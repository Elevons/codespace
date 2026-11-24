export function ConceptsGuide(cli: string, root: string): string
{
    return `Concepts pass: write down the design the code already has, as things and operations, for the person to confirm. Run:
  node --experimental-transform-types ${cli} concepts --repo ${root}
It prints JSON and decides nothing. It works in stages, and every answer also carries a "review" check against the real files and imports:
- "overview" (when no operations exist yet): every described file in the repository, in path order — code, data tables, scenes, config, tests, and docs alike — with its system, layer, tags, summary, and how many files it imports and is imported by, plus the systems and folders. Nothing is picked out for you: decide from the descriptions and the files themselves what the things and operations are. It is paged: "overview.pages" says how many; read each with --page N before you write anything. --page N returns that page at any stage.
- "operations": lists operations still missing steps, file evidence on their steps, or inputs and outputs, with their files' source and "nearby" imported neighbours not yet in the operation.
- "things": lists things still missing a layer or their files, with the operations that read and write them and "suggestedLayers".
- "place": lists described files that no operation and no thing names yet, each with its imports, importers, and "near" (where those neighbours already sit, a hint only). Put every one somewhere: in a step of the operation it does work in (add a step, or a new operation such as one for the tests, the docs, or the dev tooling, if none fits), or in the "files" of the thing it holds. Nothing is finished while a file is unplaced.
- "review": lists blocking gaps — orphan things neither read nor written, or whole systems with no file in any operation or thing.
Every operation and every thing must end up with files: an operation through its steps, a thing through "files".
- "done": every required field and blocking check is satisfied; read "review" anyway ("coverage.unplaced", import divergences, overlapping operations, and issues) and do one polish pass if anything real is flagged.

Two ideas:
- A thing is data that is kept or passed between steps: a type that crosses a boundary, a store, a world or session state, a file written to disk, a message on a stream. It is not a module, class, system, or folder. Name it as a noun the person would use ("Snapshot", "Architecture file"). Give it a "summary", a "layer": where it is held, from the declared layers, and "files": the files that define or hold it (its type or schema, its store, its authored tables or saved state), so the map draws them with it. A thing with no files is not finished.
- An operation is something that changes data, started by one entry point, command, endpoint, handler, or loop: "Read a repository", "Describe files", "Advance one simulation tick". It reads some things and writes others. About 6 to 15 operations cover a typical repository; cover every working system rather than stopping after one or two entry points, and merge near-duplicates.

How to write an operation, as a process sheet:
- "steps": 3 to 8, in order, in plain words, each saying what happens to which thing ("Read every file and its imports into the snapshot"). No function, class, or file names in the text. Tie every step to the files that do it with "files" (they are the evidence, not the subject), and do not leave files in the operation untied to any step.
- "reads" and "writes": the things it takes in and puts out. Check each against the code: a thing is written only if the code stores, mutates, or sends it.
- "rules": only what the code enforces or clearly intends ("All or nothing: one problem refuses the whole change"). Leave it out when unsure; never invent a rule.
- "summary": one sentence on what it is for.
Read the whole overview, find where work starts (entry files, endpoints, commands, handlers, loops) and follow what each calls, and read the files before you describe them. Every described file must end up in an operation's steps or in a thing's files, tests and docs included.

Save with apply, in one batch, under "concepts" (merged by name; null removes one; a field set to null is removed; a list replaces the old list):
{
  "concepts": {
    "things": { "Snapshot": { "summary": "Every file and its imports, read once and reused.", "layer": "repo", "files": [".codespace/snapshot.json"], "rules": ["Rebuilt when any file's stamp changes."] } },
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
Declare a thing before an operation reads or writes it, in the same batch or earlier. A thing an operation still uses cannot be removed. Repeat until "remaining" is 0, then check "review" and fix any real gaps (unplaced files that do work or hold data, uncovered systems, orphan things, import divergences, near-duplicate operations, or missing summaries) in at most two review passes.`
}
