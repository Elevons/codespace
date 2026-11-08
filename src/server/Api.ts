import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Chat } from '../agent/Chat.ts'
import { Architecture, type IArchitecturePatch } from '../repo/Architecture.ts'
import { Graph } from '../repo/Graph.ts'
import { StatusAsync } from '../repo/Ingest.ts'
import { Ledger } from '../repo/Ledger.ts'
import { Refine } from '../repo/Refine.ts'
import { RefineGuide } from '../repo/RefineGuide.ts'
import { Snapshot } from '../repo/Snapshot.ts'
import { ReadJsonAsync, RefuseOutside, RefuseWrite, SendJson } from './Guard.ts'
import type { IShownFile, View } from './View.ts'
import type { Workspace } from './Workspace.ts'

/** The most files one show request may name. */
const MaxShown = 60

/** The longest note on a file, a title, and an overall note, in characters. */
const MaxFileNote = 600
const MaxTitle = 120
const MaxNote = 1500

/**
 * What a person pastes into their agent, naming these same commands.
 * @param cli the CLI script's absolute path
 * @param root the repository's absolute path
 */
function PromptFor(cli: string, root: string): string
{
    return `Describe this repository for the Codespace map. Its CLI needs no server or MCP; run it from a shell:
  node --experimental-transform-types ${cli} status --repo ${root}
  node --experimental-transform-types ${cli} next --repo ${root}
First, once, run this so that whoever changes the repository later keeps the map true. It adds a short marked
note to the repository's AGENTS.md (creating one if there is none) and writes the rules to .codespace/README.md:
  node --experimental-transform-types ${cli} install --repo ${root}
Then write each batch to a JSON file and save it with:
  node --experimental-transform-types ${cli} apply --file batch.json --repo ${root}

A batch is one JSON object shaped like this:
{
  "systems": {
    "browser": { "summary": "The page: the 3D city and everything drawn and driven in the browser." },
    "server": { "summary": "The server side: reading repositories and serving the map." }
  },
  "layers": ["meta", "data", "api", "ui", "entry"],
  "files": {
    "public/main.ts": { "summary": "...", "system": "browser", "layer": "entry", "tags": ["entry"] },
    "public/panels.ts": { "summary": "...", "system": "browser", "layer": "ui", "tags": ["ui"] },
    "public/repo.ts": { "summary": "...", "system": "browser", "layer": "data", "tags": ["core", "io"] },
    "src/server/Api.ts": { "summary": "...", "system": "server", "layer": "api", "tags": ["orchestrate", "io"] }
  },
  "folders": { "public": { "summary": "The browser side of the map." } }
}

Three ideas, each answering a different question. Keep them apart:
- Folders are where files sit on disk. That is organization only, and the map already shows it.
  A folder is never a system or a layer by itself; give it just a summary.
- Layers are how high a file sits in the dependency stack: what may use what.
  A layer is a file's level or role in the stack — its job — not its system and not its folder.
  Imports point down the ladder: a file imports files on its own layer or lower, and a lower
  layer never imports a higher one. The map draws every import that points up as a red line,
  so each one you create is a mistake on the map.
- Systems are the app's functional parts, each with files across several layers: a browser,
  a server, a game loop, a build tool, a billing flow. Choose systems that still explain the
  code when their files live in unrelated folders. The map groups and filters the 3D scene by
  system and layer; until a repository declares systems, those controls stay hidden.

Placing files on layers:
- Declare the ladder once, bottom plane first, e.g.
  ["meta","config","data","domain","integration","security","tool","api","ui","entry","tests"],
  and give each file the single level it belongs to.
- Use the "imports" and "usedBy" lists that "next" prints. A file must sit at or above every
  file in its "imports", and at or below every file in its "usedBy". Files nothing uses (boot
  scripts, mains, CLIs) sit at the top; files that import nothing in the repository (types,
  constants, pure helpers) sit near the bottom.
- One system's files normally land on several layers: a browser's boot file is "entry", its
  panels are "ui", its API clients are "data", its pure helpers lower still. If every file in
  a system lands on one layer, or a layer's name repeats a system's name, the layering is
  wrong — pick the level from the file's role and imports, not from the folder it sits in.
- Layers are shared by every system: declare each once in "layers" and let it hold files from
  many systems. Do not declare the same layer once per system.
- Docs and config go on low layers of their own (e.g. "meta", "config"), since they import
  nothing. Tests import the code they test, so a "tests" layer goes above everything it imports,
  at the top of the ladder; put it lower and every test file is a red line on the map.

Rules:
- Every file entry needs all four: a one-sentence summary, a system, tags from entry/orchestrate/core/data/io/ui/config/test, and a layer.
- Declare a system or layer before a file uses it. A system or layer not listed is refused, and a system that files still use cannot be removed.
- If the architecture file declares no systems or layers yet, declare them in the first apply, as in the example above.
- "next" gives back the next batch plus the declared "systems" and "layers". Files come before folders, and each file's "missing" list says which of summary, system, layer, or tags it still needs. "next" also returns files that already have a summary but still lack a system, layer, or tags.
- The same loop updates a repository that was described before, so run it whenever the repository has changed; it only hands back what needs work. Each file has a "reason": "new", "changed" (its text is not what its entry was written from, and "current" shows that entry), or "incomplete". For a changed file, read it again: if its entry is still true, apply the same summary again to confirm it, otherwise rewrite what no longer fits. Before it reads anything, "next" moves the entry of a file that was moved (same text, new path) to its new path and drops the entries of files that were deleted.
- Describe every file a batch names, including tests and docs; generated and vendored files are already settled for you, so do not read them.
- Until the repository is fully described, the map draws only the files that already have an entry; describing a file makes it appear.
- Repeat until "status" reports "remaining": 0.
- If these commands fail, stop and say so rather than editing .codespace/architecture.json by hand.

${RefineGuide(cli, root)}`
}

/** The endpoints tools and the page use to read the architecture and change what the map shows. */
export class Api
{
    /** The repository being mapped. */
    private readonly workspace: Workspace

    /** What the map is showing, and the pages watching it. */
    private readonly view: View

    /** Whether changes are accepted from any machine, as started with --allow-writes. */
    private readonly allowWrites: boolean

    /** Where the ingest CLI lives, so the page can copy commands that work. */
    private readonly cli: string

    /** The chat built into the map, or null when this server has none. */
    private readonly chat: Chat | null

    /**
     * Prepares the endpoints.
     * @param workspace the repository being mapped
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     * @param cli the absolute path of the ingest CLI
     * @param chat the chat built into the map, if any
     */
    public constructor(workspace: Workspace, allowWrites = false, cli = 'src/cli/Cli.ts', chat: Chat | null = null)
    {
        this.chat = chat
        this.workspace = workspace
        this.allowWrites = allowWrites
        this.cli = cli
        this.view = workspace.view
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
            const repo = this.workspace.repo
            SendJson(response, 200, await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync()), request)
        }
        else if (path === '/api/graph' && reading)
        {
            const snapshot = await Snapshot.ReadAsync(this.workspace.repo)
            SendJson(response, 200, { edges: Graph.EdgesUnder(snapshot.edges, url.searchParams.get('folder') ?? '') }, request)
        }
        else if (path === '/api/ingest/status' && reading)
        {
            const repo = this.workspace.repo
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            const status = await StatusAsync(repo, architecture)
            // The second pass only has something to say once the first is done.
            const refine = status.remaining === 0 ? Refine(architecture, (await Snapshot.ReadAsync(repo)).edges, 1) : null
            SendJson(response, 200, {
                ...status,
                described: Object.values(architecture.files).filter((entry) => entry.summary !== undefined).length,
                refine: refine === null ? { remaining: 0, breaks: 0 } : { remaining: refine.remaining, breaks: refine.breakCount },
                prompt: PromptFor(this.cli, repo.Root),
            })
        }
        else if (path === '/api/view' && reading) SendJson(response, 200, { shown: this.view.Shown })
        else if (path === '/api/view/events' && reading) this.view.Subscribe(response, RefuseOutside(request, this.allowWrites) === null)
        else if (path === '/api/chat' && this.chat !== null)
        {
            // The chat runs commands in the repository, so even reading it is kept to this machine.
            const refusal = reading ? RefuseOutside(request, this.allowWrites) : RefuseWrite(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            if (reading) { SendJson(response, 200, await this.chat.StateAsync()); return true }
            if (request.method !== 'POST') { SendJson(response, 405, { error: 'The chat takes GET or POST.' }); return true }
            try { await this.ChangeChatAsync(this.chat, await ReadJsonAsync(request)); SendJson(response, 200, { ok: true }) }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }) }
        }
        else if ((path === '/api/architecture' || path === '/api/view') && request.method === 'POST')
        {
            const refusal = RefuseWrite(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            let body: Record<string, unknown>
            try { body = await ReadJsonAsync(request) }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }); return true }
            try
            {
                if (path === '/api/architecture') await this.UpdateArchitectureAsync(response, body)
                else await this.ChangeViewAsync(response, body)
            }
            catch (error) { SendJson(response, 400, { error: (error as Error).message }) }
        }
        else if (path === '/api/architecture' && request.method === 'DELETE')
        {
            const refusal = RefuseWrite(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return true }
            try
            {
                await Architecture.DeleteAsync(this.workspace.repo.Root)
                this.view.ArchitectureChanged()
                const repo = this.workspace.repo
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
     */
    private async UpdateArchitectureAsync(response: ServerResponse, body: Record<string, unknown>): Promise<void>
    {
        const repo = this.workspace.repo
        const updated = await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), body as IArchitecturePatch)
        await Ledger.RecordAsync(repo, Object.keys((body as IArchitecturePatch).files ?? {}))
        this.view.ArchitectureChanged()
        SendJson(response, 200, updated)
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
     */
    private async ChangeViewAsync(response: ServerResponse, body: Record<string, unknown>): Promise<void>
    {
        const known = new Set(await this.workspace.repo.ListFilesAsync())

        if (body.action === 'clear')
        {
            this.view.Clear()
            SendJson(response, 200, { ok: true })
        }
        else if (body.action === 'focus')
        {
            const path = typeof body.path === 'string' ? body.path.replace(/^\.?\/+|\/+$/g, '') : ''
            const isFolder = path === '' || [...known].some((file) => file.startsWith(path + '/'))
            if (!known.has(path) && !isFolder) throw new Error(`"${path}" is not a file or folder in the repository.`)
            this.view.Focus(path)
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
            this.view.Show({
                files, trace: body.trace === true,
                title: typeof body.title === 'string' ? body.title.slice(0, MaxTitle) : '',
                note: typeof body.note === 'string' ? body.note.slice(0, MaxNote) : '',
            })
            SendJson(response, 200, { ok: true, shown: files.length, unknown })
        }
        else throw new Error('action must be "show", "focus", or "clear".')
    }
}
