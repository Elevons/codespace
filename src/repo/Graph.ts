import { dirname, posix } from 'node:path'
import { TS_JS_FILE } from '../../public/symbols.ts'
import type { Repo } from './Repo.ts'

/** The files whose imports are read as C#, by namespace. */
const CSharpFile = /\.cs$/

/** The largest file read for its imports, in characters. */
const MaxImportScanChars = 400_000

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
     * @param files the repository's files, when the caller has already listed them
     * @param read how to read one file, when the caller has already read them
     */
    public static async BuildAsync(
        repo: Repo,
        files?: readonly string[],
        read: (path: string) => Promise<string> = (path) => repo.ReadFileAsync(path),
    ): Promise<Graph>
    {
        files ??= await repo.ListFilesAsync()
        const known = new Set(files)
        const imports = new Map<string, string[]>()

        // C# imports name namespaces, not files, so first we index which files declare each one
        // and which namespaces each file uses, reading every C# file once for both.
        const declared = new Map<string, string[]>()
        const csharpUses = new Map<string, string[]>()
        for (const path of files)
        {
            if (!CSharpFile.test(path)) continue
            const text = (await read(path).catch(() => '')).slice(0, MaxImportScanChars)
            csharpUses.set(path, Graph.CSharpUses(text))
            const namespace = Graph.CSharpNamespace(text)
            if (namespace !== null) declared.set(namespace, [...(declared.get(namespace) ?? []), path])
        }

        for (const path of files)
        {
            const targets = new Set<string>()
            if (CSharpFile.test(path))
            {
                // A C# file imports every file that declares a namespace it names.
                for (const namespace of csharpUses.get(path) ?? [])
                    for (const target of declared.get(namespace) ?? []) if (target !== path) targets.add(target)
            }
            else if (TS_JS_FILE.test(path))
            {
                const text = await read(path).catch(() => '')
                for (const specifier of Graph.ParseSpecifiers(text.slice(0, MaxImportScanChars)))
                {
                    const folder = dirname(path) === '.' ? '' : dirname(path)
                    const target = Graph.Resolve(posix.join(folder, specifier), known)
                    if (target !== null && target !== path) targets.add(target)
                }
            }
            else continue
            imports.set(path, [...targets].sort())
        }
        return new Graph(imports)
    }

    /**
     * Lists what one file imports, among the repository's files.
     * @param path the importing file
     */
    public ImportsOf(path: string): string[]
    {
        return [...(this.imports.get(path) ?? [])]
    }

    /**
     * Lists every import between two files.
     * @returns each import as the importing file and the imported one
     */
    public Edges(): Array<[string, string]>
    {
        const edges: Array<[string, string]> = []
        for (const [from, targets] of this.imports) for (const to of targets) edges.push([from, to])
        return edges
    }

    /**
     * Narrows a list of imports to the ones that touch a folder.
     * @param edges each import, as the importing file and the imported one
     * @param folder when given, only imports where either file is under this folder
     */
    public static EdgesUnder(edges: ReadonlyArray<[string, string]>, folder = ''): Array<[string, string]>
    {
        if (folder === '') return [...edges]
        const prefix = folder.replace(/\/+$/, '') + '/'
        return edges.filter(([from, to]) => from.startsWith(prefix) || to.startsWith(prefix))
    }

    /**
     * Reads the namespace a C# file declares, or null when it declares none.
     * @param text the source text
     */
    private static CSharpNamespace(text: string): string | null
    {
        const match = /\bnamespace\s+([A-Za-z_][\w.]*)/.exec(text)
        return match === null ? null : match[1]!
    }

    /**
     * Reads every namespace a C# file names in a `using` directive: plain, `static`, `global`,
     * or an alias, where the right-hand namespace is the one that matters.
     * @param text the source text
     */
    private static CSharpUses(text: string): string[]
    {
        const uses = new Set<string>()
        const pattern = /\busing\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*(?:=\s*([A-Za-z_][\w.]*))?\s*;/g
        for (const match of text.matchAll(pattern)) uses.add(match[2] ?? match[1]!)
        return [...uses]
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
    /**
     * Resolves one import specifier, written in a file, to the file it names, when the repository holds it.
     * @param fromPath the importing file
     * @param specifier the specifier as written, such as './Helper.ts'
     * @param known the repository's file paths
     */
    public static ResolveImport(fromPath: string, specifier: string, known: ReadonlySet<string>): string | null
    {
        const folder = dirname(fromPath) === '.' ? '' : dirname(fromPath)
        return Graph.Resolve(posix.join(folder, specifier), known)
    }

    /** Resolves one path against the repository's files, trying the usual source extensions. */
    private static Resolve(resolved: string, known: ReadonlySet<string>): string | null
    {
        const base = posix.normalize(resolved)
        const candidates = [
            base, base + '.ts', base + '.mts', base + '.cts',
            base.replace(/\.mjs$/, '.mts'), base.replace(/\.cjs$/, '.cts'), base.replace(/\.[cm]?js$/, '.ts'),
            base + '.tsx', base + '.js', base + '.jsx', base + '.mjs', base + '.cjs',
            base + '/index.ts', base + '/index.mts', base + '/index.cts', base + '/index.tsx', base + '/index.js', base + '/index.jsx',
        ]
        return candidates.find((candidate) => known.has(candidate)) ?? null
    }
}
