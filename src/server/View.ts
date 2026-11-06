import type { ServerResponse } from 'node:http'

/** How often an idle event stream is nudged, so a proxy does not close it, in milliseconds. */
const KeepAliveInterval = 25_000

/** One file the map is showing, with what to say about it. */
export interface IShownFile
{
    /** The repository-relative path. */
    path: string
    /** What to say about this file, or empty. */
    note: string
}

/** What a tool has asked the map to show. */
export interface IShown
{
    /** The files, in order. */
    files: IShownFile[]
    /** Whether to draw a route through them in that order, as a code path. */
    trace: boolean
    /** A heading for what is shown, or empty. */
    title: string
    /** A short explanation of what is shown, or empty. */
    note: string
}

/** One thing sent to every page that is watching. */
export type ViewEvent =
    | { type: 'show', shown: IShown }
    | { type: 'clear' }
    | { type: 'focus', path: string }
    | { type: 'architecture' }
    | { type: 'repo' }

/** What the map is currently being asked to show, and the pages watching it. */
export class View
{
    /** What is shown now, or null. A page that connects later is told it first. */
    private shown: IShown | null = null

    /** The pages watching. */
    private readonly clients = new Set<ServerResponse>()

    /** What the map is showing now. */
    public get Shown(): IShown | null
    {
        return this.shown
    }

    /**
     * Asks the map to show files.
     * @param shown what to show
     */
    public Show(shown: IShown): void
    {
        this.shown = shown
        this.Broadcast({ type: 'show', shown })
    }

    /** Asks the map to stop showing files. */
    public Clear(): void
    {
        this.shown = null
        this.Broadcast({ type: 'clear' })
    }

    /**
     * Asks the map to select a file or folder and bring it into view.
     * @param path the repository-relative path; empty is the repository root
     */
    public Focus(path: string): void
    {
        this.Broadcast({ type: 'focus', path })
    }

    /** Tells the pages the map now reads another repository, so they start again. */
    public RepoChanged(): void
    {
        this.Broadcast({ type: 'repo' })
    }

    /** Tells the pages the architecture file changed, so they read it again. */
    public ArchitectureChanged(): void
    {
        this.Broadcast({ type: 'architecture' })
    }

    /**
     * Starts an event stream to one page.
     * @param response the page's response, held open
     */
    public Subscribe(response: ServerResponse): void
    {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        this.clients.add(response)
        const timer = setInterval(() => response.write(': keepalive\n\n'), KeepAliveInterval)
        response.on('close', () => { clearInterval(timer); this.clients.delete(response) })
        if (this.shown !== null) response.write(`data: ${JSON.stringify({ type: 'show', shown: this.shown } satisfies ViewEvent)}\n\n`)
        else response.write(': connected\n\n')
    }

    /**
     * Sends an event to every page.
     * @param event what to send
     */
    private Broadcast(event: ViewEvent): void
    {
        const line = `data: ${JSON.stringify(event)}\n\n`
        for (const client of this.clients) client.write(line)
    }
}
