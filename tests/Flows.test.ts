import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DraftTour, MaxTourSteps, NormaliseFlow, ReadFlowsAsync, WriteFlowsAsync } from '../src/repo/Flows.ts'
import type { IArchitecture } from '../src/repo/Architecture.ts'
import { makeRepo, removeTemp, request, send, startApi } from './support.ts'

function architecture(): IArchitecture
{
    return {
        layers: ['model', 'api', 'entry'],
        systems: {},
        files: {
            'src/main.ts': { layer: 'entry', tags: ['entry'], summary: 'Starts the application.' },
            'src/server.ts': { layer: 'api', tags: ['io'], summary: 'Answers requests.' },
            'src/store.ts': { layer: 'model', tags: ['data'], summary: 'Keeps the records.' },
        },
        folders: {},
        warnings: [],
        error: '',
    }
}

const edges: Array<[string, string]> = [
    ['src/main.ts', 'src/server.ts'],
    ['src/server.ts', 'src/store.ts'],
]

test('A flow is trimmed, checked, and kept within the show limits', () =>
{
    const flow = NormaliseFlow({ name: '  First look  ', title: '', note: '  How it runs.  ', files: ['src/a.ts', { path: 'src/b.ts', note: '  Second  ' }] })
    assert.deepEqual(flow, {
        name: 'First look',
        title: 'First look',
        note: 'How it runs.',
        trace: false,
        files: [{ path: 'src/a.ts', note: '' }, { path: 'src/b.ts', note: 'Second' }],
    })
    assert.throws(() => NormaliseFlow({ name: '', files: ['src/a.ts'] }), /needs a name/)
    assert.throws(() => NormaliseFlow({ name: 'Empty', files: [] }), /at least one file/)
    assert.throws(() => NormaliseFlow({ name: 'Wrong', files: ['nope.ts'] }, new Set(['src/a.ts'])), /not in the repository/)
})

test('A start-here tour begins at the entry file and follows what it reaches', () =>
{
    const tour = DraftTour(architecture(), edges, 'Codespace')
    assert.ok(tour !== null)
    assert.equal(tour.name, 'start-here')
    assert.equal(tour.trace, true)
    assert.deepEqual(tour.files.map((step) => step.path), ['src/main.ts', 'src/server.ts', 'src/store.ts'])
    assert.equal(tour.files[0]?.note, 'Starts the application.')
    assert.match(tour.note, /Codespace/)
})

test('A start-here tour needs at least two described files', () =>
{
    const bare = architecture()
    bare.files = { 'src/main.ts': { summary: 'Starts.' } }
    assert.equal(DraftTour(bare, edges, 'Bare'), null)
    assert.equal(DraftTour({ ...architecture(), files: {} }, edges, 'Empty'), null)
    const tour = DraftTour(architecture(), edges, 'Many')
    assert.ok(tour !== null && tour.files.length <= MaxTourSteps)
})

test('Flows are saved under their name, shown on the map, and deleted', async () =>
{
    const root = await makeRepo({
        'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
        'src/b.ts': 'export const b = 2\n',
        '.codespace/architecture.json': JSON.stringify({
            layers: ['base', 'top'],
            files: {
                'src/a.ts': { layer: 'top', tags: ['entry'], summary: 'Starts.' },
                'src/b.ts': { layer: 'base', tags: ['core'], summary: 'Stores.' },
            },
        }),
    }, 'codespace-flows-')
    const { port, workspace, stop } = await startApi(root)
    try
    {
        const flow = { name: 'Sign in', title: 'How signing in works', trace: true, files: [{ path: 'src/a.ts', note: 'The form.' }, { path: 'src/b.ts', note: 'The check.' }] }
        const saved = await request(port, 'POST', '/api/flows', { action: 'save', flow })
        assert.equal(saved.status, 200, saved.text)
        assert.equal(saved.body.flows.length, 1)

        // A save from another machine is a write, so it is refused.
        assert.equal((await request(port, 'POST', '/api/flows', { action: 'save', flow }, { Host: 'example.com' })).status, 403)

        const listed = await send(port, '/api/flows')
        assert.deepEqual(listed.body.flows, [NormaliseFlow(flow)])

        // Saving the same name replaces the flow, rather than adding a second one.
        assert.equal((await request(port, 'POST', '/api/flows', { action: 'save', flow: { ...flow, note: 'Again.' } })).body.flows.length, 1)

        const shown = await request(port, 'POST', '/api/flows', { action: 'show', name: 'sign in' })
        assert.equal(shown.status, 200, shown.text)
        assert.deepEqual(workspace.view.Shown?.files.map((file) => file.path), ['src/a.ts', 'src/b.ts'])
        assert.equal(workspace.view.Shown?.trace, true)

        // A draft is made from the architecture file, and is not saved.
        const draft = await send(port, '/api/flows?draft=1')
        assert.equal(draft.status, 200)
        assert.equal(draft.body.flow.name, 'start-here')
        assert.equal((await send(port, '/api/flows')).body.flows.length, 1)

        // Only a truthy draft asks for a tour; false and 0 list the flows.
        assert.deepEqual((await send(port, '/api/flows?draft=false')).body.flows.map((item: { name: string }) => item.name), ['Sign in'])
        assert.deepEqual((await send(port, '/api/flows?draft=0')).body.flows.map((item: { name: string }) => item.name), ['Sign in'])

        // A flow that names a file which has since gone is refused when it is shown.
        await request(port, 'POST', '/api/flows', { action: 'save', flow: { name: 'Stale', files: ['src/a.ts'] } })
        await rm(join(root, 'src', 'b.ts'))
        assert.equal((await request(port, 'POST', '/api/flows', { action: 'show', name: 'Sign in' })).status, 400)

        const deleted = await request(port, 'POST', '/api/flows', { action: 'delete', name: 'Stale' })
        assert.equal(deleted.body.deleted, true)
        assert.deepEqual(deleted.body.flows.map((item: { name: string }) => item.name), ['Sign in'])

        assert.equal((await request(port, 'POST', '/api/flows', { action: 'show', name: 'Missing' })).status, 400)
        assert.equal((await request(port, 'POST', '/api/flows', { action: 'nonsense' })).status, 400)
    }
    finally { await stop(); await removeTemp(root) }
})

test('Flows are written once and read back whole', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-flows-store-')
    try
    {
        await WriteFlowsAsync(root, [NormaliseFlow({ name: 'One', trace: true, files: [{ path: 'src/a.ts', note: 'Here.' }] })])
        assert.deepEqual(await ReadFlowsAsync(root), [{ name: 'One', title: 'One', note: '', trace: true, files: [{ path: 'src/a.ts', note: 'Here.' }] }])
        assert.deepEqual(await ReadFlowsAsync(join(root, 'nowhere')), [])
    }
    finally { await removeTemp(root) }
})
