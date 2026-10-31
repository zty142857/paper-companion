"""表格区域与单元格抽取。

主路径用 PyMuPDF 2.0 的 ``Document.to_json()``：一次调用返回表框和单元格文本，
而且不会把 ``0.0099`` 拆成 ``00099\\n.``。只对版面模型标了 ``table`` 的页运行，
避免把整篇文档重新过一遍版面模型。

仍然需要这里的三件事：

1. 过滤首页作者/单位区误检——PyMuPDF 会把作者块标成 table；
2. 把旋转表、字体乱码表降级为图片（394f p4 / p7）；
3. 用解析后的 blocks 配对表题，并给落在表框里的段落打 ``table_id``。

不删除、不重排 blocks：摘要按 ``table_id`` 过滤即可，已存的卡片锚点不受影响。
"""
import json
import re

import pymupdf

TABLES_VERSION = 2

CAPTION_RE = re.compile(r"^\s*(?:(?:table|tab\.)\s*[IVXLC\d]+|表\s*\d+)", re.I)
AFFIL_RE = re.compile(
    r"\b(university|institute|college|school|department|faculty|laborator(?:y|ies)"
    r"|academy|e-?mail|univ\.)\b|@", re.I)

# 表格框内出现这些字符说明字体映射坏了（394f p7 的 Symbol 字体）
_BAD_CHARS = ("\ufffd",)
_MAX_CAPTION_GAP = 60.0


def _page_lines(page) -> list[dict]:
    """行级文本，专供竖排表题的兜底配对（p4 整页旋转，解析器会丢掉竖排行）。"""
    out = []
    try:
        data = page.get_text("dict")
    except Exception:
        return out
    for b in data.get("blocks") or []:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines") or []:
            text = "".join((s.get("text") or "") for s in (ln.get("spans") or [])).strip()
            if text:
                out.append({"text": text,
                            "bbox": tuple(float(v) for v in ln["bbox"])})
    return out


def _page_spans(page) -> list[dict]:
    """页面所有非空 span，带线方向。只用于旋转/乱码判断。"""
    out = []
    try:
        data = page.get_text("dict")
    except Exception:
        return out
    for b in data.get("blocks") or []:
        if b.get("type") != 0:
            continue
        for ln in b.get("lines") or []:
            for s in ln.get("spans") or []:
                t = s.get("text") or ""
                if not t.strip():
                    continue
                out.append({
                    "text": t,
                    "bbox": tuple(float(v) for v in s["bbox"]),
                    "dir": ln.get("dir") or (1.0, 0.0),
                })
    return out


def _inter(a, b) -> float:
    return (max(0.0, min(a[2], b[2]) - max(a[0], b[0])) *
            max(0.0, min(a[3], b[3]) - max(a[1], b[1])))


def _area(b) -> float:
    return max(0.0, b[2] - b[0]) * max(0.0, b[3] - b[1])


def _inside_spans(box, spans) -> list[dict]:
    return [s for s in spans if _inter(box, s["bbox"]) > 0]


def _cell_text(value) -> str:
    """单元格文本：换行折成空格，顺手修 ``6 . 00`` 这类数字空格。"""
    s = str(value or "").replace("\r", "\n").replace("\u00a0", " ")
    parts = [re.sub(r"\s+", " ", p).strip() for p in s.split("\n")]
    s = " ".join(p for p in parts if p)
    s = re.sub(r"(?<=\d)\s*\.\s*(?=\d)", ".", s)
    return s.strip()


def normalize_rows(rows: list) -> list[list[str]]:
    """把 PyMuPDF 的原始 rows 清洗成矩形二维表。

    两列表（符号表/参数表）里，PyMuPDF 有时把两条 key/value 合并进一格：
    ``["3D\\nRMSE", "Three dimensional\\nRoot-Mean-Square-Error"]``。
    两边换行数相同且 >1 时拆成多行；首列为空的续行并回上一行。
    """
    raw = [[("" if c is None else str(c)) for c in (row or [])] for row in (rows or [])]
    expanded: list[list[str]] = []
    for row in raw:
        segs = [[p.strip() for p in c.splitlines() if p.strip()] for c in row]
        # 只拆“短 key + 短 value”的合并行；长句换行通常是真正的折行，不能拆
        if (len(row) == 2 and len(segs[0]) > 1
                and len(segs[0]) == len(segs[1])
                and all(len(p) <= 40 for p in segs[0])):
            expanded.extend([[a, b] for a, b in zip(segs[0], segs[1])])
        else:
            expanded.append(row)

    merged: list[list[str]] = []
    for row in expanded:
        if len(row) == 2 and not row[0].strip() and row[1].strip() and merged:
            merged[-1][1] = (merged[-1][1] + " " + row[1]).strip()
        else:
            merged.append(list(row))

    out = [[_cell_text(c) for c in row] for row in merged]
    out = [r for r in out if any(c.strip() for c in r)]
    ncol = max((len(r) for r in out), default=0)
    return [r + [""] * (ncol - len(r)) for r in out]


def rows_text(rows: list[list[str]]) -> str:
    return "\n".join(" | ".join(r) for r in rows).strip()


def _is_author_block(rows, box, page_no: int, page_h: float) -> bool:
    """首页上半部、矮、带邮箱/单位词的“表”是作者区，不是真表。"""
    if page_no != 1 or not page_h:
        return False
    if box[1] > page_h * 0.45:
        return False
    if box[3] - box[1] > page_h * 0.28:
        return False
    return bool(AFFIL_RE.search(rows_text(rows)))


def _caption_candidate(box, block, used: set[str]) -> tuple[int, float] | None:
    """返回 (优先级, 间距)：0=上方 1=下方 2=左侧 3=右侧。"""
    if block.get("id") in used:
        return None
    text = (block.get("text") or "").strip()
    if not CAPTION_RE.match(text):
        return None
    bb = (block["x0"], block["y0"], block["x1"], block["y1"])
    x_overlap = min(bb[2], box[2]) - max(bb[0], box[0]) > 0
    y_overlap = min(bb[3], box[3]) - max(bb[1], box[1]) > 0
    if bb[3] <= box[1] + 3 and x_overlap:
        return 0, box[1] - bb[3]
    if bb[1] >= box[3] - 3 and x_overlap:
        return 1, bb[1] - box[3]
    if bb[2] <= box[0] + 3 and y_overlap:
        return 2, box[0] - bb[2]
    if bb[0] >= box[2] - 3 and y_overlap:
        return 3, bb[0] - box[2]
    return None


def caption_for(box, page_blocks: list[dict], used: set[str],
                page_lines: list[dict] | None = None) -> tuple[str, str]:
    """在表框上方/下方/左右找表题块。表题文字用解析后的完整 block，不用 to_json 的 caption。

    整页旋转的表格（394f p4）解析器会丢掉竖排行，连表题块都没有；这时退到
    行级文本，只取文字做摘要，不提供 block id。
    """
    cands = []
    for b in page_blocks:
        hit = _caption_candidate(box, b, used)
        if hit is None:
            continue
        kind, gap = hit
        if gap > _MAX_CAPTION_GAP:
            continue
        cands.append((kind, gap, b))
    if not cands and page_lines:
        for ln in page_lines:
            text = re.sub(r"\s+", " ", ln.get("text") or "").strip()
            if not CAPTION_RE.match(text):
                continue
            fake = {"id": "", "text": text,
                    "x0": ln["bbox"][0], "y0": ln["bbox"][1],
                    "x1": ln["bbox"][2], "y1": ln["bbox"][3]}
            hit = _caption_candidate(box, fake, used)
            if hit is None or hit[1] > _MAX_CAPTION_GAP:
                continue
            cands.append((hit[0], hit[1], fake))
    if not cands:
        return "", ""
    cands.sort(key=lambda x: (x[0], x[1]))
    b = cands[0][2]
    text = re.sub(r"\s+", " ", b.get("text") or "").strip()
    return text, b.get("id") or ""


def _quality(rows: list[list[str]], spans: list[dict], page_h: float) -> tuple[str, str]:
    text = rows_text(rows)
    if len(rows) < 2 or (rows and len(rows[0]) < 2):
        return "image_only", "tiny"
    nonempty = sum(1 for r in rows for c in r if c.strip())
    if len(text) < 8 or nonempty < 2:
        return "image_only", "empty"
    if spans and any(abs(float(s["dir"][1])) > 0.5 for s in spans):
        return "image_only", "rotated"
    bad = (sum(text.count(ch) for ch in _BAD_CHARS)
           + sum(1 for ch in text if 0xE000 <= ord(ch) <= 0xF8FF))
    ctrl = sum(1 for ch in text if ord(ch) < 32 and ch not in "\n\t")
    if bad + ctrl > max(2, len(text) * 0.01):
        return "image_only", "garbled"
    return "ok", ""


def _dedupe(tables: list[dict]) -> list[dict]:
    """to_json 偶尔对同一张表给两个几乎重合的框；留面积大的。"""
    out: list[dict] = []
    for t in sorted(tables, key=lambda x: (x["page"], x["y0"], x["x0"])):
        tb = (t["x0"], t["y0"], t["x1"], t["y1"])
        dup = False
        for o in out:
            if o["page"] != t["page"]:
                continue
            ob = (o["x0"], o["y0"], o["x1"], o["y1"])
            if _inter(tb, ob) / max(1e-6, min(_area(tb), _area(ob))) >= 0.85:
                dup = True
                break
        if not dup:
            out.append(t)
    for i, t in enumerate(out, 1):
        t["id"] = f"t{i}"
    return out


def detect_table_pages(doc) -> list[int]:
    """版面模型标了 table 的页（0-based）。老论文懒补时先筛页，避免 to_json 全篇。"""
    out = []
    for page in doc:
        try:
            if not page.get_text("text").strip():
                continue
            page.get_layout()
            info = page.layout_information or []
            if any(str(e[4]) == "table" for e in info):
                out.append(page.number)
        except Exception:
            continue
    return out


def _to_json(doc, pages: list[int]) -> dict:
    """PyMuPDF 2.0 的表格/版面 JSON。失败时抛出，让调用方决定是否降级。

    注意 ``pages`` 是 0-based；返回的 ``page_number`` 是 1-based。
    """
    raw = doc.to_json(pages=pages, ocr=False)
    data = json.loads(raw) if isinstance(raw, str) else raw
    if not isinstance(data, dict):
        raise ValueError("to_json 返回了非对象")
    return data


def extract_tables(doc, blocks: list[dict], pages: list[int] | None = None) -> list[dict]:
    """指定页（0-based）→ ``structure["tables"]``。不修改 blocks。

    ``pages=None`` 时先跑一次版面模型筛表页；新论文解析时由 ``pdf_parse``
    把已经算好的表页传进来，避免第二次 layout。
    """
    if pages is None:
        pages = detect_table_pages(doc)
    pages = sorted({int(p) for p in pages if 0 <= int(p) < doc.page_count})
    if not pages:
        return []
    data = _to_json(doc, pages)
    by_page: dict[int, list[dict]] = {}
    for b in blocks:
        by_page.setdefault(b.get("page"), []).append(b)

    tables: list[dict] = []
    used_captions: set[str] = set()
    span_cache: dict[int, list[dict]] = {}
    line_cache: dict[int, list[dict]] = {}

    for pg in data.get("pages") or []:
        try:
            page_no = int(pg.get("page_number") or 0)
        except (TypeError, ValueError):
            continue
        page_h = float(pg.get("height") or 0)
        page = doc[page_no - 1] if 1 <= page_no <= doc.page_count else None
        if page is not None and page_no not in span_cache:
            span_cache[page_no] = _page_spans(page)
            line_cache[page_no] = _page_lines(page)
        spans = span_cache.get(page_no, [])

        for box in pg.get("boxes") or []:
            if box.get("boxclass") != "table":
                continue
            tb = box.get("table") or {}
            rows = normalize_rows(tb.get("extract") or [])
            bbox = (float(box.get("x0") or 0), float(box.get("y0") or 0),
                    float(box.get("x1") or 0), float(box.get("y1") or 0))
            if _is_author_block(rows, bbox, page_no, page_h):
                continue
            in_spans = _inside_spans(bbox, spans)
            quality, reason = _quality(rows, in_spans, page_h)
            caption, cid = caption_for(bbox, by_page.get(page_no) or [], used_captions,
                                       line_cache.get(page_no) or [])
            if cid:
                used_captions.add(cid)
            tables.append({
                "id": "",
                "page": page_no,
                "x0": round(bbox[0], 1), "y0": round(bbox[1], 1),
                "x1": round(bbox[2], 1), "y1": round(bbox[3], 1),
                "caption": caption,
                "caption_block_id": cid,
                "rows": rows if quality == "ok" else [],
                "quality": quality,
                "reason": reason,
                "source": "to_json",
            })

    return _dedupe(tables)


def tag_table_blocks(blocks: list[dict], tables: list[dict]) -> None:
    """给 ≥90% 落在表框里的 para 块打 ``table_id``；表题块保持不进表。"""
    by_page: dict[int, list[dict]] = {}
    for t in tables:
        by_page.setdefault(t["page"], []).append(t)

    for b in blocks:
        b.pop("table_id", None)
        if b.get("type") != "para":
            continue
        text = (b.get("text") or "").strip()
        if not text or CAPTION_RE.match(text):
            continue
        area = max(1e-6, (b["x1"] - b["x0"]) * (b["y1"] - b["y0"]))
        best = None
        for t in by_page.get(b.get("page"), []):
            tb = (t["x0"], t["y0"], t["x1"], t["y1"])
            bb = (b["x0"], b["y0"], b["x1"], b["y1"])
            if _inter(tb, bb) / area >= 0.9:
                if best is None or _area(tb) < _area((best["x0"], best["y0"], best["x1"], best["y1"])):
                    best = t
        if best is not None:
            b["table_id"] = best["id"]


def ensure_tables(structure: dict, pdf_path: str) -> list[dict]:
    """给老论文补 ``tables`` / ``table_id``；不重排 block id。"""
    if structure.get("tables_version") == TABLES_VERSION:
        return structure.get("tables") or []
    doc = pymupdf.open(pdf_path)
    try:
        blocks = structure.get("blocks") or []
        tables = extract_tables(doc, blocks)
        tag_table_blocks(blocks, tables)
    finally:
        doc.close()
    structure["tables"] = tables
    structure["tables_version"] = TABLES_VERSION
    return tables
