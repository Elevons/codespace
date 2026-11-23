import { mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import { Architecture, type IArchitecture } from './Architecture.ts'
import { IsInside } from './JsonStore.ts'
import { Ledger } from './Ledger.ts'
import type { Repo } from './Repo.ts'

/** The longest summary a new file may start with. */
export const MaxNewSummary = 400

/** A file to create, as the page's form or a tool sends it. */
export interface INewFile
{
    /** The repository-relative path of the new file. */
    path: string
    /** The one sentence about what the file is for; it opens the file as a comment and is its summary. */
    summary: string
    /** The layer the file goes on, which the architecture must already declare. */
    layer: string
    /** The system the file belongs to, which the architecture must already declare. */
    system?: string
    /** The file's tags. */
    tags?: string[]
}

/** What creating a file did. */
export interface ICreated
{
    /** The path of the file now on disk. */
    path: string
    /** The architecture as it now reads, with the new file's entry. */
    architecture: IArchitecture
    /** Things worth knowing that did not stop it. */
    notes: string[]
}

/** How each kind of file opens with its summary, by extension. A kind not listed opens with no comment. */
const Openers: Record<string, (summary: string, name: string) => string> = {}
const line = (marker: string) => (summary: string): string => `${marker} ${summary}\n`
for (const extension of ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.jsonc', '.scss', '.sass', '.less',
    '.go', '.rs', '.java', '.kt', '.kts', '.swift', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.dart', '.scala', '.proto'])
{
    Openers[extension] = line('//')
}
for (const extension of ['.py', '.rb', '.yml', '.yaml', '.toml', '.r', '.jl', '.ex', '.exs', '.tf', '.hcl', '.graphql', '.gql'])
{
    Openers[extension] = line('#')
}
for (const extension of ['.sql', '.lua']) Openers[extension] = line('--')
for (const extension of ['.ini']) Openers[extension] = line(';')
Openers['.clj'] = line(';;')
Openers['.erl'] = line('%')
for (const extension of ['.sh', '.bash', '.zsh'])
{
    Openers[extension] = (summary) => `#!/usr/bin/env ${extension === '.sh' ? 'sh' : extension.slice(1)}\n# ${summary}\n`
}
Openers['.php'] = (summary) => `<?php\n// ${summary}\n`
Openers['.css'] = (summary) => `/* ${summary} */\n`
for (const extension of ['.html', '.htm', '.xml', '.vue', '.svelte']) Openers[extension] = (summary) => `<!-- ${summary} -->\n`
for (const extension of ['.md', '.mdx']) Openers[extension] = (summary, name) => `# ${name}\n\n${summary}\n`
Openers['.txt'] = (summary) => `${summary}\n`
Openers['.json'] = () => '{}\n'

/**
 * The text a new file starts with: its summary as a comment in the file's own syntax, so the file
 * says what it is for before any code is written, as the block summaries read it.
 * @param path the new file's path
 * @param summary the one sentence about what it is for
 */
export function OpeningText(path: string, summary: string): string
{
    const extension = extname(path).toLowerCase()
    const opener = Openers[extension]
    const name = basename(path, extname(path))
    // A comment that ends early would cut the file short, so its own closing mark is kept out.
    const safe = summary.replace(/\*\//g, '* /').replace(/-->/g, '-- >').replace(/\r?\n/g, ' ')
    return opener === undefined ? '' : opener(safe, name)
}

/**
 * Tidies a path as typed: forward slashes, no leading "./" or "/", no doubled slashes.
 * @param path the path as typed
 */
export function NormalisePath(path: string): string
{
    return path.trim().replace(/\\/g, '/').replace(/^(\.\/|\/)+/, '').replace(/\/{2,}/g, '/')
}

/**
 * Creates one new file in the repository, opening with its summary, and writes its entry to the
 * architecture file in the same step. Either both happen or neither does: an entry the architecture
 * refuses takes the new file away again.
 * @param repo the repository to create it in
 * @param file the file to create
 */
export async function CreateFileAsync(repo: Repo, file: INewFile): Promise<ICreated>
{
    const path = NormalisePath(file.path)
    const summary = file.summary.trim()
    if (path === '' || path.endsWith('/')) throw new Error('Give the new file a path, with its name, such as "src/tools/Export.ts".')
    if (summary === '') throw new Error('Give the new file a summary: one sentence about what it is for.')
    if (summary.length > MaxNewSummary) throw new Error(`Keep the summary to ${MaxNewSummary} characters.`)
    if (file.layer.trim() === '') throw new Error('Choose the layer the new file goes on.')
    if (!repo.IsAllowed(path))
    {
        throw new Error(extname(path) === ''
            ? `"${path}" has no extension. Give the file a type the map can read, such as .ts, .py, or .md.`
            : `"${path}" is outside the repository, in a folder it ignores, or a type of file the map does not read.`)
    }

    // The folders are made first, and their real place checked, so a link inside the tree cannot carry the file out of it.
    const absolute = join(repo.Root, path)
    const folder = dirname(absolute)
    await mkdir(folder, { recursive: true })
    if (!IsInside(repo.Root, await realpath(folder))) throw new Error(`"${path}" would land outside the repository.`)

    // "wx" refuses a file that is already there, so nothing is ever overwritten.
    try { await writeFile(absolute, OpeningText(path, summary), { encoding: 'utf8', flag: 'wx' }) }
    catch (error) { throw (error as NodeJS.ErrnoException).code === 'EEXIST' ? new Error(`"${path}" already exists.`) : error }

    try
    {
        const entry = { summary, layer: file.layer, ...(file.system ? { system: file.system } : {}), tags: file.tags ?? [] }
        const updated = await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), { files: { [path]: entry } })
        await Ledger.RecordAsync(repo, [path])
        return { path, architecture: updated.architecture, notes: updated.notes }
    }
    catch (error)
    {
        await rm(absolute, { force: true })
        throw error
    }
}
