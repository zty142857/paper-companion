import os
import sys
import json
import time
import shutil
import threading
import mimetypes
from fastapi import FastAPI, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import ai, db, llm, model_catalog, pdf_parse, profile, quiz, search, summarize, table_regions

# Windows 的 MIME 注册表缺 .mjs 映射，默认会退化成 text/plain，
# 浏览器对 import() 的模块有 MIME 校验，会拒绝加载 PDF.js worker。
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("text/javascript", ".js")

app = FastAPI(title="paper-companion")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
db.init()
llm.ensure_migrated()


@app.exception_handler(llm.LLMNotConfigured)
def _llm_not_configured(request: Request, exc: llm.LLMNotConfigured):
    """把「没配模型」变成前端能直接展示的 400，而不是 500。"""
    return JSONResponse(status_code=400, content={
        "detail": str(exc), "code": "model_not_configured", "purpose": exc.purpose})


def _prefetch_domain_guess(pid: str, structure: dict):
    """解析完成后后台预生成领域猜测并落库，使 /profile 瞬间返回。"""
    def run():
        try:
            db.upsert_meta(pid, domain_guess=profile.guess_domain(structure))
        except Exception:
            pass
    threading.Thread(target=run, daemon=True).start()


@app.post("/api/papers")
async def upload(file: UploadFile, folder_id: str = ""):
    if not (file.filename or "").lower().endswith(".pdf"):
        raise HTTPException(400, "仅支持 PDF 文件")
    if folder_id and not db.get_folder(folder_id):
        raise HTTPException(404, "文件夹不存在")
    pid = db.new_pending(file.filename, folder_id or None)
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


# ---------------- 文件夹 ----------------

class FolderIn(BaseModel):
    name: str


def _folder_name(name: str) -> str:
    n = (name or "").strip()
    if not n:
        raise HTTPException(400, "文件夹名不能为空")
    if len(n) > 40:
        raise HTTPException(400, "文件夹名不能超过 40 个字符")
    return n


@app.get("/api/folders")
def list_folders():
    return db.list_folders()


@app.post("/api/folders")
def create_folder(body: FolderIn):
    name = _folder_name(body.name)
    if db.folder_name_exists(name):
        raise HTTPException(409, "已存在同名文件夹")
    fid = db.add_folder(name)
    return {"id": fid, "name": name}


@app.patch("/api/folders/{fid}")
def rename_folder(fid: str, body: FolderIn):
    if not db.get_folder(fid):
        raise HTTPException(404, "文件夹不存在")
    name = _folder_name(body.name)
    if db.folder_name_exists(name, exclude_id=fid):
        raise HTTPException(409, "已存在同名文件夹")
    db.rename_folder(fid, name)
    return {"ok": True, "name": name}


@app.delete("/api/folders/{fid}")
def remove_folder(fid: str):
    """删除文件夹及其中的所有论文（用户确认后才会调用）。"""
    folders = db.list_folders()
    folder = next((f for f in folders if f["id"] == fid), None)
    if not folder:
        raise HTTPException(404, "文件夹不存在")
    paths = db.delete_folder(fid, delete_papers=True)
    for path in paths or []:
        try:
            os.remove(path)
        except OSError:
            pass
    return {"ok": True, "papers_removed": folder.get("paper_count", 0)}


class FolderTargetIn(BaseModel):
    folder_id: str | None = None


@app.post("/api/papers/{pid}/move")
def move_paper_to_folder(pid: str, body: FolderTargetIn):
    if not db.get_paper(pid):
        raise HTTPException(404, "not found")
    if body.folder_id and not db.get_folder(body.folder_id):
        raise HTTPException(404, "文件夹不存在")
    db.move_paper(pid, body.folder_id)
    return {"ok": True, "folder_id": body.folder_id}


@app.post("/api/papers/{pid}/copy")
def copy_paper_to_folder(pid: str, body: FolderTargetIn):
    """复制为独立副本：新论文记录 + 新 PDF，继承导读/卡片/笔记/标亮/画像。"""
    src = db.get_paper(pid)
    if not src:
        raise HTTPException(404, "not found")
    if body.folder_id and not db.get_folder(body.folder_id):
        raise HTTPException(404, "文件夹不存在")
    src_pdf = src.get("pdf_path") or ""
    if not src_pdf or not os.path.exists(src_pdf):
        raise HTTPException(422, "原论文 PDF 文件不存在，无法复制")
    new_pid = db.new_paper_id()
    new_pdf = os.path.join(db.PDF_DIR, f"{new_pid}.pdf")
    shutil.copy2(src_pdf, new_pdf)
    try:
        db.copy_paper(pid, body.folder_id, new_pid, new_pdf)
    except Exception:
        try:
            os.remove(new_pdf)
        except OSError:
            pass
        raise
    return {"id": new_pid}


@app.get("/api/papers/{pid}")
def paper(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    p.pop("pdf_path", None)
    if p.get("analysis"):
        # 旧数据里术语可能没有 refs → 读取时按原文出现位置补齐，小卡才有锚点
        summarize.locate_term_refs(p["analysis"].get("terms") or [], p["structure"])
    return p


_table_locks: dict[str, threading.Lock] = {}
_table_locks_guard = threading.Lock()


def _table_lock(pid: str) -> threading.Lock:
    with _table_locks_guard:
        lock = _table_locks.get(pid)
        if lock is None:
            lock = threading.Lock()
            _table_locks[pid] = lock
        return lock


@app.get("/api/papers/{pid}/tables")
def paper_tables(pid: str):
    """老论文懒补表格；同一篇只跑一次，结果写回 structure。"""
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    if p["structure"].get("tables_version") == table_regions.TABLES_VERSION:
        return {"tables": p["structure"].get("tables") or [],
                "version": table_regions.TABLES_VERSION}
    path = p.get("pdf_path") or ""
    if not path or not os.path.isfile(path):
        guess = os.path.join(db.PDF_DIR, f"{pid}.pdf")
        if not os.path.isfile(guess):
            raise HTTPException(404, "PDF 文件不存在")
        path = guess
    with _table_lock(pid):
        p = db.get_paper(pid) or p
        st = p["structure"]
        if st.get("tables_version") == table_regions.TABLES_VERSION:
            return {"tables": st.get("tables") or [],
                    "version": table_regions.TABLES_VERSION}
        try:
            tables = table_regions.ensure_tables(st, path)
        except Exception as e:
            raise HTTPException(500, f"表格识别失败：{e}")
        db.set_structure(pid, st)
        return {"tables": tables, "version": table_regions.TABLES_VERSION}


@app.get("/api/papers/{pid}/pdf")
def pdf(pid: str):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    path = p["pdf_path"]
    if not path or not os.path.isfile(path):
        # 数据目录搬过家（换机器/换系统）后库里存的绝对路径会失效，按 id 回数据目录找
        guess = os.path.join(db.PDF_DIR, f"{pid}.pdf")
        if not os.path.isfile(guess):
            raise HTTPException(404, "PDF 文件不存在")
        path = guess
    return FileResponse(path, media_type="application/pdf",
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
    analysis = p["analysis"] or {"elements": [], "outlines": [], "terms": []}
    summarize.locate_term_refs(analysis.get("terms") or [], p["structure"])
    return analysis


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


# ---------------- 原文标亮 ----------------

HL_COLORS = {"yellow", "green", "blue", "pink"}


class HighlightIn(BaseModel):
    page: int
    color: str = "yellow"
    text: str = ""
    rects: list[list[float]] = []


class HighlightPatch(BaseModel):
    color: str


def _clean_rects(rects: list[list[float]]) -> list[list[float]]:
    out = []
    for r in rects or []:
        if len(r) != 4:
            continue
        x0, y0, x1, y1 = (min(1.0, max(0.0, float(v))) for v in r)
        if x1 - x0 < 0.001 or y1 - y0 < 0.001:
            continue
        out.append([round(x0, 5), round(y0, 5), round(x1, 5), round(y1, 5)])
    return out


@app.get("/api/papers/{pid}/highlights")
def highlights(pid: str):
    if not db.get_paper(pid):
        raise HTTPException(404, "not found")
    return db.list_highlights(pid)


@app.post("/api/papers/{pid}/highlights")
def add_highlight(pid: str, body: HighlightIn):
    if not db.get_paper(pid):
        raise HTTPException(404, "not found")
    rects = _clean_rects(body.rects)
    if not rects:
        raise HTTPException(400, "标亮区域为空")
    color = body.color if body.color in HL_COLORS else "yellow"
    hid = db.add_highlight(pid, body.page, color, (body.text or "")[:2000], rects)
    return {"id": hid, "page": body.page, "color": color, "text": body.text,
            "rects": rects}


@app.patch("/api/highlights/{hid}")
def patch_highlight(hid: str, body: HighlightPatch):
    if body.color not in HL_COLORS:
        raise HTTPException(400, "不支持的标亮颜色")
    if not db.set_highlight_color(hid, body.color):
        raise HTTPException(404, "标亮不存在")
    return {"ok": True, "color": body.color}


@app.delete("/api/highlights/{hid}")
def del_highlight(hid: str):
    if not db.delete_highlight(hid):
        raise HTTPException(404, "标亮不存在")
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
    table_id: str = ""


@app.post("/api/papers/{pid}/chat")
def chat(pid: str, body: ChatIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    db.mark_visited(pid)
    m = db.get_meta(pid) or {}
    has_profile = bool(m.get("domain")) and bool(m.get("plan"))
    return ai.chat(p["structure"], body.block_ids, body.history, body.question,
                   familiarity=m.get("familiarity") if has_profile else None,
                   analysis=p.get("analysis"), table_id=body.table_id)


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
    folder_id = p.get("folder_id")
    rows = [r for r in db.list_papers() if r["id"] != pid]

    # 推荐历史只看当前文件夹；文件夹内没有其他论文时退到同领域；再没有就少给。
    scope = "none"
    hist_rows: list[dict] = []
    if folder_id:
        hist_rows = [r for r in rows if r.get("folder_id") == folder_id]
        if hist_rows:
            scope = "folder"
    domain = (m.get("domain") or "").strip()
    if not hist_rows and domain:
        hist_rows = [r for r in rows if (r.get("domain") or "").strip() == domain]
        if hist_rows:
            scope = "domain"

    if scope == "folder":
        fname = next((f["name"] for f in db.list_folders() if f["id"] == folder_id), "")
        scope_label = f"文件夹「{fname or '当前文件夹'}」的阅读历史"
    elif scope == "domain":
        scope_label = f"同领域「{domain}」的阅读历史"
    else:
        scope_label = "暂无同文件夹 / 同领域阅读历史（仅依据本篇）"

    history = []
    for row in hist_rows[:20]:
        mm = db.get_meta(row["id"]) or {}
        asked = [c["data"].get("messages", [{}])[0].get("content", "")
                 for c in db.list_cards(row["id"]) if c["type"] == "chat"]
        history.append({"title": row["title"] or row["filename"],
                        "domain": mm.get("domain"), "asked": [a for a in asked if a]})

    queries = profile.recommend_queries(
        p["structure"],
        m.get("domain") or ("未分类" if not has_profile else ""),
        m.get("familiarity") or "",
        m.get("known_terms") or [], history,
        m.get("plan") if has_profile else None,
        scope_label=scope_label)
    context = p.get("title") or p.get("filename") or ""
    known_titles = [r.get("title") or r.get("filename") or ""
                    for r in db.list_papers() if r["id"] != pid]
    picks = search.pick_recommendations(queries, context=context,
                                        exclude_titles=known_titles, limit=3)
    if not picks:
        return {"items": [], "scope": scope, "scope_label": scope_label,
                "history_count": len(history), "queries": queries,
                "note": "没有检索到符合当前论文领域的真实文献，请重试或调整阅读计划。"}

    try:
        reasons = profile.recommend_reasons(
            picks, p["structure"],
            m.get("domain") or ("未分类" if not has_profile else ""),
            m.get("familiarity") or "", history,
            m.get("plan") if has_profile else None)
    except Exception:
        reasons = [q.get("why", "") for q in picks]

    items = []
    for pick, reason in zip(picks, reasons):
        doi = pick.get("doi") or ""
        items.append({
            "title": pick.get("title") or "",
            "reason": reason or pick.get("why") or "同领域真实文献，可按摘要了解其方法与结论。",
            "doi": doi,
            "url": f"https://doi.org/{doi}" if doi else (pick.get("url") or ""),
            "source": pick.get("source") or "",
            "year": pick.get("year") or "",
            "venue": pick.get("venue") or "",
            "authors": (pick.get("authors") or [])[:4],
            "query": pick.get("query") or "",
            "direction": pick.get("why") or "",
            "matched": True,
        })
    return {"items": items, "scope": scope, "scope_label": scope_label,
            "history_count": len(history), "queries": queries}


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

@app.get("/api/papers/{pid}/quiz")
def read_quiz(pid: str):
    """上次做的自测（题目+作答+判分结果），供重新打开面板时还原。"""
    if not db.get_paper(pid):
        raise HTTPException(404, "not found")
    return {"quiz": (db.get_meta(pid) or {}).get("quiz")}


@app.post("/api/papers/{pid}/quiz")
def make_quiz(pid: str):
    """出一套新题并覆盖已存的自测（「再测一次」也走这里）。"""
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    m = db.get_meta(pid) or {}
    has_profile = bool(m.get("domain")) and bool(m.get("plan"))
    out = quiz.make_quiz(p["structure"], p["analysis"], m.get("familiarity") if has_profile else None)
    if out.get("questions"):
        db.upsert_meta(pid, quiz={"questions": out["questions"],
                                  "answers": ["" for _ in out["questions"]], "grade": None})
    return out


class QuizGradeIn(BaseModel):
    questions: list[dict]
    answers: list[str] = []


@app.post("/api/papers/{pid}/quiz/grade")
def grade_quiz(pid: str, body: QuizGradeIn):
    p = db.get_paper(pid)
    if not p:
        raise HTTPException(404, "not found")
    res = quiz.grade_quiz(p["structure"], body.questions, body.answers)
    db.upsert_meta(pid, quiz_score=f"{res['score']}/{res['total']}",
                   quiz={"questions": body.questions, "answers": body.answers, "grade": res})
    return res


class QuizAnswersIn(BaseModel):
    answers: list[str]


@app.post("/api/papers/{pid}/quiz/answers")
def save_quiz_answers(pid: str, body: QuizAnswersIn):
    """保存未提交的作答，下次打开面板接着做。"""
    qz = (db.get_meta(pid) or {}).get("quiz")
    if not qz:
        return {"ok": False}
    db.upsert_meta(pid, quiz={**qz, "answers": body.answers})
    return {"ok": True}


# ---------------- 模型提供商 / 用途路由 ----------------

# 模型列表里的非对话模型（向量/重排/语音/绘图），自动启用时跳过
_SKIP_MODEL_HINTS = ("embed", "rerank", "whisper", "tts", "moderation", "dall-e",
                     "davinci", "transcribe", "speech", "audio", "ocr",
                     "stable-diffusion", "flux", "sdxl", "bge-", "gte-", "clip")


def _mask_key(key: str) -> str:
    key = key or ""
    return (key[:4] + "****" + key[-4:]) if len(key) > 10 else ("已设置" if key else "")


def _routes_raw() -> dict:
    out = {}
    for purpose in llm.PURPOSES:
        raw = db.get_setting(f"llm_route_{purpose}") or ""
        try:
            val = json.loads(raw) if raw else {}
        except ValueError:
            val = {}
        out[purpose] = val if isinstance(val, dict) else {}
    return out


def _routes_out() -> dict:
    raw = _routes_raw()
    out = {}
    for purpose in llm.PURPOSES:
        r = raw.get(purpose) or {}
        prov = db.get_provider(r.get("provider_id") or "")
        out[purpose] = {
            "provider_id": r.get("provider_id") or "",
            "provider_name": (prov.get("name") or "") if prov else "",
            "model": r.get("model") or "",
            "effort": r.get("effort") or "",
            "configured": bool(prov and (r.get("model") or "").strip()),
        }
    return out


def _provider_out(p: dict, routes: dict | None = None) -> dict:
    routes = routes if routes is not None else _routes_raw()
    key = p.get("api_key") or ""
    m = p.get("models") or {}
    cat = model_catalog.preset(p.get("catalog_id"))
    return {
        "id": p["id"],
        "name": p.get("name") or "",
        "base_url": p.get("base_url") or "",
        "api_key": _mask_key(key),
        "has_key": bool(key),
        "headers": p.get("headers") or {},
        "catalog_id": p.get("catalog_id"),
        "catalog_name": (cat or {}).get("name"),
        "models": {
            "enabled": m.get("enabled") or [],
            "available": len(m.get("available") or []),
            "fetched_at": m.get("fetched_at"),
            "source": m.get("source") or "",
        },
        "in_use": [x for x in llm.PURPOSES if (routes.get(x) or {}).get("provider_id") == p["id"]],
    }


def _looks_chat(model_id: str) -> bool:
    low = (model_id or "").lower()
    return not any(h in low for h in _SKIP_MODEL_HINTS)


def _models_payload(p: dict, ids: list[str], enabled: list[str], source: str,
                    error: str = "") -> dict:
    rows = []
    cat = p.get("catalog_id")
    for mid in ids:
        info = model_catalog.model_info(cat, mid)
        rows.append({
            "id": mid,
            "name": info.get("name") or mid,
            "known": bool(info.get("known")),
            "reasoning_options": info.get("reasoning_options") or [],
            "context": (info.get("limit") or {}).get("context"),
        })
    return {"models": rows, "enabled": enabled, "source": source, "error": error,
            "fetched_at": (p.get("models") or {}).get("fetched_at")}


class ProviderIn(BaseModel):
    name: str | None = None
    base_url: str | None = None
    api_key: str | None = None
    headers: dict[str, str] | None = None
    catalog_id: str | None = None
    clear_key: bool = False


class TestIn(BaseModel):
    base_url: str | None = None
    api_key: str | None = None
    model: str | None = None
    effort: str | None = None
    purpose: str = "default"


class ProviderModelsIn(BaseModel):
    enabled: list[str] = []


class RouteIn(BaseModel):
    provider_id: str = ""
    model: str = ""
    effort: str = ""


class RoutesIn(BaseModel):
    default: RouteIn | None = None
    translate: RouteIn | None = None


class ProbeIn(BaseModel):
    provider_id: str
    model: str
    levels: list[str]


@app.get("/api/providers")
def list_providers():
    routes = _routes_raw()
    return [_provider_out(p, routes) for p in db.list_providers()]


@app.get("/api/provider-presets")
def provider_presets():
    """内置目录里的 OpenAI 兼容提供方，供「添加提供商」一键预填。"""
    return model_catalog.presets()


@app.post("/api/providers")
def create_provider(body: ProviderIn):
    cat = model_catalog.preset(body.catalog_id) if body.catalog_id else None
    base_url = (body.base_url or (cat or {}).get("api") or "").strip()
    if not base_url:
        raise HTTPException(400, "请填写 Base URL，或从内置目录里选一个提供商")
    name = (body.name or (cat or {}).get("name") or llm.suggest_name(base_url)).strip()
    pid = db.add_provider(
        name=name,
        base_url=base_url,
        api_key=(body.api_key or "").strip(),
        headers=body.headers or {},
        catalog_id=body.catalog_id or (cat or {}).get("id"),
    )
    llm.reset_capability_cache()
    return _provider_out(db.get_provider(pid))


@app.put("/api/providers/{pid}")
def update_provider(pid: str, body: ProviderIn):
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "提供商不存在")
    fields = {}
    if body.name is not None and body.name.strip():
        fields["name"] = body.name.strip()
    if body.base_url is not None:
        base_url = body.base_url.strip()
        if not base_url:
            raise HTTPException(400, "Base URL 不能为空")
        fields["base_url"] = base_url
        # 地址变了就重新按目录匹配一次（显式传 catalog_id 时不覆盖）
        if body.catalog_id is None:
            cat = model_catalog.guess_provider(base_url)
            fields["catalog_id"] = cat["id"] if cat else None
    if body.catalog_id is not None:
        fields["catalog_id"] = body.catalog_id or None
    if body.headers is not None:
        fields["headers"] = body.headers
    if body.clear_key:
        fields["api_key"] = ""
    elif body.api_key and "****" not in body.api_key and body.api_key != "已设置":
        fields["api_key"] = body.api_key.strip()
    if fields:
        db.update_provider(pid, **fields)
        llm.reset_capability_cache()
    return _provider_out(db.get_provider(pid))


@app.delete("/api/providers/{pid}")
def delete_provider(pid: str):
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "提供商不存在")
    used = []
    for x in llm.PURPOSES:
        try:
            route = json.loads(db.get_setting(f"llm_route_{x}") or "{}")
        except ValueError:
            route = {}
        if isinstance(route, dict) and route.get("provider_id") == pid:
            used.append(llm.PURPOSE_LABELS[x])
    if used:
        raise HTTPException(409, f"这个提供商正在被「{'、'.join(used)}」使用，请先改成别的提供商")
    db.delete_provider(pid)
    llm.reset_capability_cache()
    return {"ok": True}


@app.post("/api/providers/{pid}/test")
def test_provider(pid: str, body: TestIn | None = None):
    """用表单当前值（未填/掩码项回落到已保存配置）发一次最小调用。"""
    ov = body.model_dump(exclude_none=True) if body else {}
    return llm.test_connection(pid, ov, purpose=(ov.pop("purpose", "default") or "default"))


@app.post("/api/providers/{pid}/models/sync")
def sync_provider_models(pid: str):
    """实时拉 /v1/models；拉不到就回落到内置目录，并如实把失败原因带回前端。"""
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "提供商不存在")
    error, source, ids = "", "api", []
    try:
        client = llm.provider_client(p, timeout=20)
        listing = client.models.list()
        ids = sorted({m.id for m in listing.data if getattr(m, "id", None)})
        if not ids:
            raise RuntimeError("服务商返回了空模型列表")
    except Exception as e:
        source = "catalog"
        error = llm.brief_error(e)
        ids = [m["id"] for m in model_catalog.models(p.get("catalog_id"))]

    prev = p.get("models") or {}
    enabled = [m for m in (prev.get("enabled") or []) if m in ids]
    if not enabled:
        want = {(r.get("model") or "") for r in _routes_raw().values()}
        enabled = [m for m in ids if m in want]
    if not enabled:
        enabled = [m for m in ids if _looks_chat(m)][:20]
    if ids:
        db.update_provider(pid, models={"available": ids, "enabled": enabled,
                                        "fetched_at": time.time(), "source": source})
    p = db.get_provider(pid)
    return _models_payload(p, ids, enabled, source, error)


@app.get("/api/providers/{pid}/models")
def get_provider_models(pid: str):
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "提供商不存在")
    m = p.get("models") or {}
    ids = m.get("available") or []
    return _models_payload(p, ids, m.get("enabled") or [], m.get("source") or "")


@app.put("/api/providers/{pid}/models")
def save_provider_models(pid: str, body: ProviderModelsIn):
    """保存启用清单（搜索 / 全选在前端完成，这里只落库）。"""
    p = db.get_provider(pid)
    if not p:
        raise HTTPException(404, "提供商不存在")
    m = p.get("models") or {}
    available = set(m.get("available") or [])
    enabled = []
    for mid in body.enabled:
        mid = (mid or "").strip()
        if mid and mid not in enabled and (not available or mid in available):
            enabled.append(mid)
    db.update_provider(pid, models={**m, "enabled": enabled})
    return {"ok": True, "enabled": enabled}


@app.get("/api/model-info")
def model_info(provider_id: str = "", model: str = ""):
    prov = db.get_provider(provider_id)
    info = model_catalog.model_info(prov.get("catalog_id") if prov else None, model)
    return {
        "known": bool(info.get("known")),
        "name": info.get("name") or model,
        "reasoning": bool(info.get("reasoning")),
        "reasoning_options": info.get("reasoning_options") or [],
        "limit": info.get("limit") or {},
        "cost": info.get("cost") or {},
    }


@app.post("/api/settings/probe-efforts")
def probe_efforts(body: ProbeIn):
    """手动验证档位：逐个发最小请求，只证明服务商接受参数，不证明真的在思考。"""
    return llm.probe_efforts(body.provider_id, body.model, body.levels)


@app.get("/api/routes")
def get_routes():
    return _routes_out()


@app.put("/api/routes")
def put_routes(body: RoutesIn):
    for purpose in llm.PURPOSES:
        r = getattr(body, purpose)
        if r is None:
            continue
        if not r.provider_id.strip() or not r.model.strip():
            db.set_setting(f"llm_route_{purpose}",
                           json.dumps({"provider_id": "", "model": "", "effort": ""}))
            continue
        prov = db.get_provider(r.provider_id)
        if not prov:
            raise HTTPException(400, "提供商不存在")
        db.set_setting(f"llm_route_{purpose}", json.dumps({
            "provider_id": prov["id"],
            "model": r.model.strip(),
            "effort": (r.effort or "").strip(),
        }, ensure_ascii=False))
    llm.reset_capability_cache()
    return _routes_out()


@app.post("/api/catalog/refresh")
def refresh_catalog():
    """联网更新 models.dev 目录快照（写到 data/catalog.json，不覆盖随包版本）。"""
    try:
        return model_catalog.refresh()
    except Exception as e:
        raise HTTPException(502, f"更新模型目录失败：{llm.brief_error(e)}")



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
