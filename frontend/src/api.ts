export interface Block {
  id: string; page: number; col: number; type: 'para' | 'heading' | 'figure' | 'formula'
  y0: number; y1: number; x0: number; x1: number; size: number; text: string; section_id: string | null
  /** 落在表格框内的正文块（摘要会排除；卡片锚点仍有效） */
  table_id?: string
  /** 页脚/脚注小字，原位翻译跳过 */
  footer?: boolean
}
export interface Section {
  id: string; title: string; level: number; page: number; heading_block_id: string
  is_references: boolean; outline: string; order: number
}
export interface Element { kind: string; text: string; refs: string[]; pages: number[]; checked?: boolean }
export interface Term { term: string; zh: string; expl: string; refs: string[]; pages: number[] }
export interface Analysis { elements: Element[]; outlines: { section_id: string; outline: string }[]; terms?: Term[] }
export interface Card {
  id: string; paper_id: string; type: string; block_id: string; top: number
  data: Record<string, any>; created_at: number
}
export interface FormulaBox {
  page: number; x0: number; y0: number; x1: number; y1: number
  number?: string | null; src?: string
}
export interface TableBox {
  id: string; page: number
  x0: number; y0: number; x1: number; y1: number
  caption?: string; caption_block_id?: string
  /** 只在 quality === 'ok' 时存在；旋转/乱码表为图片模式 */
  rows?: string[][]
  quality: 'ok' | 'image_only'
  reason?: string
  source?: string
}
/** 表格抽取规则版本：老论文没有这个版本号时，前端打开会调 /tables 懒补 */
export const TABLES_VERSION = 3
export interface Structure {
  title: string; pages: number; blocks: Block[]; sections: Section[]
  /** 后端版面模型给出的整条公式框（1.0 解析器新增；老论文没有这个字段） */
  formulas?: FormulaBox[]
  tables?: TableBox[]
  tables_version?: number
}
export interface Paper {
  id: string; title: string; filename: string; pages: number
  structure: Structure; analysis: Analysis | null; status: string
  parse_error?: string | null
  has_analysis?: number
  visited?: number; collected?: number; domain?: string | null; note?: string | null
  folder_id?: string | null; folder_name?: string | null
}
export interface Folder {
  id: string; name: string; created_at: number; paper_count?: number
}
export interface Highlight {
  id: string; paper_id: string; page: number; color: string
  text: string; rects: number[][]; created_at: number
}
export interface NewHighlight {
  page: number; color: string; text: string; rects: number[][]
}
export interface ReasoningOption { type: 'toggle' | 'effort' | 'budget_tokens'; values?: string[] }
export interface ModelInfo {
  known: boolean; name: string; reasoning: boolean
  reasoning_options: ReasoningOption[]
  limit: { context?: number; output?: number }
  cost?: Record<string, number>
}
export interface ProviderModelsMeta {
  enabled: string[]; available: number; fetched_at: number | null; source: string
}
export interface Provider {
  id: string; name: string; base_url: string; api_key: string; has_key: boolean
  headers: Record<string, string>; catalog_id: string | null; catalog_name?: string | null
  models: ProviderModelsMeta; in_use: string[]
}
export interface ProviderPreset {
  id: string; name: string; api: string; model_count: number; local: boolean
}
export interface RouteConfig {
  provider_id: string; provider_name: string; model: string; effort: string; configured?: boolean
}
export interface Routes { default: RouteConfig; translate: RouteConfig }
export interface ModelRow {
  id: string; name: string; known: boolean; reasoning_options: ReasoningOption[]; context?: number
}
export interface ProviderModelList {
  models: ModelRow[]; enabled: string[]; source: string; error: string; fetched_at: number | null
}
export interface ProviderTestResult {
  ok: boolean; model?: string; provider?: string; latency_ms?: number
  reply?: string; error?: string; reasoning?: Record<string, unknown>
}

export interface ProfilePrior {
  domain: string; familiarity: string; known_terms: string[]; updated_at: number
}
export interface PaperMeta {
  paper_id: string; domain: string | null; familiarity: string | null
  known_terms: string[]; dismissed_terms?: string[]; plan: ReadingPlan | null
  visited: number; collected: number
}
export interface ReadingPlan {
  summary: string; focus: string[]; skip: string[]; term_depth: string
  abstract_emphasis: string; suggestions: string[]; domain: string; familiarity: string
}
export interface ProfileResponse {
  guess: { domain: string; terms: string[]; reason: string }
  prior: ProfilePrior | null
  meta: PaperMeta | null
}
export interface SearchResult {
  source: string; title: string; abstract?: string; url?: string
  year?: string; doi?: string; authors?: string[]; error?: string
}
export interface Recommendation {
  title: string; reason: string; doi?: string; url?: string
  matched?: boolean; source?: string; year?: string
  venue?: string; authors?: string[]; query?: string; direction?: string
}
export interface RecommendResponse {
  items: Recommendation[]
  scope: 'folder' | 'domain' | 'none'
  scope_label: string
  history_count: number
  queries?: { query: string; why: string }[]
  note?: string
}
export interface ChatStep { step: string; text: string }
export interface QuizQuestion {
  type: 'choice' | 'short'
  q: string
  options?: string[]
  answer?: string
  explain?: string
  keypoints?: string[]
  reference?: string
  pages?: number[]
  refs?: string[]
}
export interface QuizResult {
  type: 'choice' | 'short'
  correct: boolean
  your?: string
  answer?: string
  explain?: string
  hit?: string
  feedback?: string
  reference?: string
}
export interface QuizGrade { results: QuizResult[]; score: number; total: number }
/** 入库的一次自测：题目 + 作答 + 判分结果（未判分时 grade 为 null） */
export interface QuizSaved { questions: QuizQuestion[]; answers?: string[]; grade?: QuizGrade | null }

const j = async (r: Response) => {
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    const detail = body?.detail
    // FastAPI 的 422 校验错误是数组，直接放进 Error 会变成 [object Object]
    const message = Array.isArray(detail)
      ? detail.map((d: any) => d?.msg || '').filter(Boolean).join('；')
      : detail
    throw new Error(message || r.statusText)
  }
  return r.json()
}
export const api = {
  list: (): Promise<Paper[]> => fetch('/api/papers').then(j),
  get: (id: string): Promise<Paper> => fetch(`/api/papers/${id}`).then(j),
  deletePaper: (id: string): Promise<any> => fetch(`/api/papers/${id}`, { method: 'DELETE' }).then(j),
  upload: (file: File, folderId?: string, signal?: AbortSignal): Promise<{ id: string }> => {
    const fd = new FormData(); fd.append('file', file)
    const q = folderId ? `?folder_id=${encodeURIComponent(folderId)}` : ''
    return fetch(`/api/papers${q}`, { method: 'POST', body: fd, signal }).then(j)
  },
  retryPaper: (id: string): Promise<{ ok: boolean }> =>
    fetch(`/api/papers/${id}/retry`, { method: 'POST' }).then(j),
  folders: (): Promise<Folder[]> => fetch('/api/folders').then(j),
  addFolder: (name: string): Promise<{ id: string; name: string }> =>
    fetch('/api/folders', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then(j),
  renameFolder: (fid: string, name: string): Promise<{ ok: boolean; name: string }> =>
    fetch(`/api/folders/${fid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name }) }).then(j),
  deleteFolder: (fid: string): Promise<{ ok: boolean; papers_removed: number }> =>
    fetch(`/api/folders/${fid}`, { method: 'DELETE' }).then(j),
  movePaper: (pid: string, folder_id: string | null): Promise<{ ok: boolean }> =>
    fetch(`/api/papers/${pid}/move`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id }) }).then(j),
  copyPaper: (pid: string, folder_id: string | null): Promise<{ id: string }> =>
    fetch(`/api/papers/${pid}/copy`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ folder_id }) }).then(j),
  analyze: (id: string, signal?: AbortSignal): Promise<Analysis> =>
    fetch(`/api/papers/${id}/analyze`, { method: 'POST', signal }).then(j),
  providers: (): Promise<Provider[]> => fetch('/api/providers').then(j),
  providerPresets: (): Promise<ProviderPreset[]> => fetch('/api/provider-presets').then(j),
  addProvider: (b: { name?: string; base_url?: string; api_key?: string; catalog_id?: string | null }): Promise<Provider> =>
    fetch('/api/providers', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j),
  updateProvider: (id: string, b: { name?: string; base_url?: string; api_key?: string; headers?: Record<string, string>; catalog_id?: string | null; clear_key?: boolean }): Promise<Provider> =>
    fetch(`/api/providers/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j),
  deleteProvider: (id: string): Promise<{ ok: boolean }> =>
    fetch(`/api/providers/${id}`, { method: 'DELETE' }).then(j),
  testProvider: (id: string, b: { base_url?: string; api_key?: string; model?: string; effort?: string; purpose?: string }): Promise<ProviderTestResult> =>
    fetch(`/api/providers/${id}/test`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) }).then(j),
  syncProviderModels: (id: string): Promise<ProviderModelList> =>
    fetch(`/api/providers/${id}/models/sync`, { method: 'POST' }).then(j),
  providerModels: (id: string): Promise<ProviderModelList> =>
    fetch(`/api/providers/${id}/models`).then(j),
  saveProviderModels: (id: string, enabled: string[]): Promise<{ ok: boolean; enabled: string[] }> =>
    fetch(`/api/providers/${id}/models`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled }) }).then(j),
  modelInfo: (provider_id: string, model: string): Promise<ModelInfo> =>
    fetch(`/api/model-info?provider_id=${encodeURIComponent(provider_id)}&model=${encodeURIComponent(model)}`).then(j),
  routes: (): Promise<Routes> => fetch('/api/routes').then(j),
  saveRoutes: (r: Partial<Routes>): Promise<Routes> =>
    fetch('/api/routes', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(r) }).then(j),
  probeEfforts: (provider_id: string, model: string, levels: string[]):
    Promise<{ ok: boolean; results: { level: string; ok: boolean; latency_ms: number; error?: string }[] }> =>
    fetch('/api/settings/probe-efforts', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ provider_id, model, levels }) }).then(j),
  refreshCatalog: (): Promise<{ ok: boolean; providers: number; models: number; bytes: number }> =>
    fetch('/api/catalog/refresh', { method: 'POST' }).then(j),
  clearData: (): Promise<{ ok: boolean; papers_removed: number }> =>
    fetch('/api/data/clear', { method: 'POST' }).then(j),
  cards: (pid: string): Promise<Card[]> => fetch(`/api/papers/${pid}/cards`).then(j),
  addCard: (pid: string, c: { type: string; block_id?: string; top?: number; data?: object }): Promise<{ id: string }> =>
    fetch(`/api/papers/${pid}/cards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }).then(j),
  patchCard: (cid: string, f: object): Promise<any> =>
    fetch(`/api/cards/${cid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) }).then(j),
  delCard: (cid: string): Promise<any> => fetch(`/api/cards/${cid}`, { method: 'DELETE' }).then(j),
  tables: (pid: string): Promise<{ tables: TableBox[]; version: number }> =>
    fetch(`/api/papers/${pid}/tables`).then(j),
  translate: (pid: string, block_id: string, signal?: AbortSignal): Promise<{ translation: string; page: number; text?: string }> =>
    fetch(`/api/papers/${pid}/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ block_id }), signal }).then(j),
  inlineTranslations: (pid: string): Promise<{ translations: Record<string, string> }> =>
    fetch(`/api/papers/${pid}/translations`).then(j),
  translateInline: (pid: string, block_id: string, force = false, signal?: AbortSignal):
    Promise<{ translation: string; block_id: string; page: number; text: string; cached: boolean }> =>
    fetch(`/api/papers/${pid}/translate-inline`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ block_id, force }), signal }).then(j),
  translateSelection: (pid: string, body: { text: string; block_id?: string }, signal?: AbortSignal):
    Promise<{ translation: string; block_id: string; page: number }> =>
    fetch(`/api/papers/${pid}/translate-selection`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }).then(j),
  explainTerm: (pid: string, body: { term: string; zh?: string; refs?: string[] }, signal?: AbortSignal):
    Promise<{ term: string; zh: string; expl: string; refs: string[]; pages: number[] }> =>
    fetch(`/api/papers/${pid}/term`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }).then(j),
  chat: (pid: string, body: { block_ids: string[]; history: object[]; question: string; table_id?: string }, signal?: AbortSignal):
    Promise<{ answer: string; refs: string[]; pages: number[]; steps?: ChatStep[] }> =>
    fetch(`/api/papers/${pid}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }).then(j),
  /** 流式对话：SSE 事件 step（检索过程）/ delta（回答增量）/ done（最终结果，与 chat 同构）。
      老后端没有 /chat/stream（404/405）时自动降级为一次性 chat。 */
  chatStream: async (pid: string, body: { block_ids: string[]; history: object[]; question: string; table_id?: string },
    cb: { onStep?: (s: ChatStep) => void; onDelta?: (text: string) => void }, signal?: AbortSignal):
    Promise<{ answer: string; refs: string[]; pages: number[]; steps?: ChatStep[] }> => {
    const r = await fetch(`/api/papers/${pid}/chat/stream`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    })
    if (r.status === 404 || r.status === 405) return api.chat(pid, body, signal)
    if (!r.ok || !r.body) return j(r)
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    let done: { answer: string; refs: string[]; pages: number[]; steps?: ChatStep[] } | null = null
    // SSE 帧以空行分隔；一帧里可能有 event: 与 data: 两行
    const handleFrame = (frame: string) => {
      let ev = 'message'
      let data = ''
      for (const line of frame.split('\n')) {
        if (line.startsWith('event:')) ev = line.slice(6).trim()
        else if (line.startsWith('data:')) data += line.slice(5).trim()
      }
      if (!data) return
      const payload = JSON.parse(data)
      if (ev === 'step') cb.onStep?.(payload as ChatStep)
      else if (ev === 'delta') cb.onDelta?.(payload.text ?? '')
      else if (ev === 'done') done = payload
      else if (ev === 'error') {
        const e = new Error(payload.detail || '对话失败') as Error & { code?: string; purpose?: string }
        e.code = payload.code
        e.purpose = payload.purpose
        throw e
      }
    }
    while (true) {
      const { value, done: eof } = await reader.read()
      if (eof) break
      buf += dec.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i)
        buf = buf.slice(i + 2)
        handleFrame(frame)
      }
    }
    if (buf.trim()) handleFrame(buf)
    if (!done) throw new Error('回答流中断，请重试')
    return done
  },
  profile: (pid: string): Promise<ProfileResponse> => fetch(`/api/papers/${pid}/profile`).then(j),
  survey: (pid: string, body: { domain: string; familiarity: string; known_terms: string[]; reuse?: boolean }): Promise<PaperMeta> =>
    fetch(`/api/papers/${pid}/survey`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  makePlan: (pid: string, signal?: AbortSignal): Promise<ReadingPlan> =>
    fetch(`/api/papers/${pid}/plan`, { method: 'POST', signal }).then(j),
  savePlan: (pid: string, plan: ReadingPlan): Promise<PaperMeta> =>
    fetch(`/api/papers/${pid}/plan`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) }).then(j),
  search: (body: { q?: string; source?: string; doi?: string }, signal?: AbortSignal): Promise<{ results: SearchResult[] }> =>
    fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal }).then(j),
  refs: (pid: string): Promise<{ dois: string[] }> => fetch(`/api/papers/${pid}/refs`).then(j),
  dismissTerm: (pid: string, term: string): Promise<{ dismissed_terms: string[] }> =>
    fetch(`/api/papers/${pid}/dismiss_term`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ term }) }).then(j),
  collect: (pid: string, collected: boolean): Promise<{ collected: number }> =>
    fetch(`/api/papers/${pid}/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collected }) }).then(j),
  setNote: (pid: string, note: string): Promise<{ note: string }> =>
    fetch(`/api/papers/${pid}/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) }).then(j),
  recommend: (pid: string, signal?: AbortSignal): Promise<RecommendResponse> =>
    fetch(`/api/papers/${pid}/recommend`, { signal }).then(j),
  review: (paper_ids: string[] = [], signal?: AbortSignal): Promise<{ review: string; count: number }> =>
    fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paper_ids }), signal }).then(j),
  makeQuiz: (pid: string, signal?: AbortSignal): Promise<{ questions: QuizQuestion[]; error?: string }> =>
    fetch(`/api/papers/${pid}/quiz`, { method: 'POST', signal }).then(j),
  getQuiz: (pid: string): Promise<{ quiz?: QuizSaved | null }> =>
    fetch(`/api/papers/${pid}/quiz`).then(j),
  saveQuizAnswers: (pid: string, answers: string[]): Promise<{ ok: boolean }> =>
    fetch(`/api/papers/${pid}/quiz/answers`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ answers }) }).then(j),
  gradeQuiz: (pid: string, questions: QuizQuestion[], answers: string[], signal?: AbortSignal): Promise<QuizGrade> =>
    fetch(`/api/papers/${pid}/quiz/grade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questions, answers }), signal }).then(j),
  highlights: (pid: string): Promise<Highlight[]> => fetch(`/api/papers/${pid}/highlights`).then(j),
  addHighlight: (pid: string, h: NewHighlight): Promise<Highlight> =>
    fetch(`/api/papers/${pid}/highlights`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(h) }).then(j),
  setHighlightColor: (hid: string, color: string): Promise<{ ok: boolean; color: string }> =>
    fetch(`/api/highlights/${hid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ color }) }).then(j),
  deleteHighlight: (hid: string): Promise<{ ok: boolean }> =>
    fetch(`/api/highlights/${hid}`, { method: 'DELETE' }).then(j),
}
