import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { makeRepo, makeTemp, removeTemp, request, send, startServer, waitFor } from './support.ts'

/** Two repositories and a public folder: the server's own, one a page asks for with ?repo=, and the page. */
async function setup(): Promise<{ main: string, other: string, publicRoot: string }>
{
    const main = await makeRepo({ 'main.ts': 'export const main = 1\n' }, 'codespace-pinned-main-')
    const other = await makeRepo({ 'src/other.ts': 'export const other = 1\n' }, 'codespace-pinned-other-')
    const publicRoot = await makeTemp('codespace-pinned-public-')
    await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Map</title>')
    return { main, other, publicRoot }
}

/** Collects what one page's event stream is sent, until it is stopped. */
function watch(port: number, path: string): { messages: string[], stop: () => void }
{
    const messages: string[] = []
    const req = httpRequest({ host: '127.0.0.1', port, path }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
    req.on('error', () => undefined)
    req.end()
    return { messages, stop: () => req.destroy() }
}

test('?repo= reads another repository beside the server\'s own, each with its own map', async () =>
{
    const { main, other, publicRoot } = await setup()
    const { port, stop } = await startServer(main, publicRoot)
    const repo = `repo=${encodeURIComponent(other)}`
    try
    {
        assert.deepEqual((await send(port, '/api/files')).body.files, ['main.ts'])
        assert.deepEqual((await send(port, `/api/files?${repo}`)).body.files, ['src/other.ts'])

        const pinned = (await send(port, `/api/bootstrap?${repo}`)).body.repo
        assert.equal(pinned.pinned, true)
        assert.equal(pinned.chat, false, 'the chat stays with the server\'s own repository')
        assert.deepEqual(pinned.recent, [])
        assert.equal((await send(port, '/api/repo')).body.chat, true)

        // A show on one repository reaches only the pages watching that one.
        const mainPage = watch(port, '/api/view/events')
        const otherPage = watch(port, `/api/view/events?${repo}`)
        await waitFor(() => mainPage.messages.length > 0 && otherPage.messages.length > 0)
        const shown = await request(port, 'POST', `/api/view?${repo}`, { action: 'show', files: ['src/other.ts'] })
        assert.equal(shown.status, 200)
        await waitFor(() => /"type":"show"/.test(otherPage.messages.join('')))
        assert.doesNotMatch(mainPage.messages.join(''), /"type":"show"/)
        assert.equal((await send(port, '/api/view')).body.shown, null)
        mainPage.stop(); otherPage.stop()

        // A page on a pinned repository cannot switch it, and the server's own is untouched.
        assert.equal((await request(port, 'POST', `/api/repo?${repo}`, { path: main })).status, 409)
        assert.equal((await request(port, 'GET', `/api/chat?${repo}`)).status, 404)
        assert.equal((await send(port, `/api/repo?repo=${encodeURIComponent(main)}`)).body.pinned, false)
    }
    finally { await stop(); await removeTemp(main, other, publicRoot) }
})

test('Only this machine opens a repository with ?repo=, but a repository already open reads as the server\'s own does', async () =>
{
    const { main, other, publicRoot } = await setup()
    const { port, stop } = await startServer(main, publicRoot)
    const repo = `repo=${encodeURIComponent(other)}`
    try
    {
        const outside = { Host: 'example.com' }
        assert.equal((await send(port, `/api/files?${repo}`, outside)).status, 403)
        assert.equal((await send(port, `/api/files?${repo}`)).status, 200)
        assert.deepEqual((await send(port, `/api/files?${repo}`, outside)).body.files, ['src/other.ts'])
        assert.equal((await send(port, '/api/files?repo=/no/such/folder')).status, 400)
    }
    finally { await stop(); await removeTemp(main, other, publicRoot) }
})

test('A server started without the chat says so, and the page is told', async () =>
{
    const { main, other, publicRoot } = await setup()
    const { port, stop } = await startServer(main, publicRoot, { withChat: false })
    try
    {
        assert.equal((await send(port, '/api/repo')).body.chat, false)
        const chat = await send(port, '/api/chat')
        assert.equal(chat.status, 404)
        assert.match(chat.body.error, /without the chat/)
    }
    finally { await stop(); await removeTemp(main, other, publicRoot) }
})
