import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Architecture } from '../src/repo/Architecture.ts'
import { Repo } from '../src/repo/Repo.ts'

/** Makes a repository holding the given architecture text, or none. */
async function makeRepo(architecture: string | null): Promise<string>
{
    const root = await mkdtemp(join(tmpdir(), 'codespace-arch-'))
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'a.ts'), 'export const a = 1\n')
    await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1\n')
    if (architecture !== null)
    {
        await mkdir(join(root, '.codespace'))
        await writeFile(join(root, '.codespace', 'architecture.json'), architecture)
    }
    return root
}

test('Architecture reads layers, tags, and summaries, and trims what it keeps', async () =>
{
    const root = await makeRepo(JSON.stringify({
        layers: ['base', 'ui', 'base', ' '],
        files: {
            'src/a.ts': { layer: 'base', tags: ['core', ' io ', 3], summary: '  Does a.  ' },
            'src/b.ts': { layer: 'ui' },
        },
    }))
    try
    {
        const result = await Architecture.ReadAsync((await Repo.OpenAsync(root)).Root, ['src/a.ts', 'src/b.ts'])
        assert.deepEqual(result.layers, ['base', 'ui'])
        assert.deepEqual(result.files['src/a.ts'], { layer: 'base', tags: ['core', 'io'], summary: 'Does a.' })
        assert.deepEqual(result.files['src/b.ts'], { layer: 'ui' })
        assert.equal(result.error, '')

        // The file is part of the repository, so the map lists it like any other.
        assert.deepEqual(await (await Repo.OpenAsync(root)).ListFilesAsync(), ['.codespace/architecture.json', 'src/a.ts', 'src/b.ts'])
        assert.equal(result.warnings.length, 2, 'a repeated layer and a blank one are each reported')
    }
    finally { await rm(root, { recursive: true, force: true }) }
})

test('Architecture reports problems without failing: stale paths, unknown layers, bad shapes', async () =>
{
    const root = await makeRepo(JSON.stringify({
        layers: ['base'],
        files: { 'src/gone.ts': { layer: 'base' }, 'src/a.ts': { layer: 'viz', tags: 'core' }, 'src/b.ts': 'nope' },
    }))
    try
    {
        const result = await Architecture.ReadAsync((await Repo.OpenAsync(root)).Root, ['src/a.ts', 'src/b.ts'])
        assert.deepEqual(Object.keys(result.files), ['src/a.ts'])
        const text = result.warnings.join('\n')
        assert.match(text, /"src\/gone\.ts" is not a file/)
        assert.match(text, /layer "viz", which "layers" does not list/)
        assert.match(text, /tags should be a list/)
        assert.match(text, /entry for "src\/b\.ts" should be an object/)
    }
    finally { await rm(root, { recursive: true, force: true }) }
})

test('Architecture is empty without a file, and says so for a broken one', async () =>
{
    const none = await makeRepo(null)
    const broken = await makeRepo('{ not json')
    const wrongShape = await makeRepo('[1, 2]')
    try
    {
        const absent = await Architecture.ReadAsync(none, ['src/a.ts'])
        assert.deepEqual(absent, { layers: [], files: {}, folders: {}, warnings: [], error: '' })
        assert.match((await Architecture.ReadAsync(broken, ['src/a.ts'])).error, /not valid JSON/)
        assert.match((await Architecture.ReadAsync(wrongShape, ['src/a.ts'])).error, /must be a JSON object/)
    }
    finally
    {
        for (const root of [none, broken, wrongShape]) await rm(root, { recursive: true, force: true })
    }
})

test('Architecture refuses a file that is a link out of the repository', async () =>
{
    const root = await makeRepo(null)
    const outside = await mkdtemp(join(tmpdir(), 'codespace-out-'))
    try
    {
        await writeFile(join(outside, 'elsewhere.json'), JSON.stringify({ layers: ['x'] }))
        await mkdir(join(root, '.codespace'))
        await symlink(join(outside, 'elsewhere.json'), join(root, '.codespace', 'architecture.json'))
        const repo = await Repo.OpenAsync(root)
        const result = await Architecture.ReadAsync(repo.Root, ['src/a.ts'])
        assert.deepEqual(result.layers, [])
        assert.match(result.error, /outside the repository/)
    }
    finally
    {
        await rm(root, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
    }
})

test('Architecture reads folder summaries, and reports folders that are not there', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: [], files: {}, folders: { src: { summary: '  The source.  ' }, 'src/gone': { summary: 'Nowhere.' }, lib: {} } }))
    const known = ['src/a.ts', 'src/b.ts', 'lib/x.ts']
    try
    {
        const result = await Architecture.ReadAsync(root, known)
        assert.deepEqual(result.folders, { src: 'The source.' })
        assert.match(result.warnings.join(' '), /"src\/gone" is not a folder/)
        assert.match(result.warnings.join(' '), /folder "lib" should have a summary/)
    }
    finally { await rm(root, { recursive: true, force: true }) }
})

test('UpdateAsync writes folder summaries, and clearing one removes it', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: [], files: { 'src/a.ts': { summary: 'Does a.' } } }))
    const known = ['src/a.ts', 'src/b.ts']
    try
    {
        await Architecture.UpdateAsync(root, known, { folders: { src: { summary: 'The source.' } } })
        assert.deepEqual((await Architecture.ReadAsync(root, known)).folders, { src: 'The source.' })
        const text = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
        assert.match(text, /"folders": \{\n    "src": \{\n      "summary": "The source."\n    \}\n  \}/)

        await assert.rejects(Architecture.UpdateAsync(root, known, { folders: { ghost: { summary: 'x' } } }), /is not a folder/)
        await Architecture.UpdateAsync(root, known, { folders: { src: { summary: null } } })
        assert.deepEqual((await Architecture.ReadAsync(root, known)).folders, {})
    }
    finally { await rm(root, { recursive: true, force: true }) }
})

test('UpdateAsync moves a file to a layer, edits fields, and writes the file in a stable format', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base', 'ui'], files: { 'src/a.ts': { layer: 'base', tags: ['core'], summary: 'Does a.' } }, notes: { keep: 'me' } }))
    const known = ['src/a.ts', 'src/b.ts']
    try
    {
        // Setting a layer, clearing a field with null, and adding an entry for a file that had none.
        const result = await Architecture.UpdateAsync(root, known, {
            files: { 'src/a.ts': { layer: 'ui', summary: null }, 'src/b.ts': { layer: 'base', tags: ['io', 'weird'] } },
        })
        assert.deepEqual(result.architecture.files['src/a.ts'], { layer: 'ui', tags: ['core'] })
        assert.deepEqual(result.architecture.files['src/b.ts'], { layer: 'base', tags: ['io', 'weird'] })
        assert.match(result.notes.join(' '), /"weird" is not in the vocabulary/)

        // The file is written whole and by hand-style: tags on one line, other top-level fields kept.
        const text = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
        assert.match(text, /"tags": \["io", "weird"\]/)
        assert.deepEqual(JSON.parse(text).notes, { keep: 'me' })

        // Clearing the last field of an entry removes the entry; a new layer list replaces the old.
        await Architecture.UpdateAsync(root, known, { files: { 'src/b.ts': { layer: null, tags: null } }, layers: ['ui', 'base', 'extra'] })
        const after = await Architecture.ReadAsync(root, known)
        assert.equal('src/b.ts' in after.files, false)
        assert.deepEqual(after.layers, ['ui', 'base', 'extra'])
    }
    finally { await rm(root, { recursive: true, force: true }) }
})

test('UpdateAsync is all or nothing, and reports every problem', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base'], files: { 'src/a.ts': { layer: 'base' } } }))
    const known = ['src/a.ts', 'src/b.ts']
    const before = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
    try
    {
        await assert.rejects(Architecture.UpdateAsync(root, known, {
            files: { 'src/b.ts': { layer: 'nowhere' }, 'src/ghost.ts': { summary: 'x' }, 'src/a.ts': { tags: [''] } },
        }), (error: Error) =>
            /layer "nowhere" is not in layers/.test(error.message) && /"src\/ghost\.ts" is not a file/.test(error.message) && /tags must be a list/.test(error.message))
        await assert.rejects(Architecture.UpdateAsync(root, known, { layers: ['a', 'a'] }), /unique/)
        assert.equal(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), before, 'nothing was written')

        // A file that cannot be understood is never overwritten.
        await writeFile(join(root, '.codespace', 'architecture.json'), '{ broken')
        await assert.rejects(Architecture.UpdateAsync(root, known, { layers: ['x'] }), /cannot be changed until it is fixed/)
        assert.equal(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), '{ broken')
    }
    finally { await rm(root, { recursive: true, force: true }) }
})

test('UpdateAsync renames an entry to follow a moved file, and creates the file when there is none', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base'], files: { 'src/old.ts': { layer: 'base', summary: 'Moved.' }, 'src/a.ts': { layer: 'base' } } }))
    const known = ['src/a.ts', 'src/b.ts']
    try
    {
        await assert.rejects(Architecture.UpdateAsync(root, known, { renames: [{ from: 'src/old.ts', to: 'src/a.ts' }] }), /already has an entry/)
        await assert.rejects(Architecture.UpdateAsync(root, known, { renames: [{ from: 'src/old.ts', to: 'src/nowhere.ts' }] }), /not a file in the repository/)
        await Architecture.UpdateAsync(root, known, { renames: [{ from: 'src/old.ts', to: 'src/b.ts' }] })
        const after = await Architecture.ReadAsync(root, known)
        assert.deepEqual(after.files['src/b.ts'], { layer: 'base', summary: 'Moved.' })
        assert.deepEqual(after.warnings, [])
    }
    finally { await rm(root, { recursive: true, force: true }) }

    // With no file at all, the first update makes it.
    const bare = await makeRepo(null)
    try
    {
        await Architecture.UpdateAsync(bare, ['src/a.ts'], { layers: ['base'], files: { 'src/a.ts': { layer: 'base' } } })
        assert.deepEqual((await Architecture.ReadAsync(bare, ['src/a.ts'])).files, { 'src/a.ts': { layer: 'base' } })
    }
    finally { await rm(bare, { recursive: true, force: true }) }
})

test('UpdateAsync keeps simultaneous changes from overwriting each other', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base'], files: {} }))
    const known = ['src/a.ts', 'src/b.ts']
    try
    {
        await Promise.all([
            Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { layer: 'base' } } }),
            Architecture.UpdateAsync(root, known, { files: { 'src/b.ts': { layer: 'base' } } }),
        ])
        assert.deepEqual(Object.keys((await Architecture.ReadAsync(root, known)).files).sort(), ['src/a.ts', 'src/b.ts'])
    }
    finally { await rm(root, { recursive: true, force: true }) }
})
