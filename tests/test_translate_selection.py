"""划词翻译的纯逻辑单测：选区反查段落 + 上下文注入。"""
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import ai  # noqa: E402


def _structure():
    blocks = [
        {"id": "b1", "page": 1, "col": 0, "type": "para", "x0": 0, "x1": 300, "y0": 10, "y1": 20,
         "size": 10, "text": "Working memory is limited in capacity.", "section_id": "s1"},
        {"id": "b2", "page": 1, "col": 0, "type": "para", "x0": 0, "x1": 300, "y0": 30, "y1": 50,
         "size": 10,
         "text": "Media multitasking refers to simultaneous engagement in two activities, "
                 "or the act of switching between multiple imperfect tasks.",
         "section_id": "s1"},
        {"id": "b3", "page": 2, "col": 0, "type": "para", "x0": 0, "x1": 300, "y0": 10, "y1": 20,
         "size": 10, "text": "Comprehension was measured with written reports.", "section_id": "s2"},
    ]
    sections = [
        {"id": "s1", "title": "1. Introduction", "level": 1, "page": 1,
         "heading_block_id": "b0", "is_references": False, "order": 0},
        {"id": "s2", "title": "2. Method", "level": 1, "page": 2,
         "heading_block_id": "b0", "is_references": False, "order": 1},
    ]
    return {"title": "Media multitasking", "blocks": blocks, "sections": sections}


def test_locate_block_finds_partial_selection():
    b = ai._locate_block(_structure(), "simultaneous engagement in two activities")
    assert b and b["id"] == "b2"


def test_locate_block_ignores_case_and_punctuation():
    b = ai._locate_block(_structure(), "MEDIA multitasking, refers to simultaneous")
    assert b and b["id"] == "b2"


def test_locate_block_returns_none_when_absent():
    assert ai._locate_block(_structure(), "a sentence that never appears in this paper") is None


def test_translate_selection_only_sends_excerpt_and_context():
    seen = {}

    def fake(prompt, system, *, purpose="default"):
        seen["prompt"] = prompt
        seen["purpose"] = purpose
        return {"translation": "媒体多任务是指同时参与两项活动"}

    original = ai.llm.chat_json
    ai.llm.chat_json = fake
    try:
        r = ai.translate_selection(_structure(), "simultaneous engagement in two activities")
    finally:
        ai.llm.chat_json = original
    assert r == {"translation": "媒体多任务是指同时参与两项活动", "block_id": "b2", "page": 1}
    assert seen["purpose"] == "translate"
    assert "Media multitasking refers to" in seen["prompt"]      # 所在段落作上下文
    assert "Working memory is limited" in seen["prompt"]          # 上文
    assert "选中片段：\nsimultaneous engagement in two activities" in seen["prompt"]


if __name__ == "__main__":
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok  {name}")
