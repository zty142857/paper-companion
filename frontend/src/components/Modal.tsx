import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'

interface ModalProps {
  title?: ReactNode        // 传入时渲染标准头部（h2 + 右上角 X）；不传则调用方自绘头部
  onClose: () => void      // 用户"尝试"关闭时调用，是否真关由调用方决定（如未保存守卫）
  children: ReactNode
  footer?: ReactNode       // 底部操作区，渲染在 .modal-foot
  className?: string       // 追加到 .modal 上，保住现有领域选择器（.modal.quiz 等）
  dismissable?: boolean    // false 时 Esc/遮罩/X 都不触发 onClose（busy 防误关）
  width?: number | string
}

/* ---------- 模块级共享状态 ----------
   弹窗会叠弹窗（confirm 盖在设置面板上），Esc 与滚动锁必须按"栈"处理：
   否则一次 Esc 把两层一起关掉、内层卸载会提前解锁外层还需要的滚动锁。 */

const escStack: Array<() => void> = []
let escListening = false
const onDocKeydown = (e: KeyboardEvent) => {
  // 只让最上层弹窗响应 Esc
  if (e.key === 'Escape' && escStack.length > 0) escStack[escStack.length - 1]()
}

let scrollLocks = 0
let savedOverflow = ''
const lockScroll = () => {
  if (scrollLocks === 0) {
    savedOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
  }
  scrollLocks += 1
}
const unlockScroll = () => {
  scrollLocks = Math.max(0, scrollLocks - 1)
  if (scrollLocks === 0) document.body.style.overflow = savedOverflow
}

// 焦点陷阱的可聚焦元素：排除 disabled 与 tabindex=-1（容器自身不算）
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
// 退场动画时长，与 components.css 里 .closing 的过渡保持一致
const EXIT_MS = 140

export default function Modal({ title, onClose, children, footer, className, dismissable = true, width }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const [closing, setClosing] = useState(false)
  const closingRef = useRef(false)
  const timerRef = useRef<number | null>(null)
  // Esc 监听只注册一次，但回调必须拿到最新 props，用 ref 转发避免反复解绑/重绑
  const closeRef = useRef<() => void>(() => {})

  const requestClose = () => {
    if (!dismissable || closingRef.current) return
    // 尊重系统减弱动效：没有动画可播就立即关，不做无意义等待
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) { onClose(); return }
    closingRef.current = true
    setClosing(true)
    // 先播退场动画再通知调用方。若调用方守卫拒绝关闭，组件仍挂载，
    // 这里把状态复原，弹窗淡回可交互状态（而不是卡在透明态）
    timerRef.current = window.setTimeout(() => {
      closingRef.current = false
      setClosing(false)
      onClose()
    }, EXIT_MS)
  }
  useEffect(() => { closeRef.current = requestClose })

  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    // 记住打开前的焦点，卸载时归还：键盘用户关掉弹窗后应回到原处
    const prev = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // 挂载即聚焦第一个可聚焦元素；没有则聚焦容器（tabIndex=-1），焦点不留在背景页
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.getClientRects().length > 0)
    ;(items[0] ?? panel).focus()

    lockScroll()
    const escHandler = () => closeRef.current()
    escStack.push(escHandler)
    if (!escListening) { document.addEventListener('keydown', onDocKeydown); escListening = true }

    return () => {
      unlockScroll()
      const i = escStack.indexOf(escHandler)
      if (i >= 0) escStack.splice(i, 1)
      if (escStack.length === 0 && escListening) {
        document.removeEventListener('keydown', onDocKeydown)
        escListening = false
      }
      // 退场等待中若被外部直接卸载，撤销未触发的 onClose，避免打扰已切换的页面
      if (timerRef.current != null) window.clearTimeout(timerRef.current)
      prev?.focus()
    }
  }, [])

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab') return
    const panel = panelRef.current
    if (!panel) return
    const items = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE))
      .filter((el) => el.getClientRects().length > 0)
    if (items.length === 0) { e.preventDefault(); panel.focus(); return }
    const first = items[0]
    const last = items[items.length - 1]
    const active = document.activeElement
    // Tab/Shift+Tab 在弹窗内循环，焦点绝不漏到背景页面
    if (e.shiftKey && (active === first || active === panel)) { e.preventDefault(); last.focus() }
    else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus() }
  }

  return createPortal(
    // 只认"按下点就是遮罩"：从弹窗内拖选文字、松手落在遮罩上不应误关
    <div className={`modal-bg${closing ? ' closing' : ''}`}
      onMouseDown={(e) => { if (e.target === e.currentTarget) requestClose() }}>
      <div ref={panelRef}
        className={`modal${className ? ` ${className}` : ''}`}
        style={width != null ? { width } : undefined}
        role="dialog" aria-modal="true"
        aria-label={typeof title === 'string' ? title : undefined}
        aria-labelledby={title != null && typeof title !== 'string' ? headingId : undefined}
        tabIndex={-1} onKeyDown={onKeyDown}>
        {title != null && (
          <div className="modal-head">
            <h2 id={headingId}>{title}</h2>
            <button className="modal-x" onClick={requestClose} disabled={!dismissable}
              aria-label="关闭" title="关闭"><X size={16} /></button>
          </div>
        )}
        {children}
        {footer != null && <div className="modal-foot">{footer}</div>}
      </div>
    </div>,
    document.body,
  )
}
