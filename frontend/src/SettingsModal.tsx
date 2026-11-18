import { useEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, Plus, RefreshCw, X, XCircle } from 'lucide-react'
import { api } from './api'
import type { ModelInfo, Provider, ProviderModelList, ProviderPreset, RouteConfig, Routes } from './api'
import Modal from './components/Modal'
import { Spinner } from './components/Loading'
import { useConfirm } from './components/ConfirmDialog'
import { useToast } from './components/Toast'

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

/** 测试/验证结果：pending 时画 Spinner，成败用 lucide 图标而不是 ✓/✗ 字符 */
interface TestState { ok: boolean; text: string; pending?: boolean }

function TestRes({ test }: { test: TestState }) {
  return (
    <div className={`test-res ${test.ok ? 'ok' : 'fail'}`}>
      {test.pending ? <Spinner size={14} /> : test.ok ? <CheckCircle2 size={16} /> : <XCircle size={16} />}
      <span>{test.text}</span>
    </div>
  )
}

/** Base URL 允许留空（保存时后端兜底），但填了就必须是 http(s) 地址，行内提示 */
function baseUrlError(v: string): string {
  const s = v.trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return 'Base URL 必须以 http:// 或 https:// 开头'
    return ''
  } catch {
    return 'Base URL 不是合法地址，例如 http://127.0.0.1:11434/v1'
  }
}

/** 自定义请求头必须是 JSON 对象；解析失败时把原因说清楚，而不是笼统报「格式不对」 */
function headersError(text: string): string {
  if (!text.trim()) return ''
  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return '请求头必须是 JSON 对象，例如 {"X-Api-Version": "2024-01-01"}'
    }
    return ''
  } catch (e: any) {
    return `请求头 JSON 解析失败：${e?.message || e}。需形如 {"Key": "Value"}`
  }
}

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
  } else if (!info || !info.known) {
    // 目录未收录 / 元数据接口失败时也给出手填档位，避免只能选「自动」
    for (const v of ['none', 'low', 'medium', 'high']) {
      out.push({ value: v, label: `${EFFORT_LABEL[v]}（未验证）` })
    }
  }
  if (current && !out.some((o) => o.value === current)) {
    out.push({ value: current, label: `${EFFORT_LABEL[current] || current}（当前值）` })
  }
  return out
}

function EffortSelect({ providerId, model, value, onChange, onProbing }: {
  providerId: string; model: string; value: string; onChange: (v: string) => void
  onProbing: (busy: boolean) => void
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
  const unknown = !loading && !!providerId && !!model && (!info || !info.known)
  const probeLevels = (info?.reasoning_options.find((o) => o.type === 'effort')?.values || [])
    .filter((v) => v !== 'none')

  const verify = async () => {
    if (!probeLevels.length) return
    setProbe({ key, text: '验证中…' })
    // 探测可能连发多个请求、耗时较长，上报 busy 让弹窗禁止误关
    onProbing(true)
    try {
      const r = await api.probeEfforts(providerId, model, probeLevels)
      const ok = r.results.filter((x) => x.ok).map((x) => EFFORT_LABEL[x.level] || x.level)
      const bad = r.results.filter((x) => !x.ok).map((x) => EFFORT_LABEL[x.level] || x.level)
      setProbe({ key, text: `可用：${ok.join(' / ') || '无'}${bad.length ? `；报错：${bad.join(' / ')}` : ''}` })
    } catch (e: any) {
      setProbe({ key, text: `验证失败：${e?.message || e}` })
    } finally { onProbing(false) }
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

function RouteRow({ purpose, route, providers, onChange, onTest, onProbing, test }: {
  purpose: 'default' | 'translate'
  route: RouteConfig
  providers: Provider[]
  onChange: (patch: Partial<RouteConfig>) => void
  onTest: () => void
  onProbing: (busy: boolean) => void
  test?: TestState
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
          onProbing={onProbing}
        />
        <button className="btn small" onClick={onTest}
          disabled={!route.provider_id || !route.model || test?.pending}>测试</button>
      </div>
      {test && <TestRes test={test} />}
    </div>
  )
}

function reasoningBadge(m: { reasoning_options: { type: string; values?: string[] }[] }) {
  const effort = m.reasoning_options.find((o) => o.type === 'effort')
  if (effort?.values?.length) return '思考：' + effort.values.map((v) => EFFORT_LABEL[v] || v).join('/')
  if (m.reasoning_options.some((o) => o.type === 'toggle')) return '思考：可开关'
  return ''
}

function ProvidersPanel({ providers, onReload, onError, onDirtyChange, onBusyChange, hidden }: {
  providers: Provider[]
  onReload: () => Promise<Provider[]>
  onError: (msg: string) => void
  /** 表单脏状态上报给父级：关闭弹窗时据此触发「放弃修改」守卫 */
  onDirtyChange: (dirty: boolean) => void
  /** 保存/测试/同步等请求进行中上报，父级据此禁止 Esc/遮罩误关 */
  onBusyChange: (busy: boolean) => void
  hidden?: boolean
}) {
  const confirm = useConfirm()
  const toast = useToast()
  const [selId, setSelId] = useState(providers[0]?.id || '')
  const [presets, setPresets] = useState<ProviderPreset[]>([])
  const [adding, setAdding] = useState(false)
  const [presetId, setPresetId] = useState('')
  const [name, setName] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [headersText, setHeadersText] = useState('')
  /** 表单基线：切到某个提供商时快照它的已保存值，用来判断 dirty */
  const [formBase, setFormBase] = useState<{ name: string; baseUrl: string; headersText: string } | null>(null)
  const [rows, setRows] = useState<ProviderModelList | null>(null)
  const [search, setSearch] = useState('')
  const [busy, setBusy] = useState('')
  const [test, setTest] = useState<TestState | null>(null)
  const [catalogMsg, setCatalogMsg] = useState('')
  // 校验错误只在碰过字段（blur/提交）后展示，避免边输入边报错打扰
  const [urlTouched, setUrlTouched] = useState(false)
  const [headersTouched, setHeadersTouched] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const pendingSave = useRef<{ id: string; ids: string[] } | null>(null)

  const cur = providers.find((p) => p.id === selId) || providers[0]

  useEffect(() => { api.providerPresets().then(setPresets).catch(() => {}) }, [])

  useEffect(() => {
    if (!selId && providers.length) setSelId(providers[0].id)
  }, [providers, selId])

  const resetForm = (p: Provider | undefined) => {
    const ht = p && Object.keys(p.headers).length ? JSON.stringify(p.headers, null, 2) : ''
    setName(p?.name || '')
    setBaseUrl(p?.base_url || '')
    setApiKey('')
    setHeadersText(ht)
    setFormBase(p ? { name: p.name, baseUrl: p.base_url, headersText: ht } : null)
    setTest(null)
    setSearch('')
    setUrlTouched(false)
    setHeadersTouched(false)
  }

  // 只在切换提供商时把表单重置成它的值（保存后重新拉列表不打断输入）
  useEffect(() => {
    resetForm(providers.find((x) => x.id === selId) || providers[0])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId])

  useEffect(() => {
    setRows(null)
    if (!cur?.id) return
    let alive = true
    const reqId = cur.id
    api.providerModels(reqId).then((r) => {
      if (alive && cur?.id === reqId) setRows(r)
    }).catch(() => {
      if (alive && cur?.id === reqId) setRows(null)
    })
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cur?.id])

  // 新建模式下填了任何内容就算脏；编辑模式下与基线逐字段比对（Key 留空=不修改，不算脏）
  const formDirty = adding
    ? !!(name.trim() || baseUrl.trim() || apiKey.trim())
    : !!formBase && (name !== formBase.name || baseUrl !== formBase.baseUrl
      || headersText !== formBase.headersText || !!apiKey)

  useEffect(() => { onDirtyChange(formDirty) }, [formDirty, onDirtyChange])
  useEffect(() => { onBusyChange(busy !== '') }, [busy, onBusyChange])

  const enabled = rows?.enabled || cur?.models.enabled || []
  const q = search.trim().toLowerCase()
  const filtered = useMemo(() => {
    const list = rows?.models || []
    if (!q) return list
    return list.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
  }, [rows, q])
  const allOn = filtered.length > 0 && filtered.every((m) => enabled.includes(m.id))

  const urlErr = baseUrlError(baseUrl)
  const headersErr = headersError(headersText)

  const scheduleSave = (ids: string[]) => {
    if (!cur) return
    pendingSave.current = { id: cur.id, ids }
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      const p = pendingSave.current
      pendingSave.current = null
      if (!p) return
      api.saveProviderModels(p.id, p.ids)
        .then(() => onReload())
        .catch((e) => onError(String(e?.message || e)))
    }, 400)
  }

  // 模型勾选是 400ms 防抖自动保存：卸载时把还在排队的最后一次立即发出去，不静默丢勾选
  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current)
    const p = pendingSave.current
    if (p) api.saveProviderModels(p.id, p.ids).catch(() => { /* 尽力而为 */ })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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

  /** 切换提供商也会重置表单：有未保存修改时先确认，不静默丢弃 */
  const selectProvider = async (id: string) => {
    if (id === selId && !adding) return
    if (formDirty) {
      const ok = await confirm({
        title: '放弃未保存的修改？',
        message: '切换提供商会丢弃当前表单里未保存的修改。',
        confirmText: '放弃修改',
        danger: true,
      })
      if (!ok) return
    }
    setAdding(false)
    if (id === selId) resetForm(providers.find((p) => p.id === id))
    else setSelId(id)
  }

  const enterAdding = () => {
    setAdding(true)
    onError('')
    // 新建从空白开始，避免把上一个提供商的值误存成新提供商
    setName(''); setBaseUrl(''); setApiKey(''); setHeadersText(''); setPresetId('')
    setUrlTouched(false); setHeadersTouched(false); setCatalogMsg('')
  }

  const cancelAdding = async () => {
    if (formDirty) {
      const ok = await confirm({
        title: '放弃新建提供商？',
        message: '已填写的内容尚未保存，取消后会丢失。',
        confirmText: '放弃',
        danger: true,
      })
      if (!ok) return
    }
    setAdding(false)
    resetForm(providers.find((p) => p.id === selId) || providers[0])
  }

  const saveProvider = async () => {
    if (!cur) return
    setUrlTouched(true)
    setHeadersTouched(true)
    // 行内校验不过就不发请求，错误提示就挂在对应字段下面
    if (baseUrlError(baseUrl) || headersError(headersText)) return
    const headers: Record<string, string> = headersText.trim() ? JSON.parse(headersText) : {}
    setBusy('save')
    try {
      await api.updateProvider(cur.id, { name, base_url: baseUrl, api_key: apiKey, headers })
      await onReload()
      setApiKey('')
      // 保存成功后把基线推到当前值，dirty 守卫随即解除
      setFormBase({ name, baseUrl, headersText })
      toast.success('提供商已保存')
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
      toast.info(`模型列表已更新：${r.models.length} 个模型`)
    } catch (e: any) {
      onError(String(e?.message || e))
    } finally { setBusy('') }
  }

  const runTest = async () => {
    if (!cur) return
    const model = enabled[0] || rows?.models[0]?.id || ''
    if (!model) {
      setTest({ ok: false, text: '先在下方「获取模型列表」并启用一个模型，再测试连接' })
      return
    }
    setBusy('test')
    setTest(null)
    try {
      const r = await api.testProvider(cur.id, {
        base_url: baseUrl, api_key: apiKey, model, purpose: 'default',
      })
      setTest(r.ok
        ? { ok: true, text: `连接成功 · ${r.model} · ${r.latency_ms} ms` }
        : { ok: false, text: `连接失败：${r.error || '未知错误'}` })
    } catch (e: any) {
      setTest({ ok: false, text: `连接失败：${e?.message || e}` })
    } finally { setBusy('') }
  }

  const remove = async () => {
    if (!cur) return
    const ok = await confirm({
      title: `删除提供商「${cur.name}」？`,
      message: '删除后不可恢复；正在使用它的任务路由需要重新配置。',
      confirmText: '删除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.deleteProvider(cur.id)
      const ps = await onReload()
      setSelId(ps[0]?.id || '')
      toast.success('提供商已删除')
    } catch (e: any) {
      onError(String(e?.message || e))
    }
  }

  const clearKey = async () => {
    if (!cur) return
    const ok = await confirm({
      title: '清除已保存的 API Key？',
      message: `将清除「${cur.name}」保存的密钥，之后调用需要重新填写。`,
      confirmText: '清除',
      danger: true,
    })
    if (!ok) return
    try {
      await api.updateProvider(cur.id, { clear_key: true })
      await onReload()
      toast.success('API Key 已清除')
    } catch (e: any) { onError(String(e?.message || e)) }
  }

  const pickPreset = (id: string) => {
    setPresetId(id)
    const p = presets.find((x) => x.id === id)
    if (p) { setName(p.name); setBaseUrl(p.api) }
  }

  const create = async () => {
    setUrlTouched(true)
    if (!name.trim() || !baseUrl.trim()) {
      onError('名称和 Base URL 都要填（选内置预设会自动填好）')
      return
    }
    if (baseUrlError(baseUrl)) return
    setBusy('add')
    try {
      const created = await api.addProvider({
        name: name.trim(), base_url: baseUrl.trim(), api_key: apiKey, catalog_id: presetId || null,
      })
      await onReload()
      setSelId(created.id)
      setAdding(false)
      setPresetId('')
      toast.success('提供商已添加')
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
        <button key={p.id} className={`provider-item ${p.id === cur?.id && !adding ? 'active' : ''}`}
          onClick={() => selectProvider(p.id)}>
          <span className="pi-name">{p.name}</span>
          <span className="pi-meta">
            {p.models.enabled.length ? `${p.models.enabled.length} 个模型` : '未获取模型'}
            {p.in_use.length ? ` · ${p.in_use.map((x) => PURPOSE_LABEL[x as 'default' | 'translate']).join('/')}在用` : ''}
          </span>
        </button>
      ))}
      <button className="btn small" onClick={enterAdding}><Plus size={16} />添加提供商</button>
      <button className="btn small" onClick={refreshCatalog} disabled={busy === 'catalog'}
        title="联网更新 models.dev 目录（写到本机 data/catalog.json）">
        {busy === 'catalog' ? <Spinner size={14} /> : <RefreshCw size={16} />}
        {busy === 'catalog' ? '更新中…' : '更新模型目录'}
      </button>
    </div>
  )

  if (adding) {
    return (
      <div className="provider-panel" hidden={hidden}>
        {side}
        <div className="provider-detail">
          <div className="detail-head"><b>添加提供商</b></div>
          <label>从内置目录选择（{presets.length || '200+'} 家 OpenAI 兼容服务）</label>
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
          <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
            onBlur={() => setUrlTouched(true)} placeholder="http://127.0.0.1:11434/v1" />
          {urlTouched && urlErr && <div className="field-err">{urlErr}</div>}
          <label>API Key（本地服务可留空）</label>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-...（可留空）" />
          <div className="row">
            <button className="btn" onClick={cancelAdding}>取消</button>
            <button className="btn primary" onClick={create} disabled={busy === 'add'}>
              {busy === 'add' ? '添加中…' : '添加'}
            </button>
          </div>
          {catalogMsg && <TestRes test={{ ok: true, text: catalogMsg }} />}
        </div>
      </div>
    )
  }

  return (
    <div className="provider-panel" hidden={hidden}>
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
            <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)}
              onBlur={() => setUrlTouched(true)} />
            {urlTouched && urlErr && <div className="field-err">{urlErr}</div>}
            <label>API Key（留空则不修改）</label>
            <div className="row-inline">
              <input value={apiKey} onChange={(e) => setApiKey(e.target.value)}
                placeholder={cur.has_key ? '••••••••（已设置）' : 'sk-...（本地服务可留空）'} />
              {cur.has_key && <button className="btn small" onClick={clearKey}>清除</button>}
            </div>
            <label>自定义请求头（JSON，可选）</label>
            <textarea value={headersText} onChange={(e) => setHeadersText(e.target.value)}
              onBlur={() => setHeadersTouched(true)}
              placeholder='{"X-Api-Version": "2024-01-01"}' rows={2} />
            {headersTouched && headersErr && <div className="field-err">{headersErr}</div>}
            <div className="row">
              <button className="btn" onClick={runTest} disabled={busy === 'test'}>
                {busy === 'test' ? '测试中…' : '测试连接'}
              </button>
              <button className="btn" onClick={sync} disabled={busy === 'sync'}>
                {busy === 'sync' ? '拉取中…' : '获取模型列表'}
              </button>
              <button className="btn danger" onClick={remove} disabled={busy !== ''}>删除</button>
              <button className="btn primary" onClick={saveProvider} disabled={busy === 'save'}>
                {busy === 'save' ? '保存中…' : '保存'}
              </button>
            </div>
            {test && <TestRes test={test} />}
            {catalogMsg && <TestRes test={{ ok: true, text: catalogMsg }} />}

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
  const confirm = useConfirm()
  const toast = useToast()
  const [tab, setTab] = useState<Tab>('routes')
  const [providers, setProviders] = useState<Provider[]>([])
  const [routes, setRoutes] = useState<Routes | null>(null)
  /** 路由的已保存基线：与当前编辑值比对得出 dirty，保存/加载后刷新 */
  const [savedRoutes, setSavedRoutes] = useState<Routes | null>(null)
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')
  const [saving, setSaving] = useState(false)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [testing, setTesting] = useState<Record<string, boolean>>({})
  const [providerDirty, setProviderDirty] = useState(false)
  const [providerBusy, setProviderBusy] = useState(false)
  const [probeCount, setProbeCount] = useState(0)

  // 守卫要在异步回调里读「此刻」的脏状态，state 闭包会过期，用 ref 同步最新值
  const routesRef = useRef<Routes | null>(null)
  const savedRef = useRef<Routes | null>(null)
  const providerDirtyRef = useRef(false)
  routesRef.current = routes
  savedRef.current = savedRoutes
  providerDirtyRef.current = providerDirty

  const routesDirty = !!routes && !!savedRoutes && JSON.stringify(routes) !== JSON.stringify(savedRoutes)
  const dirty = routesDirty || providerDirty
  const busy = saving || providerBusy || probeCount > 0 || !!testing.default || !!testing.translate

  const reload = async (): Promise<Provider[]> => {
    const ps = await api.providers()
    setProviders(ps)
    return ps
  }

  useEffect(() => {
    Promise.all([api.providers(), api.routes()])
      .then(([ps, rs]) => { setProviders(ps); setRoutes(rs); setSavedRoutes(rs) })
      .catch((e) => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [])

  const patchRoute = (purpose: 'default' | 'translate', patch: Partial<RouteConfig>) => {
    setRoutes((r) => (r ? { ...r, [purpose]: { ...r[purpose], ...patch } } : r))
  }

  const onProbing = (b: boolean) => setProbeCount((c) => Math.max(0, c + (b ? 1 : -1)))

  const runTest = async (purpose: 'default' | 'translate') => {
    if (!routes) return
    const r = routes[purpose]
    setTesting((t) => ({ ...t, [purpose]: true }))
    setTests((t) => ({ ...t, [purpose]: { ok: true, pending: true, text: '测试中…' } }))
    try {
      const res = await api.testProvider(r.provider_id, {
        model: r.model, effort: r.effort, purpose,
      })
      setTests((t) => ({
        ...t,
        [purpose]: res.ok
          ? { ok: true, text: `连接成功 · ${res.model} · ${res.latency_ms} ms` }
          : { ok: false, text: `连接失败：${res.error || '未知错误'}` },
      }))
    } catch (e: any) {
      setTests((t) => ({ ...t, [purpose]: { ok: false, text: `连接失败：${e?.message || e}` } }))
    } finally {
      setTesting((t) => ({ ...t, [purpose]: false }))
    }
  }

  /** Esc/遮罩/X/取消统一入口：有未保存修改先确认，确认放弃才真关 */
  const guardedClose = async () => {
    const r = routesRef.current
    const s = savedRef.current
    const routesUnsaved = !!r && !!s && JSON.stringify(r) !== JSON.stringify(s)
    if (routesUnsaved || providerDirtyRef.current) {
      const ok = await confirm({
        title: '有未保存的修改',
        message: '关闭后，未保存的模型分配与提供商表单修改将丢失。确定放弃吗？',
        confirmText: '放弃修改',
        danger: true,
      })
      if (!ok) return
    }
    onClose()
  }

  const save = async () => {
    if (!routes) return
    setSaving(true)
    setErr('')
    try {
      const r = await api.saveRoutes({ default: routes.default, translate: routes.translate })
      setRoutes(r)
      setSavedRoutes(r)
      // 立即同步 ref 基线：下面的守卫才不会把刚保存的路由误报成未保存
      routesRef.current = r
      savedRef.current = r
      toast.success('模型设置已保存')
      // 提供商表单可能还有未保存修改，保存路由后仍要过一遍守卫
      await guardedClose()
    } catch (e: any) {
      setErr(String(e?.message || e))
    } finally { setSaving(false) }
  }

  return (
    <Modal className="settings-modal" onClose={guardedClose} dismissable={!busy}>
      <div className="settings-head">
        <h2>模型设置</h2>
        <div className="settings-tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'routes'}
            className={tab === 'routes' ? 'active' : ''} onClick={() => setTab('routes')}>模型分配</button>
          <button role="tab" aria-selected={tab === 'providers'}
            className={tab === 'providers' ? 'active' : ''} onClick={() => setTab('providers')}>提供商</button>
        </div>
        {/* 自绘头部没有 Modal 标准 X，这里补一个，走同一个守卫入口 */}
        <button className="modal-x" onClick={guardedClose} disabled={busy}
          aria-label="关闭" title="关闭"><X size={16} /></button>
      </div>

      {loading && <div className="loading"><Spinner size={14} />加载中…</div>}
      {err && <div className="err">{err}</div>}

      {!loading && routes && (
        <div className="route-panel" hidden={tab !== 'routes'}>
          {(['default', 'translate'] as const).map((purpose) => (
            <RouteRow
              key={purpose}
              purpose={purpose}
              route={routes[purpose]}
              providers={providers}
              onChange={(patch) => patchRoute(purpose, patch)}
              onTest={() => runTest(purpose)}
              onProbing={onProbing}
              test={tests[purpose]}
            />
          ))}
          <div className="hint">
            两个用途各自独立：翻译可以挂本地小模型，其他任务仍走云端。改动后点「保存」生效。
            模型下拉里只出现「提供商」页勾选启用的模型。
          </div>
          <div className="row">
            {dirty && <span className="dirty-hint">有未保存的修改</span>}
            <button className="btn" onClick={guardedClose}>取消</button>
            <button className="btn primary" onClick={save} disabled={saving}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}

      {/* 提供商面板常驻挂载（hidden 切换），切 Tab 不再丢未保存的表单 */}
      {!loading && (
        <ProvidersPanel
          providers={providers}
          onReload={reload}
          onError={setErr}
          onDirtyChange={setProviderDirty}
          onBusyChange={setProviderBusy}
          hidden={tab !== 'providers'}
        />
      )}
      {!loading && tab === 'providers' && (
        <div className="row">
          <button className="btn" onClick={guardedClose}>关闭</button>
        </div>
      )}
    </Modal>
  )
}