import { ConceptsGuide } from '../repo/ConceptsGuide.ts'
import { DescribeGuide } from '../repo/DescribeGuide.ts'
import { RefineGuide } from '../repo/RefineGuide.ts'
import { MapTools } from '../server/Tools.ts'

/** Where the chat's agent finds the map and its tools. */
export interface IInstructionPlaces
{
    /** The absolute path of the repository being mapped. */
    root: string
    /** The map server's address, such as http://localhost:5190. */
    mapUrl: string
    /** The absolute path of the describe CLI. */
    cli: string
}

/**
 * What the chat's agent is told about Codespace, added to its system prompt: who it is talking to,
 * how to draw on the map, and how to describe the repository.
 * @param places where the repository, the map, and the tools are
 */
export function Instructions(places: IInstructionPlaces): string
{
    const { root, mapUrl, cli } = places
    return `# Codespace

You are the assistant built into Codespace, a 3D map of the repository at ${root}. The person is looking
at the map while they talk to you. Answer in plain words and keep replies short; the map shows the detail.

When they ask how something works, or to show, trace, or walk through code, find the real files and
functions first, then put it on the map, then reply with a few lines. The blocks tool shows how one
file is put together, with a summary of each part.

A good map is legible: a short ladder of layers by job, and a few systems that explain the code.
When you describe or refine a repository, favor that over fine-grained cleverness.

## Drawing on the map

Send JSON to the map with bash. Every open page updates at once.

    curl -s -X POST ${mapUrl}/api/view -H 'Content-Type: application/json' --data-binary @- <<'JSON'
    {"action": "show", "trace": true, "title": "How X happens", "note": "The whole process in one or two sentences.",
     "files": [{"path": "src/a.ts", "note": "Step one: what happens here, naming the function."},
               {"path": "src/b.ts", "note": "Step two: ..."}]}
    JSON

To leave only the files you highlighted on the map, send the same paths again with
{"action": "isolate", "files": [...]}. An empty files list shows every file again.

Every endpoint, and what it takes (a GET takes its arguments as query values, a POST as the JSON body with
the fixed fields shown). Paths are relative to ${root}.

${ToolReference(mapUrl)}

## Describing the repository

${DescribeGuide(cli, root)}

## Refining the description

${RefineGuide(cli, root)}

## Writing down the design: things and operations

${ConceptsGuide(cli, root)}`
}


/**
 * Lists every map tool as the endpoint the chat's agent calls with curl, its arguments, and what it is for,
 * so the chat learns of a new tool the moment it is added to MapTools.
 * @param mapUrl the map server's address
 */
export function ToolReference(mapUrl: string): string
{
    return MapTools.map((tool) =>
    {
        const fixed = tool.fixed === undefined ? '' : ` ${JSON.stringify(tool.fixed)}`
        const required = new Set(tool.parameters.required ?? [])
        const names = Object.keys(tool.parameters.properties).map((name) => required.has(name) ? name : `${name}?`)
        const takes = names.length === 0 ? '' : ` takes ${names.join(', ')}.`
        const description = tool.description.replace(/\s*\n\s*/g, ' ')
        return `- ${tool.method} ${mapUrl}${tool.path}${fixed} (${tool.name})${takes} ${description}`
    }).join('\n')
}
