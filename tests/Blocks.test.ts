import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Blocks } from '../src/repo/Blocks.ts'
import { hasChildren, stackLayout, type BlockInfo } from '../public/blocks.ts'

const Source = [
    "import { Helper } from './Helper.ts'",
    '',
    '/** The most items to list. */',
    'export const Limit = 4',
    '',
    '/** One thing the report names. */',
    'interface IThing',
    '{',
    '    name: string',
    '}',
    '',
    '/**',
    ' * Looks at the things and returns what it found.',
    ' * @param things the things to look at',
    ' */',
    'export function Look(things: IThing[]): string[]',
    '{',
    '    const kept: string[] = []',
    '',
    '    // Keep the things that have a name.',
    '    for (const thing of things)',
    '    {',
    '        if (thing.name !== undefined) kept.push(Helper(thing.name))',
    '    }',
    '',
    '    // Sort what is left, so the answer reads.',
    '    kept.sort()',
    '    return kept',
    '}',
].join('\n')

test('Blocks groups declarations and cuts a long function at its comments', () =>
{
    const report = Blocks.Read('src/Things.ts', Source)
    const blocks = report.blocks
    assert.equal(report.lines, 29)

    const [imports, constants, types, look] = blocks
    assert.equal(imports.kind, 'import')
    assert.equal(imports.name, 'imports')
    assert.deepEqual(imports.members, ['./Helper.ts'])
    assert.equal(constants.kind, 'constant')
    assert.equal(constants.name, 'Limit')
    assert.equal(constants.summary, 'The most items to list.')
    assert.equal(constants.fromComment, true)
    assert.equal(types.kind, 'type')
    assert.equal(types.name, 'IThing')
    assert.equal(look.kind, 'function')
    assert.equal(look.name, 'Look')
    assert.equal(look.line, 16)
    assert.equal(look.endLine, 29)
    assert.equal(look.summary, 'Looks at the things and returns what it found.')
    assert.equal(look.fromComment, true)
    // A block is not a reference to the sections inside it.
    assert.deepEqual(look.refs, ['IThing'])
})

test('A function of more than 40 lines opens into its commented sections', () =>
{
    const body = [
        '/** Long enough to open. */',
        'export function Long(): number',
        '{',
        '    let total = 0',
        '    total += 1',
        '    total += 2',
        '    total += 3',
        '    total += 4',
        '    total += 5',
        '    total += 6',
        '    total += 7',
        '    total += 8',
        '    total += 9',
        '    total += 10',
        '    total += 11',
        '    total += 12',
        '    total += 13',
        '    total += 14',
        '    total += 15',
        '    total += 16',
        '    total += 17',
        '    total += 18',
        '    total += 19',
        '    total += 20',
        '    total += 21',
        '',
        '    // Fold the total in half.',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '    total = total / 2',
        '',
        '    // Report it.',
        '    return total',
        '}',
    ].join('\n')
    const sections = Blocks.Read('src/Long.ts', body).blocks.filter((block) => block.depth === 1)
    assert.equal(sections.length, 3)
    assert.equal(sections[0].name, '¶1')
    assert.equal(sections[0].parent, 'Long')
    assert.equal(sections[1].name, 'Fold the total in half')
    assert.equal(sections[2].summary, 'Report it.')
    assert.equal(sections[2].endLine, 48)
})

test('A block with no comment gets a plain description of its shape, and says so', () =>
{
    const blocks = Blocks.Read('src/Bare.ts', 'export function Bare()\n{\n    return 1\n}\n').blocks
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].summary, 'Bare: a function of 4 lines.')
    assert.equal(blocks[0].fromComment, false)
})

test('Blocks reads the top-level declarations of other languages, with their comments', () =>
{
    const python = [
        'import os',
        '',
        '# The most nodes to read.',
        'LIMIT = 10',
        '',
        '# Loads the graph from a folder.',
        'def load(path):',
        '    return path',
        '',
        'class Node:',
        '    pass',
        '',
    ].join('\n')
    const blocks = Blocks.Read('script.py', python).blocks
    assert.deepEqual(blocks.map((block) => [block.kind, block.name]), [['constant', 'LIMIT'], ['function', 'load'], ['type', 'Node']])
    assert.equal(blocks[1].summary, 'Loads the graph from a folder.')
    assert.equal(blocks[2].line, 10)
})

test('A text file with no declarations is one block of the whole file', () =>
{
    const blocks = Blocks.Read('notes.md', '# Notes\n\nJust prose.\n').blocks
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].name, 'notes.md')
    assert.equal(blocks[0].line, 1)
    assert.equal(blocks[0].endLine, 4)
})

test('Stack layout gives every block a slab, a header over its sections, filling the height', () =>
{
    const blocks: BlockInfo[] = [
        { name: 'imports', kind: 'import', line: 1, endLine: 1, depth: 0, summary: '', fromComment: false, refs: [] },
        { name: 'Work', kind: 'function', line: 3, endLine: 60, depth: 0, summary: '', fromComment: false, refs: [] },
        { name: '¶1', kind: 'section', line: 4, endLine: 30, depth: 1, parent: 'Work', summary: '', fromComment: false, refs: [] },
        { name: '¶2', kind: 'section', line: 31, endLine: 60, depth: 1, parent: 'Work', summary: '', fromComment: false, refs: [] },
    ]
    assert.equal(hasChildren(blocks, blocks[1]), true)
    const floors = stackLayout(blocks, 10)
    assert.equal(floors.length, 4)
    // Reading order runs top to bottom: the last block sits at the foot of the stack.
    assert.equal(floors[0].block.name, '¶2')
    assert.equal(floors[3].block.name, 'imports')
    assert.ok(Math.abs(floors.reduce((sum, floor) => sum + floor.thickness, 0) - 10) < 1e-9)
    // The function is only a header over its two sections, so each section gets real height.
    const header = floors.find((floor) => floor.block.name === 'Work')!
    assert.ok(header.thickness < floors[0].thickness)
    assert.deepEqual(stackLayout([], 10), [])
})
