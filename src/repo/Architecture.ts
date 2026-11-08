import { mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'

/** Where a repository's architecture file lives, relative to its root. */
const ArchitecturePath = '.codespace/architecture.json'

/** The longest summary kept, in characters. */
const MaxSummary = 600

/** The tags the map knows how to colour. Others are allowed, and shown grey. */
const TagVocabulary: readonly string[] = ['entry', 'orchestrate', 'core', 'data', 'io', 'ui', 'config', 'test']

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
}

/** What the architecture file says about one system: a slice of the repository that shares layers. */
interface ISystemEntry
{
    /** What the system is for, in a sentence. */
    summary?: string
}

/** A repository's architecture, as the map reads it. */
export interface IArchitecture
{
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
    files?: Record<string, { system?: string | null, layer?: string | null, tags?: string[] | null, summary?: string | null }>
    /** Changes to folder summaries by path. Null removes one. */
    folders?: Record<string, { summary?: string | null }>
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

/** Changes wait their turn, so two at once cannot read the same file and overwrite each other. */
let writeQueue: Promise<unknown> = Promise.resolve()

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
        const result: IArchitecture = { layers: [], systems: {}, files: {}, folders: {}, warnings: [], error: '' }

        // First we read the file, making sure a link cannot point it outside the repository.
        let text: string
        try
        {
            const real = await realpath(join(root, ArchitecturePath))
            if (!real.startsWith(root + sep)) throw new Error('it points outside the repository')
            text = await readFile(real, 'utf8')
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') result.error = `${ArchitecturePath} could not be read: ${(error as Error).message}`
            return result
        }

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
        return result
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
        const run = (): Promise<IUpdated> => Architecture.ApplyAsync(root, known, patch)
        const result = writeQueue.then(run, run)
        writeQueue = result.catch(() => undefined)
        return result
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
            const real = await realpath(join(root, ArchitecturePath))
            if (!real.startsWith(root + sep)) return stale
            const parsed = JSON.parse(await readFile(real, 'utf8')) as { files?: unknown, folders?: unknown } | null
            const exists = new Set(known), folders = Architecture.Folders(known)
            if (typeof parsed?.files === 'object' && parsed.files !== null) stale.files = Object.keys(parsed.files).filter((path) => !exists.has(path)).sort()
            if (typeof parsed?.folders === 'object' && parsed.folders !== null) stale.folders = Object.keys(parsed.folders).filter((path) => !folders.has(path)).sort()
        }
        catch { /* No readable file means nothing is stale. */ }
        return stale
    }

    /**
     * Deletes a repository's architecture folder, so the map draws it with no layers, systems, or
     * summaries, as a repository that was never described. Nothing else in the repository is touched.
     * @param root the repository's real path
     */
    public static async DeleteAsync(root: string): Promise<void>
    {
        // The path is fixed and inside the repository. A symlink of that name is removed, not followed,
        // so this can never delete through it.
        await rm(join(root, '.codespace'), { recursive: true, force: true })
    }

    /**
     * Makes one change to the file.
     * @param root the repository's real path
     * @param known every file in the repository
     * @param patch the change to make
     */
    private static async ApplyAsync(root: string, known: readonly string[], patch: IArchitecturePatch): Promise<IUpdated>
    {
        // First we read what is there, refusing to overwrite a file we cannot understand.
        const target = join(root, ArchitecturePath)
        let raw: Record<string, unknown> = {}
        try
        {
            const real = await realpath(target)
            if (!real.startsWith(root + sep)) throw new Error('it points outside the repository')
            const parsed: unknown = JSON.parse(await readFile(real, 'utf8'))
            if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('it is not a JSON object')
            raw = parsed as Record<string, unknown>
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error(`${ArchitecturePath} cannot be changed until it is fixed: ${(error as Error).message}`)
        }
        const { layers: oldLayers, systems: oldSystems, files: oldFiles, folders: oldFolders, ...others } = raw
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

        // Then we apply the change in memory, collecting every problem rather than stopping at the first.
        const exists = new Set(known)
        const problems: string[] = []
        const notes: string[] = []

        for (const { from, to } of patch.renames ?? [])
        {
            if (files[from] === undefined) problems.push(`Cannot rename "${from}": it has no entry.`)
            else if (!exists.has(to)) problems.push(`Cannot rename "${from}" to "${to}": "${to}" is not a file in the repository.`)
            else if (files[to] !== undefined) problems.push(`Cannot rename "${from}" to "${to}": "${to}" already has an entry.`)
            else { files[to] = files[from]!; delete files[from] }
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
                    for (const tag of entry.tags as string[]) if (!TagVocabulary.includes(tag)) notes.push(`"${path}": tag "${tag}" is not in the vocabulary (${TagVocabulary.join(', ')}); it will be grey.`)
                }
            }
            if (change.summary !== undefined)
            {
                if (change.summary === null || change.summary.trim() === '') delete entry.summary
                else if (change.summary.length > MaxSummary) problems.push(`"${path}": summary is over ${MaxSummary} characters.`)
                else entry.summary = change.summary.trim()
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
        if (problems.length > 0) throw new Error(problems.join('\n'))

        // Finally we write it whole to a temporary file and move it into place, so a reader never sees half of it.
        await mkdir(join(root, '.codespace'), { recursive: true })
        const temporary = `${target}.${process.pid}.tmp`
        await writeFile(temporary, Architecture.Serialize(layers, systems, files, folders, others), 'utf8')
        await rename(temporary, target)
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
    private static Serialize(layers: readonly string[], systems: Record<string, Record<string, unknown>>, files: Record<string, Record<string, unknown>>, folders: Record<string, Record<string, unknown>>, others: Record<string, unknown>): string
    {
        const order = ['system', 'layer', 'tags', 'summary']
        const section = (entries: Record<string, Record<string, unknown>>, declared = false): string =>
        {
            const keysOf = declared ? Object.keys(entries) : Object.keys(entries).sort()
            const lines = keysOf.map((path) =>
            {
                const entry = entries[path]!
                const keys = [...order.filter((key) => key in entry), ...Object.keys(entry).filter((key) => !order.includes(key))]
                const body = keys.length === 0 ? '{}' : `{\n${keys.map((key) => `      ${JSON.stringify(key)}: ${Architecture.Inline(entry[key])}`).join(',\n')}\n    }`
                return `    ${JSON.stringify(path)}: ${body}`
            })
            return lines.length === 0 ? '{}' : `{\n${lines.join(',\n')}\n  }`
        }
        // Systems keep the order they were declared in, so the map's deck of cards stays stable.
        const systemSection = Object.keys(systems).length === 0 ? '' : `,\n  "systems": ${section(systems, true)}`
        const folderSection = Object.keys(folders).length === 0 ? '' : `,\n  "folders": ${section(folders)}`
        const extra = Object.entries(others).map(([key, value]) => `,\n  ${JSON.stringify(key)}: ${JSON.stringify(value, null, 2).replace(/\n/g, '\n  ')}`).join('')
        return `{\n  "layers": ${Architecture.Inline(layers)}${systemSection},\n  "files": ${section(files)}${folderSection}${extra}\n}\n`
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
     * Writes a value on one line, with a space after each comma in a list.
     * @param value the value to write
     */
    private static Inline(value: unknown): string
    {
        return Array.isArray(value) ? `[${value.map((item) => JSON.stringify(item)).join(', ')}]` : JSON.stringify(value)
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
        return entry
    }
}
