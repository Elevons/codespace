import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Chat } from '../src/agent/Chat.ts'
import { Ledger } from '../src/repo/Ledger.ts'
import { Repo } from '../src/repo/Repo.ts'
import { MaxFileNote, MaxNote, MaxShown, MaxTitle } from '../src/repo/ShowLimits.ts'
import { makeRepo, makeTemp, removeTemp, request, send, startApi, waitFor, ChatSettings, ChatStateKeys } from './support.ts'

/** A small repository with two files, an architecture file, and one folder. */
function repo(): Promise<string>
{
    return makeRepo({
        'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
        'src/b.ts': 'export const b = 1\n',
        '.codespace/architecture.json': JSON.stringify({
            layers: ['base', 'ui'],
            files: { 'src/a.ts': { layer: 'base' }, 'src/b.ts': { layer: 'ui' } },
            folders: { src: { summary: 'The source.' } },
        }),
    })
}

test('The API reads the architecture and the import graph', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const architecture = await send(port, '/api/architecture')
        assert.deepEqual(architecture.body.layers, ['base', 'ui'])
        assert.equal(architecture.body.files['src/b.ts'].layer, 'ui')
        assert.equal(architecture.body.folders.src, 'The source.')

        const graph = await send(port, '/api/graph')
        assert.deepEqual(graph.body.edges, [['src/a.ts', 'src/b.ts']])
        assert.deepEqual((await send(port, '/api/graph?folder=docs')).body.edges, [])
    }
    finally { await stop(); await removeTemp(root) }
})

test('Changes are refused from another host, another site, or without JSON', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const change = { files: { 'src/a.ts': { layer: 'ui' } } }
        assert.equal((await request(port, 'POST', '/api/architecture', change, { Host: 'my-laptop.example:8443' })).status, 403)
        assert.equal((await request(port, 'POST', '/api/architecture', change, { Origin: 'https://evil.example' })).status, 403)
        assert.equal((await request(port, 'POST', '/api/view', { action: 'clear' }, { 'Content-Type': 'text/plain' })).status, 403)

        // The same change from this machine, as a local host name, goes through.
        assert.equal((await request(port, 'POST', '/api/architecture', change, { Host: `localhost:${port}` })).status, 200)
        assert.match(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), /"src\/a.ts": \{\n\s+"layer": "ui"/)

        // The change is stamped in the ledger, so a later edit is seen as a change rather than a new file.
        const ledger = JSON.parse(await readFile(join(root, '.codespace', 'ingested.json'), 'utf8'))
        assert.ok(ledger.files['src/a.ts'], 'the applied file is recorded')
        await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b.ts'\nexport const a = b + 1\n")
        const repo = await Repo.OpenAsync(root)
        assert.deepEqual(await Ledger.ChangedAsync(repo, await Ledger.ReadAsync(repo.Root), ['src/a.ts']), ['src/a.ts'])
    }
    finally { await stop(); await removeTemp(root) }
})

test('A bad architecture change is a 400 with the reasons, and writes nothing', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    const before = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
    try
    {
        const result = await request(port, 'POST', '/api/architecture', { files: { 'src/a.ts': { layer: 'missing' }, 'nope.ts': { summary: 'x' } } })
        assert.equal(result.status, 400)
        assert.match(result.body.error, /layer "missing" is not in layers/)
        assert.match(result.body.error, /"nope\.ts" is not a file/)
        assert.equal(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), before)
    }
    finally { await stop(); await removeTemp(root) }
})

test('The view shows files, replays to a late page, and rejects unknown paths', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        assert.equal((await request(port, 'POST', '/api/view', { action: 'show', files: ['nowhere.ts'] })).status, 400)
        const shown = await request(port, 'POST', '/api/view', {
            action: 'show', trace: true, title: 'A to B', note: 'a uses b',
            files: [{ path: 'src/a.ts', note: 'starts' }, 'src/b.ts', { path: 'src/ghost.ts' }],
        })
        assert.deepEqual(shown.body, { ok: true, shown: 2, unknown: ['src/ghost.ts'] })
        assert.equal((await send(port, '/api/view')).body.shown.trace, true)

        // A page that connects now is told what is already shown, then hears later changes.
        const messages: string[] = []
        const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
        stream.end()
        await waitFor(() => /"type":"show".*"title":"A to B"/.test(messages.join('')))
        await request(port, 'POST', '/api/view', { action: 'focus', path: 'src' })
        await request(port, 'POST', '/api/view', { action: 'clear' })
        await waitFor(() => /"type":"focus","path":"src"/.test(messages.join('')) && /"type":"clear"/.test(messages.join('')))
        stream.destroy()

        assert.equal((await request(port, 'POST', '/api/view', { action: 'focus', path: 'src/ghost' })).status, 400)
        assert.equal((await request(port, 'POST', '/api/view', { action: 'jump' })).status, 400)
    }
    finally { await stop(); await removeTemp(root) }
})

test('The view isolates an ad-hoc set of files, replays it, and clears it', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        assert.equal((await request(port, 'POST', '/api/view', { action: 'isolate', files: ['nowhere.ts'] })).status, 400)
        const isolated = await request(port, 'POST', '/api/view', { action: 'isolate', files: ['src/a.ts', 'src/ghost.ts', 'src/a.ts'] })
        assert.deepEqual(isolated.body, { ok: true, isolated: 1, unknown: ['src/ghost.ts'] })
        assert.deepEqual((await send(port, '/api/view')).body.isolated, ['src/a.ts'])

        // A page that connects now is told what is isolated.
        const messages: string[] = []
        const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
        stream.end()
        await waitFor(() => /"type":"isolate","files":\["src\/a.ts"\]/.test(messages.join('')))
        stream.destroy()

        // An empty list removes the isolation.
        assert.deepEqual((await request(port, 'POST', '/api/view', { action: 'isolate', files: [] })).body, { ok: true, isolated: 0, unknown: [] })
        assert.equal((await send(port, '/api/view')).body.isolated, null)
    }
    finally { await stop(); await removeTemp(root) }
})

test('A show request is capped, and its title, note, and file notes are cut to their limits', async () =>
{
    const files: Record<string, string> = {}
    for (let i = 0; i < MaxShown + 1; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i}\n`
    const root = await makeRepo(files)
    const { port, stop } = await startApi(root)
    try
    {
        const paths = Object.keys(files)
        const listed = paths.map((path, index) => index === 0 ? { path, note: 'x'.repeat(MaxFileNote + 100) } : path)
        const shown = await request(port, 'POST', '/api/view', { action: 'show', files: listed, title: 't'.repeat(MaxTitle + 50), note: 'n'.repeat(MaxNote + 100) })
        assert.deepEqual(shown.body, { ok: true, shown: MaxShown, unknown: [] })

        const view = (await send(port, '/api/view')).body.shown
        assert.equal(view.files.length, MaxShown)
        assert.equal(view.files[0].note.length, 600)
        assert.equal(view.title.length, 120)
        assert.equal(view.note.length, 1500)
    }
    finally { await stop(); await removeTemp(root) }
})

test('Changing the architecture tells watching pages to read it again', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const messages: string[] = []
        const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
        stream.end()
        // Wait for the stream's first chunk, so the page is subscribed before the change is written.
        await waitFor(() => messages.join('').includes(': connected'))
        await request(port, 'POST', '/api/architecture', { files: { 'src/a.ts': { summary: 'Does a.' } } })
        await waitFor(() => /"type":"architecture"/.test(messages.join('')))
        stream.destroy()
    }
    finally { await stop(); await removeTemp(root) }
})

test('Deleting the architecture removes the folder, and is refused from another host', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const json = { 'Content-Type': 'application/json' }
        assert.equal((await request(port, 'DELETE', '/api/architecture', undefined, { ...json, Host: 'my-laptop.example:8443' })).status, 403)

        const result = await request(port, 'DELETE', '/api/architecture', undefined, { ...json, Host: `localhost:${port}` })
        assert.equal(result.status, 200)
        assert.deepEqual(result.body.layers, [])
        await assert.rejects(readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), /ENOENT/)
    }
    finally { await stop(); await removeTemp(root) }
})

test('The agent prompt names the CLI, the repository, the commands, and the four required fields', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const prompt = (await send(port, '/api/ingest/status')).body.prompt as string
        assert.ok(prompt.includes('src/cli/Cli.ts'), 'the prompt names the CLI')
        assert.ok(prompt.includes(root), 'the prompt names this repository')
        for (const command of ['status', 'next', 'apply', 'install', 'refine'])
            assert.ok(prompt.includes(command), `the prompt names the ${command} command`)
        for (const field of ['"summary"', '"system"', '"layer"', '"tags"'])
            assert.ok(prompt.includes(field), `the prompt names the ${field} field`)

        // The rules that keep a description honest, not just the command words.
        assert.match(prompt, /A folder is never a system or a layer by itself/)
        assert.match(prompt, /Layers are shared by every system/)
        assert.match(prompt, /Every file entry needs all four: a one-sentence summary, a system, tags from .+, and a layer\./)
        assert.match(prompt, /a "tests" layer goes above everything it imports,\s+at the top of the ladder/)
        assert.match(prompt, /generated and vendored files are already settled for you/)
    }
    finally { await stop(); await removeTemp(root) }
})

test('The chat stays on this machine, reads its state, and validates its actions', async () =>
{
    const root = await repo()
    const agentDir = await makeTemp('codespace-chat-')
    const chat = new Chat(() => root, { mapUrl: 'http://localhost:5199', cli: 'src/cli/Cli.ts' }, () => undefined, () => ChatSettings, { agentDir })
    const { port, stop } = await startApi(root, { chat })
    try
    {
        assert.equal((await send(port, '/api/chat', { Host: 'evil.example:8443' })).status, 403)
        assert.equal((await request(port, 'POST', '/api/chat', { action: 'stop' }, { Host: 'evil.example:8443' })).status, 403)

        const state = await send(port, '/api/chat')
        assert.equal(state.status, 200)
        assert.deepEqual(Object.keys(state.body).sort(), ChatStateKeys)
        assert.equal(state.body.busy, false)
        assert.equal(state.body.current, '')
        assert.equal(state.body.model, 'test at http://model.test')
        assert.equal(state.body.problem, '')

        assert.equal((await request(port, 'POST', '/api/chat', { action: 'jump' })).status, 400)
        assert.match((await request(port, 'POST', '/api/chat', { action: 'jump' })).body.error, /action must be/)
        assert.equal((await request(port, 'POST', '/api/chat', { action: 'send', text: '   ' })).status, 400)
        assert.equal((await request(port, 'POST', '/api/chat', { action: 'stop' })).status, 200)
    }
    finally { await stop(); await removeTemp(root, agentDir) }
})
