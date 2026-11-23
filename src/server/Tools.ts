import { DefaultBatch, MaxBatchSize } from '../repo/Ingest.ts'
import { DefaultRefineSize } from '../repo/Refine.ts'
import { MaxFileNote, MaxNote, MaxShown, MaxTitle } from '../repo/ShowLimits.ts'
import { MaxFlowName } from '../../public/flows.ts'
import { MaxNeighbourDepth } from '../../public/neighbours.ts'
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
 * along with `fixed`. Either may add `?repo=<absolute path>` to choose the repository. The answer is the
 * endpoint's JSON, as is. Descriptions are written in ASD-STE100 style, as a host such as Bartleby checks.
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

/** The shape of `GET /api/tools`: the version of this list's format, how to choose a repository, and the tools. */
export interface IToolList
{
    version: 1
    /** The query value every call may carry to read one repository, whatever the server's own is. */
    repoQuery: { name: 'repo', description: string }
    tools: IMapTool[]
}

/** What `?repo=` does, for a host to tell its agent or to fill in itself. */
export const RepoQueryDescription = 'The absolute path of the repository to read. Without it, a call reads the server repository. Only this machine can open a new repository.'

/** Arguments for a tool that takes none. */
const NoArguments: IToolParameters = { type: 'object', properties: {}, additionalProperties: false }

/** A repository-relative path argument. */
const PathArgument = (description: string): Record<string, unknown> => ({ type: 'string', description })

/** A batch size argument. */
const SizeArgument = (fallback: number): Record<string, unknown> => ({
    type: 'integer', minimum: 1, maximum: MaxBatchSize, description: `The number of items to return. The default is ${fallback}. The maximum is ${MaxBatchSize}.`,
})

/** A summary entry, for a system or a folder. Null removes it. */
const SummaryEntry = { type: ['object', 'null'], properties: { summary: { type: ['string', 'null'] } }, additionalProperties: false }

/** One file's entry, as `apply` takes it. A field set to null is removed. */
const FileEntry = {
    type: 'object',
    properties: {
        summary: { type: ['string', 'null'], description: 'One plain sentence that tells the purpose of the file. Do not tell how it works.' },
        system: { type: ['string', 'null'], description: 'A system that the systems list declares.' },
        layer: { type: ['string', 'null'], description: 'A layer that the layers list declares. A layer is the level or role of the file in the stack.' },
        tags: { type: ['array', 'null'], items: { type: 'string' }, description: `Tags from this list: ${TAG_VOCABULARY.join(', ')}.` },
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
        description: 'Returns the repository that the map reads, with its name and absolute root. Use this tool first.',
    },
    {
        name: 'switch_repo', method: 'POST', path: '/api/repo', writes: true,
        description: 'Changes the server repository to a different folder on this machine. All open pages show the new repository. The map removes the files that it shows. A call with repo cannot change the repository.',
        parameters: { type: 'object', properties: { path: PathArgument('The absolute path of the repository folder.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'files', method: 'GET', path: '/api/files', writes: false, parameters: NoArguments,
        description: 'Returns every file path that the map knows. All paths are relative to the repository root. All other tools use the same paths.',
    },
    {
        name: 'architecture', method: 'GET', path: '/api/architecture', writes: false, parameters: NoArguments,
        description: 'Returns the architecture file. It has the layers and the systems. It has the summary, system, layer, and tags of each file. It has the summary of each folder.',
    },
    {
        name: 'graph', method: 'GET', path: '/api/graph', writes: false,
        description: 'Returns the imports between files as pairs of paths. Give a folder to get only the imports in that folder.',
        parameters: { type: 'object', properties: { folder: PathArgument('A folder path. If you do not give a folder, the tool returns the imports of the full repository.') }, additionalProperties: false },
    },
    {
        name: 'source', method: 'GET', path: '/api/source', writes: false,
        description: 'Returns the text of one file. The answer is plain text, not JSON.',
        parameters: { type: 'object', properties: { path: PathArgument('The file path, relative to the repository root.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'blocks', method: 'GET', path: '/api/blocks', writes: false,
        description: 'Returns the blocks that one file is made of: its imports, its groups of constants and types, and each function and class. Every function and class stays one block, however long it is. Each block has a summary, a kind, its line range, and the names of the other blocks it uses. Use a path from the files tool.',
        parameters: { type: 'object', properties: { path: PathArgument('The file path, relative to the repository root.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'changes', method: 'GET', path: '/api/changes', writes: false, parameters: NoArguments,
        description: 'Returns each file that changed after the last commit, with the number of changed lines. Outside git, the list is empty.',
    },
    {
        name: 'health', method: 'GET', path: '/api/health', writes: false, parameters: NoArguments,
        description: `Returns the shape of the codebase: its files, lines, and imports, the imports that go up the layers,
the largest files, the files without a description, and values that look like keys in files that a browser can read.
It decides nothing: each item is a place to look.`,
    },
    {
        name: 'neighbours', method: 'GET', path: '/api/neighbours', writes: false,
        description: `Returns one file and the files around it: the files that it imports and the files that import it.
With depth 2, it also returns their neighbours. The answer is ordered by distance. Use it to see the small part of
a repository that one file belongs to.`,
        parameters: {
            type: 'object',
            properties: {
                path: PathArgument('The file path, relative to the repository root.'),
                depth: { type: 'integer', minimum: 1, maximum: MaxNeighbourDepth, description: `How many steps out to walk. The default is 1. The maximum is ${MaxNeighbourDepth}.` },
            },
            required: ['path'], additionalProperties: false,
        },
    },
    {
        name: 'shown', method: 'GET', path: '/api/view', writes: false, parameters: NoArguments,
        description: 'Returns the files that the map shows now and the files that it isolates. If the map shows no files, shown is null. If it isolates no files, isolated is null.',
    },
    {
        name: 'show', method: 'POST', path: '/api/view', fixed: { action: 'show' }, writes: true,
        description: `Highlights files on the map, with a note on each file. All open pages show them at the same time.
With trace, the files become numbered steps in the given order, with a route between the steps. A file can be in more than one step.
Each step is one file, so write the name of the function or method in its note. Without trace, the map only highlights the files.
A new call replaces the files that the map shows. The answer lists each unknown path. Correct those paths and send again.
Limits: ${MaxShown} files, ${MaxFileNote} characters for each file note, ${MaxTitle} characters for the title, and ${MaxNote} characters for the note.`,
        parameters: {
            type: 'object',
            properties: {
                title: { type: 'string', maxLength: MaxTitle, description: 'The title of the route, for example "How a request is served".' },
                note: { type: 'string', maxLength: MaxNote, description: 'One or two sentences about the full process.' },
                trace: { type: 'boolean', description: 'Set true to show the files as numbered steps with a route between them.' },
                files: {
                    type: 'array', minItems: 1, maxItems: MaxShown,
                    items: {
                        type: 'object',
                        properties: {
                            path: PathArgument('The file path, relative to the repository root.'),
                            note: { type: 'string', maxLength: MaxFileNote, description: 'What occurs in this file at this step.' },
                        },
                        required: ['path'], additionalProperties: false,
                    },
                },
            },
            required: ['files'], additionalProperties: false,
        },
    },
    {
        name: 'isolate', method: 'POST', path: '/api/view', fixed: { action: 'isolate' }, writes: true,
        description: `Shows only the given files. The map hides every other file, so the given files stand alone on the map.
This is an ad-hoc filter, not a highlight: the files that stay are drawn as usual, and the Outliner lists only them.
A new call replaces the last isolation. Give an empty files list to remove the isolation and show every file again.
The answer lists each unknown path. Correct those paths and send again.
Limits: ${MaxShown} files.`,
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array', minItems: 0, maxItems: MaxShown,
                    items: PathArgument('The file path, relative to the repository root.'),
                    description: 'The files to keep, or an empty list to remove the isolation.',
                },
            },
            required: ['files'], additionalProperties: false,
        },
    },
    {
        name: 'select', method: 'POST', path: '/api/view', fixed: { action: 'select' }, writes: true,
        description: `Selects one or more files at the same time, as if they were shift-clicked, and draws the import traces of every selected file.
The first file opens its block stack; the rest are added to the selection and listed beside it.
It clears any route the map was showing first, so the traces are visible. A new call replaces the selection.
The answer lists each unknown path. Correct those paths and send again.
Limits: ${MaxShown} files.`,
        parameters: {
            type: 'object',
            properties: {
                files: {
                    type: 'array', minItems: 1, maxItems: MaxShown,
                    items: PathArgument('The file path, relative to the repository root.'),
                    description: 'The files to select, in the order they should be chosen.',
                },
            },
            required: ['files'], additionalProperties: false,
        },
    },
    {
        name: 'focus', method: 'POST', path: '/api/view', fixed: { action: 'focus' }, writes: true,
        description: 'Selects one file or folder and moves the camera to it.',
        parameters: { type: 'object', properties: { path: PathArgument('A file or folder path, relative to the repository root. An empty path is the root.') }, required: ['path'], additionalProperties: false },
    },
    {
        name: 'clear', method: 'POST', path: '/api/view', fixed: { action: 'clear' }, writes: true, parameters: NoArguments,
        description: 'Removes all files that the map shows.',
    },
    {
        name: 'flows', method: 'GET', path: '/api/flows', writes: false, parameters: NoArguments,
        description: 'Returns the flows that the repository keeps. A flow is a list of files in order, with a note on each, that the map can show again as a route.',
    },
    {
        name: 'tour', method: 'GET', path: '/api/flows', writes: false,
        description: `Drafts a tour to start with, from the descriptions that the architecture file already has.
It starts at the files with the entry tag, then follows their imports out, one file at a time. The answer is a flow that is not saved.
Save it with save_flow to keep it. The answer is null when too few files have a description.`,
        parameters: {
            type: 'object',
            properties: { draft: { type: 'boolean', description: 'Set true to draft a tour instead of listing the saved flows.' } },
            required: ['draft'], additionalProperties: false,
        },
    },
    {
        name: 'save_flow', method: 'POST', path: '/api/flows', fixed: { action: 'save' }, writes: true,
        description: `Saves a flow under its name, and replaces a flow with the same name.
Every path must be a file in the repository. Use show_flow to draw it on the map.`,
        parameters: {
            type: 'object',
            properties: {
                flow: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', maxLength: MaxFlowName, description: 'The name to save the flow under.' },
                        title: { type: 'string', maxLength: MaxTitle, description: 'The heading the map shows above the steps.' },
                        note: { type: 'string', maxLength: MaxNote, description: 'One or two sentences about the whole flow.' },
                        trace: { type: 'boolean', description: 'Set true to show the steps as a numbered route.' },
                        files: {
                            type: 'array', minItems: 1, maxItems: MaxShown,
                            items: {
                                type: 'object',
                                properties: {
                                    path: PathArgument('The file path, relative to the repository root.'),
                                    note: { type: 'string', maxLength: MaxFileNote, description: 'What happens in this file at this step.' },
                                },
                                required: ['path'], additionalProperties: false,
                            },
                        },
                    },
                    required: ['name', 'files'], additionalProperties: false,
                },
            },
            required: ['flow'], additionalProperties: false,
        },
    },
    {
        name: 'show_flow', method: 'POST', path: '/api/flows', fixed: { action: 'show' }, writes: true,
        description: 'Draws one saved flow on the map, as a route or as a set of highlighted files. Every open page follows it.',
        parameters: { type: 'object', properties: { name: { type: 'string', maxLength: MaxFlowName, description: 'The name of the flow.' } }, required: ['name'], additionalProperties: false },
    },
    {
        name: 'delete_flow', method: 'POST', path: '/api/flows', fixed: { action: 'delete' }, writes: true,
        description: 'Deletes one saved flow. The answer lists the flows that remain.',
        parameters: { type: 'object', properties: { name: { type: 'string', maxLength: MaxFlowName, description: 'The name of the flow.' } }, required: ['name'], additionalProperties: false },
    },
    {
        name: 'ingest_status', method: 'GET', path: '/api/ingest/status', writes: false, parameters: NoArguments,
        description: 'Returns the number of files and folders that need a description. It also returns the number of layer breaks to refine.',
    },
    {
        name: 'next', method: 'POST', path: '/api/ingest/next', writes: true,
        description: `Returns the next files that need a description. When all files have a description, it returns folders.
Each file has its source, its imports, the files that import it, its reason, its current entry, and the fields it needs.
The reason is new, changed, or incomplete. The tool moves the entries of moved files and writes the generated files first.
Write each entry with apply. Do this again until remaining is 0.`,
        parameters: { type: 'object', properties: { size: SizeArgument(DefaultBatch) }, additionalProperties: false },
    },
    {
        name: 'apply', method: 'POST', path: '/api/architecture', writes: true,
        description: `Writes entries to the architecture file. It writes all entries or no entries. If there is a problem, the answer lists each reason.
Each usual file entry needs a summary, a system, a layer, and tags. Declare a system or a layer before an entry uses it.
List the layers from the bottom layer to the top layer. All systems use the same layers. Write the folder summaries last.
The answer has the full architecture file and a list of notes.`,
        parameters: {
            type: 'object',
            properties: {
                layers: { type: 'array', items: { type: 'string' }, description: 'All layers, from the bottom layer to the top layer. This list replaces the old list.' },
                systems: { type: 'object', additionalProperties: SummaryEntry, description: 'The systems to declare or change, by name. Null removes a system that no file uses.' },
                files: { type: 'object', additionalProperties: FileEntry, description: 'The entry changes, by file path.' },
                folders: { type: 'object', additionalProperties: SummaryEntry, description: 'The folder summaries, by folder path. Null removes a summary.' },
                renames: {
                    type: 'array', description: 'The entries to move to a new path, for a moved file. The tool applies these first.',
                    items: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' } }, required: ['from', 'to'], additionalProperties: false },
                },
                forget: { type: 'array', items: { type: 'string' }, description: 'The entries to remove, for files and folders that do not exist now.' },
            },
            additionalProperties: false,
        },
    },
    {
        name: 'create_file', method: 'POST', path: '/api/files', writes: true,
        description: `Makes a new file in the repository and writes its entry to the architecture file in the same step.
The file starts with its summary as a comment. It does not change a file that exists.
The layer and the system must be declared before. Declare them with apply.
The answer has the path of the new file and a list of notes.`,
        parameters: {
            type: 'object',
            properties: {
                path: PathArgument('The repository-relative path of the new file, with its name and extension. Folders that do not exist are made.'),
                summary: { type: 'string', description: 'One plain sentence that tells the purpose of the file. Do not tell how it works.' },
                layer: { type: 'string', description: 'A layer that the layers list declares. A layer is the level or role of the file in the stack.' },
                system: { type: 'string', description: 'A system that the systems list declares.' },
                tags: { type: 'array', items: { type: 'string' }, description: `Tags from this list: ${TAG_VOCABULARY.join(', ')}.` },
            },
            required: ['path', 'summary', 'layer'],
            additionalProperties: false,
        },
    },
    {
        name: 'refine', method: 'GET', path: '/api/ingest/refine', writes: false,
        description: `The second pass. Use it after next returns 0 remaining. It returns the imports that go up the layers, grouped by pair of layers.
It also returns files that can go on a better layer, files that can go in a better system, and layer problems.
It does not change the architecture file. Read the files that it names. Write the changes with apply, and then use it again.`,
        parameters: { type: 'object', properties: { size: SizeArgument(DefaultRefineSize) }, additionalProperties: false },
    },
]
