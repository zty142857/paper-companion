"""表格抽取的纯逻辑单测 + 6 张样本的可选集成测试。

    python tests/test_table_regions.py

纯逻辑测试不需要 PDF；集成测试只在 backend/data/pdfs 里的样本存在时跑
（PyMuPDF 的 to_json 会加载版面模型，单篇约 10–60 秒，取决于页数和机器）。
"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import ai, summarize  # noqa: E402
from app import table_regions as tr  # noqa: E402

PDF_DIR = os.path.join(ROOT, "backend", "data", "pdfs")


def _structure(blocks, tables=None):
    return {
        "title": "t",
        "pages": 1,
        "blocks": blocks,
        "sections": [{"id": "s1", "title": "Sec", "level": 0, "page": 1,
                      "heading_block_id": "", "is_references": False, "order": 0}],
        "tables": tables or [],
        "tables_version": 1,
    }


def _block(bid, text, y0=0, y1=20, type_="para", table_id=None):
    b = {"id": bid, "page": 1, "col": 0, "type": type_, "x0": 0, "x1": 300,
         "y0": y0, "y1": y1, "size": 10, "text": text, "section_id": "s1"}
    if table_id:
        b["table_id"] = table_id
    return b


def test_cell_text_fixes_decimal_spacing():
    assert tr._cell_text("6 . 00") == "6.00"
    assert tr._cell_text("0.0099") == "0.0099"
    assert tr._cell_text("1 . 01 × 10 −4") == "1.01 × 10 −4"


def test_normalize_rows_splits_two_column_multiline():
    rows = tr.normalize_rows([["3D\nRMSE", "Three dimensional\nRoot-Mean-Square-Error"]])
    assert rows == [["3D", "Three dimensional"], ["RMSE", "Root-Mean-Square-Error"]]


def test_normalize_rows_merges_empty_key_continuation():
    rows = tr.normalize_rows([["A", "x"], ["", "continued"]])
    assert rows == [["A", "x continued"]]


def test_author_block_filter():
    rows = [["Zheshuai Yang", "School of Mechanical Engineering"],
            ["author@example.edu", "Xi'an Jiaotong University"]]
    assert tr._is_author_block(rows, (54, 145, 543, 260), 1, 842)
    # 真表：第 1 页下方、带数值，不应被过滤
    assert not tr._is_author_block([["Cable 1", "0.0099"]], (54, 500, 543, 600), 1, 842)


def test_caption_for_above_and_rotated():
    box = (100, 200, 300, 400)
    above = {"id": "b1", "text": "Table 2. Params", "x0": 100, "x1": 300, "y0": 180, "y1": 190}
    assert tr.caption_for(box, [above], set()) == ("Table 2. Params", "b1")
    # 竖排表题在表的左侧
    left = {"text": "Table 1. Sampling", "bbox": (70, 200, 90, 400)}
    assert tr.caption_for(box, [], set(), [left]) == ("Table 1. Sampling", "")


def test_quality_gates():
    rows = [["Name", "Value"], ["a", "1"]]
    assert tr._quality(rows, [], 800) == ("ok", "")
    assert tr._quality(rows, [{"dir": (0.0, -1.0), "bbox": (0, 0, 1, 1)}], 800) == ("image_only", "rotated")
    bad = [["Name", "Value"], ["a", "\ufffd\ufffd\ufffd"]]
    assert tr._quality(bad, [], 800) == ("image_only", "garbled")
    assert tr._quality([["only"]], [], 800)[0] == "image_only"


def test_digest_excludes_table_cells_and_keeps_caption():
    blocks = [
        _block("b1", "Body before"),
        _block("b2", "Table 1. Results", y0=100, y1=110, type_="para"),
        _block("b3", "0.0099", y0=120, y1=130, table_id="t1"),
        _block("b4", "Body after", y0=140, y1=150),
    ]
    tables = [{"id": "t1", "page": 1, "caption": "Table 1. Results",
               "caption_block_id": "b2", "quality": "ok", "rows": [["0.0099"]]}]
    digest, _ = summarize.build_digest(_structure(blocks, tables))
    assert "0.0099" not in digest
    assert digest.count("Table 1. Results") == 1
    assert "Body before" in digest and "Body after" in digest


def test_digest_adds_placeholder_for_uncaptained_table():
    blocks = [_block("b1", "Body")]
    tables = [{"id": "t1", "page": 2, "caption": "", "caption_block_id": "",
               "quality": "ok", "rows": []}]
    digest, _ = summarize.build_digest(_structure(blocks, tables))
    assert "[表|第2页] （无表题）" in digest


def test_table_ctx_includes_rows_and_neighbors():
    blocks = [
        _block("b1", "Before paragraph", y0=10, y1=20),
        _block("b2", "Table 1. Results", y0=30, y1=40),
        _block("b3", "0.0099", y0=50, y1=60, table_id="t1"),
        _block("b4", "0.0128", y0=60, y1=70, table_id="t1"),
        _block("b5", "After paragraph", y0=80, y1=90),
    ]
    table = {"id": "t1", "page": 1, "caption": "Table 1. Results",
             "caption_block_id": "b2", "quality": "ok",
             "rows": [["Cable 1", "0.0099"], ["Cable 2", "0.0128"]]}
    ctx = ai._table_ctx(_structure(blocks, [table]), table)
    assert "【表格 t1" in ctx
    assert "Cable 1 | 0.0099" in ctx
    assert "Before paragraph" in ctx and "After paragraph" in ctx
    assert ctx.count("0.0128") == 1


def test_table_question_keywords():
    assert ai._looks_table_question("Table 2 的参数是多少")
    assert ai._looks_table_question("这个实验的误差")
    assert not ai._looks_table_question("这句话表示什么意思")


def _pdf(name):
    return os.path.join(PDF_DIR, name)


def test_integration_samples():
    if not os.path.isdir(PDF_DIR):
        return
    import pymupdf
    cases = [
        ("1b444eb8e4eb.pdf", 1),
        ("79ad3afa5630.pdf", 3),
        ("394f5504380f.pdf", 2),
    ]
    for name, count in cases:
        path = _pdf(name)
        if not os.path.isfile(path):
            continue
        doc = pymupdf.open(path)
        try:
            blocks = []
            for pno, page in enumerate(doc):
                for b in page.get_text("blocks"):
                    blocks.append({"id": f"b{len(blocks) + 1}", "page": pno + 1,
                                   "x0": b[0], "y0": b[1], "x1": b[2], "y1": b[3],
                                   "type": "para", "text": b[4]})
            tables = tr.extract_tables(doc, blocks)
        finally:
            doc.close()
        assert len(tables) == count, (name, len(tables))
        if name.startswith("1b444"):
            t = tables[0]
            assert t["page"] == 3 and t["quality"] == "ok"
            assert t["rows"][1][1] == "0.0099"
            assert t["caption"].startswith("TABLE I.")
        elif name.startswith("79ad"):
            by_page = {t["page"]: t for t in tables}
            assert by_page[17]["rows"][1][0] == "Disk dimensions"
            assert len(by_page[19]["rows"][0]) == 7
            assert by_page[2]["caption"] == ""
        else:
            by_page = {t["page"]: t for t in tables}
            assert by_page[4]["quality"] == "image_only"
            assert by_page[4]["caption"].startswith("Table 1.")
            assert by_page[7]["quality"] == "image_only"


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
