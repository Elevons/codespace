import ts from 'typescript'
import { TS_JS_FILE } from '../../public/symbols.ts'
import { Architecture, MaxSummary, type IArchitecturePatch } from './Architecture.ts'
import { JsonStore } from './JsonStore.ts'
import { Ledger } from './Ledger.ts'
import type { Repo } from './Repo.ts'

/** What lifting one file's comments found and left. */
export interface ILifted
{
    /** The file's text with those comments taken out. */
    text: string
    /** The notes, by name: "Name", "Class.member", and each function's steps as "Name:1", "Name:2". */
    notes: Record<string, string>
    /** The names whose steps were lifted, so steps kept before for them are replaced, not added to. */
    stepped: string[]
    /** How many comments were taken out. */
    count: number
}

/** What lifting a whole repository did. */
export interface ILiftReport
{
    /** The files whose comments were moved. */
    files: number
    /** The comments moved, in all. */
    comments: number
    /** The notes written to the architecture file. */
    notes: number
    /** Notes cut to the longest kept, by file and name. */
    cut: string[]
    /** Whether anything was written; false for a dry run. */
    written: boolean
}

/** The name a declaration is known by in a note, or null for one that is not named. */
function NameOf(node: ts.Node): string | null
{
    if (ts.isConstructorDeclaration(node)) return 'constructor'
    if (ts.isVariableStatement(node))
    {
        const first = node.declarationList.declarations[0]
        return first !== undefined && ts.isIdentifier(first.name) ? first.name.text : null
    }
    const named = ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) ||
        ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node) ||
        ts.isMethodDeclaration(node) || ts.isMethodSignature(node) || ts.isPropertyDeclaration(node) ||
        ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) ||
        ts.isEnumMember(node) || ts.isPropertyAssignment(node) || ts.isVariableDeclaration(node)
    if (!named) return null
    const name = (node as ts.NamedDeclaration).name
    if (name === undefined) return null
    if (ts.isIdentifier(name) || ts.isPrivateIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
    return null
}

/** A JSDoc comment's prose: no markers, each tag as a plain line ("name: meaning" for a parameter). */
function CleanDoc(raw: string): string
{
    const lines = raw.replace(/^\/\*\*+/, '').replace(/\*+\/$/, '').split('\n').map((line) => line.replace(/^\s*\*+ ?/, '').trimEnd())
    const prose: string[] = []
    const tags: string[] = []
    let inTags = false
    for (const line of lines)
    {
        const tag = /^@(\w+)\s*(.*)$/.exec(line.trim())
        if (tag !== null)
        {
            inTags = true
            const [, name, rest] = tag
            if (name === 'param') tags.push(rest!.replace(/^\{[^}]*\}\s*/, '').replace(/^(\[?[\w$.]+\]?)\s*-?\s*/, '$1: '))
            else if (name === 'returns' || name === 'return') tags.push('Returns ' + rest!.replace(/^\{[^}]*\}\s*/, ''))
            else tags.push('@' + name + (rest ? ' ' + rest : ''))
            continue
        }
        if (inTags && tags.length > 0 && line.trim() !== '') tags[tags.length - 1] += ' ' + line.trim()
        else if (!inTags) prose.push(line.trim())
    }
    const text = prose.join('\n').replace(/\n{3,}/g, '\n\n').trim().replace(/(?<!\n)\n(?!\n)/g, ' ')
    return [text, ...tags].filter((part) => part !== '').join('\n')
}

/** A run of `//>` lines as one step's prose. */
function CleanSteps(lines: string[]): string
{
    return lines.map((line) => line.replace(/^\/\/>\s?/, '').trim()).filter((line) => line !== '').join(' ')
}

/**
 * Takes a script's plain-English comments out of it, as notes for the architecture file: every JSDoc
 * comment (`/** … *\/`) and every step comment (`//>`). A JSDoc comment on a declaration becomes that
 * declaration's note; anything else becomes the next step of the declaration it sits in. Other
 * comments, the short reasons code is the way it is, stay where they are.
 * @param path the file's path, which picks how it is parsed
 * @param text the file's text
 */
export function LiftNotes(path: string, text: string): ILifted
{
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, path.endsWith('x') ? ts.ScriptKind.TSX : undefined)
    const seen = new Set<number>()
    const cuts: Array<{ start: number, end: number }> = []
    const notes: Record<string, string> = {}
    const steps = new Map<string, string[]>()
    const stepOf = (key: string, prose: string): void =>
    {
        if (prose === '') return
        const list = steps.get(key) ?? []
        list.push(prose)
        steps.set(key, list)
    }
    const noteOf = (key: string, prose: string): void =>
    {
        if (prose === '') return
        notes[key] = notes[key] === undefined ? prose : notes[key] + '\n\n' + prose
    }

    // The comments in front of one position, taken in order. A run of `//>` lines is one step of the
    // declaration they sit in; a JSDoc comment is the note of the declaration it sits on.
    const take = (position: number, owner: string | null, enclosing: string): void =>
    {
        const ranges = ts.getLeadingCommentRanges(text, position) ?? []
        let run: string[] = []
        const flush = (): void => { if (run.length > 0) { stepOf(enclosing, CleanSteps(run)); run = [] } }
        ranges.forEach((range, at) =>
        {
            if (seen.has(range.pos)) return
            seen.add(range.pos)
            const raw = text.slice(range.pos, range.end)
            if (raw.startsWith('//>'))
            {
                run.push(raw)
                cuts.push({ start: range.pos, end: range.end })
                // A run ends at a comment of another kind or a blank line.
                const next = ranges[at + 1]
                if (next === undefined || !text.slice(next.pos, next.end).startsWith('//>') || /\n\s*\n/.test(text.slice(range.end, next.pos))) flush()
                return
            }
            flush()
            if (!raw.startsWith('/**') || raw === '/**/' || raw.startsWith('/***')) return
            cuts.push({ start: range.pos, end: range.end })
            const prose = CleanDoc(raw)
            // The last JSDoc before a declaration is its note; any other is a step of where it sits.
            const last = ranges.slice(at + 1).every((later) => !text.slice(later.pos, later.end).startsWith('/**'))
            if (owner !== null && last) noteOf(owner, prose)
            else if (enclosing === '#file') noteOf('#file', prose)
            else stepOf(enclosing, prose)
        })
        flush()
    }

    // The deepest named declaration starting where a node starts, which the comments in front of it describe.
    const ownerAt = (node: ts.Node): ts.Node | null =>
    {
        let at: ts.Node | undefined = node
        while (at !== undefined)
        {
            if (NameOf(at) !== null) return at
            const first: ts.Node | undefined = at.getChildren(source)[0]
            if (first === undefined || first.pos !== node.pos) return null
            at = first
        }
        return null
    }

    // Whether a declaration is the first of a variable statement, which already gave the scope its name.
    const namedByStatement = (node: ts.Node): boolean =>
        ts.isVariableDeclaration(node) && ts.isVariableDeclarationList(node.parent) && ts.isVariableStatement(node.parent.parent) &&
        node.parent.declarations[0] === node

    const visit = (node: ts.Node, scope: string[]): void =>
    {
        const here = scope.length === 0 ? '#file' : scope.join('.')
        for (const child of node.getChildren(source))
        {
            const owner = ownerAt(child)
            take(child.pos, owner === null ? null : [...scope, NameOf(owner)!].join('.'), here)
            const name = NameOf(child)
            visit(child, name !== null && !namedByStatement(child) ? [...scope, name] : scope)
        }
    }
    visit(source, [])

    // Each function's steps are numbered in the order they come.
    for (const [key, list] of steps) list.forEach((prose, at) => { notes[`${key}:${at + 1}`] = prose })

    // Then the comments are cut out, last first, with the line each stood on when nothing else was on it.
    cuts.sort((a, b) => b.start - a.start)
    let result = text
    for (const { start, end } of cuts)
    {
        const lineStart = result.lastIndexOf('\n', start - 1) + 1
        let lineEnd = result.indexOf('\n', end)
        if (lineEnd === -1) lineEnd = result.length
        const before = result.slice(lineStart, start), after = result.slice(end, lineEnd)
        if (before.trim() === '' && after.trim() === '') result = result.slice(0, lineStart) + result.slice(Math.min(result.length, lineEnd + 1))
        else result = result.slice(0, start) + result.slice(end).replace(/^[ \t]+/, after.trim() === '' ? '' : ' ')
    }
    return { text: result, notes, stepped: [...steps.keys()], count: cuts.length }
}

/**
 * Moves the plain-English comments of every script in a repository into its architecture file, as
 * notes, and takes them out of the code. A note already kept is replaced by one lifted for the same
 * name, and a function's lifted steps replace the steps kept for it; other notes are kept. Files
 * whose description was up to date are stamped again, so taking comments out does not mark them changed.
 * @param repo the repository
 * @param dryRun when true, only reports what it would do
 */
export async function LiftNotesAsync(repo: Repo, dryRun: boolean): Promise<ILiftReport>
{
    const files = await repo.ListFilesAsync()
    const architecture = await Architecture.ReadAsync(repo.Root, files)
    const record = await Ledger.ReadAsync(repo.Root)
    const report: ILiftReport = { files: 0, comments: 0, notes: 0, cut: [], written: false }
    const patch: IArchitecturePatch = { files: {} }
    const rewritten = new Map<string, string>()

    for (const path of files)
    {
        if (!TS_JS_FILE.test(path) || path.endsWith('.d.ts')) continue
        const text = await repo.ReadFileAsync(path)
        if (!text.includes('/**') && !text.includes('//>')) continue
        const lifted = LiftNotes(path, text)
        if (lifted.count === 0) continue
        // The notes kept before, less the steps of each function whose steps were lifted again.
        const kept = { ...(architecture.files[path]?.notes ?? {}) }
        for (const key of Object.keys(kept)) if (lifted.stepped.some((name) => key.startsWith(name + ':'))) delete kept[key]
        const merged: Record<string, string> = { ...kept }
        for (const [key, note] of Object.entries(lifted.notes))
        {
            if (note.length > MaxSummary) report.cut.push(`${path}: ${key}`)
            merged[key] = note.length > MaxSummary ? note.slice(0, MaxSummary - 1) + '…' : note
        }
        patch.files![path] = { notes: merged, replaceNotes: true }
        rewritten.set(path, lifted.text)
        report.files++
        report.comments += lifted.count
        report.notes += Object.keys(lifted.notes).length
    }
    if (dryRun || rewritten.size === 0) return report

    // The files whose description matched their text before, to stamp again once the comments are out.
    const current = new Set(Object.keys(architecture.files).filter((path) => record[path] !== undefined))
    const changed = new Set(await Ledger.ChangedAsync(repo, record, [...current]))

    // The notes are written first, so a refused note leaves every script as it was.
    await Architecture.UpdateAsync(repo.Root, files, patch)
    for (const [path, text] of rewritten) await JsonStore.WriteTextAsync(repo.Root, path, text)
    await Ledger.RecordAsync(repo, [...rewritten.keys()].filter((path) => current.has(path) && !changed.has(path)))
    report.written = true
    return report
}
