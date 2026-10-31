import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { ModelInfo, Provider, ProviderModelList, ProviderPreset, RouteConfig, Routes } from './api'

const EFFORT_LABEL: Record<string, string> = {
  none: '关闭', minimal: '极低', low: '低', medium: '中',
  high: '高', xhigh: '超高', max: '最高', on: '开启',
}

const PURPOSE_LABEL: Record<'default' | 'translate', string> = {
  default: '其他任务',
  translate: '翻译',
}

const PURPOSE_HINT: Record<'default' | 'translate', string> = {
  default: '导读 / 章节概要 / 问答 / 术语 / 自测 / 推荐 / 综述',
  translate: '只看「翻译」这一个功能，适合挂本地小模型',
}

type Tab = 'routes' | 'providers'

/** 按模型元数据生成思考强度选项；未收录时退化到通用四档并标注未验证。 */
function effortChoices(info: ModelInfo | null, current: string) {
  const out: { value: string; label: string }[] = [{ value: '', label: '自动（不发送参数）' }]
  const opts = info?.reasoning_options || []
  const toggle = opts.some((o) => o.type === 'toggle')
  const effort = opts.find((o) => o.type === 'effort')
  const values = effort?.values || []
  if (values.length) {
    for (const v of values) {
      if (v !== 'none') out.push({ value: v, label: EFFORT_LABEL[v] || v })
    }
    if (values.includes('none')) out.push({ value: 'none', label: '关闭（none）' })
    else if (toggle) out.push({ value: 'none', label: '关闭思考' })
  } else if (toggle) {
    out.push({ value: 'on', label: '开启思考' })
    out.push({ value: 'none', label: '关闭思考' })
  } else if (info && !info.known) {
    for (const v of ['none', 'low', 'medium', 'high']) {
      out.push({ value: v, label: `${EFFORT_LABEL[v]}（未验证）` })
    }
  }
  if (current && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: `${EFFORT_LABEL[current] || current}（当前值）` })
  }
  return out
}

function EffortSelect({ providerId, model, value, onChange }: {
  providerId: string; model: string; value: string; onChange: (v: string) => void
}) {
  const key = `${providerId}:${model}`
  const [loaded, setLoaded] = useState<{ key: string; info: ModelInfo | null } | null>(null)
  const [probe, setProbe] = useState<{ key: string; text: string } | null>(null)
  useEffect(() => {
    let alive = true
    if (!providerId || !model) return
    api.modelInfo(providerId, model)
      .then((r) => { if (alive) setLoaded({ key, info: r }) })
      .catch(() => { if (alive) setLoaded({ key, info: null }) })
    return () => { alive = false }
  }, [providerId, model, key])
  // 用 key 对齐：换了模型但新数据还没到时，不展示上一个模型的档位
  const info = loaded?.key === key ? loaded.info : null
  const loading = !!providerId && !!model && loaded?.key !== key
  const probeText = probe?.key === key ? probe.text : ''
  const choices = effortChoices(info, value)
  const unknown = info && !info.known
  const probeLevels = (info?.reasoning_options.find((o) => o.type === 'effort')?.values || [])
    .filter((v) => v !== 'none')

  const verify = async () => {
    if (!probeLevels.length) return
    setProbe({ key, text: '验证中…' })
    try {
      const r = await api.probeEfforts(providerId, model, probeLevels)
      const ok = r.results.filter((x) => x.ok).map((x) => EFFORT_LABEL[x.level] || x.level)
      const bad = r.results.filter((x) => !x.ok).map((x) => EFFORT_LABEL[x.level] || x.level)
      setProbe({ key, text: `可用：${ok.join(' / ') || '无'}${bad.length ? `；报错：${bad.join(' / ')}` : ''}` })
    } catch (e: any) {
      setProbe({ key, text: `验证失败：${e?.message || e}` })
    }
  }

  return (
    <div className="effort-cell">
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={loading}>
        {choices.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {unknown && <span className="hint-tiny">目录未收录，档位未验证</span>}
      {info?.limit?.context ? (
        <span className="hint-tiny">上下文 {Math.round(info.limit.context / 1000)}K</span>
      ) : null}
      {probeLevels.length > 0 && (
        <button className="link-btn" onClick={verify} title="逐个档位发一次极短请求，只证明服务商不报错">验证档位</button>
      )}
      {probeText && <span className="hint-tiny">{probeText}</span>}
    </div>
  )
}

function RouteRow({ purpose, route, providers, onChange, onTest, test }: {
  purpose: 'default' | 'translate'
  route: RouteConfig
  providers: Provider[]
  onChange: (patch: Partial<RouteConfig>) => void
  onTest: () => void
  test?: { ok: boolean; text: string }
}) {
  const provider = providers.find((p) => p.id === route.provider_id)
  const enabled = provider?.models.enabled || []
  // 当前路由里的模型即使还没进启用清单也要显示出来，否则下拉会假装没选
  const models = route.model && !enabled.includes(route.model) ? [route.model, ...enabled] : enabled
  return (
    <div className="route-row">
      <div className="route-head">
        <b>{PURPOSE_LABEL[purpose]}</b>
        <span className="hint-tiny">{PURPOSE_HINT[purpose]}</span>
      </div>
      <div className="route-grid">
        <select
          value={route.provider_id}
          onChange={(e) => {
            const p = providers.find((x) => x.id === e.target.value)
            onChange({ provider_id: e.target.value, model: p?.models.enabled[0] || '' })
          }}
        >
          {providers.length === 0 && <option value="">（还没有提供商）</option>}
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <div className="model-cell">
          <input list={`route-models-${purpose}`} value={route.model}
            onChange={(e) => onChange({ model: e.target.value })}
            placeholder={models.length ? '选择或输入模型名' : '直接输入模型名，如 qwen2.5:7b'} />
          <datalist id={`route-models-${purpose}`}>
            {models.map((m) => <option key={m} value={m} />)}
          </datalist>
          {models.length === 0 && <span className="hint-tiny">还没启用模型，可手填或去「提供商」获取列表</span>}
        </div>
        <EffortSelect
          providerId={route.provider_id}
          model={route.model}
          value={route.effort}
          onChange={(v) => onChange({ effort: v })}
        />
        <button className="btn small" onClick={onTest} disabled={!route.provider_id || !route.model}>测试</button>
      </div>
      {test && <div className={`test-res ${test.ok ? 'ok' : 'fail'}`}>{test.text}</div>}
    </div>
  )
}

function reasoningBadge(m: { reasoning_options: { type: string; values?: string[] }[] }) {
  const effort = m.reasoning_options.find((o) => o.type === 'effort')
  if (effort?.values?.length) return '思考：' + effort.values.map((v) => EFFORT_LABEL[v] || v).join('/')
  if (m.reasoning_options.some((o) => o.type === 'toggle')) return '思考：可开关'
  return ''
}

function ProvidersPanel({ providers, onReload, onError }: {
  providers: Provider[]
  onReload: () => Promise<Provider[]>
  onError: (msg: string) => void
}) {
  const [selId, setSelId] = useState(providers[0]?.id || '')
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [adding, setAdding] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [headersText, setHeadersText] = useState('')
  const [rows, setRows] = useState<ProviderModelList | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null)
  const [catalogMsg, setCatalogMsg] = useState('')
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const cur = providers.find((p) => p.id === selId) || providers[0]

  useEffect(() => { api.providerPresets().then(setPresets).catch(() => {}) }, [])

  useEffect(() => {
    if (!selId && providers.length) setSelId(providers[0].id)
  }, [providers, selId])

  // 只在切换提供商时把表单重置成它的值（保存后重新拉列表不打断输入）
  useEffect(() => {
    const p = providers.find((x) => x.id === selId) || providers[0]
    if (!p) return
    setName(p.name)
    setBaseUrl(p.base_url)
    setApiKey('')
    setHeadersText(Object.keys(p.headers).length ? JSON.stringify(p.headers, null, 2) : '')
    setTest(null)
    setSearch('')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId])

  useEffect(() => {
    setRows(null)
    if (!cur?.id) return
    api.providerModels(cur.id).then(setRows).catch(() => setRows(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id])

  const enabled = rows?.enabled || cur?.models.enabled || []
  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    const list = rows?.models || []
    if (!q) return list
    return list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }, [rows, q])
  const allOn = filtered.length > 0 && filtered.every((m) => enabled.includes(m.id))

  const scheduleSave = (ids: string[]) => {
    if (!cur) return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      api.saveProviderModels(cur.id, ids)
        .then(() => onReload())
        .catch((e) => onError(String(e?.message || e)))
    }, 400)
  }

  const toggleOne = (mid: string, on: boolean) => {
    const next = on ? [...enabled, mid] : enabled.filter((x) => x !== mid)
    setRows((r) => (r ? { ...r, enabled: next } : r))
    scheduleSave(next)
  }

  const toggleAll = () => {
    const set = new Set(enabled)
    if (allOn) filtered.forEach((m) => set.delete(m.id))
    else filtered.forEach((m) => set.add(m.id))
    const next = [...set]
    setRows((r) => (r ? { ...r, enabled: next } : r))
    scheduleSave(next)
  }

  const saveProvider = async () => {
    if (!cur) return
    let headers: Record<string, string> = {}
    if (headersText.trim()) {
      try {
        const parsed = JSON.parse(headersText)
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not object')
        headers = parsed
      } catch {
        onError('自定义请求头必须是 JSON 对象，例如 {"X-Api-Version": "2024-01-01"}')
        return
      }
    }
    setBusy('save')
    try {
      await api.updateProvider(cur.id, { name, base_url: baseUrl, api_key: apiKey, headers })
      await onReload()
      setApiKey('')
    } catch (e: any) {
      onError(String(e?.message || e))
    } finally { setBusy('') }
  }

  const sync = async () => {
    if (!cur) return
    setBusy('sync')
    onError('')
    try {
      const r = await api.syncProviderModels(cur.id)
      setRows(r)
      await onReload()
    } catch (e: any) {
      onError(String(e?.message || e))
    } finally { setBusy('') }
  }

  const runTest = async () => {
    if (!cur) return
    const model = enabled[0] || rows?.models[0]?.id || ''
    if (!model) {
      setTest({ ok: false, text: '✗ 先在下方「获取模型列表」并启用一个模型，再测试连接' })
      return
    }
    setBusy('test')
    setTest(null)
    try {
      const r = await api.testProvider(cur.id, {
        base_url: baseUrl, api_key: apiKey, model, purpose: 'default',
      })
      setTest(r.ok
        ? { ok: true, text: `✓ 连接成功 · ${r.model} · ${r.latency_ms} ms` }
        : { ok: false, text: `✗ 连接失败：${r.error || '未知错误'}` })
    } catch (e: any) {
      setTest({ ok: false, text: `✗ 连接失败：${e?.message || e}` })
    } finally { setBusy('') }
  }

  const remove = async () => {
    if (!cur) return
    if (!window.confirm(`删除提供商「${cur.name}」？`)) return
    try {
      await api.deleteProvider(cur.id)
      const ps = await onReload()
      setSelId(ps[0]?.id || '')
    } catch (e: any) {
      onError(String(e?.message || e))
    }
  }

  const clearKey = async () => {
    if (!cur || !window.confirm('清除这个提供商保存的 API Key？')) return
    try {
      await api.updateProvider(cur.id, { clear_key: true })
      await onReload()
    } catch (e: any) { onError(String(e?.message || e)) }
  }

  const pickPreset = (id: string) => {
    setPresetId(id)
    const p = presets.find((x) => x.id === id)
    if (p) { setName(p.name); setBaseUrl(p.api) }
  }

  const create = async () => {
    if (!name.trim() || !baseUrl.trim()) {
      onError('名称和 Base URL 都要填（选内置预设会自动填好）')
      return
    }
    setBusy('add')
    try {
      const created = await api.addProvider({
        name: name.trim(), base_url: baseUrl.trim(), api_key: apiKey, catalog_id: presetId || null,
      })
      await onReload()
      setSelId(created.id)
      setAdding(false)
      setPresetId('')
    } catch (e: any) {
      onError(String(e?.message || e))
    } finally { setBusy('') }
  }

  const refreshCatalog = async () => {
    setBusy('catalog')
    onError('')
    try {
      const r = await api.refreshCatalog()
      setCatalogMsg(`已更新：${r.providers} 家 / ${r.models} 个模型`)
      setPresets(await api.providerPresets())
    } catch (e: any) {
      onError(String(e?.message || e))
    } finally { setBusy('') }
  }

  const side = (
    <div className="provider-side">
      {providers.map((p) => (
        <button key={p.id} className={`provider-item ${p.id === cur?.id ? 'active' : ''}`}
          onClick={() => setSelId(p.id)}>
          <span className="pi-name">{p.name}</span>
          <span className="pi-meta">
            {p.models.enabled.length ? `${p.models.enabled.length} 个模型` : '未获取模型'}
            {p.in_use.length ? ` · ${p.in_use.map((x) => PURPOSE_LABEL[x as 'default' | 'translate']).join('/')}在用` : ''}
          </span>
        </button>
      ))}
      <button className="btn small" onClick={() => { setAdding(true); onError('') }}>＋ 添加提供商</button>
      <button className="btn small" onClick={refreshCatalog} disabled={busy === 'catalog'}
        title="联网更新 models.dev 目录（写到本机 data/catalog.json）">
        {busy === 'catalog' ? '更新中…' : '更新模型目录'}
      </button>
    </div>
  )

  if (adding) {
    return (
      <div className="provider-panel">
        {side}
        <div className="provider-detail">
          <div className="detail-head"><b>添加提供商</b></div>
          <label>从内置目录选择（205 家 OpenAI 兼容服务）</label>
          <select value={presetId} onChange={(e) => pickPreset(e.target.value)}>
            <option value="">自定义（手动填写地址）</option>
            <optgroup label="本地服务">
              {presets.filter((p) => p.local).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </optgroup>
            <optgroup label="云端服务">
              {presets.filter((p) => !p.local).map((p) => (
                <option key={p.id} value={p.id}>{p.name}（{p.model_count} 个模型）</option>
              ))}
            </optgroup>
          </select>
          <label>名称</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如：本地 Ollama" />
          <label>Base URL（需要以 /v1 结尾，除非服务商另有说明）</label>
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="http://127.0.0.1:11434/v1" />
          <label>API Key（本地服务可留空）</label>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-...（可留空）" />
          <div className="row">
            <button className="btn" onClick={() => setAdding(false)}>取消</button>
            <button className="btn primary" onClick={create} disabled={busy === 'add'}>
              {busy === 'add' ? '添加中…' : '添加'}
            </button>
          </div>
          {catalogMsg && <div className="test-res ok">{catalogMsg}</div>}
        </div>
      </div>
    )
  }

  return (
    <div className="provider-panel">
      {side}
      <div className="provider-detail">
        {!cur ? <div className="empty">还没有提供商，点左侧「添加提供商」。</div> : (
          <>
            <div className="detail-head">
              <b>{cur.name}</b>
              {cur.catalog_name && cur.catalog_name !== cur.name && <span className="hint-tiny">目录：{cur.catalog_name}</span>}
            </div>
            <label>名称</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
            <label>Base URL</label>
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
            <label>API Key（留空则不修改）</label>
            <div className="row-inline">
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={cur.has_key ? '••••••••（已设置）' : 'sk-...（本地服务可留空）'} />
              {cur.has_key && <button className="btn small" onClick={clearKey}>清除</button>}
            </div>
            <label>自定义请求头（JSON，可选）</label>
            <textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)}
              placeholder='{"X-Api-Version": "2024-01-01"}' rows={2} />
            <div className="row">
              <button className="btn" onClick={runTest} disabled={busy === 'test'}>
                {busy === 'test' ? '测试中…' : '测试连接'}
              </button>
              <button className="btn" onClick={sync} disabled={busy === 'sync'}>
                {busy === 'sync' ? '拉取中…' : '获取模型列表'}
              </button>
              <button className="btn danger" onClick={remove}>删除</button>
              <button className="btn primary" onClick={saveProvider} disabled={busy === 'save'}>
                {busy === 'save' ? '保存中…' : '保存'}
              </button>
            </div>
            {test && <div className={`test-res ${test.ok ? 'ok' : 'fail'}`}>{test.text}</div>}
            {catalogMsg && <div className="test-res ok">{catalogMsg}</div>}

            <div className="model-block">
              <div className="model-toolbar">
                <b>模型（已启用 {enabled.length} / {rows?.models.length ?? cur.models.available}）</b>
                {rows?.source === 'api' && <span className="hint-tiny">来源：实时接口</span>}
                {rows?.source === 'catalog' && <span className="hint-tiny">来源：内置目录</span>}
              </div>
              {rows?.error && (
                <div className="hint-warn">
                  实时拉取失败：{rows.error}。
                  {rows.models.length ? '已回落到内置目录，也可手填模型名。' : '可以稍后重试，或直接在「模型分配」里手填模型名。'}
                </div>
              )}
              <div className="row-inline">
                <input value={search} onChange={(e) => setSearch(e.target.value)}
                  placeholder={`搜索模型（共 ${rows?.models.length ?? 0} 个）…`} />
                <button className="btn small" onClick={toggleAll} disabled={!filtered.length}>
                  {allOn ? `全不选（${filtered.length}）` : `全选（${filtered.length}）`}
                </button>
              </div>
              <div className="model-list">
                {filtered.length === 0 && (
                  <div className="empty">
                    {rows?.models.length ? '没有匹配的模型。' : '还没有模型列表，点上面「获取模型列表」。'}
                  </div>
                )}
                {filtered.map((m) => (
                  <label key={m.id} className="model-row">
                    <input type="checkbox" checked={enabled.includes(m.id)}
                      onChange={(e) => toggleOne(m.id, e.target.checked)} />
                    <span className="mid">{m.id}</span>
                    <span className="mmeta">
                      {reasoningBadge(m)}{m.context ? ` · ${Math.round(m.context / 1000)}K` : ''}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>('routes')
  const [providers, setProviders] = useState<Provider[]>([])
  const [routes, setRoutes] = useState<Routes | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [tests, setTests] = useState<Record<string, { ok: boolean; text: string }>>({})

  const reload = async (): Promise<Provider[]> => {
    const ps = await api.providers()
    setProviders(ps)
    return ps
  }

  useEffect(() => {
    Promise.all([api.providers(), api.routes()])
      .then(([ps, rs]) => { setProviders(ps); setRoutes(rs) })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [])

  const patchRoute = (purpose: 'default' | 'translate', patch: Partial<RouteConfig>) => {
    setRoutes((r) => (r ? { ...r, [purpose]: { ...r[purpose], ...patch } } : r))
  }

  const runTest = async (purpose: 'default' | 'translate') => {
    if (!routes) return
    const r = routes[purpose]
    setTests((t) => ({ ...t, [purpose]: { ok: true, text: '测试中…' } }))
    try {
      const res = await api.testProvider(r.provider_id, {
        model: r.model, effort: r.effort, purpose,
      })
      setTests((t) => ({
        ...t,
        [purpose]: res.ok
          ? { ok: true, text: `✓ 连接成功 · ${res.model} · ${res.latency_ms} ms` }
          : { ok: false, text: `✗ 连接失败：${res.error || '未知错误'}` },
      }))
    } catch (e: any) {
      setTests((t) => ({ ...t, [purpose]: { ok: false, text: `✗ 连接失败：${e?.message || e}` } }))
    }
  }

  const save = async () => {
    if (!routes) return
    setSaving(true)
    setErr('')
    try {
      const r = await api.saveRoutes({ default: routes.default, translate: routes.translate })
      setRoutes(r)
      onClose()
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally { setSaving(false) }
  }

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal settings-modal" onClick={(e) => e.stopPropagation()}>
        <div className="settings-head">
          <h2>模型设置</h2>
          <div className="settings-tabs">
            <button className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')}>模型分配</button>
            <button className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>提供商</button>
          </div>
        </div>

        {loading && <div className="loading">加载中…</div>}
        {err && <div className="err">{err}</div>}

        {!loading && tab === 'routes' && routes && (
          <>
            <div className="route-panel">
              {(['default', 'translate'] as const).map((purpose) => (
                <RouteRow
                  key={purpose}
                  purpose={purpose}
                  route={routes[purpose]}
                  providers={providers}
                  onChange={(patch) => patchRoute(purpose, patch)}
                  onTest={() => runTest(purpose)}
                  test={tests[purpose]}
                />
              ))}
            </div>
            <div className="hint">
              两个用途各自独立：翻译可以挂本地小模型，其他任务仍走云端。改动后点「保存」生效。
              模型下拉里只出现「提供商」页勾选启用的模型。
            </div>
            <div className="row">
              <button className="btn" onClick={onClose}>取消</button>
              <button className="btn primary" onClick={save} disabled={saving}>
                {saving ? '保存中…' : '保存'}
              </button>
            </div>
          </>
        )}

        {!loading && tab === 'providers' && (
          <>
            <ProvidersPanel providers={providers} onReload={reload} onError={setErr} />
            <div className="row">
              <button className="btn" onClick={onClose}>关闭</button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
