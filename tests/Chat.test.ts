import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Chat, ChatLines, ToolDetail, type ChatEvent } from '../src/agent/Chat.ts'
import { ChatSettings, ChatStateKeys, makeTemp, removeTemp } from './support.ts'
import { Instructions } from '../src/agent/Instructions.ts'
import { DefaultBaseUrl, DefaultModel, ReadModelSettings } from '../src/agent/ModelSettings.ts'

test('With nothing set, the chat uses OpenRouter and the default model, and says it has no key', () =>
{
    const settings = ReadModelSettings({})
    assert.equal(settings.baseUrl, DefaultBaseUrl)
    assert.equal(settings.model, DefaultModel)
    assert.equal(settings.apiKey, undefined)
})

test('A key given directly wins over a key file, and the base URL loses its trailing slash', () =>
{
    const settings = ReadModelSettings({
        CODESPACE_MODEL_BASE_URL: 'http://127.0.0.1:8080/v1/',
        CODESPACE_MODEL_API_KEY: ' direct ',
        CODESPACE_MODEL_KEY_FILE: '/other/.env',
    }, () => { throw new Error('not read') })
    assert.equal(settings.baseUrl, 'http://127.0.0.1:8080/v1')
    assert.equal(settings.apiKey, 'direct')
})

test('A key is read by name from another program\'s env file, without the key in the source note', () =>
{
    const files: Record<string, string> = { '/bartleby/.env': 'OTHER=1\nMODEL_API_KEY=sk-test\n' }
    const settings = ReadModelSettings({ CODESPACE_MODEL_KEY_FILE: '/bartleby/.env' }, (path) => files[path]!)
    assert.equal(settings.apiKey, 'sk-test')
    assert.equal(settings.keySource, 'MODEL_API_KEY from /bartleby/.env')

    const missing = ReadModelSettings({ CODESPACE_MODEL_KEY_FILE: '/bartleby/.env', CODESPACE_MODEL_KEY_NAME: 'NOPE' }, (path) => files[path]!)
    assert.equal(missing.apiKey, undefined)
    assert.match(missing.keySource, /NOPE is not set/)
})

test('Pi\'s messages become the person\'s lines, the model\'s text, and a line per tool, marked when it failed', () =>
{
    const lines = ChatLines([
        { role: 'user', content: 'How do needs drain?' },
        { role: 'assistant', content: [
            { type: 'thinking', thinking: 'hidden' },
            { type: 'toolCall', id: 'a', name: 'grep', arguments: { pattern: 'UpdateNeeds' } },
            { type: 'toolCall', id: 'b', name: 'bash', arguments: { command: 'curl -s localhost:5190/api/view' } },
        ] },
        { role: 'toolResult', toolCallId: 'a', toolName: 'grep', content: [], isError: false },
        { role: 'toolResult', toolCallId: 'b', toolName: 'bash', content: [], isError: true },
        { role: 'assistant', content: [{ type: 'text', text: ' It is on the map. ' }] },
    ])
    assert.deepEqual(lines, [
        { role: 'user', text: 'How do needs drain?' },
        { role: 'tool', tool: 'grep', text: 'UpdateNeeds' },
        { role: 'error', tool: 'bash', text: 'curl -s localhost:5190/api/view' },
        { role: 'assistant', text: 'It is on the map.' },
    ])
})

test('A tool line names the command, path, or pattern, cut short', () =>
{
    assert.equal(ToolDetail('read', { path: 'src/a.ts' }), 'src/a.ts')
    assert.equal(ToolDetail('bash', { command: 'x'.repeat(400) }).length, 160)
    assert.equal(ToolDetail('ls', undefined), 'ls')
})

test('The agent is told where the repository, the map, and the CLI are', () =>
{
    const text = Instructions({ root: '/repo', mapUrl: 'http://localhost:6000', cli: '/cs/src/cli/Cli.ts' })
    assert.match(text, /3D map of the repository at \/repo/)
    assert.match(text, /http:\/\/localhost:6000\/api\/view/)
    assert.match(text, /\/cs\/src\/cli\/Cli\.ts next --repo \/repo/)
})

/** A stand-in pi session, so a test never contacts a model or writes a chat. */
function fakeSession(prompt: () => Promise<void>, messages: readonly unknown[] = [])
{
    const prompts: string[] = []
    const result = {
        sessionId: 'test-session',
        messages,
        prompts,
        aborted: false,
        disposed: false,
        prompt: async (text: string) => { prompts.push(text); await prompt() },
        abort: async () => { result.aborted = true },
        dispose: () => { result.disposed = true },
        subscribe: () => undefined,
        agent: { state: { errorMessage: undefined as string | undefined } },
    }
    return result
}

/** A chat over a temporary home, with the session factory stubbed. */
async function chatWith(session: ReturnType<typeof fakeSession> | (() => Promise<unknown>))
{
    const agentDir = await makeTemp('codespace-chat-')
    const events: ChatEvent[] = []
    let opens = 0
    const chat = new Chat(() => '/repo', { mapUrl: 'http://localhost:5199', cli: '/cs/Cli.ts' }, (event) => events.push(event), () => ChatSettings, {
        agentDir,
        openSession: async () =>
        {
            opens++
            return (typeof session === 'function' ? await session() : session) as never
        },
    })
    return { chat, events, agentDir, opens: () => opens }
}

test('An empty message is refused before a session is opened', async () =>
{
    const { chat, agentDir, opens } = await chatWith(fakeSession(async () => undefined))
    try
    {
        await assert.rejects(chat.SendAsync('   '), /empty/)
        assert.equal(opens(), 0)
        assert.equal((await chat.StateAsync()).busy, false)
    }
    finally { await removeTemp(agentDir) }
})

test('A reply marks the chat busy, a second message waits, and a stop ends it', async () =>
{
    let finish!: () => void
    const session = fakeSession(() => new Promise<void>((resolve) => { finish = resolve }), [{ role: 'user', content: 'hello' }])
    const { chat, events, agentDir } = await chatWith(session)
    try
    {
        await chat.SendAsync('hello')
        assert.deepEqual(session.prompts, ['hello'], 'the exact message reaches the session')
        const busy = await chat.StateAsync()
        assert.deepEqual(Object.keys(busy).sort(), ChatStateKeys)
        assert.equal(busy.busy, true)
        assert.equal(busy.current, 'test-session')
        assert.equal(busy.model, 'test at http://model.test')
        assert.equal(busy.problem, '')
        assert.deepEqual(busy.lines, [{ role: 'user', text: 'hello' }])
        await assert.rejects(chat.SendAsync('again'), /still under way/)

        await chat.StopAsync()
        assert.equal(session.aborted, true)
        finish()
        await new Promise((done) => setTimeout(done, 0))
        assert.equal((await chat.StateAsync()).busy, false)
        assert.deepEqual(events.map((event) => event.kind), ['start', 'end'])
    }
    finally { await removeTemp(agentDir) }
})

test('A new chat drops the open session and tells the page it changed', async () =>
{
    const session = fakeSession(() => new Promise<void>(() => undefined))
    const { chat, events, agentDir } = await chatWith(session)
    try
    {
        await chat.SendAsync('hello')
        await chat.NewAsync()
        assert.equal(session.disposed, true)
        assert.deepEqual(events.map((event) => event.kind), ['start', 'changed'])
        assert.equal((await chat.StateAsync()).current, '')
    }
    finally { await removeTemp(agentDir) }
})
