import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { RunAsync } from '../src/cli/Cli.ts'
import { makeRepo, makeTemp, removeTemp } from './support.ts'

/** Runs one command, capturing what it writes to the console. */
async function run(args: string[]): Promise<{ code: number, out: string, err: string }>
{
    const out: string[] = [], err: string[] = []
    const log = console.log, error = console.error
    console.log = (...parts: unknown[]) => { out.push(parts.join(' ')) }
    console.error = (...parts: unknown[]) => { err.push(parts.join(' ')) }
    try
    {
        const code = await RunAsync(args)
        return { code, out: out.join('\n'), err: err.join('\n') }
    }
    finally
    {
        console.log = log
        console.error = error
    }
}

test('repo names the repository, including with --repo=path', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-cli-repo-')
    try
    {
        const result = await run(['repo', `--repo=${root}`])
        assert.equal(result.code, 0)
        assert.deepEqual(JSON.parse(result.out), { name: root.split('/').pop(), root })
    }
    finally { await removeTemp(root) }
})

test('status counts what is left to describe', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-cli-status-')
    try
    {
        const result = await run(['status', '--repo', root])
        assert.equal(result.code, 0)
        const status = JSON.parse(result.out)
        assert.equal(status.root, root)
        assert.deepEqual({ files: status.files, incomplete: status.incomplete, changed: status.changed, stale: status.stale, folders: status.folders, remaining: status.remaining }, { files: 1, incomplete: 0, changed: 0, stale: 0, folders: 1, remaining: 2 })
    }
    finally { await removeTemp(root) }
})

test('next clamps --size between 1 and 40, and settles generated files for the agent', async () =>
{
    const files: Record<string, string> = { 'package-lock.json': '{}\n' }
    for (let i = 0; i < 45; i++) files[`src/f${i}.ts`] = `export const f${i} = ${i}\n`
    const root = await makeRepo(files, 'codespace-cli-next-')
    try
    {
        const many = await run(['next', '--size', '100', `--repo=${root}`])
        assert.equal(many.code, 0)
        const batch = JSON.parse(many.out)
        assert.equal(batch.files.length, 40, 'a size over 40 is cut to 40')
        assert.ok(batch.skipped.some((item: { path: string }) => item.path === 'package-lock.json'))

        // The generated file was written into the architecture file, so a later run does not hand it back.
        const architecture = JSON.parse(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'))
        assert.ok(architecture.files['package-lock.json'].summary)

        const one = JSON.parse((await run(['next', '--size', '-5', '--repo', root])).out)
        assert.equal(one.files.length, 1, 'a size under 1 is raised to 1')
        const three = JSON.parse((await run(['next', '--size=3', '--repo', root])).out)
        assert.equal(three.files.length, 3)
    }
    finally { await removeTemp(root) }
})

test('sync reports the housekeeping it did', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-cli-sync-')
    try
    {
        const result = await run(['sync', '--repo', root])
        assert.equal(result.code, 0)
        assert.deepEqual(JSON.parse(result.out), { ok: true, renamed: [], forgotten: [], stamped: 0 })
    }
    finally { await removeTemp(root) }
})

test('install leaves the upkeep rules in the repository', async () =>
{
    const root = await makeRepo({}, 'codespace-cli-install-')
    try
    {
        const result = await run(['install', '--repo', root])
        assert.equal(result.code, 0)
        assert.deepEqual(JSON.parse(result.out), { ok: true, instructions: 'AGENTS.md', note: 'created', guide: '.codespace/README.md' })
        assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /codespace:start/)
    }
    finally { await removeTemp(root) }
})

test('apply writes a valid batch, and refuses a malformed one', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-cli-apply-')
    const batchDir = await makeTemp('codespace-cli-batch-')
    try
    {
        const valid = join(batchDir, 'valid.json')
        await writeFile(valid, JSON.stringify({
            layers: ['base'],
            systems: { app: {} },
            files: { 'src/a.ts': { summary: 'A.', system: 'app', layer: 'base', tags: ['core'] } },
        }))
        const applied = await run(['apply', '--file', valid, '--repo', root])
        assert.equal(applied.code, 0)
        assert.equal(JSON.parse(applied.out).ok, true)
        const architecture = JSON.parse(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'))
        assert.equal(architecture.files['src/a.ts'].summary, 'A.')

        // The applied file is stamped in the ledger, so an edit comes back as changed, not new.
        assert.ok(JSON.parse(await readFile(join(root, '.codespace', 'ingested.json'), 'utf8')).files['src/a.ts'], 'the ledger records the applied file')
        await writeFile(join(root, 'src/a.ts'), 'export const a = 2\n')
        const changed = JSON.parse((await run(['next', '--repo', root])).out)
        assert.deepEqual(changed.files.map((file: { path: string, reason: string }) => [file.path, file.reason]), [['src/a.ts', 'changed']])

        const broken = join(batchDir, 'broken.json')
        await writeFile(broken, '{ not json')
        const malformed = await run(['apply', '--file', broken, '--repo', root])
        assert.equal(malformed.code, 1)
        assert.ok(malformed.err.length > 0)

        const list = join(batchDir, 'list.json')
        await writeFile(list, '[]')
        const wrongShape = await run(['apply', '--file', list, '--repo', root])
        assert.equal(wrongShape.code, 1)
        assert.match(wrongShape.err, /JSON object/)

        const missing = await run(['apply', '--repo', root])
        assert.equal(missing.code, 1)
        assert.match(missing.err, /apply needs --file/)
    }
    finally { await removeTemp(root, batchDir) }
})

test('next carries entries along with moved files and drops those for deleted ones', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n', 'src/b.ts': 'export const b = 2\n' }, 'codespace-cli-sync-wiring-')
    const batchDir = await makeTemp('codespace-cli-sync-batch-')
    try
    {
        const batch = join(batchDir, 'batch.json')
        await writeFile(batch, JSON.stringify({
            layers: ['base'],
            systems: { app: {} },
            files: {
                'src/a.ts': { summary: 'A.', system: 'app', layer: 'base', tags: ['core'] },
                'src/b.ts': { summary: 'B.', system: 'app', layer: 'base', tags: ['core'] },
            },
        }))
        assert.equal((await run(['apply', '--file', batch, '--repo', root])).code, 0)

        await rename(join(root, 'src', 'a.ts'), join(root, 'src', 'c.ts'))
        await rm(join(root, 'src', 'b.ts'))

        // next syncs before it reads, so the moved entry follows its text and the deleted one is gone.
        const next = JSON.parse((await run(['next', '--repo', root])).out)
        assert.deepEqual(next.files, [], 'neither the moved file nor the deleted one is handed back as new')

        const architecture = JSON.parse(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'))
        assert.equal(architecture.files['src/c.ts'].summary, 'A.')
        assert.equal('src/a.ts' in architecture.files, false)
        assert.equal('src/b.ts' in architecture.files, false)

        const ledger = JSON.parse(await readFile(join(root, '.codespace', 'ingested.json'), 'utf8'))
        assert.ok(ledger.files['src/c.ts'])
        assert.equal('src/a.ts' in ledger.files, false)
        assert.equal('src/b.ts' in ledger.files, false)
    }
    finally { await removeTemp(root, batchDir) }
})

test('refine reports the second pass and an unknown command exits with 1', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-cli-refine-')
    try
    {
        const result = await run(['refine', '--repo', root])
        assert.equal(result.code, 0)
        const report = JSON.parse(result.out)
        assert.equal(report.root, root)
        assert.equal(typeof report.remaining, 'number')
        assert.ok(Array.isArray(report.breaks))

        const unknown = await run(['jump', '--repo', root])
        assert.equal(unknown.code, 1)
        assert.match(unknown.err, /Unknown command "jump"/)
    }
    finally { await removeTemp(root) }
})
