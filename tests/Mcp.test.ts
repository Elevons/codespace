import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

/** Runs the MCP server against a URL, sends it messages, and returns what it answered, by id. */
async function converse(url: string, messages: object[]): Promise<Map<number, any>>
{
    const child = spawn(process.execPath, ['--experimental-transform-types', join(import.meta.dirname, '..', 'src', 'mcp', 'Mcp.ts')], { env: { ...process.env, CODESPACE_URL: url }, stdio: ['pipe', 'pipe', 'ignore'] })
    const answers = new Map<number, any>()
    let buffer = ''
    child.stdout.on('data', (chunk) =>
    {
        buffer += String(chunk)
        for (let cut = buffer.indexOf('\n'); cut >= 0; cut = buffer.indexOf('\n'))
        {
            const message = JSON.parse(buffer.slice(0, cut))
            buffer = buffer.slice(cut + 1)
            if (typeof message.id === 'number') answers.set(message.id, message)
        }
    })
    for (const message of messages) child.stdin.write(JSON.stringify(message) + '\n')
    const wanted = messages.filter((message: any) => message.id !== undefined).length
    for (let waited = 0; answers.size < wanted && waited < 8000; waited += 25) await new Promise((done) => setTimeout(done, 25))
    child.kill()
    return answers
}

const Hello = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '0' } } }

test('The MCP server speaks the protocol and lists its tools', async () =>
{
    const answers = await converse('http://127.0.0.1:1', [
        Hello,
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        { jsonrpc: '2.0', id: 3, method: 'nothing/here' },
        { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope', arguments: {} } },
    ])
    assert.equal(answers.get(1).result.protocolVersion, '2025-06-18')
    assert.deepEqual(answers.get(1).result.capabilities, { tools: {} })
    const names = answers.get(2).result.tools.map((tool: { name: string }) => tool.name)
    assert.deepEqual(names, ['get_architecture', 'get_import_graph', 'get_view', 'update_architecture', 'show_files', 'focus', 'clear_view'])
    for (const tool of answers.get(2).result.tools) assert.equal(tool.inputSchema.type, 'object')
    assert.equal(answers.get(3).error.code, -32601)
    assert.equal(answers.get(4).error.code, -32602)
})

test('A tool call becomes a request to Codespace, and its answer comes back', async () =>
{
    const seen: Array<{ method: string, url: string, body: string }> = []
    const server = createServer((req, res) =>
    {
        let body = ''
        req.on('data', (chunk) => { body += chunk })
        req.on('end', () =>
        {
            seen.push({ method: req.method!, url: req.url!, body })
            res.writeHead(req.url === '/api/view' && body.includes('ghost') ? 400 : 200, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify(req.url === '/api/view' && body.includes('ghost') ? { error: 'None of those paths are files.' } : { ok: true }))
        })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    try
    {
        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
        const answers = await converse(url, [
            Hello,
            { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'show_files', arguments: { files: [{ path: 'src/a.ts', note: 'starts' }], trace: true, title: 'T' } } },
            { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'show_files', arguments: { files: ['ghost.ts'] } } },
            { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'update_architecture', arguments: { renames: [{ from: 'a', to: 'b' }] } } },
        ])
        assert.equal(answers.get(2).result.isError, undefined)
        assert.deepEqual(JSON.parse(seen[0]!.body), { action: 'show', files: [{ path: 'src/a.ts', note: 'starts' }], trace: true, title: 'T' })
        assert.equal(answers.get(3).result.isError, true)
        assert.match(answers.get(3).result.content[0].text, /None of those paths/)
        assert.equal(seen.find((request) => request.url === '/api/architecture')?.method, 'POST')
    }
    finally { server.close() }
})

test('When Codespace is not running, a tool call says how to start it', async () =>
{
    const answers = await converse('http://127.0.0.1:1', [Hello, { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_view', arguments: {} } }])
    assert.equal(answers.get(2).result.isError, true)
    assert.match(answers.get(2).result.content[0].text, /Cannot reach Codespace.*npm start/)
})
