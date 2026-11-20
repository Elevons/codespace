import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Neighbours } from '../src/repo/Neighbours.ts'
import { ClampNeighbourDepth, MaxNeighbourDepth, MaxNeighbourhood } from '../public/neighbours.ts'

const edges: Array<[string, string]> = [
    ['src/a.ts', 'src/b.ts'],
    ['src/b.ts', 'src/c.ts'],
    ['src/c.ts', 'src/d.ts'],
]

test('A neighbourhood holds the chosen file and its neighbours, outward by one step', () =>
{
    const one = Neighbours(edges, 'src/b.ts', 1)
    assert.deepEqual(one, [
        { path: 'src/b.ts', depth: 0 },
        { path: 'src/a.ts', depth: 1 },
        { path: 'src/c.ts', depth: 1 },
    ])
    const two = Neighbours(edges, 'src/b.ts', 2)
    assert.deepEqual(two.filter((item) => item.depth === 2), [{ path: 'src/d.ts', depth: 2 }])
})

test('A neighbourhood crosses imports in both directions, and never repeats a file', () =>
{
    const found = Neighbours(edges, 'src/c.ts', 1)
    assert.deepEqual(found.map((item) => item.path), ['src/c.ts', 'src/b.ts', 'src/d.ts'])
    const twice = Neighbours([...edges, ['src/d.ts', 'src/b.ts']], 'src/b.ts', 2)
    assert.equal(new Set(twice.map((item) => item.path)).size, twice.length)
})

test('A neighbourhood is capped, and a file with no imports is alone', () =>
{
    const wide: Array<[string, string]> = Array.from({ length: MaxNeighbourhood + 40 }, (_, index) => ['src/hub.ts', `src/leaf-${index}.ts`])
    assert.equal(Neighbours(wide, 'src/hub.ts', 1).length, MaxNeighbourhood)
    assert.deepEqual(Neighbours([], 'src/lonely.ts', 2), [{ path: 'src/lonely.ts', depth: 0 }])
})

test('A requested depth is a whole number within the rule', () =>
{
    assert.equal(ClampNeighbourDepth(1), 1)
    assert.equal(ClampNeighbourDepth('2'), 2)
    assert.equal(ClampNeighbourDepth(99), MaxNeighbourDepth)
    assert.equal(ClampNeighbourDepth(0), 1)
    assert.equal(ClampNeighbourDepth('deep'), 1)
})
