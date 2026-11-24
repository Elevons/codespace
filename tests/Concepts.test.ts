import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RunAsync } from '../src/cli/Cli.ts'
import { Architecture } from '../src/repo/Architecture.ts'
import { ConceptsLeft, ConceptsNextAsync, ReviewConcepts } from '../src/repo/Concepts.ts'
import { conceptFileOwners, conceptSpineLayout, conceptDataClaims } from '../public/rules.ts'
import { Graph } from '../src/repo/Graph.ts'
import { Repo } from '../src/repo/Repo.ts'
import { makeRepo, removeTemp } from './support.ts'

const Known = ['src/a.ts', 'src/b.ts', 'src/Cli.ts']

function repo(concepts?: unknown): Promise<string>
{
    return makeRepo({
        'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
        'src/b.ts': 'export const b = 1\n',
        'src/Cli.ts': "if (command === 'run') console.log(1)\nif (path === '/api/data') {}\n",
        '.codespace/architecture.json': JSON.stringify({ layers: ['data', 'top'], systems: { core: {} }, files: { 'src/Cli.ts': { tags: ['entry'], summary: 'Runs.' } }, ...(concepts === undefined ? {} : { concepts }) }),
    }, 'codespace-concepts-')
}

test('Concepts read layers, rules, and steps, and drop what does not exist', async () =>
{
    const root = await repo({
        data: { Data: { summary: 'The data.', layer: 'data', rules: ['Never empty.', 3] }, Lost: { layer: 'nowhere' } },
        operations: {
            Run: {
                reads: ['Data', 'Ghost'], writes: ['Data'], rules: ['Runs once.'],
                steps: [{ text: 'Do it.', files: ['src/a.ts', 'src/missing.ts'] }, { text: '' }, { text: 'Then more.' }],
            },
        },
    })
    try
    {
        const { concepts, warnings } = await Architecture.ReadAsync(root, Known)
        assert.deepEqual(concepts.data.Data, { summary: 'The data.', layer: 'data', rules: ['Never empty.'] })
        assert.deepEqual(concepts.data.Lost, {})
        assert.deepEqual(concepts.operations.Run, {
            files: ['src/a.ts'], reads: ['Data'], writes: ['Data'], rules: ['Runs once.'],
            steps: [{ text: 'Do it.', files: ['src/a.ts'] }, { text: 'Then more.', files: [] }],
        })
        assert.ok(warnings.some((warning) => /nowhere/.test(warning)), 'an unknown layer is reported')
        assert.ok(warnings.some((warning) => /Ghost/.test(warning)), 'an undeclared datum is reported')
        assert.ok(warnings.some((warning) => /missing\.ts/.test(warning)), 'a missing file is reported')
    }
    finally { await removeTemp(root) }
})

test('A concepts patch merges by name, removes with null, and keeps the file stable', async () =>
{
    const root = await repo()
    try
    {
        await Architecture.UpdateAsync(root, Known, { concepts: {
            data: { Data: { summary: 'The data.', layer: 'data', rules: ['Never empty.'] }, Report: { summary: 'A report.', layer: 'top' } },
            operations: { Run: { summary: 'Runs.', reads: ['Data'], writes: ['Report'], steps: [{ text: 'Read it.', files: ['src/a.ts'] }, { text: 'Write it.', files: ['src/b.ts'] }], rules: ['Once.'] } },
        } })
        let read = (await Architecture.ReadAsync(root, Known)).concepts
        assert.deepEqual(read.operations.Run?.files, ['src/a.ts', 'src/b.ts'])
        assert.equal(read.operations.Run?.steps.length, 2)

        // Only the named fields change; null removes a field; a list replaces the old one.
        await Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: { layer: null, rules: ['Always one.'] } }, operations: { Run: { rules: null, writes: [] } } } })
        read = (await Architecture.ReadAsync(root, Known)).concepts
        assert.deepEqual(read.data.Data, { summary: 'The data.', rules: ['Always one.'] })
        assert.deepEqual(read.operations.Run?.rules, [])
        assert.deepEqual(read.operations.Run?.writes, [])
        assert.equal(read.operations.Run?.summary, 'Runs.')

        const once = await readFile(join(root, '.codespace/architecture.json'), 'utf8')
        await Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: {} } } })
        assert.equal(await readFile(join(root, '.codespace/architecture.json'), 'utf8'), once, 'writing again changes nothing')
        assert.ok(once.includes('"files": {'), 'the files section is kept')
        assert.deepEqual(JSON.parse(once).layers, ['data', 'top'])

        await Architecture.UpdateAsync(root, Known, { concepts: { operations: { Run: null }, data: { Report: null } } })
        read = (await Architecture.ReadAsync(root, Known)).concepts
        assert.deepEqual(Object.keys(read.operations), [])
        assert.deepEqual(Object.keys(read.data), ['Data'])
    }
    finally { await removeTemp(root) }
})

test('A concepts patch is all or nothing and says what is wrong', async () =>
{
    const root = await repo({ data: { Data: { layer: 'data' } }, operations: { Run: { reads: ['Data'], writes: [] } } })
    try
    {
        const before = await readFile(join(root, '.codespace/architecture.json'), 'utf8')
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: null } } }), /Cannot remove the data "Data": the operation "Run" still reads it/)
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: {
            data: { Fresh: { layer: 'nowhere' } },
            operations: { New: { reads: ['Undeclared'], steps: [{ text: 'Do.', files: ['src/gone.ts'] }] } },
        }, files: { 'src/a.ts': { summary: 'Fine.' } } }), (error: Error) =>
            /layer "nowhere"/.test(error.message) && /Undeclared/.test(error.message) && /src\/gone\.ts/.test(error.message))
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: { rules: 'no' as unknown as string[] } } } }), /rules must be a list/)
        assert.equal(await readFile(join(root, '.codespace/architecture.json'), 'utf8'), before, 'nothing was written')

        // Taking the use away in the same change lets the data go.
        await Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: null }, operations: { Run: { reads: null } } } })
        assert.deepEqual((await Architecture.ReadAsync(root, Known)).concepts.data, {})
    }
    finally { await removeTemp(root) }
})

test('A moved file is followed in the operations that name it', async () =>
{
    const root = await repo({ data: {}, operations: { Run: { files: ['src/a.ts'], steps: [{ text: 'Do.', files: ['src/a.ts'] }] } } })
    try
    {
        await Architecture.UpdateAsync(root, Known, { files: { 'src/a.ts': { summary: 'A.' } } })
        const moved = [...Known, 'src/c.ts']
        await Architecture.UpdateAsync(root, moved, { renames: [{ from: 'src/a.ts', to: 'src/c.ts' }] })
        const run = (await Architecture.ReadAsync(root, moved)).concepts.operations.Run
        assert.deepEqual(run?.files, ['src/c.ts'])
        assert.deepEqual(run?.steps[0]?.files, ['src/c.ts'])
    }
    finally { await removeTemp(root) }
})

test('The pass hands out the whole overview first, then what each operation still lacks', async () =>
{
    const root = await repo()
    try
    {
        const opened = await Repo.OpenAsync(root)
        const first = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(first.mode, 'overview')
        assert.equal(first.remaining, 1)
        assert.deepEqual(first.overview?.files.map((file) => file.path), ['src/Cli.ts', 'src/a.ts', 'src/b.ts'])
        assert.equal(first.overview?.files[0]?.summary, 'Runs.')
        assert.match(first.guide, /plain words/)

        await Architecture.UpdateAsync(root, Known, { concepts: {
            data: { Data: { summary: 'Data.' } },
            operations: { Run: { files: ['src/a.ts'] }, Done: { reads: ['Data'], steps: [{ text: 'Do.', files: ['src/b.ts'] }] } },
        } })
        const second = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(second.mode, 'operations')
        assert.deepEqual(second.operations.map((operation) => [operation.name, operation.missing]), [['Run', ['steps', 'reads or writes']]])
        assert.deepEqual(second.operations[0]?.files.map((file) => [file.path, file.imports]), [['src/a.ts', ['src/b.ts']]])
        assert.deepEqual(second.operations[0]?.nearby.map((file) => [file.path, file.relation]), [['src/b.ts', 'imports']])
        assert.equal(second.remaining, 3, 'the operation, the data without a layer or files, and the unplaced src/Cli.ts')

        await Architecture.UpdateAsync(root, Known, { concepts: { operations: { Run: { reads: ['Data'], steps: [{ text: 'Go.', files: ['src/a.ts'] }] } } } })
        const data = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(data.mode, 'data')
        assert.deepEqual(data.data.map((datum) => [datum.name, datum.missing]), [['Data', ['layer', 'files']]])
        await Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: { layer: 'data', files: ['src/b.ts'] } } } })

        const place = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(place.mode, 'place', 'a described file no operation or data entry names is handed back')
        assert.deepEqual(place.unplaced.map((file) => [file.path, file.summary]), [['src/Cli.ts', 'Runs.']])
        assert.equal(place.remaining, 1)
        await Architecture.UpdateAsync(root, Known, { concepts: { operations: { Run: { steps: [{ text: 'Start.', files: ['src/Cli.ts'] }, { text: 'Go.', files: ['src/a.ts'] }] } } } })
        const done = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(done.mode, 'done')
        assert.equal(done.remaining, 0)
    }
    finally { await removeTemp(root) }
})

test('The concepts command prints the pass, and apply takes a concepts patch', async () =>
{
    const root = await repo()
    const out: string[] = []
    const log = console.log
    console.log = (...parts: unknown[]) => { out.push(parts.join(' ')) }
    try
    {
        assert.equal(await RunAsync(['concepts', '--repo', root]), 0)
        assert.equal(JSON.parse(out.pop()!).mode, 'overview')
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(root, 'patch.json'), JSON.stringify({ concepts: { data: { Data: { layer: 'data' } } } }))
        assert.equal(await RunAsync(['apply', '--file', join(root, 'patch.json'), '--repo', root]), 0)
        assert.deepEqual((await Architecture.ReadAsync(root, Known)).concepts.data, { Data: { layer: 'data' } })
    }
    finally
    {
        console.log = log
        await removeTemp(root)
    }
})

test('ConceptsLeft counts what the design still needs, without reading a file', async () =>
{
    const root = await repo({
        data: { Data: { layer: 'data' }, Loose: { summary: 'Kept somewhere.' } },
        operations: {
            Good: { summary: 'Runs.', reads: ['Data'], writes: [], steps: [{ text: 'Do it.', files: ['src/a.ts'] }] },
            Bare: { summary: 'Not written yet.' },
            Ungrounded: { summary: 'No file evidence.', reads: ['Data'], steps: [{ text: 'Magic.', files: [] }] },
        },
    })
    try
    {
        const architecture = await Architecture.ReadAsync(root, Known)
        assert.deepEqual(ConceptsLeft(architecture), { started: true, operations: 2, data: 2, unplaced: 1 }, 'both data lack files; src/Cli.ts is described and unplaced')
    }
    finally { await removeTemp(root) }

    const empty = await repo()
    try
    {
        const architecture = await Architecture.ReadAsync(empty, Known)
        assert.deepEqual(ConceptsLeft(architecture), { started: false, operations: 0, data: 0, unplaced: 0 })
    }
    finally { await removeTemp(empty) }
})

test('The overview lists every described file, tests, docs, and data tables alike, with nothing picked out', async () =>
{
    const root = await makeRepo({
        'src/Model/WorldState.cs': 'namespace Sim.Model;\npublic class WorldState { public int TickCount; }\n',
        'src/Sim/SimulationRunner.cs': 'using Sim.Model;\nnamespace Sim.Core;\npublic class SimulationRunner { public void Tick() {} }\n',
        'data/places.json': '{"places": []}\n',
        'tests/SimTests.cs': 'using Sim.Core;\nnamespace Sim.Tests;\npublic class SimTests { public void Run() {} }\n',
        'README.md': '# Sim\n',
        'package-lock.json': '{}\n',
        '.codespace/architecture.json': JSON.stringify({
            layers: ['docs', 'data', 'model', 'entry', 'tests'],
            systems: { sim: { summary: 'Runs the world simulation.' }, meta: { summary: 'Docs and tests.' } },
            folders: { 'src/Model': { summary: 'Simulation state.' } },
            files: {
                'src/Model/WorldState.cs': { system: 'sim', layer: 'model', tags: ['data'], summary: 'Holds the live world state.' },
                'src/Sim/SimulationRunner.cs': { system: 'sim', layer: 'entry', tags: ['orchestrate'], summary: 'Advances the simulation one tick at a time.' },
                'data/places.json': { system: 'sim', layer: 'data', tags: ['data'], summary: 'The authored places.' },
                'tests/SimTests.cs': { system: 'meta', layer: 'tests', tags: ['test'], summary: 'Tests the simulation.' },
                'README.md': { system: 'meta', layer: 'docs', tags: ['config'], summary: 'Readme.' },
                'package-lock.json': { summary: 'Lockfile.' },
            },
        }),
    }, 'codespace-overview-')
    try
    {
        const opened = await Repo.OpenAsync(root)
        const known = await opened.ListFilesAsync()
        const batch = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(batch.mode, 'overview')
        assert.deepEqual(batch.overview?.files.map((f) => f.path), [
            'README.md', 'data/places.json', 'src/Model/WorldState.cs', 'src/Sim/SimulationRunner.cs', 'tests/SimTests.cs',
        ], 'only generated files are left out')
        assert.equal(batch.overview?.systems.sim?.files, 3)
        assert.deepEqual(batch.overview?.folders.find((f) => f.path === 'src/Model'), { path: 'src/Model', summary: 'Simulation state.', files: 1 })
        assert.ok(!('candidates' in batch) && !('dataCandidates' in batch) && !('entryFiles' in batch), 'no preset guesses')
    }
    finally { await removeTemp(root) }
})

test('A data entry names the files that hold it, they count as placed, follow a move, and stand under its hexagon on the map', async () =>
{
    const root = await repo({
        data: { Data: { summary: 'The data.', layer: 'data', files: ['src/b.ts', 'src/gone.ts'] } },
        operations: { Run: { writes: ['Data'], steps: [{ text: 'Do.', files: ['src/a.ts'] }] } },
    })
    try
    {
        const architecture = await Architecture.ReadAsync(root, Known)
        assert.deepEqual(architecture.concepts.data.Data?.files, ['src/b.ts'])
        assert.ok(architecture.warnings.some((w) => /src\/gone\.ts/.test(w)))
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: { data: { Data: { files: ['src/nope.ts'] } } } }), /"src\/nope\.ts" is not a file/)

        const opened = await Repo.OpenAsync(root)
        const review = ReviewConcepts(architecture, await Graph.BuildAsync(opened), Known)
        assert.deepEqual(review.coverage.unplaced, ['src/Cli.ts'])

        const layout = conceptSpineLayout({
            center: { x: 0, z: 0 },
            files: Known.map((path) => ({ path, y: 0 })),
            data: architecture.concepts.data,
            operations: architecture.concepts.operations,
            unmappedName: 'Not in an operation',
        })
        assert.deepEqual(layout.operations.find((op) => op.name === 'Run')?.files, ['src/a.ts'])
        const hex = layout.data.find((datum) => datum.name === 'Data')!
        assert.deepEqual(hex.files, ['src/b.ts'], 'a file only the data names stands under its hexagon')
        const at = layout.home.get('src/b.ts')!
        assert.ok(Math.hypot(at.x - hex.x, at.z - hex.z) < 1, 'and sits at the hexagon, not in a column')

        const moved = [...Known, 'src/c.ts']
        await Architecture.UpdateAsync(root, Known, { files: { 'src/b.ts': { summary: 'B.' } } })
        await Architecture.UpdateAsync(root, moved, { renames: [{ from: 'src/b.ts', to: 'src/c.ts' }] })
        assert.deepEqual((await Architecture.ReadAsync(root, moved)).concepts.data.Data?.files, ['src/c.ts'])
    }
    finally { await removeTemp(root) }
})

test('ReviewConcepts blocks on uncovered systems and orphan data, and flags reflexion issues', async () =>
{
    const files: Record<string, string> = {
        'src/a1.ts': "import './a2.ts'\nimport './a3.ts'\nexport const a1 = 1\n",
        'src/a2.ts': "import './a4.ts'\nexport const a2 = 2\n",
        'src/a3.ts': 'export const a3 = 3\n',
        'src/a4.ts': 'export const a4 = 4\n',
        'src/b1.ts': "import './b2.ts'\nexport const b1 = 1\n",
        'src/b2.ts': "import './b3.ts'\nexport const b2 = 2\n",
        'src/b3.ts': 'export const b3 = 3\n',
        'src/b4.ts': 'export const b4 = 4\n',
    }
    const archFiles = Object.fromEntries(Object.keys(files).map((path) => [
        path,
        { system: path.startsWith('src/a') ? 'alpha' : 'beta', layer: 'core', tags: ['core'], summary: `File ${path}.` },
    ]))
    const root = await makeRepo({
        ...files,
        '.codespace/architecture.json': JSON.stringify({
            layers: ['data', 'core'],
            systems: { alpha: { summary: 'Alpha.' }, beta: { summary: 'Beta.' } },
            files: archFiles,
            concepts: {
                data: {
                    Input: { summary: 'External input.', layer: 'data', files: ['src/a1.ts'] },
                    Orphan: { layer: 'data', files: ['src/a1.ts'] },
                    alpha: { summary: 'Named after a system.', layer: 'data', files: ['src/a2.ts'] },
                },
                operations: {
                    DoAlpha: {
                        reads: ['Input'],
                        writes: ['alpha'],
                        files: ['src/a1.ts', 'src/a2.ts', 'src/a3.ts'],
                        steps: [{ text: 'Run src/a1.ts on the input.', files: ['src/a1.ts', 'src/a2.ts'] }],
                    },
                    DoAlphaCopy: {
                        summary: 'Duplicate.',
                        reads: ['Input'],
                        writes: ['alpha'],
                        steps: [{ text: 'Do alpha again.', files: ['src/a1.ts', 'src/a2.ts'] }],
                    },
                },
            },
        }),
    }, 'codespace-review-')
    try
    {
        const opened = await Repo.OpenAsync(root)
        const known = await opened.ListFilesAsync()
        const architecture = await Architecture.ReadAsync(root, known)
        const graph = await Graph.BuildAsync(opened)

        const review = ReviewConcepts(architecture, graph, known, 8)
        assert.equal(review.coverage.files, 8)
        assert.equal(review.coverage.placedFiles, 3)
        assert.deepEqual(review.coverage.unplaced, ['src/a4.ts', 'src/b1.ts', 'src/b2.ts', 'src/b3.ts', 'src/b4.ts'])
        assert.deepEqual(review.orphanData, ['Orphan'])
        assert.deepEqual(review.externalInputs, ['Input'])
        assert.deepEqual(review.finalOutputs, ['alpha'])
        assert.deepEqual(review.coverage.uncoveredSystems.map((s) => s.name), ['beta'])
        assert.equal(review.overlaps.length, 1, 'detects near-duplicate operations')
        assert.ok(review.divergences.some((d) => d.operation === 'DoAlpha' && d.unplacedImports.some((u) => u.path === 'src/a4.ts')), 'detects uncovered import divergence')
        assert.ok(review.issues.some((i) => /names a file in its text/.test(i)), 'flags file path leaked into step text')
        assert.ok(review.issues.some((i) => /not tied to any step/.test(i)), 'flags unplaced operation file src/a3.ts')
        assert.ok(review.issues.some((i) => /looks like a system/.test(i)), 'flags module-shaped datum name')
        assert.equal(review.blocking.length, 2, 'blocks on the orphan datum and the uncovered system')

        const batch = await ConceptsNextAsync(opened, architecture, graph, 8, 'cli.ts')
        assert.equal(batch.mode, 'place')
        assert.deepEqual(batch.unplaced.map((file) => file.path), ['src/a4.ts', 'src/b1.ts', 'src/b2.ts', 'src/b3.ts', 'src/b4.ts'])
        assert.ok(batch.unplaced[0]?.near.includes('operation: DoAlpha'), 'a4 is imported by a file DoAlpha names')
        assert.equal(batch.remaining, 7, 'two blocking gaps and five unplaced files')

        // Resolving the blocking gaps transitions cleanly to done.
        await Architecture.UpdateAsync(root, known, { concepts: {
            data: { Orphan: null },
            operations: {
                DoAlphaCopy: null,
                DoBeta: {
                    summary: 'Handles beta.',
                    reads: ['Input'],
                    writes: ['alpha'],
                    steps: [
                        { text: 'Start beta processing.', files: ['src/b1.ts', 'src/b2.ts'] },
                        { text: 'Finish beta processing.', files: ['src/b3.ts', 'src/b4.ts', 'src/a4.ts'] },
                    ],
                },
            },
        } })
        const after = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, known), graph, 8, 'cli.ts')
        assert.equal(after.mode, 'done')
        assert.equal(after.remaining, 0)
    }
    finally { await removeTemp(root) }
})

test('ConceptsNextAsync pages the overview under 40 KB without leaving a file out', async () =>
{
    const files: Record<string, string> = {}
    const archFiles: Record<string, { system: string, layer: string, tags: string[], summary: string }> = {}
    const body = `${'export const line = "payload padding for large source files"\n'.repeat(120)}`
    for (let i = 0; i < 300; i++)
    {
        const path = `src/mod${String(i % 35).padStart(2, '0')}/File${i}Store.ts`
        files[path] = body
        archFiles[path] = { system: 'core', layer: 'data', tags: ['data'], summary: `Handles workflow and stored records for module ${i}. ${'A long summary. '.repeat(10)}` }
    }
    const root = await makeRepo({
        ...files,
        '.codespace/architecture.json': JSON.stringify({ layers: ['data', 'entry'], systems: { core: { summary: 'Core system.' } }, files: archFiles }),
    }, 'codespace-budget-')
    try
    {
        const opened = await Repo.OpenAsync(root)
        const known = await opened.ListFilesAsync()
        const graph = await Graph.BuildAsync(opened)
        const architecture = await Architecture.ReadAsync(root, known)

        const first = await ConceptsNextAsync(opened, architecture, graph, 8, 'cli.ts')
        const pages = first.overview!.pages
        assert.ok(pages > 1)
        const seen: string[] = []
        for (let page = 1; page <= pages; page++)
        {
            const batch = await ConceptsNextAsync(opened, architecture, graph, 8, 'cli.ts', page)
            const json = JSON.stringify(batch)
            assert.ok(json.length < 40_000, `page ${page} is ${json.length} characters`)
            assert.ok(json.indexOf('"overview"') < json.indexOf('"data"'), 'overview serializes near the top')
            seen.push(...batch.overview!.files.map((f) => f.path))
        }
        assert.deepEqual(seen, Object.keys(files).sort(), 'every file, once, in order')

        const allPaths = Object.keys(files)
        await Architecture.UpdateAsync(root, known, { concepts: {
            operations: Object.fromEntries([0, 1, 2, 3, 4].map((n) => [`Op${n}`, { files: allPaths.slice(n * 10, n * 10 + 10) }])),
        } })
        const operations = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, known), graph, 8, 'cli.ts')
        assert.equal(operations.mode, 'operations')
        assert.equal(operations.overview, undefined)
        assert.equal(operations.operations.length, 3, 'caps operations per batch')
        assert.ok(JSON.stringify(operations).length < 40_000)
        const paged = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, known), graph, 8, 'cli.ts', 2)
        assert.equal(paged.mode, 'operations')
        assert.equal(paged.overview?.page, 2, 'a page is returned at any stage')
    }
    finally { await removeTemp(root) }
})

test('Every operation that names a file draws at least one in its own column', () =>
{
    const owners = conceptFileOwners([
        { name: 'Big', files: ['a', 'b', 'c'], steps: [{ files: ['a', 'b', 'c'] }] },
        { name: 'Shared', files: ['a', 'b'], steps: [{ files: ['a'] }, { files: ['a'] }] },
        { name: 'Subset', files: ['c'], steps: [{ files: ['c'] }] },
    ])
    assert.equal(owners.get('a'), 'Shared', 'the operation whose steps cite a file most keeps it')
    assert.equal(owners.get('c'), 'Subset', 'the smaller operation wins a tie')
    const counts = new Map<string, number>()
    for (const name of owners.values()) counts.set(name, (counts.get(name) ?? 0) + 1)
    for (const name of ['Big', 'Shared', 'Subset']) assert.ok((counts.get(name) ?? 0) > 0, `${name} has a file`)
})

test('A file an operation needs to keep a column stays there, the rest of a datum\'s files go under its hexagon', () =>
{
  const known = new Set(['a', 'b', 'c'])
  const ops = [{ name: 'Load', files: ['a'], steps: [{ files: ['a'] }] }, { name: 'Run', files: ['b', 'c'], steps: [{ files: ['b', 'c'] }] }]
  const claims = conceptDataClaims({ Tables: { files: ['a', 'b', 'c', 'gone'] } }, ops, known)
  assert.deepEqual([...claims.entries()], [['b', 'Tables']], 'Load keeps its only file, Run keeps one of its two, unknown files are ignored')
})

test('A map written with the old "things" key reads as data, and the next apply rewrites it as data', async () =>
{
    const root = await makeRepo({
        'src/a.ts': 'export const a = 1\n',
        '.codespace/architecture.json': JSON.stringify({
            layers: ['data'], files: { 'src/a.ts': { summary: 'A.' } },
            concepts: { things: { Table: { summary: 'Rows.', layer: 'data', files: ['src/a.ts'] } }, operations: { Load: { reads: ['Table'], steps: [{ text: 'Read.', files: ['src/a.ts'] }] } } },
        }),
    }, 'codespace-legacy-')
    try
    {
        const known = ['src/a.ts']
        const before = await Architecture.ReadAsync(root, known)
        assert.deepEqual(before.concepts.data.Table?.files, ['src/a.ts'])
        assert.deepEqual(before.warnings, [])
        await Architecture.UpdateAsync(root, known, { concepts: { things: { Table: { summary: 'All the rows.' } } } } as never)
        const text = await readFile(join(root, '.codespace/architecture.json'), 'utf8')
        assert.ok(text.includes('"data": {') && !text.includes('"things"'), 'the file now says data')
        assert.equal((await Architecture.ReadAsync(root, known)).concepts.data.Table?.summary, 'All the rows.', 'an old-style patch still applies')
    }
    finally { await removeTemp(root) }
})

test('The review flags data that holds more than 15 files', async () =>
{
    const files: Record<string, string> = {}
    for (let i = 0; i < 17; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i}\n`
    const known = Object.keys(files)
    const root = await makeRepo({
        ...files,
        '.codespace/architecture.json': JSON.stringify({
            layers: ['data'], files: Object.fromEntries(known.map((path) => [path, { summary: 'F.' }])),
            concepts: { data: { Bucket: { summary: 'Everything.', layer: 'data', files: known } }, operations: { Use: { reads: ['Bucket'], steps: [{ text: 'Use it.', files: ['src/f0.ts'] }] } } },
        }),
    }, 'codespace-oversized-')
    try
    {
        const opened = await Repo.OpenAsync(root)
        const review = ReviewConcepts(await Architecture.ReadAsync(root, known), await Graph.BuildAsync(opened), known)
        assert.ok(review.issues.some((issue) => /"Bucket" holds 17 files/.test(issue)))
    }
    finally { await removeTemp(root) }
})
