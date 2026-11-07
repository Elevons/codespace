import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Graph } from '../src/repo/Graph.ts'
import { Repo } from '../src/repo/Repo.ts'
import { Snapshot } from '../src/repo/Snapshot.ts'
import { makeTemp, removeTemp } from './support.ts'

test('Snapshot reads lines, declarations, and imports once, and reuses them until a file changes', async () =>
{
    const root = await makeTemp('codespace-snapshot-')
    try
    {
        await mkdir(join(root, 'src'))
        await writeFile(join(root, 'src', 'a.ts'), "import { b } from './b.ts'\nexport function a() { return b }\n")
        await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1\n')
        await writeFile(join(root, 'notes.md'), '# notes\n')
        const repo = await Repo.OpenAsync(root)

        const first = await Snapshot.ReadAsync(repo)
        assert.deepEqual(first.files, ['notes.md', 'src/a.ts', 'src/b.ts'])
        assert.deepEqual(first.edges, [['src/a.ts', 'src/b.ts']])
        assert.equal(first.lines['src/a.ts'], 3)
        assert.deepEqual(first.symbols['src/a.ts'], ['a'])
        assert.deepEqual(first.symbols['src/b.ts'], ['b'])
        // A file that declares nothing is left out of the symbols, but still has a line count.
        assert.equal(first.symbols['notes.md'], undefined)
        assert.equal(first.lines['notes.md'], 2)

        // Nothing moved, so the same read comes back.
        assert.equal(await Snapshot.ReadAsync(repo), first)

        // A changed file is read again.
        await writeFile(join(root, 'src', 'b.ts'), 'export const b = 1\nexport const c = 2\n')
        await utimes(join(root, 'src', 'b.ts'), new Date(), new Date(Date.now() + 5000))
        const second = await Snapshot.ReadAsync(repo)
        assert.notEqual(second.fingerprint, first.fingerprint)
        assert.deepEqual(second.symbols['src/b.ts'], ['b', 'c'])
    }
    finally { await removeTemp(root) }
})

test('Graph narrows imports to the ones touching a folder', () =>
{
    const edges: Array<[string, string]> = [['src/a.ts', 'lib/b.ts'], ['docs/x.md', 'docs/y.md']]
    assert.deepEqual(Graph.EdgesUnder(edges, 'lib'), [['src/a.ts', 'lib/b.ts']])
    assert.deepEqual(Graph.EdgesUnder(edges, 'lib/'), [['src/a.ts', 'lib/b.ts']])
    assert.deepEqual(Graph.EdgesUnder(edges), edges)
})

test('The page loads the Babylon version that is installed', async () =>
{
    const html = await readFile(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8')
    const installed = JSON.parse(await readFile(join(import.meta.dirname, '..', 'node_modules', 'babylonjs', 'package.json'), 'utf8')).version
    assert.ok(html.includes(`/vendor/babylon-${installed}.js`), `index.html must load /vendor/babylon-${installed}.js`)
})
