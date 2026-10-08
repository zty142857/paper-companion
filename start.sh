#!/bin/bash
# 论文阅读学伴 一键启动（开发模式）
cd "$(dirname "$0")"
if [ ! -d backend/.venv ]; then echo "先运行: uv venv backend/.venv && uv pip install -p backend/.venv fastapi 'uvicorn[standard]' pymupdf httpx openai python-multipart"; exit 1; fi
if [ ! -d frontend/node_modules ]; then (cd frontend && npm install); fi
for p in $(pgrep -f '[u]vicorn app.main:app'); do kill "$p"; done
nohup backend/.venv/bin/uvicorn app.main:app --app-dir backend --host 127.0.0.1 --port 8000 > /tmp/pc-backend.log 2>&1 &
cd frontend && npm run dev -- --host 127.0.0.1 > /tmp/pc-frontend.log 2>&1 &
echo "backend: http://127.0.0.1:8000  frontend: http://127.0.0.1:5173  (日志 /tmp/pc-*.log)"
