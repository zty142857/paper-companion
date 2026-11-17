"""跨页段落合并：解析链接 + 导读/翻译/上下文只出现一次。"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import ai, pdf_parse, summarize  # noqa: E402
from app.textblocks import join_text, logical_blocks, page_label  # noqa: E402


def _block(bid, page, text, *, type_="para", size=10.0, section="s1", table_id=None):
    b = {"id": bid, "page": page, "col": 0, "type": type_, "x0": 0, "x1": 300,
         "y0": 10, "y1": 20, "size": size, "text": text, "section_id": section}
    if table_id:
        b["table_id"] = table_id
    return b


def _structure(blocks, sections=None):
    return {
        "title": "T",
        "pages": max((b["page"] for b in blocks), default=1),
        "blocks": blocks,
        "sections": sections or [
            {"id": "s1", "title": "1. Intro", "level": 1, "page": 1,
             "heading_block_id": "", "is_references": False, "order": 0},
            {"id": "s2", "title": "References", "level": 0, "page": 3,
             "heading_block_id": "", "is_references": True, "order": 1},
        ],
        "tables": [],
    }


def test_join_text_handles_hyphen_and_dash():
    assert join_text("multi-", "tasking") == "multitasking"
    assert join_text("a —", "b") == "a —b"
    assert join_text("the", "next word") == "the next word"


def test_caption_vs_sentence_starting_with_table():
    assert pdf_parse._is_caption_text("Table 1 Descriptive statistics for the measured variables.")
    assert pdf_parse._is_caption_text("Fig. 2. The set-up in the lab.")
    assert not pdf_parse._is_caption_text(
        "Table 1 includes descriptive information and correlations for all measured variables. All scores were")


def test_weighted_body_size_ignores_short_small_text():
    assert pdf_parse._weighted_median_size([(8.0, 20), (10.0, 500), (7.0, 10)]) == 10.0


def test_split_footer_lines_from_last_paragraph():
    def line(text, size, y):
        return {"text": text, "size": size, "bbox": (0, y, 300, y + 10),
                "bold": False, "italic": False, "spans": []}

    lines = [
        line("The paragraph continues onto the next page and", 10.0, 700),
        line("ends with a dangling preposition of", 10.0, 711),
        line("This work is supported by a foundation.", 8.0, 750),
        line("Grant No. 123456.", 8.0, 760),
    ]
    segs = pdf_parse._split_block_to_items(lines, 10.0, False, 800.0)
    assert len(segs) == 2
    assert segs[0][0] == "para"
    assert segs[1][0] == "footer"
    assert "dangling preposition of" in pdf_parse._join_lines(segs[0][1])
    assert "Grant No. 123456." in pdf_parse._join_lines(segs[1][1])
    assert len(segs[1][1]) == 2


def test_link_page_continuation_mid_sentence_skips_footnote():
    blocks = [
        _block("b1", 1, "This paragraph starts here and continues into the"),
        _block("b2", 1, "1 Corresponding author. E-mail: a@b.com", size=7.0),
        _block("b3", 2, "next page without any break."),
    ]
    st = _structure(blocks)
    assert pdf_parse.ensure_block_links(st)
    assert blocks[2]["cont_of"] == "b1"
    assert "cont_of" not in blocks[0]
    assert logical_blocks(st)[0]["text"] == "This paragraph starts here and continues into the next page without any break."
    assert page_label(logical_blocks(st)[0]) == "第1–2页"


def test_link_page_continuation_ignores_trailing_footer_text():
    blocks = [
        _block("b1", 1, "The static model uses the extension deflections of "
                        "This work is supported by a foundation."),
        _block("b2", 2, "cables that are neglected in the model."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    assert blocks[1]["cont_of"] == "b1"


def test_link_page_continuation_skips_table_caption():
    blocks = [
        _block("b1", 1, "The scores were"),
        _block("b2", 2, "Table 1 Descriptive statistics."),
        _block("b3", 2, "approximately normally distributed."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    assert blocks[2]["cont_of"] == "b1"
    assert "cont_of" not in blocks[1]


def test_no_link_when_next_page_starts_new_paragraph():
    blocks = [
        _block("b1", 1, "A paragraph that ends properly."),
        _block("b2", 2, "Another paragraph starts here."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    assert "cont_of" not in blocks[1]


def test_no_link_when_next_page_starts_with_heading():
    blocks = [
        _block("b1", 1, "A paragraph that ends mid-sentence"),
        _block("b2", 2, "2. Method", type_="heading"),
        _block("b3", 2, "New sentence."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    assert "cont_of" not in blocks[2]


def test_no_link_in_references_section():
    blocks = [
        _block("b1", 2, "Smith, J. (2020). A title that continues", section="s2", size=6.4),
        _block("b2", 3, "onto the next page.", section="s2", size=6.4),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    assert "cont_of" not in blocks[1]


def test_digest_prints_page_spanning_paragraph_once():
    blocks = [
        _block("b1", 1, "First half of a long paragraph that goes"),
        _block("b2", 2, "onto the second page and then ends."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    digest, _ = summarize.build_digest(st)
    assert digest.count("First half of a long paragraph") == 1
    assert digest.count("onto the second page") == 1     # 已并进 b1，不再单独成行
    assert "[b2|" not in digest
    assert "第1–2页" in digest


def test_translate_uses_full_page_spanning_paragraph():
    blocks = [
        _block("b1", 1, "First half of a paragraph that goes"),
        _block("b2", 2, "onto the second page."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    seen = {}

    def fake(prompt, system, *, purpose="default"):
        seen["prompt"] = prompt
        return {"translation": "译"}

    original = ai.llm.chat_json
    ai.llm.chat_json = fake
    try:
        r = ai.translate(st, "b2")
    finally:
        ai.llm.chat_json = original
    assert "First half of a paragraph" in seen["prompt"]
    assert "onto the second page." in seen["prompt"]
    assert r["page"] == 2          # 卡片仍锚在用户点击的那一页


def test_context_does_not_duplicate_continuation():
    blocks = [
        _block("b1", 1, "First half of a paragraph that goes"),
        _block("b2", 2, "onto the second page."),
        _block("b3", 2, "Next paragraph."),
    ]
    st = _structure(blocks)
    pdf_parse.ensure_block_links(st)
    ctx = ai._context(st, ["b1"])
    assert ctx.count("First half of a paragraph") == 1
    assert "onto the second page." in ctx
    assert "Next paragraph." in ctx


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
