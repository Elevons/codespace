import { homedir } from 'node:os'
import { resolve } from 'node:path'
import { Repo } from '../repo/Repo.ts'
import { View } from './View.ts'

/** One repository the map has been pointed at, as the page lists it. */
interface IRecentRepo
{
    /** Its folder name. */
    name: string
    /** Its absolute path. */
    root: string
}

/** What the page needs to know about the repository being read. */
export interface IWorkspaceInfo extends IRecentRepo
{
    /** The repositories opened before this one, newest first. */
    recent: IRecentRepo[]
    /** Whether this is a repository a page asked for with ?repo=, which cannot be switched. */
    pinned: boolean
}

/** The most repositories kept in the recent list. */
const MaxRecent = 8

/** The repository the map is reading, and the ones it read before, which it can switch between. */
export class Workspace
{
    /** The repository being read now. */
    public repo: Repo

    /** What the map is showing, and the pages watching it. Kept across a switch. */
    public readonly view: View

    /** Whether this repository was asked for with ?repo=, and so always reads the same one. */
    public readonly pinned: boolean

    /** The repositories opened so far, newest first. */
    private recent: IRecentRepo[]

    /**
     * Holds one repository.
     * @param repo the repository being read
     * @param pinned whether it was asked for with ?repo= and cannot be switched
     */
    private constructor(repo: Repo, pinned: boolean)
    {
        this.repo = repo
        this.pinned = pinned
        this.view = new View()
        this.recent = []
        this.Remember(repo)
    }

    /**
     * Opens the repository a page or the command line named.
     * @param path a folder, absolute or relative to where the server was started; `~/` is home
     * @param pinned whether it was asked for with ?repo= and cannot be switched
     */
    public static async OpenAsync(path: string, pinned = false): Promise<Workspace>
    {
        return new Workspace(await Repo.OpenAsync(Workspace.ResolvePath(path)), pinned)
    }

    /** What the page shows about the repository being read, and the recent ones. */
    public get Info(): IWorkspaceInfo
    {
        return { name: this.repo.Name, root: this.repo.Root, recent: this.pinned ? [] : [...this.recent], pinned: this.pinned }
    }

    /**
     * Points the map at another repository, dropping whatever was shown on the last one.
     * @param path a folder, absolute or relative to where the server was started; `~/` is home
     */
    public async SwitchAsync(path: string): Promise<IWorkspaceInfo>
    {
        if (this.pinned) throw new Error('This page reads the repository it was opened with (?repo=), so it cannot switch.')
        const repo = await Repo.OpenAsync(Workspace.ResolvePath(path))
        this.repo = repo
        this.view.Clear()
        this.view.Isolate(null)
        this.Remember(repo)
        this.view.RepoChanged()
        return this.Info
    }

    /**
     * Turns what was typed into a folder path: `~/` is the home of the machine running Codespace,
     * and anything relative is resolved against the folder the server was started in.
     * @param path the typed path
     */
    public static ResolvePath(path: string): string
    {
        const trimmed = path.trim()
        if (trimmed === '~') return homedir()
        if (trimmed.startsWith('~/')) return resolve(homedir(), trimmed.slice(2))
        return resolve(trimmed)
    }

    /**
     * Notes a repository in the recent list, newest first and once each.
     * @param repo the repository opened
     */
    private Remember(repo: Repo): void
    {
        this.recent = [{ name: repo.Name, root: repo.Root }, ...this.recent.filter((recent) => recent.root !== repo.Root)].slice(0, MaxRecent)
    }
}

/** The most repositories held open for ?repo= at once; the one used longest ago is let go first. */
const MaxPinned = 16

/**
 * The repositories one server reads: its own, which a page can switch, and any a page or tool asks for
 * by absolute path with ?repo=, each with its own view and watching pages, so several can be open at once.
 */
export class Workspaces
{
    /** The server's own repository, from --repo, which a page can switch. */
    public readonly main: Workspace

    /** The repositories asked for with ?repo=, by root, the one used most recently last. */
    private readonly pinned = new Map<string, Workspace>()

    /**
     * Holds the server's own repository.
     * @param main the repository from --repo
     */
    public constructor(main: Workspace)
    {
        this.main = main
    }

    /** Whether a root is already held open for ?repo=, so reading it opens nothing new. */
    public IsOpen(root: string): boolean
    {
        const resolved = Workspace.ResolvePath(root)
        return resolved === this.main.repo.Root || this.pinned.has(resolved)
    }

    /**
     * The workspace a request reads: the one its ?repo= names, opened the first time it is asked for, or
     * the server's own when it names none or names the server's own root.
     * @param repo the ?repo= value, if any
     */
    public async ForAsync(repo: string | null): Promise<Workspace>
    {
        if (repo === null || repo.trim() === '') return this.main
        const root = Workspace.ResolvePath(repo)
        if (root === this.main.repo.Root) return this.main
        const held = this.pinned.get(root)
        if (held !== undefined)
        {
            this.pinned.delete(root)
            this.pinned.set(root, held)
            return held
        }
        const opened = await Workspace.OpenAsync(root, true)
        // A path that is a link to an open repository reads that one.
        const known = this.pinned.get(opened.repo.Root)
        if (known !== undefined) return known
        this.pinned.set(opened.repo.Root, opened)
        while (this.pinned.size > MaxPinned) this.pinned.delete(this.pinned.keys().next().value!)
        return opened
    }
}
