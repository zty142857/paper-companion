import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Block, Card, Highlight, Paper, ReadingPlan, Recommendation, SearchResult } from './api'
import PdfViewer, { HL_COLORS, HL_COLOR_NAMES } from './PdfViewer'
import type { FormulaRegion, SelectedText, ViewerHandle } from './PdfViewer'
import CardItem from './CardItem'
import Markdown from './Markdown'
import TermItem from './TermItem'
import SettingsModal from './SettingsModal'
import ProfileModal from './ProfileModal'
import PlanCard from './PlanCard'
import QuizModal from './QuizModal'
import { copyImage, copyText, latexToText, normalizeLatex, recognizeFormula } from './formulaOcr'

/** 标题数字编号的段数：1→1(篇)、1.1→2(章)、1.1.1→3(节)；无编号→0 */
function secDepth(title: string): number {
  const t = (title || '').trim()
  const m = t.match(/^(\d+(?:\.\d+)*)\.?\s/)
  if (m) return m[1].split('.').length
  // 罗马数字节（IEEE）：单字母（C./D./V.）正文须全大写才算罗马，否则是字母子节
  const rm = t.match(/^([IVXLCDM]{1,7})\.\s+(.*)$/)
  if (rm && (rm[1].length >= 2 || !/[a-z]/.test(rm[2]))) return 1
  if (/^[A-Z]\.\s+[A-Za-z(]/.test(t)) return 2            // 字母编号子节
  return 0
}

/** 未点击的术语小卡在 displayTops 里的键（与卡片 id 命名空间隔开） */
const chipKey = (term: string) => `chip:${term}`

export default function PaperView({ id }: { id: string }) {
  const [paper, setPaper] = useState<Paper | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [settings, setSettings] = useState(false)
  const [cards, setCards] = useState<Card[]>([])
  const [tops, setTops] = useState<Record<string, number>>({})
  const [displayTops, setDisplayTops] = useState<Record<string, number>>({})
  const [termTops, setTermTops] = useState<Record<string, number>>({})
  const [activeId, setActiveId] = useState<string | null>(null)
  const [tool, setTool] = useState<{ x: number; y: number; blockId: string } | null>(null)
  const [profile, setProfile] = useState(false)
  const [plan, setPlan] = useState<ReadingPlan | null>(null)
  const [showPlan, setShowPlan] = useState(false)
  const [planBusy, setPlanBusy] = useState(false)
  const [recBusy, setRecBusy] = useState(false)
  const [collected, setCollected] = useState(false)
  const [knownTerms, setKnownTerms] = useState<string[]>([])
  const [dismissedTerms, setDismissedTerms] = useState<string[]>([])
  const [recs, setRecs] = useState<Recommendation[] | null>(null)
  const [recScope, setRecScope] = useState('')
  const [recNote, setRecNote] = useState('')
  const [searchRes, setSearchRes] = useState<SearchResult[] | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [quiz, setQuiz] = useState(false)
  const [atEnd, setAtEnd] = useState(false)
  const [steps, setSteps] = useState<{ blockId: string; text: string }[]>([])
  const [sectionsOpen, setSectionsOpen] = useState(() => {
    try { return localStorage.getItem('pc.sectionsOpen') !== '0' } catch { return true }
  })
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [selected, setSelected] = useState<SelectedText | null>(null)
  const [hlMenu, setHlMenu] = useState<{ id: string; color: string; x: number; y: number } | null>(null)
  const [formulaBusy, setFormulaBusy] = useState(false)
  const [formulaStep, setFormulaStep] = useState('')
  const [formulaErr, setFormulaErr] = useState('')
  const [formulaResult, setFormulaResult] = useState<{
    latex: string; text: string; blob: Blob; x: number; y: number
  } | null>(null)
  const [formulaCopied, setFormulaCopied] = useState('')
  const [formulaWrap, setFormulaWrap] = useState(true)
  const [findOpen, setFindOpen] = useState(false)
  const [findQ, setFindQ] = useState('')
  const [findHits, setFindHits] = useState<{ blockId: string; page: number; snippet: string; count: number }[] | null>(null)
  const viewer = useRef<ViewerHandle | null>(null)
  const leftRail = useRef<HTMLDivElement>(null)
  const rightRail = useRef<HTMLDivElement>(null)
  const onReady = useCallback((h: ViewerHandle) => { viewer.current = h }, [])

  const loadProfile = useCallback(() => {
    api.profile(id).then((d) => {
      setCollected(!!d.meta?.collected)
      setKnownTerms(d.meta?.known_terms ?? [])
      setDismissedTerms(d.meta?.dismissed_terms ?? [])
      setPlan(d.meta?.plan ?? null)
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    setPaper(null); setErr(''); setCards([]); setTops({})
    setPlan(null); setShowPlan(false); setRecs(null); setSearchRes(null); setSteps([])
    setRecNote('')
    setDismissedTerms([])
    setHighlights([]); setSelected(null); setHlMenu(null)
    setFormulaBusy(false); setFormulaStep(''); setFormulaErr(''); setFormulaResult(null); setFormulaCopied('')
    setFindOpen(false); setFindHits(null); setFindQ('')
    api.get(id).then(setPaper).catch((e) => setErr(String(e?.message || e)))
    api.cards(id).then(setCards).catch(() => {})
    api.highlights(id).then(setHighlights).catch(() => {})
    api.profile(id).then((d) => {
      setCollected(!!d.meta?.collected)
      setKnownTerms(d.meta?.known_terms ?? [])
      setDismissedTerms(d.meta?.dismissed_terms ?? [])
      if (d.meta?.plan) setPlan(d.meta.plan)
      if (!d.meta?.domain) setProfile(true)   // 未做过摸底 → 上传后立即弹问卷
    }).catch(() => {})
  }, [id])

  useEffect(() => {
    try { localStorage.setItem('pc.sectionsOpen', sectionsOpen ? '1' : '0') } catch { /* ignore */ }
  }, [sectionsOpen])

  // 点空白处收起标亮调色板 / 高亮操作菜单 / 公式弹窗
  useEffect(() => {
    if (!selected && !hlMenu && !formulaResult) return
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.sel-palette') || t.closest('.hl-menu') || t.closest('.formula-pop')) return
      setSelected(null); setHlMenu(null); setFormulaResult(null)
      viewer.current?.clearSelection()
    }
    addEventListener('mousedown', down)
    return () => removeEventListener('mousedown', down)
  }, [selected, hlMenu, formulaResult])

  const analyze = async () => {
    setBusy(true); setErr('')
    try { const a = await api.analyze(id); setPaper((p) => p && { ...p, analysis: a }) }
    catch (e: any) { setErr(`导读失败：${e?.message || e}`) }
    finally { setBusy(false) }
  }

  const genPlan = async () => {
    if (planBusy) return
    setPlanBusy(true); setErr('')
    try { setPlan(await api.makePlan(id)); setShowPlan(true) }
    catch (e: any) { setErr(`计划生成失败：${e?.message || e}`) }
    finally { setPlanBusy(false) }
  }

  // 点「阅读计划」：有已保存计划则直接展示，否则生成
  const openPlan = () => {
    if (plan) { setShowPlan(true); return }
    genPlan()
  }

  const toggleCollect = async () => {
    const v = !collected
    setCollected(v)
    try { await api.collect(id, v) } catch { setCollected(!v) }
  }

  const doRecommend = async () => {
    if (recBusy) return
    setRecBusy(true); setErr('')
    try {
      const d = await api.recommend(id)
      setRecs(d.items); setRecScope(d.scope_label || ''); setRecNote(d.note || '')
    } catch (e: any) { setErr(`推荐失败：${e?.message || e}`) }
    finally { setRecBusy(false) }
  }

  const doSearch = async () => {
    if (!query.trim()) return
    setSearchBusy(true); setErr('')
    try { setSearchRes((await api.search({ q: query, source: 'both' })).results) }
    catch (e: any) { setErr(String(e?.message || e)) }
    finally { setSearchBusy(false) }
  }

  const blocks = useMemo(() => paper?.structure.blocks ?? [], [paper?.structure.blocks])
  const blockMap: Record<string, Block> = useMemo(
    () => Object.fromEntries(blocks.map((b) => [b.id, b])), [blocks])

  // 把后端解析出的 formula 块（以及含 PUA 的公式片段）按页聚类成整段公式 bbox。
  // 公式框选时用它吸附到完整公式，避免把上下正文裁进 OCR。
  const formulaRegions = useMemo(() => {
    const isFormula = (b: Block) => {
      if (b.type === 'formula') return true
      const t = b.text || ''
      if (!/[\uE000-\uF8FF]/.test(t)) return false
      const nonSpace = t.replace(/\s/g, '').length
      const mathChars = (t.match(/[\uE000-\uF8FF=+−×÷∑∫√≈≤≥θαβγδλμπσφωΔΩ∂∞]/g) || []).length
      return nonSpace > 0 && mathChars / nonSpace > 0.25
    }
    const groups: FormulaRegion[] = []
    for (const b of blocks) {
      if (!isFormula(b)) continue
      const g = groups.find((x) => x.page === b.page
        && b.y0 <= x.y1 + 4 && b.y1 >= x.y0 - 1
        && b.x0 <= x.x1 + 6 && b.x1 >= x.x0 - 6)
      if (g) {
        g.x0 = Math.min(g.x0, b.x0); g.y0 = Math.min(g.y0, b.y0)
        g.x1 = Math.max(g.x1, b.x1); g.y1 = Math.max(g.y1, b.y1)
      } else {
        groups.push({ page: b.page, x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 })
      }
    }
    return groups.filter((g) => g.x1 - g.x0 > 8 && g.y1 - g.y0 > 4)
  }, [blocks])

  // 双栏页的 col=0 内容归左轨；单栏页（或单栏论文）全部归右轨。
  const pageCols = useMemo(() => {
    const m = new Map<number, Set<number>>()
    for (const b of blocks) {
      if (b.type !== 'para' && b.type !== 'heading') continue
      if (!m.has(b.page)) m.set(b.page, new Set())
      m.get(b.page)!.add(b.col)
    }
    return m
  }, [blocks])
  const sideOf = useCallback((blockId?: string | null): 'left' | 'right' => {
    const b = blockId ? blockMap[blockId] : null
    if (!b) return 'right'
    const cols = pageCols.get(b.page)
    return cols && cols.size >= 2 && b.col === 0 ? 'left' : 'right'
  }, [blockMap, pageCols])

  // 已懂术语匹配：忽略大小写/空格，并支持中英文任意一侧命中
  const norm = (s: string) => s.toLowerCase().replace(/[\s()（）\-]/g, '')
  const visibleTerms = useMemo(() => {
    const knownNorm = knownTerms.map(norm)
    const isKnown = (t: { term: string; zh: string }) => {
      const a = norm(t.term), b = norm(t.zh)
      return knownNorm.some((k) => k && (a.includes(k) || k.includes(a) || b.includes(k) || k.includes(b)))
    }
    return (paper?.analysis?.terms ?? [])
      .filter((t) => !isKnown(t) && !dismissedTerms.includes(t.term))
  }, [paper?.analysis, knownTerms, dismissedTerms])
  const visibleTermsRef = useRef(visibleTerms)
  visibleTermsRef.current = visibleTerms

  const anchorTop = useCallback((card: Card): number => {
    const b = blockMap[card.block_id]
    const r = rightRail.current || leftRail.current
    if (b && viewer.current && r) {
      const t = viewer.current.blockTop(b.page, b.y0, r)
      if (t != null) return t + (card.data.offset ?? 0)
    }
    return card.top
  }, [blockMap])
  const recompute = useCallback(() => {
    setTops(Object.fromEntries(cards.map((c) => [c.id, anchorTop(c)])))
    // 术语小卡锚定到其首个出现块
    const r = rightRail.current || leftRail.current
    if (viewer.current && r) {
      const rt: Record<string, number> = {}
      for (const t of visibleTermsRef.current) {
        const b = blockMap[t.refs.find((x) => blockMap[x]) ?? '']
        const top = b ? viewer.current.blockTop(b.page, b.y0, r) : null
        if (top != null) rt[t.term] = top
      }
      setTermTops(rt)
    }
  }, [cards, anchorTop, blockMap, visibleTerms])
  useEffect(() => { recompute() }, [recompute])
  // 防重叠：左右轨分别按锚定 top 排序依次下推，写入独立的 displayTops
  // （不覆盖锚点，避免与 recompute 互相覆盖）
  useLayoutEffect(() => {
    const next: Record<string, number> = {}
    for (const el of [leftRail.current, rightRail.current]) {
      if (!el) continue
      const items: { key: string; h: number; top: number }[] = []
      const loose: { key: string; h: number }[] = []   // 锚点还没算出来的小卡，排队尾
      for (const c of el.querySelectorAll<HTMLElement>('.card, .term-chip')) {
        if (c.dataset.id) {
          const top = tops[c.dataset.id] ?? (c.dataset.term ? termTops[c.dataset.term] : null) ?? parseFloat(c.style.top)
          if (Number.isFinite(top)) items.push({ key: c.dataset.id, h: c.offsetHeight, top })
        } else if (c.dataset.term) {
          const top = termTops[c.dataset.term]
          if (top != null) items.push({ key: chipKey(c.dataset.term), h: c.offsetHeight, top })
          else loose.push({ key: chipKey(c.dataset.term), h: c.offsetHeight })
        }
      }
      items.sort((a, b) => a.top - b.top)
      let prev = 0
      for (const it of items) {
        const t = Math.max(it.top, prev + 10)
        next[it.key] = t
        prev = t + it.h
      }
      for (const it of loose) {
        next[it.key] = prev + 10
        prev += it.h + 10
      }
    }
    let changed = Object.keys(next).length !== Object.keys(displayTops).length
    if (!changed) {
      for (const k of Object.keys(next)) {
        if (Math.abs((displayTops[k] ?? -1) - next[k]) > 0.5) { changed = true; break }
      }
    }
    if (changed) setDisplayTops(next)
  }, [tops, termTops, cards, blocks, visibleTerms, displayTops])
  useEffect(() => {
    const f = () => recompute()
    addEventListener('resize', f)
    return () => removeEventListener('resize', f)
  }, [recompute])
  // 读到全篇末尾 → 提示自测
  useEffect(() => {
    const el = document.querySelector('.flow') as HTMLElement | null
    if (!el) return
    const onScroll = () => {
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) setAtEnd(true)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [paper])

  const addCard = async (type: string, blockId: string, data: any) => {
    const b = blockMap[blockId]
    const r = rightRail.current || leftRail.current
    const top = b && viewer.current && r
      ? (viewer.current.blockTop(b.page, b.y0, r) ?? 0) : 0
    const { id: cid } = await api.addCard(id, { type, block_id: blockId, top, data })
    const c: Card = { id: cid, paper_id: id, type, block_id: blockId, top, data, created_at: Date.now() / 1000 }
    setCards((cs) => [...cs, c])
    setTops((t) => ({ ...t, [cid]: top }))
    return c
  }

  const doTranslate = async (blockId: string) => {
    setTool(null)
    const orig = blockMap[blockId]?.text.slice(0, 160)
    const c = await addCard('translation', blockId, { orig, pending: true })
    try {
      const r = await api.translate(id, blockId)
      const data = { ...c.data, translation: r.translation, page: r.page, pending: false }
      setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      api.patchCard(c.id, { data })
    } catch (e: any) {
      const data = { ...c.data, pending: false, error: String(e?.message || e) }
      setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      api.patchCard(c.id, { data })
    }
  }

  const askChat = async (card: Card, question: string) => {
    const msgs: any[] = card.data.messages ?? []
    const next = [...msgs, { role: 'user', content: question }]
    setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, data: { ...c.data, messages: next } } : c))
    const anchor = card.block_id
    try {
      const r = await api.chat(id, {
        block_ids: card.data.block_ids ?? [card.block_id].filter(Boolean),
        history: next, question,
      })
      if (r.steps?.length) {
        setSteps((s) => [...s, ...r.steps!.map((st) => ({ blockId: anchor, text: st.text }))])
      }
      const done = [...next, { role: 'assistant', content: r.answer, refs: r.refs, pages: r.pages }]
      setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, data: { ...c.data, messages: done } } : c))
      api.patchCard(card.id, { data: { ...card.data, messages: done } })
    } catch (e: any) {
      const done = [...next, { role: 'assistant', content: `请求失败：${e?.message || e}` }]
      setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, data: { ...c.data, messages: done } } : c))
    }
  }

  const dropCard = async (card: Card, top: number, side: 'left' | 'right') => {
    const r = rightRail.current || leftRail.current
    if (!viewer.current || !r) return
    let best: Block | null = null; let bestD = 1e9
    for (const b of blocks) {
      if (b.type === 'figure' || sideOf(b.id) !== side) continue
      const t = viewer.current.blockTop(b.page, b.y0, r)
      if (t == null) continue
      const d = Math.abs(t - top)
      if (d < bestD) { bestD = d; best = b }
    }
    if (!best) return
    const bt = viewer.current.blockTop(best.page, best.y0, r)!
    const data = { ...card.data, offset: top - bt }
    setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, block_id: best!.id, top, data } : c))
    api.patchCard(card.id, { block_id: best.id, top, data })
  }

  const addChat = async (blockId: string, question?: string) => {
    setTool(null)
    const c = await addCard('chat', blockId, { block_ids: [blockId], messages: [] })
    if (question) askChat(c, question)
  }

  // 全篇提问：不绑定具体段落（block_ids 为空 → 后端喂全文导读/开头画像 + 目录）。
  // blockId 仅决定卡片锚在哪段旁边（工具条入口=点击的段落；顶栏入口=首个文字块），不进上下文
  const addChatGlobal = async (blockId?: string) => {
    setTool(null)
    const anchor = blockId ?? blocks.find((b) => b.type === 'para' || b.type === 'heading')?.id
    if (!anchor) return
    await addCard('chat', anchor, { block_ids: [], messages: [], global: true })
  }

  const addNote = async (blockId: string) => {
    setTool(null)
    await addCard('note', blockId, { text: '' })
  }

  // ---------- 公式识别 ----------
  const runFormula = async (blob: Blob, x: number, y: number) => {
    if (formulaBusy) return
    setFormulaErr('')
    setFormulaCopied('')
    setFormulaBusy(true)
    setFormulaStep('正在识别公式…')
    try {
      const raw = await recognizeFormula(blob, (p) => {
        if (p.progress != null) setFormulaStep(`加载公式模型 ${Math.round(p.progress)}%`)
        else if (p.file) setFormulaStep('加载公式模型…')
      })
      const latex = normalizeLatex(raw)
      if (!latex) throw new Error('没有识别出公式，请重新框选')
      setFormulaResult({ latex, text: latexToText(latex), blob, x, y })
      window.getSelection()?.removeAllRanges()
    } catch (e: any) {
      const msg = String(e?.message || e)
      setFormulaErr(/formulanet|local|fetch|404|model/i.test(msg)
        ? '公式模型未加载，请先在 frontend 目录运行 npm run model:download，然后重试'
        : msg)
    } finally {
      setFormulaBusy(false)
      setFormulaStep('')
    }
  }

  const doFormula = async () => {
    if (!selected || formulaBusy || !viewer.current) return
    const s = selected
    const ys = s.rects.flatMap((r) => [r[1], r[3]])
    if (ys.length && Math.max(...ys) - Math.min(...ys) > 0.10) {
      setSelected(null)
      window.getSelection()?.removeAllRanges()
      setFormulaErr('选区跨了多行/多段。请点 PDF 上方的「∑ 框选公式」，只框住一个公式。')
      return
    }
    setSelected(null)
    setFormulaStep('正在截取选区…')
    try {
      const blob = await viewer.current.selectionImage(s)
      if (!blob) throw new Error('选区太小，无法截取公式')
      await runFormula(blob, s.x, s.y)
    } catch (e: any) {
      setFormulaErr(String(e?.message || e))
      setFormulaBusy(false)
      setFormulaStep('')
    }
  }

  const formulaCrop = (blob: Blob, x: number, y: number) => {
    setSelected(null)
    void runFormula(blob, x, y)
  }

  const copyFormula = async (kind: 'latex' | 'text' | 'image') => {
    if (!formulaResult) return
    try {
      if (kind === 'image') await copyImage(formulaResult.blob)
      else {
        const text = kind === 'latex'
          ? (formulaWrap ? `$$${formulaResult.latex}$$` : formulaResult.latex)
          : formulaResult.text
        await copyText(text)
      }
      setFormulaCopied(kind)
      window.setTimeout(() => setFormulaCopied(''), 1600)
    } catch (e: any) {
      setFormulaErr(`复制失败：${String(e?.message || e)}`)
    }
  }

  // ---------- 标亮 ----------
  const saveHighlight = async (color: string) => {
    if (!selected) return
    const s = selected
    setSelected(null)
    viewer.current?.clearSelection()
    window.getSelection()?.removeAllRanges()
    try {
      const h = await api.addHighlight(id, { page: s.page, color, text: s.text, rects: s.rects })
      setHighlights((hs) => [...hs, h])
    } catch (e: any) { setErr(`标亮保存失败：${e?.message || e}`) }
  }

  const changeHighlight = async (color: string) => {
    if (!hlMenu) return
    const m = hlMenu
    setHlMenu(null)
    setHighlights((hs) => hs.map((h) => h.id === m.id ? { ...h, color } : h))
    try { await api.setHighlightColor(m.id, color) }
    catch (e: any) {
      setHighlights((hs) => hs.map((h) => h.id === m.id ? { ...h, color: m.color } : h))
      setErr(`标亮改色失败：${e?.message || e}`)
    }
  }

  const removeHighlight = async () => {
    if (!hlMenu) return
    const m = hlMenu
    setHlMenu(null)
    setHighlights((hs) => hs.filter((h) => h.id !== m.id))
    try { await api.deleteHighlight(m.id) }
    catch (e: any) { setErr(`删除标亮失败：${e?.message || e}`); api.highlights(id).then(setHighlights).catch(() => {}) }
  }

  // ---------- 本篇全文检索 ----------
  const runFind = (q?: string) => {
    const raw = (q ?? findQ).trim()
    if (!raw) { setFindHits(null); return }
    const terms = raw.toLowerCase().split(/\s+/).filter(Boolean)
    const hits = []
    for (const b of blocks) {
      const text = b.text || ''
      const low = text.toLowerCase()
      if (!terms.every((t) => low.includes(t))) continue
      let first = Infinity
      let count = 0
      for (const t of terms) {
        const i = low.indexOf(t)
        if (i >= 0) first = Math.min(first, i)
        let at = low.indexOf(t)
        while (at >= 0) { count++; at = low.indexOf(t, at + t.length) }
      }
      if (!Number.isFinite(first)) continue
      const start = Math.max(0, first - 40)
      hits.push({ blockId: b.id, page: b.page,
        snippet: text.slice(start, first + raw.length + 80), count })
    }
    setFindHits(hits.slice(0, 100))
  }

  const goFind = (h: { page: number }) => {
    setFindOpen(false)
    viewer.current?.scrollToPage(h.page)
    const q = findQ.trim().split(/\s+/)[0]
    window.setTimeout(() => viewer.current?.flashText(h.page, q), 420)
  }

  // 找到某术语背后已持久化的解释卡
  const termCard = useCallback((term: string): Card | undefined =>
    cards.find((c) => c.type === 'term' && c.data.term === term), [cards])

  // 点击术语小卡：展开为解释卡；首次展开时按需生成解释
  const expandTerm = async (t: { term: string; zh: string; refs: string[] }) => {
    const existing = termCard(t.term)
    if (existing) {
      const data = { ...existing.data, collapsed: false }
      setCards((cs) => cs.map((x) => x.id === existing.id ? { ...x, data } : x))
      api.patchCard(existing.id, { data })
      return
    }
    const anchor = t.refs.find((r) => blockMap[r]) ?? blocks[0]?.id
    if (!anchor) return
    const c = await addCard('term', anchor, { term: t.term, zh: t.zh, block_ids: t.refs, pending: true, collapsed: false, messages: [] })
    try {
      const r = await api.explainTerm(id, { term: t.term, zh: t.zh, refs: t.refs })
      const data = { ...c.data, zh: r.zh || t.zh, expl: r.expl, pages: r.pages, block_ids: r.refs.length ? r.refs : t.refs, pending: false }
      setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      api.patchCard(c.id, { data })
    } catch (e: any) {
      const data = { ...c.data, pending: false, error: String(e?.message || e) }
      setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      api.patchCard(c.id, { data })
    }
  }

  const collapseTerm = (card: Card) => {
    const data = { ...card.data, collapsed: true }
    setCards((cs) => cs.map((x) => x.id === card.id ? { ...x, data } : x))
    api.patchCard(card.id, { data })
  }

  // 删除术语小卡：隐藏该术语（持久化），并删除其解释卡
  const dismissTerm = async (t: { term: string; refs: string[] }) => {
    const c = termCard(t.term)
    if (c) { api.delCard(c.id); setCards((cs) => cs.filter((x) => x.id !== c.id)) }
    setDismissedTerms((ds) => [...ds, t.term])
    try { await api.dismissTerm(id, t.term) } catch { /* 失败也不阻塞 UI */ }
    // 删除解释卡后，若存在对应锚定不再显示
    void t.refs
  }

  if (err && !paper) return <div className="home"><div className="err">{err}</div>
    <button className="btn" onClick={() => (location.hash = '')}>返回</button></div>
  if (!paper) return <div className="home"><div className="loading">加载中…</div></div>

  const { structure, analysis } = paper
  const outlineMap = Object.fromEntries((analysis?.outlines ?? []).map((o) => [o.section_id, o.outline]))
  const jump = (p?: number) => { if (p) viewer.current?.scrollToPage(p) }

  const termSide = (t: { refs: string[] }) => sideOf(t.refs.find((r) => blockMap[r]))
  const leftTerms = visibleTerms.filter((t) => termSide(t) === 'left')
  const rightTerms = visibleTerms.filter((t) => termSide(t) !== 'left')
  const leftCards = cards.filter((c) => c.type !== 'term' && sideOf(c.block_id) === 'left')
  const rightCards = cards.filter((c) => c.type !== 'term' && sideOf(c.block_id) !== 'left')

  const renderTerm = (t: (typeof visibleTerms)[number]) => (
    <TermItem key={t.term} term={t.term} zh={t.zh}
      top={(() => { const c = termCard(t.term); return c ? (displayTops[c.id] ?? tops[c.id] ?? termTops[t.term] ?? 0) : (displayTops[chipKey(t.term)] ?? termTops[t.term] ?? 0) })()}
      card={termCard(t.term)}
      onExpand={() => expandTerm(t)}
      onCollapse={() => { const c = termCard(t.term); if (c) collapseTerm(c) }}
      onDelete={() => dismissTerm(t)}
      onTop={(v) => { const c = termCard(t.term); if (c) setTops((ts) => ({ ...ts, [c.id]: v })) }}
      onDrop={(v) => { const c = termCard(t.term); if (c) dropCard(c, v, termSide(t)) }}
      onJump={jump} />
  )

  const renderCard = (c: Card, side: 'left' | 'right') => (
    <CardItem key={c.id} card={c} top={displayTops[c.id] ?? tops[c.id] ?? c.top}
      maxWidth={side === 'left' ? 300 : 640}
      active={activeId === c.id}
      onActivate={() => setActiveId(c.id)}
      onTop={(t) => setTops((ts) => ({ ...ts, [c.id]: t }))}
      onDrop={(t) => dropCard(c, t, side)}
      onDelete={() => { api.delCard(c.id); setCards((cs) => cs.filter((x) => x.id !== c.id)) }}
      onAsk={(q) => askChat(c, q)}
      onJump={jump}
      onResize={(w) => {
        const data = { ...c.data, width: w }
        setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      }}
      onResizeEnd={(w) => api.patchCard(c.id, { data: { ...c.data, width: w } })}
      onPatch={(data) => {
        setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
        api.patchCard(c.id, { data })
      }} />
  )

  return (
    <>
      <div className="topbar">
        <button className="btn small" onClick={() => (location.hash = '')}>←</button>
        <div className="title">{paper.title || paper.filename}</div>
        <button className={`btn small${sectionsOpen ? ' primary' : ''}`} onClick={() => setSectionsOpen((v) => !v)}
          title={sectionsOpen ? '收起章节概要侧边栏' : '展开章节概要侧边栏'}>☰ 章节</button>
        <button className="btn small" onClick={() => setFindOpen(true)} title="在当前论文全文中检索">🔍 全文检索</button>
        <button className={`btn small${collected ? ' primary' : ''}`} onClick={toggleCollect}
          title={collected ? '取消收藏' : '加入文献库（参与推荐与综述）'}>
          {collected ? '★ 已收藏' : '☆ 收藏'}</button>
        <button className="btn" onClick={() => setProfile(true)}>摸底</button>
        <button className="btn" disabled={planBusy} onClick={openPlan}>
          {planBusy ? '计划生成中…' : '阅读计划'}</button>
        {!analysis && <button className="btn primary" onClick={analyze} disabled={busy}>
          {busy ? '导读生成中（约1分钟）…' : '生成全文导读'}</button>}
        {analysis && <button className="btn" onClick={analyze} disabled={busy}>{busy ? '生成中…' : '重新生成导读'}</button>}
        <button className="btn" onClick={() => setQuiz(true)}>全篇自测</button>
        <button className="btn" onClick={() => addChatGlobal()} title="不绑定具体段落，让学伴基于全文导读与目录回答">问全篇</button>
        <button className="btn" disabled={recBusy} onClick={doRecommend}>
          {recBusy ? '推荐中（约1分钟）…' : '推荐'}</button>
        <button className="btn" onClick={() => setSettings(true)}>设置</button>
      </div>
      <div className="flow" onClick={() => tool && setTool(null)}>
        <section className="guide">
          <h3>全文导读 <span className="hint">读完向下滚动，进入论文原版面精读；点击正文段落可翻译或提问</span></h3>
          {err && <div className="err">{err}</div>}
          {(plan || recs) && <div className="panels">
            {plan && showPlan && <PlanCard pid={id} plan={plan} onUpdate={setPlan}
              onRegenerate={genPlan} onClose={() => setShowPlan(false)}
              onConfirm={() => {
                // 确认计划后自动生成导读（含术语提取/章节概要）；已有导读则不覆盖
                setShowPlan(false)
                if (!paper?.analysis) analyze()
              }} />}
            {recs && <div className="plancard">
              <div className="ph"><span className="ico">📚</span><span className="pt">文献推荐</span>
                <button className="x" onClick={() => setRecs(null)}>✕</button></div>
              <div className="pb">
                {recScope && <div className="rec-scope">推荐范围：{recScope}</div>}
                {recs.map((r) => <div key={r.title + r.doi} className="rec">
                  <div className="rt">{r.title}</div>
                  {r.query && <div className="rec-suggest">检索关键词：{r.query}</div>}
                  <div className="rr">{r.reason}</div>
                  <div className="rec-meta">
                    {r.doi
                      ? <a href={r.url || `https://doi.org/${r.doi}`} target="_blank" rel="noreferrer">DOI: {r.doi}</a>
                      : <span className="muted">暂无 DOI</span>}
                    {r.year && <span className="muted"> · {r.year}</span>}
                    {r.venue && <span className="muted"> · {r.venue}</span>}
                    {r.source && <span className="badge">{r.source}</span>}
                  </div>
                </div>)}
                {!recs.length && <div className="empty">{recNote || '暂无推荐'}</div>}
              </div>
            </div>}
          </div>}
          {!analysis && !busy && <div className="empty">点击顶部「生成全文导读」。导读按 研究问题 / 方法 / 创新点 / 实验 / 局限 等要素拆解，
            自动提取术语卡，并标注原文页码可点击跳转。</div>}
          <div className="searchbar">
            <input value={query} placeholder="检索相关文献（arXiv / Semantic Scholar）…"
              onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && doSearch()} />
            <button className="btn small" disabled={searchBusy} onClick={doSearch}>
              {searchBusy ? '检索中…' : '检索'}</button>
          </div>
          {searchRes && <div className="searchres">
            {searchRes.map((r, i) => (
              <div key={i} className="sr">
                <div className="st">
                  <span className="badge">{r.source}</span> {r.title}
                  {r.year && <span className="sy">{r.year}</span>}
                </div>
                {r.abstract && <div className="sa">{r.abstract}</div>}
                {r.url && <a href={r.url} target="_blank" rel="noreferrer">查看原文 ↗</a>}
              </div>
            ))}
            {!searchRes.length && <div className="empty">未找到相关文献（Semantic Scholar 可能限流，可稍后重试）</div>}
          </div>}
          {busy && !analysis && <div className="loading">正在通读全文并生成导读（含术语提取与事实自查）…</div>}
          <div className="grid">
            {analysis?.elements.map((e) => (
              <div className="el" key={e.kind}>
                <div className="k">{e.kind}{e.checked && <span className="ok" title="已对照原文核查">✓ 已自查</span>}</div>
                <div className="x">{e.text}</div>
                <div className="src">
                  {e.pages.map((p) => <button key={p} onClick={() => jump(p)}>📄 第{p}页</button>)}
                </div>
              </div>
            ))}
          </div>
        </section>
        <aside className={`sections-panel${sectionsOpen ? ' open' : ''}`}>
          <div className="sp-head">
            <h3>章节导航 · 概要</h3>
            <button className="x" title="收起侧边栏" onClick={() => setSectionsOpen(false)}>«</button>
          </div>
          <div className="nav">
            {structure.sections.filter((s) => !s.is_references).map((s) => {
              const d = secDepth(s.title)      // 1=篇 2=章 3=节，无编号=0
              return (
                <div key={s.id} className={`sec d${d}`} onClick={() => jump(s.page)} title={`第 ${s.page} 页`}
                  style={d > 0 ? { paddingLeft: 10 + (d - 1) * 14 } : undefined}>
                  <div className={d <= 1 ? 'lv1' : 'lv2'}>{s.title}</div>
                  {outlineMap[s.id] && <div className="o">{outlineMap[s.id]}</div>}
                </div>
              )
            })}
          </div>
        </aside>
        <div className="reader">
          <aside className="rail left" ref={leftRail}>
            {leftTerms.map(renderTerm)}
            {leftCards.map((c) => renderCard(c, 'left'))}
          </aside>
          <PdfViewer url={`/api/papers/${id}/pdf`} blocks={blocks} onReady={onReady}
            onLayout={recompute}
            onBlockClick={(blockId, x, y) => setTool({ blockId, x, y })}
            highlights={highlights}
            onSelectText={setSelected}
            onFormulaCrop={formulaCrop}
            formulaRegions={formulaRegions}
            onHighlightClick={(h, x, y) => setHlMenu({ id: h.id, color: h.color, x, y })} />
          <aside className="rail right" ref={rightRail}>
            {steps.map((s, i) => (
              <div key={i} className="agent-step">🔍 {s.text}</div>
            ))}
            {rightTerms.map(renderTerm)}
            {rightCards.map((c) => renderCard(c, 'right'))}
          </aside>
        </div>
      </div>
      {tool && (
        <div className="toolbar-pop" style={{ left: Math.min(tool.x + 8, innerWidth - 300), top: Math.min(tool.y + 8, innerHeight - 60) }}>
          <button onClick={() => doTranslate(tool.blockId)}>🈶 翻译此段</button>
          <button onClick={() => addChat(tool.blockId)}>💬 就此段提问</button>
          <button onClick={() => addChatGlobal(tool.blockId)} title="卡片仍锚在这段旁，但回答基于全文导读与目录，不局限于本段">🌐 问全文</button>
          <button onClick={() => addChat(tool.blockId, '用通俗的话讲讲这段在说什么')}> 通俗讲解</button>
          <button onClick={() => addNote(tool.blockId)}>📝 记笔记</button>
        </div>
      )}
      {selected && (
        <div className="sel-palette"
          style={{ left: Math.max(8, Math.min(selected.x + 8, innerWidth - 320)), top: Math.max(8, Math.min(selected.y + 10, innerHeight - 52)) }}>
          <button className="formula-btn" title="识别选中的单个公式；如果选区跨多行，请用 PDF 上方的「∑ 框选公式」"
            onClick={doFormula}>∑ 公式</button>
          <span className="sp-label">标亮</span>
          {Object.entries(HL_COLORS).map(([key, color]) => (
            <button key={key} className="color-dot" title={HL_COLOR_NAMES[key]}
              style={{ background: color }} onClick={() => saveHighlight(key)} />
          ))}
          <button className="x" title="取消"
            onClick={() => { setSelected(null); viewer.current?.clearSelection(); window.getSelection()?.removeAllRanges() }}>✕</button>
        </div>
      )}
      {(formulaBusy || formulaErr) && (
        <div className="formula-toast">
          <span>{formulaBusy ? (formulaStep || '正在识别公式…') : `公式识别失败：${formulaErr}`}</span>
          {!formulaBusy && <button className="x" onClick={() => setFormulaErr('')}>✕</button>}
        </div>
      )}
      {formulaResult && (
        <div className="formula-pop"
          style={{
            left: Math.max(10, Math.min(formulaResult.x + 8, innerWidth - 380)),
            top: Math.max(10, Math.min(formulaResult.y + 10, innerHeight - 420)),
          }}>
          <div className="fp-head">
            <span>∑ 公式识别</span>
            <button className="x" title="关闭" onClick={() => setFormulaResult(null)}>✕</button>
          </div>
          <div className="fp-preview"><Markdown text={`$$${formulaResult.latex}$$`} /></div>
          <textarea className="fp-code" value={formulaResult.latex} spellCheck={false}
            onChange={(e) => {
              const latex = e.target.value
              setFormulaResult({ ...formulaResult, latex, text: latexToText(latex) })
            }} />
          <div className="fp-actions">
            <label className="fp-wrap" title="勾选后复制为 $$...$$，可直接粘进笔记/对话渲染">
              <input type="checkbox" checked={formulaWrap} onChange={(e) => setFormulaWrap(e.target.checked)} />
              带 $$ 定界符
            </label>
            <button className="btn small primary" onClick={() => copyFormula('latex')}>
              {formulaCopied === 'latex' ? '已复制 LaTeX' : '复制 LaTeX'}
            </button>
            <button className="btn small" onClick={() => copyFormula('text')}>
              {formulaCopied === 'text' ? '已复制纯文本' : '复制纯文本'}
            </button>
            <button className="btn small" onClick={() => copyFormula('image')}>
              {formulaCopied === 'image' ? '已复制图片' : '复制图片'}
            </button>
          </div>
        </div>
      )}
      {hlMenu && (
        <div className="hl-menu"
          style={{ left: Math.min(hlMenu.x + 6, innerWidth - 200), top: Math.min(hlMenu.y + 10, innerHeight - 60) }}>
          {Object.entries(HL_COLORS).map(([key, color]) => (
            <button key={key} className={`color-dot${hlMenu.color === key ? ' on' : ''}`}
              title={`改为${HL_COLOR_NAMES[key]}`} style={{ background: color }}
              onClick={() => changeHighlight(key)} />
          ))}
          <button className="btn small danger" onClick={removeHighlight}>删除</button>
        </div>
      )}
      {findOpen && <div className="modal-bg" onClick={() => setFindOpen(false)}>
        <div className="modal find-modal" onClick={(e) => e.stopPropagation()}>
          <h2>全文检索</h2>
          <div className="searchbar">
            <input autoFocus value={findQ} placeholder="输入关键词，回车检索本篇全文…"
              onChange={(e) => setFindQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runFind()
                if (e.key === 'Escape') setFindOpen(false)
              }} />
            <button className="btn small primary" onClick={() => runFind()}>检索</button>
          </div>
          {findHits && <div className="find-hits">
            {findHits.length > 0
              ? findHits.map((h, i) => (
                <button key={`${h.blockId}-${i}`} className="find-hit" onClick={() => goFind(h)}>
                  <span className="fh-page">第 {h.page} 页</span>
                  <span className="fh-snip">{h.snippet}</span>
                  <span className="fh-count">{h.count} 处</span>
                </button>
              ))
              : <div className="empty">未找到「{findQ.trim()}」</div>}
          </div>}
          <div className="row">
            <button className="btn" onClick={() => setFindOpen(false)}>关闭</button>
          </div>
        </div>
      </div>}
      {atEnd && !quiz && (
        <div className="quiz-prompt" onClick={() => setQuiz(true)}>
          🎓 已读完全篇，来做 3 道自测检验掌握程度吧 →
          <button className="x" onClick={(e) => { e.stopPropagation(); setAtEnd(false) }}>稍后</button>
        </div>
      )}
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {profile && <ProfileModal pid={id} onClose={() => setProfile(false)}
        onDone={() => { setProfile(false); loadProfile(); genPlan() }} />}
      {quiz && <QuizModal pid={id} onJump={(p) => viewer.current?.scrollToPage(p)} onClose={() => setQuiz(false)} />}
    </>
  )
}
