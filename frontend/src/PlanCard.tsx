import { useState } from 'react'
import { api } from './api'
import type { ReadingPlan } from './api'

/** 阅读计划卡：展示计划并允许勾选调整（重点关注项 / 跳过项）后再应用。 */
export default function PlanCard({ pid, plan, onUpdate, onRegenerate, onClose, onConfirm }: {
  pid: string
  plan: ReadingPlan
  onUpdate: (p: ReadingPlan) => void
  onRegenerate: () => void
  onClose: () => void
  onConfirm?: () => void        // 用户点「按此计划进行」→ 触发后续自动生成
}) {
  const [focus, setFocus] = useState<string[]>(plan.focus ?? [])
  const [skip, setSkip] = useState<string[]>(plan.skip ?? [])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)

  const toggle = (arr: string[], set: (v: string[]) => void, v: string) =>
    set(arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])

  const apply = async () => {
    setBusy(true)
    const next = { ...plan, focus, skip }
    try {
      await api.savePlan(pid, next)
      onUpdate(next)
      setSaved(true)
      setTimeout(() => setSaved(false), 2000)
      onConfirm?.()
    } finally {
      setBusy(false)
    }
  }

  const depthLabel: Record<string, string> = {
    terminology_deep: '术语深度：多（逐条解释 + 白话）',
    normal: '术语深度：标准',
    light: '术语深度：少（跳过已懂/通用词）',
  }

  return (
    <div className="plancard">
      <div className="ph">
        <span className="ico">🧭</span>
        <span className="pt">阅读计划</span>
        <span className="badge">{plan.familiarity} · {plan.domain}</span>
        <button className="x" title="重新生成" onClick={onRegenerate}>↻</button>
        <button className="x" onClick={onClose}>✕</button>
      </div>
      <div className="pb">
        {plan.summary && <div className="psum">{plan.summary}</div>}
        <div className="prow"><b>重点关注</b><span className="hint">（勾选决定我强调哪些）</span></div>
        <div className="chips">
          {plan.focus.map((f) => (
            <button key={f} className={`chip${focus.includes(f) ? ' on' : ''}`}
              onClick={() => toggle(focus, setFocus, f)}>{focus.includes(f) ? '✓ ' : ''}{f}</button>
          ))}
        </div>
        {!!plan.skip.length && <>
          <div className="prow"><b>建议略读</b></div>
          <div className="chips">
            {plan.skip.map((s) => (
              <button key={s} className={`chip${skip.includes(s) ? ' on' : ''}`}
                onClick={() => toggle(skip, setSkip, s)}>{skip.includes(s) ? '✓ ' : ''}{s}</button>
            ))}
          </div>
        </>}
        <div className="pmeta">
          <div>{depthLabel[plan.term_depth] ?? plan.term_depth}</div>
          <div>摘要侧重：{plan.abstract_emphasis}</div>
        </div>
        {!!plan.suggestions.length && <ul className="psug">
          {plan.suggestions.map((s) => <li key={s}>{s}</li>)}
        </ul>}
        <div className="prow" style={{ justifyContent: 'flex-end', alignItems: 'center' }}>
          {saved && <span className="ok">✓ 已按此计划保存</span>}
          <button className="btn small primary" disabled={busy} onClick={apply}>
            {busy ? '保存中…' : '按此计划进行'}
          </button>
        </div>
      </div>
    </div>
  )
}
