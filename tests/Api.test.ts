import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Api } from '../src/server/Api.ts'
import { Repo } from '../src/repo/Repo.ts'
import { View } from '../src/server/View.ts'

/** Starts the endpoints over a small repository and returns a way to call them. */
async function start(): Promise<{ root: string, view: View, port: number, stop: () => Promise<void> }>
{
    const root = await mkdtemp(join(tmpdir(), 'codespace-api-'))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b.ts'\nexport const a = b\n")
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1\n')
    await mkdir(join(root, '.codespace'))
    await writeFile(join(root, '.codespace', 'architecture.json'), JSON.stringify({ layers: ['base', 'ui'], files: { 'src/a.ts': { layer: 'base' }, 'src/b.ts': { layer: 'ui' } } }))
    const repo = await Repo.OpenAsync(root)
    const view = new View()
    let api: Api
    const server: Server = createServer((req, res) =>
    {
        api.HandleAsync(req, res, new URL(req.url!, 'http://localhost')).then((handled) => { if (!handled) { res.writeHead(404); res.end() } })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    // The API reaches its own MCP tools over loopback, so it needs the port it ended up on.
    api = new Api(repo, view, `http://127.0.0.1:${port}`)
    return { root, view, port, stop: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }) }
}

/** Sends one request with any headers, and returns the status and parsed body. */
function send(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number, body: any }>
{
    return new Promise((done, fail) =>
    {
        const text = body === undefined ? undefined : JSON.stringify(body)
        const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(text ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) =>
        {
            let data = ''
            res.on('data', (chunk) => { data += chunk })
            res.on('end', () => done({ status: res.statusCode!, body: data === '' ? null : JSON.parse(data) }))
        })
        req.on('error', fail)
        req.end(text)
    })
}

test('The API reads the architecture and the import graph', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const architecture = await send(port, 'GET', '/api/architecture')
        assert.deepEqual(architecture.body.layers, ['base', 'ui'])
        assert.equal(architecture.body.files['src/b.ts'].layer, 'ui')

        const graph = await send(port, 'GET', '/api/graph')
        assert.deepEqual(graph.body.edges, [['src/a.ts', 'src/b.ts']])
        assert.deepEqual((await send(port, 'GET', '/api/graph?folder=docs')).body.edges, [])
    }
    finally { await stop(); await rm(root, { recursive: true, force: true }) }
})

test('Changes are refused from another host, another site, or without JSON', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const change = { files: { 'src/a.ts': { layer: 'ui' } } }
        assert.equal((await send(port, 'POST', '/api/architecture', change, { Host: 'my-laptop.example:8443' })).status, 403)
        assert.equal((await send(port, 'POST', '/api/architecture', change, { Origin: 'https://evil.example' })).status, 403)
        assert.equal((await send(port, 'POST', '/api/view', { action: 'clear' }, { 'Content-Type': 'text/plain' })).status, 403)

        // The same change from this machine, as a local host name, goes through.
        assert.equal((await send(port, 'POST', '/api/architecture', change, { Host: `localhost:${port}` })).status, 200)
        assert.match(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), /"src\/a.ts": \{\n\s+"layer": "ui"/)
    }
    finally { await stop(); await rm(root, { recursive: true, force: true }) }
})

test('A bad architecture change is a 400 with the reasons, and writes nothing', async () =>
{
    const { root, port, stop } = await start()
    const before = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
    try
    {
        const result = await send(port, 'POST', '/api/architecture', { files: { 'src/a.ts': { layer: 'missing' }, 'nope.ts': { summary: 'x' } } })
        assert.equal(result.status, 400)
        assert.match(result.body.error, /layer "missing" is not in layers/)
        assert.match(result.body.error, /"nope\.ts" is not a file/)
        assert.equal(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), before)
    }
    finally { await stop(); await rm(root, { recursive: true, force: true }) }
})

test('The view shows files, replays to a late page, and rejects unknown paths', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        assert.equal((await send(port, 'POST', '/api/view', { action: 'show', files: ['nowhere.ts'] })).status, 400)
        const shown = await send(port, 'POST', '/api/view', {
            action: 'show', trace: true, title: 'A to B', note: 'a uses b',
            files: [{ path: 'src/a.ts', note: 'starts' }, 'src/b.ts', { path: 'src/ghost.ts' }],
        })
        assert.deepEqual(shown.body, { ok: true, shown: 2, unknown: ['src/ghost.ts'] })
        assert.equal((await send(port, 'GET', '/api/view')).body.shown.trace, true)

        // A page that connects now is told what is already shown, then hears later changes.
        const messages: string[] = []
        const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
        stream.end()
        await new Promise((done) => setTimeout(done, 100))
        assert.match(messages.join(''), /"type":"show".*"title":"A to B"/)
        await send(port, 'POST', '/api/view', { action: 'focus', path: 'src' })
        await send(port, 'POST', '/api/view', { action: 'clear' })
        await new Promise((done) => setTimeout(done, 100))
        assert.match(messages.join(''), /"type":"focus","path":"src"/)
        assert.match(messages.join(''), /"type":"clear"/)
        stream.destroy()

        assert.equal((await send(port, 'POST', '/api/view', { action: 'focus', path: 'src/ghost' })).status, 400)
        assert.equal((await send(port, 'POST', '/api/view', { action: 'jump' })).status, 400)
    }
    finally { await stop(); await rm(root, { recursive: true, force: true }) }
})

test('Changing the architecture tells watching pages to read it again', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const messages: string[] = []
        const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
        stream.end()
        await new Promise((done) => setTimeout(done, 100))
        await send(port, 'POST', '/api/architecture', { files: { 'src/a.ts': { summary: 'Does a.' } } })
        await new Promise((done) => setTimeout(done, 100))
        assert.match(messages.join(''), /"type":"architecture"/)
        stream.destroy()
    }
    finally { await stop(); await rm(root, { recursive: true, force: true }) }
})

test('MCP is served from the main server, over HTTP, with nothing else running', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const hello = await send(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } })
        assert.equal(hello.status, 200)
        assert.equal(hello.body.result.serverInfo.name, 'codespace')

        const listed = await send(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 2, method: 'tools/list' })
        assert.ok(listed.body.result.tools.some((tool: { name: string }) => tool.name === 'update_architecture'))

        // The tools reach the same endpoints over loopback, so a change made through MCP lands.
        const moved = await send(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'update_architecture', arguments: { files: { 'src/b.ts': { layer: 'base' } } } } })
        assert.equal(moved.body.result.isError, undefined)
        assert.equal((await send(port, 'GET', '/api/architecture')).body.files['src/b.ts'].layer, 'base')

        // A notification gets no answer.
        const notified = await send(port, 'POST', '/mcp', { jsonrpc: '2.0', method: 'notifications/initialized' })
        assert.equal(notified.status, 202)

        assert.equal((await send(port, 'GET', '/mcp')).status, 405)
        assert.equal((await send(port, 'POST', '/mcp', { jsonrpc: '2.0', id: 4, method: 'initialize' }, { Host: 'example.com' })).status, 403)
    }
    finally { await stop(); await rm(root, { recursive: true, force: true }) }
})
