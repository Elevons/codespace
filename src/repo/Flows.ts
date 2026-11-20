import { MaxFlowName, type IFlow, type IFlowStep } from '../../public/flows.ts'
import { CodespaceFolder, JsonStore } from './JsonStore.ts'
import { MaxFileNote, MaxNote, MaxShown, MaxTitle } from './ShowLimits.ts'
import type { IArchitecture } from './Architecture.ts'

/** Where a repository's saved flows live, relative to its root. */
export const FlowsPath = `${CodespaceFolder}/flows.json`

/** The most steps a drafted start-here tour takes. */
export const MaxTourSteps = 12

/** A string cut to a length and trimmed, or empty for anything that is not a string. */
function text(value: unknown, max: number): string
{
    return typeof value === 'string' ? value.trim().slice(0, max) : ''
}

/** Whether a name can be saved: it is not empty, and it has nothing that would make it unreadable. */
function validName(name: string): boolean
{
    return name.length > 0 && name.length <= MaxFlowName && !/[\u0000-\u001f\u007f]/.test(name)
}

/**
 * Checks one flow as a caller sent it, and returns the flow the repository will keep: every string
 * trimmed and cut to its limit, and every file a real file when a set is given.
 * @param input the flow, as sent
 * @param known every file path in the repository, or undefined to accept any path
 */
export function NormaliseFlow(input: unknown, known?: ReadonlySet<string>): IFlow
{
    if (typeof input !== 'object' || input === null || Array.isArray(input)) throw new Error('A flow must be a JSON object with a name and a files list.')
    const flow = input as Record<string, unknown>
    const name = text(flow.name, MaxFlowName)
    if (!validName(name)) throw new Error(`A flow needs a name of 1 to ${MaxFlowName} characters.`)
    if (!Array.isArray(flow.files) || flow.files.length === 0) throw new Error(`The flow "${name}" needs at least one file.`)
    if (flow.files.length > MaxShown) throw new Error(`The flow "${name}" names more than ${MaxShown} files.`)

    const files: IFlowStep[] = []
    const unknown: string[] = []
    for (const item of flow.files)
    {
        const step = typeof item === 'string' ? { path: item } : item
        if (typeof step !== 'object' || step === null) throw new Error(`A step of the flow "${name}" must be a path or an object with a path.`)
        const path = text((step as { path?: unknown }).path, 1000).replace(/^\.?\/+|\/+$/g, '')
        if (path === '') throw new Error(`A step of the flow "${name}" has no path.`)
        if (known !== undefined && !known.has(path)) { unknown.push(path); continue }
        files.push({ path, note: text((step as { note?: unknown }).note, MaxFileNote) })
    }
    if (unknown.length > 0) throw new Error(`The flow "${name}" names files that are not in the repository: ${unknown.slice(0, 6).join(', ')}.`)
    if (files.length === 0) throw new Error(`The flow "${name}" names no files in the repository.`)

    return {
        name,
        title: text(flow.title, MaxTitle) || name,
        note: text(flow.note, MaxNote),
        trace: flow.trace === true,
        files,
    }
}

/**
 * Reads the flows a repository has saved, oldest first. A repository with none answers with an
 * empty list; a file that cannot be read as flows names the problem rather than hiding it.
 * @param root the repository's real path
 */
export async function ReadFlowsAsync(root: string): Promise<IFlow[]>
{
    const stored = await JsonStore.ReadAsync(root, FlowsPath)
    if (stored === null) return []
    let parsed: unknown
    try { parsed = JSON.parse(stored) }
    catch (error) { throw new Error(`${FlowsPath} is not valid JSON: ${(error as Error).message}`) }
    const list = (parsed as { flows?: unknown } | null)?.flows
    if (!Array.isArray(list)) throw new Error(`${FlowsPath} must hold {"flows": [...]}, with one entry for each flow.`)
    return list.map((item) => NormaliseFlow(item))
}

/**
 * Writes the flows a repository keeps. Call it inside `JsonStore.RunAsync`, so a read and the
 * write that follows it cannot interleave with another change.
 * @param root the repository's real path
 * @param flows every flow to keep, in order
 */
export async function WriteFlowsAsync(root: string, flows: readonly IFlow[]): Promise<void>
{
    await JsonStore.WriteAsync(root, FlowsPath, JSON.stringify({ flows }, null, 2) + '\n')
}

/**
 * Drafts a tour to start with, from what the architecture file already says: it begins at the
 * files tagged `entry` (or, failing that, at the files nothing imports), then follows their imports
 * out, taking one step per file until the tour is long enough. Notes are the files' own summaries,
 * so a tour is no better than the descriptions it is built from.
 * @param architecture what the architecture file says
 * @param edges every import, as the importing file and the imported one
 * @param repoName the repository's name, for the tour's note
 */
export function DraftTour(architecture: IArchitecture, edges: ReadonlyArray<readonly [string, string]>, repoName: string): IFlow | null
{
    const described = Object.keys(architecture.files).filter((path) => architecture.files[path]?.summary !== undefined)
    if (described.length < 2) return null
    const describedSet = new Set(described)
    const rank = new Map(architecture.layers.map((layer, index) => [layer, index]))
    const rankOf = (path: string): number =>
    {
        const layer = architecture.files[path]?.layer
        return layer === undefined ? -1 : rank.get(layer) ?? -1
    }

    const imports = new Map<string, string[]>()
    const importers = new Map<string, number>()
    for (const [from, to] of edges)
    {
        if (from === to || !describedSet.has(from) || !describedSet.has(to)) continue
        imports.set(from, [...(imports.get(from) ?? []), to])
        importers.set(to, (importers.get(to) ?? 0) + 1)
    }

    const byRank = (a: string, b: string): number => rankOf(b) - rankOf(a) || (a < b ? -1 : a > b ? 1 : 0)
    let seeds = described.filter((path) => architecture.files[path]?.tags?.includes('entry') === true)
    if (seeds.length === 0) seeds = described.filter((path) => (importers.get(path) ?? 0) === 0)
    if (seeds.length === 0) seeds = [...described]
    seeds.sort(byRank)

    const steps: IFlowStep[] = []
    const seen = new Set<string>()
    let frontier = seeds
    const take = (path: string): void =>
    {
        if (seen.has(path) || steps.length >= MaxTourSteps) return
        seen.add(path)
        steps.push({ path, note: architecture.files[path]?.summary ?? '' })
    }
    for (const seed of seeds) take(seed)
    while (frontier.length > 0 && steps.length < MaxTourSteps)
    {
        const next: string[] = []
        for (const path of frontier)
        {
            for (const other of [...(imports.get(path) ?? [])].sort(byRank)) if (!seen.has(other)) { take(other); next.push(other) }
            if (steps.length >= MaxTourSteps) break
        }
        frontier = next
    }
    // A repository whose files import nothing still gets a tour: the entry files, then the rest by layer.
    if (steps.length < 2) for (const path of [...described].sort(byRank)) { if (seen.has(path)) continue; take(path); if (steps.length >= 2) break }
    if (steps.length < 2) return null

    return {
        name: 'start-here',
        title: 'Start here',
        note: `A first pass over ${repoName}: where it starts, then what that reaches.`,
        trace: true,
        files: steps,
    }
}
