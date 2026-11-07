import { test } from 'node:test'
import assert from 'node:assert/strict'

import { join } from 'node:path'
import { Workspace } from '../src/server/Workspace.ts'
import { makeTemp, removeTemp } from './support.ts'

test('A workspace opens one repository, switches to another, and keeps them recent', async () =>
{
    const first = await makeTemp('codespace-switch-a-')
    const second = await makeTemp('codespace-switch-b-')
    try
    {
        const workspace = await Workspace.OpenAsync(first)
        assert.equal(workspace.Info.root, first)
        assert.deepEqual(workspace.Info.recent.map((entry) => entry.root), [first])

        const info = await workspace.SwitchAsync(second)
        assert.equal(workspace.repo.Root, second)
        assert.equal(info.root, second)
        assert.deepEqual(info.recent.map((entry) => entry.root), [second, first])

        // Switching back does not list a repository twice; it moves to the front.
        await workspace.SwitchAsync(first)
        assert.deepEqual(workspace.Info.recent.map((entry) => entry.root), [first, second])
    }
    finally
    {
        await removeTemp(first)
        await removeTemp(second)
    }
})

test('Opening a folder that is not there fails without moving the map', async () =>
{
    const root = await makeTemp('codespace-switch-keep-')
    try
    {
        const workspace = await Workspace.OpenAsync(root)
        await assert.rejects(workspace.SwitchAsync(join(root, 'nowhere')), /ENOENT|no such file/)
        assert.equal(workspace.repo.Root, root)
    }
    finally { await removeTemp(root) }
})
