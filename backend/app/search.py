"""外部检索：arXiv + Semantic Scholar（均免费、无需 Key）。

仅返回元数据（标题/作者/年份/摘要/链接/DOI），不代下载。
"""
import re
import difflib
import urllib.parse
import xml.etree.ElementTree as ET
from concurrent.futures import ThreadPoolExecutor

import httpx

UA = {"User-Agent": "paper-companion/0.1 (research demo; mailto:demo@example.com)"}
DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+")
ARXIV_ID_RE = re.compile(r"arxiv\.org/abs/([0-9]{4}\.[0-9]{4,5})", re.I)
ATOM = "{http://www.w3.org/2005/Atom}"


def arxiv(q: str, limit: int = 5) -> list[dict]:
    url = ("https://export.arxiv.org/api/query?search_query="
           + urllib.parse.quote(f"all:{q}") + f"&start=0&max_results={limit}")
    r = httpx.get(url, headers=UA, timeout=20)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    out = []
    for e in root.findall(f"{ATOM}entry"):
        title = (e.findtext(f"{ATOM}title") or "").strip().replace("\n", " ")
        summary = (e.findtext(f"{ATOM}summary") or "").strip().replace("\n", " ")
        link = e.findtext(f"{ATOM}id") or ""
        pub = e.findtext(f"{ATOM}published") or ""
        authors = [a.findtext(f"{ATOM}name") for a in e.findall(f"{ATOM}author")][:4]
        out.append({"source": "arXiv", "title": title, "abstract": summary[:1200],
                    "url": link, "year": pub[:4], "authors": authors, "doi": "",
                    "venue": "arXiv", "type": "preprint", "cites": 0})
    return out


def s2(doi_or_query: str, limit: int = 5) -> list[dict]:
    """Semantic Scholar：优先按 DOI 取 references/citations，否则关键词搜索。"""
    doi = DOI_RE.search(doi_or_query or "")
    base = "https://api.semanticscholar.org/graph/v1"
    fields = "title,abstract,year,authors,url,externalIds,citationCount,venue"
    if doi:
        url = f"{base}/paper/DOI:{doi.group(0)}?fields={fields}"
    else:
        url = f"{base}/paper/search?query={urllib.parse.quote(doi_or_query)}&limit={limit}&fields={fields}"
    r = httpx.get(url, headers=UA, timeout=20)
    if r.status_code != 200:
        return []
    data = r.json()
    items = data.get("data") if isinstance(data, dict) and "data" in data else [data]
    out = []
    for p in items or []:
        if not p:
            continue
        out.append({"source": "Semantic Scholar",
                    "title": (p.get("title") or "").strip(),
                    "abstract": (p.get("abstract") or "")[:1200],
                    "url": p.get("url") or "",
                    "year": str(p.get("year") or ""),
                    "doi": (p.get("externalIds") or {}).get("DOI", ""),
                    "authors": [a.get("name") for a in (p.get("authors") or [])][:4],
                    "venue": p.get("venue") or "",
                    "type": "paper",
                    "cites": int(p.get("citationCount") or 0)})
    return out[:limit]


def ref_dois(structure: dict, limit: int = 30) -> list[str]:
    """从参考文献节文本里用正则抽取 DOI。"""
    ref_secs = {s["id"] for s in structure.get("sections", []) if s.get("is_references")}
    seen, out = set(), []
    for b in structure.get("blocks", []):
        if b.get("section_id") not in ref_secs:
            continue
        for m in DOI_RE.finditer(b.get("text", "")):
            d = m.group(0).rstrip(".,;)]}")
            if d not in seen:
                seen.add(d)
                out.append(d)
        if len(out) >= limit:
            break
    return out


# ---------- 推荐文献的 DOI 落地：标题 → 真实检索结果 ----------

_TITLE_CACHE: dict[str, dict | None] = {}


def _norm_title(s: str) -> str:
    s = (s or "").lower()
    s = re.sub(r"[^\w\u4e00-\u9fff]+", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def title_similarity(a: str, b: str) -> float:
    a, b = _norm_title(a), _norm_title(b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b).ratio()


def _arxiv_doi(url: str) -> str:
    m = ARXIV_ID_RE.search(url or "")
    return f"10.48550/arXiv.{m.group(1)}" if m else ""


def crossref(title: str, limit: int = 3) -> list[dict]:
    """Crossref 按题名检索：覆盖期刊/会议论文，返回带 DOI 的候选。"""
    url = "https://api.crossref.org/works"
    params = {"query.bibliographic": title, "rows": limit,
              "select": "DOI,title,author,issued,URL,type,container-title,is-referenced-by-count,abstract"}
    r = httpx.get(url, params=params, headers=UA, timeout=10)
    if r.status_code != 200:
        return []
    items = (r.json().get("message") or {}).get("items") or []
    out = []
    for it in items:
        names = [f"{a.get('given', '')} {a.get('family', '')}".strip()
                 for a in (it.get("author") or [])][:4]
        y = (it.get("issued") or {}).get("date-parts") or [[None]]
        abstract = re.sub(r"<[^>]+>", " ", it.get("abstract") or "")
        abstract = re.sub(r"\s+", " ", abstract).strip()
        out.append({"source": "Crossref", "title": (it.get("title") or [""])[0],
                    "doi": it.get("DOI") or "", "url": it.get("URL") or "",
                    "year": str((y[0] or [None])[0] or ""), "authors": names,
                    "type": it.get("type") or "",
                    "venue": (it.get("container-title") or [""])[0],
                    "abstract": abstract[:1200],
                    "cites": int(it.get("is-referenced-by-count") or 0)})
    return out


def _openalex_abstract(inv: dict | None) -> str:
    if not inv:
        return ""
    pos: dict[int, str] = {}
    for word, idxs in inv.items():
        for i in idxs or []:
            pos[int(i)] = word
    return " ".join(pos[i] for i in sorted(pos))[:1200]


def openalex(title: str, limit: int = 5) -> list[dict]:
    """OpenAlex 题名/关键词检索：召回通常比 Crossref 更稳，且自带 DOI/摘要/引用量。"""
    url = "https://api.openalex.org/works"
    params = {"search": title, "per-page": limit,
              "select": "id,doi,title,publication_year,cited_by_count,type,"
                        "authorships,primary_location,abstract_inverted_index"}
    r = httpx.get(url, params=params, headers=UA, timeout=12)
    if r.status_code != 200:
        return []
    out = []
    for w in (r.json().get("results") or []):
        doi = (w.get("doi") or "").replace("https://doi.org/", "").replace("http://doi.org/", "")
        src = ((w.get("primary_location") or {}).get("source") or {})
        authors = [((a.get("author") or {}).get("display_name") or "")
                   for a in (w.get("authorships") or [])][:4]
        out.append({"source": "OpenAlex", "title": w.get("title") or "", "doi": doi,
                    "url": w.get("doi") or "", "year": str(w.get("publication_year") or ""),
                    "authors": [a for a in authors if a], "type": w.get("type") or "",
                    "venue": src.get("display_name") or "",
                    "abstract": _openalex_abstract(w.get("abstract_inverted_index")),
                    "cites": int(w.get("cited_by_count") or 0)})
    return out


def arxiv_title(title: str, limit: int = 3) -> list[dict]:
    """按题名精确检索 arXiv（all: 关键词检索对长标题经常召回不到原论文）。"""
    q = 'ti:"' + (title or "").replace('"', " ").strip() + '"'
    url = ("https://export.arxiv.org/api/query?search_query="
           + urllib.parse.quote(q) + f"&start=0&max_results={limit}")
    r = httpx.get(url, headers=UA, timeout=15)
    r.raise_for_status()
    root = ET.fromstring(r.text)
    out = []
    for e in root.findall(f"{ATOM}entry"):
        link = e.findtext(f"{ATOM}id") or ""
        pub = e.findtext(f"{ATOM}published") or ""
        authors = [a.findtext(f"{ATOM}name") for a in e.findall(f"{ATOM}author")][:4]
        out.append({"source": "arXiv", "title": (e.findtext(f"{ATOM}title") or "").strip().replace("\n", " "),
                    "doi": "", "url": link, "year": pub[:4], "authors": authors,
                    "type": "preprint", "container": "arXiv", "cites": 0})
    return out


def _lcs_ratio(a: list[str], b: list[str]) -> float:
    """最长连续公共词串占较短标题的比例：能容忍副标题，但能挡住词序被调换的假匹配。"""
    if not a or not b:
        return 0.0
    best = 0
    for i in range(len(a)):
        for j in range(len(b)):
            k = 0
            while i + k < len(a) and j + k < len(b) and a[i + k] == b[j + k]:
                k += 1
            if k > best:
                best = k
    return best / min(len(a), len(b))


def _title_score(a: str, b: str) -> tuple[float, bool]:
    na, nb = _norm_title(a), _norm_title(b)
    if not na or not nb:
        return 0.0, False
    if na == nb:
        return 1.0, True
    ta, tb = na.split(), nb.split()
    lcs = _lcs_ratio(ta, tb)
    jac = len(set(ta) & set(tb)) / max(1, len(set(ta) | set(tb)))
    seq = difflib.SequenceMatcher(None, na, nb).ratio()
    return 0.6 * lcs + 0.3 * jac + 0.1 * seq, False


def _cand_rank(c: dict) -> int:
    """候选来源可信度：S2 / 正式期刊会议 > arXiv > 图书章节 > 其他 Crossref 记录。"""
    src = c.get("source") or ""
    typ = c.get("type") or ""
    if src == "Semantic Scholar":
        return 0
    if src == "Crossref" and typ in ("journal-article", "proceedings-article"):
        return 1
    if src == "arXiv":
        return 2
    if src == "OpenAlex":
        return 3
    if src == "Crossref" and typ == "book-chapter":
        return 4
    return 5


def _bad_candidate(c: dict) -> bool:
    """过滤补充材料/视频/数据集等不是论文本体的 Crossref/OpenAlex 记录。"""
    title = (c.get("title") or "").strip()
    doi = (c.get("doi") or "").strip()
    if not title:
        return True
    if re.search(r"\.(mp4|mov|zip|pdf|docx?|xlsx?|pptx?)$", title, re.I):
        return True
    if "_supp" in title.lower() or re.search(r"/(mm\d+|suppl?\d*)$", doi, re.I):
        return True
    if (c.get("type") or "") in ("component", "dataset"):
        return True
    if title.lower().startswith(("dataset of", "supplementary", "correction to", "erratum")):
        return True
    return False


def _best_match(cands: list[dict], title: str) -> dict | None:
    best, best_score, best_exact, best_lcs = None, -1.0, False, 0.0
    for c in cands:
        score, exact = _title_score(c.get("title", ""), title)
        # 精确题名优先按来源可信度排序；引用量只在非精确匹配时作为微弱加分
        if not exact:
            score += min(int(c.get("cites") or 0), 500) / 500 * 0.01
        if best is None or (score, exact, -_cand_rank(c)) > (best_score, best_exact, -_cand_rank(best)):
            nt = _norm_title(c.get("title", ""))
            best, best_score, best_exact = c, score, exact
            best_lcs = _lcs_ratio(nt.split(), _norm_title(title).split())
    if not best:
        return None
    # 必须词序基本一致（或完全相等），避免 "Is Attention All You Need?" 这类近似假匹配
    if best_exact or (best_score >= 0.78 and best_lcs >= 0.85):
        return best
    return None


_STOP_WORDS = set("a an the of for and with in on to from by based using use method methods study "
                  "analysis approach model models toward towards via under over about nothing "
                  "something anything everything much many more most new novel recent paper papers "
                  "title titles completely complete fake general overview review comparative "
                  "evaluation metrics".split())

# 这些词在「机器学习/AI」类论文里太常见，不能用来证明候选与当前论文同领域
_GENERIC_TERMS = set("machine learning model models data driven control dynamic dynamics method "
                     "methods based approach review design analysis evaluation metrics neural "
                     "network networks deep reinforcement supervised unsupervised prediction "
                     "estimation optimization framework system systems".split())


def _stem(t: str) -> str:
    return t[:-1] if len(t) > 4 and t.endswith("s") else t


def _content_overlap(a: str, b: str) -> int:
    ta = {_stem(t) for t in _norm_title(a).split() if t not in _STOP_WORDS}
    tb = {_stem(t) for t in _norm_title(b).split() if t not in _STOP_WORDS}
    return len(ta & tb)


def _domain_overlap(a: str, b: str) -> int:
    ta = {_stem(t) for t in _norm_title(a).split()
          if t not in _STOP_WORDS and t not in _GENERIC_TERMS}
    tb = {_stem(t) for t in _norm_title(b).split()
          if t not in _STOP_WORDS and t not in _GENERIC_TERMS}
    return len(ta & tb)


def _best_approx(cands: list[dict], title: str, context: str = "") -> dict | None:
    """没有高置信度题名匹配时，取检索结果里最接近的一篇真实文献（仅用于推荐）。

    有 context（当前论文题名）时，要求候选同时与推荐方向和当前论文领域有实词重叠，
    避免把「经济学机器学习指南」这类只共享通用词的论文硬塞给机器人论文读者。
    """
    ranked = []
    for c in cands:
        score, exact = _title_score(c.get("title", ""), title)
        ranked.append((score, exact, -_cand_rank(c), c))
    ranked.sort(key=lambda x: x[:3], reverse=True)
    for score, exact, _, c in ranked:
        if exact:
            return c
        if context and _title_score(c.get("title", ""), context)[0] >= 0.85:
            continue                     # 不把当前论文自己当成“相关文献”
        if context and _content_overlap(c.get("title", ""), context) < 2:
            continue
        if context and _domain_overlap(c.get("title", ""), context) < 1:
            continue                     # 必须共享至少一个领域实词（cable/continuum/robot…）
        if _content_overlap(c.get("title", ""), title) < 1:
            continue
        if score >= 0.12:
            return c
    return None


def resolve(title: str, allow_approx: bool = False, context: str = "") -> dict | None:
    """用题名在 OpenAlex / Crossref / Semantic Scholar / arXiv 中找到真实论文并给出 DOI。

    strict（默认）：找不到高相似度结果就返回 None，宁可不显示 DOI，也不把模型编的题名
    伪装成真实文献。allow_approx=True（仅推荐用）：允许退到「相关文献」，由前端明确标注；
    context 传入当前论文题名，用来约束「相关文献」必须仍在同一研究领域内。
    """
    key = _norm_title(title)
    if not key:
        return None
    cache_key = ("approx:" if allow_approx else "strict:") + key + "|" + _norm_title(context)
    if cache_key in _TITLE_CACHE:
        return _TITLE_CACHE[cache_key]

    def gather(query: str, include_arxiv: bool = True) -> list[dict]:
        out: list[dict] = []
        fns = [openalex, crossref, s2] + ([arxiv_title] if include_arxiv else [])
        for fn in fns:
            try:
                out.extend(fn(query))
            except Exception:
                continue
        return out

    def usable_of(cands: list[dict]) -> list[dict]:
        out = []
        for c in cands:
            doi = (c.get("doi") or "").strip() or _arxiv_doi(c.get("url") or "")
            if doi and not _bad_candidate({**c, "doi": doi}):
                out.append({**c, "doi": doi})
        return out

    usable = usable_of(gather(title))
    hit = _best_match(usable, title)
    approximate = False
    if not hit and allow_approx:
        aug = f"{title} {context}".strip()
        if context and aug.lower() != title.strip().lower():
            hit = _best_approx(usable_of(gather(aug, include_arxiv=False)), title, context)
        if not hit:
            hit = _best_approx(usable, title, context)
        approximate = hit is not None

    found = None
    if hit:
        found = {
            "title": hit.get("title") or title,
            "doi": hit["doi"],
            "url": hit.get("url") or f"https://doi.org/{hit['doi']}",
            "year": hit.get("year") or "",
            "authors": hit.get("authors") or [],
            "source": hit.get("source") or "",
            "approximate": approximate,
            "suggested_title": title if approximate else "",
        }
        _TITLE_CACHE[cache_key] = found   # 只缓存命中；网络抖动导致的失败下次可重试
    return found


# ---------- 检索优先的推荐：方向 → 真实论文 ----------

def _work_doi(c: dict) -> str:
    return (c.get("doi") or "").strip() or _arxiv_doi(c.get("url") or "")


def search_works(query: str, limit: int = 8) -> list[dict]:
    """按关键词检索真实论文（四源并行合并）。返回项可能没有 DOI，由 pick_recommendations 过滤。"""
    fns = (openalex, crossref, s2, arxiv)
    out: list[dict] = []
    with ThreadPoolExecutor(max_workers=len(fns)) as ex:
        futures = [ex.submit(fn, query, limit) for fn in fns]
        for fut in futures:
            try:
                out.extend(fut.result())
            except Exception:
                continue
    return out


def _score_work(c: dict, query: str, context: str = "") -> float | None:
    title = c.get("title") or ""
    abstract = c.get("abstract") or ""
    title_hit = _content_overlap(query, title)
    abs_hit = _content_overlap(query, abstract)
    ctx_hit = _domain_overlap(context, f"{title} {abstract}") if context else 0
    if title_hit < 1 and abs_hit < 2:
        return None
    if context and ctx_hit < 1:
        return None
    score = (0.50 * min(title_hit, 4) / 4
             + 0.25 * min(abs_hit, 6) / 6
             + 0.15 * min(ctx_hit, 3) / 3
             + 0.05 * min(int(c.get("cites") or 0), 500) / 500)
    if abstract:
        score += 0.02
    return score


def pick_recommendations(queries: list[dict], context: str = "",
                         exclude_titles: list[str] | None = None,
                         limit: int = 3) -> list[dict]:
    """把模型给出的检索方向落地成真实论文；每条都带可验证 DOI。

    - 每方向取相关度最高、且与当前论文同领域的一篇；
    - 跳过当前论文、已读论文、补充材料/视频；
    - 方向不足 3 条时，用各方向候选池里的次优结果补齐。
    """
    excludes = [t for t in (exclude_titles or []) if t]

    def excluded(title: str) -> bool:
        if context and title_similarity(title, context) >= 0.85:
            return True
        return any(title_similarity(title, t) >= 0.85 for t in excludes)

    jobs: list[tuple[str, str]] = []
    for q in queries:
        qtext = (q.get("query") or "").strip() if isinstance(q, dict) else str(q).strip()
        why = (q.get("why") or "").strip() if isinstance(q, dict) else ""
        if qtext:
            jobs.append((qtext, why))
    if not jobs:
        return []
    # 三个方向并行检索，避免 3×4 个来源串行等待
    with ThreadPoolExecutor(max_workers=min(3, len(jobs))) as ex:
        fetched = list(ex.map(lambda job: search_works(job[0]), jobs))

    picked: list[dict] = []
    pool: list[tuple[float, dict, dict]] = []
    for (qtext, why), works in zip(jobs, fetched):
        scored: list[tuple[float, dict]] = []
        seen_doi: set[str] = set()
        for c in works:
            doi = _work_doi(c).lower()
            if not doi or doi in seen_doi or _bad_candidate({**c, "doi": doi}):
                continue
            if excluded(c.get("title") or ""):
                continue
            s = _score_work(c, qtext, context)
            if s is None:
                continue
            seen_doi.add(doi)
            scored.append((s, {**c, "doi": doi}))
        scored.sort(key=lambda x: (x[0], min(int(x[1].get("cites") or 0), 500)), reverse=True)
        for s, c in scored:
            if any(title_similarity(c.get("title") or "", p.get("title") or "") >= 0.85 for p in picked):
                continue
            picked.append({**c, "query": qtext, "why": why, "_score": s})
            break
        pool.extend((s, c, {"query": qtext, "why": why}) for s, c in scored)

    if len(picked) < limit:
        pool.sort(key=lambda x: (x[0], min(int(x[1].get("cites") or 0), 500)), reverse=True)
        for s, c, meta in pool:
            if len(picked) >= limit:
                break
            if excluded(c.get("title") or ""):
                continue
            if any(title_similarity(c.get("title") or "", p.get("title") or "") >= 0.85 for p in picked):
                continue
            picked.append({**c, **meta, "_score": s})
    return picked[:limit]
