"""SSE 流式对话的纯逻辑单测：增量 answer 提取器 / llm.chat_stream 降级重试 /
ai.chat 重构兼容 / SSE 路由线上合同。

    python tests/test_chat_stream.py

不联网：模型调用全部用假实现替换；数据目录指向临时目录，不动用户的 backend/data。
"""
import json
import os
import sys
import tempfile
import types
from contextlib import contextmanager

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

# 必须在导入 db / main 之前指定数据目录，避免动到用户的 backend/data
TMP = tempfile.mkdtemp(prefix="pc-chat-stream-")
os.environ["PAPER_COMPANION_DATA_DIR"] = TMP

from app import ai, db, llm  # noqa: E402

llm.ENV_PATH = os.path.join(TMP, "absent.env")   # 别让本机 .env 影响断言

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app, _sse_event  # noqa: E402


# ---------------- 增量 answer 提取器 ----------------

def _collect(raw: str, size: int) -> str:
    """按固定 chunk 大小喂入，拼回提取结果。size=1 即逐字符（覆盖所有切分边界）。"""
    ex = ai._AnswerExtractor()
    return "".join(ex.feed(raw[i:i + size]) for i in range(0, len(raw), size))


def test_extractor_plain_and_chinese():
    assert _collect('{"answer": "hello world", "refs": []}', 4) == "hello world"
    assert _collect('{"answer": "中文回答，分点说明。", "refs": ["b1"]}', 3) == "中文回答，分点说明。"


def test_extractor_escapes_all_boundaries():
    answer = 'He said "hi"\nline2\ttab\\end\rcr\bbf\f'
    raw = json.dumps({"answer": answer, "refs": []}, ensure_ascii=True)
    for size in (1, 2, 3, 5, 7, 13, len(raw)):
        assert _collect(raw, size) == answer, f"chunk size {size}"


def test_extractor_unicode_escapes_and_surrogate():
    # \uXXXX 基本多文种平面 + 代理对（emoji）+ 重音字符
    raw = '{"answer": "\\u4e2d\\u6587\\ud83d\\ude00\\u00e9"}'
    for size in (1, 2, 3, 4, 5, 6, 7, len(raw)):
        assert _collect(raw, size) == "中文😀é", f"chunk size {size}"


def test_extractor_refs_before_answer():
    raw = '{"refs": ["b1", "b2"], "answer": "ok"}'
    for size in (1, 3, len(raw)):
        assert _collect(raw, size) == "ok"


def test_extractor_key_like_text_inside_value():
    # refs 值里出现带转义引号的 "answer" 字样：不能被误认为键
    raw = '{"refs": ["\\"answer\\""], "answer": "ok"}'
    for size in (1, 2, len(raw)):
        assert _collect(raw, size) == "ok"


def test_extractor_no_output_before_key_and_incremental():
    ex = ai._AnswerExtractor()
    assert ex.feed('{"refs": ["b1"], "ans') == ""
    assert ex.feed('wer": "') == ""
    assert ex.feed("你好") == "你好"          # 键刚找到就立刻出增量
    assert ex.feed("，世界") == "，世界"
    assert ex.feed('", "refs": []}') == ""    # 闭合后停止
    assert ex.feed('{"answer": "cd"}') == ""  # done 之后不再输出
    assert ex.feed("") == ""


def test_extractor_whitespace_around_key():
    assert _collect('{ "answer" :\n "x y" }', 2) == "x y"


def test_extractor_non_json_yields_nothing():
    ex = ai._AnswerExtractor()
    assert ex.feed("这不是 JSON，纯文本回答。") == ""
    assert ex.feed("继续输出也没有 answer 键") == ""


def test_extractor_answer_not_string():
    assert _collect('{"answer": null, "refs": []}', 3) == ""
    assert _collect('{"answer": 42}', 2) == ""


def test_extractor_truncated_escape_waits():
    ex = ai._AnswerExtractor()
    assert ex.feed('{"answer": "a\\') == "a"      # 半个转义：等下一个 chunk
    assert ex.feed('nb') == "\nb"                 # 凑成 \n 后反转义
    assert ex.feed('\\u4e') == ""                 # 半个 \u 码点
    assert ex.feed('2d"}') == "中"


# ---------------- llm.chat_stream：假 client 验证降级 / 重试 / 流降级 ----------------

def _fake_cfg(**over):
    cfg = {"purpose": "default", "provider_id": "p1", "model": "m1",
           "base_url": "https://api.example.com/v1", "api_key": "sk-x",
           "headers": {}, "catalog_id": None, "effort": ""}
    cfg.update(over)
    return cfg


def _chunk(text):
    return types.SimpleNamespace(
        choices=[types.SimpleNamespace(delta=types.SimpleNamespace(content=text))])


class _FakeCompletions:
    """按脚本回放：Exception → 抛出；其他 → 作为 create 的返回值（chunk 列表/生成器）。"""

    def __init__(self, script):
        self.script = list(script)
        self.calls = []

    def create(self, **kw):
        self.calls.append(dict(kw))
        item = self.script.pop(0)
        if isinstance(item, Exception):
            raise item
        return item


@contextmanager
def _fake_llm(script, cfg=None):
    cfg = cfg or _fake_cfg()
    comp = _FakeCompletions(script)
    client = types.SimpleNamespace(chat=types.SimpleNamespace(completions=comp))
    orig = (llm.get_route, llm._client, llm.time.sleep)
    llm.get_route = lambda purpose="default": dict(cfg)
    llm._client = lambda c, timeout=300: client
    llm.time.sleep = lambda s: None      # 重试退避不真睡
    llm._UNSUPPORTED.clear()
    try:
        yield comp
    finally:
        llm.get_route, llm._client, llm.time.sleep = orig
        llm._UNSUPPORTED.clear()


def test_llm_stream_basic():
    with _fake_llm([[_chunk("Hel"), _chunk("lo")]]) as comp:
        assert list(llm.chat_stream([{"role": "user", "content": "q"}])) == ["Hel", "lo"]
        assert comp.calls[0]["stream"] is True
        assert "response_format" not in comp.calls[0]   # 未开 json_mode


def test_llm_stream_response_format_degrade():
    with _fake_llm([Exception("response_format is not supported"), [_chunk("ok")]],
                   ) as comp:
        got = list(llm.chat_stream([], json_mode=True))
        assert got == ["ok"]
        assert "response_format" in comp.calls[0]
        assert "response_format" not in comp.calls[1]
        assert "response_format" in llm._unsupported(_fake_cfg())


def test_llm_stream_max_completion_tokens_degrade():
    with _fake_llm([Exception("use max_completion_tokens instead"), [_chunk("x")]]) as comp:
        assert list(llm.chat_stream([])) == ["x"]
        assert "max_tokens" not in comp.calls[1]
        assert comp.calls[1]["max_completion_tokens"] == 4096


def test_llm_stream_reasoning_degrade():
    cfg = _fake_cfg(effort="low")
    with _fake_llm([Exception("reasoning_effort not supported"), [_chunk("x")]], cfg) as comp:
        assert list(llm.chat_stream([])) == ["x"]
        assert comp.calls[0]["reasoning_effort"] == "low"
        assert "reasoning_effort" not in comp.calls[1]
    dash = _fake_cfg(base_url="https://dashscope.aliyuncs.com/compatible-mode/v1",
                     catalog_id="alibaba-cn", model="qwen3.8-flash", effort="medium")
    with _fake_llm([Exception("enable_thinking is not supported"), [_chunk("x")]], dash) as comp:
        assert list(llm.chat_stream([])) == ["x"]
        assert "extra_body" in comp.calls[0] and "extra_body" not in comp.calls[1]


def test_llm_stream_transient_retry_before_first_delta():
    with _fake_llm([Exception("429 Too Many Requests"), [_chunk("x")]]) as comp:
        assert list(llm.chat_stream([])) == ["x"]
        assert len(comp.calls) == 2


def test_llm_stream_unsupported_falls_back_to_chat():
    orig_chat = llm.chat
    chat_calls = []

    def fake_chat(messages, **kw):
        chat_calls.append(kw)
        return "全文一次性返回"

    llm.chat = fake_chat
    try:
        with _fake_llm([Exception("stream is not supported")]) as comp:
            assert list(llm.chat_stream([], json_mode=True)) == ["全文一次性返回"]
            assert "stream" in llm._unsupported(_fake_cfg())
            # 第二次：记住不支持，直接非流式，不再撞 create
            assert list(llm.chat_stream([], json_mode=True)) == ["全文一次性返回"]
            assert len(comp.calls) == 1
            assert len(chat_calls) == 2 and chat_calls[1]["json_mode"] is True
    finally:
        llm.chat = orig_chat


def test_llm_stream_error_after_first_delta_raises_without_retry():
    def broken():
        yield _chunk("a")
        raise Exception("connection error mid-stream")

    with _fake_llm([broken()]) as comp:
        it = llm.chat_stream([])
        assert next(it) == "a"
        try:
            next(it)
            assert False, "应当直接抛出"
        except Exception as e:
            assert "mid-stream" in str(e)
        assert len(comp.calls) == 1    # 已输出内容：不允许重试


def test_llm_stream_empty_choices_same_as_chat():
    with _fake_llm([[types.SimpleNamespace(choices=[])]]):
        try:
            list(llm.chat_stream([]))
            assert False, "应当抛 RuntimeError"
        except RuntimeError as e:
            assert "空 choices" in str(e)
    # 有内容后跟 usage-only 空 choices chunk：跳过，不报错
    with _fake_llm([[_chunk("x"), types.SimpleNamespace(choices=[])]]):
        assert list(llm.chat_stream([])) == ["x"]


# ---------------- ai.chat_stream / ai.chat 重构兼容 ----------------

def _structure():
    blocks = [
        {"id": "b1", "page": 1, "col": 0, "type": "para", "x0": 0, "x1": 300, "y0": 10, "y1": 20,
         "size": 10, "text": "Working memory is limited in capacity.", "section_id": "s1"},
        {"id": "b2", "page": 1, "col": 0, "type": "para", "x0": 0, "x1": 300, "y0": 30, "y1": 50,
         "size": 10, "text": "Media multitasking refers to simultaneous engagement.",
         "section_id": "s1"},
        {"id": "b3", "page": 2, "col": 0, "type": "para", "x0": 0, "x1": 300, "y0": 10, "y1": 20,
         "size": 10, "text": "Comprehension was measured with written reports.", "section_id": "s2"},
    ]
    sections = [
        {"id": "s1", "title": "1. Introduction", "level": 1, "page": 1,
         "heading_block_id": "b1", "is_references": False, "order": 0},
        {"id": "s2", "title": "2. Method", "level": 1, "page": 2,
         "heading_block_id": "b3", "is_references": False, "order": 1},
    ]
    tables = [{"id": "t1", "page": 2, "caption": "Results", "quality": "ok",
               "rows": [["acc", "0.9"]]}]
    return {"title": "Media multitasking", "pages": 2,
            "blocks": blocks, "sections": sections, "tables": tables}


def test_ai_chat_matches_stream_done_with_postprocess():
    raw_answer = "结论见 [b1]，方法见 [s2]，数据见 [t1]。"
    raw = json.dumps({"answer": raw_answer, "refs": ["b1", "bX"]}, ensure_ascii=False)
    seen = {}

    def fake_stream(messages, *, purpose="default", json_mode=False, max_tokens=4096):
        seen["messages"] = messages
        seen["json_mode"] = json_mode
        for i in range(0, len(raw), 5):
            yield raw[i:i + 5]

    orig = llm.chat_stream
    llm.chat_stream = fake_stream
    try:
        events = list(ai.chat_stream(_structure(), ["b1"], [], "结论是什么？"))
        result = ai.chat(_structure(), ["b1"], [], "结论是什么？")
    finally:
        llm.chat_stream = orig
    # delta 是后处理前的原始文本，逐段拼回完整 answer
    assert "".join(e["data"]["text"] for e in events if e["event"] == "delta") == raw_answer
    assert all(e["event"] == "delta" for e in events[:-1])   # 无检索时只有 delta + done
    done = events[-1]
    assert done["event"] == "done"
    # done 经过全部后处理：节号引用清洗、表格引用替换、refs 过滤、pages 汇总
    assert done["data"] == {
        "answer": "结论见 [b1]，方法见 ，数据见 （表 t1，第2页）。",
        "refs": ["b1"], "pages": [1, 2], "steps": []}
    assert result == done["data"]          # 旧 chat() 返回值与重构前同构
    assert seen["json_mode"] is True
    assert seen["messages"][0]["content"].endswith("只输出合法 JSON，不要输出任何其他内容。")


def test_ai_chat_stream_search_steps_realtime():
    seen = {}

    def fake_json(prompt, system, **kw):
        return {"enough": False, "query": "media multitasking"}

    def fake_arxiv(q, limit=3):
        seen["query"] = q
        return [{"title": "T1", "year": "2025", "url": "u", "abstract": "a"}]

    def fake_stream(messages, **kw):
        seen["prompt"] = messages[1]["content"]
        yield '{"answer": "据外部检索：T1", "refs": []}'

    orig = (llm.chat_json, ai.search.arxiv, llm.chat_stream)
    llm.chat_json, ai.search.arxiv, llm.chat_stream = fake_json, fake_arxiv, fake_stream
    try:
        events = list(ai.chat_stream(_structure(), ["b1"], [], "这个方向最新进展有哪些？"))
    finally:
        llm.chat_json, ai.search.arxiv, llm.chat_stream = orig
    steps = [e["data"] for e in events if e["event"] == "step"]
    assert steps == [
        {"step": "search", "text": "论文中未找到，正在检索 arXiv：media multitasking"},
        {"step": "found", "text": "找到 1 篇相关文献"}]
    # step 必须先于 delta（产生时立刻推送）
    assert [e["event"] for e in events] == ["step", "step", "delta", "done"]
    assert seen["query"] == "media multitasking"
    assert "外部检索结果" in seen["prompt"] and "T1" in seen["prompt"]
    assert events[-1]["data"]["steps"] == steps
    assert events[-1]["data"]["answer"] == "据外部检索：T1"


def test_ai_chat_non_json_fallback_same_as_chat_json():
    def fake_stream(messages, **kw):
        yield "抱歉，我无法输出 JSON。"

    orig = llm.chat_stream
    llm.chat_stream = fake_stream
    try:
        events = list(ai.chat_stream(_structure(), ["b1"], [], "结论？"))
        result = ai.chat(_structure(), ["b1"], [], "结论？")
    finally:
        llm.chat_stream = orig
    assert not [e for e in events if e["event"] == "delta"]   # 找不到 answer 键不出增量
    # chat_json 降级语义：{result: 原文} → answer 缺失 → 失败文案（与重构前一致）
    assert result == {"answer": "（生成失败，请重试）", "refs": [], "pages": [], "steps": []}
    assert events[-1]["data"] == result


# ---------------- SSE 路由线上合同 ----------------

def _make_paper():
    pid = db.new_pending("s.pdf")
    db.finish_paper(pid, "s", "s.pdf", _structure())
    return pid


def test_sse_event_format():
    assert _sse_event("delta", {"text": "a\nb"}) == 'event: delta\ndata: {"text": "a\\nb"}\n\n'
    assert _sse_event("step", {"step": "search", "text": "检索"}) == \
        'event: step\ndata: {"step": "search", "text": "检索"}\n\n'


def test_sse_route_contract():
    pid = _make_paper()
    done_data = {"answer": "你好", "refs": [], "pages": [],
                 "steps": [{"step": "search", "text": "检索中"}]}
    seen = {}

    def fake_stream(structure, block_ids, history, question, **kw):
        seen.update(kw, block_ids=block_ids, question=question)
        yield {"event": "step", "data": {"step": "search", "text": "检索中"}}
        yield {"event": "delta", "data": {"text": "你好"}}
        yield {"event": "done", "data": done_data}

    orig = ai.chat_stream
    ai.chat_stream = fake_stream
    try:
        c = TestClient(app)
        r = c.post(f"/api/papers/{pid}/chat/stream",
                   json={"question": "hi", "block_ids": ["b1"]})
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/event-stream")
        assert r.headers["cache-control"] == "no-cache"
        assert r.headers["x-accel-buffering"] == "no"
        assert r.text == (
            'event: step\ndata: {"step": "search", "text": "检索中"}\n\n'
            'event: delta\ndata: {"text": "你好"}\n\n'
            'event: done\ndata: {"answer": "你好", "refs": [], "pages": [], '
            '"steps": [{"step": "search", "text": "检索中"}]}\n\n')
        # 复用旧路由的 familiarity 逻辑：没档案 → None
        assert seen["familiarity"] is None and seen["block_ids"] == ["b1"]
        assert db.get_meta(pid)["visited"] == 1      # mark_visited 已执行
        # 有档案时 familiarity 透传
        db.upsert_meta(pid, domain="cogsci", plan={"steps": []}, familiarity="熟手")
        c.post(f"/api/papers/{pid}/chat/stream", json={"question": "hi"})
        assert seen["familiarity"] == "熟手"
        # 旧 /chat 路由行为不变：返回 done 同构 JSON
        r2 = c.post(f"/api/papers/{pid}/chat", json={"question": "hi"})
        assert r2.status_code == 200 and r2.json() == done_data
    finally:
        ai.chat_stream = orig


def test_sse_route_error_events():
    pid = _make_paper()
    c = TestClient(app)
    orig = ai.chat_stream

    def not_configured(*a, **kw):
        raise llm.LLMNotConfigured("default")
        yield   # 使其成为生成器

    def boom(*a, **kw):
        raise RuntimeError("boom")
        yield

    def mid_stream(*a, **kw):
        yield {"event": "delta", "data": {"text": "部分"}}
        raise RuntimeError("断流")

    try:
        ai.chat_stream = not_configured
        r = c.post(f"/api/papers/{pid}/chat/stream", json={"question": "hi"})
        assert r.status_code == 200 and r.text.startswith("event: error\n")
        data = json.loads(r.text.split("data: ", 1)[1].strip())
        assert data["code"] == "model_not_configured" and data["purpose"] == "default"
        assert data["detail"]

        ai.chat_stream = boom
        r = c.post(f"/api/papers/{pid}/chat/stream", json={"question": "hi"})
        assert r.status_code == 200
        data = json.loads(r.text.split("data: ", 1)[1].strip())
        assert data["detail"].startswith("对话生成失败：")

        # 流已开始后出错：先前的 delta 保留，只能补 error 事件
        ai.chat_stream = mid_stream
        r = c.post(f"/api/papers/{pid}/chat/stream", json={"question": "hi"})
        assert r.text == ('event: delta\ndata: {"text": "部分"}\n\n'
                          'event: error\ndata: {"detail": "对话生成失败：断流"}\n\n')
    finally:
        ai.chat_stream = orig
    # 论文不存在仍是 HTTP 404（流尚未开始）
    assert c.post("/api/papers/nope/chat/stream", json={"question": "q"}).status_code == 404


if __name__ == "__main__":
    fails = 0
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok  {name}")
            except AssertionError as e:
                fails += 1
                print(f"FAIL {name}: {e}")
    if fails:
        print(f"FAILED: {fails}")
        sys.exit(1)
    print("all passed")