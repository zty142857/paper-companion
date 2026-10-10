"""OpenAI 兼容客户端。用户自填 base_url/key/model；开发测试 key 走 .env，绝不硬编码进应用。"""
import json
import os
import time
import openai
from openai import OpenAI

from . import db

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")

# 进程级能力缓存：provider 明确拒绝过 response_format 就不再带它（每次白撞一趟浪费一个来回）
_NO_JSON_MODE = False


def reset_capability_cache() -> None:
    """设置变更后调用：换服务商/模型后重新探测参数支持。"""
    global _NO_JSON_MODE
    _NO_JSON_MODE = False


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


def _load_env():
    env = {}
    if os.path.exists(ENV_PATH):
        for line in open(ENV_PATH, encoding="utf-8"):
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    return env


def get_llm_config() -> dict:
    env = _load_env()
    return {
        "base_url": db.get_setting("llm_base_url") or env.get("LLM_BASE_URL")
                     or "https://dashscope.aliyuncs.com/compatible-mode/v1",
        "api_key": db.get_setting("llm_api_key") or env.get("LLM_API_KEY") or "",
        "model": db.get_setting("llm_model") or env.get("LLM_MODEL") or "qwen3.8-flash",
        "effort": db.get_setting("llm_effort") or "medium",
    }


def chat(messages: list[dict], *, json_mode=False, max_tokens=4096) -> str:
    global _NO_JSON_MODE
    cfg = get_llm_config()
    if not cfg["api_key"]:
        raise RuntimeError("未配置 API Key：请在工作台「设置」中填写，或在 backend/.env 配置 LLM_API_KEY")
    client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=300)
    kw = dict(model=cfg["model"], messages=messages, max_tokens=max_tokens)
    if json_mode and not _NO_JSON_MODE:
        kw["response_format"] = {"type": "json_object"}
    if cfg["model"].startswith("qwen3") and "dashscope" in cfg["base_url"]:
        kw["extra_body"] = {"enable_thinking": cfg["effort"] != "none",
                           "thinking_budget": {"low": 2048, "medium": 6144, "high": 16384}.get(cfg["effort"], 6144)}
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
                _NO_JSON_MODE = True
                continue
            if "extra_body" in kw and ("enable_thinking" in low or "thinking_budget" in low):
                kw.pop("extra_body")
                continue
            # 限流/5xx/网络抖动：退避后重试一次
            if not retried_transient and _is_transient(e):
                retried_transient = True
                time.sleep(1.5)
                continue
            raise


def test_connection(overrides: dict | None = None) -> dict:
    """连通性自检：一次最小对话调用（不落库、不改配置），返回 ok/耗时/错误摘要。
    overrides 让前端可以「未保存先测试」表单里填的值。"""
    cfg = get_llm_config()
    ov = overrides or {}
    for k in ("base_url", "model"):
        if (ov.get(k) or "").strip():
            cfg[k] = ov[k].strip()
    k = (ov.get("api_key") or "").strip()
    if k and "****" not in k and k != "已设置":
        cfg["api_key"] = k
    if not cfg["api_key"]:
        return {"ok": False, "model": cfg["model"], "error": "尚未配置 API Key"}
    t0 = time.time()
    try:
        client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=20)
        kw = dict(model=cfg["model"], messages=[{"role": "user", "content": "ping，请只回复：ok"}], max_tokens=8)
        if cfg["model"].startswith("qwen3") and "dashscope" in cfg["base_url"]:
            kw["extra_body"] = {"enable_thinking": False}   # 自检不思考，快且省
        r = client.chat.completions.create(**kw)
        ms = int((time.time() - t0) * 1000)
        return {"ok": True, "model": cfg["model"], "latency_ms": ms,
                "reply": (r.choices[0].message.content or "").strip()[:24]}
    except Exception as e:
        ms = int((time.time() - t0) * 1000)
        low = str(e).lower()
        if "timeout" in low or "timed out" in low:
            brief = "连接超时（20s）：检查网络或 Base URL 是否可达"
        elif "401" in low or "invalid_api_key" in low or "authentication" in low:
            brief = "鉴权失败：API Key 无效或过期"
        elif "404" in low or "not found" in low or "does not exist" in low:
            brief = "模型或接口不存在：核对模型名与 Base URL"
        else:
            brief = str(e)[:240]
        return {"ok": False, "model": cfg["model"], "latency_ms": ms, "error": brief}


def tone_hint(familiarity: str | None) -> str:
    """按读者熟悉度给出措辞/难度提示，供各功能拼进 prompt。"""
    fam = (familiarity or "新手").strip()
    if fam == "新手":
        return "读者是**新手**：请用最通俗易懂的语言，少用行话；专业名词首次出现时用一句白话或比喻解释。"
    if fam == "熟手":
        return "读者是**熟手**：可用专业术语，直接讲要点，无需解释基础概念。"
    return "读者是**进阶**：语言适中，专业术语可直接使用，个别难点稍作说明。"


def chat_json(prompt: str, system: str, *, fallback_key: str = "result", max_tokens: int = 4096) -> dict:
    """要求模型输出 JSON；解析失败时降级为 {fallback_key: 原文}。"""
    raw = chat([{"role": "system", "content": system + "\n只输出合法 JSON，不要输出任何其他内容。"},
                {"role": "user", "content": prompt}], json_mode=True, max_tokens=max_tokens)
    try:
        start = raw.find("{")
        end = raw.rfind("}")
        return json.loads(raw[start:end + 1]) if start >= 0 and end > start else {fallback_key: raw}
    except json.JSONDecodeError:
        return {fallback_key: raw}
