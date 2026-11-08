import { lstat, readFile, realpath } from 'node:fs/promises'
import { join, sep } from 'node:path'
import { TAG_VOCABULARY } from '../../public/tags.ts'
import { GitignorePath, GuidePath, JsonStore } from './JsonStore.ts'

/** The lines that mark the block Codespace owns in an agent instructions file. */
const BlockStart = '<!-- codespace:start -->'
const BlockEnd = '<!-- codespace:end -->'

/** The instruction files an agent reads on arrival, in the order one is chosen. */
const InstructionFiles = ['AGENTS.md', 'CLAUDE.md']

/** The short note left in the repository's instruction file, which points to the full rules. */
const Block = `${BlockStart}
## Codespace map

\`.codespace/architecture.json\` says what each file in this repository is for, and which system and layer
it belongs to; the Codespace map is drawn from it. Keep it true as you work: when you add, move, rename,
delete, or change what a file is for, update its entry in the same change. The format and the rules are in
\`.codespace/README.md\`.
${BlockEnd}
`

/** The full upkeep rules, kept in the repository beside the file they are about. */
const Guide = `# Keeping the Codespace map true

\`architecture.json\` in this folder describes the repository to the Codespace map: what each file is for,
and where it sits. It was written when the repository was first mapped, and it only stays useful if every
change to the code carries its entry along. **Whoever changes a file updates its entry in the same change.**

## What to do when

- **A file is added:** add its entry (below). Until it has one, the map leaves it out while only described files are shown.
- **A file is moved or renamed:** move its entry to the new path, key and all. An entry for a path that no
  longer exists is reported as stale.
- **A file is deleted:** delete its entry.
- **A file's job changes:** rewrite its summary, and change its system, layer, or tags if they no longer fit.
- **A folder is added or its purpose changes:** add or update its entry under \`folders\`.

## The file

\`\`\`json
{
  "layers": ["config", "data", "api", "ui", "entry", "tests"],
  "systems": { "server": { "summary": "What this part of the app is for." } },
  "files": {
    "src/api/orders.ts": {
      "system": "server",
      "layer": "api",
      "tags": ["orchestrate", "io"],
      "summary": "Serves the order endpoints and checks each request before it reaches the store."
    }
  },
  "folders": { "src/api": { "summary": "The HTTP endpoints." } }
}
\`\`\`

- **summary:** one plain sentence on what the file is *for*, not how it works.
- **system:** the functional part of the app the file belongs to. It must be listed under \`systems\`.
- **layer:** the file's level in the stack, from \`layers\` (listed bottom first). It is the file's job, not its
  system and not its folder.
- **tags:** its roles, primary first, from ${TAG_VOCABULARY.map((tag) => `\`${tag}\``).join(', ')}. Other tags are stored and shown grey.
- Use a layer and a system that already exist. Add a new one only when nothing fits, and declare it first.

Every ordinary file entry needs a summary, a system, a layer, and tags. A generated or vendored file is the
exception: its entry may be a summary alone.

## Keep the layers honest

Imports point down the stack: a file may import files on its own layer or a lower one, and never a higher one.
The map draws each import that points up as a red line, so a change that adds one has put the file on the wrong
layer, or the layers in the wrong order. Choose the layer from what the file imports and what imports it. Tests
import the code they test, so a tests layer sits above it.

## How to edit

Edit \`architecture.json\` directly and keep it valid JSON; the map picks the change up on its own. If you can
reach Codespace's command line (\`src/cli/Cli.ts\`), \`apply --file change.json\` writes the same shape all at once
and reports anything wrong, and \`refine\` lists imports that point up the layers.
`

/** What `install` did. */
interface IInstalled
{
    /** The instruction file the note went in, relative to the repository. */
    instructions: string
    /** Whether that file was created, had the note added, had it updated, or already had it. */
    note: 'created' | 'added' | 'updated' | 'unchanged'
    /** The full rules file, relative to the repository. */
    guide: string
}

/**
 * Leaves the upkeep rules in a repository, so whoever changes it later keeps its architecture file true:
 * a short note in its agent instructions file (AGENTS.md, or CLAUDE.md when that is the one it has), and
 * the full rules in `.codespace/README.md`. Running it again changes nothing that is already current, and
 * touches nothing outside the marked block of the instructions file.
 * @param root the repository's real path
 */
export async function InstallAsync(root: string): Promise<IInstalled>
{
    // The file to put the note in: the first that exists, else a new AGENTS.md.
    let name = 'AGENTS.md'
    for (const candidate of InstructionFiles)
    {
        if (await Exists(join(root, candidate))) { name = candidate; break }
    }
    const path = join(root, name)

    let note: IInstalled['note'] = 'created'
    if (await Exists(path))
    {
        // A link that leads out of the repository is never written through.
        const real = await realpath(path)
        if (!real.startsWith(root + sep)) throw new Error(`${name} points outside the repository, so Codespace will not write to it.`)
        const text = await readFile(real, 'utf8')
        const start = text.indexOf(BlockStart), end = text.indexOf(BlockEnd)
        let next: string
        if (start >= 0 && end > start)
        {
            next = text.slice(0, start) + Block.trimEnd() + text.slice(end + BlockEnd.length)
            note = next === text ? 'unchanged' : 'updated'
        }
        else
        {
            next = text.replace(/\s*$/, '') + '\n\n' + Block
            note = 'added'
        }
        if (note !== 'unchanged') await JsonStore.WriteTextAsync(root, name, next)
    }
    else await JsonStore.WriteTextAsync(root, name, `# Working in this repository\n\n${Block}`)

    await JsonStore.RunAsync(root, async () =>
    {
        await JsonStore.WriteAsync(root, GuidePath, Guide)
        // The record of what each description was based on holds file times, which differ on every machine.
        await JsonStore.WriteAsync(root, GitignorePath, 'ingested.json\n')
    })
    return { instructions: name, note, guide: GuidePath }
}

/** Whether something is at a path, without following a link at the end of it. */
async function Exists(path: string): Promise<boolean>
{
    try { await lstat(path); return true }
    catch { return false }
}
