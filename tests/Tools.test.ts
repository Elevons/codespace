import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Instructions } from '../src/agent/Instructions.ts'
import { MapTools, type IMapTool } from '../src/server/Tools.ts'
import { makeRepo, makeTemp, removeTemp, request, send, startServer } from './support.ts'

/** A small repository with an import, a generated file, and a declared layer and system. */
function repo(): Promise<string>
{
    return makeRepo({
        'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
        'src/b.ts': 'export const b = 1\n',
        'package-lock.json': '{}\n',
        '.codespace/architecture.json': JSON.stringify({ layers: ['base', 'top'], systems: { core: {} }, files: {} }),
    }, 'codespace-tools-repo-')
}

/** The arguments each tool is called with in the test, enough for it to succeed. */
function argumentsFor(tool: IMapTool, other: string): Record<string, unknown>
{
    switch (tool.name)
    {
        case 'switch_repo': return { path: other }
        case 'source': return { path: 'src/a.ts' }
        case 'blocks': return { path: 'src/a.ts' }
        case 'graph': return { folder: 'src' }
        case 'show': return { trace: true, title: 'A route', files: [{ path: 'src/a.ts', note: 'First.' }, { path: 'src/b.ts', note: 'Second.' }] }
        case 'isolate': return { files: ['src/a.ts'] }
        case 'focus': return { path: 'src' }
        case 'next': case 'refine': return { size: 2 }
        case 'apply': return { files: { 'src/b.ts': { summary: 'The value.', system: 'core', layer: 'base', tags: ['core'] } } }
        default: return {}
    }
}

/** Calls one tool the way a host would: query values for a GET, the JSON body with its fixed fields for a POST. */
function call(port: number, tool: IMapTool, args: Record<string, unknown>)
{
    if (tool.method === 'GET')
    {
        const query = new URLSearchParams(Object.entries(args).map(([name, value]) => [name, String(value)])).toString()
        return send(port, query === '' ? tool.path : `${tool.path}?${query}`)
    }
    return request(port, 'POST', tool.path, { ...args, ...tool.fixed })
}

test('Every tool has a unique name, a description, and arguments that fit its schema', () =>
{
    const names = MapTools.map((tool) => tool.name)
    assert.equal(new Set(names).size, names.length, 'no two tools share a name')
    for (const tool of MapTools)
    {
        assert.match(tool.name, /^[a-z]+(_[a-z]+)*$/)
        assert.ok(tool.description.length > 10, `${tool.name} says what it is for`)
        assert.equal(tool.parameters.type, 'object')
        assert.equal(tool.writes, tool.method === 'POST', `${tool.name} writes exactly when it is a POST`)
        for (const name of tool.parameters.required ?? []) assert.ok(name in tool.parameters.properties, `${tool.name} requires a property it declares`)
        for (const name of Object.keys(argumentsFor(tool, ''))) assert.ok(name in tool.parameters.properties, `${tool.name} takes ${name}`)
    }
})

test('The map serves its tool list, and every tool answers through the real server', async () =>
{
    const root = await repo()
    const other = await makeRepo({ 'other.ts': 'export {}\n' }, 'codespace-tools-other-')
    const publicRoot = await makeTemp('codespace-tools-public-')
    await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Map</title>')
    const { port, stop } = await startServer(root, publicRoot)
    try
    {
        const listed = await send(port, '/api/tools')
        assert.equal(listed.status, 200)
        assert.equal(listed.body.version, 1)
        assert.equal(listed.body.repoQuery.name, 'repo')
        assert.deepEqual(listed.body.tools, JSON.parse(JSON.stringify(MapTools)))

        // Switching repositories is last, so every other tool reads the test repository.
        const ordered = [...MapTools.filter((tool) => tool.name !== 'switch_repo'), ...MapTools.filter((tool) => tool.name === 'switch_repo')]
        for (const tool of ordered)
        {
            const answer = await call(port, tool, argumentsFor(tool, other))
            assert.equal(answer.status, 200, `${tool.name} answers: ${answer.text.slice(0, 200)}`)
        }
    }
    finally { await stop(); await removeTemp(root, other, publicRoot) }
})

test('Next over HTTP settles generated files and hands out the rest, and apply takes them off the list', async () =>
{
    const root = await repo()
    const publicRoot = await makeTemp('codespace-tools-public-')
    const { port, stop } = await startServer(root, publicRoot)
    try
    {
        const next = await request(port, 'POST', '/api/ingest/next', { size: 40 })
        assert.equal(next.status, 200)
        assert.deepEqual(next.body.files.map((file: { path: string }) => file.path).sort(), ['src/a.ts', 'src/b.ts'])
        const written = JSON.parse(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'))
        assert.ok(written.files['package-lock.json'].summary, 'the lockfile is settled with a summary')

        const entry = { system: 'core', layer: 'base', tags: ['core'] }
        const applied = await request(port, 'POST', '/api/architecture', { files: { 'src/a.ts': { ...entry, summary: 'Uses b.' }, 'src/b.ts': { ...entry, summary: 'The value.' } } })
        assert.equal(applied.status, 200)
        const after = await request(port, 'POST', '/api/ingest/next', {})
        assert.deepEqual(after.body.files, [])

        // A next from another machine is a write, so it is refused.
        assert.equal((await request(port, 'POST', '/api/ingest/next', {}, { Host: 'example.com' })).status, 403)
    }
    finally { await stop(); await removeTemp(root, publicRoot) }
})

test('The chat is told every tool, with its endpoint', () =>
{
    const text = Instructions({ root: '/repo', mapUrl: 'http://localhost:6000', cli: '/cs/src/cli/Cli.ts' })
    for (const tool of MapTools) assert.ok(text.includes(`${tool.method} http://localhost:6000${tool.path}`) && text.includes(`(${tool.name})`), `the chat is told about ${tool.name}`)
})
