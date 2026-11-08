import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, rename, rm, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTemp, removeTemp } from './support.ts'
import { Architecture } from '../src/repo/Architecture.ts'
import { Graph } from '../src/repo/Graph.ts'
import { NextBatchAsync, StatusAsync } from '../src/repo/Ingest.ts'
import { Ledger } from '../src/repo/Ledger.ts'
import { Repo } from '../src/repo/Repo.ts'
import { SyncAsync } from '../src/repo/Sync.ts'

/** A described repository: two files, fully described and recorded the way `apply` does. */
async function described(): Promise<{ root: string, repo: Repo }>
{
    const root = await makeTemp('codespace-update-')
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 2\n')
    const repo = await Repo.OpenAsync(root)
    const files = {
        'src/a.ts': { summary: 'A.', system: 'app', layer: 'base', tags: ['core'] },
        'src/b.ts': { summary: 'B.', system: 'app', layer: 'base', tags: ['core'] },
    }
    await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), { layers: ['base'], systems: { app: {} }, files, folders: { src: { summary: 'Source.' } } })
    await Ledger.RecordAsync(repo, Object.keys(files))
    return { root, repo }
}

/** What `next` and `status` say about the repository now. */
async function look(repo: Repo)
{
    const known = await repo.ListFilesAsync()
    const architecture = await Architecture.ReadAsync(repo.Root, known)
    return { status: await StatusAsync(repo, architecture), batch: await NextBatchAsync(repo, architecture, await Graph.BuildAsync(repo), 12) }
}

test('A described repository has nothing to update until a file changes, and then only that file comes back', async () =>
{
    const { root, repo } = await described()
    try
    {
        const before = await look(repo)
        assert.equal(before.status.remaining - before.status.folders, 0)
        assert.deepEqual(before.batch.files, [])

        // Only touching a file changes nothing, since its text is the same; rewriting it does.
        await utimes(join(root, 'src', 'a.ts'), new Date(), new Date(Date.now() + 5000))
        assert.equal((await look(repo)).status.changed, 0)
        await writeFile(join(root, 'src', 'a.ts'), 'export const a = 100 // changed\n')
        const after = await look(repo)
        assert.equal(after.status.changed, 1)
        assert.deepEqual(after.batch.files.map((file) => [file.path, file.reason, file.current.summary]), [['src/a.ts', 'changed', 'A.']])

        // Applying the entry again confirms it against the new text, so it is not offered again.
        await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), { files: { 'src/a.ts': { summary: 'A, still.' } } })
        await Ledger.RecordAsync(repo, ['src/a.ts'])
        assert.equal((await look(repo)).status.changed, 0)
    }
    finally { await removeTemp(root) }
})

test('A file that is moved keeps its entry, and one that is deleted loses its entry, without being described again', async () =>
{
    const { root, repo } = await described()
    try
    {
        await rename(join(root, 'src', 'a.ts'), join(root, 'src', 'renamed.ts'))
        await rm(join(root, 'src', 'b.ts'))
        const stale = await look(repo)
        assert.equal(stale.status.stale, 2)
        assert.deepEqual(stale.batch.files.map((file) => file.path), ['src/renamed.ts'])

        const synced = await SyncAsync(repo)
        assert.deepEqual(synced.renamed, [{ from: 'src/a.ts', to: 'src/renamed.ts' }])
        assert.deepEqual(synced.forgotten, ['src/b.ts'])

        const after = await look(repo)
        assert.deepEqual([after.status.stale, after.status.files, after.status.changed], [0, 0, 0])
        const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
        assert.equal(architecture.files['src/renamed.ts']?.summary, 'A.')
        assert.deepEqual(await Architecture.StaleAsync(repo.Root, await repo.ListFilesAsync()), { files: [], folders: [] })
        assert.deepEqual((await SyncAsync(repo)), { renamed: [], forgotten: [], stamped: 0 })
    }
    finally { await removeTemp(root) }
})

test('A file moved and edited is new, not renamed, and an entry described before there was a record is taken as current', async () =>
{
    const { root, repo } = await described()
    try
    {
        await rename(join(root, 'src', 'a.ts'), join(root, 'src', 'moved.ts'))
        await writeFile(join(root, 'src', 'moved.ts'), 'export const different = true\n')
        const synced = await SyncAsync(repo)
        assert.deepEqual(synced.renamed, [])
        assert.deepEqual(synced.forgotten, ['src/a.ts'])
        assert.deepEqual((await look(repo)).batch.files.map((file) => [file.path, file.reason]), [['src/moved.ts', 'new']])

        // With no record at all, nothing counts as changed, and a sync stamps what is described.
        await rm(join(root, '.codespace', 'ingested.json'))
        assert.equal((await look(repo)).status.changed, 0)
        assert.equal((await SyncAsync(repo)).stamped, 1)
        await writeFile(join(root, 'src', 'b.ts'), 'export const b = 3\n')
        assert.equal((await look(repo)).status.changed, 1)
    }
    finally { await removeTemp(root) }
})

test('Forgetting an entry for a file that is still there is refused', async () =>
{
    const { root, repo } = await described()
    try
    {
        await assert.rejects(Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), { forget: ['src/a.ts'] }), /still in the repository/)
    }
    finally { await removeTemp(root) }
})
