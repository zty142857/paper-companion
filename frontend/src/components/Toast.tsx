import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, CheckCircle2, Info, X } from 'lucide-react'

type ToastKind = 'success' | 'error' | 'info'
interface ToastItem { id: number; kind: ToastKind; msg: string; leaving?: boolean }
interface ToastApi {
  success(msg: string): void
  error(msg: string): void
  info(msg: string): void
}

const ToastContext = createContext<ToastApi | null>(null)

const MAX_VISIBLE = 5
// error 停留更久：失败信息需要用户读清楚原因，而不是扫一眼就没了
const AUTO_MS: Record<ToastKind, number> = { success: 3500, info: 3500, error: 6000 }
// 退场动画时长，与 components.css 里 .toast.leaving 的过渡保持一致
const EXIT_MS = 180

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const nextId = useRef(1)
  // 每条 toast 的定时器集中管理：手动关闭/卸载时统一清理，避免幽灵回调
  const timers = useRef(new Map<number, number>())

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
    const tm = timers.current.get(id)
    if (tm != null) { window.clearTimeout(tm); timers.current.delete(id) }
  }, [])

  const dismiss = useCallback((id: number) => {
    // 两段式移除：先标记 leaving 播退场动画，动画结束才真正卸载
    const old = timers.current.get(id)
    if (old != null) window.clearTimeout(old)
    setToasts((ts) => ts.map((t) => (t.id === id ? { ...t, leaving: true } : t)))
    timers.current.set(id, window.setTimeout(() => remove(id), EXIT_MS))
  }, [remove])

  const push = useCallback((kind: ToastKind, msg: string) => {
    const id = nextId.current++
    // 超出上限直接挤掉最旧一条；被挤掉者的定时器稍后空转一次即自清理
    setToasts((ts) => [...ts, { id, kind, msg }].slice(-MAX_VISIBLE))
    timers.current.set(id, window.setTimeout(() => dismiss(id), AUTO_MS[kind]))
  }, [dismiss])

  const api = useMemo<ToastApi>(() => ({
    success: (msg) => push('success', msg),
    error: (msg) => push('error', msg),
    info: (msg) => push('info', msg),
  }), [push])

  useEffect(() => {
    const map = timers.current
    return () => { map.forEach((tm) => window.clearTimeout(tm)); map.clear() }
  }, [])

  return (
    <ToastContext.Provider value={api}>
      {children}
      {toasts.length > 0 && createPortal(
        <div className="toast-stack">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}${t.leaving ? ' leaving' : ''}`}
              role={t.kind === 'error' ? 'alert' : 'status'}>
              {t.kind === 'success' ? <CheckCircle2 size={16} />
                : t.kind === 'error' ? <AlertCircle size={16} /> : <Info size={16} />}
              <span className="toast-msg">{t.msg}</span>
              {/* 只有 error 给手动关闭：失败信息用户可能想留着对照，也可能想立刻清掉 */}
              {t.kind === 'error' && (
                <button className="toast-x" onClick={() => dismiss(t.id)} aria-label="关闭提示"><X size={14} /></button>
              )}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </ToastContext.Provider>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast 必须在 <ToastProvider> 内部使用：请确认组件树外层已包裹 ToastProvider')
  return ctx
}
