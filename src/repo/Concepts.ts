import { dirname } from 'node:path'
import type { IArchitecture } from './Architecture.ts'
import { ConceptsGuide } from './ConceptsGuide.ts'
import type { Graph } from './Graph.ts'
import { SkippedSummary } from './Ingest.ts'
import type { Repo } from './Repo.ts'

export const DefaultConceptsSize = 8

// Budgets keep every response comfortably under host tool caps (e.g. 40 KB) even on large repos;
// the overview is paged rather than trimmed, so the agent always sees every file.
const MaxBatchSourceChars = 12_000
const MinFileSourceChars = 400
const MaxFileSourceChars = 5_000
const MaxOperationsPerBatch = 3
const MaxFilesPerOperation = 8
const MaxOverviewPageChars = 12_000
const MaxFileLinks = 16
const MaxNearby = 8
const MaxUncoveredImportsPerOp = 6
const MaxUnplacedListed = 150
const MaxPlaceBatch = 20
const MinSystemFilesForCoverageCheck = 3
const CodeFileMention = /\b[\w-]+\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs|cs|py|go|rs|java|kt|rb|php|swift|cpp|hpp|c|h|vue|svelte)\b/

export interface IConceptFile
{
    path: string
    summary: string
    layer: string
    system: string
    tags: string[]
    source: string
    truncated: boolean
    imports: string[]
    usedBy: string[]
}

export interface IConceptNearby
{
    path: string
    relation: 'imports' | 'usedBy'
    layer: string
    system: string
    tags: string[]
    summary: string
}

export interface IConceptUnplaced
{
    path: string
    system: string
    layer: string
    tags: string[]
    summary: string
    imports: string[]
    usedBy: string[]
    near: string[]
}

export interface IConceptOverviewFile
{
    path: string
    system: string
    layer: string
    tags: string[]
    summary: string
    imports: number
    usedBy: number
}

export interface IConceptOverview
{
    fileCount: number
    page: number
    pages: number
    systems: Record<string, { summary: string, files: number, layers: string[] }>
    folders: Array<{ path: string, summary: string, files: number }>
    files: IConceptOverviewFile[]
}

export interface IConceptCoverage
{
    files: number
    placedFiles: number
    ratio: number
    unplaced: string[]
    uncoveredSystems: Array<{ name: string, files: number, summary: string }>
}

export interface IConceptOverlap
{
    operations: [string, string]
    sharedFiles: string[]
    similarity: number
}

export interface IConceptDivergence
{
    operation: string
    unplacedImports: Array<{ path: string, layer: string, tags: string[], summary: string }>
}

export interface IConceptsReview
{
    coverage: IConceptCoverage
    orphanThings: string[]
    externalInputs: string[]
    finalOutputs: string[]
    overlaps: IConceptOverlap[]
    divergences: IConceptDivergence[]
    issues: string[]
    blocking: string[]
}

export interface IConceptsBatch
{
    mode: 'overview' | 'operations' | 'things' | 'place' | 'review' | 'done'
    remaining: number
    guide: string
    layers: string[]
    overview?: IConceptOverview
    things: Array<{ name: string, summary?: string, layer?: string, files: string[], missing: string[], readBy: string[], writtenBy: string[], suggestedLayers: string[] }>
    operations: Array<{
        name: string
        summary?: string
        missing: string[]
        optional: string[]
        reads: string[]
        writes: string[]
        steps: Array<{ text: string, files: string[] }>
        rules: string[]
        files: IConceptFile[]
        nearby: IConceptNearby[]
    }>
    unplaced: IConceptUnplaced[]
    review?: IConceptsReview
}

export function ReadPage(value: string | null | undefined): number | undefined
{
    if (value === null || value === undefined || value.trim() === '') return undefined
    const page = Number.parseInt(value, 10)
    return Number.isFinite(page) && page >= 1 ? page : undefined
}

// Every file the design can name: all of them but the generated and vendored ones settled with a summary alone.
function DesignFiles(known: readonly string[]): string[]
{
    return known.filter((path) => SkippedSummary(path) === null).sort()
}

// The files the design must place: every described one but the generated and vendored ones.
function FilesToPlace(architecture: IArchitecture): string[]
{
    return Object.entries(architecture.files).filter(([path, entry]) => entry.summary !== undefined && SkippedSummary(path) === null).map(([path]) => path).sort()
}

function PlacedFiles(architecture: IArchitecture): Set<string>
{
    const placed = new Set<string>()
    for (const thing of Object.values(architecture.concepts.things)) for (const path of thing.files ?? []) placed.add(path)
    for (const op of Object.values(architecture.concepts.operations))
    {
        for (const path of op.files) placed.add(path)
        for (const step of op.steps) for (const path of step.files) placed.add(path)
    }
    return placed
}

export function ThingMissing(thing: { layer?: string, files?: string[] }): string[]
{
    const missing: string[] = []
    if (thing.layer === undefined) missing.push('layer')
    if ((thing.files ?? []).length === 0) missing.push('files')
    return missing
}

export function OperationMissing(operation: { steps: Array<{ files: unknown[] }>, reads: unknown[], writes: unknown[] }): string[]
{
    const missing: string[] = []
    if (operation.steps.length === 0) missing.push('steps')
    else if (operation.steps.every((step) => step.files.length === 0)) missing.push('step files')
    if (operation.reads.length === 0 && operation.writes.length === 0) missing.push('reads or writes')
    return missing
}

export interface IConceptsLeft
{
    started: boolean
    operations: number
    things: number
    unplaced: number
}

export function ConceptsLeft(architecture: IArchitecture): IConceptsLeft
{
    const operations = Object.values(architecture.concepts.operations).filter((operation) => OperationMissing(operation).length > 0).length
    const things = Object.values(architecture.concepts.things).filter((thing) => ThingMissing(thing).length > 0).length
    const started = Object.keys(architecture.concepts.operations).length > 0
    const placed = PlacedFiles(architecture)
    const unplaced = started ? FilesToPlace(architecture).filter((path) => !placed.has(path)).length : 0
    return { started, operations, things, unplaced }
}

function BuildGraphIndex(graph: Graph, inDesign: ReadonlySet<string>): { imports: Map<string, string[]>, usedBy: Map<string, string[]> }
{
    const imports = new Map<string, string[]>()
    const usedBy = new Map<string, string[]>()
    for (const [from, to] of graph.Edges())
    {
        if (from === to || !inDesign.has(from) || !inDesign.has(to)) continue
        imports.set(from, [...(imports.get(from) ?? []), to])
        usedBy.set(to, [...(usedBy.get(to) ?? []), from])
    }
    return { imports, usedBy }
}

function OverviewFile(path: string, architecture: IArchitecture, imports: ReadonlyMap<string, string[]>, usedBy: ReadonlyMap<string, string[]>): IConceptOverviewFile
{
    const entry = architecture.files[path]
    return {
        path,
        system: entry?.system ?? '',
        layer: entry?.layer ?? '',
        tags: entry?.tags ?? [],
        summary: entry?.summary ?? '',
        imports: (imports.get(path) ?? []).length,
        usedBy: (usedBy.get(path) ?? []).length,
    }
}

// The whole described codebase in path order, cut into pages by size so nothing is ever left out.
function BuildOverview(architecture: IArchitecture, files: readonly string[], imports: ReadonlyMap<string, string[]>, usedBy: ReadonlyMap<string, string[]>, page: number): IConceptOverview
{
    const systems: IConceptOverview['systems'] = {}
    const systemLayers = new Map<string, Set<string>>()
    for (const [name, entry] of Object.entries(architecture.systems))
    {
        systems[name] = { summary: entry.summary ?? '', files: 0, layers: [] }
        systemLayers.set(name, new Set())
    }
    const folderCounts = new Map<string, number>()
    const rows: IConceptOverviewFile[] = []
    for (const path of files)
    {
        const row = OverviewFile(path, architecture, imports, usedBy)
        rows.push(row)
        if (row.system !== '' && systems[row.system])
        {
            systems[row.system]!.files++
            if (row.layer !== '') systemLayers.get(row.system)!.add(row.layer)
        }
        const folder = dirname(path) === '.' ? '' : dirname(path)
        if (folder !== '') folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1)
    }
    for (const [name, layers] of systemLayers) systems[name]!.layers = architecture.layers.filter((layer) => layers.has(layer))

    const pages: IConceptOverviewFile[][] = [[]]
    let size = 0
    for (const row of rows)
    {
        const cost = JSON.stringify(row).length + 1
        if (size + cost > MaxOverviewPageChars && pages[pages.length - 1]!.length > 0) { pages.push([]); size = 0 }
        pages[pages.length - 1]!.push(row)
        size += cost
    }
    const index = Math.min(Math.max(1, page), pages.length)
    const first = index === 1
    return {
        fileCount: rows.length,
        page: index,
        pages: pages.length,
        systems: first ? systems : {},
        folders: first ? [...folderCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, count]) => ({ path, summary: architecture.folders[path] ?? '', files: count })) : [],
        files: pages[index - 1]!,
    }
}

export function ReviewConcepts(architecture: IArchitecture, graph: Graph, known: readonly string[], size = DefaultConceptsSize): IConceptsReview
{
    const files = DesignFiles(known)
    const inDesign = new Set(files)
    const { imports } = BuildGraphIndex(graph, inDesign)

    const { things, operations } = architecture.concepts
    const opEntries = Object.entries(operations)
    const placed = new Set<string>()
    const opFiles = new Map<string, Set<string>>()
    const readers = new Map<string, string[]>()
    const writers = new Map<string, string[]>()
    for (const [name, thing] of Object.entries(things))
    {
        readers.set(name, []); writers.set(name, [])
        for (const path of thing.files ?? []) placed.add(path)
    }
    for (const [name, op] of opEntries)
    {
        const set = new Set<string>([...op.files, ...op.steps.flatMap((step) => step.files)].filter((path) => inDesign.has(path)))
        for (const path of set) placed.add(path)
        opFiles.set(name, set)
        for (const thing of op.reads) readers.get(thing)?.push(name)
        for (const thing of op.writes) writers.get(thing)?.push(name)
    }

    const placedFiles = files.filter((path) => placed.has(path)).length
    const ratio = files.length === 0 ? 1 : Number((placedFiles / files.length).toFixed(2))
    const unplaced = files.filter((path) => !placed.has(path))

    const systemCounts = new Map<string, { total: number, placed: number }>()
    for (const path of files)
    {
        const system = architecture.files[path]?.system
        if (system === undefined || !(system in architecture.systems)) continue
        const counts = systemCounts.get(system) ?? { total: 0, placed: 0 }
        counts.total++
        if (placed.has(path)) counts.placed++
        systemCounts.set(system, counts)
    }
    const uncoveredSystems = [...systemCounts.entries()]
        .filter(([, counts]) => counts.total >= MinSystemFilesForCoverageCheck && counts.placed === 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, counts]) => ({ name, files: counts.total, summary: architecture.systems[name]?.summary ?? '' }))

    const orphanThings: string[] = []
    const externalInputs: string[] = []
    const finalOutputs: string[] = []
    const issues: string[] = []
    const blocking: string[] = []
    const systemNames = new Set(Object.keys(architecture.systems).map((name) => name.toLowerCase()))

    for (const [name, thing] of Object.entries(things))
    {
        const readCount = (readers.get(name) ?? []).length
        const writeCount = (writers.get(name) ?? []).length
        if (readCount === 0 && writeCount === 0)
        {
            orphanThings.push(name)
            if (opEntries.length > 0) blocking.push(`The thing "${name}" is neither read nor written by any operation; connect it to an operation or remove it.`)
        }
        else if (writeCount === 0) externalInputs.push(name)
        else if (readCount === 0) finalOutputs.push(name)
        if (thing.summary === undefined) issues.push(`The thing "${name}" has no summary.`)
        if (systemNames.has(name.toLowerCase()) || name.includes('/') || CodeFileMention.test(name))
            issues.push(`The thing "${name}" looks like a system, folder, or file path; check that it names data kept or passed, not a module.`)
    }

    for (const system of uncoveredSystems)
        blocking.push(`The system "${system.name}" (${system.files} files) has no file in any operation or thing; decide where its files belong.`)
    if (opEntries.length > 0 && unplaced.length > 0)
        issues.push(`${unplaced.length} of ${files.length} files are in no operation and no thing (listed in "coverage.unplaced"); for each, decide whether it does work in an operation, holds a thing, or is rightly left out.`)

    const divergences: IConceptDivergence[] = []
    for (const [name, op] of opEntries)
    {
        if (op.summary === undefined) issues.push(`The operation "${name}" has no summary.`)
        const count = opFiles.get(name)?.size ?? 0
        if (op.files.length >= 4 && op.steps.length === 1)
            issues.push(`The operation "${name}" covers ${op.files.length} files in one step; split it into 3 to 8 ordered steps showing what happens to the data.`)
        if (files.length >= 12 && count > Math.max(20, Math.floor(files.length * 0.6)))
            issues.push(`The operation "${name}" covers ${count} of ${files.length} files; consider splitting it into distinct operations.`)
        const emptySteps = op.steps.filter((step) => step.files.length === 0).length
        if (emptySteps > 0 && emptySteps < op.steps.length)
            issues.push(`The operation "${name}" has ${emptySteps} step(s) with no files cited as evidence.`)
        const stepFileSet = new Set(op.steps.flatMap((step) => step.files))
        const untied = op.files.filter((path) => !stepFileSet.has(path))
        if (op.steps.length > 0 && untied.length > 0)
            issues.push(`The operation "${name}" lists ${untied.length} file(s) not tied to any step: ${untied.slice(0, 5).join(', ')}.`)
        if (op.steps.some((step) => CodeFileMention.test(step.text)))
            issues.push(`A step in "${name}" names a file in its text; write steps in plain words and keep file paths in step.files.`)

        // Files this operation's files import that nothing in the design names yet.
        const missing = new Set<string>()
        for (const path of opFiles.get(name) ?? [])
            for (const target of imports.get(path) ?? []) if (!placed.has(target)) missing.add(target)
        if (missing.size > 0)
        {
            const list = [...missing].sort().slice(0, MaxUncoveredImportsPerOp).map((path) =>
            {
                const entry = architecture.files[path]
                return { path, layer: entry?.layer ?? '', tags: entry?.tags ?? [], summary: entry?.summary ?? '' }
            })
            divergences.push({ operation: name, unplacedImports: list })
        }
    }
    divergences.sort((a, b) => b.unplacedImports.length - a.unplacedImports.length || a.operation.localeCompare(b.operation))

    const overlaps: IConceptOverlap[] = []
    for (let i = 0; i < opEntries.length; i++)
    {
        const [nameA] = opEntries[i]!
        const setA = opFiles.get(nameA)!
        if (setA.size < 2) continue
        for (let j = i + 1; j < opEntries.length; j++)
        {
            const [nameB] = opEntries[j]!
            const setB = opFiles.get(nameB)!
            if (setB.size < 2) continue
            const shared = [...setA].filter((path) => setB.has(path)).sort()
            if (shared.length < 2) continue
            const union = setA.size + setB.size - shared.length
            const similarity = shared.length / union
            const containment = shared.length / Math.min(setA.size, setB.size)
            if (similarity >= 0.6 || containment >= 0.85)
                overlaps.push({ operations: [nameA, nameB], sharedFiles: shared, similarity: Number(similarity.toFixed(2)) })
        }
    }
    overlaps.sort((a, b) => b.similarity - a.similarity || a.operations[0].localeCompare(b.operations[0]))

    const reviewLimit = Math.min(size, 6)
    return {
        coverage: { files: files.length, placedFiles, ratio, unplaced: unplaced.slice(0, MaxUnplacedListed), uncoveredSystems },
        orphanThings,
        externalInputs,
        finalOutputs,
        overlaps: overlaps.slice(0, reviewLimit),
        divergences: divergences.slice(0, reviewLimit),
        issues: issues.slice(0, Math.min(Math.max(size * 2, 16), 20)),
        blocking,
    }
}

// page: which page of the overview to return; given, it is returned whatever stage the pass is at.
export async function ConceptsNextAsync(repo: Repo, architecture: IArchitecture, graph: Graph, size: number, cli: string, page?: number): Promise<IConceptsBatch>
{
    const known = await repo.ListFilesAsync()
    const files = DesignFiles(known)
    const inDesign = new Set(files)
    const { imports, usedBy } = BuildGraphIndex(graph, inDesign)

    const describe = async (path: string, cap: number): Promise<IConceptFile> =>
    {
        const full = await repo.ReadFileAsync(path).catch(() => '')
        const entry = architecture.files[path]
        return {
            path,
            summary: entry?.summary ?? '',
            layer: entry?.layer ?? '',
            system: entry?.system ?? '',
            tags: entry?.tags ?? [],
            source: full.slice(0, cap),
            truncated: full.length > cap,
            imports: graph.ImportsOf(path).slice(0, MaxFileLinks),
            usedBy: (usedBy.get(path) ?? []).slice(0, MaxFileLinks),
        }
    }

    const { things, operations } = architecture.concepts
    const readBy = new Map<string, string[]>()
    const writtenBy = new Map<string, string[]>()
    const touchedLayers = new Map<string, Set<string>>()
    for (const name of Object.keys(things))
    {
        readBy.set(name, [])
        writtenBy.set(name, [])
        touchedLayers.set(name, new Set())
    }
    for (const [opName, op] of Object.entries(operations))
    {
        const opLayers = op.files.map((path) => architecture.files[path]?.layer).filter((layer): layer is string => layer !== undefined)
        for (const name of op.reads)
        {
            readBy.get(name)?.push(opName)
            for (const layer of opLayers) touchedLayers.get(name)?.add(layer)
        }
        for (const name of op.writes)
        {
            writtenBy.get(name)?.push(opName)
            for (const layer of opLayers) touchedLayers.get(name)?.add(layer)
        }
    }

    const thingRows = Object.entries(things).map(([name, thing]) => ({
        name,
        summary: thing.summary,
        layer: thing.layer,
        files: thing.files ?? [],
        missing: ThingMissing(thing),
        readBy: readBy.get(name) ?? [],
        writtenBy: writtenBy.get(name) ?? [],
        suggestedLayers: architecture.layers.filter((layer) => touchedLayers.get(name)?.has(layer)),
    }))
    const operationRows = Object.entries(operations).map(([name, operation]) => ({ name, operation, missing: OperationMissing(operation) }))
    const operationsLeft = operationRows.filter((row) => row.missing.length > 0)
    const thingsLeft = thingRows.filter((row) => row.missing.length > 0)
    const hasOperations = Object.keys(operations).length > 0
    const review = hasOperations ? ReviewConcepts(architecture, graph, known, size) : undefined
    const placedNow = PlacedFiles(architecture)
    const unplaced = hasOperations ? FilesToPlace(architecture).filter((path) => !placedNow.has(path)) : []
    const remaining = !hasOperations ? 1 : operationsLeft.length + thingsLeft.length + unplaced.length + review!.blocking.length

    // Keep overview near the top of the serialized JSON so it is never clipped if a host truncates long tool replies.
    const batch: IConceptsBatch = {
        mode: 'done',
        remaining,
        guide: ConceptsGuide(cli, repo.Root),
        layers: architecture.layers,
        overview: page !== undefined ? BuildOverview(architecture, files, imports, usedBy, page) : undefined,
        things: thingRows,
        operations: [],
        unplaced: [],
        review: undefined,
    }

    if (!hasOperations)
    {
        batch.mode = 'overview'
        batch.overview ??= BuildOverview(architecture, files, imports, usedBy, 1)
        return batch
    }

    if (operationsLeft.length > 0)
    {
        batch.mode = 'operations'
        const selected = operationsLeft.slice(0, Math.min(size, MaxOperationsPerBatch))
        const totalFiles = selected.reduce((sum, row) => sum + Math.min(MaxFilesPerOperation, row.operation.files.length), 0)
        const perFile = totalFiles === 0
            ? MaxFileSourceChars
            : Math.max(MinFileSourceChars, Math.min(MaxFileSourceChars, Math.floor(MaxBatchSourceChars / totalFiles)))
        for (const row of selected)
        {
            const described: IConceptFile[] = []
            for (const path of row.operation.files.slice(0, MaxFilesPerOperation)) described.push(await describe(path, perFile))

            const inOp = new Set(row.operation.files)
            const nearbyMap = new Map<string, 'imports' | 'usedBy'>()
            for (const path of row.operation.files)
                for (const target of imports.get(path) ?? []) if (!inOp.has(target) && !nearbyMap.has(target)) nearbyMap.set(target, 'imports')
            for (const path of row.operation.files)
                for (const caller of usedBy.get(path) ?? []) if (!inOp.has(caller) && !nearbyMap.has(caller)) nearbyMap.set(caller, 'usedBy')
            const nearby: IConceptNearby[] = [...nearbyMap.entries()]
                .slice(0, MaxNearby)
                .map(([path, relation]) =>
                {
                    const entry = architecture.files[path]
                    return { path, relation, layer: entry?.layer ?? '', system: entry?.system ?? '', tags: entry?.tags ?? [], summary: entry?.summary ?? '' }
                })

            const optional: string[] = []
            if (row.operation.summary === undefined) optional.push('summary')
            if (row.operation.rules.length === 0) optional.push('rules')
            batch.operations.push({
                name: row.name,
                summary: row.operation.summary,
                missing: row.missing,
                optional,
                reads: row.operation.reads,
                writes: row.operation.writes,
                steps: row.operation.steps,
                rules: row.operation.rules,
                files: described,
                nearby,
            })
        }
        return batch
    }

    if (thingsLeft.length > 0)
    {
        batch.mode = 'things'
        return batch
    }

    if (unplaced.length > 0)
    {
        // Each file comes with where its neighbours already sit, as a hint, never a decision.
        const homes = new Map<string, Set<string>>()
        const addHome = (path: string, home: string): void => { const set = homes.get(path) ?? new Set(); set.add(home); homes.set(path, set) }
        for (const [name, thing] of Object.entries(things)) for (const path of thing.files ?? []) addHome(path, `thing: ${name}`)
        for (const [name, op] of Object.entries(operations))
            for (const path of [...op.files, ...op.steps.flatMap((step) => step.files)]) addHome(path, `operation: ${name}`)
        batch.mode = 'place'
        batch.unplaced = unplaced.slice(0, Math.max(size, MaxPlaceBatch)).map((path) =>
        {
            const entry = architecture.files[path]
            const near = new Set<string>()
            for (const other of [...(imports.get(path) ?? []), ...(usedBy.get(path) ?? [])]) for (const home of homes.get(other) ?? []) near.add(home)
            return {
                path, system: entry?.system ?? '', layer: entry?.layer ?? '', tags: entry?.tags ?? [], summary: entry?.summary ?? '',
                imports: (imports.get(path) ?? []).slice(0, MaxFileLinks), usedBy: (usedBy.get(path) ?? []).slice(0, MaxFileLinks),
                near: [...near].sort().slice(0, MaxNearby),
            }
        })
        return batch
    }

    batch.review = review
    batch.mode = review!.blocking.length > 0 ? 'review' : 'done'
    return batch
}
