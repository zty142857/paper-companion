import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import {
  Check, ChevronDown, ChevronLeft, ChevronUp, Copy, ExternalLink, FileText, Globe,
  GraduationCap, Languages, Library, Lightbulb, MessageCircle, MoveHorizontal,
  NotebookPen, Search, Sigma, Table2, X,
} from 'lucide-react'
import { api, TABLES_VERSION } from './api'
import type { Block, Card, Highlight, Paper, ReadingPlan, Recommendation, SearchResult, TableBox } from './api'
import PdfViewer, { HL_COLORS, HL_COLOR_NAMES } from './PdfViewer'
import type { FormulaRegion, SelectedText, ViewerHandle } from './PdfViewer'
import CardItem from './CardItem'
import Markdown from './Markdown'
import TermItem from './TermItem'
import Topbar from './Topbar'
import PlanCard from './PlanCard'
// 三个大弹窗懒加载：打开时才拉对应 chunk，工作台首包更小
const SettingsModal = lazy(() => import('./SettingsModal'))
const ProfileModal = lazy(() => import('./ProfileModal'))
const QuizModal = lazy(() => import('./QuizModal'))
import { copyImage, copyText, latexToText, normalizeLatex, recognizeFormula } from './formulaOcr'
import { useToast } from './components/Toast'
import { useConfirm } from './components/ConfirmDialog'
import { Skeleton, Spinner } from './components/Loading'

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

/** 订阅一条媒体查询；只在跨越断点时触发一次重渲染 */
function useMedia(query: string) {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches)
  useEffect(() => {
    const mq = window.matchMedia(query)
    const onChange = () => setMatches(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [query])
  return matches
}

/** 浮层定位：优先落在光标右下；靠近右缘/底部时向左/向上翻转，避免被视口压扁 */
function popPos(x: number, y: number, w: number, h: number, gap = 10) {
  const vw = window.innerWidth, vh = window.innerHeight
  let left = x + gap
  if (left + w > vw - 8) left = x - gap - w
  left = Math.max(8, Math.min(left, vw - w - 8))
  let top = y + gap
  if (top + h > vh - 8) top = y - gap - h
  top = Math.max(8, Math.min(top, vh - h - 8))
  return { left, top }
}

/** 流式回答的本地态：delta 增量 + 检索步骤；ac 用于区分同一卡片的新旧两次请求 */
interface ChatStream { text: string; steps: string[]; ac: AbortController }

export default function PaperView({ id }: { id: string }) {
  const toast = useToast()
  const confirm = useConfirm()
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
  const [translationMode, setTranslationMode] = useState(false)
  const [inlineTranslations, setInlineTranslations] = useState<Record<string, string>>({})
  const [translationPending, setTranslationPending] = useState<Record<string, boolean>>({})
  const [translationErrors, setTranslationErrors] = useState<Record<string, string>>({})
  const [showOriginal, setShowOriginal] = useState<Record<string, boolean>>({})
  const [batchTranslation, setBatchTranslation] = useState<{
    sectionId: string; title: string; total: number; done: number; failed: number; running: boolean
    stopped?: boolean
  } | null>(null)
  const [sectionMenu, setSectionMenu] = useState<{ sectionId: string; x: number; y: number } | null>(null)
  const translationSeq = useRef(0)
  const batchSeq = useRef(0)
  const batchStop = useRef(false)
  const translationAbort = useRef<AbortController | null>(null)
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
  // 流式回答按卡片 id 存放；done 后整体替换进卡片 data 并落库
  const [streams, setStreams] = useState<Record<string, ChatStream>>({})
  const chatAborts = useRef(new Map<string, AbortController>())
  const termAborts = useRef(new Map<string, AbortController>())
  const analyzeAbort = useRef<AbortController | null>(null)
  const planAbort = useRef<AbortController | null>(null)
  const recAbort = useRef<AbortController | null>(null)
  const analyzeTimers = useRef<number[]>([])
  const [analyzeStage, setAnalyzeStage] = useState('')
  const [sectionsOpen, setSectionsOpen] = useState(() => {
    try { return localStorage.getItem('pc.sectionsOpen') !== '0' } catch { return true }
  })
  // 略窄于 1600 时先挤压双轨；到 1400 以下才砍掉左轨
  const compact = useMedia('(max-width: 1599px)')
  const singleRail = useMedia('(max-width: 1399px)')
  const tooNarrow = useMedia('(max-width: 1149px)')
  const [narrowSections, setNarrowSections] = useState(false)
  const showSections = compact ? narrowSections : sectionsOpen
  const toggleSections = () => {
    if (compact) setNarrowSections((v) => !v)
    else setSectionsOpen((v) => !v)
  }
  const closeSections = () => {
    if (compact) setNarrowSections(false)
    else setSectionsOpen(false)
  }
  const [tipClosed, setTipClosed] = useState(false)
  const [highlights, setHighlights] = useState<Highlight[]>([])
  const [tables, setTables] = useState<TableBox[]>([])
  const [tablesLoading, setTablesLoading] = useState(false)
  const [tablesErr, setTablesErr] = useState('')
  const [tableTool, setTableTool] = useState<{ table: TableBox; x: number; y: number } | null>(null)
  const [tableView, setTableView] = useState<{ table: TableBox; blob: Blob; url: string; x: number; y: number } | null>(null)
  const [tableCopied, setTableCopied] = useState(false)
  const [tableBusy, setTableBusy] = useState(false)
  const [selected, setSelected] = useState<SelectedText | null>(null)
  const [selTrans, setSelTrans] = useState<{
    text: string; translation: string; error: string; pending: boolean
    x: number; y: number; page: number; blockId: string; saved: boolean
  } | null>(null)
  const [selTransCopied, setSelTransCopied] = useState(false)
  const selTransSeq = useRef(0)
  const searchSeq = useRef(0)
  const formulaSeq = useRef(0)
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
  const [findIdx, setFindIdx] = useState(0)
  const findInput = useRef<HTMLInputElement>(null)
  const flashRaf = useRef(0)
  const viewer = useRef<ViewerHandle | null>(null)
  const paperIdRef = useRef(id)
  paperIdRef.current = id
  const leftRail = useRef<HTMLDivElement>(null)
  const rightRail = useRef<HTMLDivElement>(null)
  const onReady = useCallback((h: ViewerHandle) => { viewer.current = h }, [])

  const clearAnalyzeTimers = () => {
    analyzeTimers.current.forEach((t) => window.clearTimeout(t))
    analyzeTimers.current = []
  }
  // 切论文/卸载时中止所有在途长任务，避免后台继续产生模型调用与串台响应
  const abortAll = () => {
    analyzeAbort.current?.abort(); analyzeAbort.current = null
    planAbort.current?.abort(); planAbort.current = null
    recAbort.current?.abort(); recAbort.current = null
    chatAborts.current.forEach((ac) => ac.abort()); chatAborts.current.clear()
    termAborts.current.forEach((ac) => ac.abort()); termAborts.current.clear()
    clearAnalyzeTimers()
    cancelAnimationFrame(flashRaf.current)
  }

  // 摸底档案只在挂载时拉一次（autoSurvey=true 才允许自动弹问卷），完成后刷新复用同一入口
  const loadProfile = useCallback((autoSurvey = false) => {
    const reqId = id
    api.profile(reqId).then((d) => {
      if (paperIdRef.current !== reqId) return
      setCollected(!!d.meta?.collected)
      setKnownTerms(Array.isArray(d.meta?.known_terms) ? d.meta.known_terms : [])
      setDismissedTerms(Array.isArray(d.meta?.dismissed_terms) ? d.meta.dismissed_terms : [])
      setPlan(d.meta?.plan ?? null)
      // 未做过摸底 → 上传后立即弹问卷；用户点过「稍后再说」的不再自动弹
      if (autoSurvey && !d.meta?.domain) {
        let dismissed = false
        try { dismissed = !!localStorage.getItem(`survey-dismissed:${reqId}`) } catch { /* ignore */ }
        if (!dismissed) setProfile(true)
      }
    }).catch(() => {})
  }, [id])

  const loadTables = useCallback(() => {
    const reqId = id
    setTablesLoading(true); setTablesErr('')
    api.tables(reqId).then((d) => {
      if (paperIdRef.current !== reqId) return   // 已切到别的论文，丢弃旧响应
      setTables(d.tables || [])
      setPaper((p) => p ? {
        ...p,
        structure: { ...p.structure, tables: d.tables, tables_version: d.version },
      } : p)
    }).catch((e: any) => {
      if (paperIdRef.current === reqId) setTablesErr(String(e?.message || e))
    }).finally(() => {
      if (paperIdRef.current === reqId) setTablesLoading(false)
    })
  }, [id])

  useEffect(() => {
    abortAll()
    setPaper(null); setErr(''); setCards([]); setTops({})
    setDisplayTops({}); setTermTops({}); setActiveId(null)
    setBusy(false); setPlanBusy(false); setRecBusy(false); setSearchBusy(false)
    setPlan(null); setShowPlan(false); setRecs(null); setSearchRes(null)
    setStreams({}); setAnalyzeStage('')
    setRecNote(''); setQuery(''); setCollected(false); setKnownTerms([])
    setDismissedTerms([]); setAtEnd(false); setProfile(false); setQuiz(false)
    setHighlights([]); setSelected(null); setHlMenu(null)
    setSelTrans(null); setSelTransCopied(false); selTransSeq.current += 1
    searchSeq.current += 1; formulaSeq.current += 1
    setTables([]); setTablesLoading(false); setTablesErr(''); setTableTool(null); setTableView(null)
    setTableBusy(false); setTableCopied(false)
    setFormulaBusy(false); setFormulaStep(''); setFormulaErr(''); setFormulaResult(null); setFormulaCopied('')
    setFindOpen(false); setFindHits(null); setFindQ(''); setFindIdx(0)
    translationAbort.current?.abort(); translationAbort.current = null
    translationSeq.current += 1; batchSeq.current += 1; batchStop.current = true
    setTranslationMode(false); setInlineTranslations({}); setTranslationPending({})
    setTranslationErrors({}); setShowOriginal({}); setBatchTranslation(null)
    setSectionMenu(null)
    api.get(id).then((p) => {
      if (paperIdRef.current !== id) return
      setPaper(p)
      const st = p.structure
      if (Array.isArray(st.tables) && st.tables_version === TABLES_VERSION) {
        setTables(st.tables)
      } else {
        loadTables()          // 老论文：后台懒补，不阻塞阅读
      }
    }).catch((e) => {
      if (paperIdRef.current === id) setErr(String(e?.message || e))
    })
    // 切换论文时旧请求可能后返回：统一按当前 id 丢弃，避免把上一篇的卡片/标亮盖到这一篇
    api.cards(id).then((cs) => {
      if (paperIdRef.current === id) setCards(cs)
    }).catch(() => {})
    api.inlineTranslations(id).then((d) => {
      if (paperIdRef.current === id) {
        setInlineTranslations((local) => ({ ...(d.translations || {}), ...local }))
      }
    }).catch(() => {})
    api.highlights(id).then((hs) => {
      if (paperIdRef.current === id) setHighlights(hs)
    }).catch(() => {})
    loadProfile(true)
  }, [id, loadTables, loadProfile])

  // 离开论文时停止章节队列并中止在途请求，避免后台继续产生模型调用。
  useEffect(() => () => {
    batchStop.current = true
    batchSeq.current += 1
    translationSeq.current += 1
    translationAbort.current?.abort()
    translationAbort.current = null
    abortAll()
  }, [])

  // tableView 换图/关闭时释放上一张图的 object URL
  useEffect(() => () => { if (tableView) URL.revokeObjectURL(tableView.url) }, [tableView])

  useEffect(() => {
    try { localStorage.setItem('pc.sectionsOpen', sectionsOpen ? '1' : '0') } catch { /* ignore */ }
  }, [sectionsOpen])

  // 回到宽屏后重置窄屏抽屉状态，避免下次变窄时自动弹开
  useEffect(() => {
    if (!compact) setNarrowSections(false)
  }, [compact])

  // 点空白处收起标亮调色板 / 高亮菜单 / 公式弹窗 / 表格工具条与图片 / 划词翻译
  useEffect(() => {
    if (!selected && !hlMenu && !formulaResult && !tableTool && !tableView && !selTrans) return
    const down = (e: MouseEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('.sel-palette') || t.closest('.hl-menu') || t.closest('.formula-pop')
        || t.closest('.toolbar-pop') || t.closest('.table-pop') || t.closest('.sel-trans-pop')) return
      setSelected(null); setHlMenu(null); setFormulaResult(null)
      setTableTool(null); setTableView(null); setSelTrans(null)
      viewer.current?.clearSelection()
    }
    addEventListener('mousedown', down)
    return () => removeEventListener('mousedown', down)
  }, [selected, hlMenu, formulaResult, tableTool, tableView, selTrans])

  // 章节右键菜单：点外部、滚轮或 Esc 关闭（Esc 在全局快捷键里统一逐层处理）
  useEffect(() => {
    if (!sectionMenu) return
    const down = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.section-menu')) setSectionMenu(null)
    }
    const wheel = () => setSectionMenu(null)
    addEventListener('mousedown', down)
    addEventListener('wheel', wheel, { passive: true })
    return () => {
      removeEventListener('mousedown', down)
      removeEventListener('wheel', wheel)
    }
  }, [sectionMenu])

  // 检索面板：点外部关闭（面板本身非模态，不挡阅读）
  useEffect(() => {
    if (!findOpen) return
    const down = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.find-modal')) setFindOpen(false)
    }
    addEventListener('mousedown', down)
    return () => removeEventListener('mousedown', down)
  }, [findOpen])

  // ←/→ 翻页：用视口中心落在哪个页面块推断当前页（PdfViewer 未暴露页码查询接口）
  const turnPage = useCallback((dir: 1 | -1) => {
    const pages = Array.from(document.querySelectorAll<HTMLElement>('.reader .page'))
    if (!pages.length) return
    const mid = window.innerHeight / 2
    let cur = Number(pages[0].dataset.page || 1)
    for (const el of pages) {
      const r = el.getBoundingClientRect()
      if (r.top > mid) break
      cur = Number(el.dataset.page || cur)
    }
    const next = Math.max(1, Math.min(pages.length, cur + dir))
    viewer.current?.scrollToPage(next)
  }, [])

  // 全局快捷键：Ctrl+F 一律劫持为本应用检索；Esc 逐层关闭（浮层→右键菜单→检索面板）；
  // ←/→ 翻页。输入框聚焦时不触发翻页；基座模态自带 Esc，这里不重复绑。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        // 模态打开时不叠加检索面板（仍劫持浏览器查找，避免行为分裂）
        if (settings || profile || quiz) return
        setFindOpen(true)
        findInput.current?.focus()
        return
      }
      if (e.key === 'Escape') {
        if (settings || profile || quiz) return
        if (selected || hlMenu || formulaResult || tableTool || tableView || selTrans) {
          setSelected(null); setHlMenu(null); setFormulaResult(null)
          setTableTool(null); setTableView(null); setSelTrans(null)
          viewer.current?.clearSelection()
          return
        }
        if (sectionMenu) { setSectionMenu(null); return }
        if (findOpen) { setFindOpen(false); return }
        return
      }
      const t = e.target as HTMLElement | null
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA'
        || t.tagName === 'SELECT' || t.isContentEditable)
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      if (settings || profile || quiz || findOpen) return
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault()
        turnPage(e.key === 'ArrowRight' ? 1 : -1)
      }
    }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [selected, hlMenu, formulaResult, tableTool, tableView, selTrans, sectionMenu,
    findOpen, settings, profile, quiz, turnPage])

  const analyze = async () => {
    const reqId = id
    const ac = new AbortController()
    analyzeAbort.current?.abort()
    analyzeAbort.current = ac
    setBusy(true); setErr(''); setAnalyzeStage('正在通读全文…')
    clearAnalyzeTimers()
    // 长任务阶段化文案：30-110s 的等待里给用户进度感，避免以为卡死
    analyzeTimers.current.push(window.setTimeout(() => {
      if (paperIdRef.current === reqId && !ac.signal.aborted) setAnalyzeStage('正在生成章节概要…')
    }, 20000))
    analyzeTimers.current.push(window.setTimeout(() => {
      if (paperIdRef.current === reqId && !ac.signal.aborted) setAnalyzeStage('即将完成，长论文可能需要 2 分钟')
    }, 60000))
    try {
      const a = await api.analyze(reqId, ac.signal)
      if (paperIdRef.current !== reqId || ac.signal.aborted) return
      setPaper((p) => p && { ...p, analysis: a })
      toast.success('导读已生成')
    } catch (e: any) {
      if (ac.signal.aborted) return
      if (paperIdRef.current === reqId) {
        setErr(`导读失败：${e?.message || e}`)
        toast.error(`导读失败：${e?.message || e}`)
      }
    } finally {
      clearAnalyzeTimers()
      if (analyzeAbort.current === ac) analyzeAbort.current = null
      if (paperIdRef.current === reqId) { setBusy(false); setAnalyzeStage('') }
    }
  }
  const cancelAnalyze = () => {
    analyzeAbort.current?.abort()
    analyzeAbort.current = null
    clearAnalyzeTimers()
    setBusy(false); setAnalyzeStage('')
    toast.info('已取消')
  }

  const genPlan = async () => {
    if (planBusy) return
    const reqId = id
    const ac = new AbortController()
    planAbort.current?.abort()
    planAbort.current = ac
    setPlanBusy(true); setErr('')
    try {
      const next = await api.makePlan(reqId, ac.signal)
      if (paperIdRef.current !== reqId || ac.signal.aborted) return
      setPlan(next); setShowPlan(true)
    } catch (e: any) {
      if (ac.signal.aborted) return
      if (paperIdRef.current === reqId) {
        setErr(`计划生成失败：${e?.message || e}`)
        toast.error(`计划生成失败：${e?.message || e}`)
      }
    } finally {
      if (planAbort.current === ac) planAbort.current = null
      if (paperIdRef.current === reqId) setPlanBusy(false)
    }
  }
  const cancelPlan = () => {
    planAbort.current?.abort()
    planAbort.current = null
    setPlanBusy(false)
    toast.info('已取消')
  }

  // 点「阅读计划」：有已保存计划则直接展示，否则生成
  const openPlan = () => {
    if (plan) { setShowPlan(true); return }
    genPlan()
  }

  const toggleCollect = async () => {
    const reqId = id
    const v = !collected
    setCollected(v)
    try {
      await api.collect(reqId, v)
    } catch (e: any) {
      if (paperIdRef.current === reqId) {
        setCollected(!v)
        toast.error(`收藏失败：${e?.message || e}`)
      }
    }
  }

  const doRecommend = async () => {
    if (recBusy) return
    const reqId = id
    const ac = new AbortController()
    recAbort.current?.abort()
    recAbort.current = ac
    setRecBusy(true); setErr('')
    try {
      const d = await api.recommend(reqId, ac.signal)
      if (paperIdRef.current !== reqId || ac.signal.aborted) return
      setRecs(d.items); setRecScope(d.scope_label || ''); setRecNote(d.note || '')
    } catch (e: any) {
      if (ac.signal.aborted) return
      if (paperIdRef.current === reqId) {
        setErr(`推荐失败：${e?.message || e}`)
        toast.error(`推荐失败：${e?.message || e}`)
      }
    } finally {
      if (recAbort.current === ac) recAbort.current = null
      if (paperIdRef.current === reqId) setRecBusy(false)
    }
  }
  const cancelRecommend = () => {
    recAbort.current?.abort()
    recAbort.current = null
    setRecBusy(false)
    toast.info('已取消')
  }

  const doSearch = async () => {
    if (!query.trim()) return
    const reqId = id
    const seq = ++searchSeq.current
    setSearchBusy(true); setErr('')
    try {
      const results = (await api.search({ q: query, source: 'both' })).results
      if (paperIdRef.current === reqId && seq === searchSeq.current) setSearchRes(results)
    } catch (e: any) {
      if (paperIdRef.current === reqId && seq === searchSeq.current) setErr(String(e?.message || e))
    } finally {
      if (paperIdRef.current === reqId && seq === searchSeq.current) setSearchBusy(false)
    }
  }

  const blocks = useMemo(() => paper?.structure.blocks ?? [], [paper?.structure.blocks])
  const blockMap: Record<string, Block> = useMemo(
    () => Object.fromEntries(blocks.map((b) => [b.id, b])), [blocks])
  const referenceSections = useMemo(() => new Set(
    (paper?.structure.sections ?? []).filter((s) => s.is_references).map((s) => s.id),
  ), [paper?.structure.sections])
  const translatable = useCallback((b: Block) => (
    (b.type === 'para' || b.type === 'heading') && !!b.text?.trim()
    && !b.table_id && !b.footer && !referenceSections.has(b.section_id || '')
  ), [referenceSections])
  const sectionBlocks = useCallback((sectionId: string) => {
    const sections = paper?.structure.sections ?? []
    const start = sections.findIndex((s) => s.id === sectionId)
    if (start < 0) return []
    const section = sections[start]
    const depth = secDepth(section.title)
    const opening = section.title === '(正文开头)'
    let end = sections.length
    if (opening) {
      // 开篇只到第一个正式标题，避免把整篇正文都算成开篇。
      for (let i = start + 1; i < sections.length; i++) {
        if (sections[i].is_references || sections[i].heading_block_id) { end = i; break }
      }
    } else if (depth > 0) {
      // 有编号的章/节包含其下级；无编号小标题视为子标题，不提前截断本章。
      for (let i = start + 1; i < sections.length; i++) {
        if (sections[i].is_references) { end = i; break }
        const d = secDepth(sections[i].title)
        if (d > 0 && d <= depth) { end = i; break }
      }
    } else {
      // 无编号标题无法可靠推断层级：只翻译自身小节，避免误吞后续整章。
      end = start + 1
    }
    const ids = new Set(sections.slice(start, end).filter((s) => !s.is_references).map((s) => s.id))
    return blocks.filter((b) => ids.has(b.section_id || '') && translatable(b))
  }, [paper?.structure.sections, blocks, translatable])
  const visibleTranslations = useMemo(() => translationMode
    ? Object.fromEntries(Object.entries(inlineTranslations).filter(([bid]) =>
      translatable(blockMap[bid]) && !showOriginal[bid]))
    : {}, [translationMode, inlineTranslations, showOriginal, translatable, blockMap])
  const translationBusy = !!batchTranslation?.running || Object.keys(translationPending).length > 0

  // 公式区域，供框选吸附。新解析结果直接用后端版面模型给出的整条公式框（已裁掉编号）；
  // 老论文（没有 formulas 字段）沿用 formula 块 + PUA 片段聚类。
  // 新格式不再混入旧规则：旧规则会把单独的编号块当公式，反而把裁掉的 "(12)" 又拼回去。
  const formulaRegions = useMemo(() => {
    const stored = paper?.structure.formulas
    if (Array.isArray(stored)) {
      return stored
        .filter((f) => f.x1 - f.x0 > 8 && f.y1 - f.y0 > 4)
        .map((f) => ({ page: f.page, x0: f.x0, y0: f.y0, x1: f.x1, y1: f.y1 }))
    }
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
  }, [blocks, paper?.structure.formulas])

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
  const norm = (s: string) => String(s ?? '').toLowerCase().replace(/[\s()（）-]/g, '')
  const visibleTerms = useMemo(() => {
    const knownNorm = knownTerms.map(norm)
    const isKnown = (t: { term: string; zh: string }) => {
      const a = norm(t.term), b = norm(t.zh)
      return knownNorm.some((k) => k && (
        (a && (a.includes(k) || k.includes(a)))
        || (b && (b.includes(k) || k.includes(b)))
      ))
    }
    return (paper?.analysis?.terms ?? [])
      .filter((t) => !isKnown(t) && !dismissedTerms.includes(t.term))
      .map((t) => ({
        ...t,
        term: String(t.term ?? ''),
        zh: String(t.zh ?? ''),
        refs: Array.isArray(t.refs) ? t.refs : [],
        pages: Array.isArray(t.pages) ? t.pages : [],
      }))
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
    const visibleCards = cards.filter((c) => c.type !== 'translation' || c.data.selection)
    setTops(Object.fromEntries(visibleCards.map((c) => [c.id, anchorTop(c)])))
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
    const reqId = id
    const b = blockMap[blockId]
    const r = rightRail.current || leftRail.current
    const top = b && viewer.current && r
      ? (viewer.current.blockTop(b.page, b.y0, r) ?? 0) : 0
    const { id: cid } = await api.addCard(reqId, { type, block_id: blockId, top, data })
    const c: Card = { id: cid, paper_id: reqId, type, block_id: blockId, top, data, created_at: Date.now() / 1000 }
    if (paperIdRef.current === reqId) {
      setCards((cs) => [...cs, c])
      setTops((t) => ({ ...t, [cid]: top }))
    }
    return c
  }

  const doTranslate = async (blockId: string, force = false) => {
    const b = blockMap[blockId]
    if (!b || !translatable(b)) return
    if (translationPending[blockId] || batchTranslation?.running || Object.keys(translationPending).length) {
      toast.info('已有翻译在进行中')
      return
    }
    setTool(null)
    const reqId = id
    const seq = translationSeq.current
    const ac = new AbortController()
    translationAbort.current?.abort()
    translationAbort.current = ac
    setTranslationErrors((e) => { const n = { ...e }; delete n[blockId]; return n })
    setTranslationPending((p) => ({ ...p, [blockId]: true }))
    try {
      const r = await api.translateInline(reqId, blockId, force, ac.signal)
      if (paperIdRef.current !== reqId || translationSeq.current !== seq) return
      setInlineTranslations((t) => ({ ...t, [blockId]: r.translation }))
      setShowOriginal((o) => { const n = { ...o }; delete n[blockId]; return n })
      setTranslationMode(true)
    } catch (e: any) {
      if (ac.signal.aborted) return
      if (paperIdRef.current === reqId && translationSeq.current === seq) {
        setTranslationErrors((x) => ({ ...x, [blockId]: String(e?.message || e) }))
      }
    } finally {
      if (translationAbort.current === ac) translationAbort.current = null
      if (paperIdRef.current === reqId && translationSeq.current === seq) {
        setTranslationPending((p) => { const n = { ...p }; delete n[blockId]; return n })
      }
    }
  }

  const toggleOriginal = (blockId: string) => {
    const showingTranslation = translationMode && !showOriginal[blockId]
    if (showingTranslation) {
      setShowOriginal((o) => ({ ...o, [blockId]: true }))
    } else {
      setTranslationMode(true)
      setShowOriginal((o) => { const n = { ...o }; delete n[blockId]; return n })
    }
    setTool(null)
    window.getSelection()?.removeAllRanges()
  }

  const translateSection = async (sectionId: string, force = false) => {
    if (batchTranslation?.running || Object.keys(translationPending).length) {
      toast.info('已有翻译在进行中')
      return
    }
    const section = paper?.structure.sections.find((s) => s.id === sectionId)
    const todo = sectionBlocks(sectionId).filter((b) => force || !inlineTranslations[b.id])
    if (!todo.length) {
      setTranslationMode(true)
      setBatchTranslation({ sectionId, title: section?.title || '本章', total: 0, done: 0, failed: 0, running: false })
      return
    }
    const reqId = id
    const seq = translationSeq.current
    const batch = ++batchSeq.current
    const ac = new AbortController()
    translationAbort.current?.abort()
    translationAbort.current = ac
    batchStop.current = false
    setTranslationMode(true)
    setShowOriginal({})
    setBatchTranslation({ sectionId, title: section?.title || '本章', total: todo.length, done: 0, failed: 0, running: true })
    for (const b of todo) {
      if (batchStop.current || batchSeq.current !== batch
        || paperIdRef.current !== reqId || translationSeq.current !== seq) break
      setTranslationErrors((x) => { const n = { ...x }; delete n[b.id]; return n })
      setTranslationPending((p) => ({ ...p, [b.id]: true }))
      try {
        const r = await api.translateInline(reqId, b.id, force, ac.signal)
        if (paperIdRef.current !== reqId || translationSeq.current !== seq) break
        setInlineTranslations((t) => ({ ...t, [b.id]: r.translation }))
      } catch (e: any) {
        if (ac.signal.aborted) break
        if (paperIdRef.current !== reqId || translationSeq.current !== seq) break
        setTranslationErrors((x) => ({ ...x, [b.id]: String(e?.message || e) }))
        setBatchTranslation((s) => s?.sectionId === sectionId ? { ...s, failed: s.failed + 1 } : s)
      } finally {
        if (paperIdRef.current === reqId && translationSeq.current === seq) {
          setTranslationPending((p) => { const n = { ...p }; delete n[b.id]; return n })
          setBatchTranslation((s) => s?.sectionId === sectionId ? { ...s, done: s.done + 1 } : s)
        }
      }
    }
    if (translationAbort.current === ac) translationAbort.current = null
    if (paperIdRef.current === reqId && translationSeq.current === seq) {
      setBatchTranslation((s) => s?.sectionId === sectionId ? { ...s, running: false } : s)
    }
  }

  const retranslateSection = async (sectionId: string) => {
    const n = sectionBlocks(sectionId).length
    if (!n) return
    const ok = await confirm({
      title: '重新翻译本章',
      message: `将重新翻译本章共 ${n} 段，会覆盖现有译文并产生 ${n} 次模型调用。继续？`,
      confirmText: '重新翻译',
      danger: true,
    })
    if (!ok) return
    void translateSection(sectionId, true)
  }

  const stopSectionTranslation = () => {
    batchStop.current = true
    batchSeq.current += 1
    translationSeq.current += 1
    translationAbort.current?.abort()
    translationAbort.current = null
    setTranslationPending({})
    setBatchTranslation((s) => s ? { ...s, running: false, stopped: true } : s)
  }

  const askChat = async (card: Card, question: string) => {
    const reqId = id
    const alive = () => paperIdRef.current === reqId
    const history = [...(card.data.messages ?? []), { role: 'user', content: question }]
    // 提问立即落库为 pendingQuestion：中途刷新也不丢问题；回答 done 后才写进 messages。
    // 失败/中断保留 pendingQuestion，卡片显示「上次回答中断」+ 重试
    const pendingData = { ...card.data, pendingQuestion: question }
    setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, data: pendingData } : c))
    api.patchCard(card.id, { data: pendingData }).catch(() => {})
    const ac = new AbortController()
    chatAborts.current.get(card.id)?.abort()
    chatAborts.current.set(card.id, ac)
    setStreams((s) => ({ ...s, [card.id]: { text: '', steps: [], ac } }))
    try {
      const r = await api.chatStream(reqId, {
        block_ids: card.data.block_ids ?? [card.block_id].filter(Boolean),
        history, question,
        table_id: card.data.table_id || undefined,
      }, {
        onStep: (st) => {
          if (!alive()) return
          setStreams((s) => s[card.id] ? { ...s, [card.id]: { ...s[card.id], steps: [...s[card.id].steps, st.text] } } : s)
        },
        onDelta: (text) => {
          if (!alive()) return
          setStreams((s) => s[card.id] ? { ...s, [card.id]: { ...s[card.id], text: s[card.id].text + text } } : s)
        },
      }, ac.signal)
      if (!alive() || ac.signal.aborted) return
      // done 整体替换增量文本，refs/pages/steps 一并落库
      const done = [...history, { role: 'assistant', content: r.answer, refs: r.refs, pages: r.pages }]
      const data: Record<string, any> = { ...pendingData, messages: done, steps: r.steps ?? [] }
      delete data.pendingQuestion
      setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, data } : c))
      api.patchCard(card.id, { data }).catch(() => {})
    } catch (e: any) {
      if (ac.signal.aborted) return   // 取消/切论文：保留问题，交给中断态展示
      if (alive()) toast.error(`回答失败：${e?.message || e}`)
    } finally {
      if (chatAborts.current.get(card.id) === ac) chatAborts.current.delete(card.id)
      // 只清掉自己那次请求的流：同卡片快速重问时，旧请求的收尾不能误删新流
      if (alive()) setStreams((s) => {
        if (s[card.id]?.ac !== ac) return s
        const n = { ...s }; delete n[card.id]; return n
      })
    }
  }
  const cancelChat = (cardId: string) => {
    chatAborts.current.get(cardId)?.abort()
    toast.info('已取消')
  }

  const dropCard = async (card: Card, top: number, side: 'left' | 'right') => {
    const r = rightRail.current || leftRail.current
    if (!viewer.current || !r) return
    let best: Block | null = null; let bestD = 1e9
    for (const b of blocks) {
      if (b.type === 'figure' || (!singleRail && sideOf(b.id) !== side)) continue
      const t = viewer.current.blockTop(b.page, b.y0, r)
      if (t == null) continue
      const d = Math.abs(t - top)
      if (d < bestD) { bestD = d; best = b }
    }
    if (!best) return
    const bt = viewer.current.blockTop(best.page, best.y0, r)!
    const data = { ...card.data, offset: top - bt }
    setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, block_id: best!.id, top, data } : c))
    api.patchCard(card.id, { block_id: best.id, top, data }).catch(() => toast.error('卡片位置保存失败'))
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

  // ---------- 表格 ----------
  const openTableTool = (table: TableBox, x: number, y: number) => {
    setTool(null)
    setTableTool({ table, x, y })
  }

  const showTable = async (table: TableBox, x: number, y: number) => {
    if (tableBusy) return
    const reqId = id
    setTableBusy(true)
    try {
      const blob = await viewer.current?.cropTable(table.page, table, 4)
      if (!blob) throw new Error('截图失败')
      const url = URL.createObjectURL(blob)
      if (paperIdRef.current !== reqId) {
        URL.revokeObjectURL(url)
        return
      }
      setTableView({ table, blob, url, x, y })
      setTableTool(null)
    } catch (e: any) {
      if (paperIdRef.current === reqId) setErr(`查看表格失败：${e?.message || e}`)
    } finally {
      if (paperIdRef.current === reqId) setTableBusy(false)
    }
  }

  const copyTable = async (table: TableBox) => {
    if (tableBusy) return
    setTableBusy(true)
    try {
      const blob = tableView?.table.id === table.id && tableView.blob
        ? tableView.blob
        : await viewer.current?.cropTable(table.page, table, 4)
      if (!blob) throw new Error('截图失败')
      await copyImage(blob)
      setTableCopied(true)
      window.setTimeout(() => setTableCopied(false), 1600)
    } catch (e: any) { setErr(`复制表格失败：${e?.message || e}`) }
    finally { setTableBusy(false) }
  }

  const addTableChat = async (table: TableBox) => {
    // 锚在表题块；没有表题时退到最近的正文段（整页旋转表可能同一页一个块都没有）
    const byPage = blocks.filter((b) => b.type === 'para' || b.type === 'heading')
    const near = (list: Block[]) => list
      .slice()
      .sort((a, b) => Math.abs(a.page - table.page) - Math.abs(b.page - table.page)
        || Math.abs(a.y0 - table.y0) - Math.abs(b.y0 - table.y0))[0]?.id
    const anchor = (table.caption_block_id && blockMap[table.caption_block_id])
      ? table.caption_block_id
      : (near(byPage.filter((b) => !b.table_id)) || near(byPage))
    if (!anchor) { setErr('找不到表格在正文里的锚点'); return }
    setTableTool(null)
    await addCard('chat', anchor, {
      block_ids: [anchor],
      table_id: table.id,
      table_caption: table.caption || '',
      messages: [],
    })
  }

  const closeTableView = () => setTableView(null)

  // ---------- 公式识别 ----------
  const runFormula = async (blob: Blob, x: number, y: number) => {
    if (formulaBusy) return
    const reqId = id
    const seq = ++formulaSeq.current
    const alive = () => paperIdRef.current === reqId && seq === formulaSeq.current
    setFormulaErr('')
    setFormulaCopied('')
    setFormulaBusy(true)
    setFormulaStep('正在识别公式…')
    try {
      const raw = await recognizeFormula(blob, (p) => {
        if (!alive()) return
        if (p.progress != null) setFormulaStep(`加载公式模型 ${Math.round(p.progress)}%`)
        else if (p.file) setFormulaStep('加载公式模型…')
      })
      if (!alive()) return
      const latex = normalizeLatex(raw)
      if (!latex) throw new Error('没有识别出公式，请重新框选')
      setFormulaResult({ latex, text: latexToText(latex), blob, x, y })
      window.getSelection()?.removeAllRanges()
    } catch (e: any) {
      if (!alive()) return
      const msg = String(e?.message || e)
      setFormulaErr(/formulanet|local|fetch|404|model/i.test(msg)
        ? '公式模型未加载，请先在 frontend 目录运行 npm run model:download，然后重试'
        : msg)
    } finally {
      if (alive()) {
        setFormulaBusy(false)
        setFormulaStep('')
      }
    }
  }

  const doFormula = async () => {
    if (!selected || formulaBusy || !viewer.current) return
    const s = selected
    const ys = s.rects.flatMap((r) => [r[1], r[3]])
    if (ys.length && Math.max(...ys) - Math.min(...ys) > 0.10) {
      setSelected(null)
      window.getSelection()?.removeAllRanges()
      setFormulaErr('选区跨了多行/多段。请点 PDF 上方的「框选公式」，只框住一个公式。')
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

  // ---------- 划词翻译 ----------
  const doSelectionTranslate = async () => {
    if (!selected) return
    const s = selected
    setSelected(null)
    viewer.current?.clearSelection()
    window.getSelection()?.removeAllRanges()
    const seq = ++selTransSeq.current
    setSelTransCopied(false)
    setSelTrans({
      text: s.text, translation: '', error: '', pending: true,
      x: s.x, y: s.y, page: s.page, blockId: '', saved: false,
    })
    try {
      const r = await api.translateSelection(id, { text: s.text })
      if (selTransSeq.current !== seq) return   // 已开始新的划词翻译，丢弃旧响应
      setSelTrans((t) => t ? {
        ...t, translation: r.translation, blockId: r.block_id || '',
        page: r.page || t.page, pending: false,
      } : t)
    } catch (e: any) {
      if (selTransSeq.current !== seq) return
      setSelTrans((t) => t ? { ...t, error: String(e?.message || e), pending: false } : t)
    }
  }

  const copySelTrans = async () => {
    if (!selTrans?.translation) return
    try {
      await copyText(selTrans.translation)
      setSelTransCopied(true)
      window.setTimeout(() => setSelTransCopied(false), 1600)
    } catch (e: any) { setErr(`复制失败：${e?.message || e}`) }
  }

  const saveSelTrans = async () => {
    if (!selTrans?.translation || selTrans.saved) return
    const t = selTrans
    const fallback = blocks.find((b) => b.type === 'para' || b.type === 'heading')
    const blockId = t.blockId || fallback?.id
    if (!blockId) { setErr('没有可锚定的段落，无法存为卡片'); return }
    try {
      await addCard('translation', blockId, {
        orig: t.text, translation: t.translation, page: t.page || blockMap[blockId]?.page, selection: true,
      })
      setSelTrans((x) => x ? { ...x, saved: true } : x)
    } catch (e: any) { setErr(`存为卡片失败：${e?.message || e}`) }
  }

  // ---------- 标亮 ----------
  const saveHighlight = async (color: string) => {
    if (!selected) return
    const reqId = id
    const s = selected
    setSelected(null)
    viewer.current?.clearSelection()
    window.getSelection()?.removeAllRanges()
    try {
      const h = await api.addHighlight(reqId, { page: s.page, color, text: s.text, rects: s.rects })
      if (paperIdRef.current === reqId) setHighlights((hs) => [...hs, h])
    } catch (e: any) {
      if (paperIdRef.current === reqId) setErr(`标亮保存失败：${e?.message || e}`)
    }
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
    const reqId = id
    const m = hlMenu
    setHlMenu(null)
    setHighlights((hs) => hs.filter((h) => h.id !== m.id))
    try { await api.deleteHighlight(m.id) }
    catch (e: any) {
      if (paperIdRef.current === reqId) {
        setErr(`删除标亮失败：${e?.message || e}`)
        api.highlights(reqId).then((hs) => {
          if (paperIdRef.current === reqId) setHighlights(hs)
        }).catch(() => {})
      }
    }
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
    setFindIdx(0)
  }

  // 跳转命中：flashText 返回 false（页面未渲染完/译文模式未退出）时按帧重试，
  // 替代原来 setTimeout(420) 猜时间的竞态写法；面板保持打开，方便上一处/下一处循环
  const goFind = (h: { page: number }, idx: number) => {
    const reqId = id
    setFindIdx(idx)
    setTranslationMode(false); setShowOriginal({})
    viewer.current?.scrollToPage(h.page)
    const q = findQ.trim().split(/\s+/)[0]
    cancelAnimationFrame(flashRaf.current)
    const deadline = performance.now() + 4000
    let last = 0
    const tick = (now: number) => {
      if (paperIdRef.current !== reqId) return
      if (now - last >= 180) {
        last = now
        if (viewer.current?.flashText(h.page, q)) return
      }
      if (now < deadline) flashRaf.current = requestAnimationFrame(tick)
    }
    flashRaf.current = requestAnimationFrame(tick)
  }
  const stepFind = (dir: 1 | -1) => {
    if (!findHits?.length) return
    const idx = (findIdx + dir + findHits.length) % findHits.length
    goFind(findHits[idx], idx)
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
      api.patchCard(existing.id, { data }).catch(() => toast.error('术语卡保存失败'))
      return
    }
    const anchor = t.refs.find((r) => blockMap[r]) ?? blocks[0]?.id
    if (!anchor) return
    const c = await addCard('term', anchor, { term: t.term, zh: t.zh, block_ids: t.refs, pending: true, collapsed: false, messages: [] })
    const ac = new AbortController()
    termAborts.current.set(c.id, ac)
    try {
      const r = await api.explainTerm(id, { term: t.term, zh: t.zh, refs: t.refs }, ac.signal)
      if (ac.signal.aborted || paperIdRef.current !== id) return
      const data = { ...c.data, zh: r.zh || t.zh, expl: r.expl, pages: r.pages, block_ids: r.refs.length ? r.refs : t.refs, pending: false }
      setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      api.patchCard(c.id, { data }).catch(() => toast.error('术语卡保存失败'))
    } catch (e: any) {
      if (ac.signal.aborted || paperIdRef.current !== id) return
      const data = { ...c.data, pending: false, error: String(e?.message || e) }
      setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
      api.patchCard(c.id, { data }).catch(() => {})
      toast.error(`术语解释失败：${e?.message || e}`)
    } finally {
      if (termAborts.current.get(c.id) === ac) termAborts.current.delete(c.id)
    }
  }
  // 取消解释生成：删掉刚建的占位卡，术语回到 chip 形态，状态干净复位
  const cancelTerm = (card: Card) => {
    termAborts.current.get(card.id)?.abort()
    termAborts.current.delete(card.id)
    setCards((cs) => cs.filter((x) => x.id !== card.id))
    api.delCard(card.id).catch(() => {})
    toast.info('已取消')
  }

  const collapseTerm = (card: Card) => {
    const data = { ...card.data, collapsed: true }
    setCards((cs) => cs.map((x) => x.id === card.id ? { ...x, data } : x))
    api.patchCard(card.id, { data }).catch(() => toast.error('术语卡保存失败'))
  }

  // 删除术语小卡：隐藏该术语（持久化），并删除其解释卡
  const dismissTerm = async (t: { term: string; refs: string[] }) => {
    const c = termCard(t.term)
    if (c) {
      setCards((cs) => cs.filter((x) => x.id !== c.id))
      api.delCard(c.id).catch(() => toast.error('删除术语卡失败'))
    }
    setDismissedTerms((ds) => [...ds, t.term])
    try { await api.dismissTerm(id, t.term) } catch (e: any) {
      // 不再吞异常：回滚隐藏状态并提示，术语 chip 恢复可见
      setDismissedTerms((ds) => ds.filter((x) => x !== t.term))
      toast.error(`隐藏术语失败：${e?.message || e}`)
    }
    // 删除解释卡后，若存在对应锚定不再显示
    void t.refs
  }

  if (err && !paper) return <div className="home"><div className="err">{err}</div>
    <button className="btn" onClick={() => (location.hash = '')}>返回</button></div>
  if (!paper) return <div className="home"><div className="loading paper-loading"><Spinner size={16} /><span>加载中…</span></div></div>

  const { structure, analysis } = paper
  const outlineMap = Object.fromEntries((analysis?.outlines ?? []).map((o) => [o.section_id, o.outline]))
  const jump = (p?: number) => { if (p) viewer.current?.scrollToPage(p) }

  const termSide = (t: { refs: string[] }) => sideOf(t.refs.find((r) => blockMap[r]))
  // 窄屏只保留右轨：所有卡片和术语统一进右轨，论文拿走左轨让出的宽度
  const leftTerms = singleRail ? [] : visibleTerms.filter((t) => termSide(t) === 'left')
  const rightTerms = singleRail ? visibleTerms : visibleTerms.filter((t) => termSide(t) !== 'left')
  const leftCards = singleRail ? [] : cards.filter((c) => c.type !== 'term'
    && (c.type !== 'translation' || c.data.selection) && sideOf(c.block_id) === 'left')
  const rightCards = singleRail
    ? cards.filter((c) => c.type !== 'term' && (c.type !== 'translation' || c.data.selection))
    : cards.filter((c) => c.type !== 'term' && (c.type !== 'translation' || c.data.selection) && sideOf(c.block_id) !== 'left')
  // 空轨道自动收窄：没有卡片也没有术语 chip 时把对应轨道变量置 0，PDF 拿回宽度；
  // 导读区的 translateX 对齐公式依赖这两个变量，随之自动适配
  const railVars = {
    '--rail-left': leftCards.length === 0 && leftTerms.length === 0 ? '0px' : undefined,
    '--rail-right': rightCards.length === 0 && rightTerms.length === 0 ? '0px' : undefined,
  } as CSSProperties
  const totalHits = (findHits ?? []).reduce((s, h) => s + h.count, 0)

  const renderTerm = (t: (typeof visibleTerms)[number]) => (
    <TermItem key={t.term} term={t.term} zh={t.zh}
      top={(() => { const c = termCard(t.term); return c ? (displayTops[c.id] ?? tops[c.id] ?? termTops[t.term] ?? 0) : (displayTops[chipKey(t.term)] ?? termTops[t.term] ?? 0) })()}
      card={termCard(t.term)}
      onExpand={() => expandTerm(t)}
      onCollapse={() => { const c = termCard(t.term); if (c) collapseTerm(c) }}
      onDelete={() => dismissTerm(t)}
      onCancel={() => { const c = termCard(t.term); if (c) cancelTerm(c) }}
      onTop={(v) => { const c = termCard(t.term); if (c) setTops((ts) => ({ ...ts, [c.id]: v })) }}
      onDrop={(v) => { const c = termCard(t.term); if (c) dropCard(c, v, termSide(t)) }}
      onJump={jump} />
  )

  const renderCard = (c: Card, side: 'left' | 'right') => (
    <CardItem key={c.id} card={c} top={displayTops[c.id] ?? tops[c.id] ?? c.top}
      active={activeId === c.id}
      stream={streams[c.id]}
      onActivate={() => setActiveId(c.id)}
      onTop={(t) => setTops((ts) => ({ ...ts, [c.id]: t }))}
      onDrop={(t) => dropCard(c, t, side)}
      onDelete={() => {
        setCards((cs) => cs.filter((x) => x.id !== c.id))
        api.delCard(c.id).catch((e: any) => {
          setCards((cs) => [...cs, c])
          toast.error(`删除卡片失败：${e?.message || e}`)
        })
      }}
      onAsk={(q) => askChat(c, q)}
      onRetry={() => askChat(c, c.data.pendingQuestion)}
      onCancelAsk={() => cancelChat(c.id)}
      onJump={jump}
      onPatch={async (data) => {
        const prev = c.data
        setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
        try { await api.patchCard(c.id, { data }) }
        catch (e: any) {
          // 失败回滚 data：CardItem 靠 noteDirty 保住草稿，编辑态不丢
          setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data: prev } : x))
          toast.error(`保存失败：${e?.message || e}`)
          throw e
        }
      }} />
  )

  return (
    <>
      <Topbar
        title={paper.title || paper.filename}
        onBack={() => (location.hash = '')}
        tablesLoading={tablesLoading}
        tablesErr={tablesErr}
        onRetryTables={loadTables}
        showSections={showSections}
        onToggleSections={toggleSections}
        onOpenFind={() => setFindOpen(true)}
        translationMode={translationMode}
        onToggleTranslation={() => {
          setTranslationMode((v) => !v); setShowOriginal({}); setSelected(null)
          window.getSelection()?.removeAllRanges()
        }}
        collected={collected}
        onToggleCollect={toggleCollect}
        hasAnalysis={!!analysis}
        analyzeBusy={busy}
        onAnalyze={analyze}
        onCancelAnalyze={cancelAnalyze}
        onQuiz={() => setQuiz(true)}
        onAskGlobal={() => addChatGlobal()}
        recBusy={recBusy}
        onRecommend={doRecommend}
        onCancelRecommend={cancelRecommend}
        planBusy={planBusy}
        onOpenPlan={openPlan}
        onCancelPlan={cancelPlan}
        onProfile={() => setProfile(true)}
        onSettings={() => setSettings(true)} />
      <div className="flow" style={railVars} onClick={() => tool && setTool(null)}>
        <aside className={`sections-panel${showSections ? ' open' : ''}`}>
          <div className="sp-body">
            <div className="sp-head">
              <h3>章节导航 · 概要</h3>
              <button className="x" title="收起侧边栏" onClick={closeSections}>
                <span className="ico"><ChevronLeft size={16} strokeWidth={2} /></span>
              </button>
            </div>
            <div className="nav">
              {structure.sections.filter((s) => !s.is_references).map((s) => {
                const d = secDepth(s.title)      // 1=篇 2=章 3=节，无编号=0
                return (
                  <div key={s.id} className={`sec d${d}`}
                    onContextMenu={(e) => {
                      e.preventDefault()
                      setSectionMenu({ sectionId: s.id, x: e.clientX, y: e.clientY })
                    }}
                    style={d > 0 ? { paddingLeft: 10 + (d - 1) * 14 } : undefined}>
                    <div onClick={() => jump(s.page)} title={`第 ${s.page} 页 · 右键批量翻译`}>
                      <div className={d <= 1 ? 'lv1' : 'lv2'}>{s.title === '(正文开头)' ? '开篇' : s.title}</div>
                      {typeof outlineMap[s.id] === 'string' && outlineMap[s.id]
                        && <div className="o">{outlineMap[s.id]}</div>}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </aside>
        <div className="flow-main">
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
                <div className="ph"><span className="ico"><Library size={16} strokeWidth={2} /></span><span className="pt">文献推荐</span>
                  <button className="x" title="关闭推荐" onClick={() => setRecs(null)}>
                    <span className="ico"><X size={14} strokeWidth={2} /></span>
                  </button></div>
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
                  {r.url && <a href={r.url} target="_blank" rel="noreferrer">查看原文 <span className="ico"><ExternalLink size={12} strokeWidth={2} /></span></a>}
                </div>
              ))}
              {!searchRes.length && <div className="empty">未找到相关文献（Semantic Scholar 可能限流，可稍后重试）</div>}
            </div>}
            {busy && <div className="guide-loading">
              <Skeleton lines={3} />
              <div className="loading">{analyzeStage || '正在通读全文并生成导读（含术语提取与事实自查）…'}</div>
            </div>}
            <div className="grid">
              {(analysis?.elements ?? []).map((e) => (
                <div className="el" key={String(e.kind)}>
                  <div className="k">{String(e.kind)}{e.checked && <span className="ok" title="已对照原文核查"><span className="ico"><Check size={12} strokeWidth={2} /></span>已自查</span>}</div>
                  <div className="x">{String(e.text ?? '')}</div>
                  <div className="src">
                    {(e.pages ?? []).map((p) => (
                      <button key={p} onClick={() => jump(p)}>
                        <span className="ico"><FileText size={12} strokeWidth={2} /></span>第{p}页
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
          <div className="reader">
            {!singleRail && (
              <aside className="rail left" ref={leftRail}>
                {leftTerms.map(renderTerm)}
                {leftCards.map((c) => renderCard(c, 'left'))}
              </aside>
            )}
            <PdfViewer url={`/api/papers/${id}/pdf`} blocks={blocks} onReady={onReady}
              translationMode={translationMode && Object.keys(visibleTranslations).length > 0}
              inlineTranslations={visibleTranslations}
              onLayout={recompute}
              onBlockClick={(blockId, x, y) => setTool({ blockId, x, y })}
              highlights={highlights}
              onSelectText={(s) => { setSelected(s); setSelTrans(null); selTransSeq.current += 1 }}
              onFormulaCrop={formulaCrop}
              formulaRegions={formulaRegions}
              onHighlightClick={(h, x, y) => setHlMenu({ id: h.id, color: h.color, x, y })}
              tables={tables}
              onTableClick={openTableTool} />
            <aside className="rail right" ref={rightRail}>
              {rightTerms.map(renderTerm)}
              {rightCards.map((c) => renderCard(c, 'right'))}
            </aside>
          </div>
        </div>
      </div>
      {sectionMenu && (() => {
        const s = paper.structure.sections.find((x) => x.id === sectionMenu.sectionId)
        if (!s) return null
        const all = sectionBlocks(s.id)
        const missing = all.filter((b) => !inlineTranslations[b.id]).length
        const translated = all.length - missing
        return (
          <div className="section-menu" style={popPos(sectionMenu.x, sectionMenu.y, 232, 150)}
            onContextMenu={(e) => e.preventDefault()}>
            <div className="sm-title">{s.title === '(正文开头)' ? '开篇' : s.title}</div>
            <button disabled={translationBusy || missing === 0}
              onClick={() => { setSectionMenu(null); void translateSection(s.id) }}>
              {missing ? `翻译本章（${missing} 段待译）` : '本章已全部翻译'}
            </button>
            {translated > 0 && (
              <button disabled={translationBusy}
                onClick={() => { setSectionMenu(null); void retranslateSection(s.id) }}>
                重新翻译本章（{all.length} 段）
              </button>
            )}
            <div className="sm-hint">章节导航右键打开</div>
          </div>
        )
      })()}
      {tool && (
        <div className="toolbar-pop" style={popPos(tool.x, tool.y, 220, 240)}>
          <button onClick={() => doTranslate(tool.blockId, !!inlineTranslations[tool.blockId])} disabled={translationBusy || !translatable(blockMap[tool.blockId])}>
            <span className="ico"><Languages size={14} strokeWidth={2} /></span>
            {translationPending[tool.blockId] ? '翻译中…' : translationErrors[tool.blockId]
              ? '重试翻译' : inlineTranslations[tool.blockId] ? '重新翻译此段' : '翻译此段'}</button>
          {inlineTranslations[tool.blockId]
            && <button onClick={() => toggleOriginal(tool.blockId)}>
              {translationMode && !showOriginal[tool.blockId] ? '查看原文' : '查看译文'}</button>}
          {translationErrors[tool.blockId]
            && <div className="inline-tool-error" title={translationErrors[tool.blockId]}>翻译失败，可点此段重试</div>}
          {translationPending[tool.blockId] && <div className="inline-tool-progress">正在生成译文…</div>}
          <button onClick={() => addChat(tool.blockId)}>
            <span className="ico"><MessageCircle size={14} strokeWidth={2} /></span>就此段提问</button>
          <button onClick={() => addChatGlobal(tool.blockId)} title="卡片仍锚在这段旁，但回答基于全文导读与目录，不局限于本段">
            <span className="ico"><Globe size={14} strokeWidth={2} /></span>问全文</button>
          <button onClick={() => addChat(tool.blockId, '用通俗的话讲讲这段在说什么')}>
            <span className="ico"><Lightbulb size={14} strokeWidth={2} /></span>通俗讲解</button>
          <button onClick={() => addNote(tool.blockId)}>
            <span className="ico"><NotebookPen size={14} strokeWidth={2} /></span>记笔记</button>
        </div>
      )}
      {tableTool && (
        <div className="toolbar-pop" style={popPos(tableTool.x, tableTool.y, 210, 140)}>
          <button disabled={tableBusy} onClick={() => showTable(tableTool.table, tableTool.x, tableTool.y)}>
            <span className="ico"><Table2 size={14} strokeWidth={2} /></span>
            {tableBusy ? '加载中…' : '查看表格'}</button>
          <button disabled={tableBusy} onClick={() => copyTable(tableTool.table)}>
            <span className="ico"><Copy size={14} strokeWidth={2} /></span>
            {tableBusy ? '处理中…' : tableCopied ? '已复制' : '复制图片'}</button>
          <button disabled={tableTool.table.quality !== 'ok'}
            title={tableTool.table.quality === 'ok' ? '基于这张表的单元格文本提问' : '该表为旋转/乱码表，暂不能按文本提问'}
            onClick={() => addTableChat(tableTool.table)}>
            <span className="ico"><MessageCircle size={14} strokeWidth={2} /></span>问这张表</button>
        </div>
      )}
      {tableView && (
        <div className="table-pop" style={popPos(tableView.x, tableView.y, 460, 520)}>
          <div className="th">
            <span className="ico"><Table2 size={16} strokeWidth={2} /></span>
            <span className="tt">{tableView.table.caption || `第${tableView.table.page}页表格`}</span>
            <button className="x" title="关闭" onClick={closeTableView}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>
          </div>
          <div className="tb"><img src={tableView.url} alt="表格" /></div>
          <div className="ta">
            <button className="btn small" disabled={tableBusy} onClick={() => copyTable(tableView.table)}>
              {tableBusy ? '处理中…' : '复制图片'}</button>
            <button className="btn small" disabled={tableView.table.quality !== 'ok'}
              onClick={() => addTableChat(tableView.table)}>问这张表</button>
            {tableCopied && <span className="ok">已复制</span>}
          </div>
          {tableView.table.quality !== 'ok' && (
            <div className="thint">该表为旋转/乱码表，暂不能按文本提问，可复制图片</div>
          )}
        </div>
      )}
      {selected && (
        <div className="sel-palette" style={popPos(selected.x, selected.y, 320, 46)}>
          <button className="trans-btn" title="翻译选中的文字" onClick={doSelectionTranslate}>译</button>
          <button className="formula-btn" title="识别选中的单个公式；如果选区跨多行，请用 PDF 上方的「框选公式」"
            onClick={doFormula}><span className="ico"><Sigma size={14} strokeWidth={2} /></span>公式</button>
          <span className="sp-label">标亮</span>
          {Object.entries(HL_COLORS).map(([key, color]) => (
            <button key={key} className="color-dot" title={HL_COLOR_NAMES[key]}
              style={{ background: color }} onClick={() => saveHighlight(key)} />
          ))}
          <button className="x" title="取消"
            onClick={() => { setSelected(null); viewer.current?.clearSelection(); window.getSelection()?.removeAllRanges() }}>
            <span className="ico"><X size={14} strokeWidth={2} /></span>
          </button>
        </div>
      )}
      {selTrans && (
        <div className="sel-trans-pop" style={popPos(selTrans.x, selTrans.y, 380, 360)}>
          <div className="st-head">
            <span className="ico"><Languages size={16} strokeWidth={2} /></span>
            <span>划词翻译</span>
            <button className="x" title="关闭" onClick={() => setSelTrans(null)}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>
          </div>
          <div className="st-orig">{selTrans.text}</div>
          <div className="st-body">
            {selTrans.pending ? <div className="loading">翻译中…</div>
              : selTrans.error ? <div className="err">翻译失败：{selTrans.error}</div>
                : <Markdown className="tr" text={selTrans.translation} />}
          </div>
          {!selTrans.pending && !selTrans.error && (
            <div className="st-actions">
              <button className="btn small" onClick={copySelTrans}>
                {selTransCopied ? '已复制译文' : '复制译文'}
              </button>
              <button className="btn small primary" disabled={selTrans.saved || !selTrans.translation}
                onClick={saveSelTrans}>
                {selTrans.saved ? '已存为卡片' : '存为卡片'}
              </button>
            </div>
          )}
        </div>
      )}
      {formulaResult && (
        <div className="formula-pop" style={popPos(formulaResult.x, formulaResult.y, 360, 420)}>
          <div className="fp-head">
            <span className="ico"><Sigma size={16} strokeWidth={2} /></span>
            <span>公式识别</span>
            <button className="x" title="关闭" onClick={() => setFormulaResult(null)}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>
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
        <div className="hl-menu" style={popPos(hlMenu.x, hlMenu.y, 200, 42, 6)}>
          {Object.entries(HL_COLORS).map(([key, color]) => (
            <button key={key} className={`color-dot${hlMenu.color === key ? ' on' : ''}`}
              title={`改为${HL_COLOR_NAMES[key]}`} style={{ background: color }}
              onClick={() => changeHighlight(key)} />
          ))}
          <button className="btn small danger" onClick={removeHighlight}>删除</button>
        </div>
      )}
      {findOpen && (
        <div className="find-modal" role="dialog" aria-label="全文检索">
          <div className="fm-head">
            <span className="ico"><Search size={16} strokeWidth={2} /></span>
            <span className="fm-title">全文检索</span>
            <button className="x" title="关闭（Esc）" onClick={() => setFindOpen(false)}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>
          </div>
          <div className="searchbar">
            <input ref={findInput} autoFocus value={findQ} placeholder="输入关键词，回车检索本篇全文…"
              onChange={(e) => setFindQ(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') runFind()
                if (e.key === 'Escape') setFindOpen(false)
                if (e.key === 'ArrowDown' && findHits?.length) { e.preventDefault(); stepFind(1) }
                if (e.key === 'ArrowUp' && findHits?.length) { e.preventDefault(); stepFind(-1) }
              }} />
            <button className="btn small primary" onClick={() => runFind()}>检索</button>
          </div>
          {findHits && (
            <div className="find-summary">
              <span>{findHits.length
                ? `共 ${totalHits} 处命中 · ${findHits.length} 个段落`
                : `未找到「${findQ.trim()}」`}</span>
              {!!findHits.length && (
                <span className="find-nav">
                  <button className="btn small" title="上一处（循环）" onClick={() => stepFind(-1)}>
                    <span className="ico"><ChevronUp size={14} strokeWidth={2} /></span>上一处
                  </button>
                  <span className="find-idx">{findIdx + 1}/{findHits.length}</span>
                  <button className="btn small" title="下一处（循环）" onClick={() => stepFind(1)}>
                    下一处<span className="ico"><ChevronDown size={14} strokeWidth={2} /></span>
                  </button>
                </span>
              )}
            </div>
          )}
          {!!findHits?.length && (
            <div className="find-hits">
              {findHits.map((h, i) => (
                <button key={`${h.blockId}-${i}`} className={`find-hit${i === findIdx ? ' on' : ''}`} onClick={() => goFind(h, i)}>
                  <span className="fh-page">第 {h.page} 页</span>
                  <span className="fh-snip">{h.snippet}</span>
                  <span className="fh-count">{h.count} 处</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {/* 底部悬浮提示统一堆叠：翻译进度/公式 toast/自测提示/窄屏提示不再互相遮挡 */}
      <div className="float-stack">
        {batchTranslation && (
          <div className="translation-progress">
            <span>“{batchTranslation.title}” {batchTranslation.total
              ? `${batchTranslation.done}/${batchTranslation.total} 段`
              : '已全部翻译'}{batchTranslation.failed ? ` · ${batchTranslation.failed} 段失败` : ''}
              {batchTranslation.stopped ? ' · 已停止' : ''}</span>
            {batchTranslation.running
              ? <button className="btn small" onClick={stopSectionTranslation}>停止</button>
              : <button className="x" title="关闭进度" onClick={() => setBatchTranslation(null)}>
                <span className="ico"><X size={14} strokeWidth={2} /></span>
              </button>}
          </div>
        )}
        {(formulaBusy || formulaErr) && (
          <div className="formula-toast">
            <span className="ico"><Sigma size={14} strokeWidth={2} /></span>
            <span>{formulaBusy ? (formulaStep || '正在识别公式…') : `公式识别失败：${formulaErr}`}</span>
            {!formulaBusy && <button className="x" title="关闭" onClick={() => setFormulaErr('')}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>}
          </div>
        )}
        {atEnd && !quiz && (
          <div className="quiz-prompt" onClick={() => setQuiz(true)}>
            <span className="ico"><GraduationCap size={16} strokeWidth={2} /></span>
            已读完全篇，来做 3 道自测检验掌握程度吧 →
            <button className="x" onClick={(e) => { e.stopPropagation(); setAtEnd(false) }}>稍后</button>
          </div>
        )}
        {tooNarrow && !tipClosed && (
          <div className="narrow-tip">
            <span className="ico"><MoveHorizontal size={16} strokeWidth={2} /></span>
            <span>窗口偏窄，论文会偏小。建议把窗口拉宽到 1150 以上。</span>
            <button className="x" title="关闭提示" onClick={() => setTipClosed(true)}>
              <span className="ico"><X size={14} strokeWidth={2} /></span>
            </button>
          </div>
        )}
      </div>
      {settings && <Suspense fallback={null}><SettingsModal onClose={() => setSettings(false)} /></Suspense>}
      {profile && <Suspense fallback={null}><ProfileModal pid={id}
        onClose={() => {
          // 「稍后再说」/点遮罩关闭：记住选择，本篇不再自动弹问卷
          setProfile(false)
          try { localStorage.setItem(`survey-dismissed:${id}`, '1') } catch { /* ignore */ }
        }}
        onDone={() => { setProfile(false); loadProfile(); genPlan() }} /></Suspense>}
      {quiz && <Suspense fallback={null}><QuizModal pid={id} onJump={(p) => viewer.current?.scrollToPage(p)} onClose={() => setQuiz(false)} /></Suspense>}
    </>
  )
}