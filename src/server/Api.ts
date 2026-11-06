import type { IncomingMessage, ServerResponse } from 'node:http'
import { Architecture, type IArchitecturePatch } from '../repo/Architecture.ts'
import { Graph } from '../repo/Graph.ts'
import { ReadJsonAsync, RefuseWrite } from './Guard.ts'
import { CreateTools, HttpCall, Respond, type IRpcMessage, type ITool } from '../mcp/McpTools.ts'
import type { Repo } from '../repo/Repo.ts'
import type { IShownFile, View } from './View.ts'

/** The most files one show request may name. */
const MaxShown = 60

/** The longest note on a file, a title, and an overall note, in characters. */
const MaxFileNote = 600
const MaxTitle = 120
const MaxNote = 1500

/** The endpoints tools and the page use to read the architecture and change what the map shows. */
export class Api
{
    /** The repository being mapped. */
    private readonly repo: Repo

    /** What the map is showing, and the pages watching it. */
    private readonly view: View

    /** The MCP tools, which reach these same endpoints over loopback. */
    private readonly tools: readonly ITool[]

    /**
     * Prepares the endpoints.
     * @param repo the repository being mapped
     * @param view what the map is showing
     * @param baseUrl where this server can be reached from the machine it runs on, for the MCP tools
     */
    public constructor(repo: Repo, view: View, baseUrl: string)
    {
        this.repo = repo
        this.view = view
        this.tools = CreateTools(HttpCall(baseUrl, 'Codespace could not reach itself.'))
    }

    /**
     * Answers one request if it is for these endpoints.
     * @param request the incoming request
     * @param response the response to write
     * @param url the request's URL
     * @returns whether the request was one of these endpoints, and so has been answered
     */
    public async HandleAsync(request: IncomingMessage, response: ServerResponse, url: URL): Promise<boolean>
    {
        const path = url.pathname
        const reading = request.method === 'GET' || request.method === 'HEAD'

        if (path === '/api/architecture' && reading)
        {
            Api.SendJson(response, 200, await Architecture.ReadAsync(this.repo.Root, await this.repo.ListFilesAsync()))
        }
        else if (path === '/api/graph' && reading)
        {
            const graph = await Graph.BuildAsync(this.repo)
            Api.SendJson(response, 200, { edges: graph.Edges(url.searchParams.get('folder') ?? '') })
        }
        else if (path === '/mcp') await this.HandleMcpAsync(request, response)
        else if (path === '/api/view' && reading) Api.SendJson(response, 200, { shown: this.view.Shown })
        else if (path === '/api/view/events' && reading) this.view.Subscribe(response)
        else if ((path === '/api/architecture' || path === '/api/view') && request.method === 'POST')
        {
            const refusal = RefuseWrite(request)
            if (refusal !== null) { Api.SendJson(response, 403, { error: refusal }); return true }
            let body: Record<string, unknown>
            try { body = await ReadJsonAsync(request) }
            catch (error) { Api.SendJson(response, 400, { error: (error as Error).message }); return true }
            try
            {
                if (path === '/api/architecture') await this.UpdateArchitectureAsync(response, body)
                else await this.ChangeViewAsync(response, body)
            }
            catch (error) { Api.SendJson(response, 400, { error: (error as Error).message }) }
        }
        else return false
        return true
    }

    /**
     * Speaks MCP over HTTP, so an agent can use the tools with nothing to start but this server.
     * Each POST carries one JSON-RPC message and gets its answer back as JSON.
     * @param request the incoming request
     * @param response the response to write
     */
    private async HandleMcpAsync(request: IncomingMessage, response: ServerResponse): Promise<void>
    {
        if (request.method !== 'POST')
        {
            response.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json; charset=utf-8' })
            response.end(JSON.stringify({ error: 'The MCP endpoint takes POSTs of JSON-RPC messages.' }))
            return
        }
        // The tools can change the architecture file, so this is held to the same rule as any change.
        const refusal = RefuseWrite(request)
        if (refusal !== null) { Api.SendJson(response, 403, { error: refusal }); return }
        let message: IRpcMessage
        try { message = await ReadJsonAsync(request) as IRpcMessage }
        catch { Api.SendJson(response, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }); return }
        const reply = await Respond(message, this.tools)
        if (reply === null) { response.writeHead(202); response.end() }
        else Api.SendJson(response, 200, reply)
    }

    /**
     * Changes the architecture file, and tells the pages to read it again.
     * @param response the response to write
     * @param body the change, as sent
     */
    private async UpdateArchitectureAsync(response: ServerResponse, body: Record<string, unknown>): Promise<void>
    {
        const updated = await Architecture.UpdateAsync(this.repo.Root, await this.repo.ListFilesAsync(), body as IArchitecturePatch)
        this.view.ArchitectureChanged()
        Api.SendJson(response, 200, updated)
    }

    /**
     * Shows files, focuses one, or clears what is shown.
     * @param response the response to write
     * @param body the request, as sent
     */
    private async ChangeViewAsync(response: ServerResponse, body: Record<string, unknown>): Promise<void>
    {
        const known = new Set(await this.repo.ListFilesAsync())

        if (body.action === 'clear')
        {
            this.view.Clear()
            Api.SendJson(response, 200, { ok: true })
        }
        else if (body.action === 'focus')
        {
            const path = typeof body.path === 'string' ? body.path.replace(/^\.?\/+|\/+$/g, '') : ''
            const isFolder = path === '' || [...known].some((file) => file.startsWith(path + '/'))
            if (!known.has(path) && !isFolder) throw new Error(`"${path}" is not a file or folder in the repository.`)
            this.view.Focus(path)
            Api.SendJson(response, 200, { ok: true })
        }
        else if (body.action === 'show')
        {
            const files: IShownFile[] = []
            const unknown: string[] = []
            for (const item of Array.isArray(body.files) ? body.files.slice(0, MaxShown) : [])
            {
                const path = typeof item === 'string' ? item : (item as { path?: unknown })?.path
                const note = typeof item === 'object' && item !== null && typeof (item as { note?: unknown }).note === 'string' ? (item as { note: string }).note : ''
                if (typeof path !== 'string') continue
                if (known.has(path)) files.push({ path, note: note.slice(0, MaxFileNote) })
                else unknown.push(path)
            }
            if (files.length === 0) throw new Error('None of those paths are files in the repository.')
            this.view.Show({
                files, trace: body.trace === true,
                title: typeof body.title === 'string' ? body.title.slice(0, MaxTitle) : '',
                note: typeof body.note === 'string' ? body.note.slice(0, MaxNote) : '',
            })
            Api.SendJson(response, 200, { ok: true, shown: files.length, unknown })
        }
        else throw new Error('action must be "show", "focus", or "clear".')
    }

    /**
     * Sends one JSON response.
     * @param response the response to write
     * @param status the HTTP status
     * @param body the value to send
     */
    private static SendJson(response: ServerResponse, status: number, body: unknown): void
    {
        response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-cache' })
        response.end(JSON.stringify(body))
    }
}
