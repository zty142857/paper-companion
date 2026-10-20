"""智能体画像与编排：领域猜测、阅读计划、记忆（推荐 / 综述）。

计划为"简易档"：一次 LLM 调用产出结构化计划，用户可勾选调整后再执行。
"""
import json

from . import llm, summarize

FAMILIARITY = ["新手", "进阶", "熟手"]


def _abstract(structure: dict) -> str:
    """提取论文开头最像摘要的正文块：优先摘要节，其次正文首段。"""
    blocks = structure.get("blocks", [])
    # 1) 明确的 abstract 节
    for s in structure.get("sections", []):
        if "abstract" in (s.get("title") or "").lower():
            same = [b for b in blocks if b.get("section_id") == s["id"] and b.get("type") == "para"]
            txt = " ".join(b.get("text", "") for b in same).strip()
            if len(txt) > 80:
                return txt[:1500]
    # 2) 正文首段（解析器会把正文开头归入首个 section）
    for b in blocks:
        if b.get("type") == "para" and len(b.get("text", "")) > 120:
            return b["text"][:1500]
    return ""


def _paper_brief(structure: dict) -> dict:
    secs = [s for s in structure.get("sections", []) if not s.get("is_references")]
    blocks = structure.get("blocks", [])
    n_formula = sum(1 for b in blocks if b.get("type") == "formula")
    return {
        "title": structure.get("title", ""),
        "pages": structure.get("pages", 0),
        "sections": [s.get("title", "") for s in secs][:30],
        "abstract": _abstract(structure),
        "formula_density": round(n_formula / max(1, len(blocks)), 3),
    }


# 领域常见术语兜底字典：摸底自评用，避免每次为"猜术语"再调一次模型。
DOMAIN_TERMS = {
    "连续体机器人": ["continuum robot", "constant curvature", "cable-driven", "kinematics", "workspace", "twist", "Kirchhoff rod"],
    "软体机器人": ["soft robot", "pneumatic actuator", "compliance", "hyperelastic", "finite element", "morphology"],
    "强化学习": ["policy gradient", "Q-learning", "reward shaping", "exploration", "actor-critic", "Markov decision process"],
    "深度学习": ["transformer", "attention", "backpropagation", "regularization", "embedding", "dropout"],
    "计算机视觉": ["convolution", "feature map", "object detection", "segmentation", "backbone", "IoU"],
    "自然语言处理": ["tokenization", "pretraining", "fine-tuning", "attention", "embedding", "prompt"],
    "控制理论": ["state-space", "feedback", "Lyapunov", "stability", "observer", "MPC"],
    "材料科学": ["lattice", "microstructure", "phase transition", "anisotropy", "diffusion", "defect"],
    "医学影像": ["segmentation", "registration", "radiomics", "CNN", "annotations", "sensitivity"],
    "机械设计": ["kinematics", "dynamic model", "friction", "tolerance", "actuator", "topology"],
}


def _dict_terms(domain: str) -> list[str] | None:
    """本地领域词典命中则返回术语，否则 None（交给模型生成）。"""
    for k, v in DOMAIN_TERMS.items():
        if k in domain or domain in k:
            return v
    return None


def _llm_terms(domain: str, title: str, abstract: str) -> list[str]:
    """词典未覆盖的领域：只凭标题+摘要让模型给出该领域常见术语（不读全文）。"""
    prompt = f"""论文领域是「{domain}」，标题：{title}。
请列出 5-8 个该领域读者应当已掌握、可用于「你懂了吗」自评的常见专业术语（中英文均可，英文优先）。
输出 JSON：{{"terms": ["术语1", "..."]}}

摘要参考：{abstract[:500]}"""
    try:
        data = llm.chat_json(prompt, "你是学术领域术语助手。")
        terms = [t for t in data.get("terms", []) if isinstance(t, str) and t.strip()]
        return terms[:8]
    except Exception:
        return []


def guess_domain(structure: dict) -> dict:
    """凭标题+摘要快速判断领域；术语优先本地词典，未命中才让模型生成（仅标题+摘要）。"""
    title = structure.get("title", "") or ""
    abstract = _abstract(structure)
    prompt = f"""读下面论文的标题和摘要，判断它所属的研究领域。
输出 JSON：{{"domain": "4-12字的领域名（如「连续体机器人」「强化学习」）", "reason": "一句话依据"}}

标题：{title}
摘要：{abstract[:800]}"""
    try:
        data = llm.chat_json(prompt, "你是学术领域分类助手，只判断领域。")
        domain = (data.get("domain") or "").strip() or "未分类"
        reason = data.get("reason", "")
    except Exception:
        domain, reason = "未分类", ""
    terms = _dict_terms(domain)
    if terms is None:                       # 词典未覆盖 → 模型生成（同样只喂摘要）
        terms = _llm_terms(domain, title, abstract)
        if not terms:                       # 模型也失败时的最后兜底
            terms = ["研究方法", "实验设计", "评价指标", "baseline", "ablation"]
    return {"domain": domain, "terms": terms, "reason": reason}


# 术语深度由熟悉度确定性推导（不依赖模型，保证可预期）
TERM_DEPTH_BY_FAMILIARITY = {"新手": "terminology_deep", "进阶": "normal", "熟手": "light"}


def _term_depth(familiarity: str) -> str:
    return TERM_DEPTH_BY_FAMILIARITY.get(familiarity, "normal")


def make_plan(structure: dict, domain: str, familiarity: str, known_terms: list[str]) -> dict:
    """生成阅读计划：摘要侧重 / 跳过项 / 推荐方向；term_depth 由熟悉度规则推导。"""
    brief = _paper_brief(structure)
    prompt = f"""你是论文阅读规划助手。读者画像：领域「{domain}」，熟悉度「{familiarity}」，已懂术语：{json.dumps(known_terms, ensure_ascii=False)}。
请基于论文概况，生成一份"阅读计划"。输出 JSON：
{{"summary": "一句话计划概述",
  "focus": ["该读者最该关注的 2-4 个点"],
  "skip": ["可以略读/跳过的部分（如熟悉的背景、纯公式推导）"],
  "abstract_emphasis": "方法|实验|创新|应用",
  "suggestions": ["给该读者的 2-3 条具体阅读建议"]}}
规则：新手→少公式、先看综述性小节；熟手→聚焦方法与实验对比、可跳过背景。

论文概况：{json.dumps(brief, ensure_ascii=False)[:2500]}"""
    data = llm.chat_json(prompt, "你是论文阅读规划助手，输出可执行的具体建议。")
    return {
        "summary": data.get("summary", ""),
        "focus": [x for x in data.get("focus", []) if isinstance(x, str)][:4],
        "skip": [x for x in data.get("skip", []) if isinstance(x, str)][:4],
        "term_depth": _term_depth(familiarity),
        "abstract_emphasis": data.get("abstract_emphasis", "方法"),
        "suggestions": [x for x in data.get("suggestions", []) if isinstance(x, str)][:3],
        "domain": domain, "familiarity": familiarity,
    }


def _profile_lines(domain: str, familiarity: str, history: list[dict],
                   plan: dict | None, scope_label: str = "") -> tuple[str, str, str]:
    hist = json.dumps([{"title": h.get("title"), "domain": h.get("domain"),
                        "asked": h.get("asked", [])[:6]} for h in history][:8], ensure_ascii=False)
    focus = [x for x in ((plan or {}).get("focus") or []) if isinstance(x, str)]
    skip = [x for x in ((plan or {}).get("skip") or []) if isinstance(x, str)]
    plan_line = ""
    if focus:
        plan_line += f"\n读者的阅读计划重点关注：{'；'.join(focus)}。"
    if skip:
        plan_line += f"\n读者计划略读：{'；'.join(skip)}。"
    profile_line = (f"读者领域「{domain}」，熟悉度「{familiarity}」。" if domain or familiarity else "")
    scope_line = (f"\n本次推荐范围：{scope_label}。只依据该范围内的阅读历史。"
                  if scope_label else "")
    return hist, plan_line, profile_line + scope_line


def recommend_queries(structure: dict, domain: str, familiarity: str, known_terms: list[str],
                      history: list[dict], plan: dict | None = None,
                      scope_label: str = "") -> list[dict]:
    """让模型只产出检索方向/关键词，不产出具体论文标题。

    具体论文由后端到 OpenAlex/Crossref/S2/arXiv 检索，DOI 来自数据库，避免编造书目信息。
    """
    brief = _paper_brief(structure)
    hist, plan_line, profile_line = _profile_lines(domain, familiarity, history, plan, scope_label)
    prompt = f"""{profile_line}当前论文：{json.dumps(brief, ensure_ascii=False)[:2500]}{plan_line}
阅读历史（含其提问过的点）：{hist}

请给出 3 个互补的「检索方向」，供后端到 OpenAlex / Crossref / Semantic Scholar / arXiv 检索真实论文。
输出 JSON：
{{"queries": [{{"query": "英文检索关键词，3-8 个词，包含领域限定词", "why": "这个方向为什么适合该读者（结合其历史/计划，1-2 句中文）"}}]}}
要求：
- query 只写检索关键词，**不要**写论文标题、作者、年份、DOI；不要试图回忆具体论文。
- 3 个方向分别覆盖不同侧面（例如方法、评估指标、相近构型/应用），不要重复。
- 关键词用英文；避免过于宽泛的词（如只有 "machine learning"），要带上领域词。
- 不要推荐阅读历史里已经读过的论文。"""
    data = llm.chat_json(prompt, "你是论文检索规划助手，只输出检索方向，不输出具体论文条目。")
    out = []
    for q in data.get("queries", []):
        if not isinstance(q, dict):
            continue
        query = str(q.get("query") or "").strip()
        why = str(q.get("why") or "").strip()
        if query:
            out.append({"query": query, "why": why})
    return out[:3]


def recommend_reasons(papers: list[dict], structure: dict, domain: str, familiarity: str,
                      history: list[dict], plan: dict | None = None) -> list[str]:
    """拿到真实论文后，再让模型基于真实标题/摘要写个性化推荐理由。"""
    brief = _paper_brief(structure)
    hist, plan_line, profile_line = _profile_lines(domain, familiarity, history, plan)
    packs = []
    for i, p in enumerate(papers):
        authors = "、".join((p.get("authors") or [])[:4])
        packs.append(
            f"### 论文 {i}\n"
            f"标题：{p.get('title', '')}\n"
            f"来源/年份：{p.get('venue') or p.get('source') or ''} {p.get('year', '')}\n"
            f"作者：{authors or '（未提供）'}\n"
            f"摘要：{(p.get('abstract') or '（无摘要，仅依据标题）')[:700]}\n"
            f"检索方向：{p.get('query', '')}"
        )
    prompt = f"""{profile_line}当前论文：{json.dumps(brief, ensure_ascii=False)[:2000]}{plan_line}
阅读历史（含其提问过的点）：{hist}

下面是后端检索到的**真实论文**，请为每一篇写 2-3 句中文推荐理由：说明为什么值得读、建议先关注什么、与读者历史/计划的联系。
要求：
- 只能依据给出的标题与摘要，不得编造论文中没有的内容、作者或 DOI。
- 不要提及其他论文，也不要输出新的文献条目。
- 每条理由 2-3 句，直接可读，不要加“这篇论文”以外的标题。
输出 JSON：{{"reasons": [{{"index": 0, "reason": "..."}}]}}

{chr(10).join(packs)}"""
    data = llm.chat_json(prompt, "你是论文阅读推荐助手，只能基于给定的真实论文信息写理由，严禁编造。")
    by_idx: dict[int, str] = {}
    for r in data.get("reasons", []):
        try:
            idx = int(r.get("index"))
        except (TypeError, ValueError):
            continue
        text = str(r.get("reason") or "").strip()
        if text:
            by_idx[idx] = text
    return [by_idx.get(i) or (p.get("why") or "") for i, p in enumerate(papers)]


def review(papers: list[dict]) -> dict:
    """基于已收藏论文的导读要素，生成对比综述。papers: [{title, analysis, domain, focus, skip}]"""
    packs = []
    interests = []
    for p in papers:
        a = p.get("analysis") or {}
        els = {e.get("kind"): e.get("text") for e in a.get("elements", [])}
        line = f"### {p.get('title', '')}（领域：{p.get('domain', '')}）\n"
        line += "\n".join(f"- {k}：{v}" for k, v in els.items())
        focus = [x for x in (p.get("focus") or []) if isinstance(x, str)]
        if focus:
            line += "\n- 读者在本篇的重点关注：" + "；".join(focus)
            interests += focus
        packs.append(line)
    interest_line = ""
    if interests:
        interest_line = ("\n读者在多篇论文中反复关注：" + "；".join(dict.fromkeys(interests))
                         + "。综述请围绕这些关注点组织对比。\n")
    prompt = """以下是读者收藏的多篇论文的导读要点。请生成一份中文对比综述，包含：
1) 共同研究主题与脉络；2) 各篇方法/结论的差异与联系；3) 尚存的分歧或空白；4) 给读者的阅读路线建议。
输出 JSON：{"review": "Markdown 格式的综述正文（用二级/三级标题与列表）"}
""" + interest_line + "\n" + "\n\n".join(packs)
    data = llm.chat_json(prompt, "你是文献综述助手，基于给定材料，不要编造未提供的细节。", fallback_key="review")
    return {"review": data.get("review") or data.get("result", ""),
            "count": len(papers)}
