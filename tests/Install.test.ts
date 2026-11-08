import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeTemp, removeTemp } from './support.ts'
import { InstallAsync } from '../src/repo/Install.ts'
import { Repo } from '../src/repo/Repo.ts'

/** Reads a repository file's text. */
const read = (root: string, path: string): Promise<string> => readFile(join(root, path), 'utf8')

test('A repository with no instruction file gets an AGENTS.md with the note, and the rules beside the architecture file', async () =>
{
    const root = await makeTemp('codespace-install-')
    try
    {
        const result = await InstallAsync((await Repo.OpenAsync(root)).Root)
        assert.deepEqual(result, { instructions: 'AGENTS.md', note: 'created', guide: '.codespace/README.md' })
        assert.match(await read(root, 'AGENTS.md'), /<!-- codespace:start -->[\s\S]*\.codespace\/architecture\.json[\s\S]*<!-- codespace:end -->/)
        assert.match(await read(root, '.codespace/README.md'), /Keeping the Codespace map true/)
        assert.equal(await read(root, '.codespace/.gitignore'), 'ingested.json\n')
    }
    finally { await removeTemp(root) }
})

test('The note is added after what an existing file says, and only its own block changes on a second run', async () =>
{
    const root = await makeTemp('codespace-install-')
    try
    {
        await writeFile(join(root, 'CLAUDE.md'), '# Mine\n\nBuild with make.\n')
        const repo = await Repo.OpenAsync(root)
        assert.equal((await InstallAsync(repo.Root)).note, 'added')
        const once = await read(root, 'CLAUDE.md')
        assert.ok(once.startsWith('# Mine\n\nBuild with make.\n'))
        assert.ok(!(await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => '')), 'it chose CLAUDE.md, the file the repository has')

        // Running again changes nothing; an edit outside the block, or a stale block, is handled.
        assert.equal((await InstallAsync(repo.Root)).note, 'unchanged')
        await writeFile(join(root, 'CLAUDE.md'), once.replace('Build with make.', 'Build with ninja.').replace('Keep it true', 'Keep it somewhat true'))
        assert.equal((await InstallAsync(repo.Root)).note, 'updated')
        const twice = await read(root, 'CLAUDE.md')
        assert.match(twice, /Build with ninja\./)
        assert.equal(twice.match(/codespace:start/g)!.length, 1)
        assert.match(twice, /Keep it true as you work/)
    }
    finally { await removeTemp(root) }
})

test('AGENTS.md wins over CLAUDE.md, and a link that leads out of the repository is never written through', async () =>
{
    const root = await makeTemp('codespace-install-')
    const outside = await makeTemp('codespace-outside-')
    try
    {
        await writeFile(join(root, 'AGENTS.md'), '# Agents\n')
        await writeFile(join(root, 'CLAUDE.md'), '# Claude\n')
        const repo = await Repo.OpenAsync(root)
        assert.equal((await InstallAsync(repo.Root)).instructions, 'AGENTS.md')
        assert.doesNotMatch(await read(root, 'CLAUDE.md'), /codespace/)

        await writeFile(join(outside, 'target.md'), '# Not yours\n')
        await mkdir(join(root, 'sub'))
        await removeTemp(join(root, 'AGENTS.md')).catch(() => {})
        await symlink(join(outside, 'target.md'), join(root, 'AGENTS.md'))
        await assert.rejects(InstallAsync(repo.Root), /outside the repository/)
        assert.equal(await readFile(join(outside, 'target.md'), 'utf8'), '# Not yours\n')
    }
    finally { await removeTemp(root); await removeTemp(outside) }
})
