import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RunAsync } from '../src/cli/Cli.ts'
import { Architecture } from '../src/repo/Architecture.ts'
import { ConceptsLeft, ConceptsNextAsync, IsAppFile, ReviewConcepts } from '../src/repo/Concepts.ts'
import { Graph } from '../src/repo/Graph.ts'
import { Repo } from '../src/repo/Repo.ts'
import { makeRepo, removeTemp } from './support.ts'

const Known = ['src/a.ts', 'src/b.ts', 'src/Cli.ts']

function repo(concepts?: unknown): Promise<string>
{
    return makeRepo({
        'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
        'src/b.ts': 'export const b = 1\n',
        'src/Cli.ts': "if (command === 'run') console.log(1)\nif (path === '/api/things') {}\n",
        '.codespace/architecture.json': JSON.stringify({ layers: ['data', 'top'], systems: { core: {} }, files: { 'src/Cli.ts': { tags: ['entry'], summary: 'Runs.' } }, ...(concepts === undefined ? {} : { concepts }) }),
    }, 'codespace-concepts-')
}

test('Concepts read layers, rules, and steps, and drop what does not exist', async () =>
{
    const root = await repo({
        things: { Data: { summary: 'The data.', layer: 'data', rules: ['Never empty.', 3] }, Lost: { layer: 'nowhere' } },
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
        assert.deepEqual(concepts.things.Data, { summary: 'The data.', layer: 'data', rules: ['Never empty.'] })
        assert.deepEqual(concepts.things.Lost, {})
        assert.deepEqual(concepts.operations.Run, {
            files: ['src/a.ts'], reads: ['Data'], writes: ['Data'], rules: ['Runs once.'],
            steps: [{ text: 'Do it.', files: ['src/a.ts'] }, { text: 'Then more.', files: [] }],
        })
        assert.ok(warnings.some((warning) => /nowhere/.test(warning)), 'an unknown layer is reported')
        assert.ok(warnings.some((warning) => /Ghost/.test(warning)), 'an undeclared thing is reported')
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
            things: { Data: { summary: 'The data.', layer: 'data', rules: ['Never empty.'] }, Report: { summary: 'A report.', layer: 'top' } },
            operations: { Run: { summary: 'Runs.', reads: ['Data'], writes: ['Report'], steps: [{ text: 'Read it.', files: ['src/a.ts'] }, { text: 'Write it.', files: ['src/b.ts'] }], rules: ['Once.'] } },
        } })
        let read = (await Architecture.ReadAsync(root, Known)).concepts
        assert.deepEqual(read.operations.Run?.files, ['src/a.ts', 'src/b.ts'])
        assert.equal(read.operations.Run?.steps.length, 2)

        // Only the named fields change; null removes a field; a list replaces the old one.
        await Architecture.UpdateAsync(root, Known, { concepts: { things: { Data: { layer: null, rules: ['Always one.'] } }, operations: { Run: { rules: null, writes: [] } } } })
        read = (await Architecture.ReadAsync(root, Known)).concepts
        assert.deepEqual(read.things.Data, { summary: 'The data.', rules: ['Always one.'] })
        assert.deepEqual(read.operations.Run?.rules, [])
        assert.deepEqual(read.operations.Run?.writes, [])
        assert.equal(read.operations.Run?.summary, 'Runs.')

        const once = await readFile(join(root, '.codespace/architecture.json'), 'utf8')
        await Architecture.UpdateAsync(root, Known, { concepts: { things: { Data: {} } } })
        assert.equal(await readFile(join(root, '.codespace/architecture.json'), 'utf8'), once, 'writing again changes nothing')
        assert.ok(once.includes('"files": {'), 'the files section is kept')
        assert.deepEqual(JSON.parse(once).layers, ['data', 'top'])

        await Architecture.UpdateAsync(root, Known, { concepts: { operations: { Run: null }, things: { Report: null } } })
        read = (await Architecture.ReadAsync(root, Known)).concepts
        assert.deepEqual(Object.keys(read.operations), [])
        assert.deepEqual(Object.keys(read.things), ['Data'])
    }
    finally { await removeTemp(root) }
})

test('A concepts patch is all or nothing and says what is wrong', async () =>
{
    const root = await repo({ things: { Data: { layer: 'data' } }, operations: { Run: { reads: ['Data'], writes: [] } } })
    try
    {
        const before = await readFile(join(root, '.codespace/architecture.json'), 'utf8')
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: { things: { Data: null } } }), /Cannot remove the thing "Data": the operation "Run" still reads it/)
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: {
            things: { Fresh: { layer: 'nowhere' } },
            operations: { New: { reads: ['Undeclared'], steps: [{ text: 'Do.', files: ['src/gone.ts'] }] } },
        }, files: { 'src/a.ts': { summary: 'Fine.' } } }), (error: Error) =>
            /layer "nowhere"/.test(error.message) && /Undeclared/.test(error.message) && /src\/gone\.ts/.test(error.message))
        await assert.rejects(Architecture.UpdateAsync(root, Known, { concepts: { things: { Data: { rules: 'no' as unknown as string[] } } } }), /rules must be a list/)
        assert.equal(await readFile(join(root, '.codespace/architecture.json'), 'utf8'), before, 'nothing was written')

        // Taking the use away in the same change lets the thing go.
        await Architecture.UpdateAsync(root, Known, { concepts: { things: { Data: null }, operations: { Run: { reads: null } } } })
        assert.deepEqual((await Architecture.ReadAsync(root, Known)).concepts.things, {})
    }
    finally { await removeTemp(root) }
})

test('A moved file is followed in the operations that name it', async () =>
{
    const root = await repo({ things: {}, operations: { Run: { files: ['src/a.ts'], steps: [{ text: 'Do.', files: ['src/a.ts'] }] } } })
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

test('The pass lists entry points first, then what each operation still lacks', async () =>
{
    const root = await repo()
    try
    {
        const opened = await Repo.OpenAsync(root)
        const first = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(first.mode, 'candidates')
        assert.equal(first.remaining, 1)
        const names = first.candidates.map((candidate) => `${candidate.kind}:${candidate.name}`)
        assert.ok(names.includes('entry file:src/Cli.ts'))
        assert.ok(names.includes('cli command:run'))
        assert.ok(names.includes('endpoint:/api/things'))
        assert.equal(first.entryFiles[0]?.path, 'src/Cli.ts')
        assert.match(first.guide, /plain words/)

        await Architecture.UpdateAsync(root, Known, { concepts: {
            things: { Data: { summary: 'Data.' } },
            operations: { Run: { files: ['src/a.ts'] }, Done: { reads: ['Data'], steps: [{ text: 'Do.', files: ['src/b.ts'] }] } },
        } })
        const second = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        assert.equal(second.mode, 'operations')
        assert.deepEqual(second.operations.map((operation) => [operation.name, operation.missing]), [['Run', ['steps', 'reads or writes']]])
        assert.deepEqual(second.operations[0]?.files.map((file) => [file.path, file.imports]), [['src/a.ts', ['src/b.ts']]])
        assert.deepEqual(second.operations[0]?.nearby.map((file) => [file.path, file.relation]), [['src/b.ts', 'imports']])
        assert.equal(second.remaining, 2, 'the operation and the thing without a layer')

        await Architecture.UpdateAsync(root, Known, { concepts: { operations: { Run: { reads: ['Data'], steps: [{ text: 'Go.', files: ['src/a.ts'] }] } } } })
        assert.equal((await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, Known), await Graph.BuildAsync(opened), 6, 'cli.ts')).mode, 'things')
        await Architecture.UpdateAsync(root, Known, { concepts: { things: { Data: { layer: 'data' } } } })
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
        assert.equal(JSON.parse(out.pop()!).mode, 'candidates')
        const { writeFile } = await import('node:fs/promises')
        await writeFile(join(root, 'patch.json'), JSON.stringify({ concepts: { things: { Data: { layer: 'data' } } } }))
        assert.equal(await RunAsync(['apply', '--file', join(root, 'patch.json'), '--repo', root]), 0)
        assert.deepEqual((await Architecture.ReadAsync(root, Known)).concepts.things, { Data: { layer: 'data' } })
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
        things: { Data: { layer: 'data' }, Loose: { summary: 'Kept somewhere.' } },
        operations: {
            Good: { summary: 'Runs.', reads: ['Data'], writes: [], steps: [{ text: 'Do it.', files: ['src/a.ts'] }] },
            Bare: { summary: 'Not written yet.' },
            Ungrounded: { summary: 'No file evidence.', reads: ['Data'], steps: [{ text: 'Magic.', files: [] }] },
        },
    })
    try
    {
        const architecture = await Architecture.ReadAsync(root, Known)
        assert.deepEqual(ConceptsLeft(architecture), { started: true, operations: 2, things: 1 })
    }
    finally { await removeTemp(root) }

    const empty = await repo()
    try
    {
        const architecture = await Architecture.ReadAsync(empty, Known)
        assert.deepEqual(ConceptsLeft(architecture), { started: false, operations: 0, things: 0 })
    }
    finally { await removeTemp(empty) }
})

test('Discovery works on a C# simulation without HTTP or CLI syntax, surfacing overview, thingCandidates, and handlers', async () =>
{
    const root = await makeRepo({
        'src/Model/WorldState.cs': 'namespace Sim.Model;\npublic class WorldState { public int TickCount; }\n',
        'src/Model/AgentStore.cs': 'namespace Sim.Model;\npublic class AgentStore {}\n',
        'src/Actions/ActionExecutor.cs': 'using Sim.Model;\nnamespace Sim.Actions;\npublic class ActionExecutor { public void Execute(WorldState w) {} }\n',
        'src/Sim/SimulationRunner.cs': 'using Sim.Model;\nusing Sim.Actions;\nnamespace Sim.Core;\npublic class SimulationRunner { public void Tick() {} }\n',
        'tests/SimTests.cs': 'using Sim.Core;\nnamespace Sim.Tests;\npublic class SimTests { public void Run() {} }\n',
        'README.md': '# Sim\n',
        'package-lock.json': '{}\n',
        '.codespace/architecture.json': JSON.stringify({
            layers: ['docs', 'model', 'domain', 'entry', 'tests'],
            systems: {
                sim: { summary: 'Runs the world simulation.' },
                meta: { summary: 'Docs and tests.' },
            },
            folders: {
                'src/Model': { summary: 'Simulation state and stores.' },
                'src/Sim': { summary: 'Simulation loop.' },
            },
            files: {
                'src/Model/WorldState.cs': { system: 'sim', layer: 'model', tags: ['data'], summary: 'Holds the live world state.' },
                'src/Model/AgentStore.cs': { system: 'sim', layer: 'model', tags: ['data'], summary: 'Stores active agents.' },
                'src/Actions/ActionExecutor.cs': { system: 'sim', layer: 'domain', tags: ['core'], summary: 'Applies queued actions to the world.' },
                'src/Sim/SimulationRunner.cs': { system: 'sim', layer: 'entry', tags: ['orchestrate'], summary: 'Advances the simulation one tick at a time.' },
                'tests/SimTests.cs': { system: 'meta', layer: 'tests', tags: ['test'], summary: 'Tests the simulation.' },
                'README.md': { system: 'meta', layer: 'docs', tags: ['config'], summary: 'Readme.' },
                'package-lock.json': { summary: 'Lockfile.' },
            },
        }),
    }, 'codespace-cs-concepts-')
    try
    {
        const opened = await Repo.OpenAsync(root)
        const known = await opened.ListFilesAsync()
        const architecture = await Architecture.ReadAsync(root, known)
        const graph = await Graph.BuildAsync(opened)
        const batch = await ConceptsNextAsync(opened, architecture, graph, 6, 'cli.ts')

        assert.equal(batch.mode, 'candidates')
        assert.equal(batch.overview?.appFileCount, 4, 'excludes tests, docs, and lockfiles')
        assert.deepEqual(batch.overview?.files.map((f) => f.path), [
            'src/Actions/ActionExecutor.cs', 'src/Model/AgentStore.cs', 'src/Model/WorldState.cs', 'src/Sim/SimulationRunner.cs',
        ])
        assert.ok(batch.thingCandidates.some((t) => t.path === 'src/Model/WorldState.cs'), 'flags data state file as thingCandidate')
        assert.ok(batch.thingCandidates.some((t) => t.path === 'src/Model/AgentStore.cs'), 'flags data store file as thingCandidate')
        const candNames = batch.candidates.map((c) => `${c.kind}:${c.name}`)
        assert.ok(candNames.includes('handler:Tick'), 'detects C# Tick loop handler')
        assert.ok(candNames.includes('handler:Execute'), 'detects C# Execute handler')
        assert.ok(candNames.includes('orchestrator:src/Sim/SimulationRunner.cs'), 'detects orchestrator even without entry tag')
        assert.equal(batch.entryFiles[0]?.path, 'src/Sim/SimulationRunner.cs')
        assert.ok(batch.entryFiles[0]?.reaches.includes('src/Model/WorldState.cs'), 'includes transitive reaches cone')
        assert.equal(IsAppFile('tests/SimTests.cs', architecture.files['tests/SimTests.cs']), false)
    }
    finally { await removeTemp(root) }
})

test('Multi-language finders detect Express/FastAPI/CLI routes and cap candidates per file', async () =>
{
    const buttons = Array.from({ length: 15 }, (_, i) => `<button id="btn-${i}">B${i}</button>`).join('\n')
    const root = await makeRepo({
        'public/index.html': `<html><body>${buttons}</body></html>\n`,
        'src/routes.ts': "app.get('/users', list)\napp.post('/orders', create)\nprogram.command('migrate')\n",
        'src/api.py': "@app.post('/webhooks/stripe')\ndef handle(req):\n    pass\n",
        '.codespace/architecture.json': JSON.stringify({
            layers: ['api', 'ui'],
            systems: { web: {} },
            files: {
                'public/index.html': { system: 'web', layer: 'ui', tags: ['ui'], summary: 'Page.' },
                'src/routes.ts': { system: 'web', layer: 'api', tags: ['entry'], summary: 'Routes.' },
                'src/api.py': { system: 'web', layer: 'api', tags: ['entry'], summary: 'Python API.' },
            },
        }),
    }, 'codespace-finders-')
    try
    {
        const opened = await Repo.OpenAsync(root)
        const known = await opened.ListFilesAsync()
        const batch = await ConceptsNextAsync(opened, await Architecture.ReadAsync(root, known), await Graph.BuildAsync(opened), 6, 'cli.ts')
        const byFile = batch.candidates.filter((c) => c.path === 'public/index.html')
        assert.equal(byFile.length, 8, 'caps candidates per file so one HTML page cannot starve the rest')
        const names = batch.candidates.map((c) => `${c.kind}:${c.name}`)
        assert.ok(names.includes('endpoint:/users'))
        assert.ok(names.includes('endpoint:/orders'))
        assert.ok(names.includes('cli command:migrate'))
        assert.ok(names.includes('endpoint:/webhooks/stripe'))
        assert.ok(names.includes('handler:handle'))
    }
    finally { await removeTemp(root) }
})

test('ReviewConcepts blocks on low coverage, uncovered systems, and orphan things, and flags reflexion issues', async () =>
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
                things: {
                    Input: { summary: 'External input.', layer: 'data' },
                    Orphan: { layer: 'data' },
                    alpha: { summary: 'Named after a system.', layer: 'data' },
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
        assert.equal(review.coverage.appFiles, 8)
        assert.equal(review.coverage.coveredFiles, 3)
        assert.deepEqual(review.orphanThings, ['Orphan'])
        assert.deepEqual(review.externalInputs, ['Input'])
        assert.deepEqual(review.finalOutputs, ['alpha'])
        assert.deepEqual(review.coverage.uncoveredSystems.map((s) => s.name), ['beta'])
        assert.equal(review.overlaps.length, 1, 'detects near-duplicate operations')
        assert.ok(review.divergences.some((d) => d.operation === 'DoAlpha' && d.uncoveredImports.some((u) => u.path === 'src/a4.ts')), 'detects uncovered import divergence')
        assert.ok(review.issues.some((i) => /names a file in its text/.test(i)), 'flags file path leaked into step text')
        assert.ok(review.issues.some((i) => /not tied to any step/.test(i)), 'flags unplaced operation file src/a3.ts')
        assert.ok(review.issues.some((i) => /looks like a system/.test(i)), 'flags module-shaped thing name')
        assert.equal(review.blocking.length, 3, 'blocks on orphan thing, uncovered system, and <60% coverage')

        const batch = await ConceptsNextAsync(opened, architecture, graph, 8, 'cli.ts')
        assert.equal(batch.mode, 'review')
        assert.equal(batch.remaining, 3)
        assert.ok(batch.overview !== undefined, 'attaches overview in review mode so uncovered files are visible')

        // Resolving the blocking gaps transitions cleanly to done.
        await Architecture.UpdateAsync(root, known, { concepts: {
            things: { Orphan: null },
            operations: {
                DoAlphaCopy: null,
                DoBeta: {
                    summary: 'Handles beta.',
                    reads: ['Input'],
                    writes: ['alpha'],
                    steps: [
                        { text: 'Start beta processing.', files: ['src/b1.ts', 'src/b2.ts'] },
                        { text: 'Finish beta processing.', files: ['src/b3.ts', 'src/b4.ts'] },
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
