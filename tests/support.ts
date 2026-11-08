import { createServer, request as httpRequest, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Chat } from '../src/agent/Chat.ts'
import { Api } from '../src/server/Api.ts'
import { Server as CodespaceServer } from '../src/server/Server.ts'
import { Workspace } from '../src/server/Workspace.ts'

/** Makes an empty temporary repository folder, named with the given prefix. */
export function makeTemp(prefix: string): Promise<string>
{
    return mkdtemp(join(tmpdir(), prefix))
}

/** Removes one or more temporary folders, and everything under them. */
export async function removeTemp(...roots: string[]): Promise<void>
{
    await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true })))
}

/**
 * Makes a temporary repository holding the given files.
 * @param files each repository-relative path and its text
 * @param prefix the temporary folder's prefix
 */
export async function makeRepo(files: Record<string, string>, prefix = 'codespace-repo-'): Promise<string>
{
    const root = await makeTemp(prefix)
    for (const [path, text] of Object.entries(files))
    {
        await mkdir(dirname(join(root, path)), { recursive: true })
        await writeFile(join(root, path), text)
    }
    return root
}

/** A running API over one repository, and how to call and stop it. */
export interface IApiHandle
{
    port: number
    workspace: Workspace
    api: Api
    stop: () => Promise<void>
}

/**
 * Starts the endpoints over a repository on an ephemeral local port.
 * @param root the repository folder
 * @param options the write rule, the CLI path the prompt names, and the chat to expose
 */
export async function startApi(root: string, options: { allowWrites?: boolean, cli?: string, chat?: Chat | null } = {}): Promise<IApiHandle>
{
    const workspace = await Workspace.OpenAsync(root)
    let api: Api
    const server: Server = createServer((req, res) =>
    {
        api.HandleAsync(req, res, new URL(req.url!, 'http://localhost'))
            .then((handled) => { if (!handled) { res.writeHead(404); res.end() } })
            .catch((error) => { res.writeHead(500); res.end(String(error)) })
    })
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const port = (server.address() as AddressInfo).port
    api = new Api(workspace, options.allowWrites ?? false, options.cli ?? 'src/cli/Cli.ts', options.chat ?? null)
    return { port, workspace, api, stop: () => new Promise((done) => { server.closeAllConnections(); server.close(() => done()) }) }
}

/** A running full server over one repository and one public folder, and how to call and stop it. */
export interface IServerHandle
{
    port: number
    workspace: Workspace
    stop: () => Promise<void>
}

/**
 * Starts the full map server on an ephemeral local port.
 * @param repoRoot the repository folder
 * @param publicRoot the folder holding the page and its assets
 * @param options the write rule and the address the chat's agent reaches the server at
 */
export async function startServer(repoRoot: string, publicRoot: string, options: { allowWrites?: boolean, mapUrl?: string } = {}): Promise<IServerHandle>
{
    const workspace = await Workspace.OpenAsync(repoRoot)
    const { http } = await CodespaceServer.CreateAsync(workspace, publicRoot, options.allowWrites ?? false, options.mapUrl ?? 'http://localhost:5190')
    await new Promise<void>((done) => http.listen(0, '127.0.0.1', done))
    const port = (http.address() as AddressInfo).port
    return { port, workspace, stop: () => new Promise((done) => { http.closeAllConnections(); http.close(() => done()) }) }
}

/** One HTTP answer: the status, the headers, the parsed JSON body (or null), and the raw text. */
export interface IResponse
{
    status: number
    headers: Record<string, string | string[] | undefined>
    body: any
    text: string
}

/**
 * Sends one request, with an optional JSON body, and returns the status, headers, text, and body.
 * @param port the port the API listens on
 * @param method the HTTP method
 * @param path the request path and query
 * @param body a value to send as JSON, or undefined for none
 * @param headers headers to add, which override the JSON content type
 */
export function request(port: number, method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<IResponse>
{
    return new Promise((done, fail) =>
    {
        const text = body === undefined ? undefined : JSON.stringify(body)
        const req = httpRequest({ host: '127.0.0.1', port, method, path, headers: { ...(text !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (res) =>
        {
            const chunks: Buffer[] = []
            res.on('data', (chunk) => chunks.push(chunk as Buffer))
            res.on('end', () =>
            {
                const raw = Buffer.concat(chunks).toString('utf8')
                const json = (res.headers['content-type'] ?? '').includes('application/json')
                done({ status: res.statusCode!, headers: res.headers, body: json && raw !== '' ? JSON.parse(raw) : null, text: raw })
            })
        })
        req.on('error', fail)
        req.end(text)
    })
}

/** Sends one GET request, returning the status, headers, text, and parsed JSON body. */
export function send(port: number, path: string, headers: Record<string, string> = {}): Promise<IResponse>
{
    return request(port, 'GET', path, undefined, headers)
}

/** Sends one GET request and returns the status, headers, and raw body, without decoding it. */
export function raw(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number, headers: Record<string, string | string[] | undefined>, body: Buffer }>
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

/** The model settings a test supplies, so nothing is read from the environment. */
export const ChatSettings = { baseUrl: 'http://model.test', model: 'test', apiKey: 'key', keySource: 'test', contextWindow: 1000, maxTokens: 100 }

/** The fields a chat's state has, sorted. */
export const ChatStateKeys = ['busy', 'chats', 'current', 'lines', 'model', 'problem']

/** Waits until a predicate holds, so a stream test does not depend on a fixed sleep. */
export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<void>
{
    const start = Date.now()
    while (!check())
    {
        if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the stream')
        await new Promise((done) => setTimeout(done, 10))
    }
}
