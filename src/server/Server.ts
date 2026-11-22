import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Api } from './Api.ts'
import { Chat } from '../agent/Chat.ts'
import { MaxBlocks, SummarizeBlocksAsync } from '../agent/BlockSummaries.ts'
import { ReadModelSettings } from '../agent/ModelSettings.ts'
import { ReadOption } from '../cli/Options.ts'
import { ReadJsonAsync, RefuseOutside, RefuseRemoteRead, RefuseWrite, SendJson } from './Guard.ts'
import { Architecture } from '../repo/Architecture.ts'
import { Blocks } from '../repo/Blocks.ts'
import { Graph } from '../repo/Graph.ts'
import { CodespaceFolder } from '../repo/JsonStore.ts'
import { Snapshot } from '../repo/Snapshot.ts'
import { Workspace, Workspaces, type IWorkspaceInfo } from './Workspace.ts'

/** Runs a command without a shell and resolves with its standard output. */
const Run = promisify(execFile)

const BrotliAsync = promisify(brotliCompress)
const GzipAsync = promisify(gzip)

/** The installed Babylon package, which the page loads from here instead of a CDN. */
const BabylonRoot = join(import.meta.dirname, '..', '..', 'node_modules', 'babylonjs')

/** The static types worth compressing; images and fonts are already compact. */
const Compressible = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg'])

/** The content type sent for each static file type. */
const ContentTypes: Readonly<Record<string, string>> = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.woff2': 'font/woff2',
}

/** Serves the map page and the small JSON API that feeds it. */
export class Server
{
    /** The server's own repository, which a page can switch, and those asked for with ?repo=. */
    private readonly workspaces: Workspaces

    /** The folder holding the map page and its index. */
    private readonly publicRoot: string

    /** The endpoints tools use to read the architecture and change what the map shows. */
    private readonly api: Api

    /** Whether changes are accepted from any machine, as started with --allow-writes. */
    private readonly allowWrites: boolean

    /** The compressed copy of each static file last sent, kept until the file changes. */
    private readonly compressed = new Map<string, { etag: string, body: Buffer }>()

    /**
     * Prepares one server.
     * @param workspaces the repositories to read
     * @param publicRoot the folder holding the page and index
     * @param api the endpoints for tools
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     */
    private constructor(workspaces: Workspaces, publicRoot: string, api: Api, allowWrites: boolean)
    {
        this.workspaces = workspaces
        this.publicRoot = publicRoot
        this.api = api
        this.allowWrites = allowWrites
    }

    /**
     * Builds a server without starting it, so a test can listen on its own port and stop it.
     * @param workspace the repository to read
     * @param publicRoot the folder holding the page and index
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     * @param mapUrl the address the chat's agent reaches this server at
     * @param withChat whether the server runs its built-in chat, which a host with its own agent turns off
     */
    public static async CreateAsync(workspace: Workspace, publicRoot: string, allowWrites = false, mapUrl = 'http://localhost:5190', withChat = true): Promise<{ server: Server, http: HttpServer }>
    {
        const cli = resolve(publicRoot, '..', 'src', 'cli', 'Cli.ts')
        const chat = withChat ? new Chat(() => workspace.repo.Root, { mapUrl, cli }, (event) => workspace.view.Chat(event)) : null
        const server = new Server(new Workspaces(workspace), publicRoot, new Api(allowWrites, cli, chat), allowWrites)
        const http = createServer((request, response) =>
        {
            server.HandleAsync(request, response).catch((error) =>
            {
                console.error(error)
                SendJson(response, 500, { error: error instanceof Error ? error.message : 'Server error' })
            })
        })
        return { server, http }
    }

    /**
     * Starts the map server.
     * @param repoPath the repository to read
     * @param publicRoot the folder holding the page and index
     * @param port the port to listen on
     * @param host the address to bind
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     * @param withChat whether to run the built-in chat
     */
    public static async StartAsync(repoPath: string, publicRoot: string, port: number, host: string, allowWrites = false, withChat = true): Promise<void>
    {
        const workspace = await Workspace.OpenAsync(repoPath)
        const { http } = await Server.CreateAsync(workspace, publicRoot, allowWrites, `http://localhost:${port}`, withChat)
        await new Promise<void>((done) => http.listen(port, host, done))
        console.log(`Codespace reading ${workspace.repo.Name} at ${workspace.repo.Root}`)
        console.log(`Open http://localhost:${port}`)
        if (host === '0.0.0.0') console.log(`On the LAN, open http://<this machine>:${port}`)
        if (allowWrites) console.log('Changes are accepted from any machine that can reach it (--allow-writes).')
        if (!withChat) console.log('The built-in chat is off (--no-chat).')
    }

    /**
     * Answers one request.
     * @param request the incoming request
     * @param response the response to write
     */
    private async HandleAsync(request: IncomingMessage, response: ServerResponse): Promise<void>
    {
        const url = new URL(request.url ?? '/', 'http://localhost')
        const pathname = decodeURIComponent(url.pathname)
        if (!url.pathname.startsWith('/api/'))
        {
            await this.SendStaticAsync(request, response, pathname)
            return
        }

        // A request may name its repository with ?repo=. Reading one already open is as open as reading the
        // server's own, but opening a new one reads a folder of this machine, so only this machine may ask.
        const repo = url.searchParams.get('repo')
        if (repo !== null && repo.trim() !== '' && !this.workspaces.IsOpen(repo))
        {
            const refusal = RefuseOutside(request, this.allowWrites)
            if (refusal !== null) { SendJson(response, 403, { error: `?repo= opens a repository only for this machine. ${refusal}` }); return }
        }
        let workspace: Workspace
        try { workspace = await this.workspaces.ForAsync(repo) }
        catch (error) { SendJson(response, 400, { error: `${repo} could not be opened: ${(error as Error).message}` }); return }

        if (await this.api.HandleAsync(request, response, url, workspace)) return

        if (url.pathname === '/api/repo')
        {
            if (request.method === 'GET' || request.method === 'HEAD') SendJson(response, 200, { ...this.InfoOf(workspace), build: await Server.BuildStampAsync(this.publicRoot) })
            else if (request.method === 'POST') await this.SwitchRepoAsync(request, response, workspace)
            else SendJson(response, 405, { error: 'The repository endpoint takes GET or POST.' })
            return
        }

        if (url.pathname === '/api/browse')
        {
            const refusal = RefuseRemoteRead(request)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return }
            await this.SendBrowseAsync(response, url.searchParams.get('path'), workspace)
            return
        }

        if (url.pathname === '/api/files')
        {
            SendJson(response, 200, { files: await workspace.repo.ListFilesAsync() }, request)
            return
        }

        if (url.pathname === '/api/bootstrap')
        {
            await this.SendBootstrapAsync(request, response, url.searchParams.get('since'), workspace)
            return
        }

        if (url.pathname === '/api/changes')
        {
            SendJson(response, 200, await Server.ReadChangesAsync(workspace.repo.Root))
            return
        }

        if (url.pathname === '/api/source')
        {
            await this.SendSourceAsync(response, url.searchParams.get('path'), workspace)
            return
        }

        if (url.pathname === '/api/blocks')
        {
            await this.SendBlocksAsync(response, url.searchParams.get('path'), workspace)
            return
        }

        if (url.pathname === '/api/blocks/summaries')
        {
            await this.SendBlockSummariesAsync(request, response, workspace)
            return
        }

        SendJson(response, 404, { error: 'Not found' })
    }

    /**
     * Sends everything the page needs to draw the repository in one response: its name, files,
     * architecture, imports, line counts, declarations, and changes. A page that already holds the
     * current version gets only the stamp back, so polling costs a stat per file and no more.
     * @param request the incoming request
     * @param response the response to write
     * @param since the change stamp the page already holds, if any
     * @param workspace the repository to send
     */
    private async SendBootstrapAsync(request: IncomingMessage, response: ServerResponse, since: string | null, workspace: Workspace): Promise<void>
    {
        const repo = workspace.repo
        const snapshot = await Snapshot.ReadAsync(repo)
        if (since !== null && since === snapshot.fingerprint)
        {
            SendJson(response, 200, { fingerprint: snapshot.fingerprint, unchanged: true })
            return
        }
        const [architecture, changes] = await Promise.all([
            Architecture.ReadAsync(repo.Root, snapshot.files),
            Server.ReadChangesAsync(repo.Root),
        ])
        SendJson(response, 200, {
            repo: this.InfoOf(workspace),
            fingerprint: snapshot.fingerprint,
            files: snapshot.files,
            architecture,
            edges: snapshot.edges,
            lines: snapshot.lines,
            symbols: snapshot.symbols,
            stamps: snapshot.stamps,
            importNames: snapshot.importNames,
            changes: changes.files,
        }, request)
    }

    /**
     * What a page is told about the repository it reads: its name, root, recent ones, whether it is pinned
     * by ?repo=, and whether the chat is there for it.
     * @param workspace the repository the page reads
     */
    private InfoOf(workspace: Workspace): IWorkspaceInfo & { chat: boolean }
    {
        return { ...workspace.Info, chat: this.api.HasChat && !workspace.pinned }
    }

    /**
     * Points the map at another repository, which every open page then reloads to show.
     * @param request the incoming request
     * @param response the response to write
     * @param workspace the workspace to switch, which must not be pinned
     */
    private async SwitchRepoAsync(request: IncomingMessage, response: ServerResponse, workspace: Workspace): Promise<void>
    {
        const refusal = RefuseWrite(request, this.allowWrites)
        if (refusal !== null) { SendJson(response, 403, { error: refusal }); return }
        let body: Record<string, unknown>
        try { body = await ReadJsonAsync(request) }
        catch (error) { SendJson(response, 400, { error: (error as Error).message }); return }
        if (typeof body.path !== 'string' || body.path.trim() === '')
        {
            SendJson(response, 400, { error: 'Give the folder to open as "path".' })
            return
        }
        try
        {
            if (workspace.pinned) { SendJson(response, 409, { error: 'This page reads the repository it was opened with (?repo=), so it cannot switch.' }); return }
            const info = await workspace.SwitchAsync(body.path)
            console.log(`Codespace now reading ${info.name} at ${info.root}`)
            SendJson(response, 200, info)
        }
        catch (error) { SendJson(response, 400, { error: `${body.path.trim()} could not be opened: ${(error as Error).message}` }) }
    }

    /**
     * Lists the folders inside one folder of the machine running Codespace, so the page can walk
     * to a repository instead of the person typing its path from memory.
     * @param response the response to write
     * @param path the folder to list, or empty for the repository being read
     * @param workspace the repository being read
     */
    private async SendBrowseAsync(response: ServerResponse, path: string | null, workspace: Workspace): Promise<void>
    {
        const target = Workspace.ResolvePath(path === null || path.trim() === '' ? workspace.repo.Root : path)
        try
        {
            const entries = await readdir(target, { withFileTypes: true })
            const names = new Set(entries.map((entry) => entry.name))
            const parent = resolve(target) === resolve(target, '..') ? null : resolve(target, '..')
            const folders = entries
                .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
                .map((entry) => ({ name: entry.name, path: join(target, entry.name) }))
                .sort((a, b) => a.name.localeCompare(b.name))
                .slice(0, 300)
            const repository = names.has('.git') || names.has(CodespaceFolder)
            SendJson(response, 200, { path: target, parent, repository, folders })
        }
        catch (error)
        {
            SendJson(response, 400, { error: `${target} cannot be listed: ${(error as Error).message}` })
        }
    }

    /**
     * The change stamp of the page's own files: the newest write under the public folder. A page keeps
     * the stamp it loaded with, so pressing Refresh can tell the code changed under it and reload,
     * instead of re-reading the repository into a page that is still running the old code.
     * @param publicRoot the folder holding the page and its compiled scripts
     */
    private static async BuildStampAsync(publicRoot: string): Promise<string>
    {
        const names = await readdir(publicRoot)
        let newest = 0
        for (const name of names)
        {
            try
            {
                const info = await stat(join(publicRoot, name))
                if (info.isFile()) newest = Math.max(newest, Math.trunc(info.mtimeMs))
            }
            catch
            {
                // A file removed while the folder is being read does not change the stamp.
            }
        }
        return newest.toString(36)
    }

    /**
     * Sends the text of one repository file.
     * @param response the response to write
     * @param path the requested repository-relative path
     * @param workspace the repository to read it from
     */
    private async SendSourceAsync(response: ServerResponse, path: string | null, workspace: Workspace): Promise<void>
    {
        if (path === null)
        {
            SendJson(response, 400, { error: 'path is required' })
            return
        }

        try
        {
            const text = await workspace.repo.ReadFileAsync(path)
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
            response.end(text)
        }
        catch (error)
        {
            const message = (error as Error).message
            SendJson(response, message === 'Forbidden' ? 403 : 404, { error: message })
        }
    }

    /**
     * Sends the blocks one file is made of: its declarations and its groups of declarations. Every
     * function and class stays one block, however long it is. The page reads them when a file is
     * opened, so a repository that nobody opens costs nothing.
     * @param response the response to write
     * @param path the file's repository-relative path
     * @param workspace the repository to read
     */
    private async SendBlocksAsync(response: ServerResponse, path: string | null, workspace: Workspace): Promise<void>
    {
        if (path === null || path.trim() === '')
        {
            SendJson(response, 400, { error: 'path is required' })
            return
        }

        try
        {
            const text = await workspace.repo.ReadFileAsync(path)
            const known = new Set(await workspace.repo.ListFilesAsync())
            // Each block carries the files its own text imports, so a chosen block can show its wires.
            SendJson(response, 200, Blocks.Read(path, text, (specifier) => Graph.ResolveImport(path, specifier, known)))
        }
        catch (error)
        {
            const message = (error as Error).message
            SendJson(response, message === 'Forbidden' ? 403 : 404, { error: message })
        }
    }

    /**
     * Writes a sentence for each block of one file that the source leaves without a comment. The
     * page asks for this after it shows a file, so a file nobody opens costs no model call; the
     * answers are cached by the block's text for the rest of the session. The file's own comments
     * are never replaced.
     * @param request the incoming request, whose JSON body names the file
     * @param response the response to write
     * @param workspace the repository to read
     */
    private async SendBlockSummariesAsync(request: IncomingMessage, response: ServerResponse, workspace: Workspace): Promise<void>
    {
        const refusal = RefuseWrite(request, this.allowWrites)
        if (refusal !== null) { SendJson(response, 403, { error: refusal }); return }
        if (request.method !== 'POST') { SendJson(response, 405, { error: 'The block summaries take POST.' }); return }

        let body: Record<string, unknown>
        try { body = await ReadJsonAsync(request) }
        catch (error) { SendJson(response, 400, { error: (error as Error).message }); return }
        const path = typeof body.path === 'string' ? body.path : ''

        let text: string
        try { text = await workspace.repo.ReadFileAsync(path) }
        catch (error)
        {
            const message = (error as Error).message
            SendJson(response, message === 'Forbidden' ? 403 : 404, { error: message })
            return
        }

        const report = Blocks.Read(path, text)
        const lines = text.split('\n')
        const wanted = report.blocks.filter((block) => block.fromComment === false).slice(0, MaxBlocks)
        if (wanted.length === 0) { SendJson(response, 200, { ok: true, summaries: {} }); return }

        const settings = ReadModelSettings(process.env)
        if (settings.apiKey === undefined)
        {
            SendJson(response, 503, { error: 'No model is configured, so these blocks keep a plain description of their shape.' })
            return
        }

        const requests = wanted.map((block, index) => ({
            id: `b${index}`, kind: block.kind, name: block.name, line: block.line, endLine: block.endLine,
            code: lines.slice(block.line - 1, block.endLine).join('\n'),
        }))
        try
        {
            const answers = await SummarizeBlocksAsync(requests, settings)
            const summaries: Record<string, string> = {}
            wanted.forEach((block, index) =>
            {
                const summary = answers[`b${index}`]
                if (summary !== undefined) summaries[block.name + '@' + block.line] = summary
            })
            SendJson(response, 200, { ok: true, summaries })
        }
        catch (error) { SendJson(response, 502, { error: (error as Error).message }) }
    }

    /**
     * Sends one file from the public folder, or the installed Babylon build.
     * @param request the incoming request
     * @param response the response to write
     * @param pathname the requested path
     */
    private async SendStaticAsync(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void>
    {
        // Babylon is served from the installed package at one fixed address. Its ETag makes an unchanged
        // build a 304, and an upgrade is picked up on the next revalidation, with no version in the page.
        if (pathname === '/vendor/babylon.js')
        {
            await this.SendFileAsync(request, response, join(BabylonRoot, 'babylon.js'), 'no-cache')
            return
        }

        const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
        const filePath = resolve(this.publicRoot, normalize(requested))

        if (filePath !== this.publicRoot && !filePath.startsWith(this.publicRoot + sep))
        {
            SendJson(response, 403, { error: 'Forbidden' })
            return
        }

        // The page's own files are small and change with every build, so they are never stored: a proxy
        // in front, such as Cloudflare, may turn `no-cache` into hours of browser caching, and a phone
        // would then run old scripts against a new page. `no-store` is passed through unchanged.
        await this.SendFileAsync(request, response, filePath, 'no-store')
    }

    /**
     * Sends one file, compressed when the browser accepts it, and with a validator so an
     * unchanged file costs a 304 instead of the whole body.
     * @param request the incoming request
     * @param response the response to write
     * @param filePath the file's absolute path
     * @param cacheControl the caching rule to send with it
     */
    private async SendFileAsync(request: IncomingMessage, response: ServerResponse, filePath: string, cacheControl: string): Promise<void>
    {
        try
        {
            const info = await stat(filePath)
            if (!info.isFile()) throw new Error('Not a file')
            const etag = `"${info.size.toString(16)}-${Math.trunc(info.mtimeMs).toString(16)}"`
            const extension = extname(filePath).toLowerCase()
            const headers: Record<string, string> = {
                'Content-Type': ContentTypes[extension] ?? 'application/octet-stream',
                'Cache-Control': cacheControl,
                ETag: etag,
                Vary: 'Accept-Encoding',
            }
            if (request.headers['if-none-match'] === etag)
            {
                response.writeHead(304, headers)
                response.end()
                return
            }

            const accepted = String(request.headers['accept-encoding'] ?? '')
            const encoding = !Compressible.has(extension) ? null : /\bbr\b/.test(accepted) ? 'br' : /\bgzip\b/.test(accepted) ? 'gzip' : null
            let body: Buffer
            if (encoding === null) body = await readFile(filePath)
            else
            {
                const key = `${encoding}:${filePath}`
                const cached = this.compressed.get(key)
                if (cached !== undefined && cached.etag === etag) body = cached.body
                else
                {
                    const raw = await readFile(filePath)
                    body = encoding === 'br' ? await BrotliAsync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 6 } }) : await GzipAsync(raw)
                    this.compressed.set(key, { etag, body })
                }
                headers['Content-Encoding'] = encoding
            }
            response.writeHead(200, headers)
            response.end(body)
        }
        catch
        {
            SendJson(response, 404, { error: 'Not found' })
        }
    }

    /**
     * Counts the lines each file has changed since HEAD, for the map's changes colouring. The paths
     * are relative to the root, so a repository that is a folder inside a larger git checkout lists
     * only its own files, by the paths the map uses.
     * A repository that is not under git, or a machine without git, reports no changes.
     * @param root the repository's root folder
     */
    private static async ReadChangesAsync(root: string): Promise<{ files: Record<string, number> }>
    {
        try
        {
            const { stdout } = await Run('git', ['-C', root, 'diff', '--numstat', '--relative', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 })
            const files: Record<string, number> = {}
            for (const line of stdout.split('\n'))
            {
                const [added, deleted, ...rest] = line.split('\t')
                if (rest.length === 0 || !/^\d+$/.test(added!) || !/^\d+$/.test(deleted!)) continue
                const path = rest.join('\t')
                const count = Number(added) + Number(deleted)
                if (count > 0) files[path] = count
            }
            return { files }
        }
        catch
        {
            return { files: {} }
        }
    }
}

// First we read the repository from --repo or CODESPACE_REPO, defaulting to the
// current folder; then the port and host, and finally we start the server. Only when
// started as a program, so importing this module never binds a port.
const started = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (started)
{
    // Codespace's own settings, such as the chat's model, come from a .env beside it when there is one.
    const envFile = join(import.meta.dirname, '..', '..', '.env')
    if (existsSync(envFile)) process.loadEnvFile(envFile)
    const args = process.argv.slice(2)
    const repoArg = ReadOption(args, '--repo') ?? process.env.CODESPACE_REPO ?? process.cwd()
    const port = Number(ReadOption(args, '--port') ?? process.env.PORT ?? 5190)
    const host = process.env.HOST ?? '0.0.0.0'
    const publicRoot = join(import.meta.dirname, '..', '..', 'public')
    const allowWrites = args.includes('--allow-writes') || process.env.CODESPACE_ALLOW_WRITES === '1'
    const withChat = !args.includes('--no-chat') && process.env.CODESPACE_CHAT !== '0'
    await Server.StartAsync(repoArg, publicRoot, port, host, allowWrites, withChat)
}
