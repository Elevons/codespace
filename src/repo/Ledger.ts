import { createHash } from 'node:crypto'
import { LedgerPath, JsonStore } from './JsonStore.ts'
import type { Repo } from './Repo.ts'

/** What a file looked like when its entry was last written or confirmed. */
interface IStamp
{
    /** A hash of its text, which is all the record needs to tell a rewrite from an edit. */
    hash: string
}

/** Which file texts a design entry was written from: a file path to its hash, for each operation and each data entry. */
export interface IConceptStamps
{
    operations: Record<string, Record<string, string>>
    data: Record<string, Record<string, string>>
}

interface ILedger
{
    files: Record<string, IStamp>
    concepts: IConceptStamps
}

/**
 * The record of what each file looked like when its entry was written, so a later pass can tell which
 * descriptions have gone stale because the file changed, and which entries belong to a file that was
 * only moved. It sits beside the architecture file and holds nothing the map draws.
 */
export class Ledger
{
    /**
     * Reads the record. A repository that was never ingested has none.
     * @param root the repository's real path
     */
    public static async ReadAsync(root: string): Promise<Record<string, IStamp>>
    {
        return (await Ledger.ReadAllAsync(root)).files
    }

    /**
     * Reads what each operation and data entry was written from. An entry with no record was written
     * before the record existed, and counts as current.
     * @param root the repository's real path
     */
    public static async ReadConceptsAsync(root: string): Promise<IConceptStamps>
    {
        return (await Ledger.ReadAllAsync(root)).concepts
    }

    /**
     * Stamps the files each design entry names, as they are now, because the entry was just written.
     * @param repo the repository
     * @param entries the operations and data entries written, with the files each names
     */
    public static RecordConceptsAsync(repo: Repo, entries: ReadonlyArray<{ kind: 'operations' | 'data', name: string, files: readonly string[] }>): Promise<void>
    {
        return Ledger.ChangeAsync(repo.Root, async (ledger) =>
        {
            for (const { kind, name, files } of entries)
            {
                const stamps: Record<string, string> = {}
                for (const path of files)
                {
                    const stamp = await Ledger.StampAsync(repo, path)
                    if (stamp !== null) stamps[path] = stamp.hash
                }
                ledger.concepts[kind][name] = stamps
            }
        })
    }

    /**
     * Drops the records of design entries that were removed.
     * @param root the repository's real path
     * @param kind which kind of entry
     * @param names the removed entries
     */
    public static ForgetConceptsAsync(root: string, kind: 'operations' | 'data', names: readonly string[]): Promise<void>
    {
        return Ledger.ChangeAsync(root, async (ledger) => { for (const name of names) delete ledger.concepts[kind][name] })
    }

    /**
     * The hash of each file as it is now; files that cannot be read are left out.
     * @param repo the repository
     * @param paths the files to hash
     */
    public static async HashesAsync(repo: Repo, paths: Iterable<string>): Promise<Map<string, string>>
    {
        const hashes = new Map<string, string>()
        await Promise.all([...new Set(paths)].map(async (path) =>
        {
            const stamp = await Ledger.StampAsync(repo, path)
            if (stamp !== null) hashes.set(path, stamp.hash)
        }))
        return hashes
    }

    private static async ReadAllAsync(root: string): Promise<ILedger>
    {
        const result: ILedger = { files: {}, concepts: { operations: {}, data: {} } }
        try
        {
            const text = await JsonStore.ReadAsync(root, LedgerPath)
            if (text === null) return result
            const parsed = JSON.parse(text) as { files?: unknown, concepts?: unknown } | null
            const files = parsed?.files
            if (typeof files === 'object' && files !== null && !Array.isArray(files))
                for (const [path, raw] of Object.entries(files))
                {
                    const stamp = raw as Partial<IStamp> | null
                    if (typeof stamp?.hash === 'string') result.files[path] = { hash: stamp.hash }
                }
            const concepts = parsed?.concepts as Record<string, unknown> | null | undefined
            for (const kind of ['operations', 'data'] as const)
            {
                const section = concepts?.[kind]
                if (typeof section !== 'object' || section === null || Array.isArray(section)) continue
                for (const [name, raw] of Object.entries(section))
                {
                    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) continue
                    const stamps: Record<string, string> = {}
                    for (const [path, hash] of Object.entries(raw)) if (typeof hash === 'string') stamps[path] = hash
                    result.concepts[kind][name] = stamps
                }
            }
            return result
        }
        catch { return result }
    }

    /**
     * Stamps files as they are now, because an entry was just written for them or confirmed.
     * @param repo the repository
     * @param paths the files to stamp; any that cannot be read are skipped
     */
    public static RecordAsync(repo: Repo, paths: readonly string[]): Promise<void>
    {
        return Ledger.ChangeAsync(repo.Root, async ({ files }) =>
        {
            for (const path of paths)
            {
                const stamp = await Ledger.StampAsync(repo, path)
                if (stamp !== null) files[path] = stamp
            }
        })
    }

    /**
     * Moves or removes records, for files that were renamed or are gone.
     * @param root the repository's real path
     * @param moves records to carry to a new path
     * @param forget records to drop
     */
    public static ForgetAsync(root: string, moves: ReadonlyArray<{ from: string, to: string }>, forget: readonly string[]): Promise<void>
    {
        return Ledger.ChangeAsync(root, async ({ files, concepts }) =>
        {
            for (const { from, to } of moves) if (files[from] !== undefined) { files[to] = files[from]!; delete files[from] }
            for (const path of forget) delete files[path]
            for (const section of [concepts.operations, concepts.data])
                for (const stamps of Object.values(section))
                {
                    for (const { from, to } of moves) if (stamps[from] !== undefined) { stamps[to] = stamps[from]!; delete stamps[from] }
                    for (const path of forget) delete stamps[path]
                }
        })
    }

    /**
     * Finds the described files whose text is no longer what their entry was written from. Each file's
     * text is read and hashed, and a file whose hash has not moved is unchanged.
     * @param repo the repository
     * @param record what each file looked like when it was described
     * @param paths the files to check
     */
    public static async ChangedAsync(repo: Repo, record: Readonly<Record<string, IStamp>>, paths: readonly string[]): Promise<string[]>
    {
        const changed: string[] = []
        await Promise.all(paths.map(async (path) =>
        {
            const before = record[path]
            if (before === undefined) return
            const now = await Ledger.StampAsync(repo, path)
            if (now !== null && now.hash !== before.hash) changed.push(path)
        }))
        return changed.sort()
    }

    /**
     * A file's hash as it is now, or null when it cannot be read.
     * @param repo the repository
     * @param path the repository-relative path
     */
    public static async StampAsync(repo: Repo, path: string): Promise<IStamp | null>
    {
        try
        {
            const text = await repo.ReadFileAsync(path)
            return { hash: createHash('sha1').update(text).digest('hex') }
        }
        catch { return null }
    }

    /** Reads the record, lets a change edit it, and writes it back whole, one change at a time. */
    private static ChangeAsync(root: string, change: (ledger: ILedger) => Promise<void>): Promise<void>
    {
        return JsonStore.RunAsync(root, async () =>
        {
            const ledger = await Ledger.ReadAllAsync(root)
            await change(ledger)
            const sort = <T>(record: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)))
            const hasConcepts = Object.keys(ledger.concepts.operations).length + Object.keys(ledger.concepts.data).length > 0
            const body: Record<string, unknown> = { files: sort(ledger.files) }
            if (hasConcepts)
                body.concepts = { operations: sort(ledger.concepts.operations), data: sort(ledger.concepts.data) }
            await JsonStore.WriteAsync(root, LedgerPath, JSON.stringify(body, null, 1) + '\n')
        })
    }
}
