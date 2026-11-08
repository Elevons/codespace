import { DefaultBatch, MaxBatchSize } from '../repo/Ingest.ts'
import { DefaultRefineSize } from '../repo/Refine.ts'
import { MaxFileNote, MaxNote, MaxShown, MaxTitle } from '../repo/ShowLimits.ts'
import { TAG_VOCABULARY } from '../../public/tags.ts'

/** A JSON Schema for one tool's arguments. */
export interface IToolParameters
{
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
    additionalProperties: false
}

/**
 * One thing an agent can do with the map, as one HTTP call. A host turns each into a tool of its own
 * that forwards the call: a GET sends the arguments as query values, a POST sends them as the JSON body
 * along with `fixed`. The answer is the endpoint's JSON, as is.
 */
export interface IMapTool
{
    /** The tool's name: lower case, words joined by underscores. A host may add its own prefix. */
    name: string
    /** What it is for and what it answers, written for the agent that calls it. */
    description: string
    /** The HTTP method. */
    method: 'GET' | 'POST'
    /** The endpoint's path on the map server. */
    path: string
    /** Fields always sent in a POST body, such as the view action. */
    fixed?: Record<string, unknown>
    /** The arguments: query values for a GET, the JSON body for a POST. */
    parameters: IToolParameters
    /** Whether it changes what the map shows, the repository it reads, or the architecture file. */
    writes: boolean
}

/** The shape of `GET /api/tools`: the version of this list's format, and the tools. */
export interface IToolList
{
    version: 1
    tools: IMapTool[]
}

/** Arguments for a tool that takes none. */
const NoArguments: IToolParameters = { type: 'object', properties: {}, additionalProperties: false }

/** A repository-relative path argument. */
const PathArgument = (description: string): Record<string, unknown> => ({ type: 'string', description })

/** A batch size argument. */
const SizeArgument = (fallback: number): Record<string, unknown> => ({
    type: 'integer', minimum: 1, maximum: MaxBatchSize, description: `How many to hand back; ${fallback} when left out, at most ${MaxBatchSize}.`,
})

/** A summary entry, for a system or a folder; null removes it. */
const SummaryEntry = { type: ['object', 'null'], properties: { summary: { type: ['string', 'null'] } }, additionalProperties: false }

/** One file's entry, as `apply` takes it; a field set to null is removed. */
const FileEntry = {
    type: 'object',
    properties: {
        summary: { type: ['string', 'null'], description: 'One plain sentence about what the file is for, not how it works.' },
        system: { type: ['string', 'null'], description: 'A system already declared in `systems`.' },
        layer: { type: ['string', 'null'], description: "A layer already declared in `layers`: the file's level or role in the stack." },
        tags: { type: ['array', 'null'], items: { type: 'string' }, description: `From: ${TAG_VOCABULARY.join(', ')}.` },
    },
    additionalProperties: false,
}

/**
 * Every tool the map offers, in the order an agent would usually want them: reading first, then
 * drawing, then describing. The built-in chat's instructions and `GET /api/tools` are both made from this.
 */
export const MapTools: readonly IMapTool[] = [
    {
        name: 'repo', method: 'GET', path: '/api/repo', writes: false, parameters: NoArguments,
        description: 'The repository the map is reading (its name and absolute root) and the ones it read recently. Check this first.',
    },
    {
        name: 'switch_repo', method: 'POST', path: '/api/repo', writes: true,
        description: 'Points the map at another repository on this machine. Every open page follows, and whatever was shown is taken down.',
        parameters: { type: 'object', properties: { path: PathArgument('The absolute path of the repository folder.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'files', method: 'GET', path: '/api/files', writes: false, parameters: NoArguments,
        description: 'Every repository-relative file path the map knows, as {"files": [...]}. Every other tool names files the same way.',
    },
    {
        name: 'architecture', method: 'GET', path: '/api/architecture', writes: false, parameters: NoArguments,
        description: "The architecture file: the layers, the systems, and each file's summary, system, layer, and tags, and each folder's summary.",
    },
    {
        name: 'graph', method: 'GET', path: '/api/graph', writes: false,
        description: 'The imports between files, as {"edges": [[from, to], ...]}, optionally only those under one folder.',
        parameters: { type: 'object', properties: { folder: PathArgument('Only edges whose files are under this folder; the whole repository when left out.') }, additionalProperties: false },
    },
    {
        name: 'source', method: 'GET', path: '/api/source', writes: false,
        description: "One file's text, answered as plain text rather than JSON.",
        parameters: { type: 'object', properties: { path: PathArgument('The repository-relative file path.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'changes', method: 'GET', path: '/api/changes', writes: false, parameters: NoArguments,
        description: 'Each file changed since the last commit, with how many lines changed. Empty outside git.',
    },
    {
        name: 'shown', method: 'GET', path: '/api/view', writes: false, parameters: NoArguments,
        description: 'What the map is showing now, as {"shown": ...}, or {"shown": null}.',
    },
    {
        name: 'show', method: 'POST', path: '/api/view', fixed: { action: 'show' }, writes: true,
        description: `Lights up files on the map, with a note on each, for every open page at once. With trace the files are numbered steps
in the order given, joined by a route, each note beside its step; a file may appear in more than one step. Each step is one file,
so name the function or method in its note. Without trace the files are only highlighted. A new show replaces the last one.
The answer is {"ok": true, "shown": n, "unknown": [...]}: any path in unknown was not drawn, so fix it and show again.
Limits: ${MaxShown} files, ${MaxFileNote} characters per file note, ${MaxTitle} for the title, ${MaxNote} for the note.`,
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: MaxTitle, description: 'What is shown, such as "How a request is served".' },
                note: { type: 'string', maxLength: MaxNote, description: 'The whole process in one or two sentences.' },
                trace: { type: 'boolean', description: 'Draw the files as numbered steps joined by a route.' },
                files: {
                    type: 'array', minItems: 1, maxItems: MaxShown,
                    items: {
                        type: 'object',
                        properties: {
                            path: PathArgument('The repository-relative file path.'),
                            note: { type: 'string', maxLength: MaxFileNote, description: 'What happens in this file, at this step.' },
                        },
                        required: ['path'], additionalProperties: false,
                    },
                },
            },
            required: ['files'], additionalProperties: false,
        },
    },
    {
        name: 'focus', method: 'POST', path: '/api/view', fixed: { action: 'focus' }, writes: true,
        description: 'Selects a file or folder and moves the camera to it.',
        parameters: { type: 'object', properties: { path: PathArgument('A repository-relative file or folder; the root when empty.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'clear', method: 'POST', path: '/api/view', fixed: { action: 'clear' }, writes: true, parameters: NoArguments,
        description: 'Takes down whatever the map is showing.',
    },
    {
        name: 'ingest_status', method: 'GET', path: '/api/ingest/status', writes: false, parameters: NoArguments,
        description: 'How much of the repository is left to describe (files, changed files, incomplete entries, folders) and how many layer breaks are left to refine.',
    },
    {
        name: 'next', method: 'POST', path: '/api/ingest/next', writes: true,
        description: `The next files (or, once every file is done, folders) whose entry needs work, with each file's source, imports,
importers, reason (new, changed, or incomplete), its current entry, and what it is missing. Moved files carry their entries along
and generated files are settled first. Describe each with apply, and repeat until "remaining" is 0.`,
        parameters: { type: 'object', properties: { size: SizeArgument(DefaultBatch) }, additionalProperties: false },
    },
    {
        name: 'apply', method: 'POST', path: '/api/architecture', writes: true,
        description: `Writes entries to the architecture file, all or nothing: any problem is an error listing every reason, and nothing is
written. Every ordinary file entry needs a summary, a system, a layer, and tags; a system or layer must be declared (in this call
or before) before an entry names it. Layers are listed bottom first and are shared by every system. Folder summaries come last.
Answers {"architecture": ..., "notes": [...]}: the file as it now stands, and anything worth knowing that did not stop the change.`,
        parameters: {
            type: 'object',
            properties: {
                layers: { type: 'array', items: { type: 'string' }, description: 'Every layer, bottom first. Replaces the list.' },
                systems: { type: 'object', additionalProperties: SummaryEntry, description: 'Systems to declare or change, by name; null removes one no file uses.' },
                files: { type: 'object', additionalProperties: FileEntry, description: 'Entry changes by repository-relative file path.' },
                folders: { type: 'object', additionalProperties: SummaryEntry, description: 'Folder summaries by folder path; null removes one.' },
                renames: {
                    type: 'array', description: 'Entries to carry to a new path, for a moved file. Applied first.',
                    items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false },
                },
                forget: { type: 'array', items: { type: 'string' }, description: 'Entries to drop, for files and folders that are gone.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'refine', method: 'GET', path: '/api/ingest/refine', writes: false,
        description: `The second pass, once next reports nothing remaining: imports that point up the layers, grouped by pair of layers,
files that would sit in fewer breaks on another layer, files whose neighbours are mostly in another system, and layering problems.
It decides nothing: read the files it names, apply what they call for, and run it again.`,
        parameters: { type: 'object', properties: { size: SizeArgument(DefaultRefineSize) }, additionalProperties: false },
    },
]
