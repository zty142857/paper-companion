"""全文导读：要素化总结（带原文块锚点）+ 各节一句话概要。"""
import json
import re
from concurrent.futures import ThreadPoolExecutor

from . import llm

ELEMENT_KINDS = ["一句话总览", "研究问题", "方法", "创新点", "实验与结果", "局限与未来工作"]
DIGEST_CHAR_BUDGET = 48000
PARA_CAP = 600


def build_digest(structure: dict) -> tuple[str, dict]:
    blocks = {b["id"]: b for b in structure["blocks"]}
    sec_title = {s["id"]: s["title"] for s in structure["sections"]}
    ref_sec = {s["id"] for s in structure["sections"] if s["is_references"]}
    lines, used = [], 0
    for b in structure["blocks"]:
        if b["type"] in ("figure", "formula"):
            continue
        if b["section_id"] in ref_sec:
            continue  # 参考文献正文不进 digest
        t = b["text"] if len(b["text"]) <= PARA_CAP else b["text"][:PARA_CAP] + "…"
        line = f"[{b['id']}|第{b['page']}页|{sec_title.get(b['section_id'], '')}] {t}"
        if used + len(line) > DIGEST_CHAR_BUDGET:
            break
        lines.append(line)
        used += len(line)
    return "\n".join(lines), blocks


def analyze(structure: dict, known_terms: list[str] | None = None, plan: dict | None = None,
            term_depth: str | None = None, familiarity: str | None = None) -> dict:
    """plan/familiarity/term_depth 为 None 时不加任何个性化提示（手动生成路径）。"""
    digest, _ = build_digest(structure)
    valid = {b["id"] for b in structure["blocks"]}

    def elements_task() -> list[dict]:
        els = _selfcheck(_gen_elements(digest, plan, familiarity), structure)
        for e in els:
            e["refs"] = [r for r in e["refs"] if r in valid]
            pages = sorted({b["page"] for b in structure["blocks"] if b["id"] in e["refs"]})
            e["pages"] = pages[:4]
        return els

    # 三个生成步骤互不依赖，并行执行（LLM 调用为 IO 阻塞，线程池有效）
    with ThreadPoolExecutor(max_workers=3) as ex:
        f_el = ex.submit(elements_task)
        f_out = ex.submit(_gen_outlines, digest, structure, familiarity)
        f_term = ex.submit(_gen_terms, digest, known_terms or [], term_depth)
        elements = f_el.result()
        outlines = f_out.result()
        terms = f_term.result()

    for t in terms:
        t["refs"] = [r for r in t.get("refs", []) if r in valid]
        t["pages"] = sorted({b["page"] for b in structure["blocks"] if b["id"] in t["refs"]})[:3]
    return {"elements": elements, "outlines": outlines, "terms": terms}


def _plan_directive(plan: dict | None) -> str:
    """把阅读计划转为对导读要素的侧重指令（focus/skip/abstract_emphasis）。"""
    if not plan:
        return ""
    focus = [x for x in (plan.get("focus") or []) if isinstance(x, str)]
    skip = [x for x in (plan.get("skip") or []) if isinstance(x, str)]
    emph = plan.get("abstract_emphasis") or ""
    # 侧重项映射到对应要素 kind
    emph_kind = {"方法": "方法", "实验": "实验与结果", "创新": "创新点", "应用": "创新点"}.get(emph, "")
    parts = []
    if focus:
        parts.append("- 读该论文的读者尤其关注：" + "；".join(focus)
                     + "。请让「研究问题/方法/创新点/实验与结果」等要素围绕这些关注点展开。")
    if skip:
        parts.append("- 读者会略读/跳过：" + "；".join(skip)
                     + "。「方法」「实验与结果」中涉及这些部分的内容可点到为止，不必展开。")
    if emph_kind:
        parts.append(f"- 「一句话总览」务必侧重「{emph}」：用一句话点出这篇论文在{emph}方面的核心贡献/结论。")
    if not parts:
        return ""
    return "\n读者阅读计划（据此调整各要素的侧重）：\n" + "\n".join(parts) + "\n"


def _tone_line(familiarity: str | None) -> str:
    """熟悉度提示行；未提供（手动路径）时给中性说明。"""
    return llm.tone_hint(familiarity) if familiarity else "面向一般读者，客观准确地表述。"


def _gen_elements(digest: str, plan: dict | None = None, familiarity: str | None = None) -> list[dict]:
    prompt = f"""以下是一篇英文/中文学术论文按阅读顺序编号的文本块（每块以 [块ID|页码|所属节] 开头）。
请通读后生成全文导读，输出 JSON：
{{"elements": [{{"kind": "类别", "text": "中文表述，简洁准确", "refs": ["支撑该结论的块ID，1-4个"]}}]}}
elements 必须按顺序包含这些 kind：{json.dumps(ELEMENT_KINDS, ensure_ascii=False)}。
要求：
- 每条 text 控制在 2 句话内。
- {_tone_line(familiarity)}
- refs 只能使用文中出现过的块ID；确实无出处的判断（如通用背景）refs 留空数组。
- “创新点”逐条列出（text 内用 1) 2) 3) 编号），最多 4 条。
{_plan_directive(plan)}
论文文本块：
{digest}"""
    sys = "你是学术论文导读助手，帮助研究生高效读论文。"
    data = llm.chat_json(prompt, sys)
    out, seen = [], set()
    for e in data.get("elements", []):
        kind = e.get("kind", "")
        if kind in ELEMENT_KINDS and kind not in seen:
            seen.add(kind)
            out.append({"kind": kind, "text": e.get("text", ""),
                        "refs": list(e.get("refs", []))})
    missing = [k for k in ELEMENT_KINDS if k not in seen]
    for k in missing:
        out.append({"kind": k, "text": "（原文中未明确提及）", "refs": []})
    return sorted(out, key=lambda e: ELEMENT_KINDS.index(e["kind"]))


def _numbered_depth(title: str) -> int | None:
    """按标题数字编号的段数定层级：1→1(篇)、1.1→2(章)、1.1.1→3(节)。无编号返回 None。"""
    m = re.match(r"^\s*(\d+(?:\.\d+)*)\.?\s", title or "")
    if not m:
        return None
    return m.group(1).count(".") + 1


def _gen_outlines(digest: str, structure: dict, familiarity: str | None = None) -> list[dict]:
    """为所有带编号的 section（篇/章/节）各生成一句话概要，逐级概括。"""
    secs = []
    for s in structure["sections"]:
        if s["is_references"]:
            continue
        depth = _numbered_depth(s["title"])
        if depth is None:
            continue                      # 跳过无编号标题
        secs.append({**s, "depth": depth})
    if not secs:
        return []
    # 目录（带层级缩进与页码），帮助模型理解层级归属
    toc = "\n".join(f"{s['id']}: {'　' * (s['depth'] - 1)}{s['title']}（第{s['page']}页，层级{s['depth']}）"
                    for s in secs)
    prompt = f"""以下是论文的标题层级（层级1=最顶层，层级2为其子级，层级3为更细的子级）及其文本块。
请为**每一个**标题生成**一句话**中文概要，用于目录式导航。输出 JSON：
{{"outlines": [{{"section_id": "标题ID", "outline": "一句话概要"}}]}}
要求：
- 每条概要**只写一句话**（可用分号连接，但不要拆成多句）。
- 层级1的标题概括其**整个范围**（含下属所有子标题的内容），层级2概括本章，层级3概括本节；逐级收窄。
- {_tone_line(familiarity)}
- 严格依据对应范围正文，不编造。
必须覆盖全部标题（共 {len(secs)} 个）：
{toc}

论文文本块：
{digest}"""
    # 标题可能多达数十个，需要足够 token，否则 JSON 会被截断
    max_tokens = min(16000, 2048 + len(secs) * 400)
    data = llm.chat_json(prompt, "你是学术论文目录概要助手，逐级概括且每级只写一句话。", max_tokens=max_tokens)
    valid = {s["id"] for s in secs}
    got = [o for o in data.get("outlines", []) if o.get("section_id") in valid]
    # 兜底：模型偶尔漏掉部分标题 → 单独补生成缺失的
    missing = [s for s in secs if s["id"] not in {o["section_id"] for o in got}]
    if missing:
        toc2 = "\n".join(f"{s['id']}: {s['title']}" for s in missing)
        p2 = f"""请为下列论文标题各生成**一句话**中文概要。输出 JSON：
{{"outlines": [{{"section_id": "标题ID", "outline": "一句话概要"}}]}}
必须覆盖全部标题：
{toc2}

论文文本块：
{digest}"""
        d2 = llm.chat_json(p2, "你是学术论文目录概要助手。", max_tokens=min(8000, 1024 + len(missing) * 400))
        got += [o for o in d2.get("outlines", []) if o.get("section_id") in {s["id"] for s in missing}]
    return got


# 术语深度 → 提取数量区间与筛选口径
_TERM_DEPTH_SPEC = {
    "terminology_deep": ("12-15", "尽量多列，覆盖读者可能不熟悉的领域名词、缩写、方法名"),
    "normal": ("8-15", "常规筛选，只列较难的专业术语"),
    "light": ("5-8", "只列最核心、最容易卡住理解的少数关键术语，跳过一般的专业名词"),
}


def _gen_terms(digest: str, known_terms: list[str] | None = None, term_depth: str | None = None) -> list[dict]:
    skip = ""
    if known_terms:
        skip = ("\n读者已声明掌握以下术语，**不要**把它们列入结果（包括其英文、中文或同义写法）："
                + json.dumps(known_terms, ensure_ascii=False) + "\n")
    spec = _TERM_DEPTH_SPEC.get(term_depth) if term_depth else None
    lo_hi, scope = spec if spec else ("8-15", "常规筛选，只列较难的专业术语")
    prompt = f"""从下面的论文文本块中挑出 {lo_hi} 个「跨领域读者或低年级研究生可能不懂」的专业术语/概念。
不要挑通用词（如 algorithm、model），优先挑：领域特有名词、缩写、方法名、有特定含义的普通词。
术语深度要求：{scope}。{skip}
输出 JSON：{{"terms": [{{"term": "原英文术语", "zh": "中文译名", "expl": "一句白话解释（可打比方）", "refs": ["术语出现最典型的块ID"]}}]}}

论文文本块：
{digest}"""
    limit = 8 if term_depth == "light" else 15
    for _ in range(2):  # 并发下偶发空结果，重试一次
        data = llm.chat_json(prompt, "你是论文术语助手。")
        terms = data.get("terms", [])
        if terms:
            return terms[:limit]
    return []


def _selfcheck(elements: list[dict], structure: dict) -> list[dict]:
    """对照原文核查导读要素，剔除无依据的表述。"""
    blocks = {b["id"]: b for b in structure["blocks"]}
    packs = []
    for e in elements:
        cites = "\n".join(blocks[r]["text"][:500] for r in e["refs"][:4] if r in blocks)
        packs.append(f"### {e['kind']}\n导读：{e['text']}\n引用原文：{cites or '（无引用）'}")
    prompt = """以下是论文导读的各要素及其引用原文。逐条核查：导读中每个论断能否在引用原文（或常识性表述）中找到依据？
- 全部有依据 → verdict "ok"
- 个别表述无依据/夸大 → verdict "fix"，给出删除无依据部分后的 fixed_text（其余文字保持不变）
输出 JSON：{"checks": [{"kind": "要素名", "verdict": "ok|fix", "fixed_text": "..."}]}

""" + "\n\n".join(packs)
    data = llm.chat_json(prompt, "你是事实一致性核查员，宁可保守：无依据就删。")
    by_kind = {c.get("kind"): c for c in data.get("checks", [])}
    for e in elements:
        c = by_kind.get(e["kind"])
        if c and c.get("verdict") == "fix" and c.get("fixed_text"):
            e["text"] = c["fixed_text"]
            e["checked"] = True
    return elements
