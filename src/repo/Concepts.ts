import { dirname, posix } from 'node:path'
import type { IArchitecture } from './Architecture.ts'
import { ConceptsGuide } from './ConceptsGuide.ts'
import type { Graph } from './Graph.ts'
import { SkippedSummary } from './Ingest.ts'
import type { Repo } from './Repo.ts'

export const DefaultConceptsSize = 8

// Budgets keep every response comfortably under host tool caps (e.g. 40 KB) even on large repos.
const MaxBatchSourceChars = 12_000
const MinFileSourceChars = 400
const MaxFileSourceChars = 5_000
const MaxEntrySourceTotal = 4_000
const MaxEntryExcerptChars = 1_200
const MaxEntryFiles = 4
const MaxOperationsPerBatch = 3
const MaxFilesPerOperation = 8
const MaxCandidates = 35
const MaxCandidatesPerFile = 8
const MaxThingCandidates = 8
const MaxThingLinks = 3
const MaxOverviewFolders = 30
const MaxOverviewFiles = 50
const MaxOverviewSummaryChars = 90
const MaxFileLinks = 16
const MaxReaches = 10
const MaxNearby = 8
const MaxUncoveredImportsPerOp = 6
const MinAppFilesForCoverageCheck = 8
const MinCoverageRatio = 0.6
const MinSystemFilesForCoverageCheck = 3

const RuntimeTags = new Set(['entry', 'orchestrate', 'core', 'io', 'ui'])
const NonCodeExtension = /\.(?:md|mdx|txt|json|jsonc|ya?ml|toml|xml|ini|css|scss|sass|less|lock)$/i
const DeclarationFile = /\.d\.[cm]?ts$/i
const TestPath = /(?:^|\/)(?:tests?|__tests__|specs?)\/|\.(?:test|spec)\.[^.]+$/i
const ThingKeyword = /\b(store|state|model|schema|snapshot|ledger|cache|record|database|db|table|entity|world|grid|graph|view|flow|queue|event|message|transcript|session|manifest|index|catalog|registry|repository|document|history|inventory|agent|society|settings|profile|account|order|user|project|workspace)\b/i
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
    reaches: string[]
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

export interface IConceptCandidate
{
    kind: 'entry file' | 'endpoint' | 'cli command' | 'button' | 'key' | 'handler' | 'orchestrator' | 'root'
    name: string
    path: string
    line: number
}

export interface IThingCandidate
{
    path: string
    layer: string
    system: string
    tags: string[]
    summary: string
    usedByCount: number
    usedBy: string[]
    imports: string[]
    reasons: string[]
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
    appFileCount: number
    systems: Record<string, { summary: string, files: number, layers: string[] }>
    folders: Array<{ path: string, summary: string, files: number }>
    files: IConceptOverviewFile[]
}

export interface IConceptCoverage
{
    appFiles: number
    coveredFiles: number
    ratio: number
    uncovered: IConceptOverviewFile[]
    uncoveredSystems: Array<{ name: string, appFiles: number, summary: string }>
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
    uncoveredImports: Array<{ path: string, layer: string, tags: string[], summary: string }>
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
    mode: 'candidates' | 'operations' | 'things' | 'review' | 'done'
    remaining: number
    guide: string
    layers: string[]
    overview?: IConceptOverview
    things: Array<{ name: string, summary?: string, layer?: string, missing: string[], readBy: string[], writtenBy: string[], suggestedLayers: string[] }>
    thingCandidates: IThingCandidate[]
    candidates: IConceptCandidate[]
    entryFiles: IConceptFile[]
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
    review?: IConceptsReview
}

// Language-agnostic entry, route, CLI, UI, and loop triggers; kept low-noise and capped per file.
const Finders: Array<{ kind: IConceptCandidate['kind'], pattern: RegExp, test: (path: string) => boolean }> = [
    { kind: 'endpoint', pattern: /path === '(\/api\/[^']+)'/g, test: (path) => /\.(ts|js|mjs|cs)$/.test(path) },
    { kind: 'endpoint', pattern: /\.(?:get|post|put|patch|delete|all)\s*\(\s*['"`](\/[^'"`\s]*)['"`]/g, test: (path) => /\.(ts|js|mjs|go)$/.test(path) },
    { kind: 'endpoint', pattern: /\[Http(?:Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"\s*\)\]/g, test: (path) => path.endsWith('.cs') },
    { kind: 'endpoint', pattern: /\.Map(?:Get|Post|Put|Delete|Patch)\s*\(\s*"([^"]+)"/g, test: (path) => path.endsWith('.cs') },
    { kind: 'endpoint', pattern: /@(?:app|router|bp)\.(?:get|post|put|patch|delete|route)\s*\(\s*['"]([^'"]+)['"]/g, test: (path) => path.endsWith('.py') },
    { kind: 'endpoint', pattern: /@(?:Get|Post|Put|Patch|Delete|RequestMapping)\s*\(\s*['"]([^'"]+)['"]/g, test: (path) => /\.(ts|java|kt)$/.test(path) },
    { kind: 'endpoint', pattern: /\bHandle(?:Func)?\s*\(\s*"(\/[^"]*)"/g, test: (path) => path.endsWith('.go') },
    { kind: 'cli command', pattern: /command === '([a-z][a-z-]*)'/g, test: (path) => /\.(ts|js|mjs)$/.test(path) },
    { kind: 'cli command', pattern: /(?:\.command|\.AddCommand|add_parser)\s*\(\s*['"]([a-zA-Z0-9][a-zA-Z0-9:_-]*)['"]/g, test: (path) => /\.(ts|js|mjs|py|cs|rs)$/.test(path) },
    { kind: 'button', pattern: /<button[^>]*\bid=["']([^"']+)["']/g, test: (path) => /\.(html|htm|tsx|jsx|vue|svelte)$/.test(path) },
    { kind: 'key', pattern: /(?:\.key|\.code) === '([^']+)'/g, test: (path) => /\.(ts|js|tsx|jsx)$/.test(path) },
    { kind: 'handler', pattern: /\b(?:public|protected|private)?\s*(?:static\s+|override\s+|virtual\s+|async\s+)*(?:void|Task(?:<[^>]+>)?|bool|int)\s+(Main|Tick|Step|Update|FixedUpdate|LateUpdate|Run|RunAsync|Execute|ExecuteAsync|Simulate|Advance|Process|Handle|Start)\s*\(/g, test: (path) => path.endsWith('.cs') },
    { kind: 'handler', pattern: /^\s*(?:async\s+)?def\s+(main|run|tick|step|update|execute|simulate|process|handle)\s*\(/g, test: (path) => path.endsWith('.py') },
    { kind: 'handler', pattern: /^func\s+(?:\([^)]+\)\s*)?(main|Run|Tick|Step|Update|Execute|Simulate|Process|Handle)\s*\(/g, test: (path) => path.endsWith('.go') },
    { kind: 'handler', pattern: /^\s*(?:pub\s+)?(?:async\s+)?fn\s+(main|run|tick|step|update|execute|simulate|process|handle)\s*\(/g, test: (path) => path.endsWith('.rs') },
]

function ShortSummary(text: string | undefined, cap = MaxOverviewSummaryChars): string
{
    if (text === undefined || text.length <= cap) return text ?? ''
    return text.slice(0, cap - 1).trimEnd() + '…'
}

export function IsAppFile(path: string, entry?: { layer?: string, tags?: string[] }): boolean
{
    if (SkippedSummary(path) !== null) return false
    const tags = entry?.tags ?? []
    if (tags.includes('test') || entry?.layer === 'tests' || TestPath.test(path)) return false
    if (entry?.layer === 'docs' || entry?.layer === 'config') return false
    if (DeclarationFile.test(path)) return false
    const hasRuntimeTag = tags.some((tag) => RuntimeTags.has(tag))
    if (tags.includes('config') && !hasRuntimeTag) return false
    if (NonCodeExtension.test(path) && !hasRuntimeTag) return false
    return true
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
}

export function ConceptsLeft(architecture: IArchitecture): IConceptsLeft
{
    const operations = Object.values(architecture.concepts.operations).filter((operation) => OperationMissing(operation).length > 0).length
    const things = Object.values(architecture.concepts.things).filter((thing) => thing.layer === undefined).length
    return { started: Object.keys(architecture.concepts.operations).length > 0, operations, things }
}

function BuildGraphIndex(graph: Graph, appSet: ReadonlySet<string>): {
    imports: Map<string, string[]>
    usedBy: Map<string, string[]>
    appImports: Map<string, string[]>
    appUsedBy: Map<string, string[]>
}
{
    const imports = new Map<string, string[]>()
    const usedBy = new Map<string, string[]>()
    const appImports = new Map<string, string[]>()
    const appUsedBy = new Map<string, string[]>()
    for (const [from, to] of graph.Edges())
    {
        if (from === to) continue
        imports.set(from, [...(imports.get(from) ?? []), to])
        usedBy.set(to, [...(usedBy.get(to) ?? []), from])
        if (appSet.has(from) && appSet.has(to))
        {
            appImports.set(from, [...(appImports.get(from) ?? []), to])
            appUsedBy.set(to, [...(appUsedBy.get(to) ?? []), from])
        }
    }
    return { imports, usedBy, appImports, appUsedBy }
}

function ReachesOf(start: string, appImports: ReadonlyMap<string, string[]>, maxDepth = 3): string[]
{
    const seen = new Set<string>([start])
    let frontier = [start]
    for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++)
    {
        const next: string[] = []
        for (const node of frontier)
        {
            for (const target of appImports.get(node) ?? [])
            {
                if (seen.has(target)) continue
                seen.add(target)
                next.push(target)
            }
        }
        frontier = next
    }
    seen.delete(start)
    return [...seen].sort().slice(0, MaxReaches)
}

function OverviewFile(path: string, architecture: IArchitecture, appImports: ReadonlyMap<string, string[]>, appUsedBy: ReadonlyMap<string, string[]>): IConceptOverviewFile
{
    const entry = architecture.files[path]
    return {
        path,
        system: entry?.system ?? '',
        layer: entry?.layer ?? '',
        tags: entry?.tags ?? [],
        summary: ShortSummary(entry?.summary),
        imports: (appImports.get(path) ?? []).length,
        usedBy: (appUsedBy.get(path) ?? []).length,
    }
}

function FilePriority(file: IConceptOverviewFile): number
{
    let score = file.imports + file.usedBy
    if (file.tags.includes('entry')) score += 40
    if (file.tags.includes('orchestrate')) score += 30
    if (file.tags.includes('data')) score += 20
    if (file.tags.includes('io')) score += 15
    if (file.tags.includes('core')) score += 10
    return score
}

function BuildOverview(architecture: IArchitecture, appFiles: readonly string[], appImports: ReadonlyMap<string, string[]>, appUsedBy: ReadonlyMap<string, string[]>): IConceptOverview
{
    const systems: IConceptOverview['systems'] = {}
    const systemLayers = new Map<string, Set<string>>()
    for (const [name, entry] of Object.entries(architecture.systems))
    {
        systems[name] = { summary: ShortSummary(entry.summary, 140), files: 0, layers: [] }
        systemLayers.set(name, new Set())
    }
    const folderCounts = new Map<string, number>()
    const allFiles: IConceptOverviewFile[] = []
    for (const path of appFiles)
    {
        const row = OverviewFile(path, architecture, appImports, appUsedBy)
        allFiles.push(row)
        if (row.system !== '' && systems[row.system])
        {
            systems[row.system]!.files++
            if (row.layer !== '') systemLayers.get(row.system)!.add(row.layer)
        }
        const folder = dirname(path) === '.' ? '' : dirname(path)
        if (folder !== '') folderCounts.set(folder, (folderCounts.get(folder) ?? 0) + 1)
    }
    for (const [name, layers] of systemLayers) systems[name]!.layers = architecture.layers.filter((layer) => layers.has(layer))
    const allFolders = [...folderCounts.entries()]
    const keptFolders = allFolders.length <= MaxOverviewFolders
        ? allFolders
        : [...allFolders].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, MaxOverviewFolders)
    const folders = keptFolders
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, files]) => ({ path, summary: ShortSummary(architecture.folders[path]), files }))
    const files = allFiles.length <= MaxOverviewFiles
        ? allFiles
        : [...allFiles].sort((a, b) => FilePriority(b) - FilePriority(a) || a.path.localeCompare(b.path))
            .slice(0, MaxOverviewFiles)
            .sort((a, b) => a.path.localeCompare(b.path))
    return { appFileCount: appFiles.length, systems, folders, files }
}

function FindThingCandidates(architecture: IArchitecture, appFiles: readonly string[], appImports: ReadonlyMap<string, string[]>, appUsedBy: ReadonlyMap<string, string[]>): IThingCandidate[]
{
    const layerRank = new Map(architecture.layers.map((layer, index) => [layer, index]))
    const lowerHalf = Math.ceil(architecture.layers.length / 2)
    const scored: Array<{ score: number, candidate: IThingCandidate }> = []
    for (const path of appFiles)
    {
        const entry = architecture.files[path]
        const tags = entry?.tags ?? []
        const summary = entry?.summary ?? ''
        const layer = entry?.layer ?? ''
        const usedBy = appUsedBy.get(path) ?? []
        const imports = appImports.get(path) ?? []
        const reasons: string[] = []
        let score = 0
        if (tags.includes('data')) { score += 3; reasons.push('tagged data') }
        if (tags.includes('io')) { score += 2; reasons.push('tagged io') }
        if (usedBy.length >= 3) { score += 2; reasons.push(`imported by ${usedBy.length} files`) }
        else if (usedBy.length >= 2 && layer !== '' && (layerRank.get(layer) ?? lowerHalf) < lowerHalf)
        {
            score += 1
            reasons.push(`shared on layer ${layer} (${usedBy.length} importers)`)
        }
        const base = posix.basename(path).replace(/\.[^.]+$/, '')
        if (ThingKeyword.test(base) || ThingKeyword.test(summary))
        {
            score += 2
            reasons.push('names state, store, or data')
        }
        if ((tags.includes('entry') || tags.includes('ui')) && !tags.includes('data') && !tags.includes('io')) score -= 2
        if (score < 2) continue
        scored.push({
            score,
            candidate: {
                path, layer, system: entry?.system ?? '', tags, summary: ShortSummary(summary),
                usedByCount: usedBy.length,
                usedBy: usedBy.slice(0, MaxThingLinks),
                imports: imports.slice(0, MaxThingLinks),
                reasons,
            },
        })
    }
    scored.sort((a, b) => b.score - a.score || b.candidate.usedByCount - a.candidate.usedByCount || a.candidate.path.localeCompare(b.candidate.path))
    return scored.slice(0, MaxThingCandidates).map((item) => item.candidate)
}

export function ReviewConcepts(architecture: IArchitecture, graph: Graph, known: readonly string[], size = DefaultConceptsSize): IConceptsReview
{
    const appFiles = known.filter((path) => IsAppFile(path, architecture.files[path])).sort()
    const appSet = new Set(appFiles)
    const { appImports, appUsedBy } = BuildGraphIndex(graph, appSet)

    const { things, operations } = architecture.concepts
    const opEntries = Object.entries(operations)
    const coveredSet = new Set<string>()
    const opAppFiles = new Map<string, Set<string>>()
    const readers = new Map<string, string[]>()
    const writers = new Map<string, string[]>()
    for (const name of Object.keys(things)) { readers.set(name, []); writers.set(name, []) }

    for (const [name, op] of opEntries)
    {
        const set = new Set<string>()
        for (const path of op.files)
        {
            coveredSet.add(path)
            if (appSet.has(path)) set.add(path)
        }
        for (const step of op.steps)
        {
            for (const path of step.files)
            {
                coveredSet.add(path)
                if (appSet.has(path)) set.add(path)
            }
        }
        opAppFiles.set(name, set)
        for (const thing of op.reads) readers.get(thing)?.push(name)
        for (const thing of op.writes) writers.get(thing)?.push(name)
    }

    const coveredFiles = appFiles.filter((path) => coveredSet.has(path)).length
    const ratio = appFiles.length === 0 ? 1 : Number((coveredFiles / appFiles.length).toFixed(2))
    const uncovered = appFiles
        .filter((path) => !coveredSet.has(path))
        .map((path) => OverviewFile(path, architecture, appImports, appUsedBy))
        .sort((a, b) => FilePriority(b) - FilePriority(a) || a.path.localeCompare(b.path))
        .slice(0, Math.min(Math.max(size, 12), 15))

    const systemCounts = new Map<string, { total: number, covered: number }>()
    for (const path of appFiles)
    {
        const system = architecture.files[path]?.system
        if (system === undefined || !(system in architecture.systems)) continue
        const counts = systemCounts.get(system) ?? { total: 0, covered: 0 }
        counts.total++
        if (coveredSet.has(path)) counts.covered++
        systemCounts.set(system, counts)
    }
    const uncoveredSystems = [...systemCounts.entries()]
        .filter(([, counts]) => counts.total >= MinSystemFilesForCoverageCheck && counts.covered === 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([name, counts]) => ({ name, appFiles: counts.total, summary: ShortSummary(architecture.systems[name]?.summary) }))

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
        blocking.push(`The system "${system.name}" (${system.appFiles} application files) has no files in any operation.`)
    if (opEntries.length > 0 && appFiles.length >= MinAppFilesForCoverageCheck && ratio < MinCoverageRatio)
        blocking.push(`Only ${coveredFiles} of ${appFiles.length} application files (${Math.round(ratio * 100)}%) appear in any operation; add operations or steps for the uncovered files.`)

    if (opEntries.length > 0 && appFiles.length >= 15 && opEntries.length < 3)
        issues.push(`Only ${opEntries.length} operation(s) cover a ${appFiles.length}-file codebase; check whether major workflows were missed or merged too broadly.`)
    if (opEntries.length > 20)
        issues.push(`There are ${opEntries.length} operations; merge near-duplicates so the design stays readable (typically 6 to 15).`)

    const divergences: IConceptDivergence[] = []
    for (const [name, op] of opEntries)
    {
        if (op.summary === undefined) issues.push(`The operation "${name}" has no summary.`)
        const appCount = opAppFiles.get(name)?.size ?? 0
        if (op.files.length >= 4 && op.steps.length === 1)
            issues.push(`The operation "${name}" covers ${op.files.length} files in one step; split it into 3 to 8 ordered steps showing what happens to the data.`)
        if (appFiles.length >= 12 && appCount > Math.max(20, Math.floor(appFiles.length * 0.6)))
            issues.push(`The operation "${name}" covers ${appCount} of ${appFiles.length} application files; consider splitting it into distinct operations.`)
        const emptySteps = op.steps.filter((step) => step.files.length === 0).length
        if (emptySteps > 0 && emptySteps < op.steps.length)
            issues.push(`The operation "${name}" has ${emptySteps} step(s) with no files cited as evidence.`)
        const stepFileSet = new Set(op.steps.flatMap((step) => step.files))
        const unplaced = op.files.filter((path) => !stepFileSet.has(path))
        if (op.steps.length > 0 && unplaced.length > 0)
            issues.push(`The operation "${name}" lists ${unplaced.length} file(s) not tied to any step: ${unplaced.slice(0, 5).join(', ')}.`)
        if (op.steps.some((step) => CodeFileMention.test(step.text)))
            issues.push(`A step in "${name}" names a file in its text; write steps in plain words and keep file paths in step.files.`)

        // Reflexion check: uncovered app files directly imported by this operation's files.
        const missingImports = new Set<string>()
        for (const path of opAppFiles.get(name) ?? [])
        {
            for (const target of appImports.get(path) ?? []) if (!coveredSet.has(target)) missingImports.add(target)
        }
        if (missingImports.size > 0)
        {
            const list = [...missingImports]
                .map((path) => OverviewFile(path, architecture, appImports, appUsedBy))
                .sort((a, b) => FilePriority(b) - FilePriority(a) || a.path.localeCompare(b.path))
                .slice(0, MaxUncoveredImportsPerOp)
                .map(({ path, layer, tags, summary }) => ({ path, layer, tags, summary }))
            divergences.push({ operation: name, uncoveredImports: list })
        }
    }
    divergences.sort((a, b) => b.uncoveredImports.length - a.uncoveredImports.length || a.operation.localeCompare(b.operation))

    const overlaps: IConceptOverlap[] = []
    for (let i = 0; i < opEntries.length; i++)
    {
        const [nameA] = opEntries[i]!
        const setA = opAppFiles.get(nameA)!
        if (setA.size < 2) continue
        for (let j = i + 1; j < opEntries.length; j++)
        {
            const [nameB] = opEntries[j]!
            const setB = opAppFiles.get(nameB)!
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
        coverage: { appFiles: appFiles.length, coveredFiles, ratio, uncovered, uncoveredSystems },
        orphanThings,
        externalInputs,
        finalOutputs,
        overlaps: overlaps.slice(0, reviewLimit),
        divergences: divergences.slice(0, reviewLimit),
        issues: issues.slice(0, Math.min(Math.max(size * 2, 16), 20)),
        blocking,
    }
}

export async function ConceptsNextAsync(repo: Repo, architecture: IArchitecture, graph: Graph, size: number, cli: string): Promise<IConceptsBatch>
{
    const known = await repo.ListFilesAsync()
    const appFiles = known.filter((path) => IsAppFile(path, architecture.files[path])).sort()
    const appSet = new Set(appFiles)
    const { usedBy, appImports, appUsedBy } = BuildGraphIndex(graph, appSet)

    const describe = async (path: string, cap: number, includeReaches: boolean): Promise<IConceptFile> =>
    {
        const full = await repo.ReadFileAsync(path).catch(() => '')
        const entry = architecture.files[path]
        return {
            path,
            summary: ShortSummary(entry?.summary),
            layer: entry?.layer ?? '',
            system: entry?.system ?? '',
            tags: entry?.tags ?? [],
            source: full.slice(0, cap),
            truncated: full.length > cap,
            imports: graph.ImportsOf(path).slice(0, MaxFileLinks),
            usedBy: (usedBy.get(path) ?? []).slice(0, MaxFileLinks),
            reaches: includeReaches ? ReachesOf(path, appImports) : [],
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
        missing: thing.layer === undefined ? ['layer'] : [],
        readBy: readBy.get(name) ?? [],
        writtenBy: writtenBy.get(name) ?? [],
        suggestedLayers: architecture.layers.filter((layer) => touchedLayers.get(name)?.has(layer)),
    }))
    const operationRows = Object.entries(operations).map(([name, operation]) => ({ name, operation, missing: OperationMissing(operation) }))
    const operationsLeft = operationRows.filter((row) => row.missing.length > 0)
    const thingsLeft = thingRows.filter((row) => row.missing.length > 0)
    const hasOperations = Object.keys(operations).length > 0
    const review = hasOperations ? ReviewConcepts(architecture, graph, known, size) : undefined
    const remaining = !hasOperations ? 1 : operationsLeft.length + thingsLeft.length + review!.blocking.length

    // Keep overview near the top of the serialized JSON so it is never clipped if a host truncates long tool replies.
    const batch: IConceptsBatch = {
        mode: 'done',
        remaining,
        guide: ConceptsGuide(cli, repo.Root),
        layers: architecture.layers,
        overview: undefined,
        things: thingRows,
        thingCandidates: [],
        candidates: [],
        entryFiles: [],
        operations: [],
        review: undefined,
    }

    if (!hasOperations)
    {
        batch.mode = 'candidates'
        batch.overview = BuildOverview(architecture, appFiles, appImports, appUsedBy)
        batch.thingCandidates = FindThingCandidates(architecture, appFiles, appImports, appUsedBy)

        const seenCandidate = new Set<string>()
        const pushCandidate = (candidate: IConceptCandidate): void =>
        {
            if (batch.candidates.length >= MaxCandidates) return
            const key = `${candidate.kind}\u0000${candidate.path}\u0000${candidate.name}`
            if (seenCandidate.has(key)) return
            seenCandidate.add(key)
            batch.candidates.push(candidate)
        }

        const taggedEntries = appFiles.filter((path) => architecture.files[path]?.tags?.includes('entry'))
        const orchestrators = appFiles.filter((path) => !taggedEntries.includes(path) && architecture.files[path]?.tags?.includes('orchestrate'))
        const graphRoots = appFiles
            .filter((path) => !taggedEntries.includes(path) && !orchestrators.includes(path) && (appUsedBy.get(path)?.length ?? 0) === 0 && (appImports.get(path)?.length ?? 0) >= 2)
            .sort((a, b) => (appImports.get(b)?.length ?? 0) - (appImports.get(a)?.length ?? 0) || a.localeCompare(b))

        // Add structural entry candidates first so high-signal entry points are never crowded out by regex matches.
        for (const path of taggedEntries.slice(0, 10)) pushCandidate({ kind: 'entry file', name: path, path, line: 1 })
        for (const path of orchestrators.slice(0, Math.min(size, 6))) pushCandidate({ kind: 'orchestrator', name: path, path, line: 1 })
        for (const path of graphRoots.slice(0, Math.min(size, 6))) pushCandidate({ kind: 'root', name: path, path, line: 1 })

        const matchedFiles = new Set<string>()
        for (const path of appFiles)
        {
            const finders = Finders.filter((finder) => finder.test(path))
            if (finders.length === 0 || batch.candidates.length >= MaxCandidates) continue
            const text = await repo.ReadFileAsync(path).catch(() => '')
            const lines = text.split('\n')
            let perFile = 0
            for (const finder of finders)
            {
                for (let index = 0; index < lines.length && batch.candidates.length < MaxCandidates && perFile < MaxCandidatesPerFile; index++)
                {
                    for (const match of lines[index]!.matchAll(finder.pattern))
                    {
                        if (batch.candidates.length >= MaxCandidates || perFile >= MaxCandidatesPerFile) break
                        const before = batch.candidates.length
                        pushCandidate({ kind: finder.kind, name: match[1]!, path, line: index + 1 })
                        if (batch.candidates.length > before) { perFile++; matchedFiles.add(path) }
                    }
                }
            }
        }

        const fallbacks = appFiles
            .filter((path) => !taggedEntries.includes(path) && !orchestrators.includes(path) && !graphRoots.includes(path))
            .sort((a, b) =>
                Number(matchedFiles.has(b)) - Number(matchedFiles.has(a))
                || (appImports.get(b)?.length ?? 0) - (appImports.get(a)?.length ?? 0)
                || a.localeCompare(b))

        const chosenEntries = [...taggedEntries, ...orchestrators, ...graphRoots, ...fallbacks].slice(0, Math.min(size, MaxEntryFiles))
        const excerptCap = chosenEntries.length === 0
            ? MaxEntryExcerptChars
            : Math.max(MinFileSourceChars, Math.min(MaxEntryExcerptChars, Math.floor(MaxEntrySourceTotal / chosenEntries.length)))
        for (const path of chosenEntries) batch.entryFiles.push(await describe(path, excerptCap, true))
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
            const opFiles = row.operation.files.slice(0, MaxFilesPerOperation)
            const files: IConceptFile[] = []
            for (const path of opFiles) files.push(await describe(path, perFile, false))

            const inOp = new Set(row.operation.files)
            const nearbyMap = new Map<string, 'imports' | 'usedBy'>()
            for (const path of row.operation.files)
            {
                for (const target of appImports.get(path) ?? []) if (!inOp.has(target) && !nearbyMap.has(target)) nearbyMap.set(target, 'imports')
            }
            for (const path of row.operation.files)
            {
                for (const caller of appUsedBy.get(path) ?? []) if (!inOp.has(caller) && !nearbyMap.has(caller)) nearbyMap.set(caller, 'usedBy')
            }
            const nearby: IConceptNearby[] = [...nearbyMap.entries()]
                .slice(0, MaxNearby)
                .map(([path, relation]) =>
                {
                    const entry = architecture.files[path]
                    return { path, relation, layer: entry?.layer ?? '', system: entry?.system ?? '', tags: entry?.tags ?? [], summary: ShortSummary(entry?.summary) }
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
                files,
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

    batch.review = review
    if (review!.blocking.length > 0)
    {
        batch.mode = 'review'
        batch.overview = BuildOverview(architecture, appFiles, appImports, appUsedBy)
        return batch
    }

    batch.mode = 'done'
    return batch
}
