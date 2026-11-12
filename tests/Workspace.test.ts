import { test } from 'node:test'
import assert from 'node:assert/strict'

import { writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Workspace } from '../src/server/Workspace.ts'
import { makeRepo, makeTemp, removeTemp, waitFor } from './support.ts'

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

test('A typed path resolves ~/ to the home folder and a relative path to the current folder', () =>
{
    assert.equal(Workspace.ResolvePath('~'), homedir())
    assert.equal(Workspace.ResolvePath('~/projects/../repo '), join(homedir(), 'repo'))
    assert.equal(Workspace.ResolvePath(' relative/folder '), join(process.cwd(), 'relative', 'folder'))
})

test('A workspace tells its pages when the architecture file changes, and watches the repository it switches to', async () =>
{
    const first = await makeRepo({ '.codespace/architecture.json': '{}\n' }, 'codespace-watch-a-')
    const second = await makeRepo({ '.codespace/architecture.json': '{}\n' }, 'codespace-watch-b-')
    const workspace = await Workspace.OpenAsync(first)
    const told: string[] = []
    workspace.view.ArchitectureChanged = () => { told.push(workspace.repo.Root) }
    try
    {
        // A write by hand, outside the server, is picked up from the file itself.
        await writeFile(join(first, '.codespace', 'architecture.json'), '{"layers": []}\n')
        await waitFor(() => told.length === 1)

        // After a switch, the watch follows the repository the map now reads.
        await workspace.SwitchAsync(second)
        await writeFile(join(second, '.codespace', 'architecture.json'), '{"layers": ["config"]}\n')
        await waitFor(() => told.length === 2)

        // A change elsewhere in the folder is not the architecture file, and is not announced.
        await writeFile(join(second, '.codespace', 'ingested.json'), '{}\n')
        await new Promise((done) => setTimeout(done, 300))
        assert.deepEqual(told, [first, second])
    }
    finally
    {
        workspace.Close()
        await removeTemp(first, second)
    }
})
