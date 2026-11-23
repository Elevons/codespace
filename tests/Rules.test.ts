import { test } from 'node:test'
import assert from 'node:assert/strict'
import { folderColor, folderOf, isFileVisible, labelFor, layerRank, nodeMatchesFilters, rayBox, subtreeIndices } from '../public/rules.ts'

test('folderOf names the folder a path lives in, and nothing for the root', () =>
{
    assert.equal(folderOf('src/deep/a.ts'), 'src/deep')
    assert.equal(folderOf('src/a.ts'), 'src')
    assert.equal(folderOf('README.md'), '')
})

test('labelFor turns a layer name into words', () =>
{
    assert.equal(labelFor('data-layer'), 'data layer')
    assert.equal(labelFor('the_layer'), 'the layer')
    assert.equal(labelFor('api'), 'api')
})

test('folderColor is steady for one folder and differs between folders', () =>
{
    assert.match(folderColor('src/a.ts'), /^#[0-9a-f]{6}$/)
    assert.equal(folderColor('src/a.ts'), folderColor('src/b.ts'))
    assert.equal(folderColor('README.md'), folderColor('package.json'))
    assert.notEqual(folderColor('src/a.ts'), folderColor('tests/a.ts'))
})

test('layerRank is the layer place among the drawn layers, or -1', () =>
{
    assert.equal(layerRank('repo', ['config', 'repo', 'api']), 1)
    assert.equal(layerRank('config', ['config', 'repo', 'api']), 0)
    assert.equal(layerRank('gone', ['config', 'repo', 'api']), -1)
})

test('isFileVisible follows a file eye, then its folders, then the extras toggle', () =>
{
    const state = {
        shownFiles: new Set(['src/deep/hidden.ts']),
        hiddenFiles: new Set(['src/hidden.ts', 'src/deep/hidden.ts']),
        hiddenFolders: new Set(['src/deep']),
        extrasShown: true,
        hiddenByExtras: (folder: string) => folder === 'tests',
    }
    assert.equal(isFileVisible('src/a.ts', state), true)
    assert.equal(isFileVisible('src/hidden.ts', state), false)
    assert.equal(isFileVisible('src/deep/a.ts', state), false)
    // The file's own eye wins over its folder's.
    assert.equal(isFileVisible('src/deep/hidden.ts', state), true)
    assert.equal(isFileVisible('tests/a.test.ts', state), false)

    const tight = { ...state, extrasShown: false }
    assert.equal(isFileVisible('README.md', tight), false)
    assert.equal(isFileVisible('src/a.ts', tight), true)
})

test('nodeMatchesFilters is true when any file in the folder passes', () =>
{
    const matches = (path: string): boolean => path === 'src/b.ts'
    assert.equal(nodeMatchesFilters(['src/a.ts', 'src/b.ts'], matches), true)
    assert.equal(nodeMatchesFilters(['src/a.ts'], matches), false)
    assert.equal(nodeMatchesFilters([], matches), false)
})

/** A point or direction, as the ray rules read it. */
const v = (x: number, y: number, z: number) => ({ x, y, z })

/** A unit box centred on the origin. */
const unit = (o: { x: number, y: number, z: number }, d: { x: number, y: number, z: number }) => rayBox(o, d, -1, 1, -1, 1, -1, 1)

test('rayBox returns the distance where a ray enters a box', () =>
{
    assert.equal(unit(v(0, 0, -5), v(0, 0, 1)), 4)
    assert.equal(unit(v(-5, 0, 0), v(1, 0, 0)), 4)
    assert.equal(unit(v(0, -5, 0), v(0, 1, 0)), 4)
})

test('rayBox misses a box the ray does not cross', () =>
{
    assert.equal(unit(v(5, 0, -5), v(0, 0, 1)), null)
    assert.equal(unit(v(0, 5, 0), v(1, 0, 0)), null)
    assert.equal(unit(v(0, 0, 5), v(1, 0, 0)), null)
})

test('rayBox handles rays parallel to an axis', () =>
{
    // Parallel to x and inside the y and z slabs: it enters through the x slab.
    assert.equal(unit(v(-5, 0.5, 0), v(1, 0, 0)), 4)
    // Parallel to an axis and outside another slab: it never enters.
    assert.equal(unit(v(-5, 2, 0), v(1, 0, 0)), null)
})

test('rayBox ignores a box behind the origin', () =>
{
    assert.equal(rayBox(v(0, 0, 0), v(0, 0, 1), -1, 1, -1, 1, -10, -8), null)
    assert.equal(rayBox(v(0, 0, 0), v(1, 0, 0), -10, -8, -1, 1, -1, 1), null)
})

test('rayBox reports an origin inside the box without failing', () =>
{
    const inside = unit(v(0, 0, 0), v(0, 0, 1))
    assert.equal(inside, -1)
})

test('rayBox orders hits, so a caller can take the nearest box', () =>
{
    const near = rayBox(v(0, 0, 0), v(0, 0, 1), -1, 1, -1, 1, 1, 3)!
    const far = rayBox(v(0, 0, 0), v(0, 0, 1), -1, 1, -1, 1, 5, 7)!
    assert.equal(near, 1)
    assert.equal(far, 5)
    assert.equal(Math.min(near, far), near)
})

test('An extras folder re-shown by its eye is hidden again when Extras is turned off', () =>
{
    const extras = new Set(['tests'])
    const reShown = new Set<string>()
    const state = {
        shownFiles: new Set<string>(),
        hiddenFiles: new Set<string>(),
        hiddenFolders: new Set<string>(),
        extrasShown: false,
        hiddenByExtras: (folder: string) => !state.extrasShown && extras.has(folder) && !reShown.has(folder),
    }
    // The folder-eye path re-shows an extras folder by putting it in this set.
    reShown.add('tests')
    assert.equal(isFileVisible('tests/a.test.ts', state), true)

    // Turning Extras off clears what the eye brought back, so the folder is hidden again.
    reShown.clear()
    assert.equal(isFileVisible('tests/a.test.ts', state), false)
    assert.equal(isFileVisible('docs/a.md', state), true, 'a folder that is not an extra stays visible')
})

test('subtreeIndices gathers a folder and every folder under it', () =>
{
    const leaf = { index: 2, children: [] }
    const branch = { index: 1, children: [leaf] }
    const other = { index: 3, children: [] }
    const root = { index: 0, children: [branch, other] }
    assert.deepEqual([...subtreeIndices(root)].sort(), [0, 1, 2, 3])
    assert.deepEqual([...subtreeIndices(branch)].sort(), [1, 2])
    // A node without an index is walked but never added.
    const bare = { children: [{ index: 5, children: [] }] }
    assert.deepEqual([...subtreeIndices(bare)], [5])
})
