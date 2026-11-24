import type { IArchitecture } from './Architecture.ts'
import { ConceptsGuide } from './ConceptsGuide.ts'
import type { Graph } from './Graph.ts'
import type { Repo } from './Repo.ts'

const MaxSourceChars = 12_000
const MaxExcerptChars = 3_000
const MaxCandidates = 60

export interface IConceptFile
{
    path: string
    summary: string
    source: string
    truncated: boolean
    imports: string[]
    usedBy: string[]
}

export interface IConceptCandidate
{
    kind: 'entry file' | 'endpoint' | 'cli command' | 'button' | 'key'
    name: string
    path: string
    line: number
}

export interface IConceptsBatch
{
    mode: 'candidates' | 'operations' | 'things' | 'done'
    guide: string
    layers: string[]
    things: Array<{ name: string, summary?: string, layer?: string, missing: string[] }>
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
    }>
    remaining: number
}

// What each kind of entry point looks like in source text.
const Finders: Array<{ kind: IConceptCandidate['kind'], pattern: RegExp, test: (path: string) => boolean }> = [
    { kind: 'endpoint', pattern: /path === '(\/api\/[^']+)'/g, test: (path) => /\.(ts|js|mjs|cs)$/.test(path) },
    { kind: 'cli command', pattern: /command === '([a-z][a-z-]*)'/g, test: (path) => /\.(ts|js|mjs)$/.test(path) },
    { kind: 'button', pattern: /<button[^>]*\bid="([^"]+)"/g, test: (path) => path.endsWith('.html') },
    { kind: 'key', pattern: /(?:\.key|\.code) === '([^']+)'/g, test: (path) => /\.(ts|js)$/.test(path) },
]

export function OperationMissing(operation: { steps: unknown[], reads: unknown[], writes: unknown[] }): string[]
{
    const missing: string[] = []
    if (operation.steps.length === 0) missing.push('steps')
    if (operation.reads.length === 0 && operation.writes.length === 0) missing.push('reads or writes')
    return missing
}

export async function ConceptsNextAsync(repo: Repo, architecture: IArchitecture, graph: Graph, size: number, cli: string): Promise<IConceptsBatch>
{
    const usedBy = new Map<string, string[]>()
    for (const [from, to] of graph.Edges()) usedBy.set(to, [...(usedBy.get(to) ?? []), from])
    const describe = async (path: string, cap: number): Promise<IConceptFile> =>
    {
        const full = await repo.ReadFileAsync(path).catch(() => '')
        return { path, summary: architecture.files[path]?.summary ?? '', source: full.slice(0, cap), truncated: full.length > cap, imports: graph.ImportsOf(path), usedBy: usedBy.get(path) ?? [] }
    }

    const { things, operations } = architecture.concepts
    const thingRows = Object.entries(things).map(([name, thing]) =>
        ({ name, summary: thing.summary, layer: thing.layer, missing: thing.layer === undefined ? ['layer'] : [] }))
    const operationRows = Object.entries(operations).map(([name, operation]) => ({ name, operation, missing: OperationMissing(operation) }))
    const operationsLeft = operationRows.filter((row) => row.missing.length > 0)
    const thingsLeft = thingRows.filter((row) => row.missing.length > 0)
    const remaining = Object.keys(operations).length === 0 ? 1 : operationsLeft.length + thingsLeft.length
    const batch: IConceptsBatch = {
        mode: 'done', guide: ConceptsGuide(cli, repo.Root), layers: architecture.layers,
        things: thingRows, candidates: [], entryFiles: [], operations: [], remaining,
    }

    if (Object.keys(operations).length === 0)
    {
        batch.mode = 'candidates'
        const known = await repo.ListFilesAsync()
        for (const path of known)
        {
            const finders = Finders.filter((finder) => finder.test(path))
            if (finders.length === 0 || batch.candidates.length >= MaxCandidates) continue
            const text = await repo.ReadFileAsync(path).catch(() => '')
            const lines = text.split('\n')
            for (const finder of finders)
            {
                for (let index = 0; index < lines.length && batch.candidates.length < MaxCandidates; index++)
                {
                    for (const match of lines[index]!.matchAll(finder.pattern))
                        batch.candidates.push({ kind: finder.kind, name: match[1]!, path, line: index + 1 })
                }
            }
        }
        const entries = Object.entries(architecture.files).filter(([, entry]) => entry.tags?.includes('entry')).map(([path]) => path).slice(0, size)
        for (const path of entries)
        {
            batch.candidates.push({ kind: 'entry file', name: path, path, line: 1 })
            batch.entryFiles.push(await describe(path, MaxExcerptChars))
        }
        return batch
    }

    if (operationsLeft.length > 0)
    {
        batch.mode = 'operations'
        for (const row of operationsLeft.slice(0, size))
        {
            const files: IConceptFile[] = []
            for (const path of row.operation.files.slice(0, 12)) files.push(await describe(path, Math.floor(MaxSourceChars / Math.min(12, row.operation.files.length))))
            batch.operations.push({
                name: row.name, summary: row.operation.summary, missing: row.missing, optional: row.operation.rules.length === 0 ? ['rules'] : [],
                reads: row.operation.reads, writes: row.operation.writes, steps: row.operation.steps, rules: row.operation.rules, files,
            })
        }
        return batch
    }

    batch.mode = thingsLeft.length > 0 ? 'things' : 'done'
    return batch
}
