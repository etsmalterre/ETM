// Mistral AI client — OCR + structured chat, raw fetch (no SDK), the way
// MFProd calls it. Used by the « Agents IA » (lib/agents/*).
//
// Env: MISTRAL_API_KEY (read lazily — dotenv runs in index.ts after ESM
// import hoisting).
//
// Prices are USD, mistral.ai/pricing/api as of 2026-09-22. They only feed the
// « Coûts » tab — an estimate, never an invoice.

const BASE = 'https://api.mistral.ai/v1'

export const OCR_MODEL = 'mistral-ocr-latest'
/** USD per OCR page. */
export const OCR_PAGE_USD = 0.004

/** Chat models an agent version may use, with USD per million tokens (in, out). */
export const CHAT_MODELS: Record<string, { label: string; inUsd: number; outUsd: number }> = {
  'mistral-small-latest': { label: 'Mistral Small', inUsd: 0.15, outUsd: 0.6 },
  'mistral-medium-latest': { label: 'Mistral Medium', inUsd: 1.5, outUsd: 7.5 },
  'mistral-large-latest': { label: 'Mistral Large', inUsd: 0.5, outUsd: 1.5 },
  'ministral-8b-latest': { label: 'Ministral 8B', inUsd: 0.15, outUsd: 0.15 },
}

export function isChatModel(m: string): boolean {
  return Object.prototype.hasOwnProperty.call(CHAT_MODELS, m)
}

export interface ChatUsage {
  prompt_tokens: number
  completion_tokens: number
}

export function chatCostUsd(model: string, u: ChatUsage): number {
  const p = CHAT_MODELS[model]
  if (!p) return 0
  return (u.prompt_tokens * p.inUsd + u.completion_tokens * p.outUsd) / 1e6
}

function apiKey(): string {
  const k = process.env.MISTRAL_API_KEY?.trim()
  if (!k) throw new Error('MISTRAL_API_KEY is not set')
  return k
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** POST with retries on 429 / 5xx / network errors (the API rate-limits bursts). */
async function post<T>(path: string, body: unknown, timeoutMs = 120_000): Promise<T> {
  let last = ''
  for (let attempt = 0; attempt < 5; attempt++) {
    let r: Response
    try {
      r = await fetch(`${BASE}/${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
    } catch (err) {
      last = err instanceof Error ? err.message : String(err)
      await sleep(2000 * (attempt + 1))
      continue
    }
    if (r.status === 429 || r.status >= 500) {
      last = `HTTP ${r.status}`
      await sleep(2000 * (attempt + 1))
      continue
    }
    const text = await r.text()
    if (!r.ok) throw new Error(`Mistral ${path} HTTP ${r.status}: ${text.slice(0, 300)}`)
    return JSON.parse(text) as T
  }
  throw new Error(`Mistral ${path}: ${last || 'retries exhausted'}`)
}

// ── OCR ──────────────────────────────────────────────────

interface OcrResponse {
  pages: Array<{ index: number; markdown: string; tables?: Array<{ id: string; content: string }> }>
  usage_info: { pages_processed: number }
}

export interface OcrResult {
  /** Every page's markdown, tables inlined, pages separated by a rule. */
  text: string
  pages: number
  usd: number
}

/** OCR a PDF. Tables come back as markdown and are inlined where the page
 *  markdown references them. */
export async function ocrPdf(pdf: Buffer): Promise<OcrResult> {
  const j = await post<OcrResponse>('ocr', {
    model: OCR_MODEL,
    document: { type: 'document_url', document_url: `data:application/pdf;base64,${pdf.toString('base64')}` },
    table_format: 'markdown',
  })
  const text = j.pages
    .map((p) => {
      let md = p.markdown
      for (const t of p.tables ?? []) md = md.replace(`[${t.id}](${t.id})`, `\n${t.content}\n`)
      return md
    })
    .join('\n\n---\n\n')
  const pages = j.usage_info?.pages_processed ?? j.pages.length
  return { text, pages, usd: pages * OCR_PAGE_USD }
}

// ── Structured chat ──────────────────────────────────────

interface ChatResponse {
  choices: Array<{ message: { content: string } }>
  usage: ChatUsage
}

export interface ChatJsonResult {
  data: unknown
  raw: string
  usage: ChatUsage
  usd: number
}

/** One chat call constrained by a strict JSON schema, temperature 0. */
export async function chatJson(opts: {
  model: string
  system: string
  user: string
  schemaName: string
  schema: object
}): Promise<ChatJsonResult> {
  const j = await post<ChatResponse>('chat/completions', {
    model: opts.model,
    temperature: 0,
    messages: [
      { role: 'system', content: opts.system },
      { role: 'user', content: opts.user },
    ],
    response_format: { type: 'json_schema', json_schema: { name: opts.schemaName, schema: opts.schema, strict: true } },
  })
  const raw = j.choices[0]?.message?.content ?? ''
  const t = raw.replace(/```json|```/g, '').trim()
  const data = JSON.parse(t.slice(t.indexOf('{'), t.lastIndexOf('}') + 1))
  return { data, raw, usage: j.usage, usd: chatCostUsd(opts.model, j.usage) }
}
