import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SummarizeBlocksAsync, type IBlockRequest, type PostJson } from '../src/agent/BlockSummaries.ts'
import type { IModelSettings } from '../src/agent/ModelSettings.ts'

const Settings: IModelSettings = {
    baseUrl: 'http://model.test/v1',
    model: 'a-model',
    apiKey: 'a-key',
    keySource: 'CODESPACE_MODEL_API_KEY',
    contextWindow: 131_072,
    maxTokens: 16_384,
}

function request(id: string, name: string, code: string): IBlockRequest
{
    return { id, kind: 'function', name, line: 4, endLine: 12, code }
}

/** A sender that answers with the given reply text and remembers what it was asked. */
function sender(reply: string): { post: PostJson, calls: Array<{ url: string, body: any, headers: Record<string, string> }> }
{
    const calls: Array<{ url: string, body: any, headers: Record<string, string> }> = []
    return {
        calls,
        post: async (url, body, headers) => { calls.push({ url, body, headers }); return reply },
    }
}

test('SummarizeBlocksAsync asks for every block without a comment and reads the answers by id', async () =>
{
    const { post, calls } = sender('```json\n{"summaries":[{"id":"b0","summary":"Counts the things."},{"id":"b1","summary":"Sorts what is left."}]}\n```')
    const answers = await SummarizeBlocksAsync([request('b0', 'Count', 'function Count() { ... }'), request('b1', 'Sort', 'function Sort() { ... }')], Settings, post)

    assert.deepEqual(answers, { b0: 'Counts the things.', b1: 'Sorts what is left.' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://model.test/v1/chat/completions')
    assert.equal(calls[0].headers.Authorization, 'Bearer a-key')
    assert.equal(calls[0].body.model, 'a-model')
    const sent = JSON.parse(calls[0].body.messages[1].content)
    assert.deepEqual(sent.map((block: { id: string, name: string }) => [block.id, block.name]), [['b0', 'Count'], ['b1', 'Sort']])
    assert.match(calls[0].body.messages[0].content, /says what the block is for/u)
})

test('A reply the shape does not fit leaves the blocks as they were', async () =>
{
    const replies = ['I think it counts things.', '{"summaries":"none"}', '{"summaries":[{"id":"nope","summary":"Unknown."}]}']
    for (const [at, reply] of replies.entries())
    {
        const { post } = sender(reply)
        const answers = await SummarizeBlocksAsync([request('b0', `Odd${at}`, `function Odd${at}() { ... }`)], Settings, post)
        assert.deepEqual(answers, {}, reply)
    }
})

test('A block already answered in this session is not sent again', async () =>
{
    const { post, calls } = sender('{"summaries":[{"id":"b0","summary":"Counts the things."}]}')
    const first = await SummarizeBlocksAsync([request('b0', 'CacheProbe', 'function CacheProbe() { return 1 }')], Settings, post)
    const second = await SummarizeBlocksAsync([request('b9', 'CacheProbe', 'function CacheProbe() { return 1 }')], Settings, post)
    assert.equal(first.b0, 'Counts the things.')
    assert.equal(second.b9, 'Counts the things.')
    assert.equal(calls.length, 1)
})

test('With no key the summarizer says so rather than guessing', async () =>
{
    const { post } = sender('{}')
    await assert.rejects(SummarizeBlocksAsync([request('b0', 'Count', 'function Count() {}')], { ...Settings, apiKey: undefined }, post), /No model is configured/u)
})
