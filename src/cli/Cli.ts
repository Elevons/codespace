/**
 * The ingest commands an agent runs from a shell, with no server and no MCP: they read the
 * repository's files, write `.codespace/architecture.json`, and the map picks the change up.
 *
 *   node src/cli/Cli.ts next [--size N]      the next files or folders without a complete entry
 *   node src/cli/Cli.ts apply --file <json>  write systems, layers, tags, and summaries back; - reads stdin
 *   node src/cli/Cli.ts concepts [--size N]  what concept work remains: entry points to turn into operations, or steps, reads and writes, and layers to fill in
 *   node src/cli/Cli.ts refine [--size N]    the second pass: layer breaks, files that fit elsewhere, and layering problems
 *   node src/cli/Cli.ts sync                 carry entries along with moved files and drop those for files that are gone
 *   node src/cli/Cli.ts install              leave the upkeep rules in the repository, so its architecture file is kept true
 *   node src/cli/Cli.ts lift-notes           move JSDoc and //> step comments out of the scripts into the architecture file's notes
 *   node src/cli/Cli.ts status               how much is left to describe
 *   node src/cli/Cli.ts repo                 which repository it reads, and where
 *
 * Each takes `--repo <folder>`, which defaults to CODESPACE_REPO or the current folder.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Architecture, type IArchitecturePatch } from '../repo/Architecture.ts'
import { ConceptsNextAsync } from '../repo/Concepts.ts'
import { Graph } from '../repo/Graph.ts'
import { ClampSize, DefaultBatch, MaxBatchSize, StatusAsync } from '../repo/Ingest.ts'
import { InstallAsync } from '../repo/Install.ts'
import { Ledger } from '../repo/Ledger.ts'
import { LiftNotesAsync } from '../repo/LiftNotes.ts'
import { TakeNextAsync } from '../repo/Next.ts'
import { DefaultRefineSize, Refine } from '../repo/Refine.ts'
import { SyncAsync } from '../repo/Sync.ts'
import { Repo } from '../repo/Repo.ts'
import { ReadOption } from './Options.ts'

/** The usage, printed by --help and by a command that is missing. */
const Usage = `Usage: node src/cli/Cli.ts <command> [--repo <folder>]

  repo                       which repository it reads, and where
  status                     how many files and folders still need a summary, have changed, or are stale
  sync                       carry entries along with moved files and drop those for files that are gone (next does this too)
  next [--size N]            the next files or folders to describe or review, with their source
  refine [--size N]          the second pass, once everything is described: the imports that point up the layers,
                             files that would sit better on another layer or in another system, and layering problems
  concepts [--size N]        the concepts pass: entry points to turn into operations, or the operations and things still
                             missing steps, reads and writes, or a layer, with the source of their files
  install                    write the upkeep rules into the repository (a note in AGENTS.md, the rules in .codespace/README.md),
                             so whoever changes the code later keeps its architecture file true
  lift-notes [--dry-run]     move every script's JSDoc (/** */) and step (//>) comments into the architecture file's
                             notes, and take them out of the code; --dry-run only counts them
  apply --file <json>        write {"systems": {...}, "layers": [...], "files": {...}, "folders": {...}, "concepts": {...}} back; - reads stdin

Options:
  --repo <folder>            the repository (default CODESPACE_REPO, else the current folder)
  --size <n>                 how many files, folders, or report items next and refine hand back, at most ${MaxBatchSize}
  --file <path>              the JSON change for apply`

/**
 * Runs one command.
 * @param args the command line, without node and the script
 */
export async function RunAsync(args: readonly string[]): Promise<number>
{
    const [command, ...rest] = args

    if (command === undefined || command === '--help' || command === '-h')
    {
        console.log(Usage)
        return command === undefined ? 1 : 0
    }

    try
    {
        const repo = await Repo.OpenAsync(ReadOption(rest, '--repo') ?? process.env.CODESPACE_REPO ?? process.cwd())

        if (command === 'repo')
        {
            console.log(JSON.stringify({ name: repo.Name, root: repo.Root }))
            return 0
        }

        if (command === 'status')
        {
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            console.log(JSON.stringify({ name: repo.Name, root: repo.Root, ...await StatusAsync(repo, architecture) }))
            return 0
        }

        if (command === 'sync')
        {
            console.log(JSON.stringify({ ok: true, ...await SyncAsync(repo) }))
            return 0
        }

        if (command === 'next')
        {
            const batch = await TakeNextAsync(repo, ClampSize(ReadOption(rest, '--size'), DefaultBatch))
            console.log(JSON.stringify({ name: repo.Name, root: repo.Root, ...batch }))
            return 0
        }

        if (command === 'install')
        {
            console.log(JSON.stringify({ ok: true, ...await InstallAsync(repo.Root) }))
            return 0
        }

        if (command === 'refine')
        {
            const size = ClampSize(ReadOption(rest, '--size'), DefaultRefineSize)
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            const graph = await Graph.BuildAsync(repo)
            console.log(JSON.stringify({ name: repo.Name, root: repo.Root, ...Refine(architecture, graph.Edges(), size) }))
            return 0
        }

        if (command === 'concepts')
        {
            const architecture = await Architecture.ReadAsync(repo.Root, await repo.ListFilesAsync())
            const size = ClampSize(ReadOption(rest, '--size'), 6)
            console.log(JSON.stringify({ name: repo.Name, root: repo.Root, ...await ConceptsNextAsync(repo, architecture, await Graph.BuildAsync(repo), size, fileURLToPath(import.meta.url)) }))
            return 0
        }

        if (command === 'lift-notes')
        {
            console.log(JSON.stringify({ ok: true, ...await LiftNotesAsync(repo, rest.includes('--dry-run')) }))
            return 0
        }

        if (command === 'apply')
        {
            const source = ReadOption(rest, '--file')
            if (source === undefined) throw new Error('apply needs --file <json>, or --file - to read stdin.')
            const text = source === '-' ? await ReadStdinAsync() : await readFile(resolve(source), 'utf8')
            const change: unknown = JSON.parse(text)
            if (typeof change !== 'object' || change === null || Array.isArray(change)) throw new Error('The change must be a JSON object: {"files": {...}, "folders": {...}}.')
            const patch = change as IArchitecturePatch
            const updated = await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), patch)
            // Every file the change names is now described from its text as it stands, so it is not offered again until it changes.
            await Ledger.RecordAsync(repo, Object.keys(patch.files ?? {}))
            console.log(JSON.stringify({ ok: true, notes: updated.notes }))
            return 0
        }

        throw new Error(`Unknown command "${command}". Try --help.`)
    }
    catch (error)
    {
        console.error((error as Error).message)
        return 1
    }
}

/** Reads everything on standard input. */
async function ReadStdinAsync(): Promise<string>
{
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
    return Buffer.concat(chunks).toString('utf8')
}

// Only run when started as a program, so importing this module never runs a command.
const started = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (started) process.exitCode = await RunAsync(process.argv.slice(2))
