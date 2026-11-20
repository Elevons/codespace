import { SkippedSummary } from './Ingest.ts'
import { Refine } from './Refine.ts'
import type { IHealthReport, ISecretFinding } from '../../public/health.ts'
import type { IArchitecture } from './Architecture.ts'

/** The line count past which a file is worth a second look, if only for the agent that must read it. */
export const OversizedLines = 600

/** The most oversized files, undescribed files, or secret-shaped values a report lists. */
export const MaxFindings = 12

/** The most source files a secret scan reads, and the most of each file it reads. */
const MaxScannedFiles = 400
const MaxScannedChars = 200_000

/** How many files the secret scan reads at once. */
const ScanLimit = 8

/** The folder names whose files reach a browser, where a value is public however it was meant. */
const ShippedFolder = /(^|\/)(public|static|assets|client|web|frontend|www|app|pages|components|screens)\//i

/** The file types whose text can reach a browser. */
const ShippedFile = /\.(?:js|mjs|cjs|ts|tsx|jsx|vue|svelte|html?)$/i

/** Values that are named like a key but plainly are not one. */
const Placeholder = /^(?:process\.|import\.meta|undefined|null|true|false|changeme|change_me|change-me|your[-_]|my[-_]|example|placeholder|todo|xxx+|\*+|<|\$\{|\{\{|%|@)/i

/** A name that suggests a key, assigned a quoted value of some length. */
const SecretShape = /\b((?:[A-Za-z_$][\w$]*)?(?:api[_-]?key|secret|token|password|passwd|private[_-]?key|access[_-]?key)[\w$]*)\s*[:=]\s*(["'`])([^"'`\n]{8,})["'`]/gi

/** A name that ends in "key", for the keys no word above names, such as an analytics key. */
const EndedKey = /\b([A-Za-z_$][\w$]*Key)\s*[:=]\s*(["'`])([^"'`\n]{8,})["'`]/gi

/** Names that end in "key" but hold a choice, not a secret, such as a key code or a sort key. */
const StructuralKey = /(?:keyCode|sortKey|rowKey|cacheKey|groupKey|primaryKey|foreignKey|mapKey|objectKey|uniqueKey|accessibilityKey)$/i

/** A value with a digit or a symbol in it, unlike a word or a key name. */
const HasVariety = /[0-9\W]/

/** Whether a file's text can reach a browser, and so a value in it is public. */
export function ShippedPath(path: string): boolean
{
    return ShippedFile.test(path) && (ShippedFolder.test(path) || /\.html?$/i.test(path))
}

/**
 * Looks for values that are named and written like a key in the text of one file.
 * @param path the file's repository-relative path
 * @param text its text
 */
export function SecretsIn(path: string, text: string): ISecretFinding[]
{
    const found: ISecretFinding[] = []
    const lines = text.split('\n')
    lines.forEach((line, index) =>
    {
        if (line.length > 500) return
        const seen = new Set<string>()
        const take = (key: string, value: string): void =>
        {
            if (Placeholder.test(value) || seen.has(key)) return
            seen.add(key)
            const hint = value.length <= 4 ? '…' : value.slice(0, 4) + '… (' + value.length + ' characters)'
            found.push({ path, line: index + 1, key, hint })
        }
        for (const shape of [SecretShape, EndedKey])
        {
            shape.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = shape.exec(line)) !== null)
            {
                const [, key, , value] = match
                if (value === undefined) continue
                // A name that ends in "key" must also hold something that is not only a word.
                if (shape === EndedKey && (StructuralKey.test(key!) || !HasVariety.test(value))) continue
                take(key!, value)
            }
        }
    })
    return found
}

/**
 * Reads the files that can reach a browser and collects the values that look like keys. The scan is
 * bounded in files and in characters, so a large repository answers in a moment.
 * @param files every file the map knows
 * @param read reads one file's text, refusing what must not be read
 */
export async function ScanSecretsAsync(files: readonly string[], read: (path: string) => Promise<string>): Promise<{ findings: ISecretFinding[], scanned: number }>
{
    const candidates = files.filter(ShippedPath).slice(0, MaxScannedFiles)
    const findings: ISecretFinding[] = []
    let next = 0
    let scanned = 0
    const workers = Array.from({ length: Math.min(ScanLimit, candidates.length) }, async () =>
    {
        while (next < candidates.length)
        {
            const path = candidates[next++]!
            let text: string
            try { text = await read(path) }
            catch { continue }
            scanned++
            if (findings.length >= MaxFindings) continue
            for (const finding of SecretsIn(path, text.slice(0, MaxScannedChars)))
            {
                if (findings.length >= MaxFindings) break
                findings.push(finding)
            }
        }
    })
    await Promise.all(workers)
    findings.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line))
    return { findings: findings.slice(0, MaxFindings), scanned }
}

/**
 * Describes the shape of a codebase and points at what is worth a look: its size, the files nobody
 * has described, the imports that go up the layers, the largest files, and any layering problems.
 * It reads nothing and decides nothing; the answer is a checklist, and a person judges each item.
 * @param architecture what the architecture file says
 * @param edges every import, as the importing file and the imported one
 * @param lines each code file's line count
 * @param files every file the map knows
 */
export function Survey(architecture: IArchitecture, edges: ReadonlyArray<readonly [string, string]>, lines: Readonly<Record<string, number>>, files: readonly string[]): IHealthReport
{
    const refine = Refine(architecture, edges, MaxFindings)
    // Generated and vendored files are settled by `next`, not described, so they are not gaps.
    const readable = files.filter((path) => SkippedSummary(path) === null)
    const described = readable.filter((path) => architecture.files[path]?.summary !== undefined).length
    const undescribedPaths = readable.filter((path) => architecture.files[path]?.summary === undefined).sort()
    const oversized = Object.entries(lines)
        .filter(([path, count]) => count >= OversizedLines && SkippedSummary(path) === null)
        .map(([path, count]) => ({ path, lines: count }))
        .sort((a, b) => b.lines - a.lines || (a.path < b.path ? -1 : 1))
        .slice(0, MaxFindings)
    const total = Object.values(lines).reduce((sum, count) => sum + count, 0)

    return {
        files: files.length,
        codeFiles: Object.keys(lines).length,
        lines: total,
        imports: edges.length,
        described,
        undescribed: readable.length - described,
        undescribedPaths: undescribedPaths.slice(0, MaxFindings),
        layerBreaks: refine.breakCount,
        breakGroups: refine.breaks.map((group) => ({
            from: group.from, to: group.to, count: group.count, ordinary: group.ordinary,
            examples: group.examples.map((example) => ({ from: example.from.path, to: example.to.path })),
        })),
        oversized,
        issues: refine.issues,
        notes: [
            'Layer breaks count imports from a lower layer into a higher one, which the layer order says should not happen.',
            'A secret-shaped value is found by its name and its quotes, not proved: a key meant to be public is reported too.',
            'Size is a line count, not a judgement; a long table or list is often right.',
        ],
    }
}
