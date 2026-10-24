"""给已入库的老论文补 ``structure["formulas"]``。

只改这一个字段：blocks / sections / 卡片锚点都不动，所以已存的笔记、卡片不会错位。
新上传的论文在解析时就已经带上这个字段，不需要跑这个脚本。

用法::

    python -m app.backfill_formulas              # 只补没有 formulas 的论文
    python -m app.backfill_formulas --all        # 全部重算（比如调了检测参数之后）
    python -m app.backfill_formulas --id 01f0f3c53bef
    python -m app.backfill_formulas --dry-run
"""
import argparse
import json
import os
import sys

import pymupdf

from . import db, formula_regions


def _rows(pid: str | None) -> list[dict]:
    q = "SELECT id, title, pdf_path, structure FROM paper WHERE status='parsed'"
    args: tuple = ()
    if pid:
        q += " AND id=?"
        args = (pid,)
    with db.conn() as c:
        return [dict(r) for r in c.execute(q, args)]


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="给老论文补公式区域（只写 structure.formulas）")
    ap.add_argument("--id", default="", help="只处理这一篇")
    ap.add_argument("--all", action="store_true", help="连已有 formulas 的也重算")
    ap.add_argument("--dry-run", action="store_true", help="只统计，不写库")
    args = ap.parse_args(argv)

    rows = _rows(args.id or None)
    if not rows:
        print("没有匹配的论文")
        return 1

    done = skipped = failed = 0
    for row in rows:
        pid = row["id"]
        try:
            st = json.loads(row["structure"] or "{}")
        except json.JSONDecodeError:
            st = {}
        if not args.all and isinstance(st.get("formulas"), list):
            skipped += 1
            continue
        path = row["pdf_path"]
        if not path or not os.path.isfile(path):
            # 换了机器/系统后老库里的绝对路径会失效，按 id 在数据目录里找同名文件
            guess = os.path.join(db.PDF_DIR, f"{pid}.pdf")
            path = guess if os.path.isfile(guess) else ""
        if not path:
            print(f"跳过 {pid}：找不到 PDF")
            failed += 1
            continue
        try:
            doc = pymupdf.open(path)
            try:
                formulas = formula_regions.extract_formulas(doc)
            finally:
                doc.close()
        except Exception as e:          # 单篇失败不影响其它论文
            print(f"失败 {pid}：{e}")
            failed += 1
            continue
        print(f"{'[dry-run] ' if args.dry_run else ''}{pid} {row['title'][:40]!r} -> {len(formulas)} 个公式区域")
        if args.dry_run:
            done += 1
            continue
        st["formulas"] = formulas
        with db.conn() as c:
            c.execute("UPDATE paper SET structure=? WHERE id=?",
                      (json.dumps(st, ensure_ascii=False), pid))
        done += 1

    print(f"完成：处理 {done} 篇，跳过 {skipped} 篇，失败 {failed} 篇")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
