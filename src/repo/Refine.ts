import type { IArchitecture } from './Architecture.ts'

/** The most items of each kind a report lists unless asked for more. */
export const DefaultRefineSize = 12

/** How many example imports each group of layer breaks lists. */
const ExamplesPerGroup = 3

/** The fewest neighbours in another system before a file is thought to belong there. */
const MinNeighbours = 3

/** The share of a file's neighbours in one other system before it is thought to belong there. */
const MisplacedShare = 0.6

/** One file, as the report names it: its place now and a sentence on what it is for. */
export interface IRefineFile
{
    path: string
    layer: string
    system: string
    summary: string
}

/** The layer breaks between one pair of layers: a lower layer using a higher one. */
export interface IBreakGroup
{
    /** The lower layer, the one doing the importing. */
    from: string
    /** The higher layer, the one being imported. */
    to: string
    /** How many imports go this way, which is how many are wrong. */
    count: number
    /** How many imports between the same two layers point the right way, for scale. */
    ordinary: number
    /** A few of the imports, with what each file is for. */
    examples: Array<{ from: IRefineFile, to: IRefineFile }>
}

/** A file that would sit in fewer breaks on another layer. */
export interface IMove
{
    file: IRefineFile
    /** The layer it would sit in fewer breaks on. */
    suggestLayer: string
    /** The breaks it is part of where it is. */
    breaksNow: number
    /** The breaks it would be part of there, counting only its own imports and importers. */
    breaksIfMoved: number
}

/** A file whose imports and importers are mostly in another system. */
export interface IMisplaced
{
    file: IRefineFile
    /** The system most of its neighbours are in. */
    suggestSystem: string
    /** Its neighbours by system, so the share can be judged. */
    neighbours: Record<string, number>
}

/** How one system sits in the layers and among the other systems. */
export interface ISystemProfile
{
    summary: string
    files: number
    /** How many of its files are in each layer. */
    layers: Record<string, number>
    /** How many of its imports go into each other system. */
    uses: Record<string, number>
}

/** What `refine` answers: how well the layers and systems fit the imports, and where to look first. */
export interface IRefineReport
{
    /** The layer order, bottom first, as it stands. */
    layers: string[]
    /** Every system, with its place in the layers and its imports into the others. */
    systems: Record<string, ISystemProfile>
    /** Imports from a lower layer into a higher one, by pair of layers, most first. */
    breaks: IBreakGroup[]
    /** All the layer breaks, including those not listed. */
    breakCount: number
    /** Files that would sit in fewer breaks on another layer, best gain first. */
    moves: IMove[]
    /** Files whose neighbours are mostly in another system, most first. */
    misplaced: IMisplaced[]
    /** Problems with the layers and systems as a whole, each a sentence. */
    issues: string[]
    /** Items still worth a look: the breaks, misplaced files, and issues. */
    remaining: number
}

/**
 * Looks over the layers and systems a repository was given against the imports between its files:
 * which imports point up the layers, which files would sit better elsewhere, which files seem to be
 * in the wrong system, and which layers or systems look wrong as a whole. Nothing here decides; it
 * points at what an agent should read and judge.
 * @param architecture what the architecture file says
 * @param edges every import, as the importing file and the imported one
 * @param size the most items of each kind to list
 */
export function Refine(architecture: IArchitecture, edges: ReadonlyArray<readonly [string, string]>, size = DefaultRefineSize): IRefineReport
{
    const { layers, files } = architecture
    const rank = new Map(layers.map((layer, index) => [layer, index]))
    const layerOf = (path: string): string | undefined => files[path]?.layer
    const rankOf = (path: string): number | undefined => { const layer = layerOf(path); return layer === undefined ? undefined : rank.get(layer) }
    const describe = (path: string): IRefineFile => ({ path, layer: layerOf(path) ?? '', system: files[path]?.system ?? '', summary: files[path]?.summary ?? '' })

    // Only imports between two files that both have a layer can be judged.
    const placed = edges.filter(([from, to]) => from !== to && rankOf(from) !== undefined && rankOf(to) !== undefined)

    // The breaks, grouped by the pair of layers they cross.
    const groups = new Map<string, IBreakGroup>()
    const ordinary = new Map<string, number>()
    let breakCount = 0
    for (const [from, to] of placed)
    {
        const lower = layerOf(from)!, upper = layerOf(to)!
        if (rankOf(from)! < rankOf(to)!)
        {
            breakCount++
            const key = `${lower}\u0000${upper}`
            const group = groups.get(key) ?? { from: lower, to: upper, count: 0, ordinary: 0, examples: [] }
            group.count++
            if (group.examples.length < ExamplesPerGroup) group.examples.push({ from: describe(from), to: describe(to) })
            groups.set(key, group)
        }
        else if (lower !== upper)
        {
            const key = `${upper}\u0000${lower}`
            ordinary.set(key, (ordinary.get(key) ?? 0) + 1)
        }
    }
    for (const [key, group] of groups) group.ordinary = ordinary.get(key) ?? 0
    const breaks = [...groups.values()].sort((a, b) => b.count - a.count)

    // For each file, the layer where it would be part of the fewest breaks, holding every other file still.
    const imports = new Map<string, string[]>()
    const importers = new Map<string, string[]>()
    for (const [from, to] of placed)
    {
        imports.set(from, [...(imports.get(from) ?? []), to])
        importers.set(to, [...(importers.get(to) ?? []), from])
    }
    const breaksAt = (path: string, at: number): number =>
        (imports.get(path) ?? []).filter((to) => at < rankOf(to)!).length + (importers.get(path) ?? []).filter((from) => rankOf(from)! < at).length
    const moves: IMove[] = []
    for (const path of new Set([...imports.keys(), ...importers.keys()]))
    {
        const now = rankOf(path)!
        const here = breaksAt(path, now)
        if (here === 0) continue
        let best = now, fewest = here
        for (let at = 0; at < layers.length; at++)
        {
            const count = breaksAt(path, at)
            if (count < fewest || (count === fewest && count < here && Math.abs(at - now) < Math.abs(best - now))) { best = at; fewest = count }
        }
        if (best !== now) moves.push({ file: describe(path), suggestLayer: layers[best]!, breaksNow: here, breaksIfMoved: fewest })
    }
    moves.sort((a, b) => (b.breaksNow - b.breaksIfMoved) - (a.breaksNow - a.breaksIfMoved) || (a.file.path < b.file.path ? -1 : 1))

    // Systems: where each sits in the layers, what it imports from the others, and which files look misplaced.
    const profiles: Record<string, ISystemProfile> = {}
    for (const [name, entry] of Object.entries(architecture.systems)) profiles[name] = { summary: entry.summary ?? '', files: 0, layers: {}, uses: {} }
    for (const [path, entry] of Object.entries(files))
    {
        const profile = entry.system === undefined ? undefined : profiles[entry.system]
        if (!profile) continue
        profile.files++
        if (entry.layer !== undefined) profile.layers[entry.layer] = (profile.layers[entry.layer] ?? 0) + 1
    }
    const neighbours = new Map<string, Map<string, number>>()
    const meet = (path: string, other: string): void =>
    {
        const system = files[other]?.system
        if (system === undefined) return
        const counts = neighbours.get(path) ?? new Map<string, number>()
        counts.set(system, (counts.get(system) ?? 0) + 1)
        neighbours.set(path, counts)
    }
    for (const [from, to] of edges)
    {
        if (from === to) continue
        const a = files[from]?.system, b = files[to]?.system
        if (a !== undefined && b !== undefined && a !== b && profiles[a]) profiles[a]!.uses[b] = (profiles[a]!.uses[b] ?? 0) + 1
        meet(from, to)
        meet(to, from)
    }
    const misplaced: IMisplaced[] = []
    for (const [path, counts] of neighbours)
    {
        const entry = files[path]
        // Tests and settings are meant to touch everything, so their neighbours say nothing about where they belong.
        if (entry?.system === undefined || entry.tags?.includes('test') || entry.tags?.includes('config')) continue
        const total = [...counts.values()].reduce((sum, count) => sum + count, 0)
        const [top, topCount] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]!
        if (top !== entry.system && topCount >= MinNeighbours && topCount / total >= MisplacedShare) misplaced.push({ file: describe(path), suggestSystem: top, neighbours: Object.fromEntries(counts) })
    }
    misplaced.sort((a, b) => Math.max(...Object.values(b.neighbours)) - Math.max(...Object.values(a.neighbours)) || (a.file.path < b.file.path ? -1 : 1))

    // Problems with the layers and systems as a whole, in the terms of the architecture rules.
    const issues: string[] = []
    const systemNames = Object.keys(architecture.systems)
    for (const layer of layers)
    {
        const inLayer = Object.values(files).filter((entry) => entry.layer === layer).length
        if (systemNames.includes(layer)) issues.push(`The layer "${layer}" has the same name as a system; a layer is a file's job in the stack, not its system, so rename it for the job.`)
        if (inLayer === 0) issues.push(`The layer "${layer}" holds no files; remove it, or move the files that belong there.`)
        else if (inLayer === 1) issues.push(`The layer "${layer}" holds one file; it is probably part of a neighbouring layer.`)
    }
    for (const [name, profile] of Object.entries(profiles))
    {
        const used = Object.keys(profile.layers)
        if (profile.files === 0) issues.push(`The system "${name}" has no files; remove it, or move files into it.`)
        else if (profile.files >= 3 && used.length === 1) issues.push(`Every file of the system "${name}" is in the layer "${used[0]}"; one system's files normally span several layers, so the layering is probably wrong.`)
        if (profile.summary === '') issues.push(`The system "${name}" has no summary.`)
    }

    return {
        layers, systems: profiles,
        breaks: breaks.slice(0, size), breakCount, moves: moves.slice(0, size), misplaced: misplaced.slice(0, size), issues: issues.slice(0, size),
        remaining: breakCount + misplaced.length + issues.length,
    }
}
