import { createHash } from 'node:crypto'
import { LedgerPath, JsonStore } from './JsonStore.ts'
import type { Repo } from './Repo.ts'

/** What a file looked like when its entry was last written or confirmed. */
interface IStamp
{
    /** A hash of its text, which is all the record needs to tell a rewrite from an edit. */
    hash: string
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
        try
        {
            const text = await JsonStore.ReadAsync(root, LedgerPath)
            if (text === null) return {}
            const parsed: unknown = JSON.parse(text)
            const files = (parsed as { files?: unknown } | null)?.files
            if (typeof files !== 'object' || files === null || Array.isArray(files)) return {}
            const result: Record<string, IStamp> = {}
            for (const [path, raw] of Object.entries(files))
            {
                const stamp = raw as Partial<IStamp> | null
                if (typeof stamp?.hash === 'string') result[path] = { hash: stamp.hash }
            }
            return result
        }
        catch { return {} }
    }

    /**
     * Stamps files as they are now, because an entry was just written for them or confirmed.
     * @param repo the repository
     * @param paths the files to stamp; any that cannot be read are skipped
     */
    public static RecordAsync(repo: Repo, paths: readonly string[]): Promise<void>
    {
        return Ledger.ChangeAsync(repo.Root, async (files) =>
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
        return Ledger.ChangeAsync(root, async (files) =>
        {
            for (const { from, to } of moves) if (files[from] !== undefined) { files[to] = files[from]!; delete files[from] }
            for (const path of forget) delete files[path]
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
    private static ChangeAsync(root: string, change: (files: Record<string, IStamp>) => Promise<void>): Promise<void>
    {
        return JsonStore.RunAsync(root, async () =>
        {
            const files = await Ledger.ReadAsync(root)
            await change(files)
            const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
            await JsonStore.WriteAsync(root, LedgerPath, JSON.stringify({ files: sorted }, null, 1) + '\n')
        })
    }
}
