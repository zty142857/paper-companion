import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Folder, Paper } from './api'
import SettingsModal from './SettingsModal'
import Markdown from './Markdown'

type Placement = { paper: Paper; mode: 'move' | 'copy' }

export default function Home() {
  const [papers, setPapers] = useState<Paper[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [busy, setBusy] = useState('')
  const [err, setErr] = useState('')
  const [over, setOver] = useState(false)
  const [settings, setSettings] = useState(false)
  const [editNote, setEditNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [selIds, setSelIds] = useState<string[]>([])
  const [reviewText, setReviewText] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  // 'all' | 'none' | 文件夹 id
  const [activeFolder, setActiveFolder] = useState('all')
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [renameFolder, setRenameFolder] = useState<{ id: string; name: string } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)

  const load = () => {
    Promise.all([api.list(), api.folders()])
      .then(([ps, fs]) => { setPapers(ps); setFolders(fs) })
      .catch((e) => setErr(String(e)))
  }
  useEffect(() => { load() }, [])

  // 点击空白处收起论文行菜单
  useEffect(() => {
    if (!menuFor) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.paper-menu')) setMenuFor(null)
    }
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [menuFor])

  const upload = async (f: File) => {
    setBusy('解析中…'); setErr('')
    try {
      const target = activeFolder !== 'all' && activeFolder !== 'none' ? activeFolder : undefined
      const { id } = await api.upload(f, target)
      location.hash = `#/paper/${id}`
    } catch (e: any) { setErr(`上传失败：${e?.message || e}`); setBusy('') }
  }

  const startNote = (p: Paper, e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    setEditNote(p.id); setNoteDraft(p.note || '')
  }
  const saveNote = async (pid: string) => {
    try { await api.setNote(pid, noteDraft); setPapers((ps) => ps.map((x) => x.id === pid ? { ...x, note: noteDraft } : x)) }
    catch (e: any) { setErr(`备注保存失败：${e?.message || e}`) }
    setEditNote(null)
  }

  const openReview = () => {
    setReviewText(null); setSelIds(papers.filter((p) => p.collected).map((p) => p.id)); setReviewOpen(true)
  }
  const toggleSel = (pid: string) =>
    setSelIds((s) => s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid])
  const genReview = async () => {
    if (selIds.length < 2) return
    setReviewBusy(true); setErr('')
    try { setReviewText((await api.review(selIds)).review) }
    catch (e: any) { setErr(`综述生成失败：${e?.message || e}`) }
    finally { setReviewBusy(false) }
  }
  const doClear = async () => {
    if (!confirm('确定清除全部本地数据吗？将删除所有论文、卡片、笔记、标亮、文件夹、档案与 PDF，并清除已保存的 API Key。此操作不可撤销。')) return
    setClearing(true); setErr('')
    try { await api.clearData(); setPrivacyOpen(false); setActiveFolder('all'); load() }
    catch (e: any) { setErr(`清除失败：${e?.message || e}`) }
    finally { setClearing(false) }
  }

  // ---------- 文件夹 ----------
  const createFolder = async () => {
    const name = (newFolderName || '').trim()
    if (!name) { setNewFolderName(null); return }
    if (folderBusy) return
    setFolderBusy(true); setErr('')
    try { const f = await api.addFolder(name); setNewFolderName(null); setActiveFolder(f.id); load() }
    catch (e: any) { setErr(`新建文件夹失败：${e?.message || e}`) }
    finally { setFolderBusy(false) }
  }

  const saveRename = async () => {
    if (!renameFolder) return
    const name = renameFolder.name.trim()
    if (!name) { setRenameFolder(null); return }
    if (folderBusy) return
    setFolderBusy(true); setErr('')
    try { await api.renameFolder(renameFolder.id, name); setRenameFolder(null); load() }
    catch (e: any) { setErr(`重命名失败：${e?.message || e}`) }
    finally { setFolderBusy(false) }
  }

  const removeFolder = async (f: Folder) => {
    const n = f.paper_count ?? papers.filter((p) => p.folder_id === f.id).length
    if (!confirm(`删除文件夹「${f.name}」？\n其中 ${n} 篇论文（含导读、卡片、笔记、标亮与 PDF）会一并删除，此操作不可撤销。`)) return
    setErr('')
    try {
      await api.deleteFolder(f.id)
      if (activeFolder === f.id) setActiveFolder('all')
      load()
    } catch (e: any) { setErr(`删除文件夹失败：${e?.message || e}`) }
  }

  const doPlace = async (fid: string | null) => {
    if (!placement) return
    const p = placement.paper
    setErr('')
    try {
      if (placement.mode === 'move') await api.movePaper(p.id, fid)
      else await api.copyPaper(p.id, fid)
      setPlacement(null); load()
    } catch (e: any) { setErr(`${placement.mode === 'move' ? '移动' : '复制'}失败：${e?.message || e}`) }
  }

  const visiblePapers = papers.filter((p) =>
    activeFolder === 'all' ? true
      : activeFolder === 'none' ? !p.folder_id
        : p.folder_id === activeFolder)
  const folderName = activeFolder === 'all' ? '全部论文'
    : activeFolder === 'none' ? '未分类'
      : (folders.find((f) => f.id === activeFolder)?.name || '文件夹')

  return (
    <div className="home">
      <div className="home-head">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <h1 style={{ flex: 1 }}>论文阅读学伴</h1>
          {papers.length >= 2 && <button className="btn" onClick={openReview}>文献综述</button>}
          <button className="btn" onClick={() => setPrivacyOpen(true)}>隐私与数据</button>
          <button className="btn" onClick={() => setSettings(true)}>模型设置</button>
        </div>
        <div className="sub">上传 PDF，生成导读 → 真实版面精读 → 术语卡 / 子对话卡 / 笔记 / 自测</div>
      </div>

      <div className="home-body">
        <aside className="folder-sidebar">
          <div className="fs-head">
            <span>文件夹</span>
            <button className="btn small" disabled={folderBusy} onClick={() => setNewFolderName('')}>＋ 新建</button>
          </div>
          {newFolderName !== null && (
            <div className="fs-new">
              <input autoFocus value={newFolderName} placeholder="文件夹名称"
                onChange={(e) => setNewFolderName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') createFolder()
                  if (e.key === 'Escape') setNewFolderName(null)
                }} />
              <button className="btn small primary" disabled={folderBusy} onClick={createFolder}>建立</button>
            </div>
          )}
          <button className={`fs-item${activeFolder === 'all' ? ' on' : ''}`} onClick={() => setActiveFolder('all')}>
            <span className="fs-name">📄 全部论文</span><span className="fs-count">{papers.length}</span>
          </button>
          <button className={`fs-item${activeFolder === 'none' ? ' on' : ''}`} onClick={() => setActiveFolder('none')}>
            <span className="fs-name">🗂 未分类</span>
            <span className="fs-count">{papers.filter((p) => !p.folder_id).length}</span>
          </button>
          <div className="fs-divider" />
          {folders.map((f) => (
            <div key={f.id} className={`fs-item folder${activeFolder === f.id ? ' on' : ''}`}>
              {renameFolder?.id === f.id ? (
                <input className="fs-rename" autoFocus value={renameFolder.name}
                  onChange={(e) => setRenameFolder({ ...renameFolder, name: e.target.value })}
                  onBlur={saveRename}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') saveRename()
                    if (e.key === 'Escape') setRenameFolder(null)
                  }} />
              ) : (
                <button className="fs-name" onClick={() => setActiveFolder(f.id)} title={f.name}>
                  📁 {f.name}
                </button>
              )}
              <span className="fs-count">{f.paper_count ?? 0}</span>
              <span className="fs-actions">
                <button className="x" title="重命名" onClick={() => setRenameFolder({ id: f.id, name: f.name })}>✎</button>
                <button className="x" title="删除文件夹（连同论文）" onClick={() => removeFolder(f)}>🗑</button>
              </span>
            </div>
          ))}
          {!folders.length && <div className="fs-empty">还没有文件夹，点「新建」按课题分组。</div>}
        </aside>

        <main className="home-main">
          <div className={`drop${over ? ' on' : ''}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={() => setOver(false)}
            onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) upload(f) }}>
            {busy || <><b>点击或拖拽 PDF 到此处</b><br />
              {activeFolder !== 'all' && activeFolder !== 'none'
                ? <>将归入文件夹「{folderName}」</>
                : '只支持英文/中文学术论文 PDF，解析约 5–15 秒'}</>}
            <input ref={fileRef} type="file" accept="application/pdf" hidden
              onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
          </div>
          {err && <div className="err" style={{ marginBottom: 14 }}>{err}</div>}
          {papers.length > 0 && (
            <h3 style={{ fontSize: 13, color: 'var(--muted)', margin: '16px 0 8px' }}>
              我的论文 · {folderName}（{visiblePapers.length}）
            </h3>
          )}
          <div className="papers">
            {visiblePapers.map((p) => (
              <div className="paper-row" key={p.id}>
                <a className="t" href={`#/paper/${p.id}`}>{p.title || p.filename}</a>
                {p.folder_name && (
                  <span className="badge folder-badge" title={`文件夹：${p.folder_name}`}>📁 {p.folder_name}</span>
                )}
                <span className="m">{p.pages} 页</span>
                <span className="badge">{p.status === 'parsed' ? '已解析' : p.status}</span>
                <button className="btn small" title="删除论文" onClick={(e) => {
                  e.preventDefault(); e.stopPropagation()
                  if (confirm(`删除《${p.title || p.filename}》？相关卡片、笔记与标亮也会一并删除。`)) {
                    api.deletePaper(p.id).then(load).catch((e) => setErr(`删除失败：${e?.message || e}`))
                  }
                }}>删除</button>
                {editNote === p.id
                  ? <input className="note-input" autoFocus value={noteDraft}
                    placeholder="写点备注，回车保存…"
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onBlur={() => saveNote(p.id)}
                    onKeyDown={(e) => { if (e.key === 'Enter') saveNote(p.id); if (e.key === 'Escape') setEditNote(null) }} />
                  : <button className="note-view" onClick={(e) => startNote(p, e)} title="点击编辑备注">
                    {p.note ? `📝 ${p.note}` : '＋ 备注'}</button>}
                <div className="paper-menu">
                  <button className="btn small" title="更多操作"
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id) }}>⋯</button>
                  {menuFor === p.id && (
                    <div className="paper-menu-pop" onClick={(e) => e.stopPropagation()}>
                      <button onClick={() => { setPlacement({ paper: p, mode: 'move' }); setMenuFor(null) }}>移动到文件夹…</button>
                      <button onClick={() => { setPlacement({ paper: p, mode: 'copy' }); setMenuFor(null) }}>复制到文件夹…</button>
                    </div>
                  )}
                </div>
              </div>
            ))}
            {!visiblePapers.length && papers.length > 0 && (
              <div className="empty">这个文件夹里还没有论文。切到「全部论文」上传，或用论文行的「⋯ → 移动到文件夹」把已有论文移进来。</div>
            )}
          </div>
        </main>
      </div>

      {reviewOpen && <div className="modal-bg" onClick={() => setReviewOpen(false)}>
        <div className="modal quiz" onClick={(e) => e.stopPropagation()}>
          <h2>文献综述</h2>
          {!reviewText && <>
            <p className="empty" style={{ marginBottom: 10 }}>
              勾选要纳入综述的论文（至少 2 篇），我会对比它们的主题、方法、结论与空白。
            </p>
            <div className="review-pick">
              {papers.map((p) => (
                <label key={p.id} className={`pick${selIds.includes(p.id) ? ' on' : ''}`}>
                  <input type="checkbox" checked={selIds.includes(p.id)} onChange={() => toggleSel(p.id)} />
                  <span className="pt2">{p.title || p.filename}</span>
                  {p.collected ? <span className="badge">已收藏</span> : null}
                </label>
              ))}
            </div>
          </>}
          {reviewBusy && <div className="loading">正在生成对比综述（约 20 秒）…</div>}
          {reviewText && <Markdown className="rv" text={reviewText} />}
          <div className="row">
            <button className="btn" onClick={() => setReviewOpen(false)}>关闭</button>
            {!reviewText && <button className="btn primary" disabled={reviewBusy || selIds.length < 2} onClick={genReview}>
              {reviewBusy ? '生成中…' : `生成综述（${selIds.length}）`}</button>}
            {reviewText && <button className="btn" onClick={() => { setReviewText(null) }}>重新选择</button>}
          </div>
        </div>
      </div>}

      {placement && <div className="modal-bg" onClick={() => setPlacement(null)}>
        <div className="modal folder-pick" onClick={(e) => e.stopPropagation()}>
          <h2>{placement.mode === 'move' ? '移动到文件夹' : '复制到文件夹'}</h2>
          <p className="empty" style={{ marginBottom: 12 }}>
            《{placement.paper.title || placement.paper.filename}》
            {placement.mode === 'copy'
              ? '：复制会生成一篇完整独立的副本（含导读、卡片、笔记、标亮、画像），之后互不影响。'
              : `：当前在「${placement.paper.folder_name || '未分类'}」。`}
          </p>
          <div className="folder-list">
            <button className="folder-choice" disabled={!placement.paper.folder_id}
              onClick={() => doPlace(null)}>🗂 未分类</button>
            {folders.map((f) => (
              <button key={f.id} className="folder-choice"
                disabled={placement.mode === 'move' && placement.paper.folder_id === f.id}
                onClick={() => doPlace(f.id)}>📁 {f.name}
                <span className="fs-count">{f.paper_count ?? 0}</span></button>
            ))}
          </div>
          {!folders.length && <div className="empty">还没有文件夹，请先在左侧新建。</div>}
          <div className="row">
            <button className="btn" onClick={() => setPlacement(null)}>取消</button>
          </div>
        </div>
      </div>}

      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {privacyOpen && <div className="modal-bg" onClick={() => setPrivacyOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>隐私与数据说明</h2>
          <div className="privacy">
            <p><b>数据存储位置</b>：你的论文原文、生成的导读/术语/卡片/笔记/标亮、阅读计划与文件夹，全部保存在<b>本机</b>（后端 <code>backend/data/</code> 目录下的 SQLite 与 PDF 文件），不会上传到本应用以外的服务器。</p>
            <p><b>模型调用</b>：生成导读、翻译、术语解释、子对话、自测等功能，会把<b>相关论文正文片段与你的提问</b>发送到你配置的模型服务（默认阿里云 DashScope）用于推理。请仅上传你有权处理的论文，并在填写 API Key 前确认服务商的隐私政策。</p>
            <p><b>API Key</b>：仅保存在本机（<code>backend/.env</code> 或本机数据库），不回显明文、不记录日志、不对外发送（仅用于调用你配置的模型接口）。</p>
            <p><b>你的权利</b>：可随时在首页逐篇删除论文，或用下方按钮<b>一键清除全部本地数据</b>。</p>
          </div>
          <div className="row">
            <button className="btn" onClick={() => setPrivacyOpen(false)}>关闭</button>
            <button className="btn danger" disabled={clearing} onClick={doClear}>
              {clearing ? '清除中…' : '一键清除全部数据'}</button>
          </div>
        </div>
      </div>}
    </div>
  )
}
