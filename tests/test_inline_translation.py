"""原位翻译：物理块提示词、永久缓存、强制重译与数据同步。

    python tests/test_inline_translation.py

不联网：模型调用全部替换为本地假实现。
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

# 必须在导入 db 之前指定数据目录，避免动到用户的 backend/data
TMP = tempfile.mkdtemp(prefix="pc-inline-translation-")
os.environ["PAPER_COMPANION_DATA_DIR"] = TMP

from app import ai, db, llm  # noqa: E402

llm.ENV_PATH = os.path.join(TMP, "absent.env")   # 别让本机 .env 影响断言

from fastapi.testclient import TestClient  # noqa: E402
from app.main import app  # noqa: E402

FAILS = []


def check(name: str, cond: bool, extra: str = "") -> None:
    if cond:
        print(f"  ok   {name}")
    else:
        FAILS.append(name)
        print(f"  FAIL {name} {extra}")


def _structure():
    def block(bid, page, text, *, type_="para", section="s1", table_id=None, cont_of=None):
        b = {"id": bid, "page": page, "col": 0, "type": type_, "x0": 0, "x1": 300,
             "y0": 10, "y1": 20, "size": 10, "text": text, "section_id": section}
        if table_id:
            b["table_id"] = table_id
        if cont_of:
            b["cont_of"] = cont_of
        return b

    return {
        "title": "Media multitasking",
        "pages": 2,
        "blocks": [
            block("b1", 1, "First half of a paragraph that goes"),
            block("b2", 2, "onto the second page.", cont_of="b1"),
            block("b3", 2, "2. Method", type_="heading"),
            block("b4", 2, "   "),                       # 空白块
            block("b5", 2, "1 | 42", table_id="t1"),     # 表格内块
            block("b6", 1, "Smith, J. (2020). A title.", section="s2"),  # 参考文献
            block("b7", 2, "", type_="figure"),
        ],
        "sections": [
            {"id": "s1", "title": "1. Introduction", "level": 1, "page": 1,
             "heading_block_id": "b3", "is_references": False, "order": 0},
            {"id": "s2", "title": "References", "level": 0, "page": 1,
             "heading_block_id": "", "is_references": True, "order": 1},
        ],
        "tables": [{"id": "t1", "page": 2, "caption": "Table 1", "rows": [["1", "42"]]}],
    }


class FakeLLM:
    """可编程假模型：字符串模拟 chat_json 的纯文本退化，可调用对象可插入副作用。"""

    def __init__(self, responses=None):
        self.prompts = []
        self.responses = list(responses or [])

    def __call__(self, prompt, system, *, purpose="default", fallback_key="result"):
        self.prompts.append({"prompt": prompt, "system": system, "purpose": purpose})
        if self.responses:
            r = self.responses.pop(0)
            if callable(r):
                r = r()
            if isinstance(r, str):
                return {"result": r}       # llm.chat_json 解析失败时的退化结构
            return r
        return {"translation": f"译文 {len(self.prompts)}"}


def main() -> None:
    c = TestClient(app)

    print("[1] 物理块与提示词")
    st = _structure()
    fake = FakeLLM()
    original = ai.llm.chat_json
    ai.llm.chat_json = fake
    try:
        r = ai.translate_inline(st, "b2")
        prompt = fake.prompts[0]["prompt"]
        check("purpose 沿用 translate", fake.prompts[0]["purpose"] == "translate")
        check("只输出当前物理块", "当前物理块：\nonto the second page." in prompt, prompt)
        check("跨页完整段落仅作上下文",
              "First half of a paragraph that goes" in prompt
              and "不要翻译这一段" in prompt, prompt)
        check("明确禁止合并其他物理块", "不得翻译、补写或合并" in prompt, prompt)
        check("返回物理块原文", r["text"] == "onto the second page.", str(r))
        check("页码锚在物理块所在页", r["page"] == 2, str(r))

        r = ai.translate_inline(st, "b3")
        check("标题块可翻译并返回自身文本", r["text"] == "2. Method" and r["page"] == 2, str(r))
        check("标题块提示词不再重复整段", "完整段落（" not in fake.prompts[1]["prompt"])

        for bad in ("b4", "b5", "b6", "b7", "b404"):
            try:
                ai.translate_inline(st, bad)
                check(f"不可翻译块 {bad} 报错", False)
            except ValueError:
                check(f"不可翻译块 {bad} 报错", True)

        for output, expected in (
            ({}, "模型未返回有效译文，请重试"),
            ("纯文本退化", "模型未返回有效译文，请重试"),
            ({"error": "该片段无法翻译"}, "该片段无法翻译"),
            ({"translation": "   "}, "模型未返回有效译文，请重试"),
        ):
            ai.llm.chat_json = FakeLLM([output])
            try:
                ai.translate_inline(st, "b1")
                check(f"直接调用拒绝 {output!r}", False)
            except ValueError as e:
                check(f"直接调用拒绝 {output!r}", str(e) == expected, str(e))
    finally:
        ai.llm.chat_json = original

    print("[2] 缓存 / 强制重译")
    pid = db.new_pending("inline.pdf")
    db.finish_paper(pid, "Inline", "inline.pdf", _structure())
    fake = FakeLLM()
    original = ai.llm.chat_json
    ai.llm.chat_json = fake
    try:
        r = c.post(f"/api/papers/{pid}/translate-inline", json={"block_id": "b2"})
        check("首次翻译成功", r.status_code == 200, r.text[:200])
        first = r.json()
        check("首次未命中缓存", first.get("cached") is False, str(first))
        check("首次调用一次模型", len(fake.prompts) == 1, str(len(fake.prompts)))
        check("响应字段完整",
              first.get("block_id") == "b2" and first.get("page") == 2
              and first.get("text") == "onto the second page."
              and first.get("translation") == "译文 1", str(first))

        r = c.post(f"/api/papers/{pid}/translate-inline", json={"block_id": "b2"})
        second = r.json()
        check("再次请求命中缓存", second.get("cached") is True, str(second))
        check("缓存命中不再调用模型", len(fake.prompts) == 1, str(len(fake.prompts)))
        check("缓存返回同一译文", second.get("translation") == "译文 1", str(second))

        ts = c.get(f"/api/papers/{pid}/translations")
        check("translations 接口返回映射",
              ts.status_code == 200 and ts.json() == {"translations": {"b2": "译文 1"}},
              ts.text[:200])

        r = c.post(f"/api/papers/{pid}/translate-inline",
                   json={"block_id": "b2", "force": True})
        forced = r.json()
        check("force 强制重译", forced.get("cached") is False
              and forced.get("translation") == "译文 2", str(forced))
        check("force 再次调用模型", len(fake.prompts) == 2, str(len(fake.prompts)))
        ts = c.get(f"/api/papers/{pid}/translations").json()["translations"]
        check("force 覆盖缓存", ts.get("b2") == "译文 2", str(ts))

        calls_before = len(fake.prompts)
        for bad in ("b4", "b5", "b6", "b7", "b404"):
            r = c.post(f"/api/papers/{pid}/translate-inline", json={"block_id": bad})
            check(f"API 拒绝不可翻译块 {bad}", r.status_code == 422, r.text[:120])
        check("不可翻译块不调用模型", len(fake.prompts) == calls_before,
              str(len(fake.prompts)))

        # 模型输出不可用时：422、不写缓存，force 失败也不能覆盖已有译文
        for output, expected in (
            ({}, "模型未返回有效译文，请重试"),
            ("纯文本译文", "模型未返回有效译文，请重试"),
            ({"error": "模型侧拒绝翻译"}, "模型侧拒绝翻译"),
            ({"translation": "   "}, "模型未返回有效译文，请重试"),
        ):
            probe = FakeLLM([output])
            ai.llm.chat_json = probe
            try:
                r = c.post(f"/api/papers/{pid}/translate-inline",
                           json={"block_id": "b2", "force": True})
            finally:
                ai.llm.chat_json = fake
            check(f"无效输出 {output!r} → 422", r.status_code == 422, r.text[:120])
            check(f"无效输出 {output!r} 错误文案", r.json().get("detail") == expected,
                  r.text[:200])
            check(f"无效输出 {output!r} 调用一次模型", len(probe.prompts) == 1,
                  str(len(probe.prompts)))
        check("force 失败后旧译文仍在",
              db.get_translation(pid, "b2") == "译文 2", str(db.get_translations(pid)))
        ts = c.get(f"/api/papers/{pid}/translations").json()["translations"]
        check("GET 仍返回旧译文", ts == {"b2": "译文 2"}, str(ts))

        # 缓存未命中时失败也不能留下记录
        probe = FakeLLM([{}])
        ai.llm.chat_json = probe
        try:
            r = c.post(f"/api/papers/{pid}/translate-inline", json={"block_id": "b3"})
        finally:
            ai.llm.chat_json = fake
        check("缓存未命中无效输出 → 422", r.status_code == 422, r.text[:120])
        check("缓存未命中失败不落库", db.get_translation(pid, "b3") is None,
              str(db.get_translations(pid)))

        # 旧接口保持兼容，且不写入原位缓存
        r = c.post(f"/api/papers/{pid}/translate", json={"block_id": "b1"})
        check("旧 /translate 仍可用", r.status_code == 200 and r.json().get("translation"),
              r.text[:200])
        ts = c.get(f"/api/papers/{pid}/translations").json()["translations"]
        check("旧接口不写原位缓存", set(ts) == {"b2"}, str(ts))
    finally:
        ai.llm.chat_json = original

    print("[3] 删除论文后不写孤儿缓存")
    pid_gone = db.new_pending("gone.pdf")
    db.finish_paper(pid_gone, "Gone", "gone.pdf", _structure())

    def delete_then_translate():
        db.delete_paper(pid_gone)
        return {"translation": "迟到的译文"}

    probe = FakeLLM([delete_then_translate])
    ai.llm.chat_json = probe
    try:
        r = c.post(f"/api/papers/{pid_gone}/translate-inline", json={"block_id": "b2"})
    finally:
        ai.llm.chat_json = original
    check("请求完成前删除论文仍正常返回", r.status_code == 200, r.text[:120])
    check("删除后不留下孤儿译文", db.get_translations(pid_gone) == {},
          str(db.get_translations(pid_gone)))
    check("论文不存在时 save 返回 False",
          db.save_translation(pid_gone, "b2", "再次写入") is False)
    check("直接 save 也不留孤儿行", db.get_translations(pid_gone) == {},
          str(db.get_translations(pid_gone)))

    print("[4] 复制 / 删除 / 清空同步")
    new_pid = db.new_paper_id()
    check("复制论文成功", db.copy_paper(pid, None, new_pid, "copy.pdf") == new_pid)
    check("复制继承译文", db.get_translations(new_pid) == {"b2": "译文 2"},
          str(db.get_translations(new_pid)))

    db.save_translation(pid, "b3", "方法")
    check("原论文可继续新增译文", db.get_translations(pid).get("b3") == "方法")
    check("副本译文独立", db.get_translations(new_pid) == {"b2": "译文 2"},
          str(db.get_translations(new_pid)))

    db.delete_paper(pid)
    check("删除论文清掉译文", db.get_translations(pid) == {}, str(db.get_translations(pid)))
    check("删除论文不影响副本", db.get_translations(new_pid) == {"b2": "译文 2"},
          str(db.get_translations(new_pid)))

    fid = db.add_folder("temp")
    pid2 = db.new_pending("folder.pdf", folder_id=fid)
    db.finish_paper(pid2, "Folder", "folder.pdf", _structure())
    db.save_translation(pid2, "b2", "删除文件夹")
    db.delete_folder(fid, delete_papers=True)
    check("删除文件夹清掉其中论文的译文", db.get_translations(pid2) == {},
          str(db.get_translations(pid2)))

    db.clear_all_data(keep_llm_settings=True)
    check("一键清除清掉全部译文", db.get_translations(new_pid) == {},
          str(db.get_translations(new_pid)))
    check("一键清除后无论文", db.list_papers() == [], str(db.list_papers()))

    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} → {', '.join(FAILS)}")
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
