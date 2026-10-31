"""OpenAI 兼容客户端。多提供商 + 按用途路由（翻译 / 其他任务）。

配置不再是一套全局值，而是：
  provider 表：一份份提供商（base_url / key / 请求头 / 候选模型）
  setting 表：llm_route_default / llm_route_translate 指向「哪家提供商的哪个模型、哪个思考强度」
翻译只走 ai.translate()，其余功能统一走 default；两个桶各自独立，互不回落。
"""
import json
import os
import threading
import time
from urllib.parse import urlsplit

import openai
from openai import OpenAI

from . import db, model_catalog

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")

DEFAULT_BASE = "https://dashscope.aliyuncs.com/compatible-mode/v1"
DEFAULT_MODEL = "qwen3.8-flash"

PURPOSES = ("default", "translate")
PURPOSE_LABELS = {"default": "其他任务", "translate": "翻译"}

# DashScope 只认 budget 数值，不认低/中/高
THINKING_BUDGET = {"minimal": 1024, "low": 2048, "medium": 6144, "high": 16384,
                   "xhigh": 24576, "max": 32768, "on": 6144}

# 进程级能力缓存：某家 provider 明确拒绝过的可选参数就不再带（每次白撞一趟浪费一个来回）
_UNSUPPORTED: dict[str, set[str]] = {}

_MIGRATED = False
_MIGRATE_LOCK = threading.Lock()

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0", "host.docker.internal"}

_HOST_NAMES = {
    "dashscope.aliyuncs.com": "DashScope",
    "dashscope-intl.aliyuncs.com": "DashScope（国际）",
    "api.deepseek.com": "DeepSeek",
    "api.moonshot.cn": "Moonshot",
    "api.moonshot.ai": "Moonshot",
    "open.bigmodel.cn": "智谱",
    "api.openai.com": "OpenAI",
    "api.siliconflow.cn": "SiliconFlow",
    "api.siliconflow.com": "SiliconFlow",
}


class LLMNotConfigured(RuntimeError):
    """提供商/模型没配好。主程序会转成 400 + 可读提示，而不是 500。"""

    def __init__(self, purpose: str = "default", message: str = ""):
        self.purpose = purpose if purpose in PURPOSES else "default"
        label = PURPOSE_LABELS[self.purpose]
        super().__init__(message or f"「{label}」尚未选择模型，请到「模型设置」里配置提供商与模型")


def reset_capability_cache() -> None:
    """设置变更后调用：换服务商/模型后重新探测 response_format 等参数支持。"""
    _UNSUPPORTED.clear()


# ---------------- 配置读取 / 迁移 ----------------

def _load_env() -> dict:
    env = {}
    if os.path.exists(ENV_PATH):
        try:
            for line in open(ENV_PATH, encoding="utf-8"):
                line = line.strip()
                if line and not line.startswith("#") and "=" in line:
                    k, v = line.split("=", 1)
                    env[k.strip()] = v.strip()
        except OSError:
            pass
    return env


def _host(url: str) -> str:
    u = (url or "").strip()
    if u and "://" not in u:
        u = "https://" + u
    try:
        return (urlsplit(u).hostname or "").lower()
    except ValueError:
        return ""


def is_local_url(url: str) -> bool:
    h = _host(url)
    return h in _LOCAL_HOSTS or h.endswith(".local")


def suggest_name(base_url: str) -> str:
    cat = model_catalog.guess_provider(base_url)
    if cat and cat.get("name"):
        return cat["name"]
    h = _host(base_url)
    if h in _HOST_NAMES:
        return _HOST_NAMES[h]
    return h or "默认提供商"


def _route_key(purpose: str) -> str:
    return f"llm_route_{purpose if purpose in PURPOSES else 'default'}"


def ensure_migrated() -> None:
    """把旧的单套配置（llm_base_url/key/model/effort）升级成 provider + 两条路由。

    用 setting.llm_schema_v2 做幂等标记；用户之后删光提供商也不会被重新造出来。
    """
    global _MIGRATED
    if _MIGRATED or db.get_setting("llm_schema_v2") == "1":
        _MIGRATED = True
        return
    with _MIGRATE_LOCK:
        if _MIGRATED or db.get_setting("llm_schema_v2") == "1":
            _MIGRATED = True
            return
        if not db.list_providers():
            env = _load_env()
            base_url = (db.get_setting("llm_base_url") or env.get("LLM_BASE_URL")
                        or DEFAULT_BASE).strip()
            api_key = (db.get_setting("llm_api_key") or env.get("LLM_API_KEY") or "").strip()
            model = (db.get_setting("llm_model") or env.get("LLM_MODEL") or DEFAULT_MODEL).strip()
            effort = (db.get_setting("llm_effort") or "").strip() or "medium"
            cat = model_catalog.guess_provider(base_url)
            pid = db.add_provider(
                name=suggest_name(base_url),
                base_url=base_url,
                api_key=api_key,
                catalog_id=cat["id"] if cat else None,
            )
            route = json.dumps({"provider_id": pid, "model": model, "effort": effort},
                               ensure_ascii=False)
            db.set_setting("llm_route_default", route)
            db.set_setting("llm_route_translate", route)
        db.set_setting("llm_schema_v2", "1")
        _MIGRATED = True


def get_route(purpose: str = "default") -> dict:
    """解析某用途实际要用的提供商 + 模型。没配好就抛 LLMNotConfigured。"""
    ensure_migrated()
    p = purpose if purpose in PURPOSES else "default"
    raw = db.get_setting(_route_key(p)) or ""
    try:
        route = json.loads(raw) if raw else {}
    except ValueError:
        route = {}
    if not isinstance(route, dict):
        route = {}
    prov = db.get_provider(route.get("provider_id") or "")
    model = (route.get("model") or "").strip()
    if not prov or not model or not (prov.get("base_url") or "").strip():
        raise LLMNotConfigured(p)
    return {
        "purpose": p,
        "provider_id": prov["id"],
        "provider_name": prov.get("name") or "",
        "base_url": prov["base_url"],
        "api_key": prov.get("api_key") or "",
        "headers": prov.get("headers") or {},
        "catalog_id": prov.get("catalog_id"),
        "model": model,
        "effort": (route.get("effort") or "").strip(),
    }


def get_llm_config(purpose: str = "default") -> dict:
    """兼容旧调用：返回当前路由（含明文 key），仅后端内部使用。"""
    return get_route(purpose)


def _client(cfg: dict, timeout: int = 300) -> OpenAI:
    key = (cfg.get("api_key") or "").strip()
    if not key:
        if is_local_url(cfg.get("base_url") or ""):
            key = "local"   # OpenAI SDK 要求非空；本地服务不校验
        else:
            raise LLMNotConfigured(cfg.get("purpose", "default"),
                                   f"「{PURPOSE_LABELS.get(cfg.get('purpose', 'default'), '其他任务')}」"
                                   f"使用的提供商的 API Key 为空，请到「模型设置」填写")
    return OpenAI(api_key=key, base_url=cfg["base_url"], timeout=timeout,
                  default_headers=cfg.get("headers") or None)


def provider_key(prov: dict) -> str:
    """本地服务允许空 Key（SDK 要求非空，填占位值）；远程服务空 Key 视为未配置。"""
    key = (prov.get("api_key") or "").strip()
    if key:
        return key
    return "local" if is_local_url(prov.get("base_url") or "") else ""


def provider_client(prov: dict, timeout: int = 20) -> OpenAI:
    key = provider_key(prov)
    if not key:
        raise LLMNotConfigured("default", "该提供商还没填 API Key")
    return OpenAI(api_key=key, base_url=prov["base_url"], timeout=timeout,
                  default_headers=prov.get("headers") or None)


# ---------------- 思考强度 ----------------

def _is_dashscope(cfg: dict) -> bool:
    return ("dashscope" in (cfg.get("base_url") or "").lower()
            or cfg.get("catalog_id") in ("alibaba", "alibaba-cn"))


def reasoning_kwargs(cfg: dict) -> dict:
    """把统一的 effort 值翻译成该提供商认识的参数。

    空 effort = 自动：什么都不发，由服务商决定（对不支持的模型最安全）。
    """
    effort = (cfg.get("effort") or "").strip()
    if not effort:
        return {}
    model = (cfg.get("model") or "").strip()
    if _is_dashscope(cfg) and model.lower().startswith("qwen"):
        if effort == "none":
            return {"extra_body": {"enable_thinking": False}}
        return {"extra_body": {"enable_thinking": True,
                               "thinking_budget": THINKING_BUDGET.get(effort, 6144)}}
    level = "medium" if effort == "on" else effort
    if level == "none":
        declared = model_catalog.effort_values(cfg.get("catalog_id"), model)
        return {"reasoning_effort": "none"} if "none" in declared else {}
    return {"reasoning_effort": level}


def _unsupported(cfg: dict) -> set[str]:
    return _UNSUPPORTED.setdefault(cfg.get("provider_id") or "?", set())


def _mark_unsupported(cfg: dict, param: str) -> None:
    _unsupported(cfg).add(param)


# ---------------- 调用 ----------------

def _is_transient(e: Exception) -> bool:
    if isinstance(e, (openai.APITimeoutError, openai.APIConnectionError,
                      openai.RateLimitError, openai.InternalServerError)):
        return True
    code = getattr(e, "status_code", None)
    if isinstance(code, int) and (code == 429 or code >= 500):
        return True
    s = str(e).lower()
    return any(k in s for k in ("timeout", "connection error", "rate limit",
                                "too many requests", "429", "500", "502", "503", "504"))


def chat(messages: list[dict], *, purpose: str = "default", json_mode=False,
         max_tokens=4096) -> str:
    cfg = get_route(purpose)
    client = _client(cfg)
    kw = dict(model=cfg["model"], messages=messages, max_tokens=max_tokens)
    unsupported = _unsupported(cfg)
    if json_mode and "response_format" not in unsupported:
        kw["response_format"] = {"type": "json_object"}
    if "reasoning_effort" not in unsupported and "extra_body" not in unsupported:
        kw.update(reasoning_kwargs(cfg))
    retried_transient = False
    while True:
        try:
            r = client.chat.completions.create(**kw)
            return r.choices[0].message.content or ""
        except Exception as e:
            low = str(e).lower()
            # 参数降级阶梯：provider 不支持的可选参数 → 去掉立刻重试（不占瞬时错误重试额度）。
            # 老版 vLLM / Ollama 兼容层 / 部分中转不认 response_format，不降级会整站不可用。
            if "response_format" in kw and ("response_format" in low or "json_object" in low):
                kw.pop("response_format")
                _mark_unsupported(cfg, "response_format")
                continue
            if "reasoning_effort" in kw and "reasoning_effort" in low:
                kw.pop("reasoning_effort")
                _mark_unsupported(cfg, "reasoning_effort")
                continue
            if "extra_body" in kw and ("enable_thinking" in low or "thinking_budget" in low):
                kw.pop("extra_body")
                _mark_unsupported(cfg, "extra_body")
                continue
            # 限流/5xx/网络抖动：退避后重试一次
            if not retried_transient and _is_transient(e):
                retried_transient = True
                time.sleep(1.5)
                continue
            raise


def brief_error(e: Exception) -> str:
    low = str(e).lower()
    if "timeout" in low or "timed out" in low:
        return "连接超时：检查网络或 Base URL 是否可达"
    if "401" in low or "invalid_api_key" in low or "authentication" in low:
        return "鉴权失败：API Key 无效或过期"
    if "404" in low or "not found" in low or "does not exist" in low:
        return "模型或接口不存在：核对模型名与 Base URL（多数服务需要以 /v1 结尾）"
    return str(e)[:240]


def _override_key(raw: str, saved: str) -> str:
    """表单里的掩码占位值不算数，回落到已保存的 key。"""
    k = (raw or "").strip()
    if not k or "****" in k or k == "已设置":
        return saved
    return k


def test_connection(provider_id: str | None = None, overrides: dict | None = None,
                    purpose: str = "default") -> dict:
    """连通性自检：一次最小对话调用（不落库、不改配置）。

    provider_id 为空时用当前路由；overrides 支持「未保存先测试」表单里的值。
    """
    ov = overrides or {}
    p = purpose if purpose in PURPOSES else "default"
    try:
        if provider_id:
            prov = db.get_provider(provider_id)
            if not prov:
                return {"ok": False, "model": "", "error": "提供商不存在"}
            cfg = {
                "purpose": p,
                "provider_id": prov["id"],
                "provider_name": prov.get("name") or "",
                "base_url": (ov.get("base_url") or "").strip() or prov["base_url"],
                "api_key": _override_key(ov.get("api_key") or "", prov.get("api_key") or ""),
                "headers": prov.get("headers") or {},
                "catalog_id": prov.get("catalog_id"),
                "model": (ov.get("model") or "").strip(),
                "effort": (ov.get("effort") or "").strip(),
            }
            if not cfg["model"]:
                return {"ok": False, "model": "", "provider": cfg["provider_name"],
                        "error": "请先选择模型"}
        else:
            cfg = get_route(p)
            for k in ("base_url", "model"):
                if (ov.get(k) or "").strip():
                    cfg[k] = ov[k].strip()
            cfg["api_key"] = _override_key(ov.get("api_key") or "", cfg.get("api_key") or "")
            if "effort" in ov:
                cfg["effort"] = (ov.get("effort") or "").strip()
    except LLMNotConfigured as e:
        return {"ok": False, "model": "", "error": str(e)}

    t0 = time.time()
    try:
        client = _client(cfg, timeout=20)
        kw = dict(model=cfg["model"],
                  messages=[{"role": "user", "content": "ping，请只回复：ok"}],
                  max_tokens=8)
        sender = _unsupported(cfg)
        sent = reasoning_kwargs(cfg) if not ({"reasoning_effort", "extra_body"} & sender) else {}
        kw.update(sent)
        r = client.chat.completions.create(**kw)
        ms = int((time.time() - t0) * 1000)
        return {"ok": True, "model": cfg["model"], "provider": cfg.get("provider_name", ""),
                "latency_ms": ms, "reasoning": sent,
                "reply": (r.choices[0].message.content or "").strip()[:24]}
    except Exception as e:
        return {"ok": False, "model": cfg["model"], "provider": cfg.get("provider_name", ""),
                "latency_ms": int((time.time() - t0) * 1000), "error": brief_error(e)}


def probe_efforts(provider_id: str, model: str, levels: list[str]) -> dict:
    """手动验证：逐个档位发一次最小请求，看服务商是否接受这些参数。

    只能证明「不报错」，不能证明模型真的在思考 —— UI 里要如实说明。
    """
    prov = db.get_provider(provider_id)
    if not prov:
        return {"ok": False, "error": "提供商不存在", "results": []}
    results = []
    for level in levels[:8]:
        cfg = {
            "purpose": "default",
            "provider_id": prov["id"],
            "provider_name": prov.get("name") or "",
            "base_url": prov["base_url"],
            "api_key": prov.get("api_key") or "",
            "headers": prov.get("headers") or {},
            "catalog_id": prov.get("catalog_id"),
            "model": model,
            "effort": (level or "").strip(),
        }
        t0 = time.time()
        try:
            client = _client(cfg, timeout=25)
            kw = dict(model=model, messages=[{"role": "user", "content": "ping"}], max_tokens=8)
            kw.update(reasoning_kwargs(cfg))
            client.chat.completions.create(**kw)
            results.append({"level": level, "ok": True,
                            "latency_ms": int((time.time() - t0) * 1000)})
        except Exception as e:
            results.append({"level": level, "ok": False,
                            "latency_ms": int((time.time() - t0) * 1000),
                            "error": brief_error(e)})
    return {"ok": True, "results": results}


def tone_hint(familiarity: str | None) -> str:
    """按读者熟悉度给出措辞/难度提示，供各功能拼进 prompt。"""
    fam = (familiarity or "新手").strip()
    if fam == "新手":
        return "读者是**新手**：请用最通俗易懂的语言，少用行话；专业名词首次出现时用一句白话或比喻解释。"
    if fam == "熟手":
        return "读者是**熟手**：可用专业术语，直接讲要点，无需解释基础概念。"
    return "读者是**进阶**：语言适中，专业术语可直接使用，个别难点稍作说明。"


def chat_json(prompt: str, system: str, *, purpose: str = "default",
              fallback_key: str = "result", max_tokens: int = 4096) -> dict:
    """要求模型输出 JSON；解析失败时降级为 {fallback_key: 原文}。"""
    raw = chat([{"role": "system", "content": system + "\n只输出合法 JSON，不要输出任何其他内容。"},
                {"role": "user", "content": prompt}],
               purpose=purpose, json_mode=True, max_tokens=max_tokens)
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        return json.loads(raw[start:end + 1]) if start >= 0 and end > start else {fallback_key: raw}
    except json.JSONDecodeError:
        return {fallback_key: raw}
