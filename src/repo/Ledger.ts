import { createHash } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Repo } from './Repo.ts'

/** Where the record of what each description was based on lives, relative to the repository root. */
const LedgerPath = '.codespace/ingested.json'

/** What a file looked like when its entry was last written or confirmed. */
export interface IStamp
{
    /** A hash of its text. */
    hash: string
    /** Its size in bytes, so a file whose size and time have not moved is not read again. */
    size: number
    /** Its modification time, in milliseconds. */
    mtime: number
}

/** Changes wait their turn, so two at once cannot read the same file and overwrite each other. */
let writeQueue: Promise<unknown> = Promise.resolve()

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
            const parsed: unknown = JSON.parse(await readFile(join(root, LedgerPath), 'utf8'))
            const files = (parsed as { files?: unknown } | null)?.files
            if (typeof files !== 'object' || files === null || Array.isArray(files)) return {}
            const result: Record<string, IStamp> = {}
            for (const [path, raw] of Object.entries(files))
            {
                const stamp = raw as Partial<IStamp> | null
                if (typeof stamp?.hash === 'string' && typeof stamp.size === 'number' && typeof stamp.mtime === 'number') result[path] = { hash: stamp.hash, size: stamp.size, mtime: stamp.mtime }
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
     * Finds the described files whose text is no longer what their entry was written from. A file whose
     * size and time have not moved is not read; one that was only touched is read and found unchanged.
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
            if (now !== null && (now.size !== before.size || now.mtime !== before.mtime) && now.hash !== before.hash) changed.push(path)
        }))
        return changed.sort()
    }

    /**
     * A file's hash, size, and time as they are now, or null when it cannot be read.
     * @param repo the repository
     * @param path the repository-relative path
     */
    public static async StampAsync(repo: Repo, path: string): Promise<IStamp | null>
    {
        try
        {
            const [text, info] = await Promise.all([repo.ReadFileAsync(path), stat(join(repo.Root, path))])
            return { hash: createHash('sha1').update(text).digest('hex'), size: info.size, mtime: info.mtimeMs }
        }
        catch { return null }
    }

    /** Reads the record, lets a change edit it, and writes it back whole, one change at a time. */
    private static ChangeAsync(root: string, change: (files: Record<string, IStamp>) => Promise<void>): Promise<void>
    {
        const run = async (): Promise<void> =>
        {
            const files = await Ledger.ReadAsync(root)
            await change(files)
            const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1)))
            await mkdir(join(root, '.codespace'), { recursive: true })
            const target = join(root, LedgerPath)
            const temporary = `${target}.${process.pid}.tmp`
            await writeFile(temporary, JSON.stringify({ files: sorted }, null, 1) + '\n', 'utf8')
            await rename(temporary, target)
        }
        const result = writeQueue.then(run, run)
        writeQueue = result.catch(() => undefined)
        return result
    }
}
