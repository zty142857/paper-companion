"""formula_regions 的纯逻辑单测（不需要真实 PDF，也不跑版面模型）。

    python tests/test_formula_regions.py
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import formula_regions as fr  # noqa: E402


def span(text, bbox, size=10.0, font="Times", italic=False):
    return {"text": text, "bbox": bbox, "size": size, "font": font, "italic": italic}


def test_trim_number_cuts_right_aligned_label():
    box = (60.0, 100.0, 290.0, 130.0)
    spans = [
        span("E", (65, 108, 72, 122)),
        span("=", (75, 108, 82, 122)),
        span("mc2", (85, 108, 112, 122)),
        span("(12)", (278, 110, 290, 122)),
    ]
    out, num = fr.trim_number(box, spans)
    assert num == "(12)", num
    assert abs(out[2] - 276.0) < 1e-6, out
    assert out[0] == box[0] and out[3] == box[3]


def test_trim_number_ignores_reference_in_prose():
    """正文里的 "(12)" 引用在同一 y 带、但不在区域右端 → 不切。"""
    box = (60.0, 100.0, 290.0, 130.0)
    spans = [span("see (12) for details", (70, 108, 200, 122))]
    out, num = fr.trim_number(box, spans)
    assert num is None and out == box


def test_trim_number_keeps_whole_box_when_number_is_content():
    """区域只剩一个 "(3)"：它可能就是公式本体，不能切空。"""
    box = (60.0, 100.0, 72.0, 130.0)
    spans = [span("(3)", (61, 108, 72, 122))]
    out, num = fr.trim_number(box, spans)
    assert num is None and out == box


def test_dedupe_merges_near_duplicates():
    a = (10.0, 10.0, 110.0, 40.0)
    b = (11.0, 11.0, 111.0, 41.0)
    c = (10.0, 80.0, 110.0, 110.0)
    assert len(fr.dedupe([a, b, c])) == 2


def test_keep_box_filters_small_and_pictured():
    pics = [(0.0, 0.0, 200.0, 200.0)]
    assert not fr.keep_box((0, 0, 8, 8), [], 800)          # 太小
    assert not fr.keep_box((10, 10, 40, 20), pics, 800)    # 落在图里
    assert fr.keep_box((10, 400, 200, 430), pics, 800)     # 正常
    assert not fr.keep_box((10, 10, 200, 700), [], 800)    # 高过页面的 55%


def test_heuristic_flag_off_disables_layout(monkeypatch_env=None):
    """PC_FORMULA_LAYOUT=off 时不应尝试版面模型。"""
    old = os.environ.get("PC_FORMULA_LAYOUT")
    os.environ["PC_FORMULA_LAYOUT"] = "off"
    try:
        class Page:
            def get_layout(self):     # 被调用就说明开关没生效
                raise AssertionError("layout 不该被调用")

            def get_text(self, *a, **k):
                return {"blocks": []}

            rect = type("R", (), {"width": 600.0, "height": 800.0})()

            def get_drawings(self):
                return []

        src, boxes = fr.detect_page(Page())
        assert src == "heuristic" and boxes == []
    finally:
        if old is None:
            os.environ.pop("PC_FORMULA_LAYOUT", None)
        else:
            os.environ["PC_FORMULA_LAYOUT"] = old


def test_drop_formula_paragraphs():
    """整块落在公式框里的正文块删掉；部分覆盖、标题、别的页都不动。"""
    blocks = [
        {"id": "b0", "page": 1, "type": "para", "x0": 10, "y0": 10, "x1": 110, "y1": 30,
         "text": "x = y + 1"},
        {"id": "b1", "page": 1, "type": "para", "x0": 10, "y0": 10, "x1": 110, "y1": 60,
         "text": "where x is the joint angle and y is the torque"},
        {"id": "b2", "page": 1, "type": "heading", "x0": 10, "y0": 10, "x1": 110, "y1": 30,
         "text": "3. Method"},
        {"id": "b3", "page": 2, "type": "para", "x0": 10, "y0": 10, "x1": 110, "y1": 30,
         "text": "another page"},
    ]
    formulas = [{"page": 1, "x0": 8, "y0": 8, "x1": 112, "y1": 32}]
    out = fr.drop_formula_paragraphs(blocks, formulas)
    assert [b["id"] for b in out] == ["b1", "b2", "b3"], out


def test_drop_formula_paragraphs_noop_without_formulas():
    blocks = [{"id": "b0", "page": 1, "type": "para", "x0": 0, "y0": 0, "x1": 10, "y1": 10,
               "text": "x = 1"}]
    assert fr.drop_formula_paragraphs(blocks, []) == blocks


def test_split_math_segments_cuts_prose_between_formulas():
    """版面模型把"公式 + 解释正文 + 下一条公式"框成一块时，要按正文行切开。"""
    spans = [
        span("F", (60, 100, 66, 112)), span("=", (68, 100, 74, 112)), span("m", (76, 100, 82, 112)),
        span("where", (60, 118, 92, 130)), span("the", (94, 118, 110, 130)),
        span("force", (112, 118, 142, 130)), span("and", (144, 118, 162, 130)),
        span("moment", (164, 118, 202, 130)),
        span("E", (60, 140, 66, 152)), span("=", (68, 140, 74, 152)), span("m", (76, 140, 82, 152)),
    ]
    segs = fr.split_math_segments((55, 95, 210, 158), spans)
    assert len(segs) == 2, segs
    assert segs[0][3] < 118 and segs[1][1] > 130


def test_split_math_segments_keeps_wordy_subscripts():
    """θ_rig / L_mani 这类下标的英文词不能被当成正文。"""
    spans = [
        span("T", (60, 100, 68, 112)), span("tor", (69, 104, 82, 112)),
        span("L", (86, 100, 94, 112)), span("holder", (95, 104, 122, 112)),
        span("L", (126, 100, 134, 112)), span("mani", (135, 104, 152, 112)),
    ]
    segs = fr.split_math_segments((55, 95, 200, 118), spans)
    assert len(segs) == 1, segs


def test_split_math_segments_drops_number_only_box():
    spans = [span("(7)", (180, 100, 196, 112))]
    assert fr.split_math_segments((170, 95, 200, 118), spans) == []


def test_split_math_segments_keeps_box_without_text():
    box = (10.0, 10.0, 100.0, 40.0)
    assert fr.split_math_segments(box, []) == [box]


if __name__ == "__main__":
    fails = 0
    for name, fn in sorted(globals().items()):
        if not name.startswith("test_") or not callable(fn):
            continue
        try:
            fn()
            print(f"ok   {name}")
        except AssertionError as e:
            fails += 1
            print(f"FAIL {name}: {e}")
    print("全部通过" if not fails else f"{fails} 个失败")
    sys.exit(1 if fails else 0)
