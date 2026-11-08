import { test } from 'node:test'
import assert from 'node:assert/strict'
import { request as httpRequest } from 'node:http'
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { gunzipSync } from 'node:zlib'
import { makeRepo, makeTemp, raw, removeTemp, request, send, startServer, waitFor } from './support.ts'

const Run = promisify(execFile)

/** The environment git runs in, so a machine's own settings and hooks cannot change the result. */
const GitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }

/** Runs one git command in a repository, without signing, user config, or hooks. */
async function git(root: string, ...args: string[]): Promise<void>
{
    await Run('git', ['-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${join(root, '.git', 'no-hooks')}`, '-c', 'user.email=test@example.com', '-c', 'user.name=Test', '-C', root, ...args], { env: GitEnv })
}

/** Whether git is installed, so the changes test can skip instead of failing. */
async function hasGit(): Promise<boolean>
{
    try { await Run('git', ['--version'], { env: GitEnv }); return true }
    catch { return false }
}

test('Server serves the page, files, source, and the folder picker, and refuses what leaves it', async () =>
{
    const repoRoot = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-server-repo-')
    const publicRoot = await makeTemp('codespace-server-public-')
    try
    {
        await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Map</title>')

        const { port, stop } = await startServer(repoRoot, publicRoot)
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
        finally { await stop() }
    }
    finally { await removeTemp(repoRoot, publicRoot) }
})

test('Server answers a whole page load from one bootstrap request, and only the stamp when nothing changed', async () =>
{
    const files: Record<string, string> = {
        'src/a.ts': "import { b } from './b.ts'\nexport function a() { return b }\n",
        'src/b.ts': 'export const b = 1\n',
    }
    // Enough files that the answer is worth compressing.
    for (let i = 0; i < 40; i++) files[`src/extra-${i}.ts`] = `export const value${i} = ${i}\n`
    const repoRoot = await makeRepo(files, 'codespace-boot-repo-')
    const publicRoot = await makeTemp('codespace-boot-public-')
    try
    {
        await writeFile(join(publicRoot, 'index.html'), '<!doctype html><title>Map</title>'.repeat(100))
        await writeFile(join(publicRoot, 'main.js'), 'console.log(1)')

        const { port, stop } = await startServer(repoRoot, publicRoot)
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
        finally { await stop() }
    }
    finally { await removeTemp(repoRoot, publicRoot) }
})

test('Server hands out the installed Babylon at one address, with a validator', async () =>
{
    const repoRoot = await makeTemp('codespace-vendor-repo-')
    const publicRoot = await makeTemp('codespace-vendor-public-')
    try
    {
        const installed = await readFile(join(import.meta.dirname, '..', 'node_modules', 'babylonjs', 'babylon.js'))
        const { port, stop } = await startServer(repoRoot, publicRoot)
        try
        {
            const plain = await raw(port, '/vendor/babylon.js')
            assert.equal(plain.status, 200)
            assert.deepEqual(plain.body, installed, 'it serves the installed babylonjs package')

            const library = await raw(port, '/vendor/babylon.js', { 'Accept-Encoding': 'gzip' })
            assert.equal(library.status, 200)
            assert.match(String(library.headers['cache-control']), /no-cache/)
            assert.ok(library.headers.etag)
            assert.equal(library.headers['content-encoding'], 'gzip')
            assert.deepEqual(gunzipSync(library.body), installed)

            // A versioned path is not here: the page names no version.
            assert.equal((await raw(port, '/vendor/babylon-0.0.1.js')).status, 404)
        }
        finally { await stop() }
    }
    finally { await removeTemp(repoRoot, publicRoot) }
})

test('The page loads Babylon from the one installed build, and reaches the server by relative addresses', async () =>
{
    const html = await readFile(join(import.meta.dirname, '..', 'public', 'index.html'), 'utf8')
    assert.ok(html.includes('src="vendor/babylon.js"'), 'index.html must load vendor/babylon.js, relative to the page')
    // A proxy may serve the map under a path of its own, so no address may start at the site's root.
    assert.doesNotMatch(html, /(src|href)="\/|fetch\("\//)
    for (const name of await readdir(join(import.meta.dirname, '..', 'public')))
    {
        if (!name.endsWith('.ts') || name.endsWith('.d.ts')) continue
        const text = await readFile(join(import.meta.dirname, '..', 'public', name), 'utf8')
        assert.doesNotMatch(text, /["'`]\/api\//, `${name} reaches the server through endpoint.ts`)
    }
})

test('The repository endpoint lists the current repository and switches to another', async () =>
{
    const first = await makeRepo({ 'a.ts': 'export const a = 1\n' }, 'codespace-repo-a-')
    const second = await makeRepo({ 'b.ts': 'export const b = 1\n' }, 'codespace-repo-b-')
    const publicRoot = await makeTemp('codespace-repo-public-')
    try
    {
        const { port, stop } = await startServer(first, publicRoot)
        try
        {
            const info = await send(port, '/api/repo')
            assert.equal(info.status, 200)
            assert.equal(info.body.root, first)
            assert.deepEqual(info.body.recent.map((entry: { root: string }) => entry.root), [first])

            const moved = await request(port, 'POST', '/api/repo', { path: second })
            assert.equal(moved.status, 200)
            assert.equal(moved.body.root, second)
            assert.equal((await send(port, '/api/files')).body.files[0], 'b.ts')

            assert.equal((await request(port, 'POST', '/api/repo', {})).status, 400)
            assert.equal((await request(port, 'POST', '/api/repo', { path: join(first, 'nowhere') })).status, 400)
            assert.equal((await request(port, 'POST', '/api/repo', { path: first }, { Host: 'evil.example:8443' })).status, 403)
        }
        finally { await stop() }
    }
    finally { await removeTemp(first, second, publicRoot) }
})

test('Changes counts the lines a git checkout has changed, and is empty outside git', async (t) =>
{
    if (!(await hasGit())) { t.skip('git is not available'); return }
    const repoRoot = await makeRepo({ 'a.ts': 'export const a = 1\n' }, 'codespace-changes-')
    const publicRoot = await makeTemp('codespace-changes-public-')
    try
    {
        await git(repoRoot, 'init', '-q')
        await mkdir(join(repoRoot, '.git', 'no-hooks'), { recursive: true })
        await git(repoRoot, 'add', '.')
        await git(repoRoot, 'commit', '-q', '-m', 'initial')
        await writeFile(join(repoRoot, 'a.ts'), 'export const a = 1\nexport const b = 2\n')

        const { port, stop } = await startServer(repoRoot, publicRoot)
        try
        {
            const changes = await send(port, '/api/changes')
            assert.equal(changes.status, 200)
            assert.equal(changes.body.files['a.ts'], 1)
        }
        finally { await stop() }
    }
    finally { await removeTemp(repoRoot, publicRoot) }

    const plain = await makeRepo({ 'a.ts': 'export const a = 1\n' }, 'codespace-changes-plain-')
    const mismatch = await makeTemp('codespace-changes-mismatch-')
    try
    {
        const { port, stop } = await startServer(plain, mismatch)
        try { assert.deepEqual((await send(port, '/api/changes')).body, { files: {} }) }
        finally { await stop() }
    }
    finally { await removeTemp(plain, mismatch) }
})

test('Switching repositories takes down what was shown and tells watching pages', async () =>
{
    const first = await makeRepo({ 'src/a.ts': 'export const a = 1\n' }, 'codespace-show-a-')
    const second = await makeRepo({ 'b.ts': 'export const b = 1\n' }, 'codespace-show-b-')
    const publicRoot = await makeTemp('codespace-show-public-')
    try
    {
        const { port, workspace, stop } = await startServer(first, publicRoot)
        try
        {
            const messages: string[] = []
            const stream = httpRequest({ host: '127.0.0.1', port, path: '/api/view/events' }, (res) => res.on('data', (chunk) => messages.push(String(chunk))))
            stream.end()
            await waitFor(() => messages.join('').includes(': connected'))

            workspace.view.Show({ files: [{ path: 'src/a.ts', note: 'A.' }], trace: false, title: '', note: '' })
            assert.notEqual(workspace.view.Shown, null)

            await workspace.SwitchAsync(second)
            assert.equal(workspace.view.Shown, null)
            await waitFor(() => /"type":"repo"/.test(messages.join('')))
            stream.destroy()
        }
        finally { await stop() }
    }
    finally { await removeTemp(first, second, publicRoot) }
})
