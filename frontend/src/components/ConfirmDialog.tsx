import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import Modal from './Modal'

interface ConfirmOptions {
  title: string
  message?: ReactNode
  confirmText?: string
  cancelText?: string
  danger?: boolean         // true 时确认按钮用全局 .btn.danger（删除类操作）
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<ConfirmFn | null>(null)

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null)
  const resolver = useRef<((ok: boolean) => void) | null>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)

  const confirm = useCallback<ConfirmFn>((next) => new Promise<boolean>((resolve) => {
    // 同一时刻只挂一个确认框：新请求直接替换旧的，旧的按"取消"了结，
    // 否则旧 Promise 永远悬挂，调用方的 await 会卡死
    resolver.current?.(false)
    resolver.current = resolve
    setOpts(next)
  }), [])

  const done = useCallback((ok: boolean) => {
    resolver.current?.(ok)
    resolver.current = null
    setOpts(null)
  }, [])

  useEffect(() => {
    // Modal 挂载时默认聚焦第一个可聚焦元素（头部 X）；这里随后把焦点挪到"取消"，
    // 防止用户习惯性回车直接确认（尤其是删除）。子组件 effect 先于父组件执行，顺序有保证
    if (opts) cancelRef.current?.focus()
  }, [opts])

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {opts && (
        <Modal title={opts.title} onClose={() => done(false)} className="confirm-bg"
          footer={
            <>
              <button ref={cancelRef} className="btn" onClick={() => done(false)}>
                {opts.cancelText ?? '取消'}
              </button>
              <button className={opts.danger ? 'btn danger' : 'btn primary'} onClick={() => done(true)}>
                {opts.confirmText ?? '确认'}
              </button>
            </>
          }>
          {opts.message != null && <div className="confirm-msg">{opts.message}</div>}
        </Modal>
      )}
    </ConfirmContext.Provider>
  )
}

export function useConfirm(): ConfirmFn {
  const ctx = useContext(ConfirmContext)
  if (!ctx) throw new Error('useConfirm 必须在 <ConfirmProvider> 内部使用：请确认组件树外层已包裹 ConfirmProvider')
  return ctx
}
