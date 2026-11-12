import ts from 'typescript'
import { TS_JS_FILE } from '../../public/symbols.ts'
import { shortSummary, type BlockInfo, type BlockKind, type IBlocksReport } from '../../public/blocks.ts'

/** A function longer than this is cut into the sections its comments lead. */
const LongFunction = 40

/** The most sections a long function is cut into before it is left whole. */
const MaxSections = 10

/** The most references one block lists to the file's other blocks. */
const MaxRefs = 8

/** A generic name a grouped block gets, such as "6 types", rather than one declaration's name. */
const GenericName = /^\d+ (constants|types)$/

/**
 * Reads the blocks a file is made of: its imports, its groups of constants and types, each
 * function and class, and the commented sections inside a long one. TypeScript and JavaScript
 * are read with the TypeScript parser, so braces in strings and comments cannot fool it; every
 * other language falls back to a line scan of its top-level declarations.
 */
export class Blocks
{
    /**
     * Reads one file's blocks.
     * @param path the file's repository-relative path, which picks the parser
     * @param text the file's text
     */
    public static Read(path: string, text: string): IBlocksReport
    {
        const blocks = TS_JS_FILE.test(path) ? ScriptBlocks(text, path) : LineBlocks(text, path)
        AddReferences(text, blocks)
        return { path, lines: text.split('\n').length, blocks }
    }
}

/** A line as a reader counts it, starting at 1. */
function LineOf(source: ts.SourceFile, position: number): number
{
    return source.getLineAndCharacterOfPosition(position).line + 1
}

/** The line a node ends on, counting the last character it holds rather than the one after it. */
function EndLineOf(source: ts.SourceFile, node: ts.Node): number
{
    return LineOf(source, Math.max(node.getStart(source), node.getEnd() - 1))
}

/** Why a run of statements is grouped into one block, or null when it is not grouped. */
function Family(node: ts.Statement): 'import' | 'constant' | 'type' | null
{
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return 'import'
    if (ts.isVariableStatement(node)) return 'constant'
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return 'type'
    return null
}

/** The names a statement declares, for the block that groups it. */
function NamesOf(node: ts.Statement, source: ts.SourceFile): string[]
{
    if (ts.isImportDeclaration(node)) return [node.moduleSpecifier.getText(source).replace(/^['"]|['"]$/g, '')]
    if (ts.isImportEqualsDeclaration(node)) return [node.name.text]
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((declaration) => declaration.name.getText(source))
    if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node)) return [node.name.text]
    return []
}

/** The blocks of a TypeScript or JavaScript file. */
function ScriptBlocks(text: string, path: string): BlockInfo[]
{
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true)
    const statements = [...source.statements]
    const blocks: BlockInfo[] = []
    let index = 0

    while (index < statements.length)
    {
        const node = statements[index]
        const family = Family(node)

        // A run of imports, constants, or types reads as one block, so a file's four thresholds
        // are one floor, not four slivers.
        if (family !== null)
        {
            const group: ts.Statement[] = [node]
            let next = index + 1
            while (next < statements.length && Family(statements[next]) === family) group.push(statements[next++])
            blocks.push(GroupBlock(text, source, group, family))
            index = next
            continue
        }

        if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name !== undefined)
        {
            const name = node.name.text
            const line = LineOf(source, node.getStart(source))
            const endLine = EndLineOf(source, node)
            const kind: BlockKind = ts.isClassDeclaration(node) ? 'class' : 'function'
            const written = CommentAbove(text, line)
            blocks.push({
                name, kind, line, endLine, depth: 0,
                summary: written.summary !== '' ? written.summary : FallbackSummary(kind, name, endLine - line + 1),
                fromComment: written.summary !== '',
                refs: [],
            })
            if (endLine - line + 1 > LongFunction) blocks.push(...SectionsOf(text, source, name, node))
        }

        index++
    }

    return blocks
}

/** One block for a run of statements that declare the same kind of thing. */
function GroupBlock(text: string, source: ts.SourceFile, group: ts.Statement[], family: 'import' | 'constant' | 'type'): BlockInfo
{
    const names = group.flatMap((node) => NamesOf(node, source))
    const line = LineOf(source, group[0].getStart(source))
    const endLine = EndLineOf(source, group[group.length - 1])
    const kind: BlockKind = family
    const name = family === 'import' ? 'imports' : names.length === 1 ? names[0] : `${names.length} ${family === 'constant' ? 'constants' : 'types'}`
    const written = CommentAbove(text, line)
    const summary = written.summary !== ''
        ? written.summary
        : family === 'import'
            ? `The ${names.length === 1 ? 'module' : names.length + ' modules'} this file uses.`
            : `${family === 'constant' ? 'Constants' : 'Types'}: ${names.join(', ')}.`
    return { name, kind, line, endLine, depth: 0, summary, fromComment: written.summary !== '', members: names, refs: [] }
}

/** The commented sections of a long function, or its named members when it is a long class. */
function SectionsOf(text: string, source: ts.SourceFile, parent: string, node: ts.FunctionDeclaration | ts.ClassDeclaration): BlockInfo[]
{
    return ts.isClassDeclaration(node) ? ClassSections(text, source, parent, node) : FunctionSections(text, source, parent, node)
}

/** The members of a long class, one block each, so a file written as one class still opens up. */
function ClassSections(text: string, source: ts.SourceFile, parent: string, node: ts.ClassDeclaration): BlockInfo[]
{
    const members = node.members.filter((member) =>
        ts.isMethodDeclaration(member) || ts.isPropertyDeclaration(member) ||
        ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member) || ts.isConstructorDeclaration(member))
    if (members.length < 2 || members.length > MaxSections) return []
    return members.map((member) =>
    {
        const name = member.name === undefined ? 'constructor' : member.name.getText(source)
        const line = LineOf(source, member.getStart(source))
        const written = CommentAbove(text, line)
        return {
            name, kind: 'section' as BlockKind, line: line - written.lines, endLine: EndLineOf(source, member),
            depth: 1, parent,
            summary: written.summary !== '' ? written.summary : `The ${name} member of ${parent}.`,
            fromComment: written.summary !== '', refs: [],
        }
    })
}

/** The sections a long function's comments divide its body into. */
function FunctionSections(text: string, source: ts.SourceFile, parent: string, node: ts.FunctionDeclaration): BlockInfo[]
{
    const body = node.body
    if (body === undefined) return []
    const statements = [...body.statements]
    if (statements.length < 2) return []

    // A section starts at the first statement and at every statement a comment leads into.
    const starts = statements.map((statement, at) =>
    {
        const line = LineOf(source, statement.getStart(source))
        const written = CommentAbove(text, line)
        return { at, line, commentLines: written.lines, summary: written.summary }
    }).filter((start, at) => at === 0 || start.summary !== '')
    if (starts.length < 2 || starts.length > MaxSections) return []

    return starts.map((start, k) =>
    {
        const next = starts[k + 1]
        const last = next === undefined ? statements[statements.length - 1] : statements[next.at - 1]
        return {
            name: start.summary === '' ? `¶${k + 1}` : SectionName(start.summary, k),
            kind: 'section' as BlockKind,
            line: start.line - start.commentLines,
            endLine: EndLineOf(source, last),
            depth: 1,
            parent,
            summary: start.summary === '' ? `The ${k === 0 ? 'first' : 'next'} steps of ${parent}.` : start.summary,
            fromComment: start.summary !== '',
            refs: [],
        }
    })
}

/** A section's name: the first clause of its comment, short enough to sit on a floor. */
function SectionName(summary: string, at: number): string
{
    const clause = summary.split(/[.;:,]/)[0].trim()
    if (clause === '') return `¶${at + 1}`
    return shortSummary(clause, 48)
}

/** A block's summary when the source gives it no comment: a plain description of its shape. */
function FallbackSummary(kind: BlockKind, name: string, lines: number): string
{
    if (kind === 'function') return `${name}: a function of ${lines} lines.`
    if (kind === 'class') return `${name}: a class of ${lines} lines.`
    return `${name}: ${lines} lines.`
}

/** The comment lines that lead into the line, and the summary they make. */
function CommentAbove(text: string, line: number): { lines: number, summary: string }
{
    const all = text.split('\n')
    const gathered: string[] = []
    for (let at = line - 2; at >= 0; at--)
    {
        const trimmed = all[at].trim()
        if (trimmed === '' || IsComment(trimmed) === false) break
        gathered.unshift(trimmed)
    }
    return { lines: gathered.length, summary: CleanComment(gathered) }
}

/** Whether a trimmed line is a comment, in the shapes the map reads. */
function IsComment(line: string): boolean
{
    return /^(\/\/|#(?!\!)|<!--|\*|\/\*)/.test(line)
}

/** The prose a comment holds, without its markers, its tags, or its line breaks. */
function CleanComment(lines: string[]): string
{
    const kept: string[] = []
    for (const raw of lines)
    {
        const part = raw
            .replace(/^\/\/+\s?/, '')
            .replace(/^#+\s?/, '')
            .replace(/^\/\*+\s?/, '')
            .replace(/\*\/\s*$/, '')
            .replace(/^\*+\s?/, '')
            .trim()
        // JSDoc tags such as @param describe the code below; the sentence comes before them.
        if (/^@\w/.test(part)) break
        if (part !== '') kept.push(part)
    }
    return shortSummary(kept.join(' '), 200)
}

/** What a line scan can see of a declaration in a language TypeScript does not parse. */
const LineDeclaration = /^(?:export\s+)?(?:public\s+|private\s+|protected\s+|internal\s+|static\s+|async\s+|override\s+)*(function\*?|class|interface|struct|enum|impl|trait|func|fn|def|module|namespace|type)\s+([A-Za-z_$][\w$]*)|^(const|let|var)\s+([A-Za-z_$][\w$]*)|^([A-Z][A-Z0-9_]*)\s*=/

/** The blocks of any other text file, read from the declarations its top level starts. */
function LineBlocks(text: string, path: string): BlockInfo[]
{
    const lines = text.split('\n')
    const starts: { line: number, name: string, kind: BlockKind }[] = []
    lines.forEach((raw, at) =>
    {
        if (/^\s/.test(raw) || raw.trim() === '') return
        const match = LineDeclaration.exec(raw)
        if (match === null) return
        const keyword = match[1] ?? '', name = match[2] ?? match[4] ?? match[5] ?? ''
        const kind: BlockKind = keyword === '' ? 'constant'
            : /^(function|func|fn|def)$/.test(keyword) ? 'function'
            : /^(class|interface|struct|enum|impl|trait)$/.test(keyword) ? 'type'
            : 'declaration'
        starts.push({ line: at + 1, name, kind })
    })

    if (starts.length === 0)
    {
        const name = path.split('/').pop() ?? path
        return [{
            name, kind: 'declaration', line: 1, endLine: lines.length, depth: 0,
            summary: `The whole of ${name}.`, fromComment: false, refs: [],
        }]
    }

    return starts.map((start, at) =>
    {
        const next = starts[at + 1]
        const endLine = next === undefined ? lines.length : Math.max(start.line, next.line - 1)
        const written = CommentAbove(text, start.line)
        return {
            name: start.name, kind: start.kind, line: start.line, endLine, depth: 0,
            summary: written.summary !== '' ? written.summary : FallbackSummary(start.kind, start.name, endLine - start.line + 1),
            fromComment: written.summary !== '', refs: [],
        }
    })
}

/** Fills in which of the file's other blocks each block mentions. */
function AddReferences(text: string, blocks: BlockInfo[]): void
{
    const lines = text.split('\n')
    for (const block of blocks)
    {
        const words = new Set(lines.slice(block.line - 1, block.endLine).join('\n').match(/[A-Za-z_$][\w$]*/g) ?? [])
        const refs: string[] = []
        for (const other of blocks)
        {
            if (other === block || other.kind === 'import') continue
            // A block and the sections inside it use each other by definition, so they are not refs.
            if (other.parent === block.name || block.parent === other.name) continue
            const names = other.members !== undefined && GenericName.test(other.name) ? other.members : [other.name]
            const hit = names.find((name) => words.has(name))
            if (hit === undefined) continue
            // A run of sections all named by their comment still reads best by its first few words.
            if (refs.includes(hit) === false) refs.push(hit)
            if (refs.length >= MaxRefs) break
        }
        block.refs = refs
    }
}
