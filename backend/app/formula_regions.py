"""公式区域检测。

主路径用 PyMuPDF 2.0 内置的版面模型（``page.get_layout()`` → ``page.layout_information``），
它直接给出 ``label == "formula"`` 的框：2 篇论文 71 条编号公式上 71/71 命中，耗时约 0.17s/页。
模型不可用（老版本 PyMuPDF、裁剪安装）时回退到 span + 分数线聚类（57/71）。

输出统一成 ``structure["formulas"]`` 里的条目::

    {"page": 9, "x0": 80.7, "y0": 405.7, "x1": 286.2, "y1": 441.5,
     "number": "(23)", "src": "layout"}

坐标系与 ``structure["blocks"]`` 一致：PDF 页面坐标（pt，左上原点，未缩放）。
前端只拿它做选区吸附，所以不需要 block id —— 也就不影响已存在的卡片锚点。

开关：环境变量 ``PC_FORMULA_LAYOUT`` = ``auto``（默认）/ ``on`` / ``off``。
``off`` 只跑启发式；``on`` 只用版面模型；``auto`` 有模型就用、没有就回退。
"""
import os
import re
import statistics

import pymupdf

EQNUM_RE = re.compile(r"^\(\s*(\d{1,2}[a-z]?)\s*\)$")
_URL_RE = re.compile(r"(https?://|www\.|@|\.(com|org|net|edu)\b)", re.I)
_CAPTION_RE = re.compile(r"^(figure|fig\.|table|tab\.|algorithm|scheme)\b", re.I)
_MATH_FONT_RE = re.compile(
    r"(CMMI|CMSY|CMEX|CMR\d|MSBM|MTMI|MTSY|MTEX|Symbol|Euclid|STIX|XITS|Asana|"
    r"LMMath|CambriaMath)", re.I)
_MATH_CHARS = set("=+−±×÷·∑∏∫√≤≥≈≠≡∞∂∇∈∉⊂⊆∪∩→←↔⇒⇔⟨⟩{}|"
                  "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ")
_REL_OPS = set("=<>≤≥≈≠≡∈∉⊂⊆→←↔⇒⇔")
_FUNC_WORDS = {
    "sin", "cos", "tan", "cot", "sec", "csc", "log", "exp", "lim", "max", "min",
    "sup", "inf", "det", "rank", "diag", "arg", "var", "cov", "mod", "gcd", "deg",
    "erf", "tanh", "cosh", "sinh", "softmax", "sigmoid", "vec", "span", "adj",
    "tr", "st", "sgn", "atan", "asin", "acos", "rot", "col", "row", "avg", "std",
}
_GLUE_WORDS = {"where", "and", "or", "with", "for", "when", "if", "otherwise",
               "such", "that"}

# 版面模型给出的框是"这一块版面"的框，偶尔会把两三条紧邻公式并成一块；
# 超过页面 55% 高度的框一律视为异常（扫描件/旋转页），不做吸附区。
_MAX_HEIGHT_RATIO = 0.55
_MIN_W, _MIN_H = 14.0, 5.0


def _mode() -> str:
    v = (os.environ.get("PC_FORMULA_LAYOUT") or "auto").strip().lower()
    return v if v in ("auto", "on", "off") else "auto"


# ---------------- 版面模型 ----------------

def _layout_boxes(page) -> list[tuple] | None:
    """版面模型的 formula 框；模型不可用时返回 None（区别于"没有公式"的 []）。"""
    if not hasattr(page, "get_layout"):
        return None
    try:
        page.get_layout()
    except Exception:
        return None
    info = getattr(page, "layout_information", None)
    if info is None:
        return None
    return [tuple(float(v) for v in e[:4]) for e in info if str(e[4]) == "formula"]


def _picture_boxes(page) -> list[tuple]:
    """图片区域：版面模型的 picture 框 + 文字字典里的位图块。"""
    out = []
    info = getattr(page, "layout_information", None) or []
    for e in info:
        if str(e[4]) in ("picture", "figure"):
            out.append(tuple(float(v) for v in e[:4]))
    try:
        for b in page.get_text("dict")["blocks"]:
            if b["type"] == 1:
                out.append(tuple(b["bbox"]))
    except Exception:
        pass
    return out


# ---------------- 文字与线段 ----------------

def page_spans(page) -> list[dict]:
    """页面上所有非空 span（pt 坐标），字段与启发式检测需要的一致。"""
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for ln in b.get("lines") or []:
            for s in ln.get("spans") or []:
                if not s["text"].strip():
                    continue
                out.append({
                    "bbox": tuple(float(v) for v in s["bbox"]),
                    "text": s["text"],
                    "size": float(s["size"]),
                    "font": s.get("font") or "",
                    "italic": bool(s.get("flags", 0) & 2),
                })
    return out


def page_bars(page) -> list[tuple]:
    """分数线/根号横线：细长的矢量矩形。"""
    out = []
    try:
        drawings = page.get_drawings()
    except Exception:
        return out
    for d in drawings:
        r = d.get("rect")
        if r is None:
            continue
        if r.height <= 1.5 and r.width >= 8:
            out.append((float(r.x0), float(r.y0), float(r.x1), float(r.y1)))
    return out


def body_size(spans: list[dict]) -> float:
    sizes = [s["size"] for s in spans if s["size"] > 0]
    return statistics.median(sizes) if sizes else 10.0


# ---------------- 后处理 ----------------

def _area(b) -> float:
    return max(0.0, (b[2] - b[0])) * max(0.0, (b[3] - b[1]))


def _inter(a, b) -> float:
    return (max(0.0, min(a[2], b[2]) - max(a[0], b[0])) *
            max(0.0, min(a[3], b[3]) - max(a[1], b[1])))


def trim_number(box, spans) -> tuple[tuple, str | None]:
    """把右对齐的公式编号 ``(12)`` 从区域右侧切掉，并把它单独返回。

    编号是排版标记，不认识它比认识它更糟：带进 OCR 会变成 ``\\text{(12)}``，
    粘进 LaTeX 还要手动删。只认「同一 y 带 + 在区域右端」的独立编号，正文里的
    ``(12)`` 引用不会命中。
    """
    x0, y0, x1, y1 = box
    found = None
    for s in spans:
        m = EQNUM_RE.match(s["text"].strip())
        if not m:
            continue
        sx0, sy0, sx1, sy1 = s["bbox"]
        cy = (sy0 + sy1) / 2
        if not (y0 - 2 <= cy <= y1 + 2):
            continue
        # 编号必须落在区域里（允许 8pt 出界，版面框偶尔裁得紧）
        if sx1 < x0 or sx0 > x1 + 8:
            continue
        # 取最靠右的那个：多行公式里可能出现多个 (n)
        if found is None or sx0 > found[0]:
            found = (sx0, s["text"].strip())
    if not found:
        return (x0, y0, x1, y1), None
    cut = found[0] - 2
    if cut - x0 < 10:      # 切完什么都不剩 → 这个"编号"其实是公式本体
        return (x0, y0, x1, y1), None
    return (x0, y0, min(x1, cut), y1), found[1]


def dedupe(boxes: list[tuple], iou_threshold: float = 0.8) -> list[tuple]:
    """合并几乎完全重叠的框（版面模型偶尔对同一公式给出重复框）。"""
    out: list[tuple] = []
    for b in sorted(boxes, key=_area, reverse=True):
        if any(_inter(b, o) / max(1e-6, min(_area(b), _area(o))) >= iou_threshold for o in out):
            continue
        out.append(b)
    return out


def keep_box(b: tuple, pictures: list[tuple], page_h: float) -> bool:
    """丢掉过小、过高、以及整块落在图片里的框（图里的公式不该被拖选吸附）。"""
    w, h = b[2] - b[0], b[3] - b[1]
    if w < _MIN_W or h < _MIN_H:
        return False
    if page_h and h > page_h * _MAX_HEIGHT_RATIO:
        return False
    if any(_inter(b, p) / max(1e-6, _area(b)) >= 0.85 for p in pictures):
        return False
    return True


def filter_boxes(boxes: list[tuple], pictures: list[tuple], page_h: float) -> list[tuple]:
    return [b for b in boxes if keep_box(b, pictures, page_h)]


# ---------------- 版面框切分 ----------------
#
# 版面模型有时会把"公式 + 下面解释公式的正文 + 下一条公式"标成一个 formula 框。
# 直接拿去吸附，用户拖公式时就会把整段正文甚至下一条公式一起圈进 OCR。
# 这里按视觉行把框重新切开：连续的数学行算一段，正文行当分隔符。

# 判断"这一行是正文"不能用"有几个英文单词"：θ_rig、L_mani、T_tor 这类下标全是英文词，
# 会把公式行误判成正文。改成数虚词（the/of/and/is/where…），公式里几乎不会出现。
_STOPWORDS = {
    "the", "a", "an", "of", "and", "or", "is", "are", "was", "were", "be", "been",
    "to", "in", "on", "at", "by", "for", "with", "from", "that", "this", "these",
    "those", "which", "where", "when", "as", "it", "its", "we", "can", "may",
    "such", "than", "then", "also", "have", "has", "not", "but", "if", "using",
    "used", "between", "within", "each", "other", "all", "more", "most", "both",
    "will", "would", "should", "there", "their", "they", "our",
}
_PROSE_WORDS = 3               # 一行里 >=3 个虚词就按正文处理


def _rows_in(box, spans) -> list[dict]:
    """把框内的 span 按视觉行聚起来。

    用"纵向重叠"而不是"中心距"聚类：上下标、大括号会和正文行差 3~5pt，
    按中心距会被拆成两行，正文行里夹着的公式碎片就漏判成独立公式了。
    """
    sel = []
    for s in spans:
        sx0, sy0, sx1, sy1 = s["bbox"]
        cy = (sy0 + sy1) / 2
        if not (box[1] - 1 <= cy <= box[3] + 1):
            continue
        if sx1 < box[0] - 2 or sx0 > box[2] + 2:
            continue
        sel.append(s)
    sel.sort(key=lambda s: (s["bbox"][1], s["bbox"][0]))
    rows: list[dict] = []
    for s in sel:
        sx0, sy0, sx1, sy1 = s["bbox"]
        h = max(sy1 - sy0, 1.0)
        best, best_ov = None, 0.0
        for r in rows:
            ov = min(sy1, r["y1"]) - max(sy0, r["y0"])
            if ov <= 0:
                continue
            ratio = ov / max(1e-6, min(h, r["y1"] - r["y0"]))
            if ratio > best_ov:
                best, best_ov = r, ratio
        if best is not None and best_ov >= 0.5:
            best["spans"].append(s)
            best["y0"] = min(best["y0"], sy0)
            best["y1"] = max(best["y1"], sy1)
            best["x0"] = min(best["x0"], sx0)
            best["x1"] = max(best["x1"], sx1)
        else:
            rows.append({"spans": [s], "y0": sy0, "y1": sy1, "x0": sx0, "x1": sx1})
    rows.sort(key=lambda r: (r["y0"], r["x0"]))
    for r in rows:
        ss = sorted(r["spans"], key=lambda s: s["bbox"][0])
        r["spans"] = ss
        # 必须用空格拼接：直接相连会把 "where" + "and" 粘成一个词，正文行就漏判了
        r["text"] = re.sub(r"\s+", " ", " ".join(s["text"] for s in ss)).strip()
    return rows


def _row_kind(row) -> str:
    """math / prose / label。拿不准时算 math，避免把公式切碎。"""
    txt = row["text"]
    if not txt:
        return "label"
    if EQNUM_RE.match(re.sub(r"\s+", "", txt)):
        return "label"
    letters = re.findall(r"[A-Za-z]+", txt.lower())
    # 只认 >=2 个字母的虚词：公式里的变量 a / A 会被拆成单独的 "a"，不能算英文冠词
    if sum(1 for w in letters if len(w) >= 2 and w in _STOPWORDS) >= _PROSE_WORDS:
        return "prose"
    return "math"


def split_math_segments(box, spans) -> list[tuple]:
    """把版面框切成若干"连续数学行"的段；正文行与只剩编号的段直接丢掉。"""
    rows = _rows_in(box, spans)
    if not rows:
        # 框里没有文字层（公式是位图），保留版面框原样
        return [box]
    segs: list[list[dict]] = []
    cur: list[dict] = []
    for r in rows:
        k = _row_kind(r)
        r["kind"] = k
        if k == "prose":
            if cur:
                segs.append(cur)
                cur = []
            continue
        cur.append(r)
    if cur:
        segs.append(cur)
    out = []
    for seg in segs:
        if not any(r["kind"] == "math" for r in seg):
            continue                       # 只剩编号的段（版面模型把 (1) 单独框出来）
        out.append((
            min(r["x0"] for r in seg), min(r["y0"] for r in seg),
            max(r["x1"] for r in seg), max(r["y1"] for r in seg),
        ))
    return out


# ---------------- 启发式回退 ----------------

def _columns(spans, w, h, min_gutter=8.0):
    nb = int(w) + 1
    cov = [0] * nb
    for s in spans:
        y0, y1 = s["bbox"][1], s["bbox"][3]
        if y0 < h * 0.08 or y1 > h * 0.92:
            continue
        for x in range(max(0, int(s["bbox"][0])), min(nb, int(s["bbox"][2]) + 1)):
            cov[x] += 1
    runs, start = [], None
    for x in range(nb):
        if cov[x] == 0:
            if start is None:
                start = x
        else:
            if start is not None and x - start >= min_gutter and start > 0.18 * w and x < 0.82 * w:
                runs.append((start, x))
            start = None
    if not runs:
        return [(0.0, w)]
    bounds = [0.0] + [(a + b) / 2 for a, b in runs] + [w]
    return list(zip(bounds, bounds[1:]))


def _vlines(spans):
    spans = sorted(spans, key=lambda s: ((s["bbox"][1] + s["bbox"][3]) / 2, s["bbox"][0]))
    lines = []
    for s in spans:
        x0, y0, x1, y1 = s["bbox"]
        cy, h = (y0 + y1) / 2, max(y1 - y0, 1.0)
        best, bestd = None, 1e9
        for ln in lines:
            ly0, ly1 = ln["bbox"][1], ln["bbox"][3]
            lcy, lh = (ly0 + ly1) / 2, max(ly1 - ly0, 1.0)
            vov = min(y1, ly1) - max(y0, ly0)
            if abs(cy - lcy) <= 0.62 * max(h, lh) and vov > 0.3 * min(h, lh):
                d = abs(cy - lcy)
                if d < bestd:
                    best, bestd = ln, d
        if best is None:
            lines.append({"bbox": [x0, y0, x1, y1], "items": [s]})
        else:
            b = best["bbox"]
            best["bbox"] = [min(b[0], x0), min(b[1], y0), max(b[2], x1), max(b[3], y1)]
            best["items"].append(s)
    return [dict(bbox=tuple(l["bbox"]), items=l["items"]) for l in lines]


def _merge_fragments(lines, max_gap=9.0):
    lines = sorted(lines, key=lambda l: ((l["bbox"][1] + l["bbox"][3]) / 2, l["bbox"][0]))
    out = []
    for ln in lines:
        x0, y0, x1, y1 = ln["bbox"]
        band, h = (y0, y1), max(y1 - y0, 1.0)
        for cur in out:
            cb = cur["band"]
            ch = max(cb[1] - cb[0], 1.0)
            if min(y1, cb[1]) - max(y0, cb[0]) <= 0.5 * min(h, ch):
                continue
            cbb = cur["bbox"]
            if max(x0 - cbb[2], cbb[0] - x1) <= max_gap:
                cur["bbox"] = (min(cbb[0], x0), min(cbb[1], y0), max(cbb[2], x1), max(cbb[3], y1))
                cur["items"] = cur["items"] + ln["items"]
                break
        else:
            out.append({"bbox": ln["bbox"], "items": list(ln["items"]), "band": band})
    changed = True
    while changed:
        changed, merged = False, []
        for cur in out:
            cb = cur["band"]
            ch = max(cb[1] - cb[0], 1.0)
            hit = None
            for m in merged:
                mb = m["band"]
                mh = max(mb[1] - mb[0], 1.0)
                if min(cb[1], mb[1]) - max(cb[0], mb[0]) <= 0.5 * min(ch, mh):
                    continue
                if max(cur["bbox"][0] - m["bbox"][2], m["bbox"][0] - cur["bbox"][2]) <= max_gap:
                    hit = m
                    break
            if hit is None:
                merged.append(cur)
            else:
                hb = hit["bbox"]
                hit["bbox"] = (min(hb[0], cur["bbox"][0]), min(hb[1], cur["bbox"][1]),
                               max(hb[2], cur["bbox"][2]), max(hb[3], cur["bbox"][3]))
                hit["items"] = hit["items"] + cur["items"]
                changed = True
        out = merged
    for ln in out:
        ln["items"].sort(key=lambda s: s["bbox"][0])
        parts, prev = [], None
        for s in ln["items"]:
            if prev is not None and s["bbox"][0] - prev > max(0.18 * s["size"], 0.8):
                parts.append(" ")
            parts.append(s["text"])
            prev = s["bbox"][2]
        ln["text"] = re.sub(r"\s+", " ", "".join(parts)).strip()
        ln["size"] = max(s["size"] for s in ln["items"])
        ln["fonts"] = {s["font"] for s in ln["items"]}
        ln["italic"] = sum(len(s["text"]) for s in ln["items"] if s["italic"]) / max(len(ln["text"]), 1)
        ln["small"] = any(s["size"] < ln["size"] * 0.8 for s in ln["items"])
    return out


def _feat(ln):
    t = ln["text"]
    words = [w for w in re.findall(r"[A-Za-z]{3,}", t) if w.lower() not in _FUNC_WORDS]
    return dict(bbox=ln["bbox"], text=t, size=ln["size"],
                sym=sum(1 for c in t if c in _MATH_CHARS), words=len(words),
                word_list=words,
                math_font=any(_MATH_FONT_RE.search(f) for f in ln["fonts"]),
                italic=ln["italic"], small=ln["small"])


def _is_display_math(f, body) -> bool:
    t = f["text"]
    if not t or len(t) > 240 or _URL_RE.search(t) or _CAPTION_RE.match(t):
        return False
    if re.search(r"[A-Za-z]{2,}(?:[ ,]+[A-Za-z]{2,}){3,}", t):
        return False
    if f["words"] >= 3 and re.search(r"\b[a-z]{3,}\b", t):
        if any(w.lower() not in (_FUNC_WORDS | _GLUE_WORDS) for w in f["word_list"]):
            return False
    strong = any(c in _REL_OPS for c in t) or (f["sym"] >= 2 and f["small"])
    if not strong and not (f["math_font"] and f["sym"] >= 1):
        return False
    if f["sym"] == 0 and not f["math_font"]:
        return False
    if body and not (0.65 <= f["size"] / body <= 1.85):
        return False
    return True


def _un(a, b):
    return (min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3]))


def heuristic_boxes(page) -> list[tuple]:
    """span 聚类 + 分数线生长 + 编号并入。版面模型缺席时的兜底（实测 57/71）。"""
    spans = page_spans(page)
    if not spans:
        return []
    bars = page_bars(page)
    body = body_size(spans)
    w, h = page.rect.width, page.rect.height
    cols = _columns(spans, w, h)
    per = [[] for _ in cols]
    for s in spans:
        cx = (s["bbox"][0] + s["bbox"][2]) / 2
        per[min(range(len(cols)),
                key=lambda i: 0 if cols[i][0] <= cx <= cols[i][1]
                else min(abs(cx - cols[i][0]), abs(cx - cols[i][1])))].append(s)
    lines = []
    for part in per:
        if part:
            lines.extend(_merge_fragments(_vlines(part), max_gap=22.0 if len(cols) > 1 else 30.0))
    feats = [_feat(l) for l in lines]
    cand = [f for f in feats if _is_display_math(f, body)]
    nums = [f for f in feats if EQNUM_RE.match(f["text"])]
    cand.sort(key=lambda f: (f["bbox"][1], f["bbox"][0]))

    regions = []
    for f in cand:
        for r in regions:
            rb = r["bbox"]
            hh = max(rb[3] - rb[1], f["bbox"][3] - f["bbox"][1], 6)
            vgap = f["bbox"][1] - rb[3]
            same_line = abs((f["bbox"][1] + f["bbox"][3]) / 2 - (rb[1] + rb[3]) / 2) < 0.7 * hh
            xgap = max(f["bbox"][0] - rb[2], rb[0] - f["bbox"][2])
            if (same_line and xgap < 3.0 * hh) or (-1.0 <= vgap <= 0.8 * hh and _inter(rb, f["bbox"]) > 0):
                r["bbox"] = _un(rb, f["bbox"])
                r["lines"].append(f)
                break
        else:
            regions.append({"bbox": f["bbox"], "lines": [f]})

    for r in regions:
        for _ in range(3):
            rb = r["bbox"]
            hh = max(rb[3] - rb[1], 6)
            grew = False
            for bar in bars:
                by = (bar[1] + bar[3]) / 2
                if rb[1] - 0.55 * hh <= by <= rb[3] + 0.55 * hh and _inter(rb, bar) > 0:
                    nb = _un(rb, bar)
                    if nb != rb:
                        r["bbox"] = rb = nb
                        grew = True
            for f in feats:
                if f in r["lines"]:
                    continue
                fb = f["bbox"]
                if (_inter(rb, fb) / max(1e-6, _area(fb)) > 0.5 and f["words"] <= 1):
                    r["bbox"] = rb = _un(rb, fb)
                    r["lines"].append(f)
                    grew = True
            if not grew:
                break

    out = []
    for r in regions:
        x0, y0, x1, y1 = r["bbox"]
        # 编号并入区域，随后由 trim_number 统一切掉并记录
        rb = (x0, y0, x1, y1)
        hh = max(y1 - y0, 6)
        cy = (y0 + y1) / 2
        for num in nums:
            nb = num["bbox"]
            if abs((nb[1] + nb[3]) / 2 - cy) <= 0.55 * hh and nb[0] >= rb[2] - 2 and nb[0] - rb[2] < 160:
                rb = _un(rb, nb)
        out.append(rb)
    return out


# ---------------- 正文剔除 ----------------

def drop_formula_paragraphs(blocks: list[dict], formulas: list[dict],
                            cover: float = 0.9) -> list[dict]:
    """把"整块都在公式区域里"的正文块丢掉。

    公式在 PDF 里也是一串文字，解析器会把它们当成段落切进 blocks，于是导读、检索、
    "翻译本段"拿到的都是 ``F = ma`` 这种残片。这里按几何判定：块面积 >=90% 落在
    某条公式区域内才算公式文字。

    只动 ``para``：标题、图注即便被框住也不删。覆盖率不足 90% 的块一律保留 ——
    那多半是正文与行内公式混排（如 ``where $x$ is ...``），宁可留着也不删正文。
    """
    by_page: dict[int, list[tuple]] = {}
    for f in formulas:
        by_page.setdefault(f["page"], []).append((f["x0"], f["y0"], f["x1"], f["y1"]))
    if not by_page:
        return blocks

    out: list[dict] = []
    for b in blocks:
        if b.get("type") != "para" or not (b.get("text") or "").strip():
            out.append(b)
            continue
        area = max(1e-6, (b["x1"] - b["x0"]) * (b["y1"] - b["y0"]))
        covered = False
        for r in by_page.get(b["page"], ()):
            ix = max(0.0, min(b["x1"], r[2]) - max(b["x0"], r[0]))
            iy = max(0.0, min(b["y1"], r[3]) - max(b["y0"], r[1]))
            if (ix * iy) / area >= cover:
                covered = True
                break
        if not covered:
            out.append(b)
    return out


# ---------------- 对外入口 ----------------

def _heuristic_fill(page, spans, taken, pictures) -> list[tuple[tuple, str | None]]:
    """版面模型整条漏掉的公式：用启发式补上没被覆盖的那些。

    只补"和已有区域不重叠"的，所以不会把好区域改坏；代价是每页多跑一次启发式（~45ms）。
    """
    out: list[tuple[tuple, str | None]] = []
    for b in heuristic_boxes(page):
        box, num = trim_number(b, spans)
        if not keep_box(box, pictures, page.rect.height):
            continue
        area = max(1e-6, _area(box))
        if any(_inter(box, t) / area >= 0.3 for t in taken):
            continue
        if any(_inter(box, o[0]) / area >= 0.3 for o in out):
            continue
        out.append((box, num))
    return out


def _number_uncovered(spans, kept) -> bool:
    """页面上还有没有被区域盖住的、行末的公式编号？没有就不用补启发式。

    只认"右端对齐"的编号：同一行还有文字跟在后面的是正文里的 "(3)" 引用。
    """
    for s in spans:
        if not EQNUM_RE.match(s["text"].strip()):
            continue
        sx0, sy0, sx1, sy1 = s["bbox"]
        cy = (sy0 + sy1) / 2
        line_right = max((t["bbox"][2] for t in spans
                          if abs((t["bbox"][1] + t["bbox"][3]) / 2 - cy) <= 3), default=sx1)
        if line_right - sx1 > 25:
            continue
        if not any(b[1] - 3 <= cy <= b[3] + 3 and b[2] >= sx0 - 12 for b in kept):
            return True
    return False


def detect_page(page) -> tuple[str, list[tuple]]:
    """单页 → (来源, 原始框列表)。来源是 ``layout`` 或 ``heuristic``。"""
    mode = _mode()
    if mode != "off":
        boxes = _layout_boxes(page)
        if boxes is not None:
            return "layout", boxes
        if mode == "on":
            return "layout", []
    return "heuristic", heuristic_boxes(page)


def extract_formulas(doc, max_pages: int | None = None) -> list[dict]:
    """整个文档 → ``structure["formulas"]`` 列表（按页、纵向排序）。"""
    out: list[dict] = []
    for page in doc:
        if max_pages is not None and page.number >= max_pages:
            break
        # 扫描页没有文字层：正常 PDF 的公式一定带文字，跳过可省下整页模型推理
        try:
            if not page.get_text("text").strip():
                continue
        except Exception:
            continue
        try:
            src, boxes = detect_page(page)
        except Exception:
            continue
        if not boxes:
            continue
        spans = page_spans(page)
        pictures = _picture_boxes(page) if src == "layout" else []
        items: list[tuple[tuple, str | None]] = []
        for b in boxes:
            for seg in split_math_segments(b, spans):
                box, num = trim_number(seg, spans)
                if keep_box(box, pictures, page.rect.height):
                    items.append((box, num))
        # 近乎重合的框只留面积最大的一个
        kept: list[tuple[tuple, str | None]] = []
        for box, num in sorted(items, key=lambda t: _area(t[0]), reverse=True):
            if any(_inter(box, o[0]) / max(1e-6, min(_area(box), _area(o[0]))) >= 0.8
                   for o in kept):
                continue
            kept.append((box, num))
        # 版面模型偶尔整条漏掉（4 页那篇的公式 (2) 就没标出来）。只有当页面上还有
        # "没被覆盖的编号"时才补启发式，纯正文页/表格页不会被塞进一堆假区域。
        if src == "layout" and _number_uncovered(spans, [k[0] for k in kept]):
            for box, num in _heuristic_fill(page, spans, [k[0] for k in kept], pictures):
                kept.append((box, num))
        for b, num in kept:
            out.append({
                "page": page.number + 1,
                "x0": round(b[0], 1), "y0": round(b[1], 1),
                "x1": round(b[2], 1), "y1": round(b[3], 1),
                "number": num, "src": src,
            })
    out.sort(key=lambda f: (f["page"], f["y0"], f["x0"]))
    return out
