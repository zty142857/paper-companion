#!/usr/bin/env bash
# 下载 Texo / FormulaNet 公式 OCR 模型（约 77MB）到 public/models/formulanet。
# 模型不随仓库分发；首次使用公式识别前运行一次：
#   npm run model:download
# 若本机有自签名/代理证书导致 curl 校验失败：
#   CURL_INSECURE=1 npm run model:download
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$ROOT/public/models/formulanet"
BASE="https://huggingface.co/alephpi/FormulaNet/resolve/main"
CURL=(curl -fL --retry 3 --connect-timeout 20)
if [[ "${CURL_INSECURE:-0}" == "1" ]]; then CURL+=(-k); fi

mkdir -p "$DIR/onnx"
for f in config.json generation_config.json tokenizer.json tokenizer_config.json special_tokens_map.json; do
  if [[ -s "$DIR/$f" ]]; then continue; fi
  echo "Downloading $f ..."
  # 先写 .part 再改名：中断留下的半截文件不会被下一次误判为“已下载”
  "${CURL[@]}" "$BASE/$f" -o "$DIR/$f.part"
  mv "$DIR/$f.part" "$DIR/$f"
done
for f in encoder_model.onnx decoder_model_merged.onnx; do
  if [[ -s "$DIR/onnx/$f" ]]; then continue; fi
  echo "Downloading onnx/$f ..."
  "${CURL[@]}" "$BASE/onnx/$f" -o "$DIR/onnx/$f.part"
  mv "$DIR/onnx/$f.part" "$DIR/onnx/$f"
done
cp "$ROOT/scripts/formulanet-NOTICE.txt" "$DIR/NOTICE.txt"
echo "Formula model ready: $DIR"
