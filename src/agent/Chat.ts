import { homedir } from 'node:os'
import { join } from 'node:path'
import { InMemoryCredentialStore } from '@earendil-works/pi-ai'
import
{
    createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
    type AgentSession, type AgentSessionEvent,
} from '@earendil-works/pi-coding-agent'
import { Instructions, type IInstructionPlaces } from './Instructions.ts'
import { ReadModelSettings, type IModelSettings } from './ModelSettings.ts'
import type { ChatEvent, IChatLine, IChatSummary, IChatState } from '../../public/chatwire.ts'

export type { ChatEvent, IChatLine, IChatSummary, IChatState }

/** The pi tools the agent works with: enough to read, search, run commands, and edit. */
const Tools = ['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']

/** The provider name the endpoint is registered under. */
const ProviderId = 'codespace'

/** Where Codespace keeps pi's settings and chats, apart from the person's own pi setup. */
const AgentDir = join(homedir(), '.codespace', 'agent')

/** The longest tool detail shown in the chat, in characters. */
const MaxDetail = 160

/** The most past chats listed. */
const MaxChats = 30

/** How a test points the chat away from the person's home, or replaces the pi session layer. */
interface IChatOptions
{
    /** Where pi's settings and chats live; defaults to ~/.codespace/agent. */
    agentDir?: string
    /** Opens a pi session for a saved or new chat; defaults to a real one under agentDir. */
    openSession?: (sessions: SessionManager) => Promise<AgentSession>
}

/** What the chat is asked when the Repo panel's Ingest Codebase button is pressed. */
const DescribePrompt = 'Describe this repository for the map, or bring its description up to date if it was ' +
    'described before: the same loop does both, handing back only what is new or changed. Start by running install, as ' +
    'your instructions say. Then run the status, next, and apply loop from your ' +
    'instructions, applying each batch as you go, until next reports "remaining": 0, folders last. Declare the systems ' +
    'and layers first if there are none. Then do the second pass from your instructions: run refine, and improve the ' +
    'layers and systems from what it finds, unless nothing changed. Do not stop to ask me anything; when it is done, tell me in a few lines how ' +
    'you split it into systems and layers, and what the second pass changed.'

/** What the chat is asked when the Repo panel's Refine button is pressed, on a repository already described. */
const RefinePrompt = 'This repository is already described. Do the second pass from your instructions: run refine, ' +
    'and improve the layers and systems from what it finds, until it settles. Do not stop to ask me anything; when it is ' +
    'done, tell me in a few lines what you changed and what you left.'

/** One line of a chat, as the page shows it. */

/**
 * The chat built into the map: a pi agent working in the repository being mapped, talking to any
 * OpenAI-compatible endpoint. Pi runs the agent loop, the tools, and the saved history; this keeps
 * one open chat per server, starts a new one when the map moves to another repository, and passes
 * the reply to the page as it arrives.
 */
export class Chat
{
    /** Reads the repository being mapped now. */
    private readonly root: () => string

    /** Where the map and its tools are, apart from the repository. */
    private readonly places: Omit<IInstructionPlaces, 'root'>

    /** Tells the pages what is happening. */
    private readonly notify: (event: ChatEvent) => void

    /** Reads the model settings, again for each new chat so a changed key is picked up. */
    private readonly readSettings: () => IModelSettings

    /** Where pi's settings and chats live, apart from the person's own setup. */
    private readonly agentDir: string

    /** Opens a pi session, or a stand-in a test supplies. */
    private readonly openSession: (sessions: SessionManager) => Promise<AgentSession>

    /** The model runtime, made on first use. */
    private runtime: ModelRuntime | null = null

    /** The open chat, or null before the first message. */
    private session: AgentSession | null = null

    /** The repository the open chat works in. */
    private sessionRoot = ''

    /** Whether a reply is under way. */
    private busy = false

    /**
     * Prepares the chat; nothing is started until the first message.
     * @param root reads the repository being mapped
     * @param places where the map server and the CLI are
     * @param notify tells the pages what is happening
     * @param readSettings reads the model settings
     * @param options where pi keeps its files, or a stand-in session factory for a test
     */
    public constructor(root: () => string, places: Omit<IInstructionPlaces, 'root'>, notify: (event: ChatEvent) => void, readSettings: () => IModelSettings = () => ReadModelSettings(process.env), options: IChatOptions = {})
    {
        this.root = root
        this.places = places
        this.notify = notify
        this.readSettings = readSettings
        this.agentDir = options.agentDir ?? AgentDir
        this.openSession = options.openSession ?? ((sessions) => this.OpenAsync(sessions))
    }

    /** What the page shows: the model, the open chat, and the past ones. */
    public async StateAsync(): Promise<IChatState>
    {
        const settings = this.readSettings()
        this.ForgetOtherRepo()
        return {
            model: `${settings.model} at ${settings.baseUrl}`,
            problem: settings.apiKey === undefined ? `No model key: ${settings.keySource}. Set CODESPACE_MODEL_API_KEY or CODESPACE_MODEL_KEY_FILE.` : '',
            busy: this.busy,
            current: this.session?.sessionId ?? '',
            lines: this.session === null ? [] : ChatLines(this.session.messages),
            chats: await this.ListAsync(),
        }
    }

    /**
     * Sends a message and starts the reply. Returns once the reply has started; the page follows it
     * through the events.
     * @param text what the person wrote
     */
    public async SendAsync(text: string): Promise<void>
    {
        if (this.busy) throw new Error('A reply is still under way; stop it or wait.')
        if (text.trim() === '') throw new Error('The message is empty.')
        this.busy = true
        try
        {
            this.ForgetOtherRepo()
            this.session ??= await this.openSession(SessionManager.create(this.root(), this.ChatDir()))
        }
        catch (error)
        {
            this.busy = false
            throw error
        }

        const session = this.session
        this.notify({ kind: 'start' })
        session.prompt(text)
            .then(() => this.Finish(session.agent.state.errorMessage))
            .catch((error: unknown) => this.Finish(error instanceof Error ? error.message : String(error)))
    }

    /** Starts a new chat that describes the repository for the map, as the Repo panel asks. */
    public async DescribeAsync(): Promise<void>
    {
        if (this.busy) throw new Error('The chat is busy; stop its reply or wait, then try again.')
        await this.CloseAsync()
        this.notify({ kind: 'changed' })
        await this.SendAsync(DescribePrompt)
    }

    /** Starts a new chat that refines the layers and systems of an already described repository. */
    public async RefineAsync(): Promise<void>
    {
        if (this.busy) throw new Error('The chat is busy; stop its reply or wait, then try again.')
        await this.CloseAsync()
        this.notify({ kind: 'changed' })
        await this.SendAsync(RefinePrompt)
    }

    /** Stops the reply under way, keeping what was said so far. */
    public async StopAsync(): Promise<void>
    {
        await this.session?.abort()
    }

    /** Closes the open chat, so the next message starts a new one. */
    public async NewAsync(): Promise<void>
    {
        await this.CloseAsync()
        this.notify({ kind: 'changed' })
    }

    /**
     * Reopens a past chat of this repository.
     * @param id the chat's id
     */
    public async ResumeAsync(id: string): Promise<void>
    {
        const found = (await SessionManager.list(this.root(), this.ChatDir())).find((chat) => chat.id === id)
        if (found === undefined) throw new Error('That chat is not one of this repository\'s.')
        await this.CloseAsync()
        this.busy = true
        try { this.session = await this.openSession(SessionManager.open(found.path, this.ChatDir(), this.root())) }
        finally { this.busy = false }
        this.notify({ kind: 'changed' })
    }

    /** Stops and lets go of the open chat. */
    private async CloseAsync(): Promise<void>
    {
        if (this.session !== null)
        {
            await this.session.abort().catch(() => {})
            this.session.dispose()
        }
        this.session = null
        this.busy = false
    }

    /** Lets go of the open chat when the map has moved to another repository. */
    private ForgetOtherRepo(): void
    {
        if (this.session === null || this.sessionRoot === this.root() || this.busy) return
        this.session.dispose()
        this.session = null
    }

    /**
     * Starts a pi session over a saved or new chat, in the repository, with Codespace's instructions.
     * @param sessions the chat's saved history
     */
    private async OpenAsync(sessions: SessionManager): Promise<AgentSession>
    {
        const settings = this.readSettings()
        if (settings.apiKey === undefined) throw new Error(`No model key: ${settings.keySource}.`)
        const root = this.root()

        this.runtime ??= await ModelRuntime.create({
            credentials: new InMemoryCredentialStore(),
            modelsPath: null,
            modelsStorePath: join(this.agentDir, 'models-store.json'),
            refreshOnCreate: false,
        })
        this.runtime.registerProvider(ProviderId, {
            name: 'Codespace',
            baseUrl: settings.baseUrl,
            apiKey: settings.apiKey,
            api: 'openai-completions',
            models: [{
                id: settings.model, name: settings.model, reasoning: false, input: ['text'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: settings.contextWindow, maxTokens: settings.maxTokens,
            }],
        })
        const model = this.runtime.getModel(ProviderId, settings.model)
        if (model === undefined) throw new Error(`The model ${settings.model} could not be registered.`)

        // The repository's own AGENTS.md is still read; the person's pi extensions and skills are not.
        const settingsManager = SettingsManager.inMemory({ compaction: { enabled: true }, retry: { enabled: true, maxRetries: 2 } })
        const resourceLoader = new DefaultResourceLoader({
            cwd: root, agentDir: this.agentDir, settingsManager,
            noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
            appendSystemPrompt: [Instructions({ root, ...this.places })],
        })
        await resourceLoader.reload()

        const { session } = await createAgentSession({
            cwd: root, agentDir: this.agentDir, model, modelRuntime: this.runtime, thinkingLevel: 'off',
            tools: Tools, resourceLoader, sessionManager: sessions, settingsManager,
        })
        session.subscribe((event) => this.Relay(event))
        this.sessionRoot = root
        return session
    }

    /**
     * Passes the parts of pi's events the page shows.
     * @param event what pi reported
     */
    private Relay(event: AgentSessionEvent): void
    {
        if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') this.notify({ kind: 'text', delta: event.assistantMessageEvent.delta })
        else if (event.type === 'tool_execution_start') this.notify({ kind: 'tool', name: event.toolName, detail: ToolDetail(event.toolName, event.args) })
        else if (event.type === 'tool_execution_end') this.notify({ kind: 'tool-end', name: event.toolName, error: event.isError })
    }

    /**
     * Marks the reply finished and tells the pages.
     * @param error why it failed, if it did
     */
    private Finish(error: string | undefined): void
    {
        this.busy = false
        this.notify(error ? { kind: 'end', error } : { kind: 'end' })
    }

    /** The repository's past chats, newest first. */
    private async ListAsync(): Promise<IChatSummary[]>
    {
        try
        {
            const chats = await SessionManager.list(this.root(), this.ChatDir())
            return chats
                .filter((chat) => chat.messageCount > 0)
                .sort((a, b) => b.modified.getTime() - a.modified.getTime())
                .slice(0, MaxChats)
                .map((chat) => ({ id: chat.id, title: Shorten(chat.name ?? chat.firstMessage, 70) || 'Untitled', updated: chat.modified.toISOString() }))
        }
        catch { return [] }
    }

    /** Where this repository's chats are saved. */
    private ChatDir(): string
    {
        return join(this.agentDir, 'chats', this.root().replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, ''))
    }
}

/**
 * Turns pi's messages into the lines the page shows: the person's messages, the model's text, and
 * one short line for each tool it ran, marked when the tool failed.
 * @param messages the chat's messages, as pi keeps them
 */
export function ChatLines(messages: readonly unknown[]): IChatLine[]
{
    const lines: IChatLine[] = []
    const toolLines = new Map<string, IChatLine>()
    for (const message of messages as Array<{ role?: string, content?: unknown, toolCallId?: string, isError?: boolean, errorMessage?: string }>)
    {
        if (message.role === 'user')
        {
            const text = TextOf(message.content)
            if (text !== '') lines.push({ role: 'user', text })
        }
        else if (message.role === 'assistant' && Array.isArray(message.content))
        {
            for (const part of message.content as Array<{ type?: string, text?: string, name?: string, id?: string, arguments?: unknown }>)
            {
                if (part.type === 'text' && part.text?.trim()) lines.push({ role: 'assistant', text: part.text.trim() })
                else if (part.type === 'toolCall' && part.name)
                {
                    const line: IChatLine = { role: 'tool', tool: part.name, text: ToolDetail(part.name, part.arguments) }
                    lines.push(line)
                    if (part.id) toolLines.set(part.id, line)
                }
            }
            if (message.errorMessage) lines.push({ role: 'error', text: message.errorMessage })
        }
        else if (message.role === 'toolResult' && message.isError && message.toolCallId)
        {
            const line = toolLines.get(message.toolCallId)
            if (line) line.role = 'error'
        }
    }
    return lines
}

/**
 * A short account of what a tool was asked to do: the command, the path, or the pattern.
 * @param name the tool's name
 * @param args what it was given
 */
export function ToolDetail(name: string, args: unknown): string
{
    const given = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
    const main = given.command ?? given.path ?? given.pattern ?? given.file_path
    if (typeof main === 'string') return Shorten(main, MaxDetail) || name
    return Object.keys(given).length === 0 ? name : Shorten(JSON.stringify(given), MaxDetail)
}

/** The text of a message's content, which is either a string or a list of parts. */
function TextOf(content: unknown): string
{
    if (typeof content === 'string') return content.trim()
    if (!Array.isArray(content)) return ''
    return content.filter((part) => part?.type === 'text').map((part) => String(part.text)).join('\n').trim()
}

/** The text on one line, cut to a length with an ellipsis. */
function Shorten(text: string, length: number): string
{
    const flat = text.replace(/\s+/g, ' ').trim()
    return flat.length > length ? flat.slice(0, length - 1) + '…' : flat
}
