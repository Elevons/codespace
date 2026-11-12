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
It prints JSON, and decides nothing itself. It is a list of questions to ask of the code:
- "breaks": imports where a lower layer uses a higher one, which the map draws as red lines. Grouped by pair of layers, with "count", "ordinary" (imports between the same two layers that point the right way, for scale), and a few "examples" with what each file is for. "breakCount" counts all of them.
- "moves": files that would sit in fewer breaks on another layer ("suggestLayer", "breaksNow" to "breaksIfMoved"). This holds every other file still, so a suggestion is a candidate, not a verdict: a move can lower the count while misnaming the file's job.
- "misplaced": files whose imports and importers are mostly in another system ("suggestSystem"). Tests and config files are left out, since they touch everything.
- "issues": layers or systems that look wrong as a whole, such as a layer named like a system, an empty or one-file layer, or a system whose files all sit on one layer.
- "systems": each system's summary, how its files spread over the layers, and how many imports it makes into each other system.
- "remaining": breaks plus misplaced files plus issues, in total.

Read the files it names and judge from what each is for; a count is a reason to look, not an answer. For each group of breaks, decide which of these it is:
1. The layers are out of order. Many breaks cross one pair of layers while few cross it the right way ("ordinary" is small): reorder "layers". This is usually the fix when a small shared layer (a runner, a gate, a helper) sits above the services and agents that import it; move that layer below them, or fold its files into the layer below.
2. A file is on the wrong layer. A few files cause most of the breaks, and a "moves" suggestion matches what the file is for: move those files. Never move a file whose new layer misnames its job just to silence a break.
3. A real dependency cycle, or an import that must point up. Two layers that import each other cannot be ordered away. Read the files: if one is a type, interface, or pure helper, it belongs low; otherwise the code needs changing and the break stays. Say so; do not hide it.

Check each system against what its files do together. Merge two systems that are one, split one that is two, fix a summary that no longer says what the system is for, and move a file whose imports and importers show it belongs elsewhere. A system's files should still span several layers afterwards. A file that merely has most of its neighbours in another system may be a shared primitive; do not move a shared primitive into whichever system imports it most.

Apply only the changes, as one batch: "layers" (the whole new order, bottom first), "systems" (a new one with its summary, or null to remove one no file is left in), and "files" ({"system": ..., "layer": ...} per file moved). Declare a layer or system in the same batch that first uses it. Moving every file out of a layer or system and dropping it can be one batch.

Run "refine" again after each batch. Stop when "breakCount" is 0, or when every break left has been read and judged: reordered, moved, or left on purpose with a reason. Do not stop merely because a count fell; a break you leave is a red line on the map. If three rounds still leave breaks, stop and report them rather than shuffling further. End by running "refine" once more, then say in a few lines what you changed, the final "breakCount", and which breaks you left and why.

The import graph reads TypeScript/JavaScript and C# only, so other languages never appear in "breaks". A "breakCount" of 0 does not mean their layering was checked; say which parts of the repository "refine" could not see.`
}
