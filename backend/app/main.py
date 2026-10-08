import os
import sys
import threading
from fastapi import FastAPI, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai, db, llm, pdf_parse, profile, quiz, search, summarize

app = FastAPI(title="paper-companion")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
db.init()


def _prefetch_domain_guess(pid: str, structure: dict):
    """解析完成后后台预生成领域猜测并落库，使 /profile 瞬间返回。"""
    def run():
        try:
            db.upsert_meta(pid, domain_guess=profile.guess_domain(structure))
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()


@app.post("/api/papers")
async def upload(file: UploadFile):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "仅支持 PDF 文件")
    pid = db.new_pending(file.filename)
    path = os.path.join(db.PDF_DIR, f"{pid}.pdf")
    with open(path, "wb") as f:
        f.write(await file.read())
    try:
        structure = pdf_parse.parse_pdf(path)
    except Exception as e:
        db.set_status(pid, "error")
        raise HTTPException(422, f"PDF 解析失败: {e}")
    db.finish_paper(pid, structure["title"] or file.filename, path, structure)
    _prefetch_domain_guess(pid, structure)   # 后台预生成领域猜测，避免进论文时弹窗等待
    return {"id": pid}


@app.get("/api/papers")
def papers():
    return db.list_papers()


@app.get("/api/papers/{pid}")
def paper(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    p.pop("pdf_path", None)
    return p


@app.get("/api/papers/{pid}/pdf")
def pdf(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    return FileResponse(p["pdf_path"], media_type="application/pdf",
                        headers={"Content-Disposition": "inline"})


@app.delete("/api/papers/{pid}")
def del_paper(pid: str):
    path = db.delete_paper(pid)
    if path is None:
        raise HTTPException(404, "not found")
    try:
        os.remove(path)
    except OSError:
        pass
    return {"ok": True}


@app.post("/api/papers/{pid}/analyze")
def analyze(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    # 有完整画像（摸底+阅读计划）→ 带个性化提示；否则手动路径不加任何特殊提示
    has_profile = bool(m.get("domain")) and bool(m.get("plan"))
    if has_profile:
        plan = m.get("plan") or {}
        analysis = summarize.analyze(p["structure"], m.get("known_terms") or [], plan,
                                     plan.get("term_depth"), m.get("familiarity"))
    else:
        analysis = summarize.analyze(p["structure"])
    db.save_analysis(pid, analysis)
    return analysis


@app.get("/api/papers/{pid}/analysis")
def get_analysis(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    return p["analysis"] or {"elements": [], "outlines": [], "terms": []}


@app.get("/api/papers/{pid}/cards")
def cards(pid: str):
    return db.list_cards(pid)


class CardIn(BaseModel):
    type: str
    block_id: str = ""
    top: float = 0
    data: dict = {}


@app.post("/api/papers/{pid}/cards")
def add_card(pid: str, body: CardIn):
    cid = db.add_card(pid, body.type, body.block_id, body.top, body.data)
    return {"id": cid}


class CardPatch(BaseModel):
    block_id: str | None = None
    top: float | None = None
    data: dict | None = None


@app.patch("/api/cards/{cid}")
def patch_card(cid: str, body: CardPatch):
    db.update_card(cid, **body.model_dump(exclude_none=True))
    return {"ok": True}


@app.delete("/api/cards/{cid}")
def del_card(cid: str):
    db.delete_card(cid)
    return {"ok": True}


class TranslateIn(BaseModel):
    block_id: str


@app.post("/api/papers/{pid}/translate")
def translate(pid: str, body: TranslateIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    try:
        return ai.translate(p["structure"], body.block_id)
    except ValueError as e:
        raise HTTPException(422, str(e))


class TermIn(BaseModel):
    term: str
    zh: str = ""
    refs: list[str] = []


@app.post("/api/papers/{pid}/term")
def explain_term(pid: str, body: TermIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    term_depth = (m.get("plan") or {}).get("term_depth") or "normal"
    try:
        return ai.explain_term(p["structure"], body.term, body.zh, body.refs, term_depth)
    except ValueError as e:
        raise HTTPException(422, str(e))


class ChatIn(BaseModel):
    block_ids: list[str] = []
    history: list[dict] = []
    question: str


@app.post("/api/papers/{pid}/chat")
def chat(pid: str, body: ChatIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    db.mark_visited(pid)
    m = db.get_meta(pid) or {}
    has_profile = bool(m.get("domain")) and bool(m.get("plan"))
    return ai.chat(p["structure"], body.block_ids, body.history, body.question,
                   familiarity=m.get("familiarity") if has_profile else None)


# ---------------- 阶段三：档案 / 计划 / 检索 / 记忆 ----------------

@app.get("/api/papers/{pid}/profile")
def get_paper_profile(pid: str):
    """猜领域 + 同领域档案（用于上传后弹问卷）。优先读预生成缓存，秒回。"""
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    meta = db.get_meta(pid)
    guess = (meta or {}).get("domain_guess")
    if not guess:                       # 后台还没跑完/旧数据 → 现算并缓存
        guess = profile.guess_domain(p["structure"])
        db.upsert_meta(pid, domain_guess=guess)
        meta = db.get_meta(pid)
    prior = db.get_profile(guess["domain"])
    return {"guess": guess, "prior": prior, "meta": meta}


class SurveyIn(BaseModel):
    domain: str
    familiarity: str
    known_terms: list[str] = []
    reuse: bool = False          # 是否沿用同领域旧档案


@app.post("/api/papers/{pid}/survey")
def submit_survey(pid: str, body: SurveyIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    if not body.reuse:
        db.upsert_profile(body.domain, body.familiarity, body.known_terms)
    meta = db.upsert_meta(pid, domain=body.domain, familiarity=body.familiarity,
                          known_terms=body.known_terms, visited=1)
    return meta


@app.post("/api/papers/{pid}/plan")
def make_plan(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    plan = profile.make_plan(p["structure"], m.get("domain") or "", m.get("familiarity") or "新手",
                             m.get("known_terms") or [])
    db.upsert_meta(pid, plan=plan)
    return plan


class PlanIn(BaseModel):
    plan: dict


@app.put("/api/papers/{pid}/plan")
def save_plan(pid: str, body: PlanIn):
    """用户勾选调整后的计划落库。"""
    m = db.upsert_meta(pid, plan=body.plan)
    return m


class SearchIn(BaseModel):
    q: str = ""
    source: str = "both"        # arxiv | s2 | both
    doi: str = ""


@app.post("/api/search")
def do_search(body: SearchIn):
    out = []
    if body.source in ("arxiv", "both") and body.q:
        try:
            out += search.arxiv(body.q)
        except Exception as e:
            out.append({"source": "arXiv", "error": str(e)})
    if body.source in ("s2", "both"):
        try:
            out += search.s2(body.doi or body.q)
        except Exception as e:
            out.append({"source": "S2", "error": str(e)})
    return {"results": [x for x in out if x.get("title")][:8]}


@app.get("/api/papers/{pid}/refs")
def paper_refs(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    return {"dois": search.ref_dois(p["structure"])}


class CollectIn(BaseModel):
    collected: bool


@app.post("/api/papers/{pid}/collect")
def collect(pid: str, body: CollectIn):
    m = db.set_collected(pid, body.collected)
    return {"collected": m.get("collected") if m else 0}


class NoteIn(BaseModel):
    note: str = ""


@app.post("/api/papers/{pid}/note")
def set_note(pid: str, body: NoteIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.set_note(pid, body.note.strip())
    return {"note": m.get("note") if m else ""}


class DismissTermIn(BaseModel):
    term: str


@app.post("/api/papers/{pid}/dismiss_term")
def dismiss_term(pid: str, body: DismissTermIn):
    """删除术语小卡：记录已隐藏的术语，刷新后不再出现。"""
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    cur = list(m.get("dismissed_terms") or [])
    t = body.term.strip()
    if t and t not in cur:
        cur.append(t)
    db.upsert_meta(pid, dismissed_terms=cur)
    return {"dismissed_terms": cur}


@app.get("/api/papers/{pid}/recommend")
def recommend(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    has_profile = bool(m.get("domain")) and bool(m.get("plan"))
    history = []
    for row in db.list_papers():
        if row["id"] == pid:
            continue
        mm = db.get_meta(row["id"]) or {}
        asked = [c["data"].get("messages", [{}])[0].get("content", "")
                 for c in db.list_cards(row["id"]) if c["type"] == "chat"]
        history.append({"title": row["title"] or row["filename"],
                        "domain": mm.get("domain"), "asked": [a for a in asked if a]})
    return profile.recommend(p["structure"],
                             m.get("domain") or ("未分类" if not has_profile else ""),
                             m.get("familiarity") or "",
                             m.get("known_terms") or [], history,
                             m.get("plan") if has_profile else None)


class ReviewIn(BaseModel):
    paper_ids: list[str] = []     # 为空则用全部收藏论文


@app.post("/api/review")
def make_review(body: ReviewIn | None = None):
    ids = (body.paper_ids if body else None) or [r["id"] for r in db.list_collected()]
    papers = []
    for pid in ids:
        p = db.get_paper(pid)
        if p:
            m = db.get_meta(pid) or {}
            plan = m.get("plan") or {}
            papers.append({"title": p["title"] or p["filename"],
                           "analysis": p["analysis"], "domain": m.get("domain"),
                           "focus": plan.get("focus"), "skip": plan.get("skip")})
    if len(papers) < 2:
        raise HTTPException(400, "至少选择 2 篇论文才能生成综述")
    return profile.review(papers)


# ---------------- 阶段四：全篇自测 ----------------

@app.post("/api/papers/{pid}/quiz")
def make_quiz(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    has_profile = bool(m.get("domain")) and bool(m.get("plan"))
    return quiz.make_quiz(p["structure"], p["analysis"], m.get("familiarity") if has_profile else None)


class QuizGradeIn(BaseModel):
    questions: list[dict]
    answers: list[str] = []


@app.post("/api/papers/{pid}/quiz/grade")
def grade_quiz(pid: str, body: QuizGradeIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    res = quiz.grade_quiz(p["structure"], body.questions, body.answers)
    db.upsert_meta(pid, quiz_score=f"{res['score']}/{res['total']}")
    return res


class Settings(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    effort: str | None = None


@app.get("/api/settings")
def get_settings():
    cfg = llm.get_llm_config()
    key = cfg["api_key"]
    cfg["api_key"] = (key[:4] + "****" + key[-4:]) if len(key) > 10 else ("已设置" if key else "")
    cfg["has_key"] = bool(key)
    return cfg


@app.put("/api/settings")
def put_settings(s: Settings):
    for k, v in s.model_dump(exclude_none=True).items():
        if k == "api_key" and "****" in (v or ""):
            continue  # 前端回显的掩码值不覆盖真实 key
        if v is not None and v != "":
            db.set_setting(f"llm_{k}", v)
    return get_settings()


@app.post("/api/data/clear")
def clear_data():
    """一键清除全部本地数据（论文/卡片/档案/元数据/PDF；保留模型配置但清除 Key）。"""
    n = db.clear_all_data(keep_llm_settings=True)
    return {"ok": True, "papers_removed": n}


# ---------------- 前端静态托管（同一端口，免 Node / 免跨域） ----------------

def _frontend_dist() -> str:
    """打包后前端在 _MEIPASS/frontend_dist，源码运行时在 ../frontend/dist。"""
    meipass = getattr(sys, "_MEIPASS", None)
    if meipass:
        return os.path.join(meipass, "frontend_dist")
    root = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    return os.path.join(root, "frontend", "dist")


_DIST = _frontend_dist()
if os.path.isdir(_DIST):
    # 必须放在所有 /api 路由之后：静态挂载只兜底未命中的路径
    app.mount("/", StaticFiles(directory=_DIST, html=True), name="frontend")
