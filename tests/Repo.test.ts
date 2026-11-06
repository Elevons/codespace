import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Repo } from '../src/repo/Repo.ts'

test('Repo lists readable files and refuses a path outside the repository', async () =>
{
    // First we make a small repository with one readable file and one ignored folder.
    const root = await mkdtemp(join(tmpdir(), 'codespace-'))
    try
    {
        await mkdir(join(root, 'src'))
        await mkdir(join(root, 'node_modules'))
        await writeFile(join(root, 'src', 'Foo.ts'), 'export const foo = 1\n')
        await writeFile(join(root, 'node_modules', 'Skip.ts'), 'export const skip = 1\n')

        // Then we open it and check what it will read.
        const repo = await Repo.OpenAsync(root)
        assert.deepEqual(await repo.ListFilesAsync(), ['src/Foo.ts'])
        assert.equal(repo.IsAllowed('src/Foo.ts'), true)
        assert.equal(repo.IsAllowed('node_modules/Skip.ts'), false)
        assert.equal(repo.IsAllowed('../outside.ts'), false)

        // Finally we check that a refused read does not touch the disk.
        await assert.rejects(repo.ReadFileAsync('../outside.ts'), /Forbidden/)
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
    }
})

test('Repo refuses to read a symlink that points outside the repository', async () =>
{
    // First we make a repository holding a symlink to a file in a different folder.
    const root = await mkdtemp(join(tmpdir(), 'codespace-'))
    const outside = await mkdtemp(join(tmpdir(), 'codespace-out-'))
    try
    {
        await writeFile(join(outside, 'secret.ts'), 'export const secret = 1\n')
        await symlink(join(outside, 'secret.ts'), join(root, 'leak.ts'))

        // Then we ask for the link by name: its real path leaves the repository, so it is refused.
        const repo = await Repo.OpenAsync(root)
        assert.equal(repo.IsAllowed('leak.ts'), true)
        await assert.rejects(repo.ReadFileAsync('leak.ts'), /Forbidden/)
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
    }
})

test('Repo follows the repository .gitignore, so it shows what git keeps', async () =>
{
    // First we make a repository whose .gitignore hides one folder and not another.
    const root = await mkdtemp(join(tmpdir(), 'codespace-'))
    try
    {
        await mkdir(join(root, 'packages'))
        await mkdir(join(root, 'dist'))
        await writeFile(join(root, 'packages', 'Foo.ts'), 'export const foo = 1\n')
        await writeFile(join(root, 'dist', 'Bar.ts'), 'export const bar = 1\n')
        await writeFile(join(root, '.gitignore'), 'dist/\n')

        // Then we open it: the ignored folder is skipped, the tracked one is listed.
        const repo = await Repo.OpenAsync(root)
        assert.deepEqual(await repo.ListFilesAsync(), ['packages/Foo.ts'])
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
    }
})

test('Repo treats a gitignore "**/" as zero or more folders, like git', async () =>
{
    // First we make a repository that hides node_modules under dev with a "**/" rule.
    const root = await mkdtemp(join(tmpdir(), 'codespace-'))
    try
    {
        await mkdir(join(root, 'dev', 'node_modules'), { recursive: true })
        await mkdir(join(root, 'dev', 'src'), { recursive: true })
        await writeFile(join(root, 'dev', 'node_modules', 'Skip.ts'), 'export const skip = 1\n')
        await writeFile(join(root, 'dev', 'src', 'Keep.ts'), 'export const keep = 1\n')
        await writeFile(join(root, '.gitignore'), '/dev/**/node_modules/\n')

        // Then we open it: the immediate child node_modules is hidden, its sibling is kept.
        const repo = await Repo.OpenAsync(root)
        assert.deepEqual(await repo.ListFilesAsync(), ['dev/src/Keep.ts'])
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
    }
})

test('Repo fingerprints its files and notices a change', async () =>
{
    // First we make a repository with one readable file.
    const root = await mkdtemp(join(tmpdir(), 'codespace-'))
    try
    {
        await writeFile(join(root, 'a.ts'), 'export const a = 1\n')
        const repo = await Repo.OpenAsync(root)

        // Then we check the stamp is steady while nothing changes...
        const first = await repo.FingerprintAsync()
        assert.equal(await repo.FingerprintAsync(), first)

        // ...and moves when a file does.
        await writeFile(join(root, 'a.ts'), 'export const a = 2\nexport const b = 3\n')
        assert.notEqual(await repo.FingerprintAsync(), first)
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
    }
})
