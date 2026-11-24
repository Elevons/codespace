import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RunAsync } from '../src/cli/Cli.ts'
import { Architecture } from '../src/repo/Architecture.ts'
import { ConceptsLeft, ConceptsNextAsync } from '../src/repo/Concepts.ts'
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
        },
    })
    try
    {
        const architecture = await Architecture.ReadAsync(root, Known)
        assert.deepEqual(ConceptsLeft(architecture), { started: true, operations: 1, things: 1 })
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
