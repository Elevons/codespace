import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { makeRepo as makeFiles, removeTemp } from './support.ts'
import { join } from 'node:path'
import { Architecture } from '../src/repo/Architecture.ts'
import { Graph } from '../src/repo/Graph.ts'
import { NextBatchAsync, SkippedSummary, StatusAsync } from '../src/repo/Ingest.ts'
import { Repo } from '../src/repo/Repo.ts'

/** Makes a repository with a small tree, a lockfile, and a vendored folder. */
function makeRepo(): Promise<string>
{
    return makeFiles({
        'src/a.ts': "import { b } from './b.ts'\nexport const a = b\n",
        'src/b.ts': 'export const b = 1\n',
        'src/deep/c.ts': 'export const c = 1\n',
        'vendor/lib.js': 'module.exports = 1\n',
        'package-lock.json': '{}\n',
    }, 'codespace-ingest-')
}

test('SkippedSummary settles generated and vendored files, and leaves real code alone', () =>
{
    assert.match(SkippedSummary('package-lock.json')!, /npm/)
    assert.match(SkippedSummary('app.min.js')!, /minified/)
    assert.match(SkippedSummary('vendor/lib.js')!, /third-party/)
    assert.equal(SkippedSummary('src/a.ts'), null)
})

test('The first batch is files, with their source and imports, and the generated files settled', async () =>
{
    const root = await makeRepo()
    try
    {
        const repo = await Repo.OpenAsync(root)
        const known = await repo.ListFilesAsync()
        const architecture = await Architecture.ReadAsync(repo.Root, known)
        const graph = await Graph.BuildAsync(repo)
        const batch = await NextBatchAsync(repo, architecture, graph, 12)

        assert.deepEqual(batch.files.map((file) => file.path).sort(), ['src/a.ts', 'src/b.ts', 'src/deep/c.ts'])
        assert.deepEqual(batch.folders, [])
        assert.ok(batch.skipped.some((item) => item.path === 'package-lock.json'))
        assert.equal(batch.remaining, 5)
        assert.deepEqual(batch.layers, [])
        assert.deepEqual(batch.systems, [])
        assert.deepEqual(await StatusAsync(repo, architecture), { files: 3, incomplete: 0, changed: 0, stale: 0, folders: 2, remaining: 5 })

        const a = batch.files.find((file) => file.path === 'src/a.ts')!
        assert.deepEqual(a.missing, ['summary', 'system', 'layer', 'tags'])
        assert.equal(a.reason, 'new')
        assert.deepEqual(a.current, {})
        assert.match(a.source, /export const a/)
        assert.deepEqual(a.imports, ['src/b.ts'])
        assert.deepEqual(a.usedBy, [])
        assert.deepEqual(batch.files.find((file) => file.path === 'src/b.ts')!.usedBy, ['src/a.ts'])
    }
    finally { await removeTemp(root) }
})

test('Once files are summarized, folders come deepest first with their contents described, then nothing', async () =>
{
    const root = await makeRepo()
    try
    {
        const repo = await Repo.OpenAsync(root)

        // A batch settles the generated files it lists, the way the CLI does.
        const take = async () =>
        {
            const listed = await repo.ListFilesAsync()
            const batch = await NextBatchAsync(repo, await Architecture.ReadAsync(repo.Root, listed), await Graph.BuildAsync(repo), 12)
            if (batch.skipped.length > 0) await Architecture.UpdateAsync(repo.Root, listed, { files: Object.fromEntries(batch.skipped.map((item) => [item.path, { summary: item.summary }])) })
            return { batch, known: listed }
        }
        const known = await repo.ListFilesAsync()

        assert.deepEqual((await take()).batch.files.map((file) => file.path), ['src/a.ts', 'src/b.ts', 'src/deep/c.ts'])
        await Architecture.UpdateAsync(repo.Root, known, {
            layers: ['base'],
            systems: { server: { summary: 'The server.' } },
            files: {
                'src/a.ts': { summary: 'A.', system: 'server' },
                'src/b.ts': { summary: 'B.', system: 'server' },
                'src/deep/c.ts': { summary: 'C.', system: 'server' },
            },
        })

        // Summarized but without a layer or tags: the same files come back for a second pass.
        const second = (await take()).batch
        assert.deepEqual(second.files.map((file) => file.path).sort(), ['src/a.ts', 'src/b.ts', 'src/deep/c.ts'])
        assert.deepEqual(second.files[0]!.missing.sort(), ['layer', 'tags'])
        assert.deepEqual(second.layers, ['base'])

        await Architecture.UpdateAsync(repo.Root, known, {
            files: {
                'src/a.ts': { layer: 'base', tags: ['core'] },
                'src/b.ts': { layer: 'base', tags: ['core'] },
                'src/deep/c.ts': { layer: 'base', tags: ['core'] },
            },
        })

        const inner = (await take()).batch
        assert.deepEqual(inner.files, [])
        assert.deepEqual(inner.folders.map((folder) => folder.path).filter((path) => path.startsWith('src')), ['src/deep'])
        assert.deepEqual(inner.folders[0]!.children, [{ path: 'src/deep/c.ts', summary: 'C.' }])

        await Architecture.UpdateAsync(repo.Root, known, { folders: { 'src/deep': { summary: 'Deep helpers.' } } })
        const outer = (await take()).batch
        assert.deepEqual(outer.folders.map((folder) => folder.path).filter((path) => path.startsWith('src')), ['src'])
        assert.deepEqual(outer.folders.find((folder) => folder.path === 'src')!.children, [
            { path: 'src/a.ts', summary: 'A.' },
            { path: 'src/b.ts', summary: 'B.' },
            { path: 'src/deep', summary: 'Deep helpers.' },
        ])

        await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), { folders: { src: { summary: 'The source.' }, '.codespace': { summary: 'Meta.' } } })
        const done = (await take()).batch
        assert.deepEqual([done.files, done.folders.filter((folder) => folder.path.startsWith('src')), done.remaining], [[], [], 0])
    }
    finally { await removeTemp(root) }
})

test('A summarized file with no system comes back as incomplete', async () =>
{
    const root = await makeRepo()
    try
    {
        const repo = await Repo.OpenAsync(root)
        const known = await repo.ListFilesAsync()
        await Architecture.UpdateAsync(root, known, {
            layers: ['base'],
            systems: { server: {} },
            files: { 'src/a.ts': { summary: 'A.', layer: 'base', tags: ['core'] } },
        })

        const architecture = await Architecture.ReadAsync(repo.Root, known)
        assert.deepEqual(await StatusAsync(repo, architecture), { files: 2, incomplete: 1, changed: 0, stale: 0, folders: 3, remaining: 6 })

        const batch = await NextBatchAsync(repo, architecture, await Graph.BuildAsync(repo), 12)
        const a = batch.files.find((file) => file.path === 'src/a.ts')!
        assert.deepEqual(a.missing, ['system'])
        assert.deepEqual(batch.systems, ['server'])
    }
    finally { await removeTemp(root) }
})

test('A file naming a system the architecture does not declare counts as incomplete', async () =>
{
    const root = await makeRepo()
    try
    {
        const repo = await Repo.OpenAsync(root)
        const known = await repo.ListFilesAsync()
        await mkdir(join(root, '.codespace'))
        await writeFile(join(root, '.codespace', 'architecture.json'), JSON.stringify({
            layers: ['base'],
            files: { 'src/a.ts': { summary: 'A.', system: 'ghost', layer: 'base', tags: ['core'] } },
        }))

        const architecture = await Architecture.ReadAsync(repo.Root, known)
        assert.match(architecture.warnings.join(' '), /is in system "ghost", which "systems" does not list/)
        assert.equal((await StatusAsync(repo, architecture)).incomplete, 1)
    }
    finally { await removeTemp(root) }
})

test('A file naming a layer the architecture does not declare counts as incomplete', async () =>
{
    const root = await makeRepo()
    try
    {
        const repo = await Repo.OpenAsync(root)
        const known = await repo.ListFilesAsync()
        await mkdir(join(root, '.codespace'))
        await writeFile(join(root, '.codespace', 'architecture.json'), JSON.stringify({
            layers: ['base'],
            systems: { server: {} },
            files: { 'src/a.ts': { summary: 'A.', system: 'server', layer: 'ghost', tags: ['core'] } },
        }))

        const architecture = await Architecture.ReadAsync(repo.Root, known)
        assert.match(architecture.warnings.join(' '), /is in layer "ghost", which "layers" does not list/)
        assert.deepEqual(Architecture.Lacks(architecture, 'src/a.ts'), ['layer'])
        assert.equal((await StatusAsync(repo, architecture)).incomplete, 1)
    }
    finally { await removeTemp(root) }
})

test('A file longer than the read limit is cut short and marked truncated', async () =>
{
    const root = await makeFiles({ 'src/big.ts': 'x'.repeat(20_001) + '\n', 'src/small.ts': 'export const small = 1\n' }, 'codespace-ingest-big-')
    try
    {
        const repo = await Repo.OpenAsync(root)
        const known = await repo.ListFilesAsync()
        const batch = await NextBatchAsync(repo, await Architecture.ReadAsync(repo.Root, known), await Graph.BuildAsync(repo), 12)
        const big = batch.files.find((file) => file.path === 'src/big.ts')!
        assert.equal(big.truncated, true)
        assert.equal(big.source.length, 20_000)
        assert.equal(batch.files.find((file) => file.path === 'src/small.ts')!.truncated, false)
    }
    finally { await removeTemp(root) }
})
