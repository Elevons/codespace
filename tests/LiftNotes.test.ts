import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Architecture } from '../src/repo/Architecture.ts'
import { Blocks } from '../src/repo/Blocks.ts'
import { LiftNotes, LiftNotesAsync } from '../src/repo/LiftNotes.ts'
import { Repo } from '../src/repo/Repo.ts'
import { makeRepo, removeTemp } from './support.ts'

const Source = [
    '/** How many plans may wait. */',
    'export const Limit = 4',
    '',
    '/** Makes plans for one body. */',
    'export class Planner',
    '{',
    '    /** the memory: what was planned last */',
    '    private memory: string | null = null',
    '',
    '    /**',
    '     * Makes the next plan.',
    '     * @param need what is wanted',
    '     */',
    '    public Plan(need: string): string',
    '    {',
    '        //> First we look at the memory.',
    '        //> If it is empty, we start fresh.',
    '        const last = this.memory // the last plan',
    '        // A reason that stays.',
    '        //> Finally we return the plan.',
    '        return last ?? need',
    '    }',
    '}',
    '',
].join('\n')

test('Lifting takes JSDoc and step comments out, as notes by name, and leaves other comments', () =>
{
    const lifted = LiftNotes('src/Planner.ts', Source)
    assert.deepEqual(lifted.notes, {
        'Limit': 'How many plans may wait.',
        'Planner': 'Makes plans for one body.',
        'Planner.memory': 'the memory: what was planned last',
        'Planner.Plan': 'Makes the next plan.\nneed: what is wanted',
        'Planner.Plan:1': 'First we look at the memory. If it is empty, we start fresh.',
        'Planner.Plan:2': 'Finally we return the plan.',
    })
    assert.equal(lifted.count, 7)
    assert.ok(!lifted.text.includes('/**') && !lifted.text.includes('//>'))
    assert.ok(lifted.text.includes('// the last plan') && lifted.text.includes('// A reason that stays.'))
    assert.ok(lifted.text.includes('export class Planner\n{\n    private memory'), 'a comment on its own line leaves no blank line behind')
})

test('lift-notes moves the comments into the architecture file, and the blocks read them from there', async () =>
{
    const root = await makeRepo({
        'src/Planner.ts': Source,
        '.codespace/architecture.json': JSON.stringify({ layers: ['model'], files: { 'src/Planner.ts': { summary: 'Plans.', layer: 'model', notes: { 'Planner.Plan:7': 'An old step.', 'Old': 'Kept.' } } } }),
    }, 'codespace-lift-')
    try
    {
        const repo = await Repo.OpenAsync(root)
        const dry = await LiftNotesAsync(repo, true)
        assert.equal(dry.written, false)
        assert.equal(await readFile(join(root, 'src/Planner.ts'), 'utf8'), Source, 'a dry run changes nothing')

        const done = await LiftNotesAsync(repo, false)
        assert.deepEqual([done.files, done.comments, done.written], [1, 7, true])
        const text = await readFile(join(root, 'src/Planner.ts'), 'utf8')
        assert.ok(!text.includes('/**'))
        const notes = (await Architecture.ReadAsync(root, await repo.ListFilesAsync())).files['src/Planner.ts']!.notes!
        assert.equal(notes['Old'], 'Kept.', 'a note with no comment in the code is kept')
        assert.equal(notes['Planner.Plan:7'], undefined, 'lifted steps replace the steps kept before')
        assert.equal(notes['Planner.Plan:2'], 'Finally we return the plan.')

        const blocks = Blocks.Read('src/Planner.ts', text, undefined, notes).blocks
        const planner = blocks.find((block) => block.name === 'Planner')!
        assert.equal(planner.summary, 'Makes plans for one body.')
        assert.equal(planner.fromNotes, true)
        assert.deepEqual(planner.details!.map((detail) => detail.name), ['memory', 'Plan', 'Plan:1', 'Plan:2'])
        assert.equal(blocks.find((block) => block.name === 'Limit')!.summary, 'How many plans may wait.')
    }
    finally { await removeTemp(root) }
})

test('Notes are merged by name, checked for length, and written one per line', async () =>
{
    const root = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-notes-')
    try
    {
        const known = ['src/a.ts']
        await Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { notes: { a: 'The first value.', 'a:1': 'A step.' } } } })
        await Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { notes: { 'a:1': null, b: 'Another.' } } } })
        assert.deepEqual((await Architecture.ReadAsync(root, known)).files['src/a.ts']!.notes, { a: 'The first value.', b: 'Another.' })
        const written = await readFile(join(root, '.codespace/architecture.json'), 'utf8')
        assert.ok(written.includes('\n        "a": "The first value.",\n'))
        await assert.rejects(Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { notes: { a: 'x'.repeat(2001) } } } }), /over 2000/)
        await assert.rejects(Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { notes: { a: 4 as unknown as string } } } }), /notes must be/)
        await Architecture.UpdateAsync(root, known, { files: { 'src/a.ts': { notes: null } } })
        assert.equal((await Architecture.ReadAsync(root, known)).files['src/a.ts'], undefined)
    }
    finally { await removeTemp(root) }
})
