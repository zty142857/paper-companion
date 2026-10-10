import { useEffect, useState } from 'react'
import { api } from './api'
import type { LlmSettings } from './api'

export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const [s, setS] = useState<Partial<LlmSettings>>({})
  const [saving, setSaving] = useState(false)
  const [err, setErr] = useState('')
  const [testing, setTesting] = useState(false)
  const [testRes, setTestRes] = useState<{ ok: boolean; text: string } | null>(null)
  useEffect(() => { api.settings().then(setS).catch((e) => setErr(String(e))) }, [])
  const save = async () => {
    setSaving(true); setErr('')
    try { await api.saveSettings(s); onClose() }
    catch (e: any) { setErr(String(e?.message || e)) }
    finally { setSaving(false) }
  }
  // 用表单当前值测一次最小调用（掩码/留空的 Key 由后端回落到已保存值），不必先保存
  const test = async () => {
    if (testing) return
    setTesting(true); setTestRes(null); setErr('')
    try {
      const r = await api.testSettings({ base_url: s.base_url, api_key: s.api_key, model: s.model })
      setTestRes(r.ok
        ? { ok: true, text: `✓ 连接成功 · ${r.model} · ${r.latency_ms} ms` }
        : { ok: false, text: `✗ 连接失败：${r.error || '未知错误'}` })
    }
    catch (e: any) { setTestRes({ ok: false, text: `✗ 连接失败：${e?.message || e}` }) }
    finally { setTesting(false) }
  }
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <h2>模型设置</h2>
        <label>Base URL（OpenAI 兼容）</label>
        <input value={s.base_url ?? ''} placeholder="https://dashscope.aliyuncs.com/compatible-mode/v1"
          onChange={(e) => setS({ ...s, base_url: e.target.value })} />
        <label>API Key（留空则不修改）</label>
        <input value={s.api_key ?? ''} placeholder={s.has_key ? '••••••••（已设置）' : 'sk-...'}
          onChange={(e) => setS({ ...s, api_key: e.target.value })} />
        <label>模型名</label>
        <input value={s.model ?? ''} placeholder="qwen3.8-flash"
          onChange={(e) => setS({ ...s, model: e.target.value })} />
        <label>思考强度（影响延迟与质量）</label>
        <select value={s.effort ?? 'medium'} onChange={(e) => setS({ ...s, effort: e.target.value })}>
          <option value="none">关闭</option>
          <option value="low">低（快）</option>
          <option value="medium">中（推荐）</option>
          <option value="high">高（慢、更稳）</option>
        </select>
        {err && <div className="err">{err}</div>}
        {testRes && <div className={`test-res ${testRes.ok ? 'ok' : 'fail'}`}>{testRes.text}</div>}
        <div className="row">
          <button className="btn" onClick={onClose}>取消</button>
          <button className="btn" onClick={test} disabled={testing}
            title="用当前填写的值发一次最小调用，验证地址/Key/模型名是否可用（无需先保存）">
            {testing ? '测试中…' : '测试连接'}</button>
          <button className="btn primary" onClick={save} disabled={saving}>{saving ? '保存中…' : '保存'}</button>
        </div>
      </div>
    </div>
  )
}
