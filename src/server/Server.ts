import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { Api } from './Api.ts'
import { ReadJsonAsync, RefuseRemoteRead, RefuseWrite, SendJson } from './Guard.ts'
import { Architecture } from '../repo/Architecture.ts'
import { Snapshot } from '../repo/Snapshot.ts'
import { Workspace } from './Workspace.ts'

/** Runs a command without a shell and resolves with its standard output. */
const Run = promisify(execFile)

const BrotliAsync = promisify(brotliCompress)
const GzipAsync = promisify(gzip)

/** The installed Babylon package, which the page loads from here instead of a CDN. */
const BabylonRoot = join(import.meta.dirname, '..', '..', 'node_modules', 'babylonjs')

/** The static types worth compressing; images and fonts are already compact. */
const Compressible = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg'])

/** Sent with a file whose address names its version, so a browser never asks for it again. */
const ImmutableCache = 'public, max-age=31536000, immutable'

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
    /** The repository the map is reading, and the ones it can switch to. */
    private readonly workspace: Workspace

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
     * @param workspace the repository to read
     * @param publicRoot the folder holding the page and index
     * @param api the endpoints for tools
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     */
    private constructor(workspace: Workspace, publicRoot: string, api: Api, allowWrites: boolean)
    {
        this.workspace = workspace
        this.publicRoot = publicRoot
        this.api = api
        this.allowWrites = allowWrites
    }

    /**
     * Builds a server without starting it, so a test can listen on its own port and stop it.
     * @param workspace the repository to read
     * @param publicRoot the folder holding the page and index
     * @param allowWrites whether changes are accepted from any machine, as started with --allow-writes
     */
    public static async CreateAsync(workspace: Workspace, publicRoot: string, allowWrites = false): Promise<{ server: Server, http: HttpServer }>
    {
        const cli = join(publicRoot, '..', 'src', 'cli', 'Cli.ts')
        const server = new Server(workspace, publicRoot, new Api(workspace, allowWrites, cli), allowWrites)
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
     */
    public static async StartAsync(repoPath: string, publicRoot: string, port: number, host: string, allowWrites = false): Promise<void>
    {
        const workspace = await Workspace.OpenAsync(repoPath)
        const { http } = await Server.CreateAsync(workspace, publicRoot, allowWrites)
        await new Promise<void>((done) => http.listen(port, host, done))
        console.log(`Codespace reading ${workspace.repo.Name} at ${workspace.repo.Root}`)
        console.log(`Open http://localhost:${port}`)
        if (host === '0.0.0.0') console.log(`On the LAN, open http://<this machine>:${port}`)
        if (allowWrites) console.log('Changes are accepted from any machine that can reach it (--allow-writes).')
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

        if (await this.api.HandleAsync(request, response, url)) return

        if (url.pathname === '/api/repo')
        {
            if (request.method === 'GET' || request.method === 'HEAD') SendJson(response, 200, this.workspace.Info)
            else if (request.method === 'POST') await this.SwitchRepoAsync(request, response)
            else SendJson(response, 405, { error: 'The repository endpoint takes GET or POST.' })
            return
        }

        if (url.pathname === '/api/browse')
        {
            const refusal = RefuseRemoteRead(request)
            if (refusal !== null) { SendJson(response, 403, { error: refusal }); return }
            await this.SendBrowseAsync(response, url.searchParams.get('path'))
            return
        }

        if (url.pathname === '/api/files')
        {
            SendJson(response, 200, { files: await this.workspace.repo.ListFilesAsync() }, request)
            return
        }

        if (url.pathname === '/api/bootstrap')
        {
            await this.SendBootstrapAsync(request, response, url.searchParams.get('since'))
            return
        }

        if (url.pathname === '/api/changes')
        {
            SendJson(response, 200, await Server.ReadChangesAsync(this.workspace.repo.Root))
            return
        }

        if (url.pathname === '/api/fingerprint')
        {
            SendJson(response, 200, { fingerprint: await this.workspace.repo.FingerprintAsync() })
            return
        }

        if (url.pathname === '/api/source')
        {
            await this.SendSourceAsync(response, url.searchParams.get('path'))
            return
        }

        await this.SendStaticAsync(request, response, pathname)
    }

    /**
     * Sends everything the page needs to draw the repository in one response: its name, files,
     * architecture, imports, line counts, declarations, and changes. A page that already holds the
     * current version gets only the stamp back, so polling costs a stat per file and no more.
     * @param request the incoming request
     * @param response the response to write
     * @param since the change stamp the page already holds, if any
     */
    private async SendBootstrapAsync(request: IncomingMessage, response: ServerResponse, since: string | null): Promise<void>
    {
        const repo = this.workspace.repo
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
            repo: this.workspace.Info,
            fingerprint: snapshot.fingerprint,
            files: snapshot.files,
            architecture,
            edges: snapshot.edges,
            lines: snapshot.lines,
            symbols: snapshot.symbols,
            changes: changes.files,
        }, request)
    }

    /**
     * Points the map at another repository, which every open page then reloads to show.
     * @param request the incoming request
     * @param response the response to write
     */
    private async SwitchRepoAsync(request: IncomingMessage, response: ServerResponse): Promise<void>
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
            const info = await this.workspace.SwitchAsync(body.path)
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
     */
    private async SendBrowseAsync(response: ServerResponse, path: string | null): Promise<void>
    {
        const target = Workspace.ResolvePath(path === null || path.trim() === '' ? this.workspace.repo.Root : path)
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
            const repository = names.has('.git') || names.has('.codespace')
            SendJson(response, 200, { path: target, parent, repository, folders })
        }
        catch (error)
        {
            SendJson(response, 400, { error: `${target} cannot be listed: ${(error as Error).message}` })
        }
    }

    /**
     * Sends the text of one repository file.
     * @param response the response to write
     * @param path the requested repository-relative path
     */
    private async SendSourceAsync(response: ServerResponse, path: string | null): Promise<void>
    {
        if (path === null)
        {
            SendJson(response, 400, { error: 'path is required' })
            return
        }

        try
        {
            const text = await this.workspace.repo.ReadFileAsync(path)
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
     * Sends one file from the public folder, or the installed Babylon build.
     * @param request the incoming request
     * @param response the response to write
     * @param pathname the requested path
     */
    private async SendStaticAsync(request: IncomingMessage, response: ServerResponse, pathname: string): Promise<void>
    {
        // Babylon is served from the installed package at an address that names its version, so
        // the browser keeps it for good; any other version is not here.
        const vendor = /^\/vendor\/babylon-([\w.-]+)\.js$/.exec(pathname)
        if (vendor !== null)
        {
            const version = JSON.parse(await readFile(join(BabylonRoot, 'package.json'), 'utf8').catch(() => '{}')).version
            if (version === vendor[1]) await this.SendFileAsync(request, response, join(BabylonRoot, 'babylon.js'), ImmutableCache)
            else SendJson(response, 404, { error: 'Not found' })
            return
        }

        const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
        const filePath = resolve(this.publicRoot, normalize(requested))

        if (filePath !== this.publicRoot && !filePath.startsWith(this.publicRoot + sep))
        {
            SendJson(response, 403, { error: 'Forbidden' })
            return
        }

        await this.SendFileAsync(request, response, filePath, 'no-cache')
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
     * Counts the lines each file has changed since HEAD, for the map's changes colouring.
     * A repository that is not under git, or a machine without git, reports no changes.
     * @param root the repository's root folder
     */
    private static async ReadChangesAsync(root: string): Promise<{ files: Record<string, number> }>
    {
        try
        {
            const { stdout } = await Run('git', ['-C', root, 'diff', '--numstat', 'HEAD'], { maxBuffer: 32 * 1024 * 1024 })
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

    /**
     * Reads `--name value` or `--name=value` from the command line.
     * @param args the command-line arguments
     * @param name the option name, with its dashes
     */
    public static ReadOption(args: readonly string[], name: string): string | undefined
    {
        const withEquals = args.find((arg) => arg.startsWith(name + '='))
        if (withEquals) return withEquals.slice(name.length + 1)
        const index = args.indexOf(name)
        return index >= 0 ? args[index + 1] : undefined
    }
}

// First we read the repository from --repo or CODESPACE_REPO, defaulting to the
// current folder; then the port and host, and finally we start the server. Only when
// started as a program, so importing this module never binds a port.
const started = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (started)
{
    const args = process.argv.slice(2)
    const repoArg = Server.ReadOption(args, '--repo') ?? process.env.CODESPACE_REPO ?? process.cwd()
    const port = Number(Server.ReadOption(args, '--port') ?? process.env.PORT ?? 5190)
    const host = process.env.HOST ?? '0.0.0.0'
    const publicRoot = join(import.meta.dirname, '..', '..', 'public')
    const allowWrites = args.includes('--allow-writes') || process.env.CODESPACE_ALLOW_WRITES === '1'
    await Server.StartAsync(repoArg, publicRoot, port, host, allowWrites)
}
