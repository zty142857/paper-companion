import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import Markdown from './Markdown'

/** 原位译文层里的一块：坐标/尺寸已经是页面 CSS 像素（已乘当前缩放）。 */
export interface InlineTranslationBlock {
  id: string
  text: string
  left: number
  top: number
  width: number
  /** 原块高度（px） */
  height: number
  /** 在不遮挡下一块的前提下允许使用的最大高度（px） */
  maxHeight: number
  /** 按原文块字号换算出的基准字号（px），溢出时会自动缩小 */
  fontSize: number
  heading?: boolean
}

// 自动缩字的下限：再小就截断并给「展开全文」，不做无意义的压缩。
export const MIN_TRANSLATION_FONT = 12
const PAD_Y = 4

interface Props {
  items: InlineTranslationBlock[]
}

function fitFont(body: HTMLElement, avail: number, base: number): { size: number; over: boolean } {
  const measure = (px: number) => {
    body.style.fontSize = `${px}px`
    return body.scrollHeight
  }
  let size = base
  let over = false
  if (measure(size) > avail + 1) {
    if (measure(MIN_TRANSLATION_FONT) > avail + 1) {
      size = MIN_TRANSLATION_FONT
      over = true
    } else {
      // 二分搜索能放下的最大字号，最后落到 0.5px 一档，避免亚像素抖动
      let lo = MIN_TRANSLATION_FONT
      let hi = size
      for (let i = 0; i < 8; i++) {
        const mid = (lo + hi) / 2
        if (measure(mid) > avail + 1) hi = mid
        else lo = mid
      }
      size = Math.max(MIN_TRANSLATION_FONT, Math.floor(lo * 2) / 2)
    }
  }
  measure(size)
  return { size, over }
}

function TranslationItem({ b }: { b: InlineTranslationBlock }) {
  const boxRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [arrow, setArrow] = useState<{ left: number; top: number } | null>(null)
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState({ left: 0, top: 0, width: 420 })

  // 译文/基准字号/块尺寸变化（尤其是缩放重建）后重新适配。
  // 先在不遮挡下一块的范围内尽量向下展开，再把多余文本截在完整行边界，
  // 并在最后一行末尾放一个小三角用于展开。
  useLayoutEffect(() => {
    const box = boxRef.current
    const body = bodyRef.current
    if (!box || !body) return
    let alive = true
    const fit = () => {
      if (!alive) return
      box.style.height = `${Math.max(b.height, b.maxHeight)}px`
      body.style.maxHeight = 'none'
      body.style.overflow = 'visible'
      const avail = Math.max(1, box.clientHeight - PAD_Y * 2)
      if (avail <= 6) {
        body.style.fontSize = `${MIN_TRANSLATION_FONT}px`
        box.style.height = `${b.height}px`
        setArrow({ left: Math.max(6, b.width - 13), top: Math.max(0, b.height - 13) })
        return
      }
      fitFont(body, avail, b.fontSize)
      const contentH = body.scrollHeight
      const finalH = Math.max(b.height, Math.min(b.maxHeight, contentH + PAD_Y * 2))
      box.style.height = `${finalH}px`
      if (contentH <= finalH - PAD_Y * 2 + 1) {
        setArrow((prev) => (prev ? null : prev))
        return
      }

      // 只保留完整行：找可用高度内最靠下的一条文字行，以它的底部作为裁切线。
      const boxRect = box.getBoundingClientRect()
      const bodyRect = body.getBoundingClientRect()
      const availableBottom = bodyRect.top + (finalH - PAD_Y * 2)
      const rects: DOMRect[] = []
      const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        if (!n.textContent?.trim()) continue
        const range = document.createRange()
        range.selectNodeContents(n)
        for (const r of Array.from(range.getClientRects())) {
          if (r.width > 1 && r.height > 1 && r.top >= bodyRect.top - 1
            && r.bottom <= availableBottom + 1) rects.push(r)
        }
      }
      if (!rects.length) {
        body.style.maxHeight = `${Math.max(1, finalH - PAD_Y * 2)}px`
        body.style.overflow = 'hidden'
        setArrow({ left: Math.max(6, b.width - 13), top: Math.max(0, finalH - 13) })
        return
      }
      const lastBottom = Math.max(...rects.map((r) => r.bottom))
      const lastLine = rects.filter((r) => Math.abs(r.bottom - lastBottom) < 2.5)
      const right = Math.max(...lastLine.map((r) => r.right))
      const top = Math.min(...lastLine.map((r) => r.top))
      body.style.maxHeight = `${Math.max(1, lastBottom - bodyRect.top)}px`
      body.style.overflow = 'hidden'
      setArrow({
        left: Math.max(2, Math.min(b.width - 13, right - boxRect.left + 2)),
        top: Math.max(0, Math.min(finalH - 13, top - boxRect.top + 1)),
      })
    }
    fit()
    void document.fonts?.ready.then(() => { if (alive) fit() })
    return () => { alive = false }
  }, [b.text, b.fontSize, b.width, b.height, b.maxHeight])

  // 浮层关闭：Esc / 点击外部 / 页面滚动（位置会失效）
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent) => {
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    const onScroll = (e: Event) => {
      if (popRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    document.addEventListener('keydown', onKey)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      document.removeEventListener('keydown', onKey)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open])

  const openFull = (e: React.MouseEvent) => {
    e.stopPropagation()
    const r = boxRef.current?.getBoundingClientRect()
    const width = Math.max(160, Math.min(460, window.innerWidth - 20))
    const left = Math.max(8, Math.min(r?.left ?? 20, window.innerWidth - width - 8))
    const maxH = Math.min(window.innerHeight * 0.7, 560)
    let top = r ? r.bottom + 8 : 20
    if (top + maxH > window.innerHeight - 8) {
      top = Math.max(8, window.innerHeight - maxH - 8)
    }
    setPos({ left, top, width })
    setOpen(true)
  }

  return (
    <div ref={boxRef} className={b.heading ? 'il-item heading' : 'il-item'}
      style={{ left: b.left, top: b.top, width: b.width, height: b.height }}>
      <div ref={bodyRef} className="il-body"><Markdown text={b.text} /></div>
      {arrow && (
        <button className="il-more" title="展开完整译文" aria-label="展开完整译文"
          style={{ left: arrow.left, top: arrow.top }}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={openFull}>▾</button>
      )}
      {open && createPortal(
        <div ref={popRef} className="il-pop"
          style={{ left: pos.left, top: pos.top, width: pos.width }}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}>
          <div className="il-pop-h">
            <span>译文全文</span>
            <button className="x" title="关闭" onClick={() => setOpen(false)}>×</button>
          </div>
          <div className="il-pop-b"><Markdown text={b.text} /></div>
        </div>,
        document.body,
      )}
    </div>
  )
}

/** 原位译文层：只渲染父组件传入的（当前实际可见的）块译文。 */
export default function InlineTranslation({ items }: Props) {
  return (
    <>
      {items.map((b) => <TranslationItem key={b.id} b={b} />)}
    </>
  )
}
