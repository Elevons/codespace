import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { execFile } from 'node:child_process'
import { readdir, readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { Api } from './Api.ts'
import { ReadJsonAsync, RefuseWrite } from './Guard.ts'
import { Workspace } from './Workspace.ts'

/** Runs a command without a shell and resolves with its standard output. */
const Run = promisify(execFile)

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
    public allowWrites: boolean

    /**
     * Prepares one server.
     * @param workspace the repository to read
     * @param publicRoot the folder holding the page and index
     * @param api the endpoints for tools
     */
    private constructor(workspace: Workspace, publicRoot: string, api: Api)
    {
        this.workspace = workspace
        this.allowWrites = false
        this.publicRoot = publicRoot
        this.api = api
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
        const cli = join(publicRoot, '..', 'src', 'cli', 'Cli.ts')
        const server = new Server(workspace, publicRoot, new Api(workspace, allowWrites, cli))
        server.allowWrites = allowWrites

        const http = createServer((request, response) =>
        {
            server.HandleAsync(request, response).catch((error) =>
            {
                console.error(error)
                Server.SendJson(response, 500, { error: error instanceof Error ? error.message : 'Server error' })
            })
        })

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
            if (request.method === 'GET' || request.method === 'HEAD') Server.SendJson(response, 200, this.workspace.Info)
            else if (request.method === 'POST') await this.SwitchRepoAsync(request, response)
            else Server.SendJson(response, 405, { error: 'The repository endpoint takes GET or POST.' })
            return
        }

        if (url.pathname === '/api/browse')
        {
            await this.SendBrowseAsync(response, url.searchParams.get('path'))
            return
        }

        if (url.pathname === '/api/files')
        {
            Server.SendJson(response, 200, { files: await this.workspace.repo.ListFilesAsync() })
            return
        }

        if (url.pathname === '/api/changes')
        {
            Server.SendJson(response, 200, await Server.ReadChangesAsync(this.workspace.repo.Root))
            return
        }

        if (url.pathname === '/api/fingerprint')
        {
            Server.SendJson(response, 200, { fingerprint: await this.workspace.repo.FingerprintAsync() })
            return
        }

        if (url.pathname === '/api/source')
        {
            await this.SendSourceAsync(response, url.searchParams.get('path'))
            return
        }

        await this.SendStaticAsync(response, pathname)
    }

    /**
     * Points the map at another repository, which every open page then reloads to show.
     * @param request the incoming request
     * @param response the response to write
     */
    private async SwitchRepoAsync(request: IncomingMessage, response: ServerResponse): Promise<void>
    {
        const refusal = RefuseWrite(request, this.allowWrites)
        if (refusal !== null) { Server.SendJson(response, 403, { error: refusal }); return }
        let body: Record<string, unknown>
        try { body = await ReadJsonAsync(request) }
        catch (error) { Server.SendJson(response, 400, { error: (error as Error).message }); return }
        if (typeof body.path !== 'string' || body.path.trim() === '')
        {
            Server.SendJson(response, 400, { error: 'Give the folder to open as "path".' })
            return
        }
        try
        {
            const info = await this.workspace.SwitchAsync(body.path)
            console.log(`Codespace now reading ${info.name} at ${info.root}`)
            Server.SendJson(response, 200, info)
        }
        catch (error) { Server.SendJson(response, 400, { error: `${body.path.trim()} could not be opened: ${(error as Error).message}` }) }
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
            Server.SendJson(response, 200, { path: target, parent, repository, folders })
        }
        catch (error)
        {
            Server.SendJson(response, 400, { error: `${target} cannot be listed: ${(error as Error).message}` })
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
            Server.SendJson(response, 400, { error: 'path is required' })
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
            Server.SendJson(response, message === 'Forbidden' ? 403 : 404, { error: message })
        }
    }

    /**
     * Sends one file from the public folder.
     * @param response the response to write
     * @param pathname the requested path
     */
    private async SendStaticAsync(response: ServerResponse, pathname: string): Promise<void>
    {
        const requested = pathname === '/' ? 'index.html' : pathname.slice(1)
        const filePath = resolve(this.publicRoot, normalize(requested))

        if (filePath !== this.publicRoot && !filePath.startsWith(this.publicRoot + sep))
        {
            Server.SendJson(response, 403, { error: 'Forbidden' })
            return
        }

        try
        {
            const body = await readFile(filePath)
      const type = ContentTypes[extname(filePath).toLowerCase()] ?? 'application/octet-stream'
      response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' })
            response.end(body)
        }
        catch
        {
            Server.SendJson(response, 404, { error: 'Not found' })
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
// current folder; then the port and host, and finally we start the server.
const args = process.argv.slice(2)
const repoArg = Server.ReadOption(args, '--repo') ?? process.env.CODESPACE_REPO ?? process.cwd()
const port = Number(Server.ReadOption(args, '--port') ?? process.env.PORT ?? 5190)
const host = process.env.HOST ?? '0.0.0.0'
const publicRoot = join(import.meta.dirname, '..', '..', 'public')
const allowWrites = args.includes('--allow-writes') || process.env.CODESPACE_ALLOW_WRITES === '1'
await Server.StartAsync(repoArg, publicRoot, port, host, allowWrites)
