/**
 * The ingest commands an agent runs from a shell, with no server and no MCP: they read the
 * repository's files, write `.codespace/architecture.json`, and the map picks the change up.
 *
 *   node src/cli/Cli.ts next [--size N]      the next files or folders without a summary
 *   node src/cli/Cli.ts apply --file <json>  write summaries, tags, and layers back; - reads stdin
 *   node src/cli/Cli.ts status               how much is left to describe
 *   node src/cli/Cli.ts repo                 which repository it reads, and where
 *
 * Each takes `--repo <folder>`, which defaults to CODESPACE_REPO or the current folder.
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Architecture, type IArchitecturePatch } from '../repo/Architecture.ts'
import { Graph } from '../repo/Graph.ts'
import { NextBatchAsync, StatusAsync } from '../repo/Ingest.ts'
import { Repo } from '../repo/Repo.ts'

/** The usage, printed by --help and by a command that is missing. */
const Usage = `Usage: node src/cli/Cli.ts <command> [--repo <folder>]

  repo                       which repository it reads, and where
  status                     how many files and folders still need a summary
  next [--size N]            the next files or folders to describe, with their source
  apply --file <json>        write {"files": {...}, "folders": {...}} back; - reads stdin

Options:
  --repo <folder>            the repository (default CODESPACE_REPO, else the current folder)
  --size <n>                 how many files or folders next hands back, at most 40
  --file <path>              the JSON change for apply`

/**
 * What a person pastes into their agent, naming these same commands.
 * @param cli the CLI script's absolute path
 * @param root the repository's absolute path
 */
export function PromptFor(cli: string, root: string): string
{
    return `Describe this repository for the Codespace map. Its CLI needs no server or MCP; run it from a shell:
  node --experimental-transform-types ${cli} status --repo ${root}
  node --experimental-transform-types ${cli} next --repo ${root}
Write each batch to a JSON file and save it with:
  node --experimental-transform-types ${cli} apply --file batch.json --repo ${root}
where the file holds {"files": {"src/a.ts": {"summary": "...", "tags": ["core"], "layer": "base"}}, "folders": {"src": {"summary": "..."}}}. By default, ignore the extras — tests, docs, scripts, and vendored or library folders such as node_modules and vendor — and leave them out of your batches; the map hides them. Every file entry needs all three: one sentence, tags from entry/orchestrate/core/data/io/ui/config/test, and a layer. If the architecture file declares no layers yet, declare two to five in the first apply, for example {"layers": ["meta", "base", "ui"]} — a layer not declared there is refused. next also returns files that have a summary but no layer or tags, so fill those in too. Repeat until status reports "remaining": 0. Generated and vendored files are settled for you. If these commands fail, stop and say so rather than editing .codespace/architecture.json by hand.`
}

/**
 * Runs one command.
 * @param args the command line, without node and the script
 */
export async function RunAsync(args: readonly string[]): Promise<number>
{
    const [command, ...rest] = args

    /** The value after an option, or undefined. */
    const option = (name: string): string | undefined =>
    {
        const index = rest.indexOf(name)
        return index >= 0 ? rest[index + 1] : undefined
    }

    if (command === undefined || command === '--help' || command === '-h')
    {
        console.log(Usage)
        return command === undefined ? 1 : 0
    }

    try
    {
        const repo = await Repo.OpenAsync(option('--repo') ?? process.env.CODESPACE_REPO ?? process.cwd())

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

        if (command === 'next')
        {
            const size = Math.max(1, Math.min(40, Number(option('--size')) || 12))
            const known = await repo.ListFilesAsync()
            const architecture = await Architecture.ReadAsync(repo.Root, known)
            const batch = await NextBatchAsync(repo, architecture, await Graph.BuildAsync(repo), size)

            // Generated files are settled here, so the agent never spends a read on them.
            if (batch.skipped.length > 0)
            {
                const files = Object.fromEntries(batch.skipped.map((item) => [item.path, { summary: item.summary }]))
                await Architecture.UpdateAsync(repo.Root, known, { files })
            }
            console.log(JSON.stringify({ name: repo.Name, root: repo.Root, ...batch }))
            return 0
        }

        if (command === 'apply')
        {
            const source = option('--file')
            if (source === undefined) throw new Error('apply needs --file <json>, or --file - to read stdin.')
            const text = source === '-' ? await ReadStdinAsync() : await readFile(resolve(source), 'utf8')
            const change: unknown = JSON.parse(text)
            if (typeof change !== 'object' || change === null || Array.isArray(change)) throw new Error('The change must be a JSON object: {"files": {...}, "folders": {...}}.')
            const updated = await Architecture.UpdateAsync(repo.Root, await repo.ListFilesAsync(), change as IArchitecturePatch)
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

// Only run when started as a program, so importing PromptFor never runs a command.
const started = process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (started) process.exitCode = await RunAsync(process.argv.slice(2))
