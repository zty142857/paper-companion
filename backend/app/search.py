"""外部检索：arXiv + Semantic Scholar（均免费、无需 Key）。

仅返回元数据（标题/作者/年份/摘要/链接/DOI），不代下载。
"""
import re
import urllib.parse
import xml.etree.ElementTree as ET

import httpx

UA = {"User-Agent": "paper-companion/0.1 (research demo; mailto:demo@example.com)"}
DOI_RE = re.compile(r"10\.\d{4,9}/[^\s\"<>]+")
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
        out.append({"source": "arXiv", "title": title, "abstract": summary[:600],
                    "url": link, "year": pub[:4], "authors": authors})
    return out


def s2(doi_or_query: str, limit: int = 5) -> list[dict]:
    """Semantic Scholar：优先按 DOI 取 references/citations，否则关键词搜索。"""
    doi = DOI_RE.search(doi_or_query or "")
    base = "https://api.semanticscholar.org/graph/v1"
    fields = "title,abstract,year,authors,url,externalIds"
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
                    "abstract": (p.get("abstract") or "")[:600],
                    "url": p.get("url") or "",
                    "year": str(p.get("year") or ""),
                    "doi": (p.get("externalIds") or {}).get("DOI", ""),
                    "authors": [a.get("name") for a in (p.get("authors") or [])][:4]})
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
