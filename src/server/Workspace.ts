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
interface IWorkspaceInfo extends IRecentRepo
{
    /** The repositories opened before this one, newest first. */
    recent: IRecentRepo[]
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

    /** The repositories opened so far, newest first. */
    private recent: IRecentRepo[]

    /**
     * Holds one repository.
     * @param repo the repository being read
     */
    private constructor(repo: Repo)
    {
        this.repo = repo
        this.view = new View()
        this.recent = []
        this.Remember(repo)
    }

    /**
     * Opens the repository a page or the command line named.
     * @param path a folder, absolute or relative to where the server was started; `~/` is home
     */
    public static async OpenAsync(path: string): Promise<Workspace>
    {
        return new Workspace(await Repo.OpenAsync(Workspace.ResolvePath(path)))
    }

    /** What the page shows about the repository being read, and the recent ones. */
    public get Info(): IWorkspaceInfo
    {
        return { name: this.repo.Name, root: this.repo.Root, recent: [...this.recent] }
    }

    /**
     * Points the map at another repository, dropping whatever was shown on the last one.
     * @param path a folder, absolute or relative to where the server was started; `~/` is home
     */
    public async SwitchAsync(path: string): Promise<IWorkspaceInfo>
    {
        const repo = await Repo.OpenAsync(Workspace.ResolvePath(path))
        this.repo = repo
        this.view.Clear()
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
