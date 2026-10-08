import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from './api'
import type { Block, Card, Paper, ReadingPlan, SearchResult } from './api'
import PdfViewer from './PdfViewer'
import type { ViewerHandle } from './PdfViewer'
import CardItem from './CardItem'
import TermItem from './TermItem'
import SettingsModal from './SettingsModal'
import ProfileModal from './ProfileModal'
import PlanCard from './PlanCard'
import QuizModal from './QuizModal'

/** 标题数字编号的段数：1→1(篇)、1.1→2(章)、1.1.1→3(节)；无编号→0 */
function secDepth(title: string): number {
  const m = (title || '').match(/^\s*(\d+(?:\.\d+)*)\.?\s/)
  return m ? m[1].split('.').length : 0
}

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
  const [recs, setRecs] = useState<{ title: string; reason: string }[] | null>(null)
  const [searchRes, setSearchRes] = useState<SearchResult[] | null>(null)
  const [searchBusy, setSearchBusy] = useState(false)
  const [query, setQuery] = useState('')
  const [quiz, setQuiz] = useState(false)
  const [atEnd, setAtEnd] = useState(false)
  const [steps, setSteps] = useState<{ blockId: string; text: string }[]>([])
  const viewer = useRef<ViewerHandle | null>(null)
  const rail = useRef<HTMLDivElement>(null)
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
    setDismissedTerms([])
    api.get(id).then(setPaper).catch((e) => setErr(String(e?.message || e)))
    api.cards(id).then(setCards).catch(() => {})
    api.profile(id).then((d) => {
      setCollected(!!d.meta?.collected)
      setKnownTerms(d.meta?.known_terms ?? [])
      setDismissedTerms(d.meta?.dismissed_terms ?? [])
      if (d.meta?.plan) setPlan(d.meta.plan)
      if (!d.meta?.domain) setProfile(true)   // 未做过摸底 → 上传后立即弹问卷
    }).catch(() => {})
  }, [id])

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
    try { setRecs((await api.recommend(id)).items) }
    catch (e: any) { setErr(`推荐失败：${e?.message || e}`) }
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
    if (b && viewer.current && rail.current) {
      const t = viewer.current.blockTop(b.page, b.y0, rail.current)
      if (t != null) return t + (card.data.offset ?? 0)
    }
    return card.top
  }, [blockMap])
  const recompute = useCallback(() => {
    setTops(Object.fromEntries(cards.map((c) => [c.id, anchorTop(c)])))
    // 术语小卡锚定到其首个出现块
    if (viewer.current && rail.current) {
      const rt: Record<string, number> = {}
      for (const t of visibleTermsRef.current) {
        const b = blockMap[t.refs.find((r) => blockMap[r]) ?? '']
        const top = b ? viewer.current.blockTop(b.page, b.y0, rail.current) : null
        if (top != null) rt[t.term] = top
      }
      setTermTops(rt)
    }
  }, [cards, anchorTop, blockMap, visibleTerms])
  useEffect(() => { recompute() }, [recompute])
  // 防重叠：按锚定 top 排序依次下推，写入独立的 displayTops（不覆盖锚点，避免与 recompute 互相覆盖）
  useLayoutEffect(() => {
    const el = rail.current
    if (!el) return
    const items = [...el.querySelectorAll<HTMLElement>('.card')]
      .filter((c) => !!c.dataset.id)
      .map((c) => ({
        id: c.dataset.id!, h: c.offsetHeight,
        // 新卡片的 tops 还没写入时用内联 top 兜底，保证刚生成的卡片也立刻参与防重叠
        top: tops[c.dataset.id!] ?? (c.dataset.term ? termTops[c.dataset.term] : (parseFloat(c.style.top) || 0)),
      }))
      .filter((it) => it.top != null)
      .sort((a, b) => (a.top as number) - (b.top as number))
    let prev = 0
    const next: Record<string, number> = {}
    for (const it of items) {
      const t = Math.max(it.top as number, prev + 10)
      next[it.id] = t
      prev = t + it.h
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
    const top = b && viewer.current && rail.current
      ? (viewer.current.blockTop(b.page, b.y0, rail.current) ?? 0) : 0
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

  const dropCard = async (card: Card, top: number) => {
    if (!viewer.current || !rail.current) return
    let best: Block | null = null; let bestD = 1e9
    for (const b of blocks) {
      if (b.type === 'figure') continue
      const t = viewer.current.blockTop(b.page, b.y0, rail.current)
      if (t == null) continue
      const d = Math.abs(t - top)
      if (d < bestD) { bestD = d; best = b }
    }
    if (!best) return
    const bt = viewer.current.blockTop(best.page, best.y0, rail.current)!
    const data = { ...card.data, offset: top - bt }
    setCards((cs) => cs.map((c) => c.id === card.id ? { ...c, block_id: best!.id, top, data } : c))
    api.patchCard(card.id, { block_id: best.id, top, data })
  }

  const addChat = async (blockId: string, question?: string) => {
    setTool(null)
    const c = await addCard('chat', blockId, { block_ids: [blockId], messages: [] })
    if (question) askChat(c, question)
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

  return (
    <>
      <div className="topbar">
        <button className="btn small" onClick={() => (location.hash = '')}>←</button>
        <div className="title">{paper.title || paper.filename}</div>
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
        <button className="btn" disabled={recBusy} onClick={doRecommend}>
          {recBusy ? '推荐中…' : '推荐'}</button>
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
              <div className="ph"><span className="ico">📚</span><span className="pt">基于你的阅读历史的推荐</span>
                <button className="x" onClick={() => setRecs(null)}>✕</button></div>
              <div className="pb">
                {recs.map((r) => <div key={r.title} className="rec">
                  <div className="rt">{r.title}</div><div className="rr">{r.reason}</div></div>)}
                {!recs.length && <div className="empty">暂无推荐</div>}
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
        <div className="reader">
          <div className="nav">
            <h3>章节导航 · 概要</h3>
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
          <PdfViewer url={`/api/papers/${id}/pdf`} blocks={blocks} onReady={onReady}
            onLayout={recompute}
            onBlockClick={(blockId, x, y) => setTool({ blockId, x, y })} />
          <div className="rail" ref={rail}>
            {steps.map((s, i) => (
              <div key={i} className="agent-step">🔍 {s.text}</div>
            ))}
            {visibleTerms.map((t) => (
              <TermItem key={t.term} term={t.term} zh={t.zh}
                top={(() => { const c = termCard(t.term); return c ? (displayTops[c.id] ?? tops[c.id] ?? termTops[t.term] ?? 0) : (termTops[t.term] ?? 0) })()}
                card={termCard(t.term)}
                onExpand={() => expandTerm(t)}
                onCollapse={() => { const c = termCard(t.term); if (c) collapseTerm(c) }}
                onDelete={() => dismissTerm(t)}
                onTop={(v) => { const c = termCard(t.term); if (c) setTops((ts) => ({ ...ts, [c.id]: v })) }}
                onDrop={(v) => { const c = termCard(t.term); if (c) dropCard(c, v) }}
                onJump={jump} />
            ))}
            {cards.filter((c) => c.type !== 'term').map((c) => (
              <CardItem key={c.id} card={c} top={displayTops[c.id] ?? tops[c.id] ?? c.top}
                active={activeId === c.id}
                onActivate={() => setActiveId(c.id)}
                onTop={(t) => setTops((ts) => ({ ...ts, [c.id]: t }))}
                onDrop={(t) => dropCard(c, t)}
                onDelete={() => { api.delCard(c.id); setCards((cs) => cs.filter((x) => x.id !== c.id)) }}
                onAsk={(q) => askChat(c, q)}
                onJump={jump}
                onResize={(w) => {
                  const data = { ...c.data, width: w }
                  setCards((cs) => cs.map((x) => x.id === c.id ? { ...x, data } : x))
                }}
                onResizeEnd={(w) => api.patchCard(c.id, { data: { ...c.data, width: w } })} />
            ))}
          </div>
        </div>
      </div>
      {tool && (
        <div className="toolbar-pop" style={{ left: Math.min(tool.x + 8, innerWidth - 220), top: tool.y + 8 }}>
          <button onClick={() => doTranslate(tool.blockId)}>🈶 翻译此段</button>
          <button onClick={() => addChat(tool.blockId)}>💬 就此段提问</button>
          <button onClick={() => addChat(tool.blockId, '用通俗的话讲讲这段在说什么')}> 通俗讲解</button>
        </div>
      )}
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
