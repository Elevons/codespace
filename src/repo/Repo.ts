import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'

/** VCS folders a code map never walks, whatever the repository says. */
const VcsSegments = new Set(['.git', '.hg', '.svn'])

/** The folders skipped when the repository has no .gitignore of its own. */
const DefaultExcluded = new Set([
    'node_modules', 'dist', 'build', 'out', 'coverage', 'logs',
    '.next', '.nuxt', 'target', 'vendor', '.cache', '.venv', '__pycache__', '.idea',
    '.vscode', '.trail', '.claude', '.turbo', '.parcel-cache', '.pytest_cache', 'tmp',
])

/** Generated paths skipped when the repository has no .gitignore of its own. */
const DefaultExcludedPaths = new Set(['public/vectors/chunks.json'])

/** The file types the map can read and show. */
const TextExtensions = new Set([
    '.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs',
    '.json', '.jsonc', '.md', '.mdx', '.css', '.scss', '.sass', '.less',
    '.html', '.htm', '.yml', '.yaml', '.toml', '.xml', '.txt',
    '.sh', '.bash', '.zsh', '.py', '.rb', '.go', '.rs', '.java', '.kt', '.kts',
    '.swift', '.cs', '.c', '.h', '.cc', '.cpp', '.hpp', '.php', '.sql', '.vue',
    '.svelte', '.graphql', '.gql', '.proto', '.ex', '.exs', '.erl', '.clj', '.lua',
    '.r', '.jl', '.dart', '.scala', '.tf', '.hcl', '.ini',
])

/** One line of a .gitignore, compiled to a matcher. */
interface IIgnoreRule
{
    /** The pattern as a regular expression, anchored to a full name or path. */
    pattern: RegExp
    /** Whether the pattern names a path (it has a slash) or a bare name. */
    byPath: boolean
    /** Whether the rule re-includes what it matches. */
    negated: boolean
}

/** Turns a gitignore glob into an anchored regular expression. */
function globToRegExp(glob: string): RegExp
{
    let out = '^'
    for (let index = 0; index < glob.length; index++)
    {
        const ch = glob[index]!
        if (ch === '*')
        {
            if (glob[index + 1] === '*') { out += '.*'; index++ }
            else out += '[^/]*'
        }
        else if (ch === '?') out += '[^/]'
        else out += ch.replace(/[.^$+{}()|[\]\\]/g, '\\$&')
    }
    return new RegExp(out + '$')
}

/** Reads the rules of one .gitignore file. */
function parseGitignore(text: string): IIgnoreRule[]
{
    const rules: IIgnoreRule[] = []
    for (const raw of text.split('\n'))
    {
        let line = raw.trim()
        if (line === '' || line.startsWith('#')) continue
        let negated = false
        if (line.startsWith('!')) { negated = true; line = line.slice(1) }
        if (line.startsWith('/')) line = line.slice(1)
        if (line.endsWith('/')) line = line.slice(0, -1)
        if (line === '') continue
        rules.push({ pattern: globToRegExp(line), byPath: line.includes('/'), negated })
    }
    return rules
}

/** One repository that the map reads from. */
export class Repo
{
    /** The repository's real, absolute path. */
    public readonly Root: string

    /** The repository's display name, its folder name. */
    public readonly Name: string

    /** The repository's own ignore rules, or empty when it keeps none. */
    private readonly ignoreRules: readonly IIgnoreRule[]

    /**
     * Opens one repository.
     * @param root the folder to read
     * @param ignoreRules the repository's own ignore rules
     */
    private constructor(root: string, ignoreRules: readonly IIgnoreRule[])
    {
        this.Root = root
        this.Name = root.split(sep).filter(Boolean).pop() ?? root
        this.ignoreRules = ignoreRules
    }

    /**
     * Resolves a folder to a repository.
     * @param root the folder to read
     */
    public static async OpenAsync(root: string): Promise<Repo>
    {
        // First we resolve the folder's real path, so a symlink cannot escape it later.
        const real = await realpath(resolve(root))

        // Then we check that it is a folder.
        const info = await stat(real)
        if (!info.isDirectory()) throw new Error(`${root} is not a folder`)

        // Then we read the repository's own ignore list, so the map shows what git keeps.
        let ignoreRules: IIgnoreRule[] = []
        try { ignoreRules = parseGitignore(await readFile(join(real, '.gitignore'), 'utf8')) }
        catch { /* no .gitignore: the built-in defaults stand in */ }

        return new Repo(real, ignoreRules)
    }

    /**
     * Lists every readable text file in the repository, relative to its root.
     */
    public async ListFilesAsync(): Promise<string[]>
    {
        const files: string[] = []
        await this.CollectAsync(this.Root, '', files)
        files.sort()
        return files
    }

    /**
     * Reads one file inside the repository.
     * @param relativePath the repository-relative path
     */
    public async ReadFileAsync(relativePath: string): Promise<string>
    {
        // First we reject a path that would leave the repository or name an excluded subtree.
        if (!this.IsAllowed(relativePath)) throw new Error('Forbidden')

        // Then we resolve the file's real path, so a symlink inside the tree cannot point out of it.
        const real = await realpath(join(this.Root, relativePath))
        if (real !== this.Root && !real.startsWith(this.Root + sep)) throw new Error('Forbidden')

        // Finally we read the file as text.
        return readFile(real, 'utf8')
    }

    /**
     * Reports whether a repository-relative path is a readable text file inside the repository.
     * @param relativePath the repository-relative path
     */
    public IsAllowed(relativePath: string): boolean
    {
        if (relativePath === '' || relativePath.includes('\0')) return false

        const resolved = resolve(this.Root, relativePath)
        const inside = resolved === this.Root || resolved.startsWith(this.Root + sep)
        if (!inside) return false

        const path = relative(this.Root, resolved).split(sep).join('/')
        if (this.IsIgnored(path)) return false

        return TextExtensions.has(extname(resolved).toLowerCase())
    }

    /**
     * Reports whether the repository's own rules, or the built-in defaults, hide one path.
     * @param relativePath the repository-relative path, with forward slashes
     */
    private IsIgnored(relativePath: string): boolean
    {
        const parts = relativePath.split('/')
        if (parts.some((part) => VcsSegments.has(part))) return true

        // With no .gitignore of its own, the repository falls back to the built-in list.
        if (this.ignoreRules.length === 0)
        {
            if (parts.some((part) => DefaultExcluded.has(part))) return true
            return DefaultExcludedPaths.has(relativePath)
        }

        // Otherwise the repository's own rules decide, last match winning.
        const name = parts[parts.length - 1]!
        let ignored = false
        for (const rule of this.ignoreRules)
        {
            const matched = rule.byPath ? rule.pattern.test(relativePath) : rule.pattern.test(name)
            if (matched) ignored = !rule.negated
        }
        return ignored
    }

    /**
     * Adds every readable file under one folder, and its subfolders, to a list.
     * @param absoluteDir the folder's real path
     * @param relativeDir the folder's path relative to the repository
     * @param files the list to fill
     */
    private async CollectAsync(absoluteDir: string, relativeDir: string, files: string[]): Promise<void>
    {
        // First we read the folder's entries.
        const entries = await readdir(absoluteDir, { withFileTypes: true })

        // Then we walk each one.
        for (const entry of entries)
        {
            const path = relativeDir === '' ? entry.name : relativeDir + '/' + entry.name
            if (this.IsIgnored(path)) continue

            // A folder is walked; a readable file is kept.
            if (entry.isDirectory())
            {
                await this.CollectAsync(join(absoluteDir, entry.name), path, files)
                continue
            }

            if (entry.isFile() && TextExtensions.has(extname(entry.name).toLowerCase())) files.push(path)
        }
    }
}
