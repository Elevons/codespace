import { Architecture } from './Architecture.ts'
import { Ledger } from './Ledger.ts'
import { SkippedSummary } from './Ingest.ts'
import type { Repo } from './Repo.ts'

/** What a sync changed. */
interface ISynced
{
    /** Entries carried to a new path, because the file was moved and its text is the same. */
    renamed: Array<{ from: string, to: string }>
    /** Entries dropped, for files and folders that are gone. */
    forgotten: string[]
    /** Described files stamped for the first time, which are taken as up to date as they stand. */
    stamped: number
}

/**
 * The housekeeping that needs no judgment, done before an update reads anything: an entry for a file that
 * was moved follows it (found by matching text), an entry for a file that is gone is dropped, and a file
 * that was described before the record existed is stamped as it stands. Run again, it changes nothing.
 * @param repo the repository
 */
export async function SyncAsync(repo: Repo): Promise<ISynced>
{
    const known = await repo.ListFilesAsync()
    const stale = await Architecture.StaleAsync(repo.Root, known)
    const architecture = await Architecture.ReadAsync(repo.Root, known)
    const record = await Ledger.ReadAsync(repo.Root)
    const result: ISynced = { renamed: [], forgotten: [], stamped: 0 }

    // A stale entry whose recorded text matches exactly one undescribed file is that file, moved.
    const staleStamped = stale.files.filter((path) => record[path] !== undefined)
    if (staleStamped.length > 0)
    {
        const undescribed = known.filter((path) => architecture.files[path]?.summary === undefined && SkippedSummary(path) === null)
        const byHash = new Map<string, string[]>()
        for (const path of undescribed)
        {
            const stamp = await Ledger.StampAsync(repo, path)
            if (stamp !== null) byHash.set(stamp.hash, [...(byHash.get(stamp.hash) ?? []), path])
        }
        const wanted = new Map<string, string[]>()
        for (const path of staleStamped) wanted.set(record[path]!.hash, [...(wanted.get(record[path]!.hash) ?? []), path])
        for (const [hash, from] of wanted)
        {
            const to = byHash.get(hash) ?? []
            if (from.length === 1 && to.length === 1) result.renamed.push({ from: from[0]!, to: to[0]! })
        }
    }

    const moved = new Set(result.renamed.map((move) => move.from))
    const gone = [...stale.files.filter((path) => !moved.has(path)), ...stale.folders]
    if (result.renamed.length > 0 || gone.length > 0)
    {
        await Architecture.UpdateAsync(repo.Root, known, { renames: result.renamed, forget: gone })
        result.forgotten = gone
    }

    // The record forgets files that are gone, and carries the moved ones along.
    const present = new Set(known)
    const dropped = Object.keys(record).filter((path) => !present.has(path) && !moved.has(path))
    if (result.renamed.length > 0 || dropped.length > 0) await Ledger.ForgetAsync(repo.Root, result.renamed, dropped)

    // Anything described before there was a record is taken as current now.
    const unstamped = Object.keys(architecture.files).filter((path) => architecture.files[path]!.summary !== undefined && record[path] === undefined && SkippedSummary(path) === null && !moved.has(path))
    if (unstamped.length > 0)
    {
        await Ledger.RecordAsync(repo, unstamped)
        result.stamped = unstamped.length
    }
    return result
}
