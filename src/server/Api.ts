import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Chat } from '../agent/Chat.ts'
import { Architecture, type IArchitecturePatch } from '../repo/Architecture.ts'
import { DescribeGuide } from '../repo/DescribeGuide.ts'
import { Graph } from '../repo/Graph.ts'
import { ClampSize, DefaultBatch, StatusAsync } from '../repo/Ingest.ts'
import { Ledger } from '../repo/Ledger.ts'
import { TakeNextAsync } from '../repo/Next.ts'
import { DefaultRefineSize, Refine } from '../repo/Refine.ts'
import { RefineGuide } from '../repo/RefineGuide.ts'
import { MaxFileNote, MaxNote, MaxShown, MaxTitle } from '../repo/ShowLimits.ts'
import { Snapshot } from '../repo/Snapshot.ts'
import { ReadJsonAsync, RefuseOutside, RefuseWrite, SendJson } from './Guard.ts'
import { MapTools, RepoQueryDescription, type IToolList } from './Tools.ts'
import type { IShownFile } from './View.ts'
import type { Workspace } from './Workspace.ts'
import type { IIngestStatus } from '../../public/ingest.ts'

/** The endpoints tools and the page use to read the architecture and change what the map shows. */
export class Api
{
    /** Whether changes are accepted from any machine, as started with --allow-writes. */
    private readonly allowWrites: boolean

    /** Where the ingest CLI lives, so the page can copy commands that work. */
    private readonly cli: string

    /** The chat built into the map, or null when this server has none. */
    private readonly chat: Chat | null

    /**
     * Prepares the endpoints.
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     * @param cli the absolute path of the ingest CLI
     * @param chat the chat built into the map, if any
     */
    public constructor(allowWrites = false, cli = 'src/cli/Cli.ts', chat: Chat | null = null)
    {
        this.chat = chat
        this.allowWrites = allowWrites
        this.cli = cli
    }

    /** Whether this server runs the built-in chat. */
    public get HasChat(): boolean
    {
        return this.chat !== null
    }

    /**
     * Answers one request if it is for these endpoints.
     * @param request the incoming request
     * @param response the response to write
     * @param url the request's URL
     * @param workspace the repository the request reads, its own ?repo= or the server's
     * @returns whether the request was one of these endpoints, and so has been answered
     */
    public async HandleAsync(request: IncomingMessage, response: ServerResponse, url: URL, workspace: Workspace): Promise<boolean>
    {
        const path = url.pathname
        const view = workspace.view
        const reading = request.method === 'GET' || request.method === 'HEAD'

        if (path === '/api/tools' && reading)
        {
            const body: IToolList = { version: 1, repoQuery: { name: 'repo', description: RepoQueryDescription }, tools: [...MapTools] }
            SendJson(response, 200, body, request)
        }
        else if (path === '/api/architecture' && reading)
        {
            const repo = workspace.repo
            SendJson(response, 200, await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync()), request)
        }
        else if (path === '/api/graph' && reading)
        {
            const snapshot = await Snapshot.ReadAsync(workspace.repo)
            SendJson(response, 200, { edges: Graph.EdgesUnder(snapshot.edges, url.searchParams.get('folder') ?? '') }, request)
        }
        else if (path === '/api/ingest/status' && reading)
        {
            const repo = workspace.repo
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            const status = await StatusAsync(repo, architecture)
            // The second pass only has something to say once the first is done.
            const refine = status.remaining === 0 ? Refine(architecture, (await Snapshot.ReadAsync(repo)).edges, 1) : null
            const body: IIngestStatus = {
                ...status,
                described: Object.values(architecture.files).filter((entry) => entry.summary !== undefined).length,
                refine: refine === null ? { remaining: 0, breaks: 0 } : { remaining: refine.remaining, breaks: refine.breakCount },
                prompt: `${DescribeGuide(this.cli, repo.Root)}\n\n${RefineGuide(this.cli, repo.Root)}`,
            }
            SendJson(response, 200, body)
        }
        else if (path === '/api/ingest/refine' && reading)
        {
            const repo = workspace.repo
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            const size = ClampSize(url.searchParams.get('size'), DefaultRefineSize)
            SendJson(response, 200, { name: repo.Name, root: repo.Root, ...Refine(architecture, (await Snapshot.ReadAsync(repo)).edges, size) })
        }
        else if (path === '/api/view' && reading) SendJson(response, 200, { shown: view.Shown })
        else if (path === '/api/view/events' && reading) view.Subscribe(response, RefuseOutside(request, this.allowWrites) === null)
        else if (path === '/api/chat' && (this.chat === null || workspace.pinned)) SendJson(response, 404, { error: this.chat === null ? 'This server was started without the chat.' : "The chat reads only the server's own repository, not one opened with ?repo=." })
        else if (path === '/api/chat')
        {
            const chat = this.chat!
            // The chat runs commands in the repository, so even reading it is kept to this machine.
            const refusal = reading ? RefuseOutside(request, this.allowWrites) : RefuseWrite(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            if (reading) { SendJson(response, 200, await chat.StateAsync()); return true }
            if (request.method !== 'POST') { SendJson(response, 405, { error: 'The chat takes GET or POST.' }); return true }
            try { await this.ChangeChatAsync(chat, await ReadJsonAsync(request)); SendJson(response, 200, { ok: true }) }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }) }
        }
        else if ((path === '/api/architecture' || path === '/api/view' || path === '/api/ingest/next') && request.method === 'POST')
        {
            const refusal = RefuseWrite(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            let body: Record<string, unknown>
            try { body = await ReadJsonAsync(request) }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }); return true }
            try
            {
                if (path === '/api/architecture') await this.UpdateArchitectureAsync(response, body, workspace)
                else if (path === '/api/ingest/next') await this.SendNextAsync(response, body, workspace)
                else await this.ChangeViewAsync(response, body, workspace)
            }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }) }
        }
        else if (path === '/api/architecture' && request.method === 'DELETE')
        {
            const refusal = RefuseOutside(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            try
            {
                await Architecture.DeleteAsync(workspace.repo.Root)
                view.ArchitectureChanged()
                const repo = workspace.repo
                SendJson(response, 200, await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync()))
            }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }) }
        }
        else return false
        return true
    }

    /**
     * Changes the architecture file, and tells the pages to read it again.
     * @param response the response to write
     * @param body the change, as sent
     * @param workspace the repository it changes
     */
    private async UpdateArchitectureAsync(response: ServerResponse, body: Record<string, unknown>, workspace: Workspace): Promise<void>
    {
        const repo = workspace.repo
        const updated = await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), body as IArchitecturePatch)
        await Ledger.RecordAsync(repo, Object.keys((body as IArchitecturePatch).files ?? {}))
        workspace.view.ArchitectureChanged()
        SendJson(response, 200, updated)
    }

    /**
     * Hands out the next files or folders to describe, as the CLI's next does. It is a POST because it
     * can write: moved entries follow their files and generated files are settled.
     * @param response the response to write
     * @param body the request, as sent, with an optional size
     * @param workspace the repository to describe
     */
    private async SendNextAsync(response: ServerResponse, body: Record<string, unknown>, workspace: Workspace): Promise<void>
    {
        const repo = workspace.repo
        const batch = await TakeNextAsync(repo, ClampSize(body.size, DefaultBatch))
        workspace.view.ArchitectureChanged()
        SendJson(response, 200, { name: repo.Name, root: repo.Root, ...batch })
    }

    /**
     * Sends a message to the chat, stops its reply, starts a new chat (plain, or one that describes or
     * refines the repository), or reopens a past one.
     * @param chat the chat
     * @param body the request, as sent
     */
    private async ChangeChatAsync(chat: Chat, body: Record<string, unknown>): Promise<void>
    {
        if (body.action === 'send') await chat.SendAsync(typeof body.text === 'string' ? body.text : '')
        else if (body.action === 'stop') await chat.StopAsync()
        else if (body.action === 'new') await chat.NewAsync()
        else if (body.action === 'describe') await chat.DescribeAsync()
        else if (body.action === 'refine') await chat.RefineAsync()
        else if (body.action === 'open' && typeof body.id === 'string') await chat.ResumeAsync(body.id)
        else throw new Error('action must be "send", "stop", "new", "describe", "refine", or "open".')
    }

    /**
     * Shows files, focuses one, or clears what is shown.
     * @param response the response to write
     * @param body the request, as sent
     * @param workspace the repository whose map it changes
     */
    private async ChangeViewAsync(response: ServerResponse, body: Record<string, unknown>, workspace: Workspace): Promise<void>
    {
        const view = workspace.view
        const known = new Set(await workspace.repo.ListFilesAsync())

        if (body.action === 'clear')
        {
            view.Clear()
            SendJson(response, 200, { ok: true })
        }
        else if (body.action === 'focus')
        {
            const path = typeof body.path === 'string' ? body.path.replace(/^\.?\/+|\/+$/g, '') : ''
            const isFolder = path === '' || [...known].some((file) => file.startsWith(path + '/'))
            if (!known.has(path) && !isFolder) throw new Error(`"${path}" is not a file or folder in the repository.`)
            view.Focus(path)
            SendJson(response, 200, { ok: true })
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
            view.Show({
                files, trace: body.trace === true,
                title: typeof body.title === 'string' ? body.title.slice(0, MaxTitle) : '',
                note: typeof body.note === 'string' ? body.note.slice(0, MaxNote) : '',
            })
            SendJson(response, 200, { ok: true, shown: files.length, unknown })
        }
        else throw new Error('action must be "show", "focus", or "clear".')
    }
}
