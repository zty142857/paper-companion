import { useState } from 'react'
import { Check, Compass, RefreshCw, X } from 'lucide-react'
import { api } from './api'
import type { ReadingPlan } from './api'
import { useToast } from './components/Toast'

/** 阅读计划卡：展示计划并允许勾选调整（重点关注项 / 跳过项）后再应用。 */
export default function PlanCard({ pid, plan, onUpdate, onRegenerate, onClose, onConfirm }: {
  pid: string
  plan: ReadingPlan
  onUpdate: (p: ReadingPlan) => void
  onRegenerate: () => void
  onClose: () => void
  onConfirm?: () => void        // 用户点「按此计划进行」→ 触发后续自动生成
}) {
  const toast = useToast()
  const [focus, setFocus] = useState<string[]>(plan.focus ?? [])
  const [skip, setSkip] = useState<string[]>(plan.skip ?? [])
  const [busy, setBusy] = useState(false)
  const [saved, setSaved] = useState(false)
  const focusItems = Array.isArray(plan.focus) ? plan.focus : []
  const skipItems = Array.isArray(plan.skip) ? plan.skip : []
  const suggestions = Array.isArray(plan.suggestions) ? plan.suggestions : []

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
    } catch (e: any) {
      // 保存失败不能静默：原来只有 finally，异常会直接冒泡成未处理拒绝
      toast.error(`计划保存失败：${e?.message || e}`)
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
        <span className="ico"><Compass size={16} strokeWidth={2} /></span>
        <span className="pt">阅读计划</span>
        <span className="badge">{plan.familiarity} · {plan.domain}</span>
        <button className="x" title="重新生成" onClick={onRegenerate}>
          <span className="ico"><RefreshCw size={14} strokeWidth={2} /></span>
        </button>
        <button className="x" title="关闭" onClick={onClose}>
          <span className="ico"><X size={14} strokeWidth={2} /></span>
        </button>
      </div>
      <div className="pb">
        {typeof plan.summary === 'string' && plan.summary && <div className="psum">{plan.summary}</div>}
        <div className="prow"><b>重点关注</b><span className="hint">（勾选决定我强调哪些）</span></div>
        <div className="chips">
          {focusItems.map((f) => (
            <button key={f} className={`chip${focus.includes(f) ? ' on' : ''}`}
              onClick={() => toggle(focus, setFocus, f)}>
              {focus.includes(f) && <span className="ico"><Check size={12} strokeWidth={2} /></span>}{f}
            </button>
          ))}
        </div>
        {!!skipItems.length && <>
          <div className="prow"><b>建议略读</b></div>
          <div className="chips">
            {skipItems.map((s) => (
              <button key={s} className={`chip${skip.includes(s) ? ' on' : ''}`}
                onClick={() => toggle(skip, setSkip, s)}>
                {skip.includes(s) && <span className="ico"><Check size={12} strokeWidth={2} /></span>}{s}
              </button>
            ))}
          </div>
        </>}
        <div className="pmeta">
          <div>{typeof plan.term_depth === 'string'
            ? (depthLabel[plan.term_depth] ?? plan.term_depth) : ''}</div>
          <div>摘要侧重：{typeof plan.abstract_emphasis === 'string' ? plan.abstract_emphasis : ''}</div>
        </div>
        {!!suggestions.length && <ul className="psug">
          {suggestions.map((s) => <li key={s}>{s}</li>)}
        </ul>}
        <div className="prow end">
          {saved && <span className="ok"><span className="ico"><Check size={12} strokeWidth={2} /></span>已按此计划保存</span>}
          <button className="btn small primary" disabled={busy} onClick={apply}>
            {busy ? '保存中…' : '按此计划进行'}
          </button>
        </div>
      </div>
    </div>
  )
}