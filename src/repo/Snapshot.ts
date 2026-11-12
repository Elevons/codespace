import { CODE_FILE, symbolsOf } from '../../public/symbols.ts'
import { Graph } from './Graph.ts'
import type { Repo } from './Repo.ts'

/** The most files read at once, so a large repository does not open every file together. */
const ReadLimit = 16

/** The longest text scanned for declarations, in characters; the line count still covers the whole file. */
const MaxScanChars = 1_000_000

/** Everything the page needs to draw a repository, read in one pass. */
interface ISnapshot
{
    /** The change stamp the rest was read at. */
    fingerprint: string

    /** Each file's size and modified time, so the page can tell which files were edited. */
    stamps: Record<string, string>

    /** Every file the map can show, sorted. */
    files: string[]

    /** Each import, as the importing file and the imported one. */
    edges: Array<[string, string]>

    /** The line count of each scanned file. */
    lines: Record<string, number>

    /** The names each scanned file declares, for search; files that declare none are left out. */
    symbols: Record<string, string[]>
}

/** What was last read for each repository, kept until its files change. */
const Cache = new WeakMap<Repo, { fingerprint: string, snapshot: Promise<ISnapshot> }>()

/** Reads a repository once for the page, and again only when its files change. */
export class Snapshot
{
    /**
     * Reads the repository's files, imports, line counts, and declarations. A repository whose
     * change stamp has not moved answers from the last read, so a polling page costs a stat per file.
     * @param repo the repository to read
     */
    public static async ReadAsync(repo: Repo): Promise<ISnapshot>
    {
        const { files, fingerprint, stamps } = await repo.StampAsync()
        const cached = Cache.get(repo)
        if (cached !== undefined && cached.fingerprint === fingerprint) return cached.snapshot

        const snapshot = Snapshot.BuildAsync(repo, files, stamps, fingerprint)
        Cache.set(repo, { fingerprint, snapshot })
        // A failed read must not be remembered, or every later request would fail the same way.
        snapshot.catch(() => { if (Cache.get(repo)?.snapshot === snapshot) Cache.delete(repo) })
        return snapshot
    }

    /**
     * Reads every scanned file once, and shares that text between the line counts, the
     * declarations, and the import graph.
     * @param repo the repository to read
     * @param files the repository's files
     * @param stamps each file's own change stamp
     * @param fingerprint the change stamp over those files
     */
    private static async BuildAsync(repo: Repo, files: string[], stamps: Record<string, string>, fingerprint: string): Promise<ISnapshot>
    {
        const texts = new Map<string, string>()
        const queue = files.filter((path) => CODE_FILE.test(path))
        let next = 0
        const workers = Array.from({ length: Math.min(ReadLimit, queue.length) }, async () =>
        {
            while (next < queue.length)
            {
                const path = queue[next++]!
                // An unreadable file is simply shown, not scanned.
                try { texts.set(path, await repo.ReadFileAsync(path)) }
                catch { /* left out */ }
            }
        })
        await Promise.all(workers)

        const lines: Record<string, number> = {}
        const symbols: Record<string, string[]> = {}
        for (const [path, text] of texts)
        {
            lines[path] = text.split('\n').length
            const found = symbolsOf(text.slice(0, MaxScanChars))
            const names = [...found.functions, ...found.classes, ...found.interfaces, ...found.variables].map((item) => item.name)
            if (names.length > 0) symbols[path] = names
        }

        const graph = await Graph.BuildAsync(repo, files, (path) => texts.has(path) ? Promise.resolve(texts.get(path)!) : repo.ReadFileAsync(path))
        return { fingerprint, files, stamps, edges: graph.Edges(), lines, symbols }
    }
}
