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
import time
import zipfile


def _setup_io() -> None:
    """输出被重定向时（CI 日志、管道）强制 UTF-8，避免中文打印触发 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        try:
            if not stream.isatty():
                stream.reconfigure(encoding="utf-8", errors="replace")
            else:
                stream.reconfigure(errors="replace")
        except Exception:
            pass


_setup_io()

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FRONTEND = os.path.join(ROOT, "frontend")
BACKEND = os.path.join(ROOT, "backend")
PY_WORK = os.path.join(ROOT, "build", "pyinstaller")
PY_DIST = os.path.join(ROOT, "build", "dist")
RELEASE = os.path.join(ROOT, "release")

APP_NAME = "paper-companion"

# 公式 OCR 模型：public/models 下是源码副本，构建时由 vite 复制进 dist
MODEL_DIR = os.path.join(FRONTEND, "public", "models", "formulanet")
MODEL_FILES = (
    os.path.join("onnx", "encoder_model.onnx"),
    os.path.join("onnx", "decoder_model_merged.onnx"),
)

# PyMuPDF 2.0 的 page.get_layout() 默认组合是 feature_set_name='imf+rf'、
# table_grid_model_ver='V4'（别名到 V4-EP），只会读下面这几个文件。
# 包里另外十几个模型是给其他参数组合准备的，项目没有用到，打包时裁掉。
LAYOUT_KEEP = (
    "layout_rf2.4.1+imf1.onnx",
    "layout_rf2.4.1+imf1.yaml",
    "feature_imf1.onnx",
    "table_grid_model_v4_ep.onnx",
)

# onnxruntime 的模型转换 / 量化工具链只在开发期用，运行时只需要 capi 下的动态库
ONNXRUNTIME_DROP = ("transformers", "quantization", "tools", "datasets")

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

【公式识别】
本发行包内置 FormulaNet / Texo 公式 OCR 模型，识别在浏览器本地完成，
不会上传论文内容。模型来源与 AGPL-3.0 许可见程序目录中的
frontend_dist/models/formulanet/NOTICE.txt。

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


def ensure_pdfjs_wasm() -> None:
    """pdf.js 的 CCITT/JBIG2 扫描图解码器是 WASM 裸文件，vite 不会打包，必须复制进
    dist/wasm/，否则整页扫描件渲染不出来。PyInstaller 整目录收 dist，会一并带上。"""
    run(["node", os.path.join("scripts", "copy-pdfjs-wasm.mjs")], cwd=FRONTEND)


def _missing_model_files(root: str) -> list[str]:
    return [name for name in MODEL_FILES if not os.path.isfile(os.path.join(root, name))]


def ensure_formula_model(allow_missing: bool) -> None:
    """公式模型不随仓库提交，缺了就打出一个“公式识别不可用”的包。
    这里在构建前显式拦一下，避免再产出体积正常但功能残缺的发行包。"""
    missing = _missing_model_files(MODEL_DIR)
    if not missing:
        return
    hint = ("缺少公式模型：" + "、".join(missing) +
            "\n先在 frontend 目录运行 `npm run model:download`（约 77MB），"
            "或加 --allow-missing-model 打一个不含公式识别的包。")
    if allow_missing:
        print("警告：" + hint, flush=True)
    else:
        raise SystemExit(hint)


def ensure_dist_model(allow_missing: bool) -> None:
    """--skip-npm 会复用旧 dist，旧 dist 可能是在模型下载前构建的（里面没有模型），
    这时把 public/models 补进去，保证发行包内容和源码一致。"""
    dist_model = os.path.join(FRONTEND, "dist", "models", "formulanet")
    if not _missing_model_files(dist_model):
        return
    if not _missing_model_files(MODEL_DIR):
        src = os.path.join(FRONTEND, "public", "models", "formulanet")
        os.makedirs(os.path.dirname(dist_model), exist_ok=True)
        shutil.copytree(src, dist_model, dirs_exist_ok=True)
        print("提示：已把公式模型补进 frontend/dist", flush=True)
        return
    if not allow_missing:
        raise SystemExit("frontend/dist 里没有公式模型，且 public/models 也不完整，无法打包。")


def _dir_size(path: str) -> int:
    total = 0
    for root, _dirs, files in os.walk(path):
        for name in files:
            try:
                total += os.path.getsize(os.path.join(root, name))
            except OSError:
                pass
    return total


def _remove(path: str) -> int:
    """删文件或目录，返回释放的字节数。"""
    if not os.path.exists(path):
        return 0
    size = _dir_size(path) if os.path.isdir(path) else os.path.getsize(path)
    try:
        if os.path.isdir(path):
            shutil.rmtree(path)
        else:
            os.remove(path)
    except OSError as exc:
        print(f"警告：删除 {path} 失败（{exc}）", flush=True)
        return 0
    return size


def prune_bundle(built: str) -> None:
    """PyInstaller 会把整包 collect 进来，这里删掉运行时不用的文件。
    都是确定不参与运行的数据/工具链，删除后功能不变。"""
    internal = os.path.join(built, "_internal")
    if not os.path.isdir(internal):
        internal = built
    freed = 0

    # PyMuPDF 的编译头文件（给二次开发用的，运行不需要）
    freed += _remove(os.path.join(internal, "pymupdf", "mupdf-devel"))

    # 只保留默认 get_layout() 会加载的 layout 模型；其余版本没有代码引用。
    # 若 PyMuPDF 升级后模型改名，白名单校验会失败，这时宁可不裁剪也不要打坏包。
    onnx_dir = os.path.join(internal, "pymupdf", "layout", "resources", "onnx")
    if os.path.isdir(onnx_dir):
        missing = [name for name in LAYOUT_KEEP if not os.path.isfile(os.path.join(onnx_dir, name))]
        if missing:
            print("警告：未找到预期的 layout 模型（" + "、".join(missing) +
                  "），跳过模型裁剪。请检查 PyMuPDF 版本的默认模型是否改了名。", flush=True)
        else:
            for name in os.listdir(onnx_dir):
                if name not in LAYOUT_KEEP:
                    freed += _remove(os.path.join(onnx_dir, name))

    # onnxruntime 的模型转换工具链只在开发期用
    for name in ONNXRUNTIME_DROP:
        freed += _remove(os.path.join(internal, "onnxruntime", name))

    # collect-all 偶尔会把 __pycache__ 当数据带进来
    for root, dirs, _files in os.walk(internal):
        for name in list(dirs):
            if name == "__pycache__":
                freed += _remove(os.path.join(root, name))
                dirs.remove(name)

    print(f"已精简打包产物：释放 {freed / 1024 / 1024:.1f} MB", flush=True)


def build_frontend(skip: bool) -> None:
    if skip:
        if not os.path.isdir(os.path.join(FRONTEND, "dist")):
            raise SystemExit("frontend/dist 不存在，不能使用 --skip-npm")
        ensure_pdfjs_wasm()
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
        # 公式/表格区域检测用 PyMuPDF 2.0 的版面模型，模型文件在 pymupdf/layout/resources 下，
        # 推理走 onnxruntime（延时 import，PyInstaller 扫不到，必须显式收集）。
        "--collect-all", "onnxruntime",
        "--hidden-import", "pymupdf.layout",
        "--collect-submodules", "uvicorn",
        "--hidden-import", "multipart",
        "--hidden-import", "uvicorn.logging",
        os.path.join(BACKEND, "launcher.py"),
    ]
    run(cmd, cwd=ROOT)
    out = os.path.join(PY_DIST, APP_NAME)
    if not os.path.isdir(out):
        raise SystemExit(f"打包失败，未找到输出目录：{out}")
    prune_bundle(out)
    return out


def make_release(built: str, target: str) -> tuple[str, str | None]:
    stage = os.path.join(RELEASE, f"{APP_NAME}-{target}")
    os.makedirs(RELEASE, exist_ok=True)
    kept_data = None
    if os.path.isdir(stage):
        # release 目录常被直接当运行目录，重建时先把它旁边的 data/ 挪出来，避免误删用户数据
        data_dir = os.path.join(stage, "data")
        if os.path.isdir(data_dir):
            kept_data = os.path.join(RELEASE, f"{APP_NAME}-{target}.data-keep-{int(time.time())}")
            os.rename(data_dir, kept_data)
            print(f"提示：已暂存用户数据目录 -> {kept_data}")
        try:
            shutil.rmtree(stage)
        except PermissionError:
            # 旧目录里有程序正在运行（data/app.db 被占用），挪到一边，不阻塞新构建
            aside = f"{stage}.old-{int(time.time())}"
            os.rename(stage, aside)
            print(f"提示：旧目录被占用，已移动到 {aside}")

    # Windows 上杀毒软件可能短时间锁住刚生成的文件，失败重试几次
    for attempt in range(3):
        try:
            shutil.copytree(built, stage)
            break
        except PermissionError:
            if attempt == 2:
                raise
            time.sleep(2)

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
    # 注意：这里不还原 data/，要等打包完成后再放回，避免把用户数据和 Key 打进发行包
    return stage, kept_data


def archive(stage: str, target: str) -> str:
    data_prefix = os.path.join(stage, "data")

    def skip_personal_data(path: str) -> bool:
        return os.path.abspath(path).startswith(os.path.abspath(data_prefix))

    if target.startswith("linux"):
        out = os.path.join(RELEASE, f"{APP_NAME}-{target}.tar.gz")
        with tarfile.open(out, "w:gz") as tar:
            def filt(info: tarfile.TarInfo):
                return None if skip_personal_data(info.name) else info
            tar.add(stage, arcname=os.path.basename(stage), filter=filt)
    else:
        out = os.path.join(RELEASE, f"{APP_NAME}-{target}.zip")
        with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
            base = os.path.dirname(stage)
            for folder, _dirs, files in os.walk(stage):
                if skip_personal_data(folder):
                    continue
                for name in files:
                    full = os.path.join(folder, name)
                    if skip_personal_data(full):
                        continue
                    # zip 规范要求正斜杠，Windows 的 os.sep 是反斜杠
                    zf.write(full, os.path.relpath(full, base).replace(os.sep, "/"))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--target", default=None, help="产物命名，如 win-x64 / macos-arm64 / linux-x64")
    ap.add_argument("--skip-npm", action="store_true", help="跳过 npm 构建，复用 frontend/dist")
    ap.add_argument("--allow-missing-model", action="store_true",
                    help="缺少公式模型时仍然打包（发行包将不带公式识别）")
    args = ap.parse_args()

    target = args.target or detect_target()
    print(f"target = {target}")

    ensure_formula_model(args.allow_missing_model)
    build_frontend(args.skip_npm)
    ensure_dist_model(args.allow_missing_model)
    built = build_backend()
    stage, kept_data = make_release(built, target)
    out = archive(stage, target)
    size_mb = os.path.getsize(out) / 1024 / 1024
    print(f"\n完成：{out}（{size_mb:.1f} MB）")

    # 发行包生成后再把本地用户数据放回目录，本地运行时数据仍在
    if kept_data and os.path.isdir(kept_data):
        os.rename(kept_data, os.path.join(stage, "data"))
        print("提示：用户数据已放回本地目录（未进入发行包）")


if __name__ == "__main__":
    main()
