import { createInterface } from 'node:readline'
import { CreateTools, HttpCall, Respond, type IRpcMessage } from './McpTools.ts'

// The same tools the running server offers at /mcp, for an agent that can only start a program and
// talk to it over stdio. They reach the running Codespace over HTTP. Changes are only accepted when
// it is reached as localhost.
const BaseUrl = process.env.CODESPACE_URL ?? 'http://127.0.0.1:5190'
const Tools = CreateTools(HttpCall(BaseUrl, `Cannot reach Codespace at ${BaseUrl}. Start it with "npm start" in its folder, or set CODESPACE_URL.`))

/**
 * Sends one JSON-RPC message to the agent.
 * @param message the message
 */
function Send(message: unknown): void
{
    process.stdout.write(JSON.stringify(message) + '\n')
}

// Each line on stdin is one message. Requests get an answer; notifications do not.
const lines = createInterface({ input: process.stdin })
lines.on('line', (line) =>
{
    if (line.trim() === '') return
    let message: IRpcMessage
    try { message = JSON.parse(line) }
    catch { Send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
    void Respond(message, Tools).then((reply) => { if (reply !== null) Send(reply) })
})
