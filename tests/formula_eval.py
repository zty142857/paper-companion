"""公式拖选准确率评测。

模拟"用户随手拖一小段"：对每条编号公式取中心 55% 的框当拖拽区，按前端的吸附规则
（覆盖度 = 交集/拖拽面积，>=0.2 才吸，同分取面积更小的区域）拿到最终 crop，再判断：

    usable  = 覆盖公式 >=90% 且框内正文词 <=6
    clipped = 覆盖 <90%（公式被切一半）
    dirty   = 覆盖够了但把正文拖了进去（>6 个 4 字母以上的词）
    nostick = 覆盖度不足 0.2，没有吸附（等于现在的"靠手"）

真值（GT）的构造：右对齐的 ``(12)`` 是公式编号，同一 y 带、同一栏、编号左侧的数学文本
就是公式本体。只覆盖单行编号公式 —— 这正是拖选最容易出错的群体。

用法::

    python tests/formula_eval.py                        # 跑 backend/data/pdfs 下全部 PDF
    python tests/formula_eval.py --pdf a.pdf --pdf b.pdf
    python tests/formula_eval.py --method all --json out.json
    python tests/formula_eval.py --fail-under 0.9       # 低于阈值时退出码 1（给 CI 用）

``--method``：``regions``（新的 formula_regions，默认）/ ``heuristic``（强制回退路径）/
``legacy``（旧行为：formula 块 + PUA 片段聚类，等价于改动前的前端）。
"""
import argparse
import glob
import json
import os
import re
import sys
import time

import pymupdf

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import formula_regions, pdf_parse  # noqa: E402

EQNUM = re.compile(r"^\((\d{1,2}[a-z]?)\)$")
MATH_CHARS = set("=+−±×÷·∑∫√≤≥≈≠∞∂∇∈∉⊂⊆∪∩→←↔⇒⇔⟨⟩[]{}()|"
                 "αβγδεζηθικλμνξπρστυφχψωΓΔΘΛΞΠΣΦΨΩ")
WORD_RE = re.compile(r"[A-Za-z]{4,}")


# ---------------- 真值 ----------------

def page_lines(page):
    out = []
    for b in page.get_text("dict")["blocks"]:
        if b["type"] != 0:
            continue
        for ln in b.get("lines") or []:
            spans = [s for s in ln["spans"] if s["text"].strip()]
            if not spans:
                continue
            out.append({
                "bbox": tuple(ln["bbox"]),
                "text": "".join(s["text"] for s in spans),
                "spans": spans,
            })
    return out


def _mathy(text):
    if "=" in text:
        return True
    return sum(1 for c in text if c in MATH_CHARS) >= 2


def gt_equations(path):
    """-> {page(1-based): [{bbox, text, spans, number, number_bbox}]}"""
    doc = pymupdf.open(path)
    res = {}
    for page in doc:
        lines = page_lines(page)
        nums = [l for l in lines if EQNUM.match(l["text"].strip())]
        if not nums:
            continue
        edges = sorted({round(n["bbox"][2]) for n in nums})
        groups = []
        for e in edges:
            if groups and e - groups[-1][-1] <= 12:
                groups[-1].append(e)
            else:
                groups.append([e])
        edges = [max(g) for g in groups]
        items = []
        for num in nums:
            nx0, ny0, nx1, ny1 = num["bbox"]
            h = max(ny1 - ny0, 6)
            yc = (ny0 + ny1) / 2
            right = min(edges, key=lambda e: abs(e - nx1))
            lefts = [e + 20 for e in edges if e < right - 60]
            col_left = max(lefts) if lefts else 0.0
            picked = []
            for l in lines:
                if l is num:
                    continue
                x0, y0, x1, y1 = l["bbox"]
                if x1 > right + 2 or x0 < col_left:
                    continue
                if abs((y0 + y1) / 2 - yc) > 1.15 * h:
                    continue
                if not _mathy(l["text"]):
                    continue
                picked.append(l)
            if not picked:
                continue
            xs0 = min(p["bbox"][0] for p in picked)
            ys0 = min(p["bbox"][1] for p in picked)
            xs1 = max(p["bbox"][2] for p in picked)
            ys1 = max(p["bbox"][3] for p in picked)
            if xs1 - xs0 < 20:
                continue
            items.append({
                "bbox": (xs0, ys0, xs1, ys1),
                "text": " ".join(p["text"] for p in picked),
                "spans": [tuple(s["bbox"]) for p in picked for s in p["spans"]],
                "number": num["text"].strip(),
                "number_bbox": tuple(num["bbox"]),
            })
        if items:
            res[page.number + 1] = items
    doc.close()
    return res


# ---------------- 各种检测方法 ----------------

def regions_layout(path):
    doc = pymupdf.open(path)
    out = {}
    for f in formula_regions.extract_formulas(doc):
        out.setdefault(f["page"], []).append((f["x0"], f["y0"], f["x1"], f["y1"]))
    doc.close()
    return out


def regions_heuristic(path):
    doc = pymupdf.open(path)
    out = {}
    for page in doc:
        spans = formula_regions.page_spans(page)
        for b in formula_regions.heuristic_boxes(page):
            box, _num = formula_regions.trim_number(b, spans)
            out.setdefault(page.number + 1, []).append(box)
    doc.close()
    return out


def regions_legacy(path):
    """改动前的行为：formula 块 + 含 PUA 的数学片段，按页聚类。"""
    st = pdf_parse.parse_pdf(path)
    groups = []
    for b in st["blocks"]:
        if b["type"] == "formula":
            hit = True
        else:
            t = b.get("text") or ""
            if not re.search(r"[\ue000-\uf8ff]", t):
                continue
            non_space = len(re.sub(r"\s", "", t))
            mathy = len(re.findall(r"[\ue000-\uf8ff=+−×÷∑∫√≈≤≥θαβγδλμπσφωΔΩ∂∞]", t))
            hit = non_space > 0 and mathy / non_space > 0.25
        if not hit:
            continue
        g = next((x for x in groups if x["page"] == b["page"]
                  and b["y0"] <= x["y1"] + 4 and b["y1"] >= x["y0"] - 1
                  and b["x0"] <= x["x1"] + 6 and b["x1"] >= x["x0"] - 6), None)
        if g:
            g["x0"] = min(g["x0"], b["x0"]); g["y0"] = min(g["y0"], b["y0"])
            g["x1"] = max(g["x1"], b["x1"]); g["y1"] = max(g["y1"], b["y1"])
        else:
            groups.append({"page": b["page"], "x0": b["x0"], "y0": b["y0"],
                           "x1": b["x1"], "y1": b["y1"]})
    out = {}
    for g in groups:
        if g["x1"] - g["x0"] > 8 and g["y1"] - g["y0"] > 4:
            out.setdefault(g["page"], []).append((g["x0"], g["y0"], g["x1"], g["y1"]))
    return out


# ---------------- 指标 ----------------

def _inter(a, b):
    return (max(0.0, min(a[2], b[2]) - max(a[0], b[0])) *
            max(0.0, min(a[3], b[3]) - max(a[1], b[1])))


def _area(a):
    return max(1e-6, (a[2] - a[0]) * (a[3] - a[1]))


def _center_box(bbox, frac=0.55):
    x0, y0, x1, y1 = bbox
    w, h = (x1 - x0) * frac / 2, (y1 - y0) * frac / 2
    cx, cy = (x0 + x1) / 2, (y0 + y1) / 2
    return (cx - w, cy - h, cx + w, cy + h)


SNAP_MIN_COVER = 0.2     # 与 PdfViewer.formulaUp 保持一致


def snap(drag, regs):
    """前端吸附规则：覆盖度优先，同分取面积更小的区域。"""
    best, best_key = None, None
    for r in regs:
        cover = _inter(drag, r) / _area(drag)
        if cover < SNAP_MIN_COVER:
            continue
        key = (round(cover, 6), -_area(r))
        if best_key is None or key > best_key:
            best, best_key = r, key
    return best


def evaluate(path, gt, regions, verbose=False):
    doc = pymupdf.open(path)
    out = {"gt": 0, "usable": 0, "clipped": 0, "dirty": 0, "nostick": 0,
           "with_number": 0, "regions": sum(len(v) for v in regions.values()), "details": []}
    for pno in sorted(gt):
        page = doc[pno - 1]
        spans = [(tuple(s["bbox"]), s["text"]) for b in page.get_text("dict")["blocks"]
                 if b["type"] == 0 for ln in b.get("lines") or [] for s in ln["spans"] if s["text"].strip()]
        regs = regions.get(pno, [])
        for eq in gt[pno]:
            out["gt"] += 1
            drag = _center_box(eq["bbox"])
            best = snap(drag, regs)
            if best is None:
                out["nostick"] += 1
                if verbose:
                    out["details"].append((pno, eq["number"], "nostick"))
                continue
            got = tot = 0.0
            for sb in eq["spans"]:
                w = max(sb[2] - sb[0], 1)
                tot += w
                cx, cy = (sb[0] + sb[2]) / 2, (sb[1] + sb[3]) / 2
                if best[0] - 1.5 <= cx <= best[2] + 1.5 and best[1] - 1.5 <= cy <= best[3] + 1.5:
                    got += w
            cov = got / max(tot, 1e-6)
            words = 0
            for b, text in spans:
                cx, cy = (b[0] + b[2]) / 2, (b[1] + b[3]) / 2
                if best[0] <= cx <= best[2] and best[1] <= cy <= best[3]:
                    words += len(WORD_RE.findall(text))
            if cov < 0.9:
                out["clipped"] += 1
                tag = "clipped"
            elif words > 6:
                out["dirty"] += 1
                tag = "dirty"
            else:
                out["usable"] += 1
                tag = "usable"
            nb = eq.get("number_bbox")
            if nb and best[0] - 2 <= (nb[0] + nb[2]) / 2 <= best[2] + 2:
                out["with_number"] += 1
            if verbose:
                out["details"].append((pno, eq["number"], tag, round(cov, 2), words,
                                       [round(v) for v in best]))
    doc.close()
    return out


# ---------------- CLI ----------------

def default_pdfs():
    found = sorted(glob.glob(os.path.join(ROOT, "backend", "data", "pdfs", "*.pdf")))
    return found


def main():
    ap = argparse.ArgumentParser(description="公式拖选准确率评测")
    ap.add_argument("--pdf", action="append", default=[], help="待测 PDF（可重复）")
    ap.add_argument("--method", default="regions",
                    choices=["regions", "heuristic", "legacy", "all"])
    ap.add_argument("--json", default="", help="把明细写到这个文件")
    ap.add_argument("--fail-under", type=float, default=0.0,
                    help="usable 比例低于该值时以退出码 1 结束（0~1）")
    ap.add_argument("-v", "--verbose", action="store_true", help="打印每条公式的判定")
    args = ap.parse_args()

    paths = args.pdf or default_pdfs()
    if not paths:
        print("没有找到 PDF：用 --pdf 指定，或把论文放进 backend/data/pdfs/")
        return 2

    methods = {
        "regions": ("formula_regions", regions_layout),
        "heuristic": ("heuristic fallback", regions_heuristic),
        "legacy": ("old behavior", regions_legacy),
    }
    picks = list(methods) if args.method == "all" else [args.method]

    print(f"{'paper':24} {'method':20} {'usable':>9} {'clip':>5} {'dirty':>6} "
          f"{'no-stick':>9} {'num-in-crop':>12} {'regions':>8} {'sec':>6}")
    dump = {}
    worst = 1.0
    for path in paths:
        gt = gt_equations(path)
        if not gt:
            print(f"{os.path.basename(path):24} (没有可用的编号公式真值，跳过)")
            continue
        for m in picks:
            label, fn = methods[m]
            t = time.perf_counter()
            regions = fn(path)
            dt = time.perf_counter() - t
            res = evaluate(path, gt, regions, verbose=args.verbose)
            n = res["gt"]
            ratio = res["usable"] / max(n, 1)
            worst = min(worst, ratio)
            print(f"{os.path.basename(path)[:22]:24} {label:20} "
                  f"{res['usable']:>4}/{n:<4} {res['clipped']:>5} {res['dirty']:>6} "
                  f"{res['nostick']:>9} {res['with_number']:>12} {res['regions']:>8} {dt:>6.2f}")
            if args.verbose:
                for d in res["details"]:
                    print("    ", d)
            dump[f"{os.path.basename(path)} | {label}"] = {
                k: v for k, v in res.items() if k != "details"}
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(dump, f, ensure_ascii=False, indent=1)
        print(f"明细已写入 {args.json}")
    if args.fail_under and worst < args.fail_under:
        print(f"usable 比例 {worst:.0%} 低于阈值 {args.fail_under:.0%}")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
