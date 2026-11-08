import type { ServerResponse } from 'node:http'
import type { ChatEvent } from '../agent/Chat.ts'
import type { IShown } from '../../public/shown.ts'

export type { IShown, IShownFile } from '../../public/shown.ts'

/** How often an idle event stream is nudged, so a proxy does not close it, in milliseconds. */
const KeepAliveInterval = 25_000

/** One thing sent to every page that is watching. */
type ViewEvent =
    | { type: 'show', shown: IShown }
    | { type: 'clear' }
    | { type: 'focus', path: string }
    | { type: 'architecture' }
    | { type: 'repo' }
    | { type: 'chat', chat: ChatEvent }

/** What the map is currently being asked to show, and the pages watching it. */
export class View
{
    /** What is shown now, or null. A page that connects later is told it first. */
    private shown: IShown | null = null

    /** The pages watching, each with whether it is on this machine and so may follow the chat. */
    private readonly clients = new Map<ServerResponse, boolean>()

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

    /**
     * Tells the pages on this machine how the chat's reply is going.
     * @param chat what happened
     */
    public Chat(chat: ChatEvent): void
    {
        this.Broadcast({ type: 'chat', chat }, true)
    }

    /** Tells the pages the architecture file changed, so they read it again. */
    public ArchitectureChanged(): void
    {
        this.Broadcast({ type: 'architecture' })
    }

    /**
     * Starts an event stream to one page.
     * @param response the page's response, held open
     * @param local whether the page is on this machine, and so is sent the chat
     */
    public Subscribe(response: ServerResponse, local = false): void
    {
        response.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        this.clients.set(response, local)
        const timer = setInterval(() => response.write(': keepalive\n\n'), KeepAliveInterval)
        response.on('close', () => { clearInterval(timer); this.clients.delete(response) })
        if (this.shown !== null) response.write(`data: ${JSON.stringify({ type: 'show', shown: this.shown } satisfies ViewEvent)}\n\n`)
        else response.write(': connected\n\n')
    }

    /**
     * Sends an event to every page.
     * @param event what to send
     * @param localOnly whether only the pages on this machine are sent it
     */
    private Broadcast(event: ViewEvent, localOnly = false): void
    {
        const line = `data: ${JSON.stringify(event)}\n\n`
        for (const [client, local] of this.clients) if (local || !localOnly) client.write(line)
    }
}
