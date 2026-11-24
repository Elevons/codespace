export function ConceptsGuide(cli: string, root: string): string
{
    return `Concepts pass: write down the design the code already has, as things and operations, for the person to confirm. Run:
  node --experimental-transform-types ${cli} concepts --repo ${root}
It prints JSON and decides nothing. Without any operations it lists "candidates": entry points (files tagged entry, server endpoints, CLI commands, page buttons and keys) with the file's source, imports and importers. With operations it lists the ones still missing steps or inputs and outputs, and the things missing a layer, each with the source of the files involved.

Two ideas:
- A thing is data that is kept or passed between steps: a type that crosses a boundary, a store, a file written to disk, a message on a stream. It is not a module, class, or folder. Name it as a noun the person would use ("Snapshot", "Architecture file"). Give it a layer: where it is held, from the declared layers.
- An operation is something that changes data, started by one entry point: "Read a repository", "Describe files". It reads some things and writes others. About 6 to 12 operations cover a repository; merge near-duplicates.

How to write an operation, as a process sheet:
- "steps": 3 to 8, in order, in plain words, each saying what happens to which thing ("Read every file and its imports into the snapshot"). No function, class, or file names in the text. Tie each step to the files that do it with "files" (they are the evidence, not the subject).
- "reads" and "writes": the things it takes in and puts out. Check each against the code: a thing is written only if the code stores or sends it.
- "rules": only what the code enforces or clearly intends ("All or nothing: one problem refuses the whole change"). Leave it out when unsure; never invent a rule.
- "summary": one sentence on what it is for.
Follow what the entry point calls, and read the files before you describe them.

Save with apply, in one batch, under "concepts" (merged by name; null removes one; a field set to null is removed; a list replaces the old list):
{
  "concepts": {
    "things": { "Snapshot": { "summary": "Every file and its imports, read once and reused.", "layer": "repo", "rules": ["Rebuilt when any file's stamp changes."] } },
    "operations": {
      "Read a repository": {
        "summary": "Lists a folder's files and imports.",
        "reads": ["Your folder"], "writes": ["Snapshot"],
        "steps": [ { "text": "List every readable text file, skipping ignored ones.", "files": ["src/repo/Repo.ts"] },
                   { "text": "Work out which files import which.", "files": ["src/repo/Graph.ts"] } ],
        "rules": ["A symlink never leads outside the folder."]
      }
    }
  }
}
Declare a thing before an operation reads or writes it, in the same batch or earlier. A thing an operation still uses cannot be removed. Repeat until "remaining" is 0.`
}
