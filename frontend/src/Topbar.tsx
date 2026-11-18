import { useEffect, useState } from 'react'
import {
  ArrowLeft, ClipboardList, Compass, GraduationCap, Globe, Languages, Library,
  List, MoreHorizontal, Search, Settings, Sparkles, Star, Table2, TriangleAlert, X,
} from 'lucide-react'

/** 顶栏对外接口：状态（busy/激活）全部由 PaperView 传入，业务回调留在 PaperView */
export interface TopbarProps {
  title: string
  onBack: () => void
  tablesLoading: boolean
  tablesErr: string
  onRetryTables: () => void
  showSections: boolean
  onToggleSections: () => void
  onOpenFind: () => void
  translationMode: boolean
  onToggleTranslation: () => void
  collected: boolean
  onToggleCollect: () => void
  hasAnalysis: boolean
  analyzeBusy: boolean
  onAnalyze: () => void
  onCancelAnalyze: () => void
  onQuiz: () => void
  onAskGlobal: () => void
  recBusy: boolean
  onRecommend: () => void
  onCancelRecommend: () => void
  planBusy: boolean
  onOpenPlan: () => void
  onCancelPlan: () => void
  onProfile: () => void
  onSettings: () => void
}

/**
 * 工作台顶栏：左=返回+标题+状态 chip；中=章节/检索/原文译文/收藏；
 * 右=生成导读/自测/问全篇/推荐；低频项（摸底/阅读计划/设置）收进「⋯」溢出菜单。
 * 1280 以下中/右按钮图标化（CSS 隐藏 .lbl），靠 title 提示，保证窄屏不换行。
 */
export default function Topbar(p: TopbarProps) {
  const [menuOpen, setMenuOpen] = useState(false)

  // 溢出菜单：外点关闭；Esc 用捕获阶段拦截，避免和 PaperView 的全局 Esc 逐层关闭打架
  useEffect(() => {
    if (!menuOpen) return
    const down = (e: MouseEvent) => {
      if (!(e.target as HTMLElement).closest('.tb-more')) setMenuOpen(false)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); setMenuOpen(false) }
    }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', esc, true)
    return () => {
      document.removeEventListener('mousedown', down)
      document.removeEventListener('keydown', esc, true)
    }
  }, [menuOpen])

  const pick = (fn: () => void) => () => { setMenuOpen(false); fn() }

  return (
    <div className="topbar">
      <div className="tb-left">
        <button className="btn small" onClick={p.onBack} title="返回文献库">
          <span className="ico"><ArrowLeft size={16} strokeWidth={2} /></span>
        </button>
        <div className="title" title={p.title}>{p.title}</div>
        {p.tablesLoading && (
          <span className="tb-chip"><span className="ico"><Table2 size={14} strokeWidth={2} /></span>正在识别表格…</span>
        )}
        {p.tablesErr && (
          <span className="tb-chip err" title={p.tablesErr}>
            <span className="ico"><TriangleAlert size={14} strokeWidth={2} /></span>表格识别失败
            <button type="button" className="table-retry" onClick={p.onRetryTables}>重试</button>
          </span>
        )}
        {p.planBusy && (
          <span className="tb-chip">
            <span className="ico"><Compass size={14} strokeWidth={2} /></span>计划生成中…
            <button type="button" className="table-retry" onClick={p.onCancelPlan}>取消</button>
          </span>
        )}
      </div>
      <div className="tb-mid">
        <button className={`btn small${p.showSections ? ' primary' : ''}`} onClick={p.onToggleSections}
          title={p.showSections ? '收起章节概要侧边栏' : '展开章节概要侧边栏'}>
          <span className="ico"><List size={16} strokeWidth={2} /></span><span className="lbl">章节</span>
        </button>
        <button className="btn small" onClick={p.onOpenFind} title="在当前论文全文中检索（Ctrl+F）">
          <span className="ico"><Search size={16} strokeWidth={2} /></span><span className="lbl">检索</span>
        </button>
        <button className={`btn small${p.translationMode ? ' primary' : ''}`} onClick={p.onToggleTranslation}
          title="切换已翻译段落的原文/译文；未翻译段落始终显示原文">
          <span className="ico"><Languages size={16} strokeWidth={2} /></span>
          <span className="lbl">{p.translationMode ? '译文' : '原文'}</span>
        </button>
        <button className={`btn small${p.collected ? ' primary' : ''}`} onClick={p.onToggleCollect}
          title={p.collected ? '取消收藏' : '加入文献库（参与推荐与综述）'}>
          <span className="ico"><Star size={16} strokeWidth={2} fill={p.collected ? 'currentColor' : 'none'} /></span>
          <span className="lbl">{p.collected ? '已收藏' : '收藏'}</span>
        </button>
      </div>
      <div className="tb-right">
        {p.analyzeBusy ? (
          <button className="btn primary" onClick={p.onCancelAnalyze} title="取消生成导读">
            <span className="ico"><X size={16} strokeWidth={2} /></span><span className="lbl">取消</span>
          </button>
        ) : (
          <button className={`btn${p.hasAnalysis ? '' : ' primary'}`} onClick={p.onAnalyze}
            title={p.hasAnalysis ? '重新生成全文导读（约 1 分钟）' : '生成全文导读（约 1 分钟）'}>
            <span className="ico"><Sparkles size={16} strokeWidth={2} /></span>
            <span className="lbl">{p.hasAnalysis ? '重新导读' : '生成导读'}</span>
          </button>
        )}
        <button className="btn" onClick={p.onQuiz} title="全篇自测：3 道题检验掌握程度">
          <span className="ico"><GraduationCap size={16} strokeWidth={2} /></span><span className="lbl">自测</span>
        </button>
        <button className="btn" onClick={p.onAskGlobal} title="不绑定具体段落，让学伴基于全文导读与目录回答">
          <span className="ico"><Globe size={16} strokeWidth={2} /></span><span className="lbl">问全篇</span>
        </button>
        {p.recBusy ? (
          <button className="btn" onClick={p.onCancelRecommend} title="取消推荐">
            <span className="ico"><X size={16} strokeWidth={2} /></span><span className="lbl">取消</span>
          </button>
        ) : (
          <button className="btn" onClick={p.onRecommend} title="推荐相关文献（约 1 分钟）">
            <span className="ico"><Library size={16} strokeWidth={2} /></span><span className="lbl">推荐</span>
          </button>
        )}
        <div className="tb-more">
          <button className={`btn${menuOpen ? ' primary' : ''}`} title="更多操作"
            aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((v) => !v)}>
            <span className="ico"><MoreHorizontal size={16} strokeWidth={2} /></span>
          </button>
          {menuOpen && (
            <div className="tb-menu" role="menu">
              <button role="menuitem" onClick={pick(p.onProfile)}>
                <span className="ico"><ClipboardList size={16} strokeWidth={2} /></span>摸底问卷
              </button>
              <button role="menuitem" disabled={p.planBusy} onClick={pick(p.onOpenPlan)}>
                <span className="ico"><Compass size={16} strokeWidth={2} /></span>
                {p.planBusy ? '计划生成中…' : '阅读计划'}
              </button>
              <button role="menuitem" onClick={pick(p.onSettings)}>
                <span className="ico"><Settings size={16} strokeWidth={2} /></span>设置
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}