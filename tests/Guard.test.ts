import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefuseRemoteRead, RefuseWrite, ReadJsonAsync } from '../src/server/Guard.ts'
import { Readable } from 'node:stream'

/** A request as the guard sees it, from this machine over localhost unless overridden. */
function request(overrides: Record<string, unknown> = {}): Parameters<typeof RefuseWrite>[0]
{
    return {
        socket: { remoteAddress: '127.0.0.1' },
        headers: { host: 'localhost:5190', 'content-type': 'application/json' },
        ...overrides,
    } as Parameters<typeof RefuseWrite>[0]
}

test('A write from this machine over localhost is accepted', () =>
{
    assert.equal(RefuseWrite(request()), null)
})

test('A write from another machine or host is refused unless started with --allow-writes', () =>
{
    const fromLan = request({ socket: { remoteAddress: '192.168.1.20' } })
    const otherHost = request({ headers: { host: 'my-laptop.example', 'content-type': 'application/json' } })

    assert.match(RefuseWrite(fromLan)!, /machine running Codespace/)
    assert.match(RefuseWrite(otherHost)!, /reached as localhost/)
    assert.equal(RefuseWrite(fromLan, true), null)
    assert.equal(RefuseWrite(otherHost, true), null)
})

test('Even allowing any machine, a cross-site or non-JSON request is refused', () =>
{
    const crossSite = request({ headers: { host: 'localhost:5190', origin: 'https://evil.example', 'content-type': 'application/json' } })
    const noJson = request({ headers: { host: 'localhost:5190', 'content-type': 'text/plain' } })
    assert.match(RefuseWrite(crossSite, true)!, /Cross-site/)
    assert.match(RefuseWrite(noJson, true)!, /Send JSON/)
})

test('Behind a proxy, the forwarded host is what the origin is compared with', () =>
{
    const forwarded = request({ headers: { host: '127.0.0.1:5190', 'x-forwarded-host': 'my-laptop.example', origin: 'https://my-laptop.example', 'content-type': 'application/json' } })
    assert.equal(RefuseWrite(forwarded, true), null)
})

test('The folder picker is only available on this machine, over localhost', () =>
{
    assert.equal(RefuseRemoteRead(request()), null)
    assert.match(RefuseRemoteRead(request({ headers: { host: 'my-laptop.example' } }))!, /on this machine/)
    assert.match(RefuseRemoteRead(request({ socket: { remoteAddress: '192.168.1.20' } }))!, /machine running Codespace/)
    assert.match(RefuseRemoteRead(request({ headers: { host: 'evil.example' } }))!, /on this machine/)
})

/** A request body as the JSON reader sees it. */
function bodyRequest(body: string | Buffer): Parameters<typeof ReadJsonAsync>[0]
{
    return Readable.from([Buffer.from(body)]) as unknown as Parameters<typeof ReadJsonAsync>[0]
}

test('The JSON reader treats an empty body and a list as no change', async () =>
{
    assert.deepEqual(await ReadJsonAsync(bodyRequest('')), {})
    assert.deepEqual(await ReadJsonAsync(bodyRequest('[]')), {})
    assert.deepEqual(await ReadJsonAsync(bodyRequest('{"files": {}}')), { files: {} })
})

test('The JSON reader refuses malformed JSON and a body over its limit', async () =>
{
    await assert.rejects(ReadJsonAsync(bodyRequest('{ not json')), /JSON|Unexpected|Expected/)
    await assert.rejects(ReadJsonAsync(bodyRequest(Buffer.alloc(300 * 1024, 'x'))), /too large/)
})
