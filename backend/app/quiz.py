"""全篇自测：读完全文后生成 3 题（选择/简答），简答按要点判分并回原文。"""
import json

from . import llm, summarize


_QUIZ_TONE = {
    "新手": "\n难度要求：面向**新手**，题目要**基础、简单**：考核心概念与主要结论，避免细枝末节与复杂推导；"
            "选择题干扰项区分度明显，简答题只考一个大方向、评分要点 2-3 个。",
    "熟手": "\n难度要求：面向**熟手**，可考查方法细节、假设与局限性等深入内容。",
    "进阶": "\n难度要求：难度适中，兼顾核心结论与方法理解。",
}


def make_quiz(structure: dict, analysis: dict | None, familiarity: str | None = None) -> dict:
    digest, _ = summarize.build_digest(structure)
    elems = ""
    if analysis:
        elems = "\n".join(f"- {e['kind']}：{e['text']}" for e in analysis.get("elements", []))
    tone = _QUIZ_TONE.get(familiarity, "") if familiarity else ""   # 无画像→不加难度提示
    prompt = f"""基于下面的论文导读与原文，出 3 道检验「是否读懂全篇」的自测题。要求：
- 2 道单选题（4 个选项，考查核心结论/方法/创新点），1 道简答题（考查对方法的理解，给出 2-4 个评分要点）。
- 每题给出该题内容对应的原文页码（pages）与块ID（refs），便于答错后跳回原文。
- 选项要合理，不要明显凑数。{tone}
输出 JSON：
{{"questions": [
  {{"type": "choice", "q": "题干", "options": ["A...","B...","C...","D..."], "answer": "正确选项的完整文字（须与某个 option 完全一致）", "explain": "解析", "pages": [3], "refs": ["b20"]}},
  {{"type": "short", "q": "题干", "keypoints": ["要点1","要点2","要点3"], "reference": "参考答案", "pages": [6], "refs": ["b55"]}}
]}}
必须恰好包含 2 道 choice 和 1 道 short。

导读要素：
{elems or '（暂无导读，请直接依据原文出题）'}

原文文本块：
{digest}"""
    data = llm.chat_json(prompt, "你是学术自测出题助手，题目须严格基于原文。")
    valid = {b["id"] for b in structure["blocks"]}
    qs = []
    for q in data.get("questions", [])[:3]:
        if q.get("type") not in ("choice", "short"):
            continue
        q["refs"] = [r for r in q.get("refs", []) if r in valid]
        q["pages"] = q.get("pages", [])[:4]
        qs.append(q)
    # 保证有 choice/short 结构
    if not any(q["type"] == "choice" for q in qs):
        return {"questions": [], "error": "出题失败，请重试"}
    return {"questions": qs}


def grade_quiz(structure: dict, questions: list[dict], answers: list) -> dict:
    """选择题比对选项；简答按要点命中判分。answers[i] 为字符串（选项文字或简答文本）。"""
    answers = list(answers) + [""] * (len(questions) - len(answers))
    results = []
    for q, ans in zip(questions, answers):
        ans = (ans or "").strip()
        if q.get("type") == "choice":
            correct = ans == q.get("answer", "")
            results.append({"type": "choice", "correct": correct, "your": ans,
                            "answer": q.get("answer", ""), "explain": q.get("explain", "")})
        else:
            results.append({"type": "short", "your": ans, "_pending": True})
    # 简答交 LLM 按要点判分（可能多题，一次性批改）
    shorts = [(i, q) for i, q in enumerate(questions) if q.get("type") == "short"]
    if shorts:
        packs = []
        for idx, q in shorts:
            packs.append(f"### 题{idx}\n题干：{q['q']}\n评分要点：{json.dumps(q.get('keypoints', []), ensure_ascii=False)}\n"
                         f"参考答案：{q.get('reference', '')}\n学生作答：{answers[idx] or '（未作答）'}")
        prompt = ("逐题批改简答题：对照评分要点，判断学生作答命中了哪些要点、是否理解正确。"
                  "输出 JSON：{\"grades\":[{\"idx\":题号,\"hit\":\"命中的要点数/总要点数\",\"correct\":true/false,\"feedback\":\"简短中文点评\"}]}\n\n"
                  + "\n\n".join(packs))
        data = llm.chat_json(prompt, "你是严格但鼓励性的阅卷助手。")
        grades = {g.get("idx"): g for g in data.get("grades", [])}
        for idx, q in shorts:
            g = grades.get(idx, {})
            results[idx].update({"correct": bool(g.get("correct")), "hit": g.get("hit", ""),
                                 "feedback": g.get("feedback", ""),
                                 "reference": q.get("reference", ""), "_pending": False})
    return {"results": results,
            "score": sum(1 for r in results if r.get("correct")),
            "total": len(results)}
