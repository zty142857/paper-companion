import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export interface HitBlock {
  id: string; page: number; y0: number; y1: number; x0: number; x1: number; type: string
}
export interface ViewerHandle {
  scrollToPage: (n: number) => void
  hitTest: (x: number, y: number, blocks: HitBlock[]) => string | null
  blockTop: (page: number, y0: number, rail: HTMLElement) => number | null
}

interface Props {
  url: string
  blocks: HitBlock[]
  onReady?: (h: ViewerHandle) => void
  onBlockClick?: (blockId: string, x: number, y: number) => void
  onLayout?: () => void
}

function hitIn(pages: Map<number, { el: HTMLDivElement; scale: number }>, blocks: HitBlock[], x: number, y: number) {
  for (const [pno, pe] of pages) {
    const r = pe.el.getBoundingClientRect()
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) continue
    const px = (x - r.left) / pe.scale
    const py = (y - r.top) / pe.scale
    const hits = blocks.filter((b) => b.page === pno && b.type !== 'figure'
      && px >= b.x0 - 2 && px <= b.x1 + 2 && py >= b.y0 - 1 && py <= b.y1 + 1)
    if (!hits.length) return null
    return hits.sort((a, b) => (a.y1 - a.y0) * (a.x1 - a.x0) - (b.y1 - b.y0) * (b.x1 - b.x0))[0].id
  }
  return null
}

const MIN_SCALE = 0.3
const MAX_SCALE = 4
// 首次进入时的兜底缩放；实际显示比例会在文档加载后按阅读区宽度自动适配。
const DEFAULT_SCALE = 1.7

export default function PdfViewer({ url, blocks, onReady, onBlockClick, onLayout }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [err, setErr] = useState('')
  const renderTimer = useRef<number | null>(null)
  const pageEls = useRef(new Map<number, { el: HTMLDivElement; scale: number }>())
  const textLayers = useRef<pdfjs.TextLayer[]>([])
  const baseW = useRef(0)          // 页面在 100% 时的宽度（PDF 点）
  const fittedUrl = useRef('')     // 已完成自动适配的文档，避免每次缩放都重算

  const clampScale = (v: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, +v.toFixed(3)))
  // 适配 = 让整页宽度刚好等于阅读区宽度
  const fitScale = (): number | null => {
    const w = box.current?.clientWidth ?? 0
    if (!w) return null
    let base = baseW.current
    if (!base) {
      const pe = pageEls.current.get(1)
      if (pe) base = pe.el.getBoundingClientRect().width / pe.scale
    }
    if (!base) return null
    return clampScale((w - 4) / base)
  }

  useEffect(() => {
    let dead = false
    const wrap = box.current!
    wrap.innerHTML = ''
    pageEls.current = new Map()
      setErr('')
    pdfjs.getDocument({ url }).promise.then(async (doc) => {
      if (dead) return
      const first = await doc.getPage(1)
      baseW.current = first.getViewport({ scale: 1 }).width
      if (fittedUrl.current !== url) {
        fittedUrl.current = url
        const target = fitScale()
        if (target != null && Math.abs(target - scale) > 0.02) {
          setDisplayScale(target); setScale(target)
          return
        }
      }
      for (let i = 1; i <= doc.numPages; i++) {
        if (dead) return
        const page = await doc.getPage(i)
        const vp = page.getViewport({ scale })   // 不裁剪：允许超过阅读区宽度而横向滚动
        const div = document.createElement('div')
        div.className = 'page'
        div.style.width = `${vp.width}px`
        div.dataset.page = String(i)
        const canvas = document.createElement('canvas')
        const dpr = window.devicePixelRatio || 1
        canvas.width = vp.width * dpr
        canvas.height = vp.height * dpr
        canvas.style.width = `${vp.width}px`
        canvas.style.height = `${vp.height}px`
        div.appendChild(canvas)
        const tlDiv = document.createElement('div')
        tlDiv.className = 'textLayer'
        div.appendChild(tlDiv)
        const tag = document.createElement('span')
        tag.className = 'pn'
        tag.textContent = `${i} / ${doc.numPages}`
        div.appendChild(tag)
        wrap.appendChild(div)
        pageEls.current.set(i, { el: div, scale })
        await page.render({
          canvasContext: canvas.getContext('2d')!, viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        } as any).promise
        const tl = new pdfjs.TextLayer({
          textContentSource: await page.streamTextContent(), container: tlDiv, viewport: vp,
        })
        await tl.render()
        textLayers.current.push(tl)
      }
      pdfjs.TextLayer.cleanup()
      onLayout?.()
    }).catch((e) => { if (!dead) setErr(String(e?.message || e)) })
    return () => {
      dead = true
      textLayers.current.forEach((t) => t.cancel())
      textLayers.current = []
    }
  }, [url, scale])

  // 滑块连续拖动：先即时更新百分比，停止拖动 200ms 后再重排渲染
  const [displayScale, setDisplayScale] = useState(scale)
  const slide = (v: number) => {
    setDisplayScale(v)
    if (renderTimer.current) window.clearTimeout(renderTimer.current)
    renderTimer.current = window.setTimeout(() => setScale(v), 200)
  }

  useEffect(() => {
    onReady?.({
      scrollToPage: (n: number) => {
        const pe = pageEls.current.get(n)
        if (!pe) return
        pe.el.scrollIntoView({ behavior: 'smooth', block: 'start' })
        pe.el.classList.add('flash')
        setTimeout(() => pe.el.classList.remove('flash'), 1400)
      },
      hitTest: (x, y, bs) => hitIn(pageEls.current, bs, x, y),
      blockTop: (page, y0, rail) => {
        const pe = pageEls.current.get(page)
        if (!pe) return null
        return pe.el.getBoundingClientRect().top - rail.getBoundingClientRect().top + y0 * pe.scale
      },
    })
  }, [onReady])

  const click = (e: React.MouseEvent) => {
    const target = e.target as HTMLElement
    if (target.closest('.card') || target.closest('.toolbar-pop')) return
    if (!target.closest('.page')) return
    const id = hitIn(pageEls.current, blocks, e.clientX, e.clientY)
    if (id) onBlockClick?.(id, e.clientX, e.clientY)
  }

  return (
    <div className="viewer">
      <div className="zoombar">
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>缩放</span>
        <button className="btn small" onClick={() => slide(clampScale(displayScale - 0.1))}>−</button>
        <input type="range" className="zoom-slider" min={MIN_SCALE} max={MAX_SCALE} step={0.05}
          value={displayScale} onChange={(e) => slide(+e.target.value)} />
        <button className="btn small" onClick={() => slide(clampScale(displayScale + 0.1))}>+</button>
        <button className="btn small" title="贴合阅读区宽度"
          onClick={() => { const t = fitScale(); if (t != null) slide(t) }}>适配</button>
        <span style={{ fontSize: 12, color: 'var(--muted)', width: 42, textAlign: 'right' }}>
          {Math.round(displayScale * 100)}%</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto', marginRight: 8 }}>
          点击正文段落可翻译 / 提问
        </span>
        {err && <span className="err">渲染失败：{err}</span>}
      </div>
      <div ref={box} onClick={click} />
    </div>
  )
}
