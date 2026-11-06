import { dirname, posix } from 'node:path'
import type { Repo } from './Repo.ts'

/** The files whose imports are read. */
const CodeFile = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/

/** The largest file read for its imports, in characters. */
const MaxFileChars = 400_000

/** The import graph between a repository's code files. */
export class Graph
{
    /** For each file, the files it imports. */
    private readonly imports: ReadonlyMap<string, readonly string[]>

    /**
     * Holds one graph.
     * @param imports for each file, the files it imports
     */
    private constructor(imports: ReadonlyMap<string, readonly string[]>)
    {
        this.imports = imports
    }

    /**
     * Reads the repository's code files and links the imports between them.
     * @param repo the repository to read
     */
    public static async BuildAsync(repo: Repo): Promise<Graph>
    {
        const files = await repo.ListFilesAsync()
        const known = new Set(files)
        const imports = new Map<string, string[]>()
        for (const path of files)
        {
            if (!CodeFile.test(path)) continue
            const text = await repo.ReadFileAsync(path).catch(() => '')
            const targets = new Set<string>()
            for (const specifier of Graph.ParseSpecifiers(text.slice(0, MaxFileChars)))
            {
                const folder = dirname(path) === '.' ? '' : dirname(path)
                const target = Graph.Resolve(posix.join(folder, specifier), known)
                if (target !== null && target !== path) targets.add(target)
            }
            imports.set(path, [...targets].sort())
        }
        return new Graph(imports)
    }

    /**
     * Lists every import between two files.
     * @param folder when given, only imports where either file is under this folder
     * @returns each import as the importing file and the imported one
     */
    public Edges(folder = ''): Array<[string, string]>
    {
        const prefix = folder === '' ? '' : folder.replace(/\/+$/, '') + '/'
        const edges: Array<[string, string]> = []
        for (const [from, targets] of this.imports)
        {
            for (const to of targets) if (from.startsWith(prefix) || to.startsWith(prefix)) edges.push([from, to])
        }
        return edges
    }

    /**
     * Reads every relative module specifier a source file names, from `import ... from`,
     * `export ... from`, and bare `import '...'` lines.
     * @param text the source text
     */
    private static ParseSpecifiers(text: string): string[]
    {
        const specifiers: string[] = []
        const patterns = [
            /(?:^|\n)[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g,
            /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g,
        ]
        for (const pattern of patterns)
        {
            for (const match of text.matchAll(pattern)) if (match[1]!.startsWith('.')) specifiers.push(match[1]!)
        }
        return specifiers
    }

    /**
     * Finds the file a specifier names: as written, or with the extension or index file it leaves off.
     * @param resolved the specifier joined onto the importing file's folder
     * @param known every file in the repository
     */
    private static Resolve(resolved: string, known: ReadonlySet<string>): string | null
    {
        const base = posix.normalize(resolved)
        const candidates = [
            base, base + '.ts', base.replace(/\.[cm]?js$/, '.ts'), base + '.tsx', base + '.js', base + '.jsx',
            base + '.mjs', base + '.cjs', base + '/index.ts', base + '/index.tsx', base + '/index.js', base + '/index.jsx',
        ]
        return candidates.find((candidate) => known.has(candidate)) ?? null
    }
}
