import { createHash } from 'node:crypto'
import type { IModelSettings } from './ModelSettings.ts'

/**
 * Writes one sentence for each block that the source leaves without a comment. The map's own
 * comments come first and are never replaced; this only fills the blocks that would otherwise
 * show a plain description of their shape. Answers are kept in memory for the session, keyed by
 * the block's text, so opening a file again costs nothing.
 */

/** The most blocks summarized in one request. */
export const MaxBlocks = 24

/** The most characters of one block sent to the model. */
const MaxCodeChars = 3000

/** The longest summary kept, in characters. */
const MaxSummaryChars = 200

/** How long one request may take, in milliseconds. */
const Timeout = 30_000

/** One block to summarize, as the source gives it. */
export interface IBlockRequest
{
    /** The id the answer uses for this block. */
    id: string
    /** What the block is: a constant, a type, a function, or a class. */
    kind: string
    /** What the block is called. */
    name: string
    /** The line the block starts on. */
    line: number
    /** The line the block ends on. */
    endLine: number
    /** The block's own source. */
    code: string
}

/** Sends one JSON body to the model and resolves with its text, or throws. */
export type PostJson = (url: string, body: unknown, headers: Record<string, string>) => Promise<string>

/** The summaries written so far, by the block's text, so a file opened twice is summarized once. */
const Cache = new Map<string, string>()

/** The most answers the session keeps, so a long run cannot grow without bound. */
const MaxCached = 4000

/** The system prompt: what the model writes, and the shape it answers in. */
const Prompt = 'You describe code blocks for a map of a codebase. For each block, write one plain sentence of at most '
    + '20 words that says what the block is for, not how it works. Do not begin with "This", "The function", or the '
    + 'block name, and do not mention line numbers. Answer with JSON only, in this shape: '
    + '{"summaries":[{"id":"b1","summary":"..."}]}'

/**
 * Writes a sentence for each block that has no comment of its own.
 * @param requests the blocks to summarize, each with an id the answer names
 * @param settings the model to ask; a key is required
 * @param post sends the request, replaced in a test
 * @returns each id and its summary, leaving out any block the model did not answer
 */
export async function SummarizeBlocksAsync(requests: IBlockRequest[], settings: IModelSettings, post: PostJson = PostJsonAsync): Promise<Record<string, string>>
{
    const answers: Record<string, string> = {}
    const wanted: IBlockRequest[] = []
    for (const request of requests)
    {
        const key = CacheKey(request)
        const known = Cache.get(key)
        if (known !== undefined) answers[request.id] = known
        else wanted.push(request)
    }
    if (wanted.length === 0) return answers
    if (settings.apiKey === undefined) throw new Error('No model is configured for the block summaries.')

    const body = {
        model: settings.model,
        temperature: 0,
        max_tokens: 1200,
        messages: [
            { role: 'system', content: Prompt },
            { role: 'user', content: JSON.stringify(wanted.map((request) => ({
                id: request.id,
                kind: request.kind,
                name: request.name,
                lines: `${request.line}-${request.endLine}`,
                code: request.code.slice(0, MaxCodeChars),
            }))) },
        ],
    }
    const text = await post(settings.baseUrl + '/chat/completions', body, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey}`,
    })

    // A model that answers in prose, or in a different shape, simply leaves the blocks as they were.
    const parsed = ExtractObject(text)
    if (parsed === null || Array.isArray(parsed.summaries) === false) return answers
    const byId = new Map(wanted.map((request) => [request.id, request]))
    for (const item of parsed.summaries)
    {
        if (typeof item !== 'object' || item === null) continue
        const id = (item as { id?: unknown }).id
        const summary = (item as { summary?: unknown }).summary
        if (typeof id !== 'string' || typeof summary !== 'string') continue
        const request = byId.get(id)
        const clean = summary.replace(/\s+/g, ' ').trim().slice(0, MaxSummaryChars)
        if (request === undefined || clean === '') continue
        answers[id] = clean
        Remember(CacheKey(request), clean)
    }
    return answers
}

/** The key a block's answer is cached under: its name, its kind, and its own text. */
function CacheKey(request: IBlockRequest): string
{
    return createHash('sha1').update(request.name + '\u0000' + request.kind + '\u0000' + request.code).digest('hex')
}

/** Keeps one answer, letting the oldest go once the session holds too many. */
function Remember(key: string, summary: string): void
{
    if (Cache.size >= MaxCached) Cache.delete(Cache.keys().next().value!)
    Cache.set(key, summary)
}

/** The JSON object a reply holds, with any prose or code fence around it left out. */
function ExtractObject(text: string): { summaries?: unknown } | null
{
    const start = text.indexOf('{'), end = text.lastIndexOf('}')
    if (start < 0 || end <= start) return null
    try { return JSON.parse(text.slice(start, end + 1)) as { summaries?: unknown } }
    catch { return null }
}

/** Sends one request to an OpenAI-compatible endpoint and resolves with the reply's text. */
async function PostJsonAsync(url: string, body: unknown, headers: Record<string, string>): Promise<string>
{
    const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.timeout(Timeout) })
    if (response.ok === false) throw new Error(`The model answered ${response.status}.`)
    const text = await response.text()
    try
    {
        const reply = JSON.parse(text) as { choices?: Array<{ message?: { content?: string } }> }
        const content = reply.choices?.[0]?.message?.content
        if (typeof content === 'string') return content
    }
    catch { /* the text is answered as it is, so a plain reply can still be read */ }
    return text
}
