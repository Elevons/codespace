import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, sep } from 'node:path'

/** The folder Codespace writes its own files into, relative to the repository root. */
export const CodespaceFolder = '.codespace'

/** Where a repository's architecture file lives, relative to its root. */
export const ArchitecturePath = `${CodespaceFolder}/architecture.json`

/** Where the record of what each description was based on lives, relative to the repository root. */
export const LedgerPath = `${CodespaceFolder}/ingested.json`

/** The full upkeep rules `install` leaves beside the architecture file. */
export const GuidePath = `${CodespaceFolder}/README.md`

/** The ignore file `install` leaves, so a machine's own ledger is not committed. */
export const GitignorePath = `${CodespaceFolder}/.gitignore`

/** The file a change holds while it reads and writes, so another process waits its turn. */
const LockFile = `${CodespaceFolder}.lock`

/** How many times a change waits for another process's lock before giving up. */
const LockTries = 60

/** How long a change waits between tries, in milliseconds. */
const LockDelay = 25

/** Whether an absolute path stays inside the repository root, the root itself included. */
export function IsInside(root: string, absolute: string): boolean
{
    return absolute === root || absolute.startsWith(root + sep)
}

/** Whether a process with this id is still running on this machine. */
function IsProcessAlive(pid: number): boolean
{
    try { process.kill(pid, 0); return true }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM' }
}

/**
 * Reads and writes the files Codespace keeps beside a repository: its JSON records, the guide it leaves,
 * and the ignore file beside them. One rule lives in one place: a path never leaves the repository. A
 * link out of it is refused for reading, and a `.codespace` folder that is itself a link is refused for
 * writing, so a change cannot land outside the repository.
 */
export class JsonStore
{
    /** Changes wait their turn, so two writers cannot read the same file and overwrite each other. */
    private static queue: Promise<unknown> = Promise.resolve()

    /**
     * Reads a file inside the repository, refusing a link that leads out of it.
     * @param root the repository's real path
     * @param relativePath the file's repository-relative path
     * @returns its text, or null when it is not there
     */
    public static async ReadAsync(root: string, relativePath: string): Promise<string | null>
    {
        let real: string
        try { real = await realpath(join(root, relativePath)) }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
            throw error
        }
        if (!IsInside(root, real)) throw new Error('it points outside the repository')
        return readFile(real, 'utf8')
    }

    /**
     * Runs one change alone against every other change, in this process or another, so a read that then
     * writes cannot interleave. The other process is made to wait on a lock file in the repository.
     * @param root the repository's real path
     * @param work the change to run
     */
    public static RunAsync<T>(root: string, work: () => Promise<T>): Promise<T>
    {
        const run = async (): Promise<T> =>
        {
            const release = await JsonStore.LockAsync(root)
            try { return await work() }
            finally { await release() }
        }
        const result = JsonStore.queue.then(run, run)
        JsonStore.queue = result.catch(() => undefined)
        return result
    }

    /**
     * Writes one file whole: to a temporary file beside it, then moved into place, so a reader never
     * sees half of it. Call it inside RunAsync, so it cannot interleave with another change.
     * @param root the repository's real path
     * @param relativePath the file's repository-relative path
     * @param text what to write
     */
    public static async WriteAsync(root: string, relativePath: string, text: string): Promise<void>
    {
        await JsonStore.AssertFolderAsync(root)
        await JsonStore.WriteTextAsync(root, relativePath, text)
    }

    /**
     * Writes one text file whole: to a temporary file beside its real path, then moved into place, so a
     * reader never sees half of it. A link that leads out of the repository is refused.
     * @param root the repository's real path
     * @param relativePath the file's repository-relative path
     * @param text what to write
     */
    public static async WriteTextAsync(root: string, relativePath: string, text: string): Promise<void>
    {
        const target = join(root, relativePath)
        let real: string
        try { real = await realpath(target) }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            const folder = await realpath(dirname(target))
            if (!IsInside(root, folder)) throw new Error('it points outside the repository')
            real = join(folder, basename(target))
        }
        if (!IsInside(root, real)) throw new Error('it points outside the repository')
        const temporary = `${real}.${process.pid}.tmp`
        await writeFile(temporary, text, 'utf8')
        await rename(temporary, real)
    }

    /**
     * Makes sure the `.codespace` folder exists and is a real folder, not a link that could lead out.
     * @param root the repository's real path
     */
    private static async AssertFolderAsync(root: string): Promise<void>
    {
        const folder = join(root, CodespaceFolder)
        try
        {
            const info = await lstat(folder)
            if (info.isSymbolicLink()) throw new Error(`The ${CodespaceFolder} folder is a link; Codespace will not write through it.`)
            if (!info.isDirectory()) throw new Error(`The ${CodespaceFolder} path is not a folder.`)
        }
        catch (error)
        {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
            await mkdir(folder, { recursive: true })
        }
    }

    /**
     * Takes the repository's write lock, waiting for another process to release it.
     * @param root the repository's real path
     * @returns a function that releases the lock
     */
    private static async LockAsync(root: string): Promise<() => Promise<void>>
    {
        const path = join(root, LockFile)
        for (let attempt = 0; ; attempt++)
        {
            try
            {
                const handle = await open(path, 'wx')
                await handle.writeFile(String(process.pid))
                await handle.close()
                return async () => { await unlink(path).catch(() => undefined) }
            }
            catch (error)
            {
                if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
                // A lock left by a process that died belongs to no one: reclaim it and try again.
                const owner = Number.parseInt(await readFile(path, 'utf8').catch(() => ''), 10)
                if (Number.isInteger(owner) && owner !== process.pid && !IsProcessAlive(owner)) { await unlink(path).catch(() => undefined); continue }
                if (attempt >= LockTries) throw new Error(`Another Codespace process is writing to the repository (${LockFile}).`)
                await new Promise((resolve) => setTimeout(resolve, LockDelay))
            }
        }
    }
}
