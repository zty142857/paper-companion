"""models.dev 模型目录：提供商预设 + 模型能力元数据（思考强度 / 上下文 / 价格）。

快照由 packaging/build_model_catalog.py 生成，随包分发保证离线可用；
运行时若 data/catalog.json 存在（设置里点「更新模型目录」后写入）则优先使用它。
读不到目录时所有查询都返回空结果，不影响用户手填模型。
"""
import json
import os
import sys
import tempfile
import time
import urllib.request
from urllib.parse import urlsplit

SOURCE_URL = "https://models.dev/api.json"

# 只收录 OpenAI 兼容协议的提供方（本项目只实现这一种协议）
COMPAT_NPM = {
    "@ai-sdk/openai-compatible",
    "@ai-sdk/openai",
    "@openrouter/ai-sdk-provider",
    "@aihubmix/ai-sdk-provider",
}

# models.dev 里这些提供方没有 api 字段（走各自 SDK 默认地址），但都提供 OpenAI 兼容端点
API_OVERRIDES = {
    "openai": "https://api.openai.com/v1",
    "groq": "https://api.groq.com/openai/v1",
    "mistral": "https://api.mistral.ai/v1",
    "xai": "https://api.x.ai/v1",
    "google": "https://generativelanguage.googleapis.com/v1beta/openai",
}

# models.dev 不收录本地部署实例，单独补上（模型数量为 0，模型列表靠实时 /v1/models 拉）
LOCAL_PRESETS = [
    {"id": "local-ollama", "name": "本地 · Ollama", "api": "http://127.0.0.1:11434/v1", "local": True},
    {"id": "local-lmstudio", "name": "本地 · LM Studio", "api": "http://127.0.0.1:1234/v1", "local": True},
    {"id": "local-vllm", "name": "本地 · vLLM", "api": "http://127.0.0.1:8000/v1", "local": True},
]

_MODEL_KEEP = ("family", "reasoning", "reasoning_options", "limit", "cost",
               "status", "canonical_model_id", "attachment", "tool_call")

_LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1", "0.0.0.0"}

_DATA = None      # 整份快照（已裁剪）
_BY_ID = None     # provider id -> provider
_BY_URL = None    # 归一化 base_url -> provider
_MODELS = {}      # provider id -> {小写模型 id: model}


def _snapshot_paths() -> list[str]:
    paths = []
    try:
        from . import db
        paths.append(os.path.join(db.DATA_DIR, "catalog.json"))
    except Exception:
        pass
    if getattr(sys, "frozen", False) and getattr(sys, "_MEIPASS", None):
        paths.append(os.path.join(sys._MEIPASS, "app", "model_catalog.json"))
    paths.append(os.path.join(os.path.dirname(os.path.abspath(__file__)), "model_catalog.json"))
    return paths


def _reset() -> None:
    global _DATA, _BY_ID, _BY_URL
    _DATA = _BY_ID = _BY_URL = None
    _MODELS.clear()


def _data() -> dict:
    global _DATA
    if _DATA is not None:
        return _DATA
    for path in _snapshot_paths():
        if not os.path.exists(path):
            continue
        try:
            with open(path, encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict) and isinstance(loaded.get("providers"), list):
                _DATA = loaded
                return _DATA
        except (OSError, ValueError):
            continue
    _DATA = {"providers": []}
    return _DATA


def _indexes():
    global _BY_ID, _BY_URL
    if _BY_ID is None:
        _BY_ID, _BY_URL = {}, {}
        for p in _data().get("providers", []):
            pid = p.get("id")
            if not pid:
                continue
            _BY_ID[pid] = p
            key = norm_url(p.get("api") or "")
            if key:
                _BY_URL.setdefault(key, p)
    return _BY_ID, _BY_URL


def norm_url(url: str) -> str:
    """把 base_url 归一化成 host + path，忽略协议、www、结尾斜杠与 /v1 后缀。

    这样 https://api.deepseek.com 和 https://api.deepseek.com/v1 能匹配到同一家。
    """
    u = (url or "").strip()
    if not u:
        return ""
    if "://" not in u:
        u = "https://" + u
    try:
        sp = urlsplit(u)
    except ValueError:
        return ""
    host = (sp.netloc or "").lower()
    if host.startswith("www."):
        host = host[4:]
    path = (sp.path or "").rstrip("/")
    if path.endswith("/v1"):
        path = path[:-3]
    return host + path


def get_provider(pid: str | None) -> dict | None:
    if not pid:
        return None
    return _indexes()[0].get(pid)


def provider_for_base_url(base_url: str) -> dict | None:
    key = norm_url(base_url)
    if not key:
        return None
    return _indexes()[1].get(key)


def preset(pid: str | None) -> dict | None:
    """按 id 取预设；本地实例（Ollama / vLLM）不在快照里，单独补。"""
    if not pid:
        return None
    for p in LOCAL_PRESETS:
        if p["id"] == pid:
            return p
    return get_provider(pid)


def guess_provider(base_url: str) -> dict | None:
    """先按完整 URL 匹配，再退化到只比 host（用户可能多写了 /v1 之外的路径）。

    本地地址只做精确匹配：127.0.0.1 换个端口就是另一套服务，不能只看 host。
    """
    exact = provider_for_base_url(base_url)
    if exact:
        return exact
    host = norm_url(base_url).split("/")[0]
    if not host or host in _LOCAL_HOSTS:
        return None
    for p in _data().get("providers", []):
        if norm_url(p.get("api") or "").split("/")[0] == host:
            return p
    return None


def models(catalog_id: str | None) -> list[dict]:
    p = get_provider(catalog_id)
    return list(p.get("models") or []) if p else []


def _model_index(catalog_id: str) -> dict:
    idx = _MODELS.get(catalog_id)
    if idx is None:
        idx = {}
        for m in models(catalog_id):
            mid = (m.get("id") or "").lower()
            if mid:
                idx[mid] = m
        _MODELS[catalog_id] = idx
    return idx


def _find_anywhere(model_id: str) -> dict | None:
    """目录里没记录提供商时，按模型 id 全局找一份元数据（同名模型能力通常一致）。"""
    target = (model_id or "").lower()
    if not target:
        return None
    for p in _data().get("providers", []):
        pid = p.get("id")
        if pid and target in _model_index(pid):
            return _model_index(pid)[target]
    return None


def model_info(catalog_id: str | None, model_id: str) -> dict:
    """返回模型元数据；未收录时 known=False，思考档位留空由 UI 退化处理。"""
    m = None
    if catalog_id:
        m = _model_index(catalog_id).get((model_id or "").lower())
    if m is None:
        m = _find_anywhere(model_id)
    if not m:
        return {"known": False, "id": model_id, "name": model_id,
                "reasoning_options": [], "limit": {}, "cost": {}}
    out = dict(m)
    out["known"] = True
    out["reasoning_options"] = [x for x in (m.get("reasoning_options") or []) if isinstance(x, dict)]
    out["limit"] = m.get("limit") or {}
    out["cost"] = m.get("cost") or {}
    return out


def effort_values(catalog_id: str | None, model_id: str) -> list[str]:
    """该模型声明支持的具体思考档位（不含 toggle 语义）。"""
    for opt in model_info(catalog_id, model_id).get("reasoning_options") or []:
        if opt.get("type") == "effort" and isinstance(opt.get("values"), list):
            return [str(v) for v in opt["values"]]
    return []


def presets() -> list[dict]:
    rows = [dict(p, model_count=0, local=True) for p in LOCAL_PRESETS]
    for p in _data().get("providers", []):
        api = p.get("api") or ""
        if not api or "${" in api:
            continue
        rows.append({
            "id": p.get("id"), "name": p.get("name") or p.get("id"), "api": api,
            "model_count": len(p.get("models") or []), "local": False,
        })
    rows.sort(key=lambda r: (not r.get("local"), (r.get("name") or "").lower()))
    return rows


def prune(raw: dict) -> dict:
    """把 models.dev 的 api.json 裁剪成随包快照（只留 OpenAI 兼容提供方 + 能力字段）。"""
    out = []
    for pid, p in (raw or {}).items():
        if not isinstance(p, dict):
            continue
        api = p.get("api") or API_OVERRIDES.get(pid, "")
        npm = p.get("npm") or ""
        if not api or "${" in api:
            continue
        if npm not in COMPAT_NPM and pid not in API_OVERRIDES:
            continue
        ms = []
        for mid, m in (p.get("models") or {}).items():
            if not isinstance(m, dict):
                continue
            row = {"id": m.get("id") or mid, "name": m.get("name") or mid}
            for k in _MODEL_KEEP:
                if m.get(k) is not None:
                    row[k] = m[k]
            ms.append(row)
        ms.sort(key=lambda x: (x.get("name") or x["id"]).lower())
        out.append({
            "id": pid,
            "name": p.get("name") or pid,
            "api": api,
            "npm": npm,
            "env": p.get("env") or [],
            "models": ms,
        })
    out.sort(key=lambda x: (x.get("name") or "").lower())
    return {
        "source": "models.dev",
        "generated_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "providers": out,
    }


def refresh(url: str = SOURCE_URL, timeout: int = 90) -> dict:
    """联网更新目录，写到 data/catalog.json（不覆盖随包快照，删掉即可回退）。"""
    req = urllib.request.Request(url, headers={"User-Agent": "paper-companion"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        raw = json.loads(r.read().decode("utf-8"))
    snap = prune(raw)
    from . import db
    os.makedirs(db.DATA_DIR, exist_ok=True)
    path = os.path.join(db.DATA_DIR, "catalog.json")
    fd, tmp = tempfile.mkstemp(dir=db.DATA_DIR, suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(snap, f, ensure_ascii=False, separators=(",", ":"))
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)
    _reset()
    return {
        "ok": True,
        "providers": len(snap["providers"]),
        "models": sum(len(p["models"]) for p in snap["providers"]),
        "bytes": os.path.getsize(path),
    }
