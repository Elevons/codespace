import type { IncomingMessage } from 'node:http'

/** The largest request body accepted, in bytes. */
const MaxBody = 256 * 1024

/** The addresses a same-machine request comes from. */
const LoopbackAddresses = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/** The host names a page or tool uses to reach this machine's own server. */
const LocalHosts = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * Says why a request may not change anything, or null when it may. Reading is open, as it is
 * for the map itself; changing the view or the architecture file is for a tool or page on
 * this machine only. The server listens on the network, and a proxy such as Tailscale Serve
 * forwards from this machine, so the host name has to be local as well as the address.
 * @param request the incoming request
 */
export function RefuseWrite(request: IncomingMessage): string | null
{
    if (!LoopbackAddresses.has(request.socket.remoteAddress ?? '')) return 'Changes are only accepted from the machine running Codespace.'
    const host = (request.headers.host ?? '').replace(/:\d+$/, '').toLowerCase()
    if (!LocalHosts.has(host)) return `Changes are only accepted when Codespace is reached as localhost (this request used "${host}").`
    const origin = request.headers.origin
    if (origin !== undefined && new URL(origin).host !== request.headers.host) return 'Cross-site requests are refused.'
    if (!(request.headers['content-type'] ?? '').startsWith('application/json')) return 'Send JSON.'
    return null
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
