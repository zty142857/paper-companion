"""PDF -> 页→栏→节→段 块树解析。坐标仅用于点击反查，不做高亮渲染。

标题判定在**行级**进行（PyMuPDF 常把标题行与正文行合进同一个块，必须先拆行）：
- 编号体系：阿拉伯（"2. Method"/"2.1 xx"/"3.2.4. xxx"）、罗马（"I. INTRODUCTION"，IEEE 期刊）、
  字母子节（"A. Design"，需样式信号）、整词加粗/斜体/放大的无编号标题。
- run-in 标题：编号+标题+句号+正文同段（"3.1.4. Integral Representation. While …"）、
  加粗小标题后接正文（"Identity vs. Projection Shortcuts. We have shown …"）都拆出标题。
- 标题跨行合并（"4. Multi-section Forward and Inverse / Kinematics"）。
- 降大小写首字复原（IEEE 段落首字母特大号："T" + "HE in-situ…" → "The in-situ…"）。
- 守卫：图注/作者上标/文献条目/单位行/首页作者区 一律不判标题；
  仅靠"全大写+加粗"命中的弱标题还要在栏内上下留白充分（表格列头会被正文夹击而排除）。
"""
import re
import difflib
import statistics
from dataclasses import dataclass, asdict

import pymupdf

# ---------- 标题编号模式 ----------
# 带点阿拉伯编号："2." "3.2.4."（IEEE/Elsevier/SAGE 等）
HEAD_NUM_DOT_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})\.(?:\s+(?=[A-Za-z(])|$)")
# 无点阿拉伯编号："2.1 Data Augmentation"(LNCS) / "1 Introduction"(ICLR/NeurIPS)
HEAD_NUM_BARE_RE = re.compile(r"^(\d{1,2}(?:\.\d{1,2}){0,3})(?:\s+(?=[A-Za-z(])|$)")
# 罗马编号："I. INTRODUCTION" "IV. EXPERIMENTS"（IEEE 期刊，与正文同字号不加粗也成立）
HEAD_ROMAN_RE = re.compile(r"^(M{0,3}(?:CM|CD|D?C{0,3})(?:XC|XL|L?X{0,3})(?:IX|IV|V?I{0,3}))\.\s+(?=[A-Za-z(])")
# 字母编号："A. Design"（IEEE 子节），必须伴随样式信号
HEAD_LETTER_RE = re.compile(r"^[A-Z]\.\s+(?=[A-Z(])")
DOUBLE_INITIAL_RE = re.compile(r"^[A-Z]\.\s+[A-Z]\.\s")  # "B. A. Jones" 作者姓名格式
# 行末标题+句首大写：run-in 标题（"Integral Representation. While differential…"）
# 只在句号处切：冒号常是标题自身的组成部分（"EXPERIMENT: LOGISTIC REGRESSION"）
RUNIN_TAIL_RE = re.compile(r"^([^.!?]{2,70})\.\s+(?=[A-Z(])")
# 段首加粗小标题（无编号 run-in）："Identity vs. Projection Shortcuts. We have shown …"
# 停用词：Abstract—/Index Terms—、定理环境（Lemma 10.4. …）、算法/图表题注等都不是章节
RUNIN_STOPWORDS_RE = re.compile(
    r"^(abstract|keywords?|index terms?|acknowledg\w*|lemma|theorem|proof|corollary|"
    r"proposition|definition|remark|example|assumption|condition|note|property|case|"
    r"step|procedure|solution|answer|exercise|figure|table|fig\.)\b", re.I)
IEEE_TITLES_RE = re.compile(r",\s*(?:Senior |Associate |Student )?(?:Member|Fellow|Life Fellow),?\s*IEEE", re.I)

REF_HEADING_RE = re.compile(r"^(references|bibliography|参考文献|references?\s*and\s*notes)$", re.I)
UPPER_HEAD_RE = re.compile(r"[A-Z][A-Z\s,.&\-()]{3,}")
# 图/表/公式题注虽然也短，但不是章节标题
CAPTION_RE = re.compile(r"^(figure|fig\.?|table|tab\.?|eq\.?|equation|scheme|algorithm|listing)\b", re.I)
# 期刊栏目横幅（RESEARCH ARTICLE / OPEN ACCESS…），不是章节
BANNER_RE = re.compile(
    r"^(research|review|original|short|case|position|technical|editorial|commentary|"
    r"perspective|open|special|rapid|letter|topical)\s+(article|access|issue|paper|"
    r"communication|note|editorial|letters?)s?$", re.I)
# 参考文献条目常以年份或编号开头，容易误命中"数字编号标题"
REF_ENTRY_RE = re.compile(
    r"(?:\bIn\s+[A-Z][A-Za-z]+[,.]|\bpp?\.\s*\d|\bvol\.\s*\d|\barXiv:|\bdoi:"
    r"|,\s*(?:19|20)\d{2}\b|\((?:19|20)\d{2}\)|\b(?:19|20)\d{2}\.\s*$)", re.I)
# URL/网址行不是标题
URL_RE = re.compile(r"(https?://|www[.:]|\.(com|org|net|edu|gov)\b)", re.I)
# "LeCun, Y., Boser, B." / "Anderson V."式姓名列表开头 → 文献条目，不是标题
NAME_HEAD_RE = re.compile(r"^[A-Z][a-zA-Z'\-]{1,12}[,.]?\s+[A-Z]\.[,\s]")
# 文中带 [12] 编号引用标记的短行多为表格列/图例，不是章节标题
CITATION_RE = re.compile(r"\[\d{1,3}\]")
# 作者单位/联系信息，不是章节标题
AFFIL_RE = re.compile(
    r"\b(university|institute|college|school|department|faculty|laborator(?:y|ies)"
    r"|academy|e-?mail|univ\.)\b", re.I)
# 常见的"垃圾元数据标题"：编辑器默认值、会议页眉、生产编号
JUNK_META_RE = re.compile(
    r"^(untitled|no title|microsoft|openoffice|libreoffice|word|papers\b|abstract\b"
    r"|published as\b|accepted\b|submitted\b|preprint\b|working draft\b|journal\b"
    r"|conference\b|\d{4}\b)", re.I)

# 标题里允许出现的小词（用于"Title Case vs 整句"区分）
_SMALL_WORDS = {"a", "an", "the", "and", "or", "of", "in", "on", "for", "with", "to", "from",
                "by", "as", "at", "into", "vs", "via", "using", "is", "are", "their", "its"}


def _single_letter_only(text: str) -> bool:
    """整块由单字母词组成（图例/坐标轴标注，如 "O O O O D D C D D"）→ 不是标题。"""
    words = [w.strip(".,:;()[]") for w in text.split()]
    return bool(words) and all(len(w) <= 1 for w in words)


def _authorish(text: str) -> bool:
    """作者行特征：姓名后带机构编号上标（"Webster III1"）或逗号+编号（"Xanthidis,1"）→ 不是标题。"""
    return bool(re.search(r"[A-Za-z]\d", text)) or bool(re.search(r"[A-Za-z],\d{1,2}(?![\d.])", text))


def _upper_dominant(text: str) -> bool:
    """字母里大部分是大写（全大写/小型大写标题）→ 是标题的大小写特征。"""
    ls = [c for c in text if c.isalpha()]
    return bool(ls) and sum(c.isupper() for c in ls) / len(ls) >= 0.7


def _titlecased(text: str) -> bool:
    """实词首字母大写的短语（典型标题大小写），排除正文句子。"""
    words = re.findall(r"[A-Za-z][A-Za-z'\-]*", text)
    if not 1 <= len(words) <= 14:
        return False
    for w in words:
        if w[0].isupper() or w.isupper() or w.lower() in _SMALL_WORDS:
            continue
        return False
    return True


def _num_level(num: str) -> int:
    return num.count(".") + 1


def _line_of(ln) -> dict:
    """行→结构化信息。span 之间若存在明显水平间隙（不少 PDF 把词间空格编码为位移而非
    空格字符），补回空格，否则会黏成 "OpportunitiesForFutureResearch" 毁掉一切正则。"""
    spans = ln["spans"]
    parts, prev = [], None
    for sp in spans:
        t = sp["text"]
        if not t.strip():
            if prev is not None and t:
                parts.append(" ")
            prev = sp
            continue
        if prev is not None:
            gap = sp["bbox"][0] - prev["bbox"][2]
            if gap > max(0.15 * max(sp["size"], prev["size"]), 0.8):
                parts.append(" ")
        parts.append(t)
        prev = sp
    nonblank = [sp for sp in spans if sp["text"].strip()]
    return {
        # \xa0（不换行空格）不少出版社用它做词距，统一成普通空格再参与正则/展示
        "text": re.sub(r"\s+", " ", "".join(parts)).strip(),
        "spans": spans,
        "bbox": ln["bbox"],
        "size": max((sp["size"] for sp in nonblank), default=0.0),
        "bold": bool(nonblank) and all(sp["flags"] & 16 for sp in nonblank),
        "italic": bool(nonblank) and all(sp["flags"] & 2 for sp in nonblank),
    }


def _classify_numbered(text: str, body_size: float, size: float, bold: bool, italic: bool,
                       fresh: bool, next_line: str | None) -> tuple[str, int, str | None] | None:
    """阿拉伯/罗马编号标题判定，按信号强度分级，返回 (标题, 层级, 行内剩余文本|None)。

    1) Title Case / 全大写正文："1.1. Contribution"、"2.1 ARCHITECTURE" 直接成立。
    2) 加粗或大于正文（strong）：句子式正文也可（"2. Material and methods"）。
    3) 无任何样式、正文是句子的（LaTeX 小型大写标题 "2. Plane quartics…"）：短句、无逗号、
       字号不低于正文 0.95 倍；且要么本行内含 run-in 断点（"标题. 正文句"），要么下一行
       不是小写开头的长句——否则是本行未说完的正文/脚注
       （"50. This allowed us…"、"1. The molecular opacity regime…"）。
    以上都不成立的分支要求 fresh（块首行或上一行以句末标点收尾），
    挡住恰好断到行首的正文句子。"""
    if _MATH_JUNK_RE.search(text):  # 公式碎片（含 ⊕ ∑ ð ≤ 等符号）不可能是标题
        return None
    if size < body_size * 0.88 and not bold:
        return None  # 明显小于正文的无加粗文字（脚注、算法步骤、表格单元）不是标题
    strong = bold or (0 < body_size < size / 1.03)  # 加粗/放大（不含斜体：公式变量多为斜体，易撞）
    styled = strong or italic
    m = HEAD_NUM_DOT_RE.match(text)
    mdot = bool(m)
    if not m:
        m = HEAD_NUM_BARE_RE.match(text)
    if m and m.group(1):
        num, body = m.group(1), text[m.end():].strip()
        if not body or not re.match(r"[A-Z(\d]", body) or NAME_HEAD_RE.match(body):
            return None  # 编号后须接大写（挡"24 times…"/"0.61 deg…"式正文句与作者列表）
        lvl = _num_level(num)
        if not fresh:
            # 例外：块中段的多级编号短标题（如 "3.1.3. Frenet–Serret Frames." 被并入上段块）
            if not (lvl >= 2 and len(body) < 50 and _titlecased(body)
                    and not re.search(r"[,;!?]", body)):
                return None
        r = RUNIN_TAIL_RE.match(body)
        if r and _titlecased(r.group(1)):
            return f"{num}. {r.group(1)}", lvl, (body[r.end():].strip() or None)
        if not mdot and "." not in num and not strong:
            return None  # 无点无尾点的单级编号（"1 Introduction"）只认加粗/放大
        if _titlecased(body) or _upper_dominant(body):
            if body.rstrip().endswith("-"):
                return None  # 整行以断词连字符收尾 = 句子片段
            if _upper_dominant(body) and len(body.split()) <= 2 and lvl == 1 and not styled:
                return None  # "2. DIVE-SCI"式表格列名短桩
            return f"{num}. {body}", lvl, None
        if styled:
            if r and len(r.group(1).split()) <= 12 and not re.search(r"[,;!?]", r.group(1)):
                return f"{num}. {r.group(1)}", lvl, (body[r.end():].strip() or None)
            if not re.search(r"[,;!?]", body) and not body.rstrip().endswith("-"):
                return f"{num}. {body}", lvl, None
            return None
        if mdot or "." in num:
            if size < body_size * 0.95:
                return None
            if r and 2 <= len(r.group(1).split()) <= 12 and not re.search(r"[,;!?]", r.group(1)):
                return f"{num}. {r.group(1)}", lvl, (body[r.end():].strip() or None)
            # 下一行是小写开头的长句 = 本行是段落/脚注首行（"1. The molecular opacity regime…"），
            # 不是标题；真标题要么本行内含 run-in 断点（上面已返回），要么独占一行。
            cont = next_line is not None and len(next_line) >= 35 and next_line[:1].islower()
            if (not cont and len(body.split()) <= 14
                    and not re.search(r"[,;!?]", body) and not body.rstrip().endswith("-")):
                return f"{num}. {body}", lvl, None
        return None
    m = HEAD_ROMAN_RE.match(text)
    if m and m.group(1) and fresh and not text.rstrip().endswith("-"):
        body = text[m.end():]
        # 单字母（C./D./V./X.）既是合法罗马数字又是 IEEE 子节字母：
        # IEEE 顶级罗马标题全大写（"V. CONCLUSION"），子节字母是 Title Case 且带样式信号
        #（"C. Actuation System Design" 斜体）→ 单字母只认全大写，多字母才接受 Title Case。
        if _upper_dominant(body):
            return text, 1, None
        if len(m.group(1)) >= 2 and styled and _titlecased(body):
            return text, 1, None
    return None


# 缩写句点 ≠ 句子边界：上一行以 "Fig."/"Eq."/"et al." 等收尾时，下一行是续排正文
NOT_BOUNDARY_ABBREV_RE = re.compile(
    r"(?:\b(?:fig|eqs?|refs?|tabs?|vols?|nos?|pp|cf|vs|secs?|chs?|thms?|lems?|cors?|props?|"
    r"defs?|rems?|algs?|approx|e\.g|i\.e|et al)\.)\s*$", re.I)

# 数学/乱码碎片守卫：出现这些运算符号的"行"不是标题
_MATH_JUNK_RE = re.compile(r"[⊕∑∫√∂∇∈⊂⊆≤≥≠≈×÷±∞⟨⟩ðℝ𝔼∘⊗↔→]")


def _classify_head_line(text: str, size: float, bold: bool, italic: bool,
                        body_size: float, fresh: bool = True,
                        next_line: str | None = None) -> tuple[str, int, str | None] | None:
    """行级标题判定：返回 (标题文本, 层级, 行内剩余文本|None)，非标题返回 None。

    层级：阿拉伯按编号段数（1./2.1/3.2.4→1/2/3…）；罗马→1；字母→2；references 关键词→0。"""
    if not text or len(text) > 140:
        return None
    if size < body_size * 0.88 and not bold:
        return None  # 明显小于正文的无加粗文字（脚注/算法步骤/表格单元）不是标题
    if _single_letter_only(text) or _authorish(text) or IEEE_TITLES_RE.search(text):
        return None
    if URL_RE.search(text):
        return None
    if REF_ENTRY_RE.search(text) or CAPTION_RE.match(text) or AFFIL_RE.search(text):
        return None
    if CITATION_RE.search(text):
        return None  # 行内含 "[12]" 式引用标记 → 参考文献/图注内容
    alpha = sum(c.isalpha() for c in text) / max(len(text), 1)
    if alpha < 0.35:
        return None

    res = _classify_numbered(text, body_size, size, bold, italic, fresh, next_line)
    if res:
        head, lvl, rest = res
        if len(head) <= 140:
            return head, lvl, rest

    styled = bold or italic or (0 < body_size < size / 1.03)
    m = HEAD_LETTER_RE.match(text)
    if m and styled and fresh and not DOUBLE_INITIAL_RE.match(text):
        body = text[m.end():]
        if _upper_dominant(body) or _titlecased(body):
            return text, 2, None

    if REF_HEADING_RE.match(text) and len(text) <= 40:
        return text, 0, None
    return None


def _bold_runin(line: dict) -> tuple[str, dict] | None:
    """无编号加粗小标题后接正文（"Identity vs. Projection Shortcuts. We have shown …"）→
    拆成 (标题文本, 剩余正文行)。整行同样式的（如 Abstract— 整行粗体）不拆。"""
    if line["bold"] or not line["spans"]:
        return None
    head_txt, tail_spans, seen_nonbold = "", [], False
    for sp in line["spans"]:
        is_bold = bool(sp["flags"] & 16)
        if not tail_spans and is_bold and not seen_nonbold:
            head_txt += sp["text"]
        else:
            if not is_bold:
                seen_nonbold = True
            tail_spans.append(sp)
    if not tail_spans or not head_txt.strip():
        return None
    prefix = head_txt.strip()
    tail_txt = "".join(sp["text"] for sp in tail_spans).strip()
    if not (6 <= len(prefix) <= 70) or not prefix.endswith((".", ":")):
        return None
    if not re.match(r"[A-Z(\d]", tail_txt) or RUNIN_STOPWORDS_RE.match(prefix):
        return None
    body = prefix.rstrip(".:")
    if CAPTION_RE.match(body) or not (_titlecased(body) or _upper_dominant(body)):
        return None
    rest = dict(line)
    rest["text"] = tail_txt
    return prefix, rest


def _plain_heading(text: str, lines: list, max_size: float, body_size: float,
                   alpha: float, italic: bool) -> bool:
    """无编号、无加粗、字号只比正文大一点点的单行短标题。

    典型如 ASME/Elsevier 单行标题：10pt 标题 + 9pt 正文，字体与正文不同但 PyMuPDF 不报加粗。
    判据刻意保守：单行、首字母大写、1~12 词、无句末标点、大小写模式像标题、
    字号在正文的 1.04~1.30 倍之间。"""
    if len(lines) != 1 or not text:
        return False
    if CAPTION_RE.match(text) or BANNER_RE.match(text) or text[0].islower() or text[0].isdigit():
        return False
    if _single_letter_only(text) or _authorish(text) or AFFIL_RE.search(text) or italic:
        return False
    words = text.split()
    if not (1 <= len(words) <= 12) or not (4 <= len(text) < 90):
        return False
    if alpha < 0.5 or re.search(r"[.,;:]\s*$", text):
        return False
    if not body_size or not (_titlecased(text) or _upper_dominant(text)):
        return False
    return 1.04 <= (max_size / body_size) <= 1.30


def _inside_figure(bbox, figure_boxes: list) -> bool:
    """文本块大部分落在图片区域里 → 是图内标注（如任务名、坐标轴文字），不是章节标题。"""
    x0, y0, x1, y1 = bbox
    area = max((x1 - x0) * (y1 - y0), 1e-6)
    for fx0, fy0, fx1, fy1 in figure_boxes:
        ix = max(0.0, min(x1, fx1) - max(x0, fx0))
        iy = max(0.0, min(y1, fy1) - max(y0, fy0))
        if (ix * iy) / area >= 0.6:
            return True
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


def _join_lines(lines: list) -> str:
    text = " ".join(ln["text"] for ln in lines)
    text = re.sub(r"(\w)-\s+(\w)", r"\1\2", text)  # 连字符断词
    return re.sub(r"\s{2,}", " ", text).strip()


def _union_bbox(lines: list) -> tuple:
    return (min(l["bbox"][0] for l in lines), min(l["bbox"][1] for l in lines),
            max(l["bbox"][2] for l in lines), max(l["bbox"][3] for l in lines))


def _clean_lines(block, body_size: float) -> list:
    """提取块内有效行（丢弃竖排水印），并复原降大小写首字（drop-cap）：
    IEEE 等模板段落首字母为特大号单字母行 + 后续整词大写，如 "T" + "HE in-situ…" → "The in-situ…"。"""
    raw = []
    for ln in block["lines"]:
        if abs(ln.get("dir", (1, 0))[1]) > 0.5:  # 竖排水印行丢弃
            continue
        l = _line_of(ln)
        if l["text"]:
            raw.append(l)
    out, i = [], 0
    while i < len(raw):
        t = raw[i]["text"]
        if (len(t) == 1 and t.isupper() and raw[i]["size"] > body_size * 1.3
                and i + 1 < len(raw)):
            m = re.match(r"^([A-Z]{2,15})\b", raw[i + 1]["text"])
            if m:
                word = m.group(1)
                nxt = dict(raw[i + 1])
                nxt["text"] = t + word.lower() + nxt["text"][len(word):]
                b1, b2 = raw[i]["bbox"], nxt["bbox"]
                nxt["bbox"] = (min(b1[0], b2[0]), min(b1[1], b2[1]),
                               max(b1[2], b2[2]), max(b1[3], b2[3]))
                out.append(nxt)
                i += 2
                continue
        out.append(raw[i])
        i += 1
    # 同一视觉行的编号片段合并：不少模板（ICLR/LNCS/NeurIPS）把标题编号"1"/"2.1"与
    # 标题文字之间留大间隙，被解析成同 y 的两个"行"。
    frag_re = re.compile(r"^(?:\d{1,2}(?:\.\d{1,2}){0,3}\.?|[IVXLCDM]{1,6}\.?|[A-Z]\.)$")
    merged = []
    i = 0
    while i < len(out):
        a = out[i]
        b = out[i + 1] if i + 1 < len(out) else None
        if (b and len(a["text"]) <= 10 and frag_re.fullmatch(a["text"])
                and abs(a["bbox"][1] - b["bbox"][1]) < 2.0
                and b["bbox"][0] >= a["bbox"][2] - 1
                and b["text"][0].isalpha()):
            comb = dict(a)
            gap = b["bbox"][0] - a["bbox"][2]
            comb["text"] = a["text"] + ("" if gap < 1.5 else " ") + b["text"]
            comb["spans"] = a["spans"] + b["spans"]
            a1, a2 = a["bbox"], b["bbox"]
            comb["bbox"] = (min(a1[0], a2[0]), min(a1[1], a2[1]), max(a1[2], a2[2]), max(a1[3], a2[3]))
            nb = [s for s in comb["spans"] if s["text"].strip()]
            comb["size"] = max(a["size"], b["size"])
            comb["bold"] = bool(nb) and all(s["flags"] & 16 for s in nb)
            comb["italic"] = bool(nb) and all(s["flags"] & 2 for s in nb)
            merged.append(comb)
            i += 2
            continue
        merged.append(a)
        i += 1
    return merged


def _split_block_to_items(lines: list, body_size: float, top_zone: bool) -> list:
    """把一个文本块的行序列切成 [("head", text, level, lines) / ("para", lines)] 片段。

    标题可出现在块的任意位置（PyMuPDF 常把相邻标题/正文合并成一个块）；
    标题若换行（下一行是短的 Title Case 片段，且其后是长正文或另一个标题），合并为一条标题。"""
    segs, para, i = [], [], 0

    def flush():
        if para:
            segs.append(("para", list(para)))
            para.clear()

    def head_of(idx):
        ln = lines[idx]
        if top_zone and not (HEAD_NUM_DOT_RE.match(ln["text"]) or HEAD_NUM_BARE_RE.match(ln["text"])):
            return None  # 首页标题/作者/机构区：只认阿拉伯编号，不认罗马/字母（作者名易撞形）
        # fresh：块首行、或紧邻的上一行是句末标点收尾、或前面全是已消费的标题（para 为空）；
        # 段落中间恰好以编号开头的续行不算标题起点。
        if not para:
            fresh = True
        else:
            prev = para[-1]["text"].rstrip()
            fresh = (bool(re.search(r"[.;:!?)\u2019\u201d]$", prev))
                     and not NOT_BOUNDARY_ABBREV_RE.search(prev))
        next_line = lines[idx + 1]["text"] if idx + 1 < len(lines) else None
        return _classify_head_line(ln["text"], ln["size"], ln["bold"], ln["italic"],
                                   body_size, fresh, next_line)

    while i < len(lines):
        ln = lines[i]
        res = head_of(i)
        if res:
            flush()
            head, lvl, rest = res
            grp = [ln]
            i += 1
            # 标题跨行（run-in 已切出剩余文本时不再并行）：下一行短、像标题、且其后是长正文/标题/块尾
            while rest is None and i < len(lines) and len(grp) <= 3:
                t2 = lines[i]["text"]
                if _single_letter_only(t2):        # 降大小写首字母残留
                    break
                # 标题行以 and/of/the 等小词收尾 → 一定被截断，下一行是标题延续（小写开头也并）
                dangling = bool(re.search(rf"\s(?:{'|'.join(_SMALL_WORDS)})$", head, re.I))
                if head_of(i) or len(t2) >= (55 if dangling else 40):
                    break
                if not (dangling or _titlecased(t2) or _upper_dominant(t2)):
                    break
                nxt = lines[i + 1]["text"] if i + 1 < len(lines) else ""
                if nxt and len(nxt) < 40 and not head_of(i + 1) and not _single_letter_only(nxt):
                    break  # 后面还是短句 → 说明是正文行不是标题延续
                head = f"{head} {t2}"
                grp.append(lines[i])
                i += 1
            segs.append(("head", head, lvl, grp))
            if rest:
                # run-in 的行内剩余文本回流段落（spans 清空：避免 _bold_runin 再次从头切）
                para.append({**ln, "text": rest, "spans": []})
        else:
            para.append(ln)
            i += 1
    flush()
    return segs


def _para_left_edges(raw_blocks, page_w: float):
    """段落级块的左边缘 x0 与宽度。只统计"真段落"（≥2 行或 ≥60 字符）：
    公式/图注/表格单元格的左边缘五花八门，双栏公式密集页里会稀释右栏计数、
    导致整页误判为单栏（Elsevier 论文实测）。"""
    out = []
    for b in raw_blocks:
        if b["type"] != 0 or b["bbox"][2] - b["bbox"][0] >= page_w * 0.9:
            continue
        nlines = len(b.get("lines", []))
        chars = sum(len(sp["text"].strip()) for ln in b.get("lines", []) for sp in ln.get("spans", []))
        if nlines >= 2 or chars >= 60:
            out.append((b["bbox"][0], b["bbox"][2] - b["bbox"][0]))
    return out


def _cluster_centers(vals, min_count=3, bin_w=25.0, gap=150.0):
    """找"栏左边缘"候选：25pt 定宽分箱 + 按块数贪心选取。

    不用链式聚类+均值：公式缩进、表格位移的 x0 会链进主簇把栏边中心带偏
    （实测 57 被拉成 85），定宽分箱下真正的栏边缘永远是计数最高的箱。"""
    bins: dict[int, list] = {}
    for x in vals:
        bins.setdefault(int(x // bin_w), []).append(x)
    cand = sorted(((len(v), sum(v) / len(v)) for v in bins.values()), reverse=True)
    picked = []
    for cnt, cen in cand:
        if cnt < min_count:
            break
        if all(abs(cen - p) >= gap for p in picked):
            picked.append(cen)
    return sorted(picked)


def _bounds_from_centers(centers, page_w: float):
    kept = []
    for c in sorted(centers):  # 保留栏距 >=150 的主边界链
        if not kept or c - kept[-1] >= 150:
            kept.append(c)
        else:
            kept[-1] = (kept[-1] + c) / 2
    if len(kept) < 2:
        return [(0.0, page_w)]
    bounds = [0.0] + [(a + b) / 2 for a, b in zip(kept, kept[1:])] + [page_w]
    return list(zip(bounds, bounds[1:]))


def _detect_columns(raw_blocks, page_w: float):
    """按正文块左边缘 x0 的对齐密度分栏：同一 x0 附近堆积越多越可能是栏左界。"""
    paras = _para_left_edges(raw_blocks, page_w)
    n = len(paras)
    if n < 6:
        return [(0.0, page_w)]
    dom = _cluster_centers([x for x, _ in paras], min_count=max(3, n * 0.15))
    return _bounds_from_centers(dom, page_w)


def _doc_column_centers(pages_raw) -> list:
    """整篇聚合段落左边缘找栏位：双栏期刊的栏 x 位置全书固定，
    单页证据不足（短页/图表页）时用全局结果兜底。pages_raw: [(w, raw_blocks)]"""
    xs, total = [], 0
    for w, raw in pages_raw:
        paras = _para_left_edges(raw, w)
        xs += [x for x, _ in paras]
        total += len(paras)
    if total < 24:
        return []
    dom = _cluster_centers(xs, min_count=max(10, total * 0.03))
    return dom if len(dom) >= 2 else []


def _meta_title_ok(meta: str) -> bool:
    """PDF 元数据标题合法性：出版系统常把生产编号/状态语/编辑器默认值写进 Title
    （如 "IJR368147 1661..1683" "untitled" "Published as a conference paper…"），
    这类要拒绝，回退到正文猜测。"""
    if not meta or len(meta) < 8 or meta.lower().startswith("arxiv"):
        return False
    letters = sum(c.isalpha() for c in meta)
    if letters < max(8, int(len(meta) * 0.6)):
        return False
    if JUNK_META_RE.match(meta):
        return False
    if re.match(r"^[A-Z]{2,8}\d+", meta):  # 期刊生产号 IJR368147…
        return False
    if re.search(r"\d{3,}\.\.?\d{3,}", meta) or re.search(r"\d{3,}[-–]\d{3,}", meta):  # 页码区间 1661..1683
        return False
    if not re.search(r"[A-Za-z]{4,}", meta):
        return False
    return True


def _guess_title(blocks: list, body_size: float, page_h: float) -> str:
    """首页顶部字号最大、且像标题的段落作为论文标题；
    标题常拆成多个同字号的连续行块（每行一块），按纵向顺序合并成完整标题。"""
    cands = []
    for b in blocks:
        if b.page != 1 or not (10 <= len(b.text) <= 250):
            continue
        if b.y0 > page_h * 0.45 or b.size < body_size * 1.15:
            continue
        t = b.text
        alpha = sum(c.isalpha() for c in t) / max(len(t), 1)
        if alpha < 0.5 or t.startswith(("arXiv:", "arXiv ", "DOI ", "DOI:")):
            continue
        if CAPTION_RE.match(t) or REF_HEADING_RE.match(t):
            continue
        if _authorish(t) or AFFIL_RE.search(t) or "@" in t:
            continue
        if re.search(r"\b(Vol\.|No\.\s*\d|ISSN|ISBN|Copyright|Received|Accepted)\b", t):
            continue
        cands.append(b)
    if not cands:
        return ""
    best = max(cands, key=lambda b: (b.size, -b.y0))
    text, y1, size = best.text, best.y1, best.size
    line_h = max(best.y1 - best.y0, 8)
    # 向下接龙：紧随其下、字号相近的候选块（标题续行）
    for _ in range(4):
        nxt = [b for b in cands
               if b is not best and 0 <= b.y0 - y1 <= line_h * 1.6
               and 0.82 * size <= b.size <= 1.22 * size
               and not text.endswith((".", "?", "!"))]
        if not nxt:
            break
        b = min(nxt, key=lambda x: x.y0)
        text += ("" if text.endswith("-") else " ") + b.text
        y1, size = max(y1, b.y1), max(size, b.size)
        if len(text) > 300:
            break
    return re.sub(r"\s{2,}", " ", text).strip()


def parse_pdf(path: str) -> dict:
    doc = pymupdf.open(path)
    blocks: list[Block] = []
    sections: list[Section] = []
    bid, sid = 0, 0
    cur_sec: Section | None = None
    last_head = ""  # 相邻重复的同名标题（如跨页的 "References"）不再建节

    n_pages = len(doc)
    page_h0 = doc[0].rect.height if n_pages else 792
    pages_data = [(page.rect.width, page.rect.height, page.get_text("dict")) for page in doc]
    pages_raw = [(w, [b for b in d["blocks"] if (b["type"] == 0 and b.get("lines")) or b["type"] == 1])
                 for w, _h, d in pages_data]
    doc_centers = _doc_column_centers(pages_raw)  # 全书栏位基准，短页检测失败时兜底
    # 正文基准字号取整篇的中位数：按单页取中位数会被图表密集页带偏，
    # 导致图内小标签（6~7pt）反而"比正文大"而被误判成标题。
    all_sizes = [max((sp["size"] for sp in ln["spans"]), default=0)
                 for _w, _h, d in pages_data for b in d["blocks"] if b["type"] == 0
                 for ln in b["lines"] if ln.get("spans")]
    all_sizes = [s for s in all_sizes if s > 0]
    body_size = statistics.median(all_sizes) if all_sizes else 10

    for pno, (w, h, d) in enumerate(pages_data):
        raw = pages_raw[pno][1]
        if not raw:
            continue
        cols = _detect_columns(raw, w)
        if pno >= 1 and len(cols) == 1 and len(doc_centers) >= 2:
            # 本页段落证据不足以定栏，但全书有稳定双栏格局 → 借用文档级栏位。
            # 通栏段落占多数（标题/摘要页）的页保持单栏，避免通栏块被拆进两栏错排；
            # 双栏页里偶见的宽表格/通栏公式不算数。
            paras = _para_left_edges(raw, w)
            full_frac = sum(1 for _, wd in paras if wd > w * 0.62) / max(len(paras), 1)
            covered = {c for c in doc_centers for x, _ in paras if abs(x - c) <= 30}
            if full_frac < 0.5 and len(covered) >= 2:
                cols = _bounds_from_centers(sorted(covered), w)
        figure_boxes = [b["bbox"] for b in raw if b["type"] == 1]
        items = []  # (col, y0, kind, text, bbox, size, level, weak)
        for b in raw:
            cx = (b["bbox"][0] + b["bbox"][2]) / 2
            col = min(range(len(cols)), key=lambda i: (abs(cx - (cols[i][0] + cols[i][1]) / 2)
                                                       if cols[i][0] - 1 <= cx <= cols[i][1] + 1 else 1e9))
            if b["type"] == 1:
                items.append((col, b["bbox"][1], "figure", "", b["bbox"], 0.0, None, False))
                continue
            lines = _clean_lines(b, body_size)
            if not lines:
                continue
            top_zone = pno == 0 and lines[0]["bbox"][1] < h * 0.30  # 首页标题/作者/机构区
            for seg in _split_block_to_items(lines, body_size, top_zone):
                if seg[0] == "head":
                    _, text, lvl, grp = seg
                    bbox = _union_bbox(grp)
                    size = max(g["size"] for g in grp)
                    # 首页顶部的大字非编号标题块（全大写论文标题模板）不当章节，留给 _guess_title
                    if (pno == 0 and bbox[1] < h * 0.45 and size >= body_size * 1.35
                            and not (HEAD_NUM_DOT_RE.match(text) or HEAD_NUM_BARE_RE.match(text)
                                     or HEAD_ROMAN_RE.match(text) or REF_HEADING_RE.match(text))):
                        items.append((col, bbox[1], "para", text, bbox, size, None, False))
                    else:
                        items.append((col, bbox[1], "heading", text, bbox, size, lvl, False))
                    continue
                grp = seg[1]
                ri = _bold_runin(grp[0])
                if ri:
                    prefix, tail = ri
                    items.append((col, grp[0]["bbox"][1], "heading", prefix, grp[0]["bbox"],
                                  grp[0]["size"], 0, False))
                    grp = [tail] + grp[1:]
                text = _join_lines(grp)
                if not text:
                    continue
                bbox = _union_bbox(grp)
                max_size = max(g["size"] for g in grp)
                alpha = sum(c.isalpha() for c in text) / max(len(text), 1)
                first = grp[0]
                sizey = max_size > body_size * 1.12
                boldy = first["bold"] and max_size >= body_size * 0.95
                italic = first["italic"]
                upperish = bool(UPPER_HEAD_RE.fullmatch(text)) and not any(c.isdigit() for c in text)
                # 无编号"全大写+样式"弱兜底（表格列头也常命中）→ 标记 weak，排序后按栏内留白复核；
                # plain（字号略大于正文的 Title Case 短行）本身判据已严，不参与留白复核。
                weak = (len(text) < 120 and alpha > 0.35
                        and not _single_letter_only(text) and not _authorish(text)
                        and not BANNER_RE.match(text)
                        and ((sizey or boldy or italic) and upperish and not AFFIL_RE.search(text)))
                plain = _plain_heading(text, grp, max_size, body_size, alpha, italic)
                if plain and _inside_figure(bbox, figure_boxes):
                    plain = False
                # 首页顶部的大字块是论文标题（全大写模板也会命中 upperish），不当章节
                if (weak or plain) and pno == 0 and bbox[1] < h * 0.45 and max_size >= body_size * 1.35:
                    items.append((col, bbox[1], "para", text, bbox, max_size, None, False))
                    continue
                if weak or plain:
                    items.append((col, bbox[1], "heading", text, bbox, max_size, 0, weak))
                    continue
                kind = "formula" if (alpha < 0.25 and any(c.isdigit() for c in text)) else "para"
                items.append((col, bbox[1], kind, text, bbox, max_size, None, False))
        items.sort(key=lambda it: (it[0], it[1]))
        # 跨块降大小写首字："T" 独占一块 + 下一块以小写化后的首词接续（"HE in-situ…" → "The in-situ…"）
        merged_items, k = [], 0
        while k < len(items):
            it = items[k]
            if (it[2] == "para" and re.fullmatch(r"[A-Z]", it[3]) and it[5] > body_size * 1.3
                    and k + 1 < len(items) and items[k + 1][0] == it[0]
                    and items[k + 1][2] in ("para", "formula")):
                nxt = items[k + 1]
                m2 = re.match(r"^([A-Z]{2,15})\b", nxt[3])
                if m2:
                    w = m2.group(1)
                    b1, b2 = it[4], nxt[4]
                    merged_items.append((nxt[0], min(nxt[1], it[1]), nxt[2],
                                         it[3] + w.lower() + nxt[3][len(w):],
                                         (min(b1[0], b2[0]), min(b1[1], b2[1]),
                                          max(b1[2], b2[2]), max(b1[3], b2[3])),
                                         max(nxt[5], it[5]), nxt[6], nxt[7]))
                    k += 2
                    continue
            merged_items.append(it)
            k += 1
        items = merged_items
        # weak 标题复核：章节标题上下应有留白（同栏前块底/后块顶距离 ≥3pt）；
        # 表格列头被正文紧贴，会被这步排除。
        by_col: dict[int, list] = {}
        for idx, it in enumerate(items):
            by_col.setdefault(it[0], []).append((idx, it))
        demote = set()
        for lst in by_col.values():
            for j, (idx, it) in enumerate(lst):
                if it[2] != "heading" or not it[7]:
                    continue
                gap_above = it[1] - lst[j - 1][1][4][3] if j > 0 else 10
                nxt = lst[j + 1][1] if j + 1 < len(lst) else None
                gap_below = (nxt[1] - it[4][3]) if nxt else 10
                if min(gap_above, gap_below) < 3:
                    demote.add(idx)
        for idx, (col, y0, kind, text, bbox, fsize, lvl, weak) in enumerate(items):
            if kind == "heading":
                if idx in demote:
                    kind = "para"
                elif text.strip().lower() == last_head:
                    kind = "para"  # 相邻重复标题（页眉/跨页）不当新章节
            bid += 1
            b = Block(id=f"b{bid}", page=pno + 1, col=col, type=kind,
                      y0=round(bbox[1], 1), y1=round(bbox[3], 1),
                      x0=round(bbox[0], 1), x1=round(bbox[2], 1), size=round(fsize, 1), text=text)
            if kind == "heading":
                last_head = text.strip().lower()
                sid += 1
                cur_sec = Section(id=f"s{sid}", title=text, level=lvl or 0, page=b.page,
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
    meta = (doc.metadata.get("title") or "").strip()
    guess = _guess_title(blocks, body_size, page_h0)
    if _meta_title_ok(meta):
        title = meta
        # 正文标题与元数据高度相似但不相同 → 以正文为准：
        # meta 是人工填写的，可能带错字（"Leaning"/"Learning"）或被截断，正文才是版面真值
        if (guess and guess != meta and len(guess) >= len(meta) * 0.9
                and difflib.SequenceMatcher(None, meta.lower(), guess.lower()).ratio() >= 0.9
                and not (_upper_dominant(guess) and not _upper_dominant(meta))):
            # 排除小型大写渲染：正文全大写而 meta 大小写混排时，meta 反而是干净版本
            title = guess
    else:
        title = guess or meta
    doc.close()
    return {
        "title": title,
        "pages": n_pages,
        "blocks": [asdict(b) for b in blocks],
        "sections": [asdict(s) for s in sections],
    }


if __name__ == "__main__":
    import json, sys
    print(json.dumps(parse_pdf(sys.argv[1]), ensure_ascii=False)[:800])
