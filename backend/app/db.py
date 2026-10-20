import json
import os
import sqlite3
import sys
import time
import uuid


def _data_dir() -> str:
    """数据目录：打包后放在可执行文件旁边（升级覆盖程序不丢数据），源码运行放在 backend/ 下。"""
    if getattr(sys, "frozen", False):
        return os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "data")
    return os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data")


DATA_DIR = _data_dir()
PDF_DIR = os.path.join(DATA_DIR, "pdfs")
DB_PATH = os.path.join(DATA_DIR, "app.db")
os.makedirs(PDF_DIR, exist_ok=True)


def _harden_permissions():
    """收紧本地数据目录/数据库权限，仅当前用户可读写（数据隐私）。"""
    for d, mode in ((DATA_DIR, 0o700), (PDF_DIR, 0o700)):
        try:
            os.chmod(d, mode)
        except OSError:
            pass
    for f in (DB_PATH, os.path.join(os.path.dirname(DATA_DIR), ".env")):
        try:
            if os.path.exists(f):
                os.chmod(f, 0o600)
        except OSError:
            pass


def conn() -> sqlite3.Connection:
    c = sqlite3.connect(DB_PATH)
    c.row_factory = sqlite3.Row
    try:
        os.chmod(DB_PATH, 0o600)
    except OSError:
        pass
    return c


def init():
    _harden_permissions()
    with conn() as c:
        c.executescript("""
        CREATE TABLE IF NOT EXISTS paper(
          id TEXT PRIMARY KEY, title TEXT, filename TEXT, pdf_path TEXT,
          pages INTEGER, structure TEXT, analysis TEXT, status TEXT, created_at REAL,
          folder_id TEXT);
        CREATE TABLE IF NOT EXISTS setting(k TEXT PRIMARY KEY, v TEXT);
        CREATE TABLE IF NOT EXISTS card(
          id TEXT PRIMARY KEY, paper_id TEXT, type TEXT, block_id TEXT,
          top REAL, data TEXT, created_at REAL);
        CREATE TABLE IF NOT EXISTS profile(
          domain TEXT PRIMARY KEY, familiarity TEXT, known_terms TEXT, updated_at REAL);
        CREATE TABLE IF NOT EXISTS paper_meta(
          paper_id TEXT PRIMARY KEY, domain TEXT, familiarity TEXT,
          known_terms TEXT, plan TEXT, note TEXT, quiz_score TEXT, visited INTEGER, collected INTEGER, updated_at REAL,
          domain_guess TEXT, dismissed_terms TEXT, quiz TEXT);
        CREATE TABLE IF NOT EXISTS folder(
          id TEXT PRIMARY KEY, name TEXT, created_at REAL);
        CREATE TABLE IF NOT EXISTS highlight(
          id TEXT PRIMARY KEY, paper_id TEXT, page INTEGER, color TEXT,
          text TEXT, rects TEXT, created_at REAL);
        """)
        # 轻量迁移：旧库补列
        pcols = {r[1] for r in c.execute("PRAGMA table_info(paper)")}
        if "folder_id" not in pcols:
            c.execute("ALTER TABLE paper ADD COLUMN folder_id TEXT")
        cols = {r[1] for r in c.execute("PRAGMA table_info(paper_meta)")}
        if "note" not in cols:
            c.execute("ALTER TABLE paper_meta ADD COLUMN note TEXT")
        if "quiz_score" not in cols:
            c.execute("ALTER TABLE paper_meta ADD COLUMN quiz_score TEXT")
        if "domain_guess" not in cols:
            c.execute("ALTER TABLE paper_meta ADD COLUMN domain_guess TEXT")
        if "dismissed_terms" not in cols:
            c.execute("ALTER TABLE paper_meta ADD COLUMN dismissed_terms TEXT")
        if "quiz" not in cols:
            c.execute("ALTER TABLE paper_meta ADD COLUMN quiz TEXT")


def new_paper_id() -> str:
    return uuid.uuid4().hex[:12]


def new_pending(filename, folder_id=None) -> str:
    pid = new_paper_id()
    with conn() as c:
        c.execute("INSERT INTO paper(id,title,filename,pdf_path,pages,structure,analysis,status,created_at,folder_id)"
                  " VALUES(?,?,?,?,?,?,?,?,?,?)",
                  (pid, "", filename, "", 0, "{}", None, "parsing", time.time(), folder_id or None))
    return pid


def set_status(pid, status):
    with conn() as c:
        c.execute("UPDATE paper SET status=? WHERE id=?", (status, pid))


def finish_paper(pid, title, pdf_path, structure):
    with conn() as c:
        c.execute("UPDATE paper SET title=?, pdf_path=?, pages=?, structure=?, status=? WHERE id=?",
                  (title, pdf_path, structure["pages"], json.dumps(structure, ensure_ascii=False),
                   "parsed", pid))


def get_paper(pid) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM paper WHERE id=?", (pid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    d["structure"] = json.loads(d["structure"])
    d["analysis"] = json.loads(d["analysis"]) if d["analysis"] else None
    return d


def list_papers() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT p.id,p.title,p.filename,p.pages,p.status,p.created_at,p.folder_id,"
            " COALESCE(m.visited,0) AS visited, COALESCE(m.collected,0) AS collected,"
            " m.domain AS domain, m.note AS note, f.name AS folder_name"
            " FROM paper p LEFT JOIN paper_meta m ON m.paper_id=p.id"
            " LEFT JOIN folder f ON f.id=p.folder_id"
            " ORDER BY p.created_at DESC").fetchall()
    return [dict(r) for r in rows]


def save_analysis(pid, analysis):
    with conn() as c:
        c.execute("UPDATE paper SET analysis=? WHERE id=?", (json.dumps(analysis, ensure_ascii=False), pid))


def get_setting(k, default=None):
    with conn() as c:
        r = c.execute("SELECT v FROM setting WHERE k=?", (k,)).fetchone()
    return r["v"] if r else default


def set_setting(k, v):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO setting VALUES(?,?)", (k, v))


def add_card(paper_id, type_, block_id, top, data) -> str:
    cid = uuid.uuid4().hex[:12]
    with conn() as c:
        c.execute("INSERT INTO card VALUES(?,?,?,?,?,?,?)",
                  (cid, paper_id, type_, block_id, top, json.dumps(data, ensure_ascii=False), time.time()))
    return cid


def list_cards(paper_id) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT * FROM card WHERE paper_id=? ORDER BY top", (paper_id,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["data"] = json.loads(d["data"])
        out.append(d)
    return out


def update_card(cid, **fields):
    if not fields:
        return
    sets = ", ".join(f"{k}=?" for k in fields)
    vals = [json.dumps(v, ensure_ascii=False) if k == "data" else v for k, v in fields.items()]
    with conn() as c:
        c.execute(f"UPDATE card SET {sets} WHERE id=?", (*vals, cid))


def delete_card(cid):
    with conn() as c:
        c.execute("DELETE FROM card WHERE id=?", (cid,))


def delete_paper(pid) -> str | None:
    p = get_paper(pid)
    if not p:
        return None
    with conn() as c:
        c.execute("DELETE FROM card WHERE paper_id=?", (pid,))
        c.execute("DELETE FROM highlight WHERE paper_id=?", (pid,))
        c.execute("DELETE FROM paper_meta WHERE paper_id=?", (pid,))
        c.execute("DELETE FROM paper WHERE id=?", (pid,))
    return p.get("pdf_path") or None


# ---------- 文件夹：单层，论文只属于一个文件夹；复制=独立副本 ----------

def list_folders() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT f.id,f.name,f.created_at, COUNT(p.id) AS paper_count"
            " FROM folder f LEFT JOIN paper p ON p.folder_id=f.id"
            " GROUP BY f.id ORDER BY f.created_at").fetchall()
    return [dict(r) for r in rows]


def get_folder(fid) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM folder WHERE id=?", (fid,)).fetchone()
    return dict(r) if r else None


def folder_name_exists(name, exclude_id=None) -> bool:
    with conn() as c:
        if exclude_id:
            r = c.execute("SELECT id FROM folder WHERE name=? AND id<>?", (name, exclude_id)).fetchone()
        else:
            r = c.execute("SELECT id FROM folder WHERE name=?", (name,)).fetchone()
    return r is not None


def add_folder(name: str) -> str:
    fid = uuid.uuid4().hex[:12]
    with conn() as c:
        c.execute("INSERT INTO folder(id,name,created_at) VALUES(?,?,?)", (fid, name, time.time()))
    return fid


def rename_folder(fid, name: str) -> bool:
    with conn() as c:
        cur = c.execute("UPDATE folder SET name=? WHERE id=?", (name, fid))
    return cur.rowcount > 0


def delete_folder(fid, delete_papers: bool = True) -> list[str] | None:
    """删除文件夹。delete_papers=True 时连同论文/卡片/笔记/标亮一起删除，返回待删 PDF 路径。"""
    if not get_folder(fid):
        return None
    paths: list[str] = []
    with conn() as c:
        rows = c.execute("SELECT id,pdf_path FROM paper WHERE folder_id=?", (fid,)).fetchall()
        if delete_papers:
            for r in rows:
                if r["pdf_path"]:
                    paths.append(r["pdf_path"])
                c.execute("DELETE FROM card WHERE paper_id=?", (r["id"],))
                c.execute("DELETE FROM highlight WHERE paper_id=?", (r["id"],))
                c.execute("DELETE FROM paper_meta WHERE paper_id=?", (r["id"],))
                c.execute("DELETE FROM paper WHERE id=?", (r["id"],))
        else:
            c.execute("UPDATE paper SET folder_id=NULL WHERE folder_id=?", (fid,))
        c.execute("DELETE FROM folder WHERE id=?", (fid,))
    return paths


def move_paper(pid, folder_id) -> bool:
    with conn() as c:
        cur = c.execute("UPDATE paper SET folder_id=? WHERE id=?", (folder_id or None, pid))
    return cur.rowcount > 0


def copy_paper(pid, folder_id, new_pid: str, new_pdf_path: str) -> str | None:
    """把论文复制成一份完全独立的副本（结构/导读/卡片/笔记/标亮/画像/收藏）。"""
    src = get_paper(pid)
    if not src:
        return None
    title = (src.get("title") or src.get("filename") or "").strip()
    if not title.endswith("（副本）"):
        title = f"{title}（副本）"
    now = time.time()
    with conn() as c:
        c.execute(
            "INSERT INTO paper(id,title,filename,pdf_path,pages,structure,analysis,status,created_at,folder_id)"
            " VALUES(?,?,?,?,?,?,?,?,?,?)",
            (new_pid, title, src.get("filename") or "", new_pdf_path, src.get("pages") or 0,
             json.dumps(src.get("structure") or {}, ensure_ascii=False),
             json.dumps(src["analysis"], ensure_ascii=False) if src.get("analysis") else None,
             src.get("status") or "parsed", now, folder_id or None))
        for r in c.execute("SELECT * FROM card WHERE paper_id=?", (pid,)).fetchall():
            c.execute("INSERT INTO card(id,paper_id,type,block_id,top,data,created_at)"
                      " VALUES(?,?,?,?,?,?,?)",
                      (uuid.uuid4().hex[:12], new_pid, r["type"], r["block_id"], r["top"],
                       r["data"], r["created_at"]))
        m = c.execute("SELECT * FROM paper_meta WHERE paper_id=?", (pid,)).fetchone()
        if m:
            cols = [k for k in m.keys() if k not in ("paper_id", "updated_at")]
            vals = [m[k] for k in cols]
            c.execute(f"INSERT INTO paper_meta(paper_id,{','.join(cols)},updated_at)"
                      f" VALUES(?,{','.join('?' * len(cols))},?)",
                      (new_pid, *vals, now))
        for r in c.execute("SELECT * FROM highlight WHERE paper_id=?", (pid,)).fetchall():
            c.execute("INSERT INTO highlight(id,paper_id,page,color,text,rects,created_at)"
                      " VALUES(?,?,?,?,?,?,?)",
                      (uuid.uuid4().hex[:12], new_pid, r["page"], r["color"], r["text"],
                       r["rects"], r["created_at"]))
    return new_pid


# ---------- 原文标亮 ----------

def list_highlights(pid) -> list[dict]:
    with conn() as c:
        rows = c.execute("SELECT * FROM highlight WHERE paper_id=? ORDER BY page,created_at",
                         (pid,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        try:
            d["rects"] = json.loads(d["rects"]) if d.get("rects") else []
        except (TypeError, ValueError):
            d["rects"] = []
        out.append(d)
    return out


def add_highlight(pid, page: int, color: str, text: str, rects: list) -> str:
    hid = uuid.uuid4().hex[:12]
    with conn() as c:
        c.execute("INSERT INTO highlight(id,paper_id,page,color,text,rects,created_at)"
                  " VALUES(?,?,?,?,?,?,?)",
                  (hid, pid, page, color, text, json.dumps(rects, ensure_ascii=False), time.time()))
    return hid


def get_highlight(hid) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM highlight WHERE id=?", (hid,)).fetchone()
    if not r:
        return None
    d = dict(r)
    try:
        d["rects"] = json.loads(d["rects"]) if d.get("rects") else []
    except (TypeError, ValueError):
        d["rects"] = []
    return d


def set_highlight_color(hid, color: str) -> bool:
    with conn() as c:
        cur = c.execute("UPDATE highlight SET color=? WHERE id=?", (color, hid))
    return cur.rowcount > 0


def delete_highlight(hid) -> bool:
    with conn() as c:
        cur = c.execute("DELETE FROM highlight WHERE id=?", (hid,))
    return cur.rowcount > 0


# ---------- profile（领域档案）与 paper_meta（每篇论文的摸底/计划/收藏） ----------

def _row_meta(r) -> dict:
    d = dict(r)
    for k in ("known_terms", "dismissed_terms", "plan", "domain_guess", "quiz"):
        d[k] = json.loads(d[k]) if d.get(k) else ([] if k in ("known_terms", "dismissed_terms") else None)
    return d


def get_profile(domain) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM profile WHERE domain=?", (domain,)).fetchone()
    return _row_meta(r) if r else None


def upsert_profile(domain, familiarity, known_terms):
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO profile(domain,familiarity,known_terms,updated_at)"
                  " VALUES(?,?,?,?)",
                  (domain, familiarity, json.dumps(known_terms, ensure_ascii=False), time.time()))


def list_collected() -> list[dict]:
    with conn() as c:
        rows = c.execute(
            "SELECT p.id,p.title,p.filename,p.pages,p.created_at,m.domain,m.collected"
            " FROM paper p JOIN paper_meta m ON m.paper_id=p.id"
            " WHERE COALESCE(m.collected,0)=1 ORDER BY p.created_at DESC").fetchall()
    return [dict(r) for r in rows]


def get_meta(pid) -> dict | None:
    with conn() as c:
        r = c.execute("SELECT * FROM paper_meta WHERE paper_id=?", (pid,)).fetchone()
    return _row_meta(r) if r else None


def upsert_meta(pid, **fields):
    cur = get_meta(pid) or {}
    merged = {**{k: cur.get(k) for k in
                 ("domain", "familiarity", "known_terms", "plan", "note", "quiz_score",
                  "visited", "collected", "domain_guess", "dismissed_terms", "quiz")}, **fields}
    with conn() as c:
        c.execute("INSERT OR REPLACE INTO paper_meta"
                  "(paper_id,domain,familiarity,known_terms,plan,note,quiz_score,visited,collected,updated_at,domain_guess,dismissed_terms,quiz)"
                  " VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)",
                  (pid, merged.get("domain"), merged.get("familiarity"),
                   json.dumps(merged.get("known_terms") or [], ensure_ascii=False),
                   json.dumps(merged.get("plan"), ensure_ascii=False) if merged.get("plan") else None,
                   merged.get("note"), merged.get("quiz_score"),
                   1 if merged.get("visited") else 0, 1 if merged.get("collected") else 0, time.time(),
                   json.dumps(merged.get("domain_guess"), ensure_ascii=False) if merged.get("domain_guess") else None,
                   json.dumps(merged.get("dismissed_terms") or [], ensure_ascii=False),
                   json.dumps(merged.get("quiz"), ensure_ascii=False) if merged.get("quiz") else None))
    return get_meta(pid)


def set_note(pid, note: str):
    return upsert_meta(pid, note=note)


def mark_visited(pid):
    m = get_meta(pid)
    if m and m.get("visited"):
        return
    upsert_meta(pid, visited=1)


def set_collected(pid, val: bool):
    return upsert_meta(pid, collected=1 if val else 0)


def clear_all_data(keep_llm_settings: bool = True) -> int:
    """一键清除：删除全部论文、卡片、档案、元数据与 PDF 文件。

    keep_llm_settings=True 时保留模型配置（base_url/model/effort），仅清除 api_key。
    返回清除的论文数。
    """
    n = len(list_papers())
    with conn() as c:
        c.execute("DELETE FROM card")
        c.execute("DELETE FROM highlight")
        c.execute("DELETE FROM paper_meta")
        c.execute("DELETE FROM profile")
        c.execute("DELETE FROM paper")
        c.execute("DELETE FROM folder")
        c.execute("DELETE FROM setting WHERE k='llm_api_key'")
        if not keep_llm_settings:
            c.execute("DELETE FROM setting")
    for f in os.listdir(PDF_DIR):
        try:
            os.remove(os.path.join(PDF_DIR, f))
        except OSError:
            pass
    return n
