import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { IArchitecture } from '../src/repo/Architecture.ts'
import { OversizedLines, ScanSecretsAsync, SecretsIn, ShippedPath, Survey } from '../src/repo/Health.ts'
import { makeRepo, removeTemp, send, startApi } from './support.ts'

function architecture(): IArchitecture
{
    return {
        layers: ['base', 'ui'],
        systems: { app: { summary: 'The application.' } },
        files: {
            'src/base.ts': { system: 'app', layer: 'base', tags: ['core'], summary: 'The base.' },
            'src/ui.ts': { system: 'app', layer: 'ui', tags: ['ui'], summary: 'The screen.' },
            'src/orphan.ts': { system: 'app', layer: 'ui', tags: ['ui'] },
        },
        folders: {}, concepts: { things: {}, operations: {} },
        warnings: [],
        error: '',
    }
}

test('A survey counts the codebase and names what is worth a look', () =>
{
    const edges: Array<[string, string]> = [['src/base.ts', 'src/ui.ts'], ['src/ui.ts', 'src/base.ts']]
    const lines = { 'src/base.ts': OversizedLines + 100, 'src/ui.ts': 20, 'src/orphan.ts': 10 }
    const report = Survey(architecture(), edges, lines, ['src/base.ts', 'src/ui.ts', 'src/orphan.ts', 'README.md', 'package-lock.json'])

    assert.equal(report.files, 5)
    assert.equal(report.codeFiles, 3)
    assert.equal(report.lines, OversizedLines + 130)
    assert.equal(report.imports, 2)
    assert.equal(report.described, 2)
    assert.equal(report.undescribed, 2)
    assert.deepEqual(report.undescribedPaths, ['README.md', 'src/orphan.ts'])
    assert.equal(report.layerBreaks, 1)
    assert.equal(report.breakGroups[0]?.from, 'base')
    assert.equal(report.breakGroups[0]?.to, 'ui')
    assert.deepEqual(report.breakGroups[0]?.examples, [{ from: 'src/base.ts', to: 'src/ui.ts' }])
    assert.deepEqual(report.oversized, [{ path: 'src/base.ts', lines: OversizedLines + 100 }])
    assert.ok(report.notes.length > 0)
})

test('A survey of a tidy repository has nothing oversized and no breaks', () =>
{
    const report = Survey(architecture(), [['src/ui.ts', 'src/base.ts']], { 'src/base.ts': 10, 'src/ui.ts': 12 }, ['src/base.ts', 'src/ui.ts', 'src/orphan.ts'])
    assert.equal(report.layerBreaks, 0)
    assert.deepEqual(report.oversized, [])
    assert.deepEqual(report.breakGroups, [])
})

test('Secret-shaped values are found, and placeholders are left alone', () =>
{
    const text = [
        'const stripeSecret = "sk_live_abcdefgh"',
        'const apiKey = process.env.API_KEY',
        'const password = "changeme"',
        'const token = "xy"',
        'const accessKeyId = "AKIA12345678"',
        'const analyticsKey = "UA-123456-1"',
        'const keyCode = "ArrowUp"',
        'const sortKey = "name"',
    ].join('\n')
    const found = SecretsIn('public/app.js', text)
    assert.deepEqual(found.map((item) => [item.key, item.line]), [['stripeSecret', 1], ['accessKeyId', 5], ['analyticsKey', 6]])
    assert.ok(found.every((item) => !item.hint.includes('sk_live_abcdefgh')))
    assert.match(found[0]!.hint, /^sk_l…/)
})

test('Only files a browser can read are scanned for keys', () =>
{
    assert.equal(ShippedPath('public/app.ts'), true)
    assert.equal(ShippedPath('src/components/Button.tsx'), true)
    assert.equal(ShippedPath('index.html'), true)
    assert.equal(ShippedPath('src/server/Server.ts'), false)
    assert.equal(ShippedPath('tests/Api.test.ts'), false)
})

test('A scan reads the shipped files it can, and says how many it read', async () =>
{
    const files = ['public/app.js', 'src/server.ts', 'public/missing.js']
    const scan = await ScanSecretsAsync(files, async (path) =>
    {
        if (path === 'public/missing.js') throw new Error('Forbidden')
        return path === 'public/app.js' ? 'const api_key = "abcdefghij"\n' : 'const api_key = "abcdefghij"\n'
    })
    assert.equal(scan.scanned, 1)
    assert.deepEqual(scan.findings.map((item) => item.path), ['public/app.js'])
})

test('The health endpoint answers over HTTP and never sends a value back', async () =>
{
    const root = await makeRepo({
        'public/app.ts': 'const analyticsKey = "abcd1234efgh"\nexport const app = 1\n',
        'src/a.ts': 'export const a = 1\n',
        '.codespace/architecture.json': JSON.stringify({ layers: ['base'], files: { 'src/a.ts': { layer: 'base', summary: 'The value.' } } }),
    }, 'codespace-health-api-')
    const { port, stop } = await startApi(root)
    try
    {
        const health = await send(port, '/api/health')
        assert.equal(health.status, 200)
        assert.deepEqual(health.body.secrets.map((item: { path: string, key: string }) => [item.path, item.key]), [['public/app.ts', 'analyticsKey']])
        assert.equal(health.text.includes('abcd1234efgh'), false, 'the value is redacted')
        assert.equal(health.body.described, 1)
        assert.ok(health.body.undescribed >= 1)
        assert.ok(health.body.notes.length > 0)
    }
    finally { await stop(); await removeTemp(root) }
})
