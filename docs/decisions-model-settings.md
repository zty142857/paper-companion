# 模型设置改造决策记录

主题：多提供商管理、模型列表获取、思考强度识别（2026-10）
状态：已实施

## 结论与理由

| # | 结论 | 理由 |
|---|---|---|
| 1 | 提供商多份并存（`provider` 表），不再是一套全局配置 | 本地模型做翻译 + 云端模型做其他任务，必须两套配置同时生效 |
| 2 | 路由只分两桶：`translate`（仅段落翻译）/ `default`（其余全部） | 本地小模型只够翻译；按功能细分会让每个调用点都带上下文，成本高收益低 |
| 3 | 两个桶各自保存 provider + model + effort，互不回落 | 同一提供商下也可能给翻译选更小的模型；空桶明确报错，避免弱模型悄悄拉低导读/自测质量 |
| 4 | 模型列表 = models.dev 快照（离线）+ `/v1/models` 实时合并 + 手填兜底 | 既要能力元数据，又要真实可用性；拉取失败不阻断用户 |
| 5 | 拉取结果进入「启用清单」，支持搜索 + 全选（当前筛选范围） | 中转站常返回几百个含 embed/rerank/语音的模型，平铺进下拉不可用 |
| 6 | 思考强度按模型元数据 `reasoning_options` 动态渲染，允许手动覆盖，调用失败自动降级 | 各模型档位差异大（toggle / low·high·max / none·minimal…），写死四档是错的 |
| 7 | 探测只做手动「验证」，不自动全量探测 | 多数 OpenAI 兼容服务对不认识的参数静默忽略，探测只能证明「不报错」；自动探测慢且易限流 |
| 8 | 只支持 OpenAI 兼容协议，本地服务允许空 Key | Ollama / LM Studio / vLLM 都自带兼容层；原生 Anthropic/Gemini 要维护两套客户端与能力映射，收益不抵成本 |
| 9 | 旧配置自动迁移成一个提供商，两桶都指向它 | 不打断已有用户；旧 `setting` key 保留不删，便于回滚 |

## 实施要点

- `backend/app/model_catalog.py`：快照加载、`base_url` 归一化匹配（忽略协议 / `www.` / 结尾 `/v1`）、模型元数据查询、手动联网刷新到 `data/catalog.json`。
- `packaging/build_model_catalog.py`：从 `https://models.dev/api.json` 生成裁剪快照，当前 202 家 / 7005 个模型 / 2.2 MB，随包分发。
- `backend/app/llm.py`：`get_route(purpose)` 解析路由；`reasoning_kwargs()` 负责 DashScope / `reasoning_effort` / 空值三档适配；能力缓存按 provider 隔离（修掉原先进程级单例跨提供商串味的问题）。
- `backend/app/main.py`：`/api/providers*`、`/api/routes`、`/api/model-info`、`/api/settings/probe-efforts`、`/api/catalog/refresh`；`LLMNotConfigured` 统一转 400。
- `frontend/src/SettingsModal.tsx`：两个 Tab（模型分配 / 提供商），模型搜索 + 全选，思考强度随模型动态变化。

## 顺带修掉的既有问题

1. `_NO_JSON_MODE` 进程级单例 → 按提供商隔离，避免 A 家拒绝 `response_format` 连带废掉 B 家。
2. 「一键清除全部数据」只清 `setting.llm_api_key` → 现在同时清空所有 `provider.api_key`。
3. 连通性自检强制关闭思考 → 现在按用户选中的强度测，并且空 Key 的本地服务可以正常调用。

## 未做 / 后续可选

- 按功能细分路由（导读、自测分别指定模型）。
- 原生 Anthropic / Gemini 协议。
- 目录定时自动刷新（目前只有手动按钮）。
- 模型价格估算与用量统计。
