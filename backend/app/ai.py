"""块级 AI 能力：段落翻译、子对话（带出处引用与诚实拒答）。"""
import json
import re

from . import llm, search

CTX_CAP = 6000
# 回答正文里的节号引用：[s20] / [s20, s21] / [s18-s26]（含全角横线）。
# s 编号不是块ID，服务端展开为对应页码后从正文清洗
SEC_CITE_RE = re.compile(r"\[(?=[^\]]*\bs\d+\b)[^\]]*\]")
SEC_RANGE_RE = re.compile(r"s(\d+)\s*[-–—]\s*s?(\d+)")

# 仅在问题明显涉及"论文之外/时效性"信息时才触发外部检索判断
_EXTERNAL_HINTS = ("最新", "进展", "相关文献", "相关研究", "有哪些研究", "综述", "现状",
                   "今年", "近年", "2024", "2025", "2026", "sota", "state of the art",
                   "其他方法", "对比其他", "领域内", "别人怎么")


def _looks_external(q: str) -> bool:
    s = (q or "").lower()
    return any(h in s for h in _EXTERNAL_HINTS)


def _context(structure: dict, block_ids: list[str]) -> str:
    blocks = {b["id"]: b for b in structure["blocks"]}
    sec = {s["id"]: s["title"] for s in structure["sections"]}
    ids = [i for i in block_ids if i in blocks]
    if not ids:
        return ""
    # 附带同节相邻块，补足上下文
    first = blocks[ids[0]]
    same = [b for b in structure["blocks"]
            if b["section_id"] == first["section_id"]
            and b["type"] not in ("figure",)
            and not b.get("table_id")]
    if not same:
        return ""
    try:
        lo = next(i for i, b in enumerate(same) if b["id"] == ids[0])
    except StopIteration:          # 锚点本身落在表内（老卡片）→ 从本节开头取
        lo = 0
    lo = min(lo, len(same) - 1)
    window = same[max(0, lo - 1): lo + 6]
    picked = [b for b in window if b["id"] in ids] + [b for b in window if b["id"] not in ids]
    lines, used = [], 0
    for b in picked:
        t = b["text"][:1200]
        line = f"[{b['id']}|第{b['page']}页|{sec.get(b['section_id'], '')}] {t}"
        if used + len(line) > CTX_CAP:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines)


def _toc_ctx(structure: dict) -> str:
    """一行式全文目录：帮模型建立全局坐标（"前面说的X"在哪节、该引哪个块）。
    目录里的 sN 是节 ID，仅定位用，不能当 [块ID] 出处引用。"""
    rows, used = [], 0
    for s in structure["sections"]:
        if s["is_references"] or s["title"] == "(正文开头)":
            continue
        # 附标题块ID：问全篇时模型能合法引用某节（否则它会把 s 号编成 b 号，出处页码全错）
        hb = s.get("heading_block_id") or ""
        line = f"{s['id']}: {s['title']}（第{s['page']}页" + (f"，标题块 {hb}）" if hb else "）")
        if used + len(line) > 1400 or len(rows) >= 60:
            break
        rows.append(line)
        used += len(line)
    return ("\n\n【全文目录（引用某节时用它的标题块ID，如 [b150]；s 编号不得写进 answer/refs）】\n"
            + "\n".join(rows)) if rows else ""


def _global_ctx(structure: dict, analysis: dict | None) -> str:
    """未选中任何段落（全篇提问）时的整体上下文：优先用已生成的导读
    （六要素 + 每节一句话概要，零额外 LLM 调用）；没做过导读则退化为论文开头几段。
    修的是旧行为——此时 ctx 为空串，模型只拿得到标题，只能拒答或编造。"""
    parts = []
    els = (analysis or {}).get("elements") or []
    outs = (analysis or {}).get("outlines") or []
    if els:
        parts.append("【全文导读】\n" + "\n".join(f"- {e.get('kind')}：{e.get('text')}" for e in els))
    if outs:
        sec_title = {s["id"]: s["title"] for s in structure["sections"]}
        parts.append("【各节概要】\n" + "\n".join(
            f"- {sec_title.get(o.get('section_id'), '')}：{o.get('outline')}"
            for o in outs if o.get("outline")))
    if not parts:
        paras = [b["text"][:600] for b in structure["blocks"]
                 if b["type"] == "para" and len(b["text"]) > 80][:4]
        parts.append("【论文开头（尚未生成全文导读，以下仅据开头与目录作答）】\n" + "\n\n".join(paras))
    return "\n\n".join(parts)


TABLE_CTX_CAP = 6000
TABLE_ONE_CAP = 3000
TABLE_CITE_RE = re.compile(r"\[(t\d+)\]")
_TABLE_Q_RE = re.compile(r"(表格|表\s*[0-9IVX]|table|tab\.)", re.I)
_TABLE_TOPIC_RE = re.compile(r"(数据|参数|指标|结果|数值|实验|误差|精度|对比|性能|超参|hyperparam)", re.I)


def _bid_num(b: dict) -> int:
    m = re.match(r"b(\d+)$", str(b.get("id") or ""))
    return int(m.group(1)) if m else 0


def _table_head(t: dict) -> str:
    cap = (t.get("caption") or "").strip() or f"第{t.get('page')}页表格"
    return f"【表格 {t.get('id')}｜第{t.get('page')}页｜{cap}】"


def _table_text(t: dict, cap: int = TABLE_ONE_CAP) -> str:
    rows = t.get("rows") or []
    lines, used = [], 0
    for r in rows:
        line = " | ".join(str(c) for c in r)
        if used + len(line) + 1 > cap:
            lines.append("…（表格较长，已截断）")
            break
        lines.append(line)
        used += len(line) + 1
    return "\n".join(lines)


def _table_ctx(structure: dict, table: dict) -> str:
    """问某张表：表题 + 表格文本 + 表前后各 2 个非表格段落。"""
    blocks = sorted(structure.get("blocks") or [], key=_bid_num)
    idx = {b["id"]: i for i, b in enumerate(blocks)}
    tagged = [i for i, b in enumerate(blocks) if b.get("table_id") == table.get("id")]
    cap_id = table.get("caption_block_id") or ""
    cap_i = idx.get(cap_id)
    if tagged:
        center, start = tagged[0], tagged[-1] + 1
    elif cap_i is not None:
        center, start = cap_i, cap_i + 1
    elif blocks:
        # 整页旋转表（394f p4）解析器没有任何块：退到最接近该页的正文位置
        tpage = int(table.get("page") or 1)
        ty = float(table.get("y0") or 0)
        center = min(range(len(blocks)), key=lambda i: (
            abs(int(blocks[i].get("page") or 1) - tpage),
            abs(float(blocks[i].get("y0") or 0) - ty)))
        start = center + 1
    else:
        center, start = 0, 0

    def usable(b: dict) -> bool:
        return (not b.get("table_id") and b.get("type") not in ("figure", "formula")
                and bool((b.get("text") or "").strip()))

    pre = [b for b in blocks[max(0, center - 5):center] if usable(b)][-2:]
    post = [b for b in blocks[start:start + 8] if usable(b)][:2]
    sec = {s["id"]: s["title"] for s in structure.get("sections") or []}

    parts = []
    if cap_i is not None:
        cb = blocks[cap_i]
        parts.append(f"[{cb['id']}|第{cb['page']}页|{sec.get(cb.get('section_id'), '')}] "
                     f"{(cb.get('text') or '')[:600]}")
    parts.append(_table_head(table))
    if table.get("quality") == "ok":
        body = _table_text(table)
        parts.append(body or "（表格内容为空，可参考表题与上下文）")
    else:
        parts.append("（该表为旋转/乱码/图片表，无法按文本读取；不要编造表内数值）")
    for b in pre + post:
        if cap_id and b["id"] == cap_id:
            continue
        parts.append(f"[{b['id']}|第{b['page']}页|{sec.get(b.get('section_id'), '')}] "
                     f"{(b.get('text') or '')[:600]}")
    return "\n".join(parts)


def _table_index(structure: dict) -> str:
    rows = []
    for t in (structure.get("tables") or [])[:40]:
        cap = (t.get("caption") or "").strip() or "（无表题）"
        rows.append(f"- {t.get('id')}：第{t.get('page')}页 {cap}")
    if not rows:
        return ""
    return ("\n\n【表格目录（引用表格时用「表 tN」，不要写成块ID）】\n" + "\n".join(rows))


def _tables_ctx(structure: dict, question: str) -> str:
    """全篇问答命中表格关键词时附带表文本；点名 Table N 时优先那几张。"""
    all_tables = structure.get("tables") or []
    ok_tables = [t for t in all_tables if t.get("quality") == "ok" and t.get("rows")]
    m = re.search(r"(?:table|表)\s*([0-9]+)", question, re.I)
    picked: list[dict] = []
    if m:
        n = int(m.group(1))
        # 先按表题里的编号找（Table 3），再按文档顺序找第 n 张
        by_cap = [t for t in all_tables
                  if re.search(rf"(?:table|表)\s*{n}\b", t.get("caption") or "", re.I)]
        target = by_cap[:1] or ([all_tables[n - 1]] if 1 <= n <= len(all_tables) else [])
        if target and target[0].get("quality") != "ok":
            t = target[0]
            return ("\n\n" + _table_head(t)
                    + "\n（该表为旋转/乱码/图片表，无法按文本读取；不要编造表内数值）")
        picked = [t for t in target if t in ok_tables]
    if not picked:
        picked = [t for t in ok_tables if len(t.get("rows") or []) <= 10]
    parts, used = [], 0
    for t in picked:
        body = _table_text(t)
        if not body:
            continue
        line = _table_head(t) + "\n" + body
        if used + len(line) > TABLE_CTX_CAP:
            break
        parts.append(line)
        used += len(line)
    return ("\n\n" + "\n\n".join(parts)) if parts else ""


def _looks_table_question(q: str) -> bool:
    return bool(_TABLE_Q_RE.search(q or "") or _TABLE_TOPIC_RE.search(q or ""))


_TERM_DEPTH_HINT = {
    "terminology_deep": "读者基础较薄，请解释得**非常详细**：先给通俗比喻，再说明它在本文中的具体角色，必要时补充相关背景概念。",
    "normal": "读者有一定基础，请给出 2-4 句白话解释，说明它在本论文语境下的含义与作用。",
    "light": "读者较熟悉，请**简明扼要**一句话点明其含义即可，不必展开基础背景。",
}


def explain_term(structure: dict, term: str, zh: str = "", refs: list[str] | None = None,
                 term_depth: str = "normal") -> dict:
    """按需为单个术语生成针对性解释（结合其在文中出现处的上下文与术语深度）。"""
    term = (term or "").strip()
    if not term:
        raise ValueError("术语为空")
    blocks = {b["id"]: b for b in structure["blocks"]}
    ctx_blocks = [blocks[r] for r in (refs or []) if r in blocks][:3]
    ctx = "\n".join(f"[{b['id']}|第{b['page']}页] {b['text'][:500]}" for b in ctx_blocks)
    paper_title = structure.get("title", "")
    depth_hint = _TERM_DEPTH_HINT.get(term_depth, _TERM_DEPTH_HINT["normal"])
    prompt = f"""论文《{paper_title}》中出现了一个术语：**{term}**{f'（中文常译：{zh}）' if zh else ''}。
请面向「跨领域读者 / 低年级研究生」给出针对性解释。{depth_hint}输出 JSON：
{{"zh": "中文译名（若已有则沿用）", "expl": "解释正文，可打比方，说明它在本论文语境下的含义与作用", "refs": ["最能说明该术语的块ID（可用文中给出的）"]}}

该术语在文中的出现语境：
{ctx or '（无具体语境，请给出该领域的通用解释）'}"""
    data = llm.chat_json(prompt, "你是论文术语讲解助手，解释要通俗且贴合论文语境。")
    valid = {b["id"] for b in structure["blocks"]}
    out_refs = [r for r in data.get("refs", []) if r in valid] or [r for r in (refs or []) if r in valid]
    pages = sorted({blocks[r]["page"] for r in out_refs})[:3]
    return {"term": term, "zh": data.get("zh") or zh or "",
            "expl": data.get("expl") or "（生成失败，请重试）",
            "refs": out_refs, "pages": pages}


def _neighbors(structure: dict, block_id: str):
    """返回 (上一块, 下一块)：按块 id 数值序（≈文档顺序），跳过 figure/formula 与空块。"""
    order = sorted(structure["blocks"], key=lambda b: int(b["id"][1:]))
    idx = {b["id"]: i for i, b in enumerate(order)}
    i = idx.get(block_id)
    if i is None:
        return None, None
    prev = next((order[j] for j in range(i - 1, -1, -1)
                 if order[j]["type"] not in ("figure", "formula")
                 and not order[j].get("table_id") and order[j]["text"].strip()), None)
    nxt = next((order[j] for j in range(i + 1, len(order))
                if order[j]["type"] not in ("figure", "formula")
                and not order[j].get("table_id") and order[j]["text"].strip()), None)
    return prev, nxt


def translate(structure: dict, block_id: str) -> dict:
    blocks = {b["id"]: b for b in structure["blocks"]}
    b = blocks.get(block_id)
    if not b or not b["text"].strip():
        raise ValueError("该块没有可翻译的文本（可能是图片或公式，可改用「问这段」）")
    sec = next((s["title"] for s in structure["sections"] if s["id"] == b["section_id"]), "")
    prev, nxt = _neighbors(structure, block_id)
    # 本块结尾没有句末标点 → 句子被块边界截断，附下文首句帮助理解（不混进译文）
    cut_mid = not re.search(r"[.!?;:]\s*$", b["text"])
    ctx_prev = f"上文（仅供理解指代，勿翻译）：{prev['text'][-250:]}\n" if prev else ""
    ctx_next = f"下文（勿翻译）：{nxt['text'][:150]}\n" if (nxt and cut_mid) else ""
    origin = "；".join(x for x in (f"论文标题：{structure.get('title', '')}" if structure.get("title") else "",
                                   f"所在章节：{sec}" if sec else "") if x)
    prompt = f"""把下面的学术论文片段翻译成简体中文。
{origin + chr(10) if origin else ''}要求：
- 忠实、通顺，专业术语首次出现时保留英文并在括号中给中文；公式符号（如 $R$, q_12）原样保留。
- 只翻译「原文片段」；上文/下文仅用于理解 this/these/上述 等指代，**不得出现在译文里**。
- 若片段以公式符号为主、无法有效翻译，返回 {{"error": "该片段以公式符号为主，无法有效翻译"}}。
只输出 JSON：{{"translation": "..."}}

{ctx_prev}原文片段：
{b['text']}
{ctx_next}"""
    data = llm.chat_json(prompt, "你是学术翻译。", purpose="translate")
    return {"translation": data.get("translation") or data.get("error", ""),
            "block_id": block_id, "page": b["page"]}


def chat(structure: dict, block_ids: list[str], history: list[dict], question: str,
         allow_search: bool = True, familiarity: str | None = None,
         analysis: dict | None = None, table_id: str = "") -> dict:
    table = next((t for t in (structure.get("tables") or [])
                  if t.get("id") == table_id), None) if table_id else None
    if table:
        ctx = _table_ctx(structure, table)       # 问这张表：表题 + 表格 + 前后段落
    else:
        ctx = _context(structure, block_ids)
        if not ctx:
            ctx = _global_ctx(structure, analysis)   # 全篇提问：喂整体画像而非空串
            ctx += _table_index(structure)           # 表题目录始终给，成本很低
            if _looks_table_question(question):
                ctx += _tables_ctx(structure, question)
    ctx += _toc_ctx(structure)                   # 无论有无选段，都给全文目录
    paper_title = structure.get("title", "")
    steps: list[dict] = []
    search_ctx = ""

    # 智能体自主检索：仅当问题带有"外部/时效"倾向时才先判断，避免普通提问多一次 LLM 往返
    if allow_search and _looks_external(question):
        judge = llm.chat_json(
            f"""论文上下文：
{ctx[:3000]}

用户问题：{question}

判断论文上下文是否足以回答该问题。输出 JSON：
{{"enough": true/false, "query": "若不足，给出适合检索 arXiv 的英文关键词查询（否则空字符串）"}}""",
            "你是检索决策助手，只在上下文确实缺少答案时才建议检索。")
        if not judge.get("enough", True) and judge.get("query"):
            q = judge["query"]
            steps.append({"step": "search", "text": f"论文中未找到，正在检索 arXiv：{q}"})
            try:
                hits = search.arxiv(q, limit=3)
                if hits:
                    steps.append({"step": "found", "text": f"找到 {len(hits)} 篇相关文献"})
                    search_ctx = "\n".join(
                        f"- {h['title']}（{h.get('year', '')}，{h.get('url', '')}）：{h.get('abstract', '')[:300]}"
                        for h in hits)
                else:
                    steps.append({"step": "found", "text": "未检索到相关文献"})
            except Exception as e:
                steps.append({"step": "found", "text": f"检索失败：{e}"})

    sys = """你是论文阅读学伴，帮助学生精读学术论文。回答规则：
1. 优先依据「论文上下文」回答，并在相关句子后用 [块ID] 标注出处（如 [b12]）。
   「论文上下文」里的【全文目录】【全文导读】【各节概要】都是论文自身的合法依据：依据它们作答时**不要**声明"论文中未提及"；
   但出处标注只允许 [b数字] 形式的块ID——目录/概要用的是 s 编号，不是块ID，不得写进 answer 或 refs。
2. 上下文里找不到依据时：若属于通用背景知识可以补充，但必须先用一句「论文中未提及，以下为背景知识：」说明；
   若你也无法确定，直接说「不确定/原文未提及」，严禁编造。
3. 若提供了「外部检索结果」，可据此补充，但须注明「据外部检索」并给出标题/链接。
4. 用中文回答，简洁分点。只输出 JSON。
5. 若「论文上下文」包含【表格 tN】，表内数值/参数必须来自该表；表中没有的不要推断。
   表格本身用「表 tN（第N页）」引用，不要写成 [tN]；块ID仍只用 [b数字]。"""
    if familiarity:
        sys += "\n说话风格：" + llm.tone_hint(familiarity)
    extra = f"\n\n外部检索结果：\n{search_ctx}" if search_ctx else ""
    prompt = f"""论文：《{paper_title}》
论文上下文（每块以 [块ID|页码|所属节] 开头）：
{ctx or '（未选中具体段落，请基于论文整体回答）'}{extra}

对话历史：{json.dumps(history[-6:], ensure_ascii=False)}
用户问题：{question}

输出 JSON：{{"answer": "回答正文，含 [块ID] 引用", "refs": ["用到的块ID"]}}"""
    data = llm.chat_json(prompt, sys)
    valid = {b["id"] for b in structure["blocks"]}
    refs = [r for r in data.get("refs", []) if r in valid]
    answer = data.get("answer", "（生成失败，请重试）")
    extra_pages: set[int] = set()
    # 模型在全篇问答里爱用 [s20]/[s18-s26] 引节号：展开为页码（可跳转），并从正文剔除噪声
    sec_pages = {s["id"]: s["page"] for s in structure["sections"]}
    chunks = SEC_CITE_RE.findall(answer)
    if chunks:
        cited: set[str] = set()
        for c in chunks:
            for m in SEC_RANGE_RE.finditer(c):          # 区间 s18-s26（跨度封顶防失控）
                lo, hi = int(m.group(1)), min(int(m.group(2)), int(m.group(1)) + 60)
                cited.update(f"s{i}" for i in range(lo, hi + 1) if f"s{i}" in sec_pages)
            for tok in re.findall(r"s\d+", SEC_RANGE_RE.sub("", c)):   # 零散 sN
                if tok in sec_pages:
                    cited.add(tok)
        extra_pages |= {sec_pages[c] for c in cited}
        answer = re.sub(r"\s{2,}", " ", SEC_CITE_RE.sub("", answer)).strip()
    # 表格用 [tN] 引用时换成「表 tN（第N页）」，并把页码带进跳转列表
    table_pages = {t["id"]: t["page"] for t in (structure.get("tables") or [])}
    tchunks = TABLE_CITE_RE.findall(answer)
    if tchunks:
        extra_pages |= {table_pages[x] for x in tchunks if x in table_pages}
        answer = TABLE_CITE_RE.sub(
            lambda m: f"（表 {m.group(1)}，第{table_pages.get(m.group(1), '?')}页）", answer)
    if table:
        extra_pages.add(table["page"])
    pages = sorted({b["page"] for b in structure["blocks"] if b["id"] in refs} | extra_pages)[:4]
    return {"answer": answer, "refs": refs, "pages": pages, "steps": steps}
