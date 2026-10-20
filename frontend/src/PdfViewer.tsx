import { useEffect, useRef, useState } from 'react'
import * as pdfjs from 'pdfjs-dist'
import workerUrl from './pdf.worker?worker&url'
import type { Highlight } from './api'

// workerSrc 指向自建 worker 入口（见 pdf.worker.ts）：它会在启动 pdf.js worker 前补上
// Map.prototype.getOrInsertComputed 等新内置方法，否则旧内核浏览器整篇 PDF 渲染失败。
// 用 workerSrc 而不是 workerPort，保持 pdf.js 原有的"首次 getDocument 才建 worker"行为。
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

export const HL_COLORS: Record<string, string> = {
  yellow: 'rgba(255, 214, 64, .55)',
  green: 'rgba(96, 211, 122, .45)',
  blue: 'rgba(96, 165, 250, .45)',
  pink: 'rgba(244, 114, 182, .42)',
}
export const HL_COLOR_NAMES: Record<string, string> = {
  yellow: '黄色', green: '绿色', blue: '蓝色', pink: '粉色',
}

export interface HitBlock {
  id: string; page: number; y0: number; y1: number; x0: number; x1: number; type: string
}
export interface SelectedText {
  page: number; text: string; rects: number[][]
  x: number; y: number
}
export interface FormulaRegion {
  page: number; x0: number; y0: number; x1: number; y1: number
}
export interface ViewerHandle {
  scrollToPage: (n: number) => void
  hitTest: (x: number, y: number, blocks: HitBlock[]) => string | null
  blockTop: (page: number, y0: number, rail: HTMLElement) => number | null
  flashText: (page: number, query: string) => boolean
  selectionImage: (sel: SelectedText, padding?: number) => Promise<Blob | null>
  clearSelection: () => void
}

// Symbol 字体常用 PUA 到 Unicode 的映射（Word/LaTeX 导出的 PDF 里很常见）。
// 只覆盖数学符号和希腊字母；未覆盖的 PUA 会被移除并由公式识别兜底。
const PUA_MAP: Record<number, string> = {
  0xf020: ' ', 0xf021: '!', 0xf022: '∀', 0xf023: '#', 0xf024: '∃',
  0xf025: '%', 0xf026: '&', 0xf027: '∋', 0xf028: '(', 0xf029: ')',
  0xf02a: '∗', 0xf02b: '+', 0xf02c: ',', 0xf02d: '−', 0xf02e: '.',
  0xf02f: '/', 0xf03a: ':', 0xf03b: ';', 0xf03c: '<', 0xf03d: '=',
  0xf03e: '>', 0xf03f: '?', 0xf040: '≅', 0xf05b: '[', 0xf05c: '∴',
  0xf05d: ']', 0xf05e: '⊥', 0xf05f: '_', 0xf07b: '{', 0xf07c: '|',
  0xf07d: '}', 0xf07e: '∼',
  0xf041: 'Α', 0xf042: 'Β', 0xf043: 'Χ', 0xf044: 'Δ', 0xf045: 'Ε',
  0xf046: 'Φ', 0xf047: 'Γ', 0xf048: 'Η', 0xf049: 'Ι', 0xf04a: 'ϑ',
  0xf04b: 'Κ', 0xf04c: 'Λ', 0xf04d: 'Μ', 0xf04e: 'Ν', 0xf04f: 'Ο',
  0xf050: 'Π', 0xf051: 'Θ', 0xf052: 'Ρ', 0xf053: 'Σ', 0xf054: 'Τ',
  0xf055: 'Υ', 0xf056: 'ς', 0xf057: 'Ω', 0xf058: 'Ξ', 0xf059: 'Ψ',
  0xf05a: 'Ζ',
  0xf061: 'α', 0xf062: 'β', 0xf063: 'χ', 0xf064: 'δ', 0xf065: 'ε',
  0xf066: 'φ', 0xf067: 'γ', 0xf068: 'η', 0xf069: 'ι', 0xf06a: 'ϕ',
  0xf06b: 'κ', 0xf06c: 'λ', 0xf06d: 'μ', 0xf06e: 'ν', 0xf06f: 'ο',
  0xf070: 'π', 0xf071: 'θ', 0xf072: 'ρ', 0xf073: 'σ', 0xf074: 'τ',
  0xf075: 'υ', 0xf076: 'ϖ', 0xf077: 'ω', 0xf078: 'ξ', 0xf079: 'ψ',
  0xf07a: 'ζ',
  0xf0a2: '′', 0xf0a3: '≤', 0xf0a4: '⁄', 0xf0a5: '∞', 0xf0a6: 'ƒ',
  0xf0ab: '↔', 0xf0ac: '←', 0xf0ad: '↑', 0xf0ae: '→', 0xf0af: '↓',
  0xf0b0: '°', 0xf0b1: '±', 0xf0b2: '″', 0xf0b3: '≥', 0xf0b4: '×',
  0xf0b5: '∝', 0xf0b6: '∂', 0xf0b7: '•', 0xf0b8: '÷', 0xf0b9: '≠',
  0xf0ba: '≡', 0xf0bb: '≈', 0xf0bc: '…', 0xf0bd: '|', 0xf0be: '—',
  0xf0bf: '↵', 0xf0c0: 'ℵ', 0xf0c1: 'ℑ', 0xf0c2: 'ℜ', 0xf0c3: '℘',
  0xf0c4: '⊗', 0xf0c5: '⊕', 0xf0c6: '∅', 0xf0c7: '∩', 0xf0c8: '∪',
  0xf0c9: '⊃', 0xf0ca: '⊇', 0xf0cb: '⊄', 0xf0cc: '⊂', 0xf0cd: '⊆',
  0xf0ce: '∈', 0xf0cf: '∉', 0xf0d0: '∠', 0xf0d1: '∇', 0xf0d2: '®',
  0xf0d3: '©', 0xf0d4: '™', 0xf0d5: '∏',
  0xf0d6: '√', 0xf0d7: '⋅', 0xf0d8: '¬', 0xf0d9: '∧', 0xf0da: '∨',
  0xf0db: '⇔', 0xf0dc: '⇐', 0xf0dd: '⇑', 0xf0de: '⇒', 0xf0df: '⇓',
  0xf0e5: '∑', 0xf0e6: '⎛', 0xf0e7: '⎜', 0xf0e8: '⎝', 0xf0e9: '⎡',
  0xf0ea: '⎢', 0xf0eb: '⎣', 0xf0ec: '⎧', 0xf0ed: '⎨', 0xf0ee: '⎩',
  0xf0ef: '⎪', 0xf0f0: '⎫', 0xf0f1: '⎬', 0xf0f2: '⎭',
}

export function cleanPdfText(text: string): string {
  return (text || '')
    .replace(/[\uE000-\uF8FF]/g, (ch) => PUA_MAP[ch.codePointAt(0)!] ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

interface Props {
  url: string
  blocks: HitBlock[]
  onReady?: (h: ViewerHandle) => void
  onBlockClick?: (blockId: string, x: number, y: number) => void
  onLayout?: () => void
  highlights?: Highlight[]
  onSelectText?: (sel: SelectedText) => void
  onFormulaCrop?: (blob: Blob, x: number, y: number) => void
  formulaRegions?: FormulaRegion[]
  onHighlightClick?: (h: Highlight, x: number, y: number) => void
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

// 标亮矩形合并：pdf.js 文本层会把一行拆成多个 span，Range.getClientRects 还会
// 同时给出「字形框」和「行框」，直接渲染会得到一堆互相重叠的半透明方块。
// 这里按行分组、取公共字形高度，再把同一行相邻/重叠的矩形并成一段。
const RECT_MERGE_GAP = 0.012

function mergeRects(raw: number[][]): number[][] {
  const rs: number[][] = []
  for (const r of raw) {
    if (!Array.isArray(r) || r.length !== 4 || !r.every((v) => Number.isFinite(v))) continue
    const x0 = Math.max(0, Math.min(1, Math.min(r[0], r[2])))
    const y0 = Math.max(0, Math.min(1, Math.min(r[1], r[3])))
    const x1 = Math.max(0, Math.min(1, Math.max(r[0], r[2])))
    const y1 = Math.max(0, Math.min(1, Math.max(r[1], r[3])))
    if (x1 - x0 < 0.0015 || y1 - y0 < 0.0015) continue
    rs.push([x0, y0, x1, y1])
  }
  rs.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]))

  const groups: number[][][] = []
  for (const r of rs) {
    const cy = (r[1] + r[3]) / 2
    const g = groups.find((grp) => {
      const gr = grp[0]
      const gy = (gr[1] + gr[3]) / 2
      const h = Math.max(gr[3] - gr[1], r[3] - r[1])
      return Math.abs(cy - gy) < h * 0.55
    })
    if (g) g.push(r)
    else groups.push([r])
  }

  const out: number[][] = []
  for (const g of groups) {
    // 同一行内既有字形框又有行框：取交集得到紧凑的字形高度
    let y0 = Math.max(...g.map((r) => r[1]))
    let y1 = Math.min(...g.map((r) => r[3]))
    if (y1 - y0 < 0.0015) {
      y0 = Math.min(...g.map((r) => r[1]))
      y1 = Math.max(...g.map((r) => r[3]))
    }
    const xs = g.map((r) => [r[0], r[2]]).sort((a, b) => a[0] - b[0])
    let cur = [xs[0][0], xs[0][1]]
    for (let i = 1; i < xs.length; i++) {
      if (xs[i][0] <= cur[1] + RECT_MERGE_GAP) cur[1] = Math.max(cur[1], xs[i][1])
      else {
        out.push([cur[0], y0, cur[1], y1])
        cur = [xs[i][0], xs[i][1]]
      }
    }
    out.push([cur[0], y0, cur[1], y1])
  }
  return out.sort((a, b) => (a[1] - b[1]) || (a[0] - b[0]))
}

/** 找到鼠标选区矩形落在的文本层 span；用它把行框裁成真实字形框 */
function spanAtRect(pageEl: HTMLElement, r: DOMRect): DOMRect | null {
  const cx = (r.left + r.right) / 2
  const cy = (r.top + r.bottom) / 2
  let best: DOMRect | null = null
  let bestArea = Infinity
  for (const span of pageEl.querySelectorAll<HTMLElement>('.textLayer span')) {
    const sr = span.getBoundingClientRect()
    if (cx < sr.left - 1 || cx > sr.right + 1 || cy < sr.top - 1 || cy > sr.bottom + 1) continue
    const area = sr.width * sr.height
    if (area < bestArea) { best = sr; bestArea = area }
  }
  return best
}

const MIN_SCALE = 0.3
const MAX_SCALE = 4
// 首次进入时的兜底缩放；实际显示比例会在文档加载后按阅读区宽度自动适配。
const DEFAULT_SCALE = 1.7
// pdf.js 6 起 CCITT/JBIG2/JPEG2000 位图解码器在 WASM 里，缺文件时 render 既不 resolve
// 也不 reject，会把整篇渲染循环永久卡死。拼接规则是 `${wasmUrl}${filename}`，必须带尾斜杠。
const WASM_URL = new URL('wasm/', document.baseURI).href
// 首次调用 WASM 解码器要编译模块，扫描件首屏可能几十秒（实测后台标签页里 73s，
// 之后每页都在百毫秒级）。所以超时只用来提示"渲染中"，绝不 cancel——取消会让这一页永久空白。
const RENDER_SLOW_MS = 15000

function renderPage(page: any, opts: any, slowMs: number, onSlow: () => void): Promise<void> {
  const timer = window.setTimeout(onSlow, slowMs)
  return page.render(opts).promise.finally(() => clearTimeout(timer))
}

export default function PdfViewer({ url, blocks, onReady, onBlockClick, onLayout,
  highlights = [], onSelectText, onFormulaCrop, formulaRegions = [], onHighlightClick }: Props) {
  const box = useRef<HTMLDivElement>(null)
  const [scale, setScale] = useState(DEFAULT_SCALE)
  const [err, setErr] = useState('')
  const renderTimer = useRef<number | null>(null)
  const pageEls = useRef(new Map<number, { el: HTMLDivElement; scale: number }>())
  const textLayers = useRef<pdfjs.TextLayer[]>([])
  const baseW = useRef(0)          // 页面在 100% 时的宽度（PDF 点）
  const fittedUrl = useRef('')     // 已完成自动适配的文档，避免每次缩放都重算
  const selecting = useRef(false)  // 刚完成拖选：忽略随之而来的 click，避免弹段落工具条
  const flashTimer = useRef<number | null>(null)
  const highlightsRef = useRef<Highlight[]>(highlights)
  highlightsRef.current = highlights
  const onHighlightClickRef = useRef(onHighlightClick)
  onHighlightClickRef.current = onHighlightClick
  const formulaRegionsRef = useRef<FormulaRegion[]>(formulaRegions)
  formulaRegionsRef.current = formulaRegions
  const [formulaMode, setFormulaMode] = useState(false)
  const formulaDrag = useRef<{
    page: number; el: HTMLDivElement; box: HTMLDivElement
    x0: number; y0: number; pointerId: number
  } | null>(null)

  /** 把持久化标亮画到每一页（rects 是相对页面内容区的 0~1 比例，缩放后自动还原） */
  const drawHighlights = () => {
    for (const [pno, pe] of pageEls.current) {
      let layer = pe.el.querySelector<HTMLDivElement>('.hl-layer')
      if (!layer) {
        layer = document.createElement('div')
        layer.className = 'hl-layer'
        pe.el.appendChild(layer)
      }
      layer.innerHTML = ''
      for (const h of highlightsRef.current) {
        if (h.page !== pno) continue
        for (const r of mergeRects(h.rects || [])) {
          if (!Array.isArray(r) || r.length !== 4) continue
          const [x0, y0, x1, y1] = r
          const div = document.createElement('div')
          div.className = 'hl-rect'
          div.style.left = `${x0 * 100}%`
          div.style.top = `${y0 * 100}%`
          div.style.width = `${(x1 - x0) * 100}%`
          div.style.height = `${(y1 - y0) * 100}%`
          div.style.background = HL_COLORS[h.color] || HL_COLORS.yellow
          div.title = h.text || '标亮'
          div.addEventListener('click', (e) => {
            e.stopPropagation()
            onHighlightClickRef.current?.(h, e.clientX, e.clientY)
          })
          layer.appendChild(div)
        }
      }
    }
  }

  /** 全文检索命中：在文本层里按关键词精确画临时高亮（不写入数据库） */
  const flashText = (page: number, query: string): boolean => {
    const pe = pageEls.current.get(page)
    if (!pe || !query.trim()) return false
    const pageEl = pe.el
    pageEl.querySelectorAll('.search-hit').forEach((n) => n.remove())
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    const canvas = pageEl.querySelector('canvas')
    const base = canvas?.getBoundingClientRect()
    if (!base || !base.width) return false
    const q = query.trim().toLowerCase()
    const nodes: { node: Text; start: number; end: number }[] = []
    let full = ''
    for (const span of pageEl.querySelectorAll<HTMLElement>('.textLayer span')) {
      for (const child of Array.from(span.childNodes)) {
        if (child.nodeType !== Node.TEXT_NODE) continue
        const t = child.textContent || ''
        if (!t) continue
        nodes.push({ node: child as Text, start: full.length, end: full.length + t.length })
        full += t
      }
    }
    const low = full.toLowerCase()
    const raw: number[][] = []
    let at = low.indexOf(q)
    while (at >= 0) {
      const end = at + q.length
      const startNode = nodes.find((n) => at >= n.start && at < n.end)
      const endNode = nodes.find((n) => end > n.start && end <= n.end)
      if (startNode && endNode) {
        try {
          const range = document.createRange()
          range.setStart(startNode.node, at - startNode.start)
          range.setEnd(endNode.node, end - endNode.start)
          for (const rect of range.getClientRects()) {
            const sr = spanAtRect(pageEl, rect)
            const within = !!sr && rect.left >= sr.left - 1 && rect.right <= sr.right + 1
            const left = within ? Math.max(rect.left, sr!.left) : rect.left
            const right = within ? Math.min(rect.right, sr!.right) : rect.right
            const top = sr ? Math.max(rect.top, sr.top) : rect.top
            const bottom = sr ? Math.min(rect.bottom, sr.bottom) : rect.bottom
            if (right - left < 1 || bottom - top < 1) continue
            raw.push([
              (left - base.left) / base.width, (top - base.top) / base.height,
              (right - base.left) / base.width, (bottom - base.top) / base.height,
            ])
          }
        } catch { /* 跳过异常 Range */ }
      }
      at = low.indexOf(q, at + Math.max(1, q.length))
    }
    const merged = mergeRects(raw)
    for (const [x0, y0, x1, y1] of merged) {
      const hit = document.createElement('div')
      hit.className = 'search-hit'
      hit.style.left = `${x0 * 100}%`
      hit.style.top = `${y0 * 100}%`
      hit.style.width = `${(x1 - x0) * 100}%`
      hit.style.height = `${(y1 - y0) * 100}%`
      pageEl.appendChild(hit)
    }
    if (!merged.length) {
      pageEl.classList.add('flash')
      window.setTimeout(() => pageEl.classList.remove('flash'), 1400)
    } else {
      flashTimer.current = window.setTimeout(() => {
        pageEl.querySelectorAll('.search-hit').forEach((n) => n.remove())
      }, 5000)
    }
    return merged.length > 0
  }

  /** 从 PDF 画布截一块 PNG；坐标是 canvas 像素。 */
  const cropPagePixels = (page: number, x0: number, y0: number, x1: number, y1: number,
    padding = 8): Promise<Blob | null> => {
    const pe = pageEls.current.get(page)
    const canvas = pe?.el.querySelector('canvas')
    if (!canvas) return Promise.resolve(null)
    const cw = canvas.width
    const ch = canvas.height
    if (!cw || !ch) return Promise.resolve(null)
    const bx0 = Math.max(0, Math.floor(Math.min(x0, x1) - padding))
    const by0 = Math.max(0, Math.floor(Math.min(y0, y1) - padding))
    const bx1 = Math.min(cw, Math.ceil(Math.max(x0, x1) + padding))
    const by1 = Math.min(ch, Math.ceil(Math.max(y0, y1) + padding))
    const w = bx1 - bx0
    const h = by1 - by0
    if (w < 4 || h < 4) return Promise.resolve(null)
    const out = document.createElement('canvas')
    out.width = w
    out.height = h
    const ctx = out.getContext('2d')
    if (!ctx) return Promise.resolve(null)
    ctx.fillStyle = '#fff'
    ctx.fillRect(0, 0, w, h)
    ctx.drawImage(canvas, bx0, by0, w, h, 0, 0, w, h)
    return new Promise((resolve) => out.toBlob((b) => resolve(b), 'image/png'))
  }

  /** 把当前选区所在的 PDF 画布区域截成 PNG，供公式 OCR 使用。 */
  const selectionImage = (sel: SelectedText, padding = 8): Promise<Blob | null> => {
    const pe = pageEls.current.get(sel.page)
    const canvas = pe?.el.querySelector('canvas')
    if (!canvas || !sel.rects?.length) return Promise.resolve(null)
    const xs = sel.rects.flatMap((r) => [r[0], r[2]])
    const ys = sel.rects.flatMap((r) => [r[1], r[3]])
    return cropPagePixels(sel.page,
      Math.min(...xs) * canvas.width, Math.min(...ys) * canvas.height,
      Math.max(...xs) * canvas.width, Math.max(...ys) * canvas.height, padding)
  }

  // ---------- 公式框选模式：不经过文本层，直接拖一个矩形，避开 PDF.js 的文本顺序 ----------
  const cancelFormulaDrag = () => {
    const d = formulaDrag.current
    if (!d) return
    d.box.remove()
    try { d.el.releasePointerCapture(d.pointerId) } catch { /* ignore */ }
    formulaDrag.current = null
  }

  const formulaDown = (e: React.PointerEvent) => {
    if (!formulaMode || e.button !== 0) return
    const target = e.target as HTMLElement
    const pageEl = target.closest('.page') as HTMLDivElement | null
    if (!pageEl) return
    e.preventDefault()
    e.stopPropagation()
    const pr = pageEl.getBoundingClientRect()
    const x = Math.max(0, Math.min(pr.width, e.clientX - pr.left))
    const y = Math.max(0, Math.min(pr.height, e.clientY - pr.top))
    const overlay = document.createElement('div')
    overlay.className = 'formula-drag'
    overlay.style.left = `${x}px`
    overlay.style.top = `${y}px`
    overlay.style.width = '0px'
    overlay.style.height = '0px'
    pageEl.appendChild(overlay)
    try { pageEl.setPointerCapture(e.pointerId) } catch { /* ignore */ }
    formulaDrag.current = {
      page: Number(pageEl.dataset.page || 1), el: pageEl, box: overlay,
      x0: x, y0: y, pointerId: e.pointerId,
    }
  }

  const formulaMove = (e: React.PointerEvent) => {
    const d = formulaDrag.current
    if (!d) return
    const pr = d.el.getBoundingClientRect()
    const x = Math.max(0, Math.min(pr.width, e.clientX - pr.left))
    const y = Math.max(0, Math.min(pr.height, e.clientY - pr.top))
    d.box.style.left = `${Math.min(d.x0, x)}px`
    d.box.style.top = `${Math.min(d.y0, y)}px`
    d.box.style.width = `${Math.abs(x - d.x0)}px`
    d.box.style.height = `${Math.abs(y - d.y0)}px`
  }

  const formulaUp = (e: React.PointerEvent) => {
    const d = formulaDrag.current
    if (!d) return
    const pr = d.el.getBoundingClientRect()
    const x = Math.max(0, Math.min(pr.width, e.clientX - pr.left))
    const y = Math.max(0, Math.min(pr.height, e.clientY - pr.top))
    const cssW = Math.abs(x - d.x0)
    const cssH = Math.abs(y - d.y0)
    formulaDrag.current = null
    d.box.remove()
    try { d.el.releasePointerCapture(d.pointerId) } catch { /* ignore */ }
    if (cssW < 6 || cssH < 6) return
    const canvas = d.el.querySelector('canvas')
    if (!canvas) return
    let bx0 = Math.min(d.x0, x)
    let by0 = Math.min(d.y0, y)
    let bx1 = Math.max(d.x0, x)
    let by1 = Math.max(d.y0, y)

    // 后端解析出的公式 bbox 比文本层可靠：框到公式附近时直接吸附到整段公式，
    // 避免把上面的正文行、下面的“where…”一起裁进 OCR。
    const peScale = pageEls.current.get(d.page)?.scale || 1
    const px0 = bx0 / peScale, py0 = by0 / peScale
    const px1 = bx1 / peScale, py1 = by1 / peScale
    let best: FormulaRegion | null = null
    let bestArea = 0
    for (const reg of formulaRegionsRef.current) {
      if (reg.page !== d.page) continue
      const ix = Math.max(0, Math.min(px1, reg.x1) - Math.max(px0, reg.x0))
      const iy = Math.max(0, Math.min(py1, reg.y1) - Math.max(py0, reg.y0))
      if (ix * iy > bestArea) { best = reg; bestArea = ix * iy }
    }
    if (best) {
      bx0 = best.x0 * peScale
      by0 = best.y0 * peScale
      bx1 = best.x1 * peScale
      by1 = best.y1 * peScale
    } else {
      // 没有公式 bbox 时（例如新模板/扫描件），把框内碰到的文字 span 完整包进来，
      // 补上用户框选时漏掉的上下标。
      for (const span of d.el.querySelectorAll<HTMLElement>('.textLayer span')) {
        if (!span.textContent) continue
        const sr = span.getBoundingClientRect()
        if (sr.right < pr.left + bx0 || sr.left > pr.left + bx1) continue
        if (sr.bottom < pr.top + by0 || sr.top > pr.top + by1) continue
        bx0 = Math.min(bx0, sr.left - pr.left)
        bx1 = Math.max(bx1, sr.right - pr.left)
        by0 = Math.min(by0, sr.top - pr.top)
        by1 = Math.max(by1, sr.bottom - pr.top)
      }
    }
    const kx = canvas.width / pr.width
    const ky = canvas.height / pr.height
    const x0 = bx0 * kx
    const y0 = by0 * ky
    const x1 = bx1 * kx
    const y1 = by1 * ky
    selecting.current = true
    window.setTimeout(() => { selecting.current = false }, 350)
    setFormulaMode(false)
    cropPagePixels(d.page, x0, y0, x1, y1, best ? 2 : 12).then((blob) => {
      if (blob) onFormulaCrop?.(blob, e.clientX, e.clientY)
    })
  }

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
    pdfjs.getDocument({ url, wasmUrl: WASM_URL }).promise.then(async (doc) => {
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
      const failed: number[] = []
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
        // pdf.js 6 的 textLayer 用这个变量计算 span 字号；不设置会让上下标全按 16px 渲染。
        tlDiv.style.setProperty('--total-scale-factor', String(vp.scale))
        div.appendChild(tlDiv)
        const tag = document.createElement('span')
        tag.className = 'pn'
        tag.textContent = `${i} / ${doc.numPages}`
        div.appendChild(tag)
        wrap.appendChild(div)
        pageEls.current.set(i, { el: div, scale })
        const note = document.createElement('div')
        try {
          await renderPage(page, {
            canvasContext: canvas.getContext('2d')!, viewport: vp,
            transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
          } as any, RENDER_SLOW_MS, () => {
            note.className = 'page-note'
            note.textContent = `第 ${i} 页正在渲染（扫描件首次解码较慢，请稍候）`
            div.appendChild(note)
          })
        } catch (e) {
          failed.push(i)
          note.className = 'page-fail'
          note.textContent = `第 ${i} 页渲染失败：${String((e as Error)?.message || e)}`
          div.appendChild(note)
        }
        note.remove()   // 成功或失败都撤掉"渲染中"提示
        try {
          const tl = new pdfjs.TextLayer({
            textContentSource: await page.streamTextContent(), container: tlDiv, viewport: vp,
          })
          await tl.render()
          textLayers.current.push(tl)
        } catch { /* 文字层失败不影响图像展示 */ }
      }
      pdfjs.TextLayer.cleanup()
      if (!dead) drawHighlights()
      if (failed.length && !dead) {
        const shown = failed.slice(0, 6).join('、')
        setErr(`${failed.length}/${doc.numPages} 页渲染失败（第 ${shown}${failed.length > 6 ? ' 等' : ''} 页），其余页正常`)
      }
      onLayout?.()
    }).catch((e) => { if (!dead) setErr(String(e?.message || e)) })
    return () => {
      dead = true
      textLayers.current.forEach((t) => t.cancel())
      textLayers.current = []
    }
  }, [url, scale])

  // 退出公式框选模式 / 按 Esc 时清掉未完成的拖拽框
  useEffect(() => {
    if (!formulaMode) { cancelFormulaDrag(); return }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      cancelFormulaDrag()
      setFormulaMode(false)
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [formulaMode])

  // 标亮数据变化（新增/换色/删除）或重新渲染后重画覆盖层
  useEffect(() => { drawHighlights() }, [highlights, scale])

  // 原生 Ctrl+C 的兜底：把 Symbol 字体的私用区字符映射成 Unicode，
  // 并清理 PDF.js 文本层的多余空白；公式结构仍由「识别公式」处理。
  useEffect(() => {
    const onCopy = (e: ClipboardEvent) => {
      if (!box.current) return
      const sel = window.getSelection()
      if (!sel || sel.isCollapsed) return
      const range = sel.getRangeAt(0)
      if (!box.current.contains(range.commonAncestorContainer)) return
      const raw = sel.toString()
      const text = cleanPdfText(raw) || raw.trim()
      if (!text) return
      e.clipboardData?.setData('text/plain', text)
      e.preventDefault()
    }
    document.addEventListener('copy', onCopy)
    return () => document.removeEventListener('copy', onCopy)
  }, [])

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
      flashText,
      selectionImage,
      clearSelection: () => window.getSelection()?.removeAllRanges(),
    })
  }, [onReady])

  /** 选区只要碰到某个公式的一部分，就把 Range 扩到整段公式；
     正文选区保持不变，因此“正文 + 半个公式”会变成“正文 + 整个公式”。 */
  const expandRangeToFormula = (range: Range, pageEl: HTMLElement, base: DOMRect, scale: number) => {
    if (!formulaRegionsRef.current.length) return
    const page = Number(pageEl.dataset.page || 1)
    const spans = Array.from(pageEl.querySelectorAll<HTMLElement>('.textLayer span')).filter((s) => s.textContent)
    if (!spans.length) return
    const pageW = base.width / scale
    const pageH = base.height / scale
    const inside = (sr: DOMRect, g: FormulaRegion) => {
      const x = (sr.left + sr.width / 2 - base.left) / base.width * pageW
      const y = (sr.top + sr.height / 2 - base.top) / base.height * pageH
      return x >= g.x0 - 3 && x <= g.x1 + 3 && y >= g.y0 - 3 && y <= g.y1 + 3
    }
    for (const reg of formulaRegionsRef.current) {
      if (reg.page !== page) continue
      const regSpans = spans.filter((span) => inside(span.getBoundingClientRect(), reg))
      if (!regSpans.length) continue
      let hit = false
      for (const span of regSpans) {
        try { if (range.intersectsNode(span)) { hit = true; break } } catch { /* ignore */ }
      }
      if (!hit) continue
      const first = regSpans[0]
      const last = regSpans[regSpans.length - 1]
      try { if (!range.intersectsNode(first)) range.setStartBefore(first) } catch { /* ignore */ }
      try { if (!range.intersectsNode(last)) range.setEndAfter(last) } catch { /* ignore */ }
    }
  }

  const up = () => {
    if (formulaMode) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed) return
    let node: Node | null = sel.getRangeAt(0).commonAncestorContainer
    let pageEl: HTMLElement | null = null
    while (node) {
      if (node instanceof HTMLElement && node.classList.contains('page')) { pageEl = node; break }
      node = node.parentNode
    }
    if (!pageEl) return
    const base = pageEl.querySelector('canvas')?.getBoundingClientRect()
    if (!base || !base.width || !base.height) return
    const range = sel.getRangeAt(0)
    const peScale = pageEls.current.get(Number(pageEl.dataset.page || 1))?.scale || 1
    expandRangeToFormula(range, pageEl, base, peScale)
    const text = sel.toString().trim()
    if (!text) return
    const raw: number[][] = []
    let last: DOMRect | null = null
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 2 || r.height < 2) continue
      if (r.bottom < base.top || r.top > base.bottom) continue
      const sr = spanAtRect(pageEl, r)
      const within = !!sr && r.left >= sr.left - 1 && r.right <= sr.right + 1
      const left = within ? Math.max(r.left, sr!.left) : r.left
      const right = within ? Math.min(r.right, sr!.right) : r.right
      const top = sr ? Math.max(r.top, sr.top) : r.top
      const bottom = sr ? Math.min(r.bottom, sr.bottom) : r.bottom
      if (right - left < 1 || bottom - top < 1) continue
      const x0 = Math.max(0, (left - base.left) / base.width)
      const y0 = Math.max(0, (top - base.top) / base.height)
      const x1 = Math.min(1, (right - base.left) / base.width)
      const y1 = Math.min(1, (bottom - base.top) / base.height)
      if (x1 - x0 < 0.001 || y1 - y0 < 0.001) continue
      raw.push([x0, y0, x1, y1])
      last = r
    }
    const rects = mergeRects(raw)
    if (!rects.length) return
    selecting.current = true
    window.setTimeout(() => { selecting.current = false }, 350)
    onSelectText?.({
      page: Number(pageEl.dataset.page || 1),
      text: cleanPdfText(text).slice(0, 2000),
      rects,
      x: last ? last.right : base.right,
      y: last ? last.bottom : base.bottom,
    })
  }

  const click = (e: React.MouseEvent) => {
    if (formulaMode || selecting.current || window.getSelection()?.toString().trim()) return
    const target = e.target as HTMLElement
    if (target.closest('.card') || target.closest('.toolbar-pop')) return
    if (!target.closest('.page')) return
    const id = hitIn(pageEls.current, blocks, e.clientX, e.clientY)
    if (id) onBlockClick?.(id, e.clientX, e.clientY)
  }

  return (
    <div className={formulaMode ? 'viewer formula-mode' : 'viewer'}>
      <div className="zoombar">
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 8 }}>缩放</span>
        <button className="btn small" onClick={() => slide(clampScale(displayScale - 0.1))}>−</button>
        <input type="range" className="zoom-slider" min={MIN_SCALE} max={MAX_SCALE} step={0.05}
          value={displayScale} onChange={(e) => slide(+e.target.value)} />
        <button className="btn small" onClick={() => slide(clampScale(displayScale + 0.1))}>+</button>
        <button className="btn small" title="贴合阅读区宽度"
          onClick={() => { const t = fitScale(); if (t != null) slide(t) }}>适配</button>
        <button className={formulaMode ? 'btn small primary' : 'btn small'}
          title="拖拽框住一个公式，松开后自动识别为 LaTeX"
          onClick={() => {
            window.getSelection()?.removeAllRanges()
            cancelFormulaDrag()
            setFormulaMode((v) => !v)
          }}>∑ 框选公式</button>
        <span style={{ fontSize: 12, color: 'var(--muted)', width: 42, textAlign: 'right' }}>
          {Math.round(displayScale * 100)}%</span>
        <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto', marginRight: 8 }}>
          {formulaMode ? '拖拽框住一个公式，松开自动识别；Esc 取消' : '拖选文字可标亮 · 点击段落可翻译 / 提问'}
        </span>
        {err && <span className="err">渲染失败：{err}</span>}
      </div>
      <div ref={box} onClick={click} onMouseUp={up}
        onPointerDown={formulaDown}
        onPointerMove={formulaMove}
        onPointerUp={formulaUp} onPointerCancel={cancelFormulaDrag} />
    </div>
  )
}
