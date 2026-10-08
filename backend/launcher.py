"""免安装发行版入口：启动本地服务并自动打开浏览器。

源码运行：  python backend/launcher.py
打包运行：  PyInstaller 以本文件为入口，生成单文件/单目录可执行程序。
"""

import socket
import os
import sys
import threading
import time
import webbrowser

import uvicorn

HOST = "127.0.0.1"
PREFERRED_PORT = 8765
PORT_SPAN = 20


def pick_port() -> int:
    """从 8765 起找一个空闲端口，避免和别的程序撞车。"""
    for port in range(PREFERRED_PORT, PREFERRED_PORT + PORT_SPAN):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind((HOST, port))
                return port
            except OSError:
                continue
    return PREFERRED_PORT


def main() -> None:
    from app.main import app

    port = pick_port()
    url = f"http://{HOST}:{port}"
    no_browser = os.environ.get("PC_NO_BROWSER") == "1" or "--no-browser" in sys.argv

    def open_browser() -> None:
        time.sleep(1.5)
        try:
            webbrowser.open(url)
        except Exception:
            pass

    print("=" * 52)
    print("  论文阅读智能学伴已启动")
    print(f"  浏览器访问：{url}")
    print("  关闭此窗口即可退出程序")
    print("=" * 52)

    if not no_browser:
        threading.Thread(target=open_browser, daemon=True).start()
    uvicorn.run(app, host=HOST, port=port, log_level="info")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
    except Exception as exc:  # 双击运行时保留窗口，方便看到错误
        print(f"\n启动失败：{exc}")
        if getattr(sys, "frozen", False):
            input("\n按回车键退出…")
        raise
