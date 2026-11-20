import type { IncomingMessage, ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'

/** The largest request body accepted, in bytes. */
const MaxBody = 256 * 1024

/** The addresses a same-machine request comes from. */
const LoopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The host names a page or tool uses to reach this machine's own server. */
const LocalHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Says why a request may not change anything, or null when it may. Reading is open, as it is
 * for the map itself; changing the view or the architecture file is for a tool or page on
 * this machine only, unless the server was started to allow changes from anywhere. The server
 * listens on the network, and a proxy may forward from this machine, so the host name has to be
 * local as well as the address.
 * @param request the incoming request
 * @param anywhere whether changes from any machine are allowed, as started with --allow-writes
 */
export function RefuseWrite(request: IncomingMessage, anywhere = false): string | null
{
    const outside = RefuseOutside(request, anywhere)
    if (outside !== null) return outside
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return 'Send JSON.'
    return null
}

/**
 * Says why a request is not from this machine (or, with --allow-writes, from a page of this site),
 * or null when it is. Writes need this and a JSON body; the chat, which runs commands in the
 * repository, needs it even to be read or followed.
 * @param request the incoming request
 * @param anywhere whether any machine is allowed, as started with --allow-writes
 */
export function RefuseOutside(request: IncomingMessage, anywhere = false): string | null
{
    if (!anywhere)
    {
        if (!LoopbackAddresses.has(request.socket.remoteAddress ?? '')) return 'Changes are only accepted from the machine running Codespace. Start it with --allow-writes to change that.'
        const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
        if (!LocalHosts.has(host)) return `Changes are only accepted when Codespace is reached as localhost (this request used "${host}"). Start it with --allow-writes to change that.`
    }
    const origin = request.headers.origin
    const target = (request.headers['x-forwarded-host'] ?? request.headers.host ?? '').toString()
    if (origin !== undefined && new URL(origin).host !== target) return 'Cross-site requests are refused.'
    return null
}

/**
 * Says why a request may not browse the machine's folders, or null when it may. The picker lists
 * folders outside the repository, so it stays on this machine even when writes are allowed from
 * anywhere.
 * @param request the incoming request
 */
export function RefuseRemoteRead(request: IncomingMessage): string | null
{
    if (!LoopbackAddresses.has(request.socket.remoteAddress ?? '')) return 'The folder picker is only available on the machine running Codespace.'
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
    if (!LocalHosts.has(host)) return `The folder picker is only available on this machine, as localhost (this request used "${host}").`
    return null
}

/** The smallest JSON body worth compressing, in bytes. */
const MinCompressed = 1024

/**
 * Writes one JSON response.
 * @param response the response to write
 * @param status the HTTP status
 * @param body the value to send as JSON
 * @param request when given, a body the caller accepts compressed is sent gzipped
 */
export function SendJson(response: ServerResponse, status: number, body: unknown, request?: IncomingMessage): void
{
    const headers: Record<string, string> = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' }
    let payload = Buffer.from(JSON.stringify(body))
    if (request !== undefined)
    {
        headers.Vary = 'Accept-Encoding'
        if (payload.length >= MinCompressed && /\bgzip\b/.test(String(request.headers['accept-encoding'] ?? '')))
        {
            payload = gzipSync(payload)
            headers['Content-Encoding'] = 'gzip'
        }
    }
    response.writeHead(status, headers)
    response.end(payload)
}

/**
 * Reads a JSON object from a request body.
 * @param request the incoming request
 */
export async function ReadJsonAsync(request: IncomingMessage): Promise<Record<string, unknown>>
{
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of request)
    {
        size += (chunk as Buffer).length
        if (size > MaxBody) throw new Error('Request too large')
        chunks.push(chunk as Buffer)
    }
    const text = Buffer.concat(chunks).toString('utf8')
    if (text === '') return {}
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {}
}
