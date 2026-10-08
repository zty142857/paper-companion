export interface Block {
  id: string; page: number; col: number; type: 'para' | 'heading' | 'figure' | 'formula'
  y0: number; y1: number; x0: number; x1: number; size: number; text: string; section_id: string | null
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
export interface Structure { title: string; pages: number; blocks: Block[]; sections: Section[] }
export interface Paper {
  id: string; title: string; filename: string; pages: number
  structure: Structure; analysis: Analysis | null; status: string
  visited?: number; collected?: number; domain?: string | null; note?: string | null
}
export interface LlmSettings {
  base_url: string; api_key: string; model: string; effort: string; has_key: boolean
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

const j = async (r: Response) => {
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || r.statusText)
  return r.json()
}
export const api = {
  list: (): Promise<Paper[]> => fetch('/api/papers').then(j),
  get: (id: string): Promise<Paper> => fetch(`/api/papers/${id}`).then(j),
  deletePaper: (id: string): Promise<any> => fetch(`/api/papers/${id}`, { method: 'DELETE' }).then(j),
  upload: (file: File): Promise<{ id: string }> => {
    const fd = new FormData(); fd.append('file', file)
    return fetch('/api/papers', { method: 'POST', body: fd }).then(j)
  },
  analyze: (id: string): Promise<Analysis> =>
    fetch(`/api/papers/${id}/analyze`, { method: 'POST' }).then(j),
  settings: (): Promise<LlmSettings> => fetch('/api/settings').then(j),
  saveSettings: (s: Partial<LlmSettings>): Promise<LlmSettings> =>
    fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).then(j),
  clearData: (): Promise<{ ok: boolean; papers_removed: number }> =>
    fetch('/api/data/clear', { method: 'POST' }).then(j),
  cards: (pid: string): Promise<Card[]> => fetch(`/api/papers/${pid}/cards`).then(j),
  addCard: (pid: string, c: { type: string; block_id?: string; top?: number; data?: object }): Promise<{ id: string }> =>
    fetch(`/api/papers/${pid}/cards`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(c) }).then(j),
  patchCard: (cid: string, f: object): Promise<any> =>
    fetch(`/api/cards/${cid}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(f) }).then(j),
  delCard: (cid: string): Promise<any> => fetch(`/api/cards/${cid}`, { method: 'DELETE' }).then(j),
  translate: (pid: string, block_id: string): Promise<{ translation: string; page: number }> =>
    fetch(`/api/papers/${pid}/translate`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ block_id }) }).then(j),
  explainTerm: (pid: string, body: { term: string; zh?: string; refs?: string[] }):
    Promise<{ term: string; zh: string; expl: string; refs: string[]; pages: number[] }> =>
    fetch(`/api/papers/${pid}/term`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  chat: (pid: string, body: { block_ids: string[]; history: object[]; question: string }):
    Promise<{ answer: string; refs: string[]; pages: number[]; steps?: ChatStep[] }> =>
    fetch(`/api/papers/${pid}/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  profile: (pid: string): Promise<ProfileResponse> => fetch(`/api/papers/${pid}/profile`).then(j),
  survey: (pid: string, body: { domain: string; familiarity: string; known_terms: string[]; reuse?: boolean }): Promise<PaperMeta> =>
    fetch(`/api/papers/${pid}/survey`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  makePlan: (pid: string): Promise<ReadingPlan> => fetch(`/api/papers/${pid}/plan`, { method: 'POST' }).then(j),
  savePlan: (pid: string, plan: ReadingPlan): Promise<PaperMeta> =>
    fetch(`/api/papers/${pid}/plan`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ plan }) }).then(j),
  search: (body: { q?: string; source?: string; doi?: string }): Promise<{ results: SearchResult[] }> =>
    fetch('/api/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(j),
  refs: (pid: string): Promise<{ dois: string[] }> => fetch(`/api/papers/${pid}/refs`).then(j),
  dismissTerm: (pid: string, term: string): Promise<{ dismissed_terms: string[] }> =>
    fetch(`/api/papers/${pid}/dismiss_term`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ term }) }).then(j),
  collect: (pid: string, collected: boolean): Promise<{ collected: number }> =>
    fetch(`/api/papers/${pid}/collect`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ collected }) }).then(j),
  setNote: (pid: string, note: string): Promise<{ note: string }> =>
    fetch(`/api/papers/${pid}/note`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ note }) }).then(j),
  recommend: (pid: string): Promise<{ items: { title: string; reason: string }[] }> => fetch(`/api/papers/${pid}/recommend`).then(j),
  review: (paper_ids: string[] = []): Promise<{ review: string; count: number }> =>
    fetch('/api/review', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ paper_ids }) }).then(j),
  makeQuiz: (pid: string): Promise<{ questions: QuizQuestion[]; error?: string }> =>
    fetch(`/api/papers/${pid}/quiz`, { method: 'POST' }).then(j),
  gradeQuiz: (pid: string, questions: QuizQuestion[], answers: string[]): Promise<QuizGrade> =>
    fetch(`/api/papers/${pid}/quiz/grade`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ questions, answers }) }).then(j),
}
