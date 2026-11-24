import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { makeRepo as makeFiles, makeTemp, removeTemp } from './support.ts'
import { join } from 'node:path'
import { Architecture } from '../src/repo/Architecture.ts'
import { Repo } from '../src/repo/Repo.ts'
import { TAG_COLORS, TAG_VOCABULARY } from '../public/tags.ts'

/** Makes a repository holding the given architecture text, or none. */
function makeRepo(architecture: string | null): Promise<string>
{
    return makeFiles({
        'src/a.ts': 'export const a = 1\n',
        'src/b.ts': 'export const b = 1\n',
        ...(architecture === null ? {} : { '.codespace/architecture.json': architecture }),
    }, 'codespace-arch-')
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
    finally { await removeTemp(root) }
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
    finally { await removeTemp(root) }
})

test('Architecture is empty without a file, and says so for a broken one', async () =>
{
    const none = await makeRepo(null)
    const broken = await makeRepo('{ not json')
    const wrongShape = await makeRepo('[1, 2]')
    try
    {
        const absent = await Architecture.ReadAsync(none, ['src/a.ts'])
        assert.deepEqual(absent, { layers: [], systems: {}, files: {}, folders: {}, concepts: { things: {}, operations: {} }, warnings: [], error: '' })
        assert.match((await Architecture.ReadAsync(broken, ['src/a.ts'])).error, /not valid JSON/)
        assert.match((await Architecture.ReadAsync(wrongShape, ['src/a.ts'])).error, /must be a JSON object/)
    }
    finally
    {
        for (const root of [none, broken, wrongShape]) await removeTemp(root)
    }
})

test('Architecture refuses a file that is a link out of the repository', async () =>
{
    const root = await makeRepo(null)
    const outside = await makeTemp('codespace-out-')
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
        await removeTemp(root)
        await removeTemp(outside)
    }
})

test('Architecture refuses to write through a symlinked .codespace folder', async () =>
{
    const root = await makeRepo(null)
    const outside = await makeTemp('codespace-out-')
    try
    {
        await symlink(outside, join(root, '.codespace'))
        await assert.rejects(Architecture.UpdateAsync(root, ['src/a.ts'], { layers: ['base'] }), /link/)
        await assert.rejects(readFile(join(outside, 'architecture.json'), 'utf8'), /ENOENT/)
    }
    finally
    {
        await removeTemp(root)
        await removeTemp(outside)
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
    finally { await removeTemp(root) }
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
    finally { await removeTemp(root) }
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
    finally { await removeTemp(root) }
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
    finally { await removeTemp(root) }
})

test('UpdateAsync refuses a change whose fields have the wrong type, and writes nothing', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base'], systems: {}, files: { 'src/a.ts': { layer: 'base' } } }))
    const known = ['src/a.ts', 'src/b.ts']
    const before = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
    try
    {
        await assert.rejects(Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { summary: 5 } } } as never), /summary must be text/)
        await assert.rejects(Architecture.UpdateAsync(root, known, { systems: { bogus: 'not-an-object' } } as never), /"bogus" must be an object/)
        await assert.rejects(Architecture.UpdateAsync(root, known, { layers: 'base' } as never), /"layers" must be a list/)
        await assert.rejects(Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { tags: [5] } } } as never), /tags must be a list/)
        assert.equal(await readFile(join(root, '.codespace', 'architecture.json'), 'utf8'), before, 'nothing was written')
    }
    finally { await removeTemp(root) }
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
    finally { await removeTemp(root) }

    // With no file at all, the first update makes it.
    const bare = await makeRepo(null)
    try
    {
        await Architecture.UpdateAsync(bare, ['src/a.ts'], { layers: ['base'], files: { 'src/a.ts': { layer: 'base' } } })
        assert.deepEqual((await Architecture.ReadAsync(bare, ['src/a.ts'])).files, { 'src/a.ts': { layer: 'base' } })
    }
    finally { await removeTemp(bare) }
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
    finally { await removeTemp(root) }
})

test('Architecture reads systems, and layers may span them', async () =>
{
    const root = await makeRepo(JSON.stringify({
        layers: ['base', 'ui'],
        systems: { browser: { summary: '  The page.  ' }, server: {} },
        files: {
            'src/a.ts': { system: 'browser', layer: 'ui' },
            'src/b.ts': { system: 'server', layer: 'ui' },
        },
    }))
    try
    {
        const result = await Architecture.ReadAsync(root, ['src/a.ts', 'src/b.ts'])
        assert.deepEqual(result.systems, { browser: { summary: 'The page.' }, server: {} })
        assert.equal(result.files['src/a.ts']!.system, 'browser')
        assert.equal(result.files['src/b.ts']!.system, 'server')
        assert.equal(result.files['src/a.ts']!.layer, result.files['src/b.ts']!.layer, 'one shared layer can hold files from two systems')

        const updated = await Architecture.UpdateAsync(root, ['src/a.ts', 'src/b.ts'], {
            systems: { browser: { summary: null }, tools: {} },
            files: { 'src/a.ts': { system: 'tools' } },
        })
        assert.deepEqual(updated.architecture.systems.browser, {})
        assert.equal(updated.architecture.files['src/a.ts']!.system, 'tools')

        const text = await readFile(join(root, '.codespace', 'architecture.json'), 'utf8')
        assert.match(text, /"systems": \{\n    "browser": \{\},\n    "server": \{\},\n    "tools": \{\}\n  \}/)
    }
    finally { await removeTemp(root) }
})

test('UpdateAsync refuses an undeclared system and removing a system that files still use', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base'], systems: { browser: {} }, files: { 'src/a.ts': { system: 'browser' } } }))
    try
    {
        await assert.rejects(Architecture.UpdateAsync(root, ['src/a.ts', 'src/b.ts'], { files: { 'src/b.ts': { system: 'server' } } }), /system "server" is not in systems/)
        await assert.rejects(Architecture.UpdateAsync(root, ['src/a.ts', 'src/b.ts'], { systems: { browser: null } }), /still in it/)
    }
    finally { await removeTemp(root) }
})

test('UpdateAsync removes a system when the same change moves its files', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: ['base'], systems: { browser: {}, server: {} }, files: { 'src/a.ts': { system: 'browser' } } }))
    const known = ['src/a.ts', 'src/b.ts']
    try
    {
        const updated = await Architecture.UpdateAsync(root, known, {
            systems: { browser: null },
            files: { 'src/a.ts': { system: 'server' } },
        })
        assert.equal('browser' in updated.architecture.systems, false)
        assert.equal(updated.architecture.files['src/a.ts']!.system, 'server')
    }
    finally { await removeTemp(root) }
})

test('An entry for a file that is gone does not block removing its system', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: [], systems: { browser: {} }, files: { 'src/gone.ts': { system: 'browser' }, 'src/a.ts': { summary: 'A.' } } }))
    const known = ['src/a.ts', 'src/b.ts']
    try
    {
        await Architecture.UpdateAsync(root, known, { systems: { browser: null } })
        assert.equal('browser' in (await Architecture.ReadAsync(root, known)).systems, false)
    }
    finally { await removeTemp(root) }
})

test('Architecture warns when a file names a system that is not declared', async () =>
{
    const root = await makeRepo(JSON.stringify({ layers: [], files: { 'src/a.ts': { system: 'ghost' } } }))
    try
    {
        const result = await Architecture.ReadAsync(root, ['src/a.ts', 'src/b.ts'])
        assert.match(result.warnings.join(' '), /is in system "ghost", which "systems" does not list/)
    }
    finally { await removeTemp(root) }
})

test('Architecture warns about malformed systems and keeps the good ones', async () =>
{
    const root = await makeRepo(JSON.stringify({
        layers: [],
        systems: { '': {}, browser: 'nope', server: { summary: 'S.' }, tools: { summary: 3 } },
        files: {},
    }))
    try
    {
        const result = await Architecture.ReadAsync(root, ['src/a.ts', 'src/b.ts'])
        assert.deepEqual(result.systems, { server: { summary: 'S.' }, tools: {} })
        const text = result.warnings.join(' ')
        assert.match(text, /empty name/)
        assert.match(text, /The system "browser" should be an object/)
        assert.match(text, /The system "tools" should have a text summary/)
    }
    finally { await removeTemp(root) }
})

test('The server vocabulary and the browser colours are one ordered set', () =>
{
    assert.deepEqual(Object.keys(TAG_COLORS), [...TAG_VOCABULARY])
    assert.ok(TAG_VOCABULARY.length > 0)
})
