export function ConceptsGuide(cli: string, root: string): string
{
    return `Concepts pass: write down the design the code already has, as data and operations, for the person to confirm. Run:
  node --experimental-transform-types ${cli} concepts --repo ${root}
It prints JSON and decides nothing. It works in stages:
- "overview" (when no operations exist yet): every described file in the repository, in path order — code, data tables, scenes, config, tests, and docs alike — with its system, layer, tags, summary, and how many files it imports and is imported by, plus the systems and folders. Nothing is picked out for you: decide from the descriptions and the files themselves what the data and operations are. It is paged: "overview.pages" says how many; read each with --page N before you write anything. --page N returns that page at any stage.
- "operations": operations still missing steps, file evidence on their steps, or inputs and outputs, with their files' source and "nearby" imported neighbours not yet in the operation.
- "data": data entries still missing a layer or their files, with the operations that read and write them and "suggestedLayers".
- "place": described files that no operation and no data entry names yet, each with its imports, importers, and "near" (where those neighbours already sit, a hint only). Put every one somewhere: in a step of the operation it does work in, or in the "files" of the data it holds. Nothing is finished while a file is unplaced.
- "changed": operations and data whose files changed since you wrote them. Each item has "reason": "changed", "changedFiles", and the "current" entry. Read the changed files, then apply the entry again, rewritten if it no longer fits (steps, reads, writes, files, rules); applying it restamps it. An entry written before stamps existed is treated as current.
- "review": blocking gaps — data that no operation reads or writes, or whole systems with no file in any operation or data entry.
- "done": every required field and blocking check is satisfied; read "review" anyway (import divergences, overlapping operations, oversized data, and issues) and do one polish pass if anything real is flagged.
Every operation and every data entry must end up with files: an operation through its steps, data through "files".

Two ideas:
- Data is what is kept or passed between steps: a type that crosses a boundary, a store, a world or session state, a file written to disk, a message on a stream. It is not a module, class, system, or folder. Name each entry as a noun the person would use ("Snapshot", "Architecture file"). Give it a "summary", a "layer": where it is held, from the declared layers, and "files": the few files that define or hold it — its type or schema, its store, its authored tables or saved state — so the map draws them under it. Code that uses the data belongs in an operation's steps, not in its files; an entry with more than about 15 files is usually several entries, or code that belongs to an operation.
- An operation is something that changes data, started by one entry point, command, endpoint, handler, or loop: "Read a repository", "Describe files", "Advance one simulation tick". It reads some data and writes other data. About 6 to 15 operations cover a typical repository; cover every working system rather than stopping after one or two entry points, and merge near-duplicates.
Supporting work gets one operation per kind, not one per area: all the tests in one operation ("Run the tests", a step per area tested), the docs in one, and the build and dev tooling in one.

How to write an operation, as a process sheet:
- "steps": 3 to 8, in order, in plain words, each saying what happens to which data ("Read every file and its imports into the snapshot"). No function, class, or file names in the text. Tie every step to the files that do it with "files" (they are the evidence, not the subject), and do not leave files in the operation untied to any step.
- "reads" and "writes": the data it takes in and puts out. Check each against the code: data is written only if the code stores, mutates, or sends it.
- "rules": only what the code enforces or clearly intends ("All or nothing: one problem refuses the whole change"). Leave it out when unsure; never invent a rule.
- "summary": one sentence on what it is for.
Read the whole overview, find where work starts (entry files, endpoints, commands, handlers, loops) and follow what each calls, and read the files before you describe them. Every described file must end up in an operation's steps or in a data entry's files, tests and docs included.

Save with apply, in one batch, under "concepts" (merged by name; null removes one; a field set to null is removed; a list replaces the old list). Every file named must be a file in the repository:
{
  "concepts": {
    "data": {
      "Source files": { "summary": "The repository's own text files, as the person wrote them.", "layer": "repo", "files": ["src/repo/Repo.ts"] },
      "Snapshot": { "summary": "Every file and its imports, read once and reused.", "layer": "repo", "files": ["src/repo/Snapshot.ts"], "rules": ["Rebuilt when any file's stamp changes."] }
    },
    "operations": {
      "Read a repository": {
        "summary": "Lists a folder's files and imports.",
        "reads": ["Source files"], "writes": ["Snapshot"],
        "steps": [ { "text": "List every readable text file, skipping ignored ones.", "files": ["src/repo/Repo.ts"] },
                   { "text": "Work out which files import which.", "files": ["src/repo/Graph.ts"] } ],
        "rules": ["A symlink never leads outside the folder."]
      }
    }
  }
}
Declare data before an operation reads or writes it, in the same batch or earlier. Data an operation still uses cannot be removed. Repeat until "remaining" is 0, then check "review" and fix any real gaps (oversized data, import divergences, near-duplicate operations, or missing summaries) in at most two review passes.`
}
