import { useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Paper } from './api'
import SettingsModal from './SettingsModal'
import Markdown from './Markdown'

export default function Home() {
  const [papers, setPapers] = useState<Paper[]>([])
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
  const fileRef = useRef<HTMLInputElement>(null)
  const load = () => api.list().then(setPapers).catch((e) => setErr(String(e)))
  useEffect(() => { load() }, [])
  const upload = async (f: File) => {
    setBusy('解析中…'); setErr('')
    try { const { id } = await api.upload(f); location.hash = `#/paper/${id}` }
    catch (e: any) { setErr(`上传失败：${e?.message || e}`); setBusy('') }
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
    if (!confirm('确定清除全部本地数据吗？将删除所有论文、卡片、档案与 PDF，并清除已保存的 API Key。此操作不可撤销。')) return
    setClearing(true); setErr('')
    try { await api.clearData(); setPrivacyOpen(false); load() }
    catch (e: any) { setErr(`清除失败：${e?.message || e}`) }
    finally { setClearing(false) }
  }
  return (
    <div className="home">
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <h1 style={{ flex: 1 }}>论文阅读学伴</h1>
        {papers.length >= 2 && <button className="btn" onClick={openReview}>文献综述</button>}
        <button className="btn" onClick={() => setPrivacyOpen(true)}>隐私与数据</button>
        <button className="btn" onClick={() => setSettings(true)}>模型设置</button>
      </div>
      <div className="sub">上传 PDF，生成导读 → 真实版面精读 → 术语卡 / 子对话卡 / 自测</div>
      <div className={`drop${over ? ' on' : ''}`}
        onClick={() => fileRef.current?.click()}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); const f = e.dataTransfer.files[0]; if (f) upload(f) }}>
        {busy || <><b>点击或拖拽 PDF 到此处</b><br />只支持英文/中文学术论文 PDF，解析约 5–15 秒</>}
        <input ref={fileRef} type="file" accept="application/pdf" hidden
          onChange={(e) => { const f = e.target.files?.[0]; if (f) upload(f) }} />
      </div>
      {err && <div className="err" style={{ marginBottom: 14 }}>{err}</div>}
      {papers.length > 0 && <h3 style={{ fontSize: 13, color: 'var(--muted)', margin: '16px 0 8px' }}>我的论文</h3>}
      <div className="papers">
        {papers.map((p) => (
          <div className="paper-row" key={p.id}>
            <a className="t" href={`#/paper/${p.id}`}>{p.title || p.filename}</a>
            <span className="m">{p.pages} 页</span>
            <span className="badge">{p.status === 'parsed' ? '已解析' : p.status}</span>
            <button className="btn small" title="删除论文" onClick={(e) => {
              e.preventDefault(); e.stopPropagation()
              if (confirm(`删除《${p.title || p.filename}》？相关卡片也会一并删除。`)) {
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
          </div>
        ))}
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
      {settings && <SettingsModal onClose={() => setSettings(false)} />}
      {privacyOpen && <div className="modal-bg" onClick={() => setPrivacyOpen(false)}>
        <div className="modal" onClick={(e) => e.stopPropagation()}>
          <h2>隐私与数据说明</h2>
          <div className="privacy">
            <p><b>数据存储位置</b>：你的论文原文、生成的导读/术语/卡片、阅读计划与笔记，全部保存在<b>本机</b>（后端 <code>backend/data/</code> 目录下的 SQLite 与 PDF 文件），不会上传到本应用以外的服务器。</p>
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
