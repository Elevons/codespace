import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IArchitecture } from '../src/repo/Architecture.ts'
import { Refine } from '../src/repo/Refine.ts'
import { RefineGuide } from '../src/repo/RefineGuide.ts'

/** An architecture with the given layers and files, each file as `layer`, `system`, and optional tags. */
function architecture(layers: string[], systems: string[], files: Record<string, { layer: string, system: string, tags?: string[] }>): IArchitecture
{
    return {
        layers,
        systems: Object.fromEntries(systems.map((name) => [name, { summary: `The ${name}.` }])),
        files: Object.fromEntries(Object.entries(files).map(([path, entry]) => [path, { ...entry, summary: `Does ${path}.` }])),
        folders: {}, concepts: { data: {}, operations: {} }, warnings: [], error: '',
    }
}

test('Imports that point up the layers are grouped by pair of layers, with the ordinary ones for scale', () =>
{
    const arch = architecture(['data', 'api', 'ui'], ['app'], {
        'a.ts': { layer: 'data', system: 'app' }, 'b.ts': { layer: 'api', system: 'app' }, 'c.ts': { layer: 'ui', system: 'app' },
    })
    // a (data) uses b (api) is a break; c (ui) uses b (api) and c uses a are the right way round.
    const report = Refine(arch, [['a.ts', 'b.ts'], ['c.ts', 'b.ts'], ['c.ts', 'a.ts']])

    assert.equal(report.breakCount, 1)
    assert.equal(report.breaks.length, 1)
    assert.deepEqual([report.breaks[0]!.from, report.breaks[0]!.to, report.breaks[0]!.count, report.breaks[0]!.ordinary], ['data', 'api', 1, 0])
    assert.equal(report.breaks[0]!.examples[0]!.from.summary, 'Does a.ts.')
})

test('A file that sits in fewer breaks on another layer is suggested there, biggest gain first', () =>
{
    const arch = architecture(['data', 'api', 'ui'], ['app'], {
        'low.ts': { layer: 'data', system: 'app' }, 'mid.ts': { layer: 'api', system: 'app' }, 'top.ts': { layer: 'ui', system: 'app' },
    })
    // low.ts uses both files above it, so it is in two breaks; on ui it would be in none. Each of the
    // others is in one break and would be in none on data, so they follow with a smaller gain.
    const report = Refine(arch, [['low.ts', 'mid.ts'], ['low.ts', 'top.ts']])

    assert.equal(report.breakCount, 2)
    assert.deepEqual(report.moves.map((move) => [move.file.path, move.suggestLayer, move.breaksNow, move.breaksIfMoved]), [
        ['low.ts', 'ui', 2, 0], ['mid.ts', 'data', 1, 0], ['top.ts', 'data', 1, 0],
    ])
    // A file in no break is never suggested a move.
    assert.deepEqual(Refine(arch, [['top.ts', 'low.ts']]).moves, [])
})

test('A file whose neighbours are mostly in another system is flagged, but a test file never is', () =>
{
    const arch = architecture(['base', 'top'], ['server', 'browser'], {
        'odd.ts': { layer: 'top', system: 'browser' },
        's1.ts': { layer: 'base', system: 'server' }, 's2.ts': { layer: 'base', system: 'server' }, 's3.ts': { layer: 'base', system: 'server' },
        'odd.test.ts': { layer: 'top', system: 'browser', tags: ['test'] },
    })
    const edges: Array<[string, string]> = [['odd.ts', 's1.ts'], ['odd.ts', 's2.ts'], ['s3.ts', 'odd.ts'], ['odd.test.ts', 's1.ts'], ['odd.test.ts', 's2.ts'], ['odd.test.ts', 's3.ts']]
    const report = Refine(arch, edges)

    assert.deepEqual(report.misplaced.map((item) => [item.file.path, item.suggestSystem]), [['odd.ts', 'server']])
    assert.deepEqual(report.systems.browser!.uses, { server: 5 })
})

test('Layers and systems that look wrong as a whole are reported', () =>
{
    const arch = architecture(['server', 'unused', 'lone', 'top'], ['server', 'empty', 'flat'], {
        'a.ts': { layer: 'top', system: 'flat' }, 'b.ts': { layer: 'top', system: 'flat' }, 'c.ts': { layer: 'top', system: 'flat' },
        'd.ts': { layer: 'lone', system: 'server' },
    })
    const text = Refine(arch, []).issues.join('\n')

    assert.match(text, /layer "server" has the same name as a system/)
    assert.match(text, /layer "unused" holds no files/)
    assert.match(text, /layer "lone" holds one file/)
    assert.match(text, /system "empty" has no files/)
    assert.match(text, /Every file of the system "flat" is in the layer "top"/)
})

test('A well layered repository has nothing left to refine, and the lists are cut to the size asked', () =>
{
    const tidy = architecture(['base', 'top'], ['app', 'lib'], {
        'a.ts': { layer: 'base', system: 'lib' }, 'b.ts': { layer: 'base', system: 'app' }, 'c.ts': { layer: 'top', system: 'app' }, 'd.ts': { layer: 'top', system: 'lib' },
    })
    assert.equal(Refine(tidy, [['c.ts', 'a.ts'], ['d.ts', 'b.ts']]).remaining, 0)

    const files = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`f${i}.ts`, { layer: 'base', system: 'app' }]))
    const many = architecture(['base', 'top'], ['app'], { ...files, 'x.ts': { layer: 'top', system: 'app' } })
    const report = Refine(many, Array.from({ length: 6 }, (_, i): [string, string] => [`f${i}.ts`, 'x.ts']), 2)
    assert.equal(report.breakCount, 6)
    assert.equal(report.moves.length, 2)
})

test('The guide names the command with the repository filled in', () =>
{
    assert.match(RefineGuide('/cs/Cli.ts', '/repo'), /\/cs\/Cli\.ts refine --repo \/repo/)
})
