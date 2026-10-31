"""生成 backend/app/model_catalog.json（models.dev 快照）。

    python packaging/build_model_catalog.py
    python packaging/build_model_catalog.py --source /tmp/api.json   # 用已下载的文件

快照只保留 OpenAI 兼容提供方与能力字段（思考档位 / 上下文 / 价格），
随发行包一起分发，保证应用离线也能给出模型列表与思考强度。
"""
import argparse
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

from app import model_catalog  # noqa: E402

OUT = os.path.join(ROOT, "backend", "app", "model_catalog.json")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", help="本地 api.json；不填则从 models.dev 拉取")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    if args.source:
        with open(args.source, encoding="utf-8") as f:
            raw = json.load(f)
    else:
        print(f"fetching {model_catalog.SOURCE_URL} ...")
        req = urllib.request.Request(model_catalog.SOURCE_URL,
                                     headers={"User-Agent": "paper-companion"})
        with urllib.request.urlopen(req, timeout=120) as r:
            raw = json.loads(r.read().decode("utf-8"))

    snap = model_catalog.prune(raw)
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))

    n_models = sum(len(p["models"]) for p in snap["providers"])
    size = os.path.getsize(args.out) / 1024 / 1024
    print(f"providers: {len(snap['providers'])}  models: {n_models}  size: {size:.2f} MB")
    print(f"written: {args.out}")


if __name__ == "__main__":
    main()
