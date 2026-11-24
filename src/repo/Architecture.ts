import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { TAG_VOCABULARY } from '../../public/tags.ts'
import { ArchitecturePath, CodespaceFolder, JsonStore } from './JsonStore.ts'

/** The longest summary or note kept, in characters. */
export const MaxSummary = 2000

/** The longest name a note may be kept under, in characters. */
export const MaxNoteKey = 200

/** Whether a value is a plain JSON object, not null and not a list. */
function IsObject(value: unknown): value is Record<string, unknown>
{
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** What the architecture file says about one file. */
interface IFileEntry
{
    /** The system the file belongs to. */
    system?: string
    /** The layer the file belongs to. */
    layer?: string
    /** The role tags it carries, primary first. */
    tags?: string[]
    /** What it is for, in a sentence. */
    summary?: string
    /**
     * What the file's declarations are for, kept here rather than as comments in the code. Each is
     * keyed by the declaration's name, with a class's members as "Class.member", and the steps of a
     * function as "Function:1", "Function:2", in order.
     */
    notes?: Record<string, string>
}

/** What the architecture file says about one system: a slice of the repository that shares layers. */
interface ISystemEntry
{
    /** What the system is for, in a sentence. */
    summary?: string
}

export interface IThing
{
    summary?: string
    layer?: string
    rules?: string[]
}

export interface IStep
{
    text: string
    files: string[]
}

export interface IOperation
{
    summary?: string
    files: string[]
    reads: string[]
    writes: string[]
    steps: IStep[]
    rules: string[]
}

export interface IConcepts
{
    things: Record<string, IThing>
    operations: Record<string, IOperation>
}

export interface IThingPatch
{
    summary?: string | null
    layer?: string | null
    rules?: string[] | null
}

export interface IOperationPatch
{
    summary?: string | null
    files?: string[] | null
    reads?: string[] | null
    writes?: string[] | null
    steps?: Array<{ text: string, files?: string[] }> | null
    rules?: string[] | null
}

export interface IConceptsPatch
{
    things?: Record<string, IThingPatch | null>
    operations?: Record<string, IOperationPatch | null>
}

/** A repository's architecture, as the map reads it. */
export interface IArchitecture
{
    concepts: IConcepts
    /** The layer names, bottom plane first. Layers are shared by every system. */
    layers: string[]
    /** The systems, by name. A system groups files without owning its own layers. */
    systems: Record<string, ISystemEntry>
    /** What is known about each file, by repository-relative path. */
    files: Record<string, IFileEntry>
    /** What each folder is for, in a sentence, by repository-relative path. */
    folders: Record<string, string>
    /** Things worth fixing in the file that did not stop it being read. */
    warnings: string[]
    /** Why the file could not be read at all, or empty. */
    error: string
}

/** A change to the architecture file. Nothing in it is required. */
export interface IArchitecturePatch
{
    /** The new layer order, replacing the old one. Layers are shared by every system. */
    layers?: string[]
    /** Systems to add, change, or remove. Null removes one that no file uses. */
    systems?: Record<string, { summary?: string | null } | null>
    /** Changes to individual files by path. A field set to null is removed. */
    files?: Record<string, { system?: string | null, layer?: string | null, tags?: string[] | null, summary?: string | null,
        notes?: Record<string, string | null> | null, replaceNotes?: boolean }>
    /** Changes to folder summaries by path. Null removes one. */
    folders?: Record<string, { summary?: string | null }>
    /** Things and operations to add, change, or remove, merged by name. Null removes one; a field set to null is removed. */
    concepts?: IConceptsPatch
    /** Entries to move to a new path, for a file that was moved or renamed. Applied first. */
    renames?: Array<{ from: string, to: string }>
    /** Entries to delete for files and folders that are gone. A path that still exists is refused. */
    forget?: string[]
}

/** The result of a change that was made. */
interface IUpdated
{
    /** The architecture as it now reads. */
    architecture: IArchitecture
    /** Things worth knowing about the change that did not stop it. */
    notes: string[]
}

/** Reads the one file that says how a repository is laid out: its layers, tags, and summaries. */
export class Architecture
{
    /**
     * Reads a repository's architecture file. A repository without one simply has none.
     * @param root the repository's real path
     * @param known every file in the repository, so entries for files that are gone can be reported
     */
    public static async ReadAsync(root: string, known: readonly string[]): Promise<IArchitecture>
    {
        const result: IArchitecture = { layers: [], systems: {}, files: {}, folders: {}, concepts: { things: {}, operations: {} }, warnings: [], error: '' }

        // First we read the file, making sure a link cannot point it outside the repository.
        let text: string | null
        try { text = await JsonStore.ReadAsync(root, ArchitecturePath) }
        catch (error)
        {
            result.error = `${ArchitecturePath} could not be read: ${(error as Error).message}`
            return result
        }
        if (text === null) return result

        // Then we parse it, and keep what is well formed.
        let data: unknown
        try { data = JSON.parse(text) }
        catch (error) { result.error = `${ArchitecturePath} is not valid JSON: ${(error as Error).message}`; return result }
        if (typeof data !== 'object' || data === null || Array.isArray(data))
        {
            result.error = `${ArchitecturePath} must be a JSON object with "layers" and "files".`
            return result
        }
        const sections = data as Record<string, unknown>

        if (Array.isArray(sections.layers))
        {
            for (const layer of sections.layers)
            {
                if (typeof layer === 'string' && layer.trim() !== '' && !result.layers.includes(layer.trim())) result.layers.push(layer.trim())
                else result.warnings.push(`"layers" holds ${JSON.stringify(layer)}, which is not a new layer name.`)
            }
        }
        else if (sections.layers !== undefined) result.warnings.push('"layers" should be a list of layer names.')

        // Systems are declared by name, each with an optional summary; they do not own layers.
        if (typeof sections.systems === 'object' && sections.systems !== null && !Array.isArray(sections.systems))
        {
            for (const [rawName, rawEntry] of Object.entries(sections.systems as Record<string, unknown>))
            {
                const name = rawName.trim()
                if (name === '') { result.warnings.push('"systems" holds an empty name; it is ignored.'); continue }
                if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry))
                {
                    result.warnings.push(`The system "${name}" should be an object with a summary.`)
                    continue
                }
                const entry: ISystemEntry = {}
                const summary = (rawEntry as { summary?: unknown }).summary
                if (typeof summary === 'string' && summary.trim() !== '') entry.summary = summary.trim().slice(0, MaxSummary)
                else if (summary !== undefined) result.warnings.push(`The system "${name}" should have a text summary.`)
                result.systems[name] = entry
            }
        }
        else if (sections.systems !== undefined) result.warnings.push('"systems" should be an object keyed by system name.')

        const files = typeof sections.files === 'object' && sections.files !== null && !Array.isArray(sections.files)
            ? sections.files as Record<string, unknown>
            : {}
        if (sections.files !== undefined && files !== sections.files) result.warnings.push('"files" should be an object keyed by file path.')

        // Then we check each entry against the files that exist.
        const exists = new Set(known)
        for (const [path, raw] of Object.entries(files))
        {
            if (!exists.has(path)) { result.warnings.push(`"${path}" is not a file in the repository; its entry is ignored.`); continue }
            if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) { result.warnings.push(`The entry for "${path}" should be an object.`); continue }
            result.files[path] = Architecture.ReadEntry(path, raw as Record<string, unknown>, result)
        }

        // And each folder's summary, against the folders that exist.
        const folders = Architecture.Folders(known)
        if (typeof sections.folders === 'object' && sections.folders !== null && !Array.isArray(sections.folders))
        {
            for (const [path, raw] of Object.entries(sections.folders as Record<string, unknown>))
            {
                const summary = (raw as { summary?: unknown } | null)?.summary
                if (!folders.has(path)) result.warnings.push(`"${path}" is not a folder in the repository; its entry is ignored.`)
                else if (typeof summary === 'string' && summary.trim() !== '') result.folders[path] = summary.trim().slice(0, MaxSummary)
                else result.warnings.push(`The folder "${path}" should have a summary.`)
            }
        }
        else if (sections.folders !== undefined) result.warnings.push('"folders" should be an object keyed by folder path.')

        if (sections.concepts !== undefined) Architecture.ReadConcepts(sections.concepts, exists, result)
        return result
    }

    private static ReadConcepts(raw: unknown, exists: ReadonlySet<string>, result: IArchitecture): void
    {
        if (!IsObject(raw)) { result.warnings.push('"concepts" should be an object with "things" and "operations".'); return }
        const summaryOf = (entry: Record<string, unknown>, what: string): string | undefined =>
        {
            if (typeof entry.summary === 'string' && entry.summary.trim() !== '') return entry.summary.trim().slice(0, MaxSummary)
            if (entry.summary !== undefined) result.warnings.push(`${what} should have a text summary.`)
            return undefined
        }
        const textList = (entry: Record<string, unknown>, key: string, what: string): string[] =>
        {
            const value = entry[key]
            if (value === undefined) return []
            if (!Array.isArray(value)) { result.warnings.push(`${what} should list its ${key} as text.`); return [] }
            return value.filter((item): item is string => typeof item === 'string' && item.trim() !== '').map((item) => item.trim().slice(0, MaxSummary))
        }

        const things = IsObject(raw.things) ? raw.things : {}
        if (raw.things !== undefined && !IsObject(raw.things)) result.warnings.push('"concepts.things" should be an object keyed by name.')
        for (const [rawName, entry] of Object.entries(things))
        {
            const name = rawName.trim()
            if (name === '' || !IsObject(entry)) { result.warnings.push(`The thing "${rawName}" should be an object with a summary.`); continue }
            const thing: IThing = {}
            const summary = summaryOf(entry, `The thing "${name}"`)
            if (summary !== undefined) thing.summary = summary
            if (typeof entry.layer === 'string' && entry.layer.trim() !== '')
            {
                if (result.layers.includes(entry.layer.trim())) thing.layer = entry.layer.trim()
                else result.warnings.push(`The thing "${name}" is on layer "${entry.layer}", which "layers" does not list.`)
            }
            else if (entry.layer !== undefined) result.warnings.push(`The thing "${name}": layer should be a name.`)
            const rules = textList(entry, 'rules', `The thing "${name}"`)
            if (rules.length > 0) thing.rules = rules
            result.concepts.things[name] = thing
        }

        const operations = IsObject(raw.operations) ? raw.operations : {}
        if (raw.operations !== undefined && !IsObject(raw.operations)) result.warnings.push('"concepts.operations" should be an object keyed by name.')
        for (const [rawName, entry] of Object.entries(operations))
        {
            const name = rawName.trim()
            if (name === '' || !IsObject(entry)) { result.warnings.push(`The operation "${rawName}" should be an object.`); continue }
            const list = (key: 'files' | 'reads' | 'writes'): string[] =>
            {
                const value = entry[key]
                if (value === undefined) return []
                if (!Array.isArray(value)) { result.warnings.push(`The operation "${name}" should list its ${key}.`); return [] }
                const kept: string[] = []
                for (const item of value)
                {
                    if (typeof item !== 'string') continue
                    if (key === 'files' && !exists.has(item)) { result.warnings.push(`The operation "${name}" names "${item}", which is not a file in the repository.`); continue }
                    if (key !== 'files' && result.concepts.things[item] === undefined) { result.warnings.push(`The operation "${name}" ${key} "${item}", which is not a declared thing.`); continue }
                    if (!kept.includes(item)) kept.push(item)
                }
                return kept
            }
            const operation: IOperation = { files: list('files'), reads: list('reads'), writes: list('writes'), steps: [], rules: textList(entry, 'rules', `The operation "${name}"`) }
            if (Array.isArray(entry.steps))
            {
                for (const step of entry.steps)
                {
                    if (!IsObject(step) || typeof step.text !== 'string' || step.text.trim() === '') { result.warnings.push(`A step of the operation "${name}" should be an object with text.`); continue }
                    const stepFiles: string[] = []
                    for (const item of Array.isArray(step.files) ? step.files : [])
                    {
                        if (typeof item !== 'string') continue
                        if (!exists.has(item)) { result.warnings.push(`A step of the operation "${name}" names "${item}", which is not a file in the repository.`); continue }
                        if (!stepFiles.includes(item)) stepFiles.push(item)
                    }
                    operation.steps.push({ text: step.text.trim().slice(0, MaxSummary), files: stepFiles })
                    // A step's files are evidence, so the operation holds them too.
                    for (const item of stepFiles) if (!operation.files.includes(item)) operation.files.push(item)
                }
            }
            else if (entry.steps !== undefined) result.warnings.push(`The operation "${name}" should list its steps.`)
            const summary = summaryOf(entry, `The operation "${name}"`)
            if (summary !== undefined) operation.summary = summary
            result.concepts.operations[name] = operation
        }
    }

    /**
     * Changes the architecture file, all or nothing: if any part of the change is wrong, nothing is written.
     * @param root the repository's real path
     * @param known every file in the repository
     * @param patch the change to make
     * @returns the architecture as it now reads
     */
    public static UpdateAsync(root: string, known: readonly string[], patch: IArchitecturePatch): Promise<IUpdated>
    {
        return JsonStore.RunAsync(root, () => Architecture.ApplyAsync(root, known, patch))
    }

    /**
     * Lists the entries the file keeps for files and folders that are gone: read from the raw file,
     * since reading it for the map drops them.
     * @param root the repository's real path
     * @param known every file in the repository
     */
    public static async StaleAsync(root: string, known: readonly string[]): Promise<{ files: string[], folders: string[] }>
    {
        const stale = { files: [] as string[], folders: [] as string[] }
        try
        {
            const text = await JsonStore.ReadAsync(root, ArchitecturePath)
            if (text === null) return stale
            const parsed = JSON.parse(text) as { files?: unknown, folders?: unknown } | null
            const exists = new Set(known), folders = Architecture.Folders(known)
            if (typeof parsed?.files === 'object' && parsed.files !== null) stale.files = Object.keys(parsed.files).filter((path) => !exists.has(path)).sort()
            if (typeof parsed?.folders === 'object' && parsed.folders !== null) stale.folders = Object.keys(parsed.folders).filter((path) => !folders.has(path)).sort()
        }
        catch { /* No readable file means nothing is stale. */ }
        return stale
    }

    /**
     * Deletes a repository's architecture folder, so the map draws it with no layers, systems, or
     * summaries, as a repository that was never described. This removes the whole `.codespace` folder,
     * including the upkeep rules and ledger kept there, and nothing else in the repository.
     * @param root the repository's real path
     */
    public static DeleteAsync(root: string): Promise<void>
    {
        return JsonStore.RunAsync(root, async () =>
        {
            // The path is fixed and inside the repository. A symlink of that name is removed, not followed,
            // so this can never delete through it.
            await rm(join(root, CodespaceFolder), { recursive: true, force: true })
        })
    }

    /**
     * Makes one change to the file.
     * @param root the repository's real path
     * @param known every file in the repository
     * @param patch the change to make
     */
    private static async ApplyAsync(root: string, known: readonly string[], patch: IArchitecturePatch): Promise<IUpdated>
    {
        // First we check the change's shape, so a wrongly typed field can never reach the file.
        const shape = Architecture.ShapeProblems(patch)
        if (shape.length > 0) throw new Error(shape.join('\n'))

        // Then we read what is there, refusing to overwrite a file we cannot understand.
        let raw: Record<string, unknown> = {}
        try
        {
            const text = await JsonStore.ReadAsync(root, ArchitecturePath)
            if (text !== null)
            {
                const parsed: unknown = JSON.parse(text)
                if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('it is not a JSON object')
                raw = parsed as Record<string, unknown>
            }
        }
        catch (error)
        {
            throw new Error(`${ArchitecturePath} cannot be changed until it is fixed: ${(error as Error).message}`)
        }
        const { layers: oldLayers, systems: oldSystems, files: oldFiles, folders: oldFolders, concepts: oldConcepts, ...others } = raw
        let layers = Array.isArray(oldLayers) ? oldLayers.filter((layer): layer is string => typeof layer === 'string') : []
        const systems: Record<string, Record<string, unknown>> = {}
        if (typeof oldSystems === 'object' && oldSystems !== null && !Array.isArray(oldSystems))
        {
            for (const [name, entry] of Object.entries(oldSystems))
            {
                if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) systems[name] = { ...entry }
                else if (name.trim() !== '') systems[name] = {}
            }
        }
        const files: Record<string, Record<string, unknown>> = {}
        if (typeof oldFiles === 'object' && oldFiles !== null && !Array.isArray(oldFiles))
        {
            for (const [path, entry] of Object.entries(oldFiles)) if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) files[path] = { ...entry }
        }

        const folders: Record<string, Record<string, unknown>> = {}
        if (typeof oldFolders === 'object' && oldFolders !== null && !Array.isArray(oldFolders))
        {
            for (const [path, entry] of Object.entries(oldFolders)) if (typeof entry === 'object' && entry !== null && !Array.isArray(entry)) folders[path] = { ...entry }
        }

        const concepts = { things: {} as Record<string, Record<string, unknown>>, operations: {} as Record<string, Record<string, unknown>> }
        if (IsObject(oldConcepts))
        {
            for (const kind of ['things', 'operations'] as const)
            {
                const section = oldConcepts[kind]
                if (IsObject(section)) for (const [name, entry] of Object.entries(section)) if (IsObject(entry)) concepts[kind][name] = { ...entry }
            }
        }

        // Then we apply the change in memory, collecting every problem rather than stopping at the first.
        const exists = new Set(known)
        const problems: string[] = []
        const notes: string[] = []

        for (const { from, to } of patch.renames ?? [])
        {
            if (files[from] === undefined) problems.push(`Cannot rename "${from}": it has no entry.`)
            else if (!exists.has(to)) problems.push(`Cannot rename "${from}" to "${to}": "${to}" is not a file in the repository.`)
            else if (files[to] !== undefined) problems.push(`Cannot rename "${from}" to "${to}": "${to}" already has an entry.`)
            else
            {
                files[to] = files[from]!; delete files[from]
                for (const operation of Object.values(concepts.operations)) Architecture.RenameInOperation(operation, from, to)
            }
        }

        for (const path of patch.forget ?? [])
        {
            if (exists.has(path) || Architecture.Folders(known).has(path)) problems.push(`Cannot forget "${path}": it is still in the repository.`)
            else { delete files[path]; delete folders[path] }
        }

        if (patch.layers !== undefined)
        {
            const wanted = patch.layers.map((layer) => (typeof layer === 'string' ? layer.trim() : ''))
            if (wanted.some((layer) => layer === '') || new Set(wanted).size !== wanted.length) problems.push('"layers" must be unique, non-empty names.')
            else layers = wanted
        }

        // A system is a name and an optional summary. Layers stay global, so a layer can appear in several systems.
        for (const [rawName, change] of Object.entries(patch.systems ?? {}))
        {
            const name = typeof rawName === 'string' ? rawName.trim() : ''
            if (name === '') { problems.push('A system needs a non-empty name.'); continue }
            if (change === null)
            {
                // The files this patch leaves in the system: a file in this same patch that names it
                // stays, whether or not it was there before, and a file that moves away is free.
                const projected = (path: string): string | undefined =>
                {
                    const fileChange = patch.files?.[path]
                    if (fileChange !== undefined && fileChange.system !== undefined) return fileChange.system ?? undefined
                    const system = files[path]?.system
                    return typeof system === 'string' ? system : undefined
                }
                const users = [...exists].filter((path) => projected(path) === name)
                if (users.length > 0) problems.push(`Cannot remove system "${name}": ${users.length} file${users.length === 1 ? ' is' : 's are'} still in it (${users.slice(0, 3).join(', ')}${users.length > 3 ? ', …' : ''}).`)
                else delete systems[name]
                continue
            }
            const entry = systems[name] ?? {}
            if (change.summary !== undefined)
            {
                if (change.summary === null || change.summary.trim() === '') delete entry.summary
                else if (change.summary.length > MaxSummary) problems.push(`The system "${name}": summary is over ${MaxSummary} characters.`)
                else entry.summary = change.summary.trim()
            }
            systems[name] = entry
        }

        for (const [path, change] of Object.entries(patch.files ?? {}))
        {
            if (!exists.has(path)) { problems.push(`"${path}" is not a file in the repository.`); continue }
            const entry = files[path] ?? {}
            if (change.system !== undefined)
            {
                if (change.system === null) delete entry.system
                else if (change.system.trim() === '') problems.push(`"${path}": system must be a non-empty name.`)
                else if (!(change.system.trim() in systems)) problems.push(`"${path}": system "${change.system.trim()}" is not in systems (${Object.keys(systems).join(', ') || 'none'}). Add it to "systems" first.`)
                else entry.system = change.system.trim()
            }
            if (change.layer !== undefined)
            {
                if (change.layer === null) delete entry.layer
                else if (!layers.includes(change.layer)) problems.push(`"${path}": layer "${change.layer}" is not in layers (${layers.join(', ') || 'none'}). Add it to "layers" first.`)
                else entry.layer = change.layer
            }
            if (change.tags !== undefined)
            {
                if (change.tags === null) delete entry.tags
                else if (!Array.isArray(change.tags) || change.tags.some((tag) => typeof tag !== 'string' || tag.trim() === '')) problems.push(`"${path}": tags must be a list of names.`)
                else
                {
                    entry.tags = change.tags.map((tag) => tag.trim())
                    for (const tag of entry.tags as string[]) if (!(TAG_VOCABULARY as readonly string[]).includes(tag)) notes.push(`"${path}": tag "${tag}" is not in the vocabulary (${TAG_VOCABULARY.join(', ')}); it will be grey.`)
                }
            }
            if (change.summary !== undefined)
            {
                if (change.summary === null || change.summary.trim() === '') delete entry.summary
                else if (change.summary.length > MaxSummary) problems.push(`"${path}": summary is over ${MaxSummary} characters.`)
                else entry.summary = change.summary.trim()
            }
            if (change.notes !== undefined)
            {
                // Notes are merged by name: a note set to null is removed, and null for all of them clears them.
                // replaceNotes drops the old notes first, so the given set is the whole set.
                const kept: Record<string, string> = change.notes === null || change.replaceNotes === true || !IsObject(entry.notes)
                    ? {}
                    : { ...(entry.notes as Record<string, string>) }
                for (const [rawKey, note] of Object.entries(change.notes ?? {}))
                {
                    const key = rawKey.trim()
                    if (key === '' || key.length > MaxNoteKey) { problems.push(`"${path}": a note needs a name of 1 to ${MaxNoteKey} characters.`); continue }
                    if (note === null || note.trim() === '') delete kept[key]
                    else if (note.length > MaxSummary) problems.push(`"${path}": the note "${key}" is over ${MaxSummary} characters.`)
                    else kept[key] = note.trim()
                }
                if (Object.keys(kept).length === 0) delete entry.notes
                else entry.notes = kept
            }
            if (Object.keys(entry).length === 0) delete files[path]
            else files[path] = entry
        }
        const knownFolders = Architecture.Folders(known)
        for (const [path, change] of Object.entries(patch.folders ?? {}))
        {
            if (!knownFolders.has(path)) { problems.push(`"${path}" is not a folder in the repository.`); continue }
            const summary = change?.summary
            if (summary === undefined) continue
            if (summary === null || summary.trim() === '') delete folders[path]
            else if (summary.length > MaxSummary) problems.push(`"${path}": summary is over ${MaxSummary} characters.`)
            else folders[path] = { ...folders[path], summary: summary.trim() }
        }
        Architecture.ApplyConcepts(patch.concepts, concepts, layers, exists, problems)
        if (problems.length > 0) throw new Error(problems.join('\n'))

        // Finally we write it whole, so a reader never sees half of it.
        await JsonStore.WriteAsync(root, ArchitecturePath, Architecture.Serialize(layers, systems, files, folders, concepts, others))
        return { architecture: await Architecture.ReadAsync(root, known), notes }
    }

    /**
     * Writes the file the way it is kept by hand: one entry per file, tags on one line.
     * @param layers the layer order
     * @param systems each system's entry, in the order they were declared
     * @param files each file's entry, by path
     * @param folders each folder's entry, by path
     * @param others any other top-level fields the file had, which are kept
     */
    private static Serialize(layers: readonly string[], systems: Record<string, Record<string, unknown>>, files: Record<string, Record<string, unknown>>, folders: Record<string, Record<string, unknown>>, concepts: { things: Record<string, Record<string, unknown>>, operations: Record<string, Record<string, unknown>> }, others: Record<string, unknown>): string
    {
        const order = ['system', 'layer', 'tags', 'summary']
        const section = (entries: Record<string, Record<string, unknown>>, declared = false): string =>
        {
            const keysOf = declared ? Object.keys(entries) : Object.keys(entries).sort()
            const lines = keysOf.map((path) =>
            {
                const entry = entries[path]!
                const keys = [...order.filter((key) => key in entry), ...Object.keys(entry).filter((key) => !order.includes(key))]
                // Notes are many and long, so each goes on its own line.
                const value = (key: string): string => key === 'notes' && IsObject(entry[key])
                    ? Architecture.Block(entry[key] as Record<string, unknown>)
                    : Architecture.Inline(entry[key])
                const body = keys.length === 0 ? '{}' : `{\n${keys.map((key) => `      ${JSON.stringify(key)}: ${value(key)}`).join(',\n')}\n    }`
                return `    ${JSON.stringify(path)}: ${body}`
            })
            return lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n  }`
        }
        // Systems keep the order they were declared in, so the map's deck of cards stays stable.
        const systemSection = Object.keys(systems).length === 0 ? '' : `,\n  "systems": ${section(systems, true)}`
        const folderSection = Object.keys(folders).length === 0 ? '' : `,\n  "folders": ${section(folders)}`
        const conceptSection = Object.keys(concepts.things).length + Object.keys(concepts.operations).length === 0 ? '' : `,\n  "concepts": ${Architecture.ConceptsBlock(concepts)}`
        const extra = Object.entries(others).map(([key, value]) => `,\n  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`).join('')
        return `{\n  "layers": ${Architecture.Inline(layers)}${systemSection},\n  "files": ${section(files)}${folderSection}${conceptSection}${extra}\n}\n`
    }

    /**
     * Checks that a change has the shape it claims, before any of it is applied.
     * @param patch the change to make
     * @returns a sentence for each field whose type or shape is wrong
     */
    private static ShapeProblems(patch: IArchitecturePatch): string[]
    {
        if (!IsObject(patch)) return ['The change must be a JSON object: {"files": {...}, "folders": {...}}.']
        const problems: string[] = []

        if (patch.layers !== undefined && (!Array.isArray(patch.layers) || patch.layers.some((layer) => typeof layer !== 'string')))
            problems.push('"layers" must be a list of layer names.')

        if (patch.systems !== undefined)
        {
            if (!IsObject(patch.systems)) problems.push('"systems" must be an object keyed by system name.')
            else for (const [name, change] of Object.entries(patch.systems))
            {
                if (change === null) continue
                if (!IsObject(change)) { problems.push(`The system "${name}" must be an object with an optional summary.`); continue }
                if (change.summary !== undefined && change.summary !== null && typeof change.summary !== 'string') problems.push(`The system "${name}": summary must be text.`)
            }
        }

        if (patch.files !== undefined)
        {
            if (!IsObject(patch.files)) problems.push('"files" must be an object keyed by file path.')
            else for (const [path, change] of Object.entries(patch.files))
            {
                if (!IsObject(change)) { problems.push(`The entry for "${path}" must be an object.`); continue }
                for (const field of ['system', 'layer', 'summary'] as const)
                    if (change[field] !== undefined && change[field] !== null && typeof change[field] !== 'string') problems.push(`"${path}": ${field} must be text.`)
                const notes = change.notes
                if (notes !== undefined && notes !== null && (!IsObject(notes) || Object.values(notes).some((note) => note !== null && typeof note !== 'string')))
                    problems.push(`"${path}": notes must be an object of text, keyed by name.`)
                if (change.replaceNotes !== undefined && typeof change.replaceNotes !== 'boolean') problems.push(`"${path}": replaceNotes must be true or false.`)
                const tags = change.tags
                if (tags !== undefined && tags !== null && (!Array.isArray(tags) || tags.some((tag) => typeof tag !== 'string'))) problems.push(`"${path}": tags must be a list of names.`)
            }
        }

        if (patch.folders !== undefined)
        {
            if (!IsObject(patch.folders)) problems.push('"folders" must be an object keyed by folder path.')
            else for (const [path, change] of Object.entries(patch.folders))
            {
                if (!IsObject(change)) { problems.push(`The folder "${path}" must be an object with an optional summary.`); continue }
                if (change.summary !== undefined && change.summary !== null && typeof change.summary !== 'string') problems.push(`"${path}": summary must be text.`)
            }
        }

        if (patch.concepts !== undefined) problems.push(...Architecture.ConceptShapeProblems(patch.concepts as IConceptsPatch))

        if (patch.renames !== undefined && (!Array.isArray(patch.renames) || patch.renames.some((rename) => !IsObject(rename) || typeof rename.from !== 'string' || typeof rename.to !== 'string')))
            problems.push('"renames" must be a list of {"from", "to"} paths.')

        if (patch.forget !== undefined && (!Array.isArray(patch.forget) || patch.forget.some((path) => typeof path !== 'string')))
            problems.push('"forget" must be a list of paths.')

        return problems
    }

    private static RenameInOperation(operation: Record<string, unknown>, from: string, to: string): void
    {
        const swap = (list: unknown): unknown => Array.isArray(list) ? list.map((item) => (item === from ? to : item)) : list
        if (operation.files !== undefined) operation.files = swap(operation.files)
        if (Array.isArray(operation.steps))
            operation.steps = operation.steps.map((step) => (IsObject(step) && step.files !== undefined ? { ...step, files: swap(step.files) } : step))
    }

    private static ConceptShapeProblems(change: IConceptsPatch): string[]
    {
        if (!IsObject(change)) return ['"concepts" must be an object with "things" and "operations".']
        const problems: string[] = []
        const isText = (value: unknown): boolean => value === undefined || value === null || typeof value === 'string'
        const isTextList = (value: unknown): boolean => value === undefined || value === null || (Array.isArray(value) && value.every((item) => typeof item === 'string'))
        for (const kind of ['things', 'operations'] as const)
        {
            const section = change[kind]
            if (section === undefined) continue
            if (!IsObject(section)) { problems.push(`"concepts.${kind}" must be an object keyed by name.`); continue }
            for (const [name, entry] of Object.entries(section))
            {
                if (entry === null) continue
                if (!IsObject(entry)) { problems.push(`The ${kind === 'things' ? 'thing' : 'operation'} "${name}" must be an object, or null to remove it.`); continue }
                const fields = entry as Record<string, unknown>
                if (!isText(fields.summary)) problems.push(`"${name}": summary must be text.`)
                if (!isTextList(fields.rules)) problems.push(`"${name}": rules must be a list of text.`)
                if (kind === 'things')
                {
                    if (!isText(fields.layer)) problems.push(`"${name}": layer must be a layer name.`)
                    continue
                }
                for (const key of ['files', 'reads', 'writes']) if (!isTextList(fields[key])) problems.push(`"${name}": ${key} must be a list of text.`)
                const steps = fields.steps
                if (steps === undefined || steps === null) continue
                if (!Array.isArray(steps)) { problems.push(`"${name}": steps must be a list of {"text", "files"}.`); continue }
                for (const step of steps)
                    if (!IsObject(step) || typeof step.text !== 'string' || !isTextList(step.files) || step.files === null) problems.push(`"${name}": each step needs "text" and an optional list of "files".`)
            }
        }
        return problems
    }

    private static ApplyConcepts(change: IConceptsPatch | undefined, concepts: { things: Record<string, Record<string, unknown>>, operations: Record<string, Record<string, unknown>> }, layers: readonly string[], exists: ReadonlySet<string>, problems: string[]): void
    {
        if (change === undefined) return
        const removedThings = new Set<string>()
        const touched = new Set<string>()

        const rulesOf = (name: string, value: string[], into: Record<string, unknown>): void =>
        {
            const rules = value.map((rule) => rule.trim())
            if (rules.some((rule) => rule === '' || rule.length > MaxSummary)) problems.push(`"${name}": each rule needs 1 to ${MaxSummary} characters.`)
            else if (rules.length === 0) delete into.rules
            else into.rules = rules
        }
        const summaryOf = (name: string, value: string | null, into: Record<string, unknown>): void =>
        {
            if (value === null || value.trim() === '') delete into.summary
            else if (value.length > MaxSummary) problems.push(`"${name}": summary is over ${MaxSummary} characters.`)
            else into.summary = value.trim()
        }

        for (const [rawName, entry] of Object.entries(change.things ?? {}))
        {
            const name = rawName.trim()
            if (name === '') { problems.push('A thing needs a non-empty name.'); continue }
            if (entry === null)
            {
                if (name in concepts.things) removedThings.add(name)
                else problems.push(`Cannot remove the thing "${name}": it is not declared.`)
                delete concepts.things[name]
                continue
            }
            const thing = concepts.things[name] ?? {}
            if (entry.summary !== undefined) summaryOf(name, entry.summary, thing)
            if (entry.layer !== undefined)
            {
                if (entry.layer === null) delete thing.layer
                else if (!layers.includes(entry.layer)) problems.push(`The thing "${name}": layer "${entry.layer}" is not in layers (${layers.join(', ') || 'none'}).`)
                else thing.layer = entry.layer
            }
            if (entry.rules !== undefined) { if (entry.rules === null) delete thing.rules; else rulesOf(name, entry.rules, thing) }
            concepts.things[name] = thing
        }

        for (const [rawName, entry] of Object.entries(change.operations ?? {}))
        {
            const name = rawName.trim()
            if (name === '') { problems.push('An operation needs a non-empty name.'); continue }
            if (entry === null)
            {
                if (!(name in concepts.operations)) problems.push(`Cannot remove the operation "${name}": it is not declared.`)
                delete concepts.operations[name]
                continue
            }
            touched.add(name)
            const operation = concepts.operations[name] ?? {}
            if (entry.summary !== undefined) summaryOf(name, entry.summary, operation)
            if (entry.files !== undefined)
            {
                if (entry.files === null || entry.files.length === 0) delete operation.files
                else
                {
                    for (const path of entry.files) if (!exists.has(path)) problems.push(`The operation "${name}": "${path}" is not a file in the repository.`)
                    operation.files = [...new Set(entry.files)]
                }
            }
            for (const key of ['reads', 'writes'] as const)
            {
                const value = entry[key]
                if (value === undefined) continue
                if (value === null || value.length === 0) delete operation[key]
                else operation[key] = [...new Set(value)]
            }
            if (entry.steps !== undefined)
            {
                if (entry.steps === null || entry.steps.length === 0) delete operation.steps
                else
                {
                    const steps: Array<{ text: string, files: string[] }> = []
                    for (const step of entry.steps)
                    {
                        const text = step.text.trim()
                        if (text === '' || text.length > MaxSummary) { problems.push(`The operation "${name}": each step needs text of 1 to ${MaxSummary} characters.`); continue }
                        const stepFiles = [...new Set(step.files ?? [])]
                        for (const path of stepFiles) if (!exists.has(path)) problems.push(`The operation "${name}": step "${text.slice(0, 40)}" names "${path}", which is not a file in the repository.`)
                        steps.push({ text, files: stepFiles })
                    }
                    operation.steps = steps
                }
            }
            if (entry.rules !== undefined) { if (entry.rules === null) delete operation.rules; else rulesOf(name, entry.rules, operation) }
            concepts.operations[name] = operation
        }

        // A thing an operation still reads or writes cannot go; and an operation this change touched may only name declared things.
        for (const [name, operation] of Object.entries(concepts.operations))
        {
            for (const key of ['reads', 'writes'] as const)
            {
                for (const item of Array.isArray(operation[key]) ? operation[key] as unknown[] : [])
                {
                    if (typeof item !== 'string' || item in concepts.things) continue
                    if (removedThings.has(item)) problems.push(`Cannot remove the thing "${item}": the operation "${name}" still ${key === 'reads' ? 'reads' : 'writes'} it.`)
                    else if (touched.has(name)) problems.push(`The operation "${name}" ${key === 'reads' ? 'reads' : 'writes'} "${item}", which is not a declared thing.`)
                }
            }
        }
    }

    private static ConceptsBlock(concepts: { things: Record<string, Record<string, unknown>>, operations: Record<string, Record<string, unknown>> }): string
    {
        const order = ['summary', 'layer', 'reads', 'writes', 'files', 'steps', 'rules']
        const entryText = (entry: Record<string, unknown>): string =>
        {
            const keys = [...order.filter((key) => key in entry), ...Object.keys(entry).filter((key) => !order.includes(key))]
            if (keys.length === 0) return '{}'
            const value = (key: string): string =>
            {
                const item = entry[key]
                if ((key === 'steps' || key === 'rules') && Array.isArray(item) && item.length > 0)
                    return `[\n${item.map((one) => `          ${IsObject(one) ? `{ "text": ${JSON.stringify(one.text)}, "files": ${Architecture.Inline(one.files ?? [])} }` : JSON.stringify(one)}`).join(',\n')}\n        ]`
                return Architecture.Inline(item)
            }
            return `{\n${keys.map((key) => `        ${JSON.stringify(key)}: ${value(key)}`).join(',\n')}\n      }`
        }
        const section = (entries: Record<string, Record<string, unknown>>): string =>
        {
            const lines = Object.entries(entries).map(([name, entry]) => `      ${JSON.stringify(name)}: ${entryText(entry)}`)
            return lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n    }`
        }
        return `{\n    "things": ${section(concepts.things)},\n    "operations": ${section(concepts.operations)}\n  }`
    }

    /**
     * Lists every folder that holds a file, at any depth. The repository root is not one.
     * @param known every file in the repository
     */
    public static Folders(known: readonly string[]): Set<string>
    {
        const folders = new Set<string>()
        for (const path of known) for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) folders.add(path.slice(0, cut))
        return folders
    }

    /**
     * Writes an object of notes with one note per line, in the order they were given.
     * @param notes the notes, by name
     */
    private static Block(notes: Record<string, unknown>): string
    {
        const lines = Object.entries(notes).map(([key, note]) => `        ${JSON.stringify(key)}: ${JSON.stringify(note)}`)
        return lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n      }`
    }

    /**
     * Writes a value on one line, with a space after each comma in a list.
     * @param value the value to write
     */
    private static Inline(value: unknown): string
    {
        return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value)
    }

    /**
     * What one file's entry still lacks: "summary", "system", "layer", or "tags". A system or layer the
     * architecture does not declare counts as missing, since the map cannot place it on a layer or colour it by system.
     * @param architecture what the architecture file says
     * @param path the file's repository-relative path
     */
    public static Lacks(architecture: IArchitecture, path: string): string[]
    {
        const entry = architecture.files[path]
        const lacks: string[] = []
        if (entry?.summary === undefined) lacks.push('summary')
        if (entry?.system === undefined || !(entry.system in architecture.systems)) lacks.push('system')
        const layer = entry?.layer
        if (layer === undefined || (architecture.layers.length > 0 && !architecture.layers.includes(layer))) lacks.push('layer')
        if ((entry?.tags?.length ?? 0) === 0) lacks.push('tags')
        return lacks
    }

    /**
     * Keeps the well-formed fields of one file's entry.
     * @param path the file's path, for messages
     * @param raw the entry as written
     * @param result the architecture being built, which collects warnings and knows the layers
     */
    private static ReadEntry(path: string, raw: Record<string, unknown>, result: IArchitecture): IFileEntry
    {
        const entry: IFileEntry = {}
        if (typeof raw.system === 'string' && raw.system.trim() !== '')
        {
            entry.system = raw.system.trim()
            if (!(entry.system in result.systems)) result.warnings.push(`"${path}" is in system "${entry.system}", which "systems" does not list.`)
        }
        else if (raw.system !== undefined) result.warnings.push(`"${path}": system should be a name.`)

        if (typeof raw.layer === 'string' && raw.layer.trim() !== '')
        {
            entry.layer = raw.layer.trim()
            if (result.layers.length > 0 && !result.layers.includes(entry.layer)) result.warnings.push(`"${path}" is in layer "${entry.layer}", which "layers" does not list.`)
        }
        else if (raw.layer !== undefined) result.warnings.push(`"${path}": layer should be a name.`)

        if (Array.isArray(raw.tags))
        {
            entry.tags = raw.tags.filter((tag): tag is string => typeof tag === 'string' && tag.trim() !== '').map((tag) => tag.trim())
        }
        else if (raw.tags !== undefined) result.warnings.push(`"${path}": tags should be a list.`)

        if (typeof raw.summary === 'string' && raw.summary.trim() !== '') entry.summary = raw.summary.trim().slice(0, MaxSummary)
        else if (raw.summary !== undefined) result.warnings.push(`"${path}": summary should be text.`)

        if (IsObject(raw.notes))
        {
            const notes: Record<string, string> = {}
            for (const [key, note] of Object.entries(raw.notes)) if (typeof note === 'string' && note.trim() !== '') notes[key] = note.trim().slice(0, MaxSummary)
            if (Object.keys(notes).length > 0) entry.notes = notes
        }
        else if (raw.notes !== undefined) result.warnings.push(`"${path}": notes should be an object of text, keyed by name.`)
        return entry
    }
}
