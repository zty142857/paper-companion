"""块级 AI 能力：段落翻译、子对话（带出处引用与诚实拒答）。"""
import json

from . import llm, search

CTX_CAP = 6000

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
    same = [b for b in structure["blocks"] if b["section_id"] == first["section_id"] and b["type"] not in ("figure",)]
    lo = min(next(i for i, b in enumerate(same) if b["id"] == ids[0]), len(same) - 1)
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


def translate(structure: dict, block_id: str) -> dict:
    blocks = {b["id"]: b for b in structure["blocks"]}
    b = blocks.get(block_id)
    if not b or not b["text"].strip():
        raise ValueError("该块没有可翻译的文本（可能是图片或公式，可改用「问这段」）")
    prompt = f"""把下面的学术论文片段翻译成简体中文。要求：
- 忠实、通顺，专业术语首次出现时保留英文并在括号中给中文；公式符号（如 $R$, q_12）原样保留。
- 若片段是公式碎片或乱码，返回 {{"error": "该片段以公式符号为主，无法有效翻译"}}。
只输出 JSON：{{"translation": "..."}}

原文片段：
{b['text']}"""
    data = llm.chat_json(prompt, "你是学术翻译。")
    return {"translation": data.get("translation") or data.get("error", ""),
            "block_id": block_id, "page": b["page"]}


def chat(structure: dict, block_ids: list[str], history: list[dict], question: str,
         allow_search: bool = True, familiarity: str | None = None) -> dict:
    ctx = _context(structure, block_ids)
    paper_title = structure.get("title", "")
    steps: list[dict] = []
    search_ctx = ""

    # 智能体自主检索：仅当问题带有"外部/时效"倾向时才先判断，避免普通提问多一次 LLM 往返
    if allow_search and ctx and _looks_external(question):
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
2. 上下文里找不到依据时：若属于通用背景知识可以补充，但必须先用一句「论文中未提及，以下为背景知识：」说明；
   若你也无法确定，直接说「不确定/原文未提及」，严禁编造。
3. 若提供了「外部检索结果」，可据此补充，但须注明「据外部检索」并给出标题/链接。
4. 用中文回答，简洁分点。只输出 JSON。"""
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
    pages = sorted({b["page"] for b in structure["blocks"] if b["id"] in refs})[:4]
    return {"answer": data.get("answer", "（生成失败，请重试）"), "refs": refs,
            "pages": pages, "steps": steps}
