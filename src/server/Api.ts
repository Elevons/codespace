import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Chat } from '../agent/Chat.ts'
import { Architecture, type IArchitecturePatch } from '../repo/Architecture.ts'
import { ConceptsGuide } from '../repo/ConceptsGuide.ts'
import { ConceptsDriftAsync, ConceptsLeft, ConceptsNextAsync, DefaultConceptsSize, ReadPage, RecordAppliedAsync } from '../repo/Concepts.ts'
import { DescribeGuide } from '../repo/DescribeGuide.ts'
import { DraftTour, NormaliseFlow, ReadFlowsAsync, WriteFlowsAsync } from '../repo/Flows.ts'
import { Graph } from '../repo/Graph.ts'
import { ScanSecretsAsync, Survey } from '../repo/Health.ts'
import { JsonStore } from '../repo/JsonStore.ts'
import { Neighbours } from '../repo/Neighbours.ts'
import { ClampSize, DefaultBatch, StatusAsync } from '../repo/Ingest.ts'
import { TakeNextAsync } from '../repo/Next.ts'
import { DefaultRefineSize, Refine } from '../repo/Refine.ts'
import { RefineGuide } from '../repo/RefineGuide.ts'
import { MaxFileNote, MaxNote, MaxShown, MaxTitle } from '../repo/ShowLimits.ts'
import { Snapshot } from '../repo/Snapshot.ts'
import { ReadJsonAsync, RefuseOutside, RefuseWrite, SendJson } from './Guard.ts'
import { MapTools, RepoQueryDescription, type IToolList } from './Tools.ts'
import type { IShownFile } from './View.ts'
import type { Workspace } from './Workspace.ts'
import { MaxFlows } from '../../public/flows.ts'
import type { IHealthAnswer } from '../../public/health.ts'
import { ClampNeighbourDepth } from '../../public/neighbours.ts'
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
                concepts: ConceptsLeft(architecture, await ConceptsDriftAsync(repo, architecture)),
                prompt: `${DescribeGuide(this.cli, repo.Root)}\n\n${RefineGuide(this.cli, repo.Root)}\n\n${ConceptsGuide(this.cli, repo.Root)}`,
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
        else if (path === '/api/concepts' && reading)
        {
            const repo = workspace.repo
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            const size = ClampSize(url.searchParams.get('size'), DefaultConceptsSize)
            const page = ReadPage(url.searchParams.get('page'))
            SendJson(response, 200, { name: repo.Name, root: repo.Root, ...await ConceptsNextAsync(repo, architecture, await Graph.BuildAsync(repo), size, this.cli, page) })
        }
        else if (path === '/api/health' && reading)
        {
            const repo = workspace.repo
            const snapshot = await Snapshot.ReadAsync(repo)
            const architecture = await Architecture.ReadAsync(repo.Root, snapshot.files)
            const report = Survey(architecture, snapshot.edges, snapshot.lines, snapshot.files)
            const scan = await ScanSecretsAsync(snapshot.files, (file) => repo.ReadFileAsync(file))
            const answer: IHealthAnswer = { ...report, secrets: scan.findings, scanned: scan.scanned }
            SendJson(response, 200, { ok: true, ...answer })
        }
        else if (path === '/api/neighbours' && reading)
        {
            const snapshot = await Snapshot.ReadAsync(workspace.repo)
            const file = url.searchParams.get('path') ?? ''
            if (!snapshot.files.includes(file)) { SendJson(response, 400, { error: `"${file}" is not a file in the repository.` }); return true }
            const depth = ClampNeighbourDepth(url.searchParams.get('depth'))
            const neighbours = Neighbours(snapshot.edges, file, depth)
            SendJson(response, 200, { ok: true, path: file, depth, paths: neighbours.map((item) => item.path), neighbours })
        }
        else if (path === '/api/flows' && reading)
        {
            try
            {
                const repo = workspace.repo
                const draft = url.searchParams.get('draft')
                if (draft !== null && draft !== '0' && draft !== 'false')
                {
                    const snapshot = await Snapshot.ReadAsync(repo)
                    const architecture = await Architecture.ReadAsync(repo.Root, snapshot.files)
                    SendJson(response, 200, { ok: true, flow: DraftTour(architecture, snapshot.edges, repo.Name) })
                }
                else SendJson(response, 200, { ok: true, flows: await ReadFlowsAsync(repo.Root) })
            }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }) }
        }
        else if (path === '/api/view' && reading) SendJson(response, 200, { shown: view.Shown, isolated: view.Isolated, selected: view.Selected })
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
        else if ((path === '/api/architecture' || path === '/api/view' || path === '/api/flows' || path === '/api/ingest/next') && request.method === 'POST')
        {
            const refusal = RefuseWrite(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            let body: Record<string, unknown>
            try { body = await ReadJsonAsync(request) }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }); return true }
            try
            {
                if (path === '/api/architecture') await this.UpdateArchitectureAsync(response, body, workspace)
                else if (path === '/api/flows') await this.ChangeFlowsAsync(response, body, workspace)
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
        await RecordAppliedAsync(repo, body as IArchitecturePatch, updated.architecture)
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
     * Saves, deletes, or shows one saved flow. Showing a flow lights its files the way a tool's show
     * does, so every open page follows it.
     * @param response the response to write
     * @param body the request, as sent
     * @param workspace the repository whose flows it changes
     */
    private async ChangeFlowsAsync(response: ServerResponse, body: Record<string, unknown>, workspace: Workspace): Promise<void>
    {
        const repo = workspace.repo
        const name = typeof body.name === 'string' ? body.name.trim() : ''
        if (body.action === 'save')
        {
            const flow = NormaliseFlow(body.flow, new Set(await repo.ListFilesAsync()))
            const flows = await JsonStore.RunAsync(repo.Root, async () =>
            {
                const current = await ReadFlowsAsync(repo.Root)
                const next = [...current.filter((item) => item.name.toLowerCase() !== flow.name.toLowerCase()), flow]
                if (next.length > MaxFlows) throw new Error(`A repository keeps at most ${MaxFlows} flows; delete one first.`)
                await WriteFlowsAsync(repo.Root, next)
                return next
            })
            SendJson(response, 200, { ok: true, saved: flow.name, flows })
        }
        else if (body.action === 'delete')
        {
            if (name === '') throw new Error('Give the flow to delete as "name".')
            const result = await JsonStore.RunAsync(repo.Root, async () =>
            {
                const current = await ReadFlowsAsync(repo.Root)
                const next = current.filter((item) => item.name.toLowerCase() !== name.toLowerCase())
                const removed = next.length !== current.length
                if (removed) await WriteFlowsAsync(repo.Root, next)
                return { flows: next, removed }
            })
            SendJson(response, 200, { ok: true, deleted: result.removed, flows: result.flows })
        }
        else if (body.action === 'show')
        {
            if (name === '') throw new Error('Give the flow to show as "name".')
            const flows = await ReadFlowsAsync(repo.Root)
            const flow = flows.find((item) => item.name.toLowerCase() === name.toLowerCase())
            if (flow === undefined) throw new Error(`There is no flow named "${name}".`)
            const checked = NormaliseFlow(flow, new Set(await repo.ListFilesAsync()))
            workspace.view.Show({ files: checked.files, trace: checked.trace, title: checked.title, note: checked.note })
            SendJson(response, 200, { ok: true, shown: checked.files.length, unknown: [] })
        }
        else throw new Error('action must be "save", "delete", or "show".')
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
     * Shows files, isolates files, focuses one, or clears what is shown.
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
        else if (body.action === 'isolate')
        {
            const listed = Array.isArray(body.files) ? body.files.slice(0, MaxShown) : []
            const requested = listed.map((item) => typeof item === 'string' ? item : (item as { path?: unknown })?.path).filter((path): path is string => typeof path === 'string')
            if (requested.length === 0)
            {
                view.Isolate(null)
                SendJson(response, 200, { ok: true, isolated: 0, unknown: [] })
                return
            }
            const files: string[] = []
            const unknown: string[] = []
            for (const path of requested) if (known.has(path)) { if (!files.includes(path)) files.push(path) } else unknown.push(path)
            if (files.length === 0) throw new Error('None of those paths are files in the repository.')
            view.Isolate(files)
            SendJson(response, 200, { ok: true, isolated: files.length, unknown })
        }
        else if (body.action === 'select')
        {
            const listed = Array.isArray(body.files) ? body.files.slice(0, MaxShown) : []
            const requested = listed.map((item) => typeof item === 'string' ? item : (item as { path?: unknown })?.path).filter((path): path is string => typeof path === 'string')
            const files: string[] = []
            const unknown: string[] = []
            for (const path of requested) if (known.has(path)) { if (!files.includes(path)) files.push(path) } else unknown.push(path)
            if (files.length === 0) throw new Error('None of those paths are files in the repository.')
            // The selection draws its own import wires, so a route the map was showing steps aside.
            view.Clear()
            view.Select(files)
            SendJson(response, 200, { ok: true, selected: files.length, unknown })
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
        else throw new Error('action must be "show", "isolate", "select", "focus", or "clear".')
    }
}
