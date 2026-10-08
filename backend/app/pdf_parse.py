"""PDF -> 页→栏→节→段 块树解析。坐标仅用于点击反查，不做高亮渲染。"""
import re
import statistics
from dataclasses import dataclass, field, asdict

import pymupdf

HEADING_RE = re.compile(r"^\d{1,2}(?:\.\d{1,2}){0,3}\.?\s+[A-Z][A-Za-z].{1,80}$")
REF_HEADING_RE = re.compile(r"^(references|bibliography|参考文献|references?\s*and\s*notes)$", re.I)
UPPER_HEAD_RE = re.compile(r"[A-Z][A-Z\s,.&\-()]{3,}")


def _first_line_bold(block) -> bool:
    for ln in block["lines"]:
        return bool(ln["spans"]) and all(sp["flags"] & 16 for sp in ln["spans"] if sp["text"].strip())
    return False


def _first_line_italic(block) -> bool:
    """首行整体为斜体（部分期刊的子节标题用斜体，非加粗）。"""
    for ln in block["lines"]:
        spans = [sp for sp in ln["spans"] if sp["text"].strip()]
        return bool(spans) and all(sp["flags"] & 2 for sp in spans)
    return False


@dataclass
class Block:
    id: str
    page: int
    col: int
    type: str  # para | heading | figure | formula
    y0: float
    y1: float
    x0: float
    x1: float
    size: float = 0.0
    text: str = ""
    section_id: str | None = None


@dataclass
class Section:
    id: str
    title: str
    level: int
    page: int
    heading_block_id: str
    is_references: bool = False
    outline: str = ""
    order: int = 0


def _line_font_sizes(block) -> list[float]:
    return [max((sp["size"] for sp in ln["spans"]), default=0) for ln in block["lines"] if ln.get("spans")]


def _block_text(block) -> str:
    out = []
    for ln in block["lines"]:
        if abs(ln.get("dir", (1, 0))[1]) > 0.5:  # 竖排水印行丢弃
            continue
        s = "".join(sp["text"] for sp in ln["spans"]).strip()
        if s:
            out.append(s)
    text = " ".join(out)
    text = re.sub(r"(\w)-\s+(\w)", r"\1\2", text)  # 连字符断词
    return re.sub(r"\s{2,}", " ", text).strip()


def _detect_columns(raw_blocks, page_w: float):
    """按正文块左边缘 x0 的对齐密度分栏：同一 x0 附近堆积越多越可能是栏左界。"""
    xs = sorted(b["bbox"][0] for b in raw_blocks
                if b["type"] == 0 and b["bbox"][2] - b["bbox"][0] < page_w * 0.9)
    n = len(xs)
    if n < 8:
        return [(0.0, page_w)]
    groups = []
    for x in xs:
        if groups and x - groups[-1][-1] <= 15:
            groups[-1].append(x)
        else:
            groups.append([x])
    dom = [sum(g) / len(g) for g in groups if len(g) >= max(4, n * 0.22)]
    kept = []
    for c in dom:  # 保留栏距 >=150 的主边界链
        if not kept or c - kept[-1] >= 150:
            kept.append(c)
        else:
            kept[-1] = (kept[-1] + c) / 2
    if len(kept) < 2:
        return [(0.0, page_w)]
    bounds = [0.0] + [(a + b) / 2 for a, b in zip(kept, kept[1:])] + [page_w]
    return list(zip(bounds, bounds[1:]))


def parse_pdf(path: str) -> dict:
    doc = pymupdf.open(path)
    blocks: list[Block] = []
    sections: list[Section] = []
    bid, sid = 0, 0
    last_heading = ""  # 跨页节标题延续（"2. Method" / "2.1 xx" 分页情形不做更复杂处理）
    cur_sec: Section | None = None
    pending_head: Section | None = None  # 页首孤立标题，与上一页末标题合并判断用

    for pno, page in enumerate(doc):
        w = page.rect.width
        d = page.get_text("dict")
        raw = [b for b in d["blocks"] if (b["type"] == 0 and b.get("lines")) or b["type"] == 1]
        if not raw:
            continue
        cols = _detect_columns(raw, w)
        sizes = [s for b in raw if b["type"] == 0 for s in _line_font_sizes(b)]
        body_size = statistics.median(sizes) if sizes else 10
        items = []
        for b in raw:
            cx = (b["bbox"][0] + b["bbox"][2]) / 2
            col = min(range(len(cols)), key=lambda i: (abs(cx - (cols[i][0] + cols[i][1]) / 2)
                                                       if cols[i][0] - 1 <= cx <= cols[i][1] + 1 else 1e9))
            if b["type"] == 1:
                items.append((col, b["bbox"][1], "figure", "", b["bbox"], 0.0))
                continue
            text = _block_text(b)
            if not text:
                continue
            max_size = max(_line_font_sizes(b), default=body_size)
            alpha = sum(c.isalpha() for c in text) / max(len(text), 1)
            sizey = max_size > body_size * 1.12
            boldy = _first_line_bold(b) and max_size >= body_size * 0.95
            italic = _first_line_italic(b)
            upperish = bool(UPPER_HEAD_RE.fullmatch(text)) and not any(c.isdigit() for c in text)
            numbered = bool(HEADING_RE.match(text))
            # 数字编号标题（如 "2.1. xxx"）本身即强信号：部分期刊子节标题不加粗、不放大也不斜体，
            # 故编号匹配即可判为标题；其余情况仍需字号/加粗/斜体信号。
            is_head = (len(text) < 120 and alpha > 0.35
                       and (numbered or ((sizey or boldy or italic)
                                         and (REF_HEADING_RE.match(text) or upperish))))
            kind = "formula" if (alpha < 0.25 and any(c.isdigit() for c in text)) else "para"
            items.append((col, b["bbox"][1], "heading" if is_head else kind, text, b["bbox"], max_size))
        items.sort(key=lambda it: (it[0], it[1]))
        for col, y0, kind, text, bbox, fsize in items:
            bid += 1
            b = Block(id=f"b{bid}", page=pno + 1, col=col, type=kind,
                      y0=round(bbox[1], 1), y1=round(bbox[3], 1),
                      x0=round(bbox[0], 1), x1=round(bbox[2], 1), size=round(fsize, 1), text=text)
            if kind == "heading":
                sid += 1
                level = len(re.findall(r"\.", text[:6])) if re.match(r"^\d", text) else 0
                cur_sec = Section(id=f"s{sid}", title=text, level=level, page=b.page,
                                  heading_block_id=b.id, is_references=bool(REF_HEADING_RE.match(text)),
                                  order=len(sections))
                if cur_sec.is_references:
                    b.type = "para"
                sections.append(cur_sec)
                b.section_id = cur_sec.id
            else:
                if cur_sec is None:
                    sid += 1
                    cur_sec = Section(id=f"s{sid}", title="(正文开头)", level=0, page=b.page,
                                      heading_block_id="", order=len(sections))
                    sections.append(cur_sec)
                b.section_id = cur_sec.id
            blocks.append(b)
        pending_head = cur_sec
    meta = (doc.metadata.get("title") or "").strip()
    title = meta if len(meta) > 10 and not meta.lower().startswith("arxiv") else \
        (_guess_title(doc, blocks) or meta)
    doc.close()
    return {
        "title": title,
        "pages": pno + 1,
        "blocks": [asdict(b) for b in blocks],
        "sections": [asdict(s) for s in sections],
    }


def _guess_title(doc, blocks: list[Block]) -> str:
    # 首页顶部、字号最大的段落作为标题
    cands = [b for b in blocks if b.page == 1 and b.type == "para" and 8 < len(b.text) < 250
             and b.y0 < 250 and not b.text.startswith("arXiv:") and not HEADING_RE.match(b.text)]
    if not cands:
        return ""
    best = max(cands, key=lambda b: (b.size, -b.y0))
    return best.text


if __name__ == "__main__":
    import json, sys
    print(json.dumps(parse_pdf(sys.argv[1]), ensure_ascii=False)[:800])
