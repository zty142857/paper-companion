#!/usr/bin/env python3
"""在目标平台上构建「解压即用」发行包（无需用户安装 Python / Node）。

用法：
    python packaging/build.py                 # 自动识别当前平台
    python packaging/build.py --target win-x64
    python packaging/build.py --skip-npm      # 复用已有的 frontend/dist

产物：release/paper-companion-<target>.zip（Linux 为 .tar.gz）
"""

import argparse
import os
import platform
import shutil
import subprocess
import sys
import tarfile
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")
BACKEND = os.path.join(ROOT, "backend")
PY_WORK = os.path.join(ROOT, "build", "pyinstaller")
PY_DIST = os.path.join(ROOT, "build", "dist")
RELEASE = os.path.join(ROOT, "release")

APP_NAME = "paper-companion"

LAUNCHER_WIN = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
"paper-companion.exe"
if errorlevel 1 pause
"""

LAUNCHER_UNIX = """#!/bin/bash
cd "$(dirname "$0")"
./paper-companion
"""

README = """论文阅读智能学伴 · 免安装版
================================

【怎么用】
Windows : 双击  start.bat
macOS   : 右键 start.command → 打开（首次会被系统拦截，见下）
Linux   : 双击 start.sh，或在终端执行  ./start.sh

程序会自动启动本地服务并打开浏览器（默认 http://127.0.0.1:8765）。
关掉出现的命令行窗口即退出程序。

【第一次使用】
1. 打开页面后点右上角「模型设置」，填入你自己的 Base URL、API Key 和模型名。
   常用配置：
     DeepSeek   https://api.deepseek.com        模型 deepseek-chat
     阿里百炼   https://dashscope.aliyuncs.com/compatible-mode/v1   模型 qwen3.8-flash
2. 回到首页上传 PDF 即可。

【数据存在哪】
全部在本机「data」文件夹（论文、卡片、阅读记录），不会上传到别处。
删除程序目录即可清除全部数据。想升级版本时，把新的程序文件覆盖进来，data 文件夹保留。

【macOS 提示「无法验证开发者」】
这是未做苹果签名导致的。右键点 start.command → 选「打开」→ 再点一次「打开」即可。
如果仍被拦截，在终端执行一次：
    xattr -dr com.apple.quarantine .

【常见问题】
- 端口被占用：程序会自动从 8765 起往后找空闲端口，以窗口里打印的地址为准。
- 提示未配置 API Key：到「模型设置」里填。
- 想换回默认端口：先关掉占用 8765 的其他程序再启动。
"""


def run(cmd: list[str], cwd: str | None = None) -> None:
    print("+", " ".join(cmd), flush=True)
    subprocess.check_call(cmd, cwd=cwd)


def detect_target() -> str:
    system = platform.system().lower()
    machine = platform.machine().lower()
    arch64 = machine in ("amd64", "x86_64", "arm64", "aarch64")
    if system == "windows":
        return "win-x64" if arch64 else "win-x86"
    if system == "darwin":
        return "macos-arm64" if machine in ("arm64", "aarch64") else "macos-x64"
    return "linux-arm64" if machine in ("arm64", "aarch64") else "linux-x64"


def build_frontend(skip: bool) -> None:
    if skip:
        if not os.path.isdir(os.path.join(FRONTEND, "dist")):
            raise SystemExit("frontend/dist 不存在，不能使用 --skip-npm")
        return
    has_lock = os.path.isfile(os.path.join(FRONTEND, "package-lock.json"))
    npm = "npm.cmd" if os.name == "nt" else "npm"
    run([npm, "ci", "--no-audit", "--no-fund"] if has_lock
        else [npm, "install", "--no-audit", "--no-fund"], cwd=FRONTEND)
    run([npm, "run", "build"], cwd=FRONTEND)


def build_backend() -> str:
    sep = ";" if os.name == "nt" else ":"
    add_data = f"{os.path.join(FRONTEND, 'dist')}{sep}frontend_dist"
    cmd = [
        sys.executable, "-m", "PyInstaller",
        "--noconfirm", "--clean", "--onedir",
        "--name", APP_NAME,
        "--distpath", PY_DIST,
        "--workpath", PY_WORK,
        "--specpath", PY_WORK,
        "--paths", BACKEND,
        "--add-data", add_data,
        "--collect-all", "pymupdf",
        "--collect-submodules", "uvicorn",
        "--hidden-import", "multipart",
        "--hidden-import", "uvicorn.logging",
        os.path.join(BACKEND, "launcher.py"),
    ]
    run(cmd, cwd=ROOT)
    out = os.path.join(PY_DIST, APP_NAME)
    if not os.path.isdir(out):
        raise SystemExit(f"打包失败，未找到输出目录：{out}")
    return out


def make_release(built: str, target: str) -> str:
    stage = os.path.join(RELEASE, f"{APP_NAME}-{target}")
    if os.path.isdir(stage):
        shutil.rmtree(stage)
    os.makedirs(RELEASE, exist_ok=True)
    shutil.copytree(built, stage)

    if target.startswith("win"):
        with open(os.path.join(stage, "start.bat"), "w", encoding="utf-8") as f:
            f.write(LAUNCHER_WIN)
    elif target.startswith("macos"):
        path = os.path.join(stage, "start.command")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(LAUNCHER_UNIX)
        os.chmod(path, 0o755)
    else:
        path = os.path.join(stage, "start.sh")
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write(LAUNCHER_UNIX)
        os.chmod(path, 0o755)

    with open(os.path.join(stage, "README.txt"), "w", encoding="utf-8") as f:
        f.write(README)
    return stage


def archive(stage: str, target: str) -> str:
    if target.startswith("linux"):
        out = os.path.join(RELEASE, f"{APP_NAME}-{target}.tar.gz")
        with tarfile.open(out, "w:gz") as tar:
            tar.add(stage, arcname=os.path.basename(stage))
    else:
        out = os.path.join(RELEASE, f"{APP_NAME}-{target}.zip")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
            base = os.path.dirname(stage)
            for folder, _dirs, files in os.walk(stage):
                for name in files:
                    full = os.path.join(folder, name)
                    zf.write(full, os.path.relpath(full, base))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=None, help="产物命名，如 win-x64 / macos-arm64 / linux-x64")
    ap.add_argument("--skip-npm", action="store_true", help="跳过 npm 构建，复用 frontend/dist")
    args = ap.parse_args()

    target = args.target or detect_target()
    print(f"target = {target}")

    build_frontend(args.skip_npm)
    built = build_backend()
    stage = make_release(built, target)
    out = archive(stage, target)
    size_mb = os.path.getsize(out) / 1024 / 1024
    print(f"\n完成：{out}（{size_mb:.1f} MB）")


if __name__ == "__main__":
    main()
