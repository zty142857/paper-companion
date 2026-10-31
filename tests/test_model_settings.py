"""模型设置（多提供商 / 双轨路由 / 思考强度 / 目录匹配）的逻辑单测。

    python tests/test_model_settings.py

不联网：实时模型列表的失败回落分支用「无 Key 的云端提供商」触发。
"""
import os
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "backend"))

# 必须在导入 db 之前指定数据目录，避免动到用户的 backend/data
TMP = tempfile.mkdtemp(prefix="pc-model-settings-")
os.environ["PAPER_COMPANION_DATA_DIR"] = TMP

from app import db, llm, model_catalog  # noqa: E402

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


def main() -> None:
    c = TestClient(app)

    print("[1] 旧配置迁移")
    provs = db.list_providers()
    check("迁移出 1 个提供商", len(provs) == 1, str(len(provs)))
    routes = c.get("/api/routes").json()
    check("两个用途都指向它",
          routes["default"]["provider_id"] == routes["translate"]["provider_id"] == provs[0]["id"])
    check("旧模型名保留", routes["default"]["model"] == "qwen3.8-flash", routes["default"]["model"])

    print("[2] 提供商 CRUD + 路由隔离")
    r = c.post("/api/providers", json={"catalog_id": "local-ollama"})
    check("按本地预设创建", r.status_code == 200, r.text[:120])
    local = r.json()
    check("本地预设自动填 Base URL", local["base_url"] == "http://127.0.0.1:11434/v1", local["base_url"])
    c.put("/api/routes", json={"translate": {"provider_id": local["id"], "model": "qwen2.5:7b", "effort": ""}})
    check("翻译走本地", llm.get_route("translate")["model"] == "qwen2.5:7b")
    check("其他仍走云端", llm.get_route("default")["model"] == "qwen3.8-flash")
    check("被引用的提供商不能删", c.delete(f"/api/providers/{local['id']}").status_code == 409)

    print("[3] 本机服务空 Key")
    local_cfg = llm.get_route("translate")
    check("本地服务空 Key 可用", llm._client(local_cfg).api_key == "local")
    remote = dict(local_cfg, base_url="https://api.example.com/v1", api_key="")
    try:
        llm._client(remote)
        check("远程空 Key 报错", False)
    except llm.LLMNotConfigured:
        check("远程空 Key 报错", True)

    print("[4] 思考强度适配")
    base = dict(local_cfg, model="qwen3.8-flash", catalog_id="alibaba-cn",
                base_url="https://dashscope.aliyuncs.com/compatible-mode/v1")
    kw = llm.reasoning_kwargs(dict(base, effort="medium"))
    check("DashScope → enable_thinking + budget",
          kw.get("extra_body") == {"enable_thinking": True, "thinking_budget": 6144}, str(kw))
    kw = llm.reasoning_kwargs(dict(base, effort="none"))
    check("DashScope 关闭思考", kw.get("extra_body") == {"enable_thinking": False}, str(kw))
    generic = dict(base, model="some-model", catalog_id=None,
                   base_url="https://api.example.com/v1", effort="low")
    check("通用 → reasoning_effort", llm.reasoning_kwargs(generic) == {"reasoning_effort": "low"})
    check("自动 = 不发送", llm.reasoning_kwargs(dict(generic, effort="")) == {})
    check("toggle 开启 → medium", llm.reasoning_kwargs(dict(generic, effort="on")) == {"reasoning_effort": "medium"})

    print("[5] 模型目录")
    check("URL 归一化忽略 /v1", model_catalog.norm_url("https://api.deepseek.com/v1") == "api.deepseek.com")
    deep = model_catalog.provider_for_base_url("https://api.deepseek.com/v1")
    check("按 base_url 匹配到 DeepSeek", bool(deep) and deep["id"] == "deepseek",
          str(deep and deep["id"]))
    info = model_catalog.model_info("alibaba-cn", "qwen3.8-flash")
    check("模型元数据可查", info["known"], str(info)[:120])
    check("声明了思考档位", "medium" in model_catalog.effort_values("alibaba-cn", "qwen3.8-flash"),
          str(model_catalog.effort_values("alibaba-cn", "qwen3.8-flash")))
    check("未收录模型不报错", model_catalog.model_info(None, "my-local-7b")["known"] is False)
    presets = model_catalog.presets()
    check("预设包含本地服务", any(p["id"] == "local-ollama" for p in presets))
    check("预设数量 > 100", len(presets) > 100, str(len(presets)))

    print("[6] 模型列表回落 / 启用清单")
    cloud = provs[0]
    synced = c.post(f"/api/providers/{cloud['id']}/models/sync").json()
    check("无 Key 时回落到目录", synced["source"] == "catalog" and len(synced["models"]) > 0,
          f"{synced['source']} {len(synced['models'])}")
    check("回落时带失败原因", bool(synced["error"]))
    saved = c.put(f"/api/providers/{cloud['id']}/models",
                  json={"enabled": ["qwen3.8-flash", "not-exist"]}).json()
    check("启用清单过滤掉不存在的模型", saved["enabled"] == ["qwen3.8-flash"], str(saved))

    print("[7] 未配置模型 → 400 而不是 500")
    c.put("/api/routes", json={
        "default": {"provider_id": "", "model": "", "effort": ""},
        "translate": {"provider_id": "", "model": "", "effort": ""},
    })
    pid = db.new_pending("t.pdf")
    db.finish_paper(pid, "t", "t.pdf", {
        "title": "t", "pages": 1,
        "blocks": [{"id": "b1", "text": "hello world", "page": 1, "section_id": "s1", "top": 0}],
        "sections": [{"id": "s1", "title": "S", "page": 1}],
    })
    r = c.post(f"/api/papers/{pid}/translate", json={"block_id": "b1"})
    check("返回 400 + 提示", r.status_code == 400 and r.json().get("code") == "model_not_configured",
          f"{r.status_code} {r.text[:120]}")

    print("[8] 更新 / 删除提供商")
    u = c.put(f"/api/providers/{local['id']}",
              json={"name": "本地 Ollama（改）", "api_key": "sk-1234567890abcdef", "headers": {"X-Test": "1"}}).json()
    check("改名生效", u["name"] == "本地 Ollama（改）", u["name"])
    check("Key 掩码回显", "****" in u["api_key"] and u["api_key"].endswith("cdef"), u["api_key"])
    check("自定义请求头保存", u["headers"] == {"X-Test": "1"}, str(u["headers"]))
    tmp = c.post("/api/providers", json={"name": "临时", "base_url": "https://example.com/v1"}).json()
    check("删除未被引用的提供商", c.delete(f"/api/providers/{tmp['id']}").status_code == 200)

    print("[9] 一键清除会清掉所有 Key")
    db.update_provider(cloud["id"], api_key="sk-secret")
    db.clear_all_data(keep_llm_settings=True)
    check("提供商 Key 已清空", all(not p["api_key"] for p in db.list_providers()))

    print()
    if FAILS:
        print(f"FAILED: {len(FAILS)} → {', '.join(FAILS)}")
        sys.exit(1)
    print("all passed")


if __name__ == "__main__":
    main()
