import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { makeTemp, removeTemp } from './support.ts'
import { join } from 'node:path'
import { Api } from '../src/server/Api.ts'
import { Workspace } from '../src/server/Workspace.ts'

/** Starts the endpoints over a small repository and returns a way to call them. */
async function start(): Promise<{ root: string, port: number, stop: () => Promise<void> }>
{
    const root = await makeTemp('codespace-api-')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b.ts'\nexport const a = b\n")
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1\n')
    await mkdir(join(root, '.codespace'))
    await writeFile(join(root, '.codespace', 'architecture.json'), JSON.stringify({ layers: ['base', 'ui'], files: { 'src/a.ts': { layer: 'base' }, 'src/b.ts': { layer: 'ui' } }, folders: { src: { summary: 'The source.' } } }))
    const workspace = await Workspace.OpenAsync(root)
    let api: Api
    const server: Server = createServer((req, res) =>
    {
        api.HandleAsync(req, res, new URL(req.url!, 'http://localhost')).then((handled) => { if (!handled) { res.writeHead(404); res.end() } })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    api = new Api(workspace)
    return { root, port, stop: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }) }
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

/** Waits until a predicate holds, so a stream test does not depend on a fixed sleep. */
async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void>
{
    const start = Date.now()
    while (!check())
    {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the stream')
        await new Promise((done) => setTimeout(done, 10))
    }
}

test('The API reads the architecture and the import graph', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const architecture = await send(port, 'GET', '/api/architecture')
        assert.deepEqual(architecture.body.layers, ['base', 'ui'])
        assert.equal(architecture.body.files['src/b.ts'].layer, 'ui')
        assert.equal(architecture.body.folders.src, 'The source.')

        const graph = await send(port, 'GET', '/api/graph')
        assert.deepEqual(graph.body.edges, [['src/a.ts', 'src/b.ts']])
        assert.deepEqual((await send(port, 'GET', '/api/graph?folder=docs')).body.edges, [])
    }
    finally { await stop(); await removeTemp(root) }
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
    finally { await stop(); await removeTemp(root) }
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
    finally { await stop(); await removeTemp(root) }
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
        await waitFor(() => /"type":"show".*"title":"A to B"/.test(messages.join('')))
        await send(port, 'POST', '/api/view', { action: 'focus', path: 'src' })
        await send(port, 'POST', '/api/view', { action: 'clear' })
        await waitFor(() => /"type":"focus","path":"src"/.test(messages.join('')) && /"type":"clear"/.test(messages.join('')))
        stream.destroy()

        assert.equal((await send(port, 'POST', '/api/view', { action: 'focus', path: 'src/ghost' })).status, 400)
        assert.equal((await send(port, 'POST', '/api/view', { action: 'jump' })).status, 400)
    }
    finally { await stop(); await removeTemp(root) }
})

test('Changing the architecture tells watching pages to read it again', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const messages: string[] = []
        const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
        stream.end()
        await send(port, 'POST', '/api/architecture', { files: { 'src/a.ts': { summary: 'Does a.' } } })
        await waitFor(() => /"type":"architecture"/.test(messages.join('')))
        stream.destroy()
    }
    finally { await stop(); await removeTemp(root) }
})

test('Deleting the architecture removes the folder, and is refused from another host', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const json = { 'Content-Type': 'application/json' }
        assert.equal((await send(port, 'DELETE', '/api/architecture', undefined, { ...json, Host: 'my-laptop.example:8443' })).status, 403)

        const result = await send(port, 'DELETE', '/api/architecture', undefined, { ...json, Host: `localhost:${port}` })
        assert.equal(result.status, 200)
        assert.deepEqual(result.body.layers, [])
        await assert.rejects(readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), /ENOENT/)
    }
    finally { await stop(); await removeTemp(root) }
})


test('The agent prompt explains systems and the layers they share', async () =>
{
    const { root, port, stop } = await start()
    try
    {
        const status = await send(port, 'GET', '/api/ingest/status')
        assert.match(status.body.prompt, /"systems"/)
        assert.match(status.body.prompt, /"system": "browser"/)
        assert.match(status.body.prompt, /"layer": "entry"/)
        assert.match(status.body.prompt, /"layer": "ui"/)
        assert.match(status.body.prompt, /"layer": "data"/)
        assert.match(status.body.prompt, /A layer is a file's level or role/)
        assert.match(status.body.prompt, /Declare the ladder once/)
        assert.match(status.body.prompt, /layer's name repeats a system's name/)
        assert.match(status.body.prompt, /Layers are shared by every system/)
        assert.match(status.body.prompt, /Folders are where files sit on disk/)
        assert.match(status.body.prompt, /a lower\s+layer never imports a higher one/)
        assert.match(status.body.prompt, /"usedBy"/)
        assert.match(status.body.prompt, /summary, system, layer, or tags/)
        assert.ok(status.body.prompt.includes(root), 'the prompt names this repository')
        assert.match(status.body.prompt, /next --repo /)
        assert.doesNotMatch(status.body.prompt, /ignore the extras/)
    }
    finally { await stop(); await removeTemp(root) }
})
