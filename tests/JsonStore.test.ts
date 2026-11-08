import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { JsonStore } from '../src/repo/JsonStore.ts'
import { makeRepo, makeTemp, removeTemp } from './support.ts'

test('WriteAsync writes whole and leaves no temporary file behind', async () =>
{
    const root = await makeRepo({ 'a.ts': 'export const a = 1\n' }, 'codespace-store-')
    try
    {
        await JsonStore.WriteAsync(root, '.codespace/record.json', '{"a":1}\n')
        assert.equal(await readFile(join(root, '.codespace', 'record.json'), 'utf8'), '{"a":1}\n')
        const left = (await readdir(join(root, '.codespace'))).filter((name) => name.endsWith('.tmp'))
        assert.deepEqual(left, [])
    }
    finally { await removeTemp(root) }
})

test('A .codespace path that is a regular file is refused and its bytes are left alone', async () =>
{
    const root = await makeRepo({ '.codespace': 'keep me' }, 'codespace-store-file-')
    try
    {
        await assert.rejects(JsonStore.WriteAsync(root, '.codespace/record.json', 'new'), /not a folder/)
        assert.equal(await readFile(join(root, '.codespace'), 'utf8'), 'keep me')
    }
    finally { await removeTemp(root) }
})

test('ReadAsync returns null for a file that is not there', async () =>
{
    const root = await makeRepo({}, 'codespace-read-')
    try { assert.equal(await JsonStore.ReadAsync(root, '.codespace/nothing.json'), null) }
    finally { await removeTemp(root) }
})

test('ReadAsync refuses a link that points outside the repository', async () =>
{
    const outside = await makeTemp('codespace-outside-')
    const root = await makeRepo({}, 'codespace-link-')
    try
    {
        await writeFile(join(outside, 'secret.txt'), 'x')
        await symlink(join(outside, 'secret.txt'), join(root, 'link.txt'))
        await assert.rejects(JsonStore.ReadAsync(root, 'link.txt'), /outside the repository/)
    }
    finally { await removeTemp(root, outside) }
})

test('A lock left by a process that died is reclaimed', async () =>
{
    const root = await makeRepo({}, 'codespace-lock-')
    try
    {
        await writeFile(join(root, '.codespace.lock'), '999999')
        let ran = false
        await JsonStore.RunAsync(root, async () => { ran = true })
        assert.equal(ran, true)
        assert.deepEqual((await readdir(root)).filter((name) => name.endsWith('.lock')), [])
    }
    finally { await removeTemp(root) }
})
