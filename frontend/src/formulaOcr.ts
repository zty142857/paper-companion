/** 公式 OCR 客户端 + LaTeX→可读纯文本。
 *
 * 模型推理在 formula.worker.ts 里做，主线程只负责截取选区、显示进度和复制结果。
 */

export interface OcrProgress {
  file?: string
  loaded?: number
  total?: number
  progress?: number
}

type Pending = {
  resolve: (latex: string) => void
  reject: (err: Error) => void
  onProgress?: (p: OcrProgress) => void
}

let worker: Worker | null = null
let seq = 0
const pending = new Map<string, Pending>()

function getWorker(): Worker {
  if (worker) return worker
  worker = new Worker(new URL('./formula.worker.ts', import.meta.url), { type: 'module' })
  worker.onmessage = (e: MessageEvent<any>) => {
    const d = e.data || {}
    if (d.type === 'progress') {
      for (const p of pending.values()) p.onProgress?.(d)
      return
    }
    const p = pending.get(d.id)
    if (!p) return
    pending.delete(d.id)
    if (d.type === 'result') p.resolve(String(d.latex || ''))
    else if (d.type === 'error') p.reject(new Error(String(d.error || '公式识别失败')))
  }
  worker.onerror = (e) => {
    const err = new Error(e.message || '公式识别 worker 启动失败')
    for (const p of pending.values()) p.reject(err)
    pending.clear()
    worker = null
  }
  return worker
}

export function recognizeFormula(blob: Blob, onProgress?: (p: OcrProgress) => void): Promise<string> {
  const id = `f${++seq}`
  const w = getWorker()
  return new Promise<string>((resolve, reject) => {
    pending.set(id, { resolve, reject, onProgress })
    w.postMessage({ type: 'recognize', id, image: blob })
  })
}

/** 把公式区域截图复制成 PNG（保留原排版，作为兜底选项）。 */
export async function copyImage(blob: Blob): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
    return
  }
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = 'formula.png'
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}

export async function copyText(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      // 某些环境里 writeText 会一直 pending，不能让它卡住按钮状态。
      await new Promise<void>((resolve, reject) => {
        let done = false
        const timer = window.setTimeout(() => {
          if (done) return
          done = true
          reject(new Error('clipboard timeout'))
        }, 1200)
        navigator.clipboard.writeText(text).then(
          () => { if (!done) { done = true; clearTimeout(timer); resolve() } },
          (e) => { if (!done) { done = true; clearTimeout(timer); reject(e) } },
        )
      })
      return
    } catch { /* 回退到 execCommand */ }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  const ok = document.execCommand('copy')
  ta.remove()
  if (!ok) throw new Error('浏览器拒绝写入剪贴板，请手动选中代码复制')
}

const GREEK: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε',
  zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', varpi: 'ϖ',
  rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ',
  phi: 'φ', varphi: 'ϕ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π',
  Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
}

const SYMBOLS: Record<string, string> = {
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', le: '≤', leq: '≤',
  ge: '≥', geq: '≥', neq: '≠', ne: '≠', approx: '≈', equiv: '≡', sim: '∼',
  propto: '∝', infty: '∞', partial: '∂', nabla: '∇', sum: '∑', prod: '∏',
  int: '∫', oint: '∮', to: '→', rightarrow: '→', leftarrow: '←',
  leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔',
  ldots: '…', cdots: '⋯', dots: '…', angle: '∠', perp: '⊥', parallel: '∥',
  in: '∈', notin: '∉', subset: '⊂', subseteq: '⊆', supset: '⊃',
  supseteq: '⊇', cup: '∪', cap: '∩', emptyset: '∅', forall: '∀', exists: '∃',
}

/** 修正模型常见的重复/多余大括号，避免 KaTeX 直接报错。 */
export function normalizeLatex(latex: string): string {
  let s = (latex || '').trim()
  s = s.replace(/^\$\$?|\$\$?$/g, '').replace(/^\\\[|\\\]$/g, '').trim()

  // Texo 偶尔会把同一段 array 连续生成两遍；保留第一份。
  const arrays = [...s.matchAll(/\\begin\{array\}[\s\S]*?\\end\{array\}/g)].map((m) => m[0])
  if (arrays.length > 1) {
    const first = arrays[0].replace(/\s+/g, '')
    for (const block of arrays.slice(1)) {
      if (block.replace(/\s+/g, '') === first) s = s.replace(block, '')
    }
  }

  // 去掉没有对应 \begin 的 \end{array}（Texo 偶尔会在公式编号后再补一个）。
  let arrayDepth = 0
  s = s.replace(/\\begin\{array\}|\\end\{array\}/g, (m) => {
    if (m.startsWith('\\begin')) { arrayDepth++; return m }
    if (arrayDepth > 0) { arrayDepth--; return m }
    return ''
  })
  if (arrayDepth > 0) s += '\\end{array}'.repeat(arrayDepth)

  // 去掉多余的右花括号，并补齐缺失的右花括号；\{ \} 不参与计数。
  let out = ''
  let depth = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\\' && i + 1 < s.length) { out += ch + s[++i]; continue }
    if (ch === '{') { depth++; out += ch; continue }
    if (ch === '}') {
      if (depth > 0) { depth--; out += ch }
      continue
    }
    out += ch
  }
  if (depth > 0) out += '}'.repeat(depth)
  return out.trim()
}

/** 尽力把模型输出的 LaTeX 变成可读 Unicode；复杂结构仍建议用 LaTeX。 */
export function latexToText(latex: string): string {
  let s = (latex || '').trim()
  s = s.replace(/^\$\$?|\$\$?$/g, '').replace(/^\\\[|\\\]$/g, '').replace(/^\\\(|\\\)$/g, '')

  // \frac{a}{b}、\sqrt{a} 支持一层嵌套；足够覆盖常见公式。
  for (let i = 0; i < 4; i++) {
    s = s
      .replace(/\\frac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\dfrac\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g, '($1)/($2)')
      .replace(/\\sqrt\s*\{([^{}]*)\}/g, '√($1)')
  }
  s = s.replace(/\\(?:text|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|mathfrak|operatorname)\s*\{([^{}]*)\}/g, '$1')
  s = s.replace(/\\(?:left|right|big|Big|bigg|Bigg)\s*/g, '')
  s = s.replace(/\\begin\{[^{}]+\}|\\end\{[^{}]+\}/g, ' ')
  s = s.replace(/\\(?:,|;|!|quad|qquad|displaystyle|textstyle)\s*/g, '')
  s = s.replace(/\^\{([^{}]*)\}/g, '^($1)').replace(/_\{([^{}]*)\}/g, '_($1)')
  s = s.replace(/\\([A-Za-z]+)/g, (_m, name: string) => GREEK[name] ?? SYMBOLS[name] ?? name)
  s = s.replace(/[{}]/g, '').replace(/\\/g, '')
  s = s.replace(/&/g, ' ').replace(/\s+/g, ' ').trim()
  return s
}
