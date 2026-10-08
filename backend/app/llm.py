"""OpenAI 兼容客户端。用户自填 base_url/key/model；开发测试 key 走 .env，绝不硬编码进应用。"""
import json
import os
from openai import OpenAI

from . import db

ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")


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
    cfg = get_llm_config()
    if not cfg["api_key"]:
        raise RuntimeError("未配置 API Key：请在工作台「设置」中填写，或在 backend/.env 配置 LLM_API_KEY")
    client = OpenAI(api_key=cfg["api_key"], base_url=cfg["base_url"], timeout=300)
    kw = dict(model=cfg["model"], messages=messages, max_tokens=max_tokens)
    if json_mode:
        kw["response_format"] = {"type": "json_object"}
    if cfg["model"].startswith("qwen3") and "dashscope" in cfg["base_url"]:
        kw["extra_body"] = {"enable_thinking": cfg["effort"] != "none",
                           "thinking_budget": {"low": 2048, "medium": 6144, "high": 16384}.get(cfg["effort"], 6144)}
    try:
        r = client.chat.completions.create(**kw)
    except Exception as e:
        if "extra_body" in kw and ("enable_thinking" in str(e) or "thinking_budget" in str(e)):
            kw.pop("extra_body")
            r = client.chat.completions.create(**kw)
        else:
            raise
    return r.choices[0].message.content or ""


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
