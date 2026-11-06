import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { Repo } from './Repo.ts'

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
    /** The repository the map is reading. */
    private readonly repo: Repo

    /** The folder holding the map page and its index. */
    private readonly publicRoot: string

    /**
     * Prepares one server.
     * @param repo the repository to read
     * @param publicRoot the folder holding the page and index
     */
    private constructor(repo: Repo, publicRoot: string)
    {
        this.repo = repo
        this.publicRoot = publicRoot
    }

    /**
     * Starts the map server.
     * @param repoPath the repository to read
     * @param publicRoot the folder holding the page and index
     * @param port the port to listen on
     * @param host the address to bind
     */
    public static async StartAsync(repoPath: string, publicRoot: string, port: number, host: string): Promise<void>
    {
        const repo = await Repo.OpenAsync(repoPath)
        const server = new Server(repo, publicRoot)

        const http = createServer((request, response) =>
        {
            server.HandleAsync(request, response).catch((error) =>
            {
                console.error(error)
                Server.SendJson(response, 500, { error: error instanceof Error ? error.message : 'Server error' })
            })
        })

        await new Promise<void>((done) => http.listen(port, host, done))
        console.log(`Codespace reading ${repo.Name} at ${repo.Root}`)
        console.log(`Open http://localhost:${port}`)
        if (host === '0.0.0.0') console.log(`On the LAN, open http://<this machine>:${port}`)
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

        if (url.pathname === '/api/repo')
        {
            Server.SendJson(response, 200, { name: this.repo.Name, root: this.repo.Root })
            return
        }

        if (url.pathname === '/api/files')
        {
            Server.SendJson(response, 200, { files: await this.repo.ListFilesAsync() })
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
            const text = await this.repo.ReadFileAsync(path)
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' })
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
            response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' })
            response.end(body)
        }
        catch
        {
            Server.SendJson(response, 404, { error: 'Not found' })
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
const publicRoot = join(import.meta.dirname, '..', 'public')

await Server.StartAsync(repoArg, publicRoot, port, host)
