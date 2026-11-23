import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { NormalisePath, OpeningText } from '../src/repo/Create.ts'
import { makeRepo, removeTemp, request, startApi } from './support.ts'

/** A repository with two layers and one system declared, and one file already described. */
function repo(): Promise<string>
{
    return makeRepo({
        'src/a.ts': 'export const a = 1\n',
        '.codespace/architecture.json': JSON.stringify({
            layers: ['model', 'render'], systems: { browser: {} },
            files: { 'src/a.ts': { summary: 'The first value.', system: 'browser', layer: 'model', tags: ['core'] } },
        }),
    }, 'codespace-create-')
}

test('A new file opens with its summary in its own comment syntax', () =>
{
    assert.equal(OpeningText('src/a.ts', 'Draws the city.'), '// Draws the city.\n')
    assert.equal(OpeningText('tools/run.py', 'Runs the batch.'), '# Runs the batch.\n')
    assert.equal(OpeningText('bin/go.sh', 'Starts it.'), '#!/usr/bin/env sh\n# Starts it.\n')
    assert.equal(OpeningText('a.css', 'Looks.'), '/* Looks. */\n')
    assert.equal(OpeningText('a.css', 'Ends */ early.'), '/* Ends * / early. */\n')
    assert.equal(OpeningText('docs/Guide.md', 'How to start.'), '# Guide\n\nHow to start.\n')
    assert.equal(OpeningText('data.json', 'Values.'), '{}\n')
    assert.equal(NormalisePath(' ./src//b.ts '), 'src/b.ts')
    assert.equal(NormalisePath('\\src\\b.ts'), 'src/b.ts')
})

test('Creating a file writes it and its entry together, in a folder made for it', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const made = await request(port, 'POST', '/api/files', { path: 'src/view/City.ts', summary: 'Draws the city.', layer: 'render', system: 'browser', tags: ['ui'] })
        assert.equal(made.status, 200, made.text)
        assert.equal(made.body.path, 'src/view/City.ts')
        assert.equal(await readFile(join(root, 'src/view/City.ts'), 'utf8'), '// Draws the city.\n')
        const written = JSON.parse(await readFile(join(root, '.codespace/architecture.json'), 'utf8'))
        assert.deepEqual(written.files['src/view/City.ts'], { summary: 'Draws the city.', system: 'browser', layer: 'render', tags: ['ui'] })
        const ledger = JSON.parse(await readFile(join(root, '.codespace/ingested.json'), 'utf8'))
        assert.ok(JSON.stringify(ledger).includes('src/view/City.ts'), 'the new file is stamped, so next does not hand it back')
    }
    finally { await stop(); await removeTemp(root) }
})

test('Creating a file never overwrites one, leaves the tree, or keeps a file the architecture refused', async () =>
{
    const root = await repo()
    const { port, stop } = await startApi(root)
    try
    {
        const entry = { summary: 'Something.', layer: 'model', system: 'browser', tags: ['core'] }
        const again = await request(port, 'POST', '/api/files', { ...entry, path: 'src/a.ts' })
        assert.equal(again.status, 400)
        assert.match(again.body.error, /already exists/)
        assert.equal(await readFile(join(root, 'src/a.ts'), 'utf8'), 'export const a = 1\n', 'the old file is untouched')

        assert.equal((await request(port, 'POST', '/api/files', { ...entry, path: '../outside.ts' })).status, 400)
        assert.equal((await request(port, 'POST', '/api/files', { ...entry, path: 'src/notes' })).status, 400)
        assert.equal((await request(port, 'POST', '/api/files', { ...entry, path: 'src/b.ts', summary: ' ' })).status, 400)

        const refused = await request(port, 'POST', '/api/files', { ...entry, path: 'src/c.ts', layer: 'nowhere' })
        assert.equal(refused.status, 400)
        await assert.rejects(stat(join(root, 'src/c.ts')), 'a file whose entry was refused is taken away again')

        // A write from another machine is refused before anything is made.
        const remote = await request(port, 'POST', '/api/files', { ...entry, path: 'src/d.ts' }, { Host: 'example.com' })
        assert.equal(remote.status, 403)
        await assert.rejects(stat(join(root, 'src/d.ts')))
    }
    finally { await stop(); await removeTemp(root) }
})
