"""把 ``cont_of`` 链接的跨页段落还原成逻辑段落。

解析器会把 PDF 的文本框按页切开，同一段正文恰好跨页时就会出现两个 block。
``pdf_parse`` 会给后一块打上 ``cont_of``（指向上一块），这里负责在生成导读、
翻译、问答上下文时把它们拼回一段，同时保留原始 block（点击/标亮仍按页工作）。
"""
import re

from typing import Iterable


def join_text(left: str, right: str) -> str:
    """按断行规则拼接两块文本：词中断词直接接回，破折号不加空格，其余加空格。"""
    a = (left or "").rstrip()
    b = (right or "").lstrip()
    if not a:
        return b
    if not b:
        return a
    if re.search(r"[A-Za-z]-$", a):
        return a[:-1] + b
    if a.endswith(("-", "–", "—")):
        return a + b
    return a + " " + b


def paragraph_index(structure: dict) -> dict[str, dict]:
    """每个 block id → 其所属逻辑段落（含合并后的完整 text）。

    逻辑段落的 id/page 沿用第一块，``cont_ids`` / ``cont_pages`` 记录后续块。
    """
    out: dict[str, dict] = {}
    for b in structure.get("blocks") or []:
        bid = b.get("id") or ""
        target = out.get(b.get("cont_of") or "") if b.get("cont_of") else None
        if target is not None:
            target["text"] = join_text(target.get("text", ""), b.get("text", ""))
            target["cont_ids"].append(bid)
            target["cont_pages"].append(b.get("page"))
            out[bid] = target
            continue
        lb = dict(b)
        lb["cont_ids"] = []
        lb["cont_pages"] = [b.get("page")]
        out[bid] = lb
    return out


def logical_blocks(structure: dict) -> list[dict]:
    """按文档顺序返回逻辑段落；跨页段落只出现一次，text 为合并后的全文。"""
    index = paragraph_index(structure)
    out: list[dict] = []
    seen: set[str] = set()
    for b in structure.get("blocks") or []:
        bid = b.get("id") or ""
        if b.get("cont_of") and b.get("cont_of") in index:
            continue
        lb = index.get(bid)
        if lb is not None and lb.get("id") not in seen:
            out.append(lb)
            seen.add(lb["id"])
    return out


def page_label(block: dict) -> str:
    """页码文案：跨页段落显示为「第 2–3 页」。"""
    pages = [p for p in (block.get("cont_pages") or [block.get("page")]) if p]
    if not pages:
        return ""
    if pages[0] == pages[-1]:
        return f"第{pages[0]}页"
    return f"第{pages[0]}–{pages[-1]}页"


def blocks_for_ids(structure: dict, ids: Iterable[str]) -> list[dict]:
    """把一串 block id 映射成逻辑段落并去重、保序。"""
    index = paragraph_index(structure)
    out, seen = [], set()
    for bid in ids:
        lb = index.get(bid)
        if lb is None or lb.get("id") in seen:
            continue
        out.append(lb)
        seen.add(lb["id"])
    return out
