import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { ParseHistory, ReadHistoryAsync } from '../src/repo/History.ts'
import { HeatWindow, buildTimeline, historyHeat } from '../public/history.ts'
import { makeRepo, makeTemp, removeTemp, send, startServer } from './support.ts'

const Run = promisify(execFile)
const GitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

async function git(root: string, ...args: string[]): Promise<void>
{
    await Run('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, '.git', 'no-hooks')}`, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-C', root, ...args], { env: GitEnv })
}

async function hasGit(): Promise<boolean>
{
    try { await Run('git', ['--version'], { env: GitEnv }); return true }
    catch { return false }
}

const record = (hash: string, date: string, subject: string, ...lines: string[]): string => `\x1e${hash}\x1f${date}\x1f${subject}\n\n${lines.join('\n')}\n`

test('A file touched before it was renamed is credited to the name it has now, and deleted files drop out', () =>
{
    const log = record('a1', '2026-01-01', 'first', 'A\told.ts', 'A\tgone.ts') +
        record('b2', '2026-01-02', 'edit', 'M\told.ts', 'D\tgone.ts') +
        record('c3', '2026-01-03', 'move', 'R100\told.ts\tsrc/new.ts') +
        record('d4', '2026-01-04', 'again', 'R090\tsrc/new.ts\tsrc/newest.ts')
    const commits = ParseHistory(log)
    assert.deepEqual(commits.map((commit) => commit.files), [
        ['gone.ts', 'src/newest.ts'],
        ['src/newest.ts'],
        ['src/newest.ts'],
        ['src/newest.ts'],
    ])
    assert.equal(commits[2]!.subject, 'move')
    assert.equal(commits[0]!.date, '2026-01-01')
})

test('A subject that holds the field mark is kept whole, and empty output is no history', () =>
{
    assert.equal(ParseHistory(record('e5', '2026-02-01', 'a\x1fb', 'A\tx.ts'))[0]!.subject, 'a\x1fb')
    assert.deepEqual(ParseHistory(''), [])
})

test('A file is dark before its first commit, hot when touched, and cools over the heat window', () =>
{
    const timeline = buildTimeline([
        { hash: 'a', date: 'd', subject: 's', files: ['a.ts'] },
        { hash: 'b', date: 'd', subject: 's', files: ['b.ts'] },
        { hash: 'c', date: 'd', subject: 's', files: [] },
    ])
    assert.equal(historyHeat(timeline, 'b.ts', 0), -1)
    assert.equal(historyHeat(timeline, 'b.ts', 1), 1)
    assert.equal(historyHeat(timeline, 'a.ts', 2), 1 - 2 / HeatWindow)
    assert.equal(historyHeat(timeline, 'untracked.ts', 1), -1)
    assert.equal(historyHeat(timeline, 'untracked.ts', 2), 0)
})

test('History reads a checkout oldest first, follows a rename, and is empty outside git', async (t) =>
{
    if (!(await hasGit())) { t.skip('git is not available'); return }
    const root = await makeRepo({ 'a.ts': 'export const a = 1\n' }, 'codespace-history-')
    const publicRoot = await makeTemp('codespace-history-public-')
    try
    {
        await git(root, 'init', '-q')
        await mkdir(join(root, '.git', 'no-hooks'), { recursive: true })
        await git(root, 'add', '.')
        await git(root, 'commit', '-q', '-m', 'add a')
        await writeFile(join(root, 'a.ts'), 'export const a = 1\nexport const b = 2\n')
        await git(root, 'commit', '-q', '-am', 'grow a')
        await mkdir(join(root, 'src'), { recursive: true })
        await rename(join(root, 'a.ts'), join(root, 'src', 'a.ts'))
        await git(root, 'add', '-A')
        await git(root, 'commit', '-q', '-m', 'move a')

        const commits = await ReadHistoryAsync(root)
        assert.deepEqual(commits.map((commit) => commit.subject), ['add a', 'grow a', 'move a'])
        assert.deepEqual(commits.map((commit) => commit.files), [['src/a.ts'], ['src/a.ts'], ['src/a.ts']])

        const { port, stop } = await startServer(root, publicRoot)
        try
        {
            const answer = await send(port, '/api/history')
            assert.equal(answer.status, 200)
            assert.equal(answer.body.commits.length, 3)
        }
        finally { await stop() }
    }
    finally { await removeTemp(root, publicRoot) }

    const plain = await makeRepo({ 'a.ts': 'export const a = 1\n' }, 'codespace-history-plain-')
    try { assert.deepEqual(await ReadHistoryAsync(plain), []) }
    finally { await removeTemp(plain) }
})
