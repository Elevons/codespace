import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, writeFile } from 'node:fs/promises'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'
import { Server } from '../src/server/Server.ts'
import { Workspace } from '../src/server/Workspace.ts'
import { makeTemp, removeTemp } from './support.ts'

/** Sends one request, returning the status and either the parsed JSON or the raw text. */
function send(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number, body: any, text: string }>
{
    return new Promise((done, fail) =>
    {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) =>
        {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk as Buffer))
            res.on('end', () =>
            {
                const text = Buffer.concat(chunks).toString('utf8')
                const json = (res.headers['content-type'] ?? '').includes('application/json')
                done({ status: res.statusCode!, body: json && text !== '' ? JSON.parse(text) : null, text })
            })
        })
        req.on('error', fail)
        req.end()
    })
}

test('Server serves the page, files, source, and the folder picker, and refuses what leaves it', async () =>
{
    const repoRoot = await makeTemp('codespace-server-repo-')
    const publicRoot = await makeTemp('codespace-server-public-')
    try
    {
        await mkdir(join(repoRoot, 'src'))
        await writeFile(join(repoRoot, 'src', 'a.ts'), 'export const a = 1\n')
        await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Map</title>')

        const workspace = await Workspace.OpenAsync(repoRoot)
        const { http } = await Server.CreateAsync(workspace, publicRoot)
        await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
        const port = (http.address() as AddressInfo).port
        try
        {
            const files = await send(port, '/api/files')
            assert.deepEqual(files.body.files, ['src/a.ts'])

            const source = await send(port, '/api/source?path=src%2Fa.ts')
            assert.equal(source.status, 200)
            assert.match(source.text, /export const a/)

            const outside = await send(port, '/api/source?path=..%2Fsecret')
            assert.equal(outside.status, 403)

            const browse = await send(port, '/api/browse')
            assert.equal(browse.status, 200)
            assert.ok(browse.body.folders.some((folder: { name: string }) => folder.name === 'src'))

            // The picker lists folders outside the repository, so it stays on this machine.
            assert.equal((await send(port, '/api/browse', { Host: 'evil.example:8443' })).status, 403)

            const page = await send(port, '/')
            assert.equal(page.status, 200)
            assert.match(page.text, /<!doctype html>/)

            // A request that climbs out of the public folder is refused.
            assert.equal((await send(port, '/..%2F..%2Fetc%2Fpasswd')).status, 403)
        }
        finally
        {
            await new Promise<void>((done) => { http.closeAllConnections(); http.close(() => done()) })
        }
    }
    finally { await removeTemp(repoRoot, publicRoot) }
})

/** Sends one request and returns the status, headers, and raw body, without decoding it. */
function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }>
{
    return new Promise((done, fail) =>
    {
        const req = httpRequest({ host: '127.0.0.1', port, method: 'GET', path, headers }, (res) =>
        {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk as Buffer))
            res.on('end', () => done({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }))
        })
        req.on('error', fail)
        req.end()
    })
}

test('Server answers a whole page load from one bootstrap request, and only the stamp when nothing changed', async () =>
{
    const repoRoot = await makeTemp('codespace-boot-repo-')
    const publicRoot = await makeTemp('codespace-boot-public-')
    try
    {
        await mkdir(join(repoRoot, 'src'))
        await writeFile(join(repoRoot, 'src', 'a.ts'), "import { b } from './b.ts'\nexport function a() { return b }\n")
        await writeFile(join(repoRoot, 'src', 'b.ts'), 'export const b = 1\n')
        // Enough files that the answer is worth compressing.
        for (let i = 0; i < 40; i++) await writeFile(join(repoRoot, 'src', `extra-${i}.ts`), `export const value${i} = ${i}\n`)
        await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Map</title>'.repeat(100))
        await writeFile(join(publicRoot, 'main.js'), 'console.log(1)')

        const { http } = await Server.CreateAsync(await Workspace.OpenAsync(repoRoot), publicRoot)
        await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
        const port = (http.address() as AddressInfo).port
        try
        {
            const boot = await send(port, '/api/bootstrap')
            assert.equal(boot.status, 200)
            assert.equal(boot.body.files.length, 42)
            assert.deepEqual(boot.body.edges, [['src/a.ts', 'src/b.ts']])
            assert.equal(boot.body.lines['src/a.ts'], 3)
            assert.deepEqual(boot.body.symbols['src/a.ts'], ['a'])
            assert.equal(typeof boot.body.repo.name, 'string')
            assert.ok(boot.body.architecture)
            assert.deepEqual(boot.body.changes, {})

            // A page holding the current stamp gets nothing else back.
            const same = await send(port, `/api/bootstrap?since=${boot.body.fingerprint}`)
            assert.deepEqual(same.body, { fingerprint: boot.body.fingerprint, unchanged: true })
            assert.equal((await send(port, '/api/bootstrap?since=stale')).body.files.length, 42)

            // A client that accepts gzip gets it, and the body is the same JSON.
            const zipped = await raw(port, '/api/bootstrap', { 'Accept-Encoding': 'gzip' })
            assert.equal(zipped.headers['content-encoding'], 'gzip')
            assert.equal(JSON.parse(gunzipSync(zipped.body).toString()).files.length, 42)

            // Static files carry a validator, so an unchanged one is a 304, and they compress.
            const page = await raw(port, '/')
            assert.equal(page.status, 200)
            assert.equal(page.headers['cache-control'], 'no-cache')
            const etag = String(page.headers.etag)
            assert.equal((await raw(port, '/', { 'If-None-Match': etag })).status, 304)
            const packed = await raw(port, '/', { 'Accept-Encoding': 'br, gzip' })
            assert.equal(packed.headers['content-encoding'], 'br')
            assert.ok(packed.body.length < page.body.length)
        }
        finally
        {
            await new Promise<void>((done) => { http.closeAllConnections(); http.close(() => done()) })
        }
    }
    finally { await removeTemp(repoRoot, publicRoot) }
})

test('Server hands out the installed Babylon at a versioned address the browser keeps for good', async () =>
{
    const repoRoot = await makeTemp('codespace-vendor-repo-')
    const publicRoot = await makeTemp('codespace-vendor-public-')
    try
    {
        const { version } = (await import('../node_modules/babylonjs/package.json', { with: { type: 'json' } })).default
        const { http } = await Server.CreateAsync(await Workspace.OpenAsync(repoRoot), publicRoot)
        await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
        const port = (http.address() as AddressInfo).port
        try
        {
            const library = await raw(port, `/vendor/babylon-${version}.js`, { 'Accept-Encoding': 'gzip' })
            assert.equal(library.status, 200)
            assert.match(String(library.headers['cache-control']), /immutable/)
            assert.equal(library.headers['content-encoding'], 'gzip')
            assert.match(gunzipSync(library.body).subarray(0, 4000).toString(), /BABYLON|babylon/i)

            // Any other version is not here, rather than silently answered with this one.
            assert.equal((await raw(port, '/vendor/babylon-0.0.1.js')).status, 404)
        }
        finally
        {
            await new Promise<void>((done) => { http.closeAllConnections(); http.close(() => done()) })
        }
    }
    finally { await removeTemp(repoRoot, publicRoot) }
})
