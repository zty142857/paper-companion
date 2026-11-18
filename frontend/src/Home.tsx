import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle, Ban, BookOpen, CheckCircle2, Clock3, FileText, FileUp,
  Folder as FolderIcon, FolderPlus, Inbox, MoreHorizontal, NotebookPen,
  Pencil, Plus, RotateCcw, Settings, ShieldCheck, Trash2, X,
} from 'lucide-react'
import { api } from './api'
import type { Folder, Paper } from './api'
import Modal from './components/Modal'
import { Skeleton, Spinner } from './components/Loading'
import { useToast } from './components/Toast'
import { useConfirm } from './components/ConfirmDialog'
import SettingsModal from './SettingsModal'
import Markdown from './Markdown'

type Placement = { paper: Paper; mode: 'move' | 'copy' }

type UploadStatus = 'waiting' | 'uploading' | 'done' | 'error' | 'canceled'
type UploadItem = { key: string; file: File; folderId?: string; status: UploadStatus; error?: string }

// 并发上限：再多浏览器同域连接也会排队，3 个足够吃满带宽又不压垮后端解析
const UPLOAD_CONCURRENCY = 3

const UPLOAD_LABEL: Record<UploadStatus, string> = {
  waiting: '等待中', uploading: '上传中', done: '已入库', error: '失败', canceled: '已取消',
}

// 轮询合并时比较的关键字段：structure/analysis 是大对象且每次反序列化引用必变，
// 首页又不渲染它们，排除掉才能让"无变化的行保留原引用"真正生效
const MERGE_KEYS: (keyof Paper)[] = [
  'title', 'filename', 'pages', 'status', 'parse_error', 'has_analysis',
  'visited', 'collected', 'domain', 'note', 'folder_id', 'folder_name',
]

export default function Home() {
  const toast = useToast()
  const confirm = useConfirm()
  const [papers, setPapers] = useState<Paper[]>([])
  const [folders, setFolders] = useState<Folder[]>([])
  const [loading, setLoading] = useState(true)
  const [uploads, setUploads] = useState<UploadItem[]>([])
  const [over, setOver] = useState(false)
  const [settings, setSettings] = useState(false)
  const [editNote, setEditNote] = useState<string | null>(null)
  const [noteDraft, setNoteDraft] = useState('')
  const [reviewOpen, setReviewOpen] = useState(false)
  const [selIds, setSelIds] = useState<string[]>([])
  const [reviewText, setReviewText] = useState<string | null>(null)
  const [reviewBusy, setReviewBusy] = useState(false)
  const [reviewPhase, setReviewPhase] = useState(0)
  const [privacyOpen, setPrivacyOpen] = useState(false)
  const [clearing, setClearing] = useState(false)
  // 'all' | 'none' | 文件夹 id
  const [activeFolder, setActiveFolder] = useState('all')
  const [newFolderName, setNewFolderName] = useState<string | null>(null)
  const [renameFolder, setRenameFolder] = useState<{ id: string; name: string } | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [placement, setPlacement] = useState<Placement | null>(null)
  const [folderBusy, setFolderBusy] = useState(false)
  const readyPapers = papers.filter((p) => p.status === 'parsed')
  const reviewablePapers = readyPapers.filter((p) => p.has_analysis)
  const fileRef = useRef<HTMLInputElement>(null)

  // 上传队列的可变状态放 ref：并发回调里读 state 会拿到旧闭包，ref 才是唯一事实来源
  const uploadsRef = useRef<UploadItem[]>([])
  const pendingRef = useRef<UploadItem[]>([])
  const runningRef = useRef(0)
  const abortsRef = useRef(new Map<string, AbortController>())
  const seqRef = useRef(0)
  // 正在编辑备注/开着菜单的行：轮询合并时整行跳过，输入与菜单不被打断
  const editGuardRef = useRef(new Set<string>())
  const noteBusyRef = useRef<string | null>(null)
  const noteCancelRef = useRef<string | null>(null)
  const reviewAbortRef = useRef<AbortController | null>(null)

  const updateUploads = (fn: (list: UploadItem[]) => UploadItem[]) => {
    uploadsRef.current = fn(uploadsRef.current)
    setUploads(uploadsRef.current)
  }
  const patchUpload = (key: string, patch: Partial<UploadItem>) =>
    updateUploads((list) => list.map((u) => u.key === key ? { ...u, ...patch } : u))

  // 按 id 合并：关键字段没变的行保留原对象引用，React 跳过重渲染，行内交互态不被重置
  const mergePapers = (fresh: Paper[]) => {
    setPapers((prev) => {
      const byId = new Map(prev.map((p) => [p.id, p]))
      return fresh.map((f) => {
        const old = byId.get(f.id)
        if (!old) return f
        if (editGuardRef.current.has(f.id)) return old
        return MERGE_KEYS.every((k) => old[k] === f[k]) ? old : f
      })
    })
  }

  const load = async () => {
    try {
      const [ps, fs] = await Promise.all([api.list(), api.folders()])
      mergePapers(ps)
      setFolders(fs)
    } catch (e: any) {
      toast.error(`列表加载失败：${e?.message || e}`)
    } finally {
      setLoading(false)
    }
  }
  useEffect(() => { load() }, [])

  useEffect(() => {
    const s = new Set<string>()
    if (editNote) s.add(editNote)
    if (menuFor) s.add(menuFor)
    editGuardRef.current = s
  }, [editNote, menuFor])

  // 后台解析期间每 2 秒刷新列表；全部完成/失败后自动停止
  const parsing = papers.some((p) => p.status === 'parsing')
  useEffect(() => {
    if (!parsing) return
    const timer = window.setInterval(() => {
      api.list().then(mergePapers).catch(() => {})
    }, 2000)
    return () => window.clearInterval(timer)
  }, [parsing])

  // 点击空白处收起论文行菜单
  useEffect(() => {
    if (!menuFor) return
    const close = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.paper-menu')) setMenuFor(null)
    }
    addEventListener('mousedown', close)
    return () => removeEventListener('mousedown', close)
  }, [menuFor])

  // ---------- 上传队列 ----------
  // 整批落定后汇总一次，避免每个文件都弹一条 toast 刷屏
  const summarizeIfIdle = () => {
    if (pendingRef.current.length || runningRef.current > 0) return
    const list = uploadsRef.current
    const ok = list.filter((u) => u.status === 'done').length
    const bad = list.filter((u) => u.status === 'error').length
    if (ok) toast.success(`已添加 ${ok} 篇论文，正在后台解析，完成后不会自动打开`)
    if (bad) toast.error(`${bad} 篇上传失败，可在上传面板查看原因并单独重试`)
  }

  const runUpload = async (item: UploadItem) => {
    const ctrl = new AbortController()
    abortsRef.current.set(item.key, ctrl)
    patchUpload(item.key, { status: 'uploading', error: undefined })
    try {
      await api.upload(item.file, item.folderId, ctrl.signal)
      patchUpload(item.key, { status: 'done' })
      load()
    } catch (e: any) {
      if (ctrl.signal.aborted) patchUpload(item.key, { status: 'canceled' })
      else patchUpload(item.key, { status: 'error', error: e?.message || String(e) })
    } finally {
      abortsRef.current.delete(item.key)
      runningRef.current -= 1
      pump()
      summarizeIfIdle()
    }
  }

  const pump = () => {
    while (runningRef.current < UPLOAD_CONCURRENCY && pendingRef.current.length) {
      const item = pendingRef.current.shift()!
      runningRef.current += 1
      runUpload(item)
    }
  }

  const enqueue = (picked: File[]) => {
    const files = picked.filter((f) => f.name.toLowerCase().endsWith('.pdf'))
    const skipped = picked.length - files.length
    if (skipped) toast.info(`已忽略 ${skipped} 个非 PDF 文件`)
    if (!files.length) {
      if (!skipped) toast.error('请选择 PDF 文件')
      return
    }
    // 入队时锁定目标文件夹：上传过程中切换侧栏不影响已排队的文件
    const folderId = activeFolder !== 'all' && activeFolder !== 'none' ? activeFolder : undefined
    const items: UploadItem[] = files.map((file) => ({
      key: `u${++seqRef.current}`, file, folderId, status: 'waiting',
    }))
    // 新批次清掉上一批已成功的记录，失败项保留以便重试
    updateUploads((list) => [...list.filter((u) => u.status === 'error'), ...items])
    pendingRef.current.push(...items)
    pump()
  }

  const cancelUpload = (key: string) => {
    const waiting = pendingRef.current.some((u) => u.key === key)
    if (waiting) {
      pendingRef.current = pendingRef.current.filter((u) => u.key !== key)
      patchUpload(key, { status: 'canceled' })
      // 取消的可能正是最后一个排队项：此时没有 in-flight 回调来触发汇总
      summarizeIfIdle()
    } else {
      abortsRef.current.get(key)?.abort()
    }
  }
  const cancelAllUploads = () => {
    const waiting = new Set(pendingRef.current.map((u) => u.key))
    pendingRef.current = []
    updateUploads((list) => list.map((u) => waiting.has(u.key) ? { ...u, status: 'canceled' } : u))
    abortsRef.current.forEach((c) => c.abort())
    summarizeIfIdle()
  }
  const retryUpload = (key: string) => {
    const item = uploadsRef.current.find((u) => u.key === key)
    if (!item || (item.status !== 'error' && item.status !== 'canceled')) return
    const again: UploadItem = { ...item, status: 'waiting', error: undefined }
    patchUpload(key, { status: 'waiting', error: undefined })
    pendingRef.current.push(again)
    pump()
  }
  const clearUploads = () =>
    updateUploads((list) => list.filter((u) => u.status === 'waiting' || u.status === 'uploading'))

  const uploadActive = uploads.some((u) => u.status === 'waiting' || u.status === 'uploading')
  const uploadDone = uploads.filter((u) => u.status === 'done').length

  const retryPaper = async (p: Paper) => {
    try {
      await api.retryPaper(p.id)
      setPapers((ps) => ps.map((x) => x.id === p.id
        ? { ...x, status: 'parsing', parse_error: null } : x))
      toast.success('已重新开始解析')
    } catch (e: any) { toast.error(`重试失败：${e?.message || e}`) }
  }

  const removePaper = async (p: Paper) => {
    const ok = await confirm({
      title: `删除《${p.title || p.filename}》？`,
      message: '相关导读、卡片、笔记与标亮也会一并删除，此操作不可撤销。',
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try {
      await api.deletePaper(p.id)
      toast.success('论文已删除')
      load()
    } catch (e: any) { toast.error(`删除失败：${e?.message || e}`) }
  }

  const startNote = (p: Paper) => {
    setEditNote(p.id)
    setNoteDraft(p.note || '')
  }
  const saveNote = async (pid: string) => {
    // Enter 与 blur 可能先后触发同一保存；Escape 取消后的 blur 不应再保存
    if (noteBusyRef.current === pid) return
    if (noteCancelRef.current === pid) { noteCancelRef.current = null; return }
    noteBusyRef.current = pid
    try {
      await api.setNote(pid, noteDraft)
      setPapers((ps) => ps.map((x) => x.id === pid ? { ...x, note: noteDraft } : x))
      setEditNote(null)
    } catch (e: any) {
      // 保存失败：输入框保持打开、草稿不丢，用户可以直接再试
      toast.error(`备注保存失败：${e?.message || e}`)
    } finally {
      noteBusyRef.current = null
    }
  }

  // ---------- 综述 ----------
  const openReview = () => {
    setReviewText(null)
    setSelIds(readyPapers.filter((p) => p.collected && p.has_analysis).map((p) => p.id))
    setReviewOpen(true)
  }
  const toggleSel = (pid: string) =>
    setSelIds((s) => s.includes(pid) ? s.filter((x) => x !== pid) : [...s, pid])

  // 生成要 20 秒上下，阶段化文案让用户知道没有卡死
  const reviewPhases = [
    `正在通读 ${selIds.length} 篇论文…`,
    '正在对比主题与方法…',
    '正在归纳结论与研究空白…',
  ]
  useEffect(() => {
    if (!reviewBusy) return
    setReviewPhase(0)
    const timer = window.setInterval(() => setReviewPhase((p) => Math.min(p + 1, 2)), 7000)
    return () => window.clearInterval(timer)
  }, [reviewBusy])

  const genReview = async () => {
    if (selIds.length < 2) return
    const ctrl = new AbortController()
    reviewAbortRef.current = ctrl
    setReviewBusy(true)
    try {
      const text = (await api.review(selIds, ctrl.signal)).review
      if (!text?.trim()) toast.error('综述生成失败：模型没有返回内容，请重试')
      else setReviewText(text)
    } catch (e: any) {
      if (ctrl.signal.aborted) toast.info('已取消综述生成')
      else toast.error(`综述生成失败：${e?.message || e}`)
    } finally {
      setReviewBusy(false)
      reviewAbortRef.current = null
    }
  }

  const doClear = async () => {
    const ok = await confirm({
      title: '清除全部本地数据？',
      message: '将删除所有论文、卡片、笔记、标亮、文件夹、档案与 PDF，并清除已保存的 API Key。此操作不可撤销。',
      confirmText: '全部清除', danger: true,
    })
    if (!ok) return
    setClearing(true)
    try {
      await api.clearData()
      setPrivacyOpen(false)
      setActiveFolder('all')
      toast.success('已清除全部本地数据')
      load()
    } catch (e: any) { toast.error(`清除失败：${e?.message || e}`) }
    finally { setClearing(false) }
  }

  // ---------- 文件夹 ----------
  const createFolder = async () => {
    const name = (newFolderName || '').trim()
    if (!name) { setNewFolderName(null); return }
    if (folderBusy) return
    setFolderBusy(true)
    try {
      const f = await api.addFolder(name)
      setNewFolderName(null)
      setActiveFolder(f.id)
      toast.success(`文件夹「${name}」已创建`)
      load()
    } catch (e: any) { toast.error(`新建文件夹失败：${e?.message || e}`) }
    finally { setFolderBusy(false) }
  }

  const saveRename = async () => {
    if (!renameFolder) return
    const name = renameFolder.name.trim()
    if (!name) { setRenameFolder(null); return }
    if (folderBusy) return
    setFolderBusy(true)
    try {
      await api.renameFolder(renameFolder.id, name)
      setRenameFolder(null)
      toast.success('文件夹已重命名')
      load()
    } catch (e: any) { toast.error(`重命名失败：${e?.message || e}`) }
    finally { setFolderBusy(false) }
  }

  const removeFolder = async (f: Folder) => {
    const n = f.paper_count ?? papers.filter((p) => p.folder_id === f.id).length
    const ok = await confirm({
      title: `删除文件夹「${f.name}」？`,
      message: `其中 ${n} 篇论文（含导读、卡片、笔记、标亮与 PDF）会一并删除，此操作不可撤销。`,
      confirmText: '删除', danger: true,
    })
    if (!ok) return
    try {
      await api.deleteFolder(f.id)
      if (activeFolder === f.id) setActiveFolder('all')
      toast.success(`文件夹「${f.name}」已删除`)
      load()
    } catch (e: any) { toast.error(`删除文件夹失败：${e?.message || e}`) }
  }

  const doPlace = async (fid: string | null) => {
    if (!placement) return
    const p = placement.paper
    const target = fid ? (folders.find((f) => f.id === fid)?.name || '文件夹') : '未分类'
    try {
      if (placement.mode === 'move') await api.movePaper(p.id, fid)
      else await api.copyPaper(p.id, fid)
      toast.success(placement.mode === 'move' ? `已移动到「${target}」` : `已复制到「${target}」`)
      setPlacement(null)
      load()
    } catch (e: any) { toast.error(`${placement.mode === 'move' ? '移动' : '复制'}失败：${e?.message || e}`) }
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
        <div className="home-head-row">
          <h1>论文阅读智能学伴</h1>
          {reviewablePapers.length >= 2 && (
            <button className="btn" onClick={openReview}>
              <span className="ico"><BookOpen size={16} /></span>文献综述
            </button>
          )}
          <button className="btn" onClick={() => setPrivacyOpen(true)}>
            <span className="ico"><ShieldCheck size={16} /></span>隐私与数据
          </button>
          <button className="btn" onClick={() => setSettings(true)}>
            <span className="ico"><Settings size={16} /></span>模型设置
          </button>
        </div>
        <div className="sub">上传 PDF，生成导读 → 真实版面精读 → 术语卡 / 子对话卡 / 笔记 / 自测</div>
      </div>

      <div className="home-body">
        <aside className="folder-sidebar">
          <div className="fs-head">
            <span>文件夹</span>
            <button className="btn small" disabled={folderBusy} onClick={() => setNewFolderName('')}>
              <span className="ico"><FolderPlus size={16} /></span>新建
            </button>
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
            <span className="fs-name">
              <span className="ico"><FileText size={16} /></span>
              <span className="fs-label">全部论文</span>
            </span>
            <span className="fs-count">{papers.length}</span>
          </button>
          <button className={`fs-item${activeFolder === 'none' ? ' on' : ''}`} onClick={() => setActiveFolder('none')}>
            <span className="fs-name">
              <span className="ico"><Inbox size={16} /></span>
              <span className="fs-label">未分类</span>
            </span>
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
                  <span className="ico"><FolderIcon size={16} /></span>
                  <span className="fs-label">{f.name}</span>
                </button>
              )}
              <span className="fs-count">{f.paper_count ?? 0}</span>
              <span className="fs-actions">
                <button className="x" title="重命名" onClick={() => setRenameFolder({ id: f.id, name: f.name })}>
                  <Pencil size={16} />
                </button>
                <button className="x danger" title="删除文件夹（连同论文）" onClick={() => removeFolder(f)}>
                  <Trash2 size={16} />
                </button>
              </span>
            </div>
          ))}
          {!folders.length && <div className="fs-empty">还没有文件夹，点「新建」按课题分组。</div>}
        </aside>

        <main className="home-main">
          {/* 隐藏 file input 铺满拖拽区：点击/键盘（聚焦后 Enter/Space）都走原生控件，无需自造 role */}
          <label className={`drop${over ? ' on' : ''}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true) }}
            onDragLeave={(e) => {
              // 指针移入子元素（铺满的 input）也会触发 dragleave，不 guard 会闪烁
              if (e.currentTarget.contains(e.relatedTarget as Node)) return
              setOver(false)
            }}
            onDrop={(e) => {
              e.preventDefault(); setOver(false)
              enqueue(Array.from(e.dataTransfer.files))
            }}>
            <span className="ico drop-ico"><FileUp size={18} /></span>
            <b>点击或拖拽 PDF 到此处</b>
            <span className="drop-sub">
              {activeFolder !== 'all' && activeFolder !== 'none'
                ? `将归入文件夹「${folderName}」；支持一次选择/拖入多篇`
                : '支持一次选择/拖入多篇，解析在后台进行，完成后不会自动打开'}
            </span>
            <input ref={fileRef} className="drop-input" type="file" accept="application/pdf" multiple
              aria-label="选择 PDF 文件上传"
              onChange={(e) => {
                const fs = Array.from(e.target.files || [])
                e.target.value = ''
                if (fs.length) enqueue(fs)
              }} />
          </label>

          {uploads.length > 0 && (
            <div className="upload-panel">
              <div className="up-head">
                <span>上传队列{uploadActive ? `（${uploadDone}/${uploads.length}）` : ''}</span>
                <span className="up-head-actions">
                  {uploadActive && <button className="btn small" onClick={cancelAllUploads}>全部取消</button>}
                  <button className="btn small" disabled={uploadActive} onClick={clearUploads}>清除记录</button>
                </span>
              </div>
              {uploads.map((u) => (
                <div key={u.key} className={`up-item ${u.status}`}>
                  <span className="ico">
                    {u.status === 'waiting' && <Clock3 size={16} />}
                    {u.status === 'uploading' && <Spinner size={14} />}
                    {u.status === 'done' && <CheckCircle2 size={16} />}
                    {u.status === 'error' && <AlertCircle size={16} />}
                    {u.status === 'canceled' && <Ban size={16} />}
                  </span>
                  <span className="up-name" title={u.file.name}>{u.file.name}</span>
                  {u.status === 'error' && u.error && <span className="up-err" title={u.error}>{u.error}</span>}
                  <span className="up-status">{UPLOAD_LABEL[u.status]}</span>
                  {(u.status === 'waiting' || u.status === 'uploading') && (
                    <button className="up-act" title="取消上传" onClick={() => cancelUpload(u.key)}>
                      <X size={16} />
                    </button>
                  )}
                  {(u.status === 'error' || u.status === 'canceled') && (
                    <button className="up-act" title="重试上传" onClick={() => retryUpload(u.key)}>
                      <RotateCcw size={16} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}

          {loading && <Skeleton lines={4} />}

          {!loading && papers.length === 0 && (
            <div className="empty-hero">
              <span className="ico empty-hero-ico"><FileUp size={18} /></span>
              <b>拖入第一篇 PDF 开始</b>
              <p>上传后自动生成导读，再进入真实版面精读。</p>
              <button className="btn primary" onClick={() => fileRef.current?.click()}>选择 PDF 文件</button>
            </div>
          )}

          {papers.length > 0 && (
            <h3 className="list-head">我的论文 · {folderName}（{visiblePapers.length}）</h3>
          )}
          <div className="papers">
            {visiblePapers.map((p) => (
              <div className="paper-row" key={p.id}>
                {p.status === 'parsed'
                  ? <a className="t" href={`#/paper/${p.id}`}>{p.title || p.filename}</a>
                  : <span className="t pending" title={p.parse_error || undefined}>
                    {p.title || p.filename}</span>}
                {p.folder_name && (
                  <span className="badge folder-badge" title={`文件夹：${p.folder_name}`}>
                    <span className="ico"><FolderIcon size={16} /></span>
                    <span className="fb-name">{p.folder_name}</span>
                  </span>
                )}
                {p.status === 'parsed' && <span className="m">{p.pages} 页</span>}
                {p.status === 'parsing'
                  ? <span className="badge parsing"><Spinner size={12} />解析中</span>
                  : <span className={`badge${p.status === 'error' ? ' error' : ''}`} title={p.parse_error || undefined}>
                    {p.status === 'parsed' ? '已解析' : p.status === 'error' ? '解析失败' : p.status}
                  </span>}
                {p.status === 'error' && (
                  <button className="btn small" title={p.parse_error || '重新解析'} onClick={(e) => {
                    e.preventDefault(); e.stopPropagation(); retryPaper(p)
                  }}>重试</button>
                )}
                <button className="btn small" title="删除论文" onClick={(e) => {
                  e.preventDefault(); e.stopPropagation(); removePaper(p)
                }}>删除</button>
                {editNote === p.id
                  ? <input className="note-input" autoFocus value={noteDraft}
                    placeholder="写点备注，回车保存…"
                    onChange={(e) => setNoteDraft(e.target.value)}
                    onBlur={() => saveNote(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') saveNote(p.id)
                      if (e.key === 'Escape') { noteCancelRef.current = p.id; setEditNote(null) }
                    }} />
                  : <button className="note-view" onClick={() => startNote(p)} title="点击编辑备注">
                    <span className="ico">{p.note ? <NotebookPen size={16} /> : <Plus size={16} />}</span>
                    <span className="note-text">{p.note || '备注'}</span>
                  </button>}
                {p.status === 'parsed' && (
                  <div className="paper-menu">
                    <button className="btn small" title="更多操作"
                      onClick={(e) => { e.preventDefault(); e.stopPropagation(); setMenuFor(menuFor === p.id ? null : p.id) }}>
                      <MoreHorizontal size={16} />
                    </button>
                    {menuFor === p.id && (
                      <div className="paper-menu-pop" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => { setPlacement({ paper: p, mode: 'move' }); setMenuFor(null) }}>移动到文件夹…</button>
                        <button onClick={() => { setPlacement({ paper: p, mode: 'copy' }); setMenuFor(null) }}>复制到文件夹…</button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))}
            {!visiblePapers.length && papers.length > 0 && (
              <div className="empty">这个文件夹里还没有论文。切到「全部论文」上传，或用论文行的「⋯ → 移动到文件夹」把已有论文移进来。</div>
            )}
          </div>
        </main>
      </div>

      {reviewOpen && (
        <Modal title="文献综述" className="review-modal" dismissable={!reviewBusy}
          onClose={() => { reviewAbortRef.current?.abort(); setReviewOpen(false) }}
          footer={<>
            {reviewBusy
              ? <button className="btn" onClick={() => reviewAbortRef.current?.abort()}>取消生成</button>
              : <button className="btn" onClick={() => setReviewOpen(false)}>关闭</button>}
            {!reviewText && !reviewBusy && (
              <button className="btn primary" disabled={selIds.length < 2} onClick={genReview}>
                生成综述（{selIds.length}）
              </button>
            )}
            {reviewText && <button className="btn" onClick={() => setReviewText(null)}>重新选择</button>}
          </>}>
          {!reviewText && <>
            <p className="empty review-lead">
              勾选要纳入综述的论文（至少 2 篇），我会对比它们的主题、方法、结论与空白。
            </p>
            <div className="review-pick">
              {readyPapers.map((p) => (
                <label key={p.id} className={`pick${selIds.includes(p.id) ? ' on' : ''}${p.has_analysis ? '' : ' disabled'}`}
                  title={p.has_analysis ? undefined : '这篇论文还没有生成导读，无法纳入综述'}>
                  <input type="checkbox" checked={selIds.includes(p.id)} disabled={!p.has_analysis || reviewBusy}
                    onChange={() => toggleSel(p.id)} />
                  <span className="pt2">{p.title || p.filename}</span>
                  {p.collected ? <span className="badge">已收藏</span> : null}
                  {!p.has_analysis ? <span className="badge error">未生成导读</span> : null}
                </label>
              ))}
            </div>
          </>}
          {reviewBusy && (
            <div className="review-progress">
              <div className="loading review-phase"><Spinner size={14} />{reviewPhases[reviewPhase]}</div>
              <Skeleton lines={5} />
            </div>
          )}
          {reviewText && <Markdown className="rv" text={reviewText} />}
        </Modal>
      )}

      {placement && (
        <Modal title={placement.mode === 'move' ? '移动到文件夹' : '复制到文件夹'}
          className="folder-pick" onClose={() => setPlacement(null)}
          footer={<button className="btn" onClick={() => setPlacement(null)}>取消</button>}>
          <p className="empty placement-lead">
            《{placement.paper.title || placement.paper.filename}》
            {placement.mode === 'copy'
              ? '：复制会生成一篇完整独立的副本（含导读、卡片、笔记、标亮、画像），之后互不影响。'
              : `：当前在「${placement.paper.folder_name || '未分类'}」。`}
          </p>
          <div className="folder-list">
            <button className="folder-choice" disabled={!placement.paper.folder_id}
              onClick={() => doPlace(null)}>
              <span className="ico"><Inbox size={16} /></span>未分类
            </button>
            {folders.map((f) => (
              <button key={f.id} className="folder-choice"
                disabled={placement.mode === 'move' && placement.paper.folder_id === f.id}
                onClick={() => doPlace(f.id)}>
                <span className="ico"><FolderIcon size={16} /></span>{f.name}
                <span className="fs-count">{f.paper_count ?? 0}</span>
              </button>
            ))}
          </div>
          {!folders.length && <div className="empty">还没有文件夹，请先在左侧新建。</div>}
        </Modal>
      )}

      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {privacyOpen && (
        <Modal title="隐私与数据说明" onClose={() => setPrivacyOpen(false)}
          footer={<>
            <button className="btn" onClick={() => setPrivacyOpen(false)}>关闭</button>
            <button className="btn danger" disabled={clearing} onClick={doClear}>
              {clearing ? '清除中…' : '一键清除全部数据'}
            </button>
          </>}>
          <div className="privacy">
            <p><b>数据存储位置</b>：你的论文原文、生成的导读/术语/卡片/笔记/标亮、阅读计划与文件夹，全部保存在<b>本机</b>（打包版在程序目录的 <code>data/</code>，源码运行在 <code>backend/data/</code>；SQLite + PDF 文件），不会上传到本应用以外的服务器。</p>
            <p><b>模型调用</b>：生成导读、翻译、术语解释、子对话、自测等功能，会把<b>相关论文正文片段与你的提问</b>发送到你配置的模型服务（默认阿里云 DashScope）用于推理。请仅上传你有权处理的论文，并在填写 API Key 前确认服务商的隐私政策。</p>
            <p><b>API Key</b>：仅保存在本机数据库（源码运行也可预置在 <code>backend/.env</code>），不回显明文、不记录日志、不对外发送（仅用于调用你配置的模型接口）。</p>
            <p><b>你的权利</b>：可随时在首页逐篇删除论文，或用下方按钮<b>一键清除全部本地数据</b>。</p>
          </div>
        </Modal>
      )}
    </div>
  )
}