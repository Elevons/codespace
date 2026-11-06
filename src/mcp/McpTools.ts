/** The protocol versions the server speaks, newest first. */
const ProtocolVersions = ['2025-06-18', '2025-03-26', '2024-11-05']

/** Asks the Codespace server for something: a GET, or a POST when given a body. Resolves to its JSON answer. */
export type CallServer = (path: string, body?: unknown) => Promise<any>

/** One tool an agent can call. */
export interface ITool
{
    /** The tool's name. */
    name: string
    /** What it does and when to use it, as the agent reads it. */
    description: string
    /** The shape of its arguments, as JSON Schema. */
    inputSchema: Record<string, unknown>
    /** Runs the tool and returns the text to give back. */
    run: (args: Record<string, unknown>) => Promise<string>
}

/** One JSON-RPC message from an agent. */
export interface IRpcMessage
{
    /** The request's id; a notification has none and gets no answer. */
    id?: unknown
    /** The method called. */
    method?: string
    /** Its parameters. */
    params?: Record<string, unknown>
}

/**
 * Makes a way to reach the Codespace server over HTTP.
 * @param baseUrl where the server is
 * @param unreachable what to say when it cannot be reached
 */
export function HttpCall(baseUrl: string, unreachable: string): CallServer
{
    const root = baseUrl.replace(/\/+$/, '')
    return async (path, body) =>
    {
        let response: Response
        try
        {
            response = await fetch(root + path, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
        }
        catch
        {
            throw new Error(unreachable)
        }
        const data: any = await response.json().catch(() => ({}))
        if (!response.ok) throw new Error(data.error ?? `Codespace answered ${response.status}.`)
        return data
    }
}

/** Describes a file entry's fields once, so tools describe them the same way. */
const EntrySchema = {
    type: 'object',
    properties: {
        layer: { type: ['string', 'null'], description: 'A layer named in "layers", or null to remove the file from its layer.' },
        tags: { type: ['array', 'null'], items: { type: 'string' }, description: 'Roles, primary first, or null to clear. Vocabulary: entry, orchestrate, core, data, io, ui, config, test.' },
        summary: { type: ['string', 'null'], description: 'One sentence on what the file is for, or null to clear.' },
    },
    additionalProperties: false,
}

/**
 * Builds the tools, each of which reaches the Codespace server through `call`.
 * @param call asks the Codespace server for something
 */
export function CreateTools(call: CallServer): ITool[]
{
    return [
        {
            name: 'get_architecture',
            description: 'Read how this repository is laid out on the map: the layer order, each file\'s layer, tags and summary, warnings about the architecture file, and the files that have no layer or no summary yet. Start here.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            run: async () =>
            {
                const [architecture, listing] = await Promise.all([call('/api/architecture'), call('/api/files')])
                const files: string[] = listing.files
                return JSON.stringify({
                    layers: architecture.layers, entries: architecture.files, warnings: architecture.warnings, error: architecture.error,
                    withoutLayer: files.filter((path) => architecture.files[path]?.layer === undefined),
                    withoutSummary: files.filter((path) => architecture.files[path]?.summary === undefined),
                })
            },
        },
        {
            name: 'get_import_graph',
            description: 'List the imports between files (TypeScript and JavaScript, relative imports) and which of them break the layers: a file in a lower layer importing one in a higher layer. Pass folder to limit it to imports touching that folder.',
            inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'A repository-relative folder, such as "src".' } }, additionalProperties: false },
            run: async (args) =>
            {
                const folder = typeof args.folder === 'string' ? args.folder : ''
                const [graph, architecture] = await Promise.all([call('/api/graph?folder=' + encodeURIComponent(folder)), call('/api/architecture')])
                const rank = (path: string): number => architecture.layers.indexOf(architecture.files[path]?.layer ?? '')
                const breaks = graph.edges.filter(([from, to]: [string, string]) => rank(from) >= 0 && rank(to) >= 0 && rank(from) < rank(to))
                return JSON.stringify({ imports: graph.edges, layerBreaks: breaks })
            },
        },
        {
            name: 'get_view',
            description: 'Read what the map is currently being asked to show, if anything.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            run: async () => JSON.stringify(await call('/api/view')),
        },
        {
            name: 'update_architecture',
            description: 'Change the repository\'s architecture file, which the map reads and redraws live, without touching any source code. Use it to move files between layers, retag them, write summaries, reorder or add layers, or move an entry after a file was renamed. The change is all or nothing: if any part is invalid, nothing is written and the problems are listed.',
            inputSchema: {
                type: 'object',
                properties: {
                    layers: { type: 'array', items: { type: 'string' }, description: 'The full layer order, bottom first. Replaces the current list. Needed before a file can join a new layer.' },
                    files: { type: 'object', additionalProperties: EntrySchema, description: 'Changes keyed by repository-relative file path. Only the fields you give are changed; null removes one.' },
                    renames: {
                        type: 'array', items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false },
                        description: 'Move an entry from its old path to the file\'s new path. Applied first.',
                    },
                },
                additionalProperties: false,
            },
            run: async (args) =>
            {
                const result = await call('/api/architecture', args)
                return JSON.stringify({ layers: result.architecture.layers, warnings: [...result.notes, ...result.architecture.warnings] })
            },
        },
        {
            name: 'show_files',
            description: 'Light up files on the map for the person looking at it, and explain them. Give files in order with trace set to true to draw a numbered route through them, which is how to show a code path. Write each note as a real explanation of what happens at that step: a sentence or two in your own words, saying what this file does here and how it hands off to the next, not a restatement of the file summary. Read the files first so the notes are specific. Put the overall point in title and the leading note; they appear beside the map. Replaces whatever was shown before.',
            inputSchema: {
                type: 'object',
                properties: {
                    files: {
                        type: 'array', minItems: 1, maxItems: 60,
                        items: { type: 'object', properties: { path: { type: 'string' }, note: { type: 'string', description: 'What happens at this step: a sentence or two in your own words on what this file does here and how it leads to the next, not the file summary.' } }, required: ['path'], additionalProperties: false },
                        description: 'Repository-relative paths, with an optional note each. For a trace, in the order the path visits them.',
                    },
                    trace: { type: 'boolean', description: 'Draw a numbered route through the files in order. Default false.' },
                    title: { type: 'string', description: 'A short heading, such as "How a click becomes a highlight".' },
                    note: { type: 'string', description: 'A sentence or two on what the person is looking at.' },
                },
                required: ['files'],
                additionalProperties: false,
            },
            run: async (args) => JSON.stringify(await call('/api/view', { action: 'show', ...args })),
        },
        {
            name: 'focus',
            description: 'Select a file or folder on the map and bring the camera to it, opening its summary and details.',
            inputSchema: { type: 'object', properties: { path: { type: 'string', description: 'A repository-relative file or folder path. Empty is the repository root.' } }, required: ['path'], additionalProperties: false },
            run: async (args) => JSON.stringify(await call('/api/view', { action: 'focus', path: args.path })),
        },
        {
            name: 'clear_view',
            description: 'Stop showing whatever show_files lit up.',
            inputSchema: { type: 'object', properties: {}, additionalProperties: false },
            run: async () => JSON.stringify(await call('/api/view', { action: 'clear' })),
        },
    ]
}

/**
 * Answers one JSON-RPC message from an agent, whatever carried it.
 * @param message the message
 * @param tools the tools on offer
 * @returns the JSON-RPC answer, or null for a notification, which gets none
 */
export async function Respond(message: IRpcMessage, tools: readonly ITool[]): Promise<object | null>
{
    if (message.id === undefined || typeof message.method !== 'string') return null
    const id = message.id
    const params = message.params ?? {}

    if (message.method === 'initialize')
    {
        const wanted = typeof params.protocolVersion === 'string' ? params.protocolVersion : ''
        return {
            jsonrpc: '2.0', id,
            result: {
                protocolVersion: ProtocolVersions.includes(wanted) ? wanted : ProtocolVersions[0],
                capabilities: { tools: {} },
                serverInfo: { name: 'codespace', version: '0.0.0' },
                instructions: 'Tools for the Codespace 3D code map. Read with get_architecture, point at files with show_files, and reshape layers and tags with update_architecture, which edits the architecture file, not the code.',
            },
        }
    }
    if (message.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
    if (message.method === 'tools/list')
    {
        return { jsonrpc: '2.0', id, result: { tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } }
    }
    if (message.method === 'tools/call')
    {
        const tool = tools.find((candidate) => candidate.name === params.name)
        if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${String(params.name)}` } }
        try
        {
            const text = await tool.run((params.arguments ?? {}) as Record<string, unknown>)
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } }
        }
        catch (error)
        {
            return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: (error as Error).message }], isError: true } }
        }
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${message.method}` } }
}
