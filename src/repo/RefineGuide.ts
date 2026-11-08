/**
 * The second pass of describing a repository, as instructions for an agent: how to run `refine`, read
 * what it prints, and change the layers and systems with `apply`. Shared by the prompt a person copies
 * to an outside agent and by what the built-in chat is told, so the two cannot drift apart.
 * @param cli the CLI script's absolute path
 * @param root the repository's absolute path
 */
export function RefineGuide(cli: string, root: string): string
{
    return `Second pass: refine the layers and systems. Once "status" reports "remaining": 0, check what you wrote against the repository's imports:
  node --experimental-transform-types ${cli} refine --repo ${root}
It prints JSON, and decides nothing itself:
- "breaks": imports where a lower layer uses a higher one, which the map draws as red lines. Grouped by pair of layers, with "count", "ordinary" (imports between the same two layers that point the right way, for scale), and a few "examples" with what each file is for. "breakCount" counts all of them.
- "moves": files that would sit in fewer breaks on another layer ("suggestLayer"), judged only from that file's own imports and importers.
- "misplaced": files whose imports and importers are mostly in another system ("suggestSystem").
- "issues": layers or systems that look wrong as a whole, such as a layer named like a system, or a system whose files all sit on one layer.
- "systems": each system's summary, how its files spread over the layers, and how many imports it makes into each other system.

Read the files it names and judge from what each is for; a count is a reason to look, not an answer.
- A break means the order of the layers, a file's layer, or the import is wrong. When many breaks cross the same pair of layers and few cross it the right way ("ordinary" is small), the two layers are in the wrong order: reorder "layers". When a few files cause most of the breaks, move those files to the layer their role and imports call for. A "tests" layer that sits low is the usual cause of a flood of breaks: tests import the code they test, so the layer belongs above everything it imports, at the top. Never move a file only to silence a break if its job says it belongs where it is. An import that really must point up may stay, but say so.
- Check each system against what its files do together. Merge two systems that are one, split one that is two, fix a summary that no longer says what the system is for, and move a file whose imports and importers show it belongs elsewhere. A system's files should still span several layers afterwards.
- Apply only the changes, as one batch: "layers" (the whole new order, bottom first), "systems" (a new one with its summary, or null to remove one no file is left in), and "files" ({"system": ..., "layer": ...} per file moved). Declare a layer or system in the same batch that first uses it. Moving every file out of a layer or system and dropping it can be one batch.
- Run "refine" again after each batch. Stop when "breakCount" is 0, or when what is left is a break you have judged correct, a file you have judged rightly placed, or after three rounds. Then say in a few lines what you changed and why, and what you left.`
}
