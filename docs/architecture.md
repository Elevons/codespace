# The architecture file — telling the map what the code is for

The folder tree says *where* code lives. The architecture file says *what it is* and *how
it is layered*, in one place, so the map can show role and layer instead of only nesting.
It lives in the repository being mapped, at `.codespace/architecture.json`, and the code
itself carries no marker comments: changing the architecture means editing this file, not
the code.

```json
{
  "layers": ["model", "repo", "api", "render", "panels", "shell", "entry"],
  "systems": {
    "browser": { "summary": "The page: the 3D city and everything drawn and driven in the browser." },
    "server": { "summary": "The server side: reading repositories and serving the map." }
  },
  "files": {
    "public/main.ts": {
      "system": "browser",
      "layer": "entry",
      "tags": ["entry"],
      "summary": "Boots the page: pointer interaction, the render loop, and the first load."
    },
    "src/server/Server.ts": {
      "system": "server",
      "layer": "entry",
      "tags": ["entry", "io"],
      "summary": "Serves the page, its assets, Babylon, and the API over HTTP."
    },
    "src/repo/Repo.ts": {
      "system": "server",
      "layer": "repo",
      "tags": ["core", "io"],
      "summary": "Reads a folder as a repository: lists its files and reads source safely."
    }
  },
  "folders": {
    "src/repo": { "summary": "Reads and checks a repository: its files, imports, and architecture." }
  }
}
```

`entry` is used by both systems here; `repo` belongs to one. A system's secondary layers are just
the layer names its own files use, and another system may share any of them.

The map reads it live: the server watches the file, so saving it redraws every open page at
once, without a reload; a change made while the page is closed is there when it loads. A
repository without one still draws, with layers coloured by folder. The Repo
panel can delete this folder whole, so a repository can be described again from nothing.

## Fields

| Field | Means |
| --- | --- |
| `layers` | The layer names, bottom plane first. Each is drawn as a plane. Layers are shared. |
| `systems` | An object keyed by system name, each with a `summary`. A system groups files; it does not own layers. Optional. |
| `files` | An object keyed by repository-relative path, with forward slashes. |
| `folders` | An object keyed by folder path, each with a `summary`. The repository root is not one. Optional. |
| `concepts` | An object with `things` (the data, keyed by name, each with a `summary`, the `layer` it is held on, and `rules`) and `operations` (keyed by a plain name, each with a `summary`, the `files` it lives in, the things it `reads` and `writes`, ordered `steps` of `{text, files}` in plain words, and `rules`). The map's concept zoom (Space) draws them: things float at their layer's height, wired to the operations that read (dashed) and write (solid) them, and an operation opens as a process sheet. Optional. `apply` edits it with the same all-or-nothing validation (merged by name, `null` removes one, a list replaces the old list); the `concepts` command hands out what is left to write. |
| `system` | The system the file belongs to. One system can use any number of shared layers. |
| `layer` | The file's level or role in the stack — its job, not its system or folder. Its box rises to that layer's plane. |
| `tags` | The file's roles, primary first. The first tag sets its colour. |
| `summary` | One plain sentence on what the file is *for*: what it does and why it exists, not how. At most 2000 characters. |
| `notes` | What the file's declarations are for, by name: `Name`, `Class.member`, and a function's steps as `Name:1`, `Name:2`. The block rail shows them. Explanations live here rather than as comments in the code; `lift-notes` moves existing JSDoc and `//>` comments here. Each note is at most 2000 characters. |
| `folders` entry | A `summary` saying what the folder's contents are for, written once its files and folders are described. |

Every field is optional to the reader: a file with no entry is read as one with no system, layer, or
tags. The map shows only described files by default; the *Described only* toggle in the Outliner's
grouping menu draws the rest, and those files then sit on the ground, uncoloured by role.
The describe loop is stricter — it hands back any ordinary file that lacks a summary, a system, a
layer, or tags (`Architecture.Lacks`). Generated and vendored files are the one exemption:
`Ingest.SkippedSummary` settles each with a summary alone (for example `package-lock.json` and
`.codespace/architecture.json` here), so they carry no system, layer, or tags. The architecture file
also covers only readable text files: tracked root files with no extension, such as `.gitignore` and
`.env.example`, are outside it and need no entry.

## The tag vocabulary (fixed for colour; unknown tags are kept but drawn grey)

The vocabulary and its colours are defined once in `public/tags.ts`; the server imports it too, so
the two trees cannot drift.

| Tag | Means |
| --- | --- |
| `entry` | a process, request, or command starts here |
| `orchestrate` | coordinates others; holds little logic itself |
| `core` | the substantive logic |
| `data` | types, schemas, records, fixtures |
| `io` | touches the world: disk, network, clock, process |
| `ui` | presentation |
| `config` | settings and constants |
| `test` | tests and fixtures |

## Rules for generated code

1. When you add a file, add its entry to `.codespace/architecture.json` in the same change, or
   run `node --experimental-transform-types src/cli/Cli.ts apply`, which validates the change and redraws the map.
2. When you move or rename a file, move its entry's key to the new path. An entry for a
   path that no longer exists is ignored, and the info panel warns about it.
3. Draw tags from the vocabulary above; a tag outside it is accepted and stored, but drawn grey.
   Systems must come from `systems`, and layers from `layers`. A layer may appear in more than one system.
4. Keep summaries to one sentence.
5. A repository keeps its own entries true: `Cli.ts install` leaves a marked note in its `AGENTS.md`
   (or `CLAUDE.md`) and the full rules in `.codespace/README.md`, so whoever changes the code updates
   the entry in the same change. `Cli.ts refine` is the second pass over a described repository: it
   lists imports that point up the layers, files that would sit in fewer breaks on another layer, files
   whose imports are mostly in another system, and layers or systems that look wrong as a whole.
   The ingest is incremental: `Cli.ts apply` records each file it names in `.codespace/ingested.json`
   (a hash, size, and time, git-ignored), so `next` can hand back files that changed since their entry
   was written, and `Cli.ts sync` carries an entry along with a file that was moved (same text) and drops
   entries for files that are gone.
6. Entries can be written by an agent in batches: `node --experimental-transform-types src/cli/Cli.ts next` hands back the
   files and folders still missing a summary, a system, a layer, or tags, and `apply` writes
   them back. Declare the systems and layers first; a system or layer not listed is refused.
   Generated and vendored files are summarized for it, so it does not spend effort on lockfiles
   or built output.

## What the map does with it

- Boxes are coloured by their first tag by default; the Colour menu can colour them by system,
  layer, folder, size, or recent changes.
- Each layer is a translucent plane with a coloured outline; files rise to their layer, and a
  vertical line ties each lifted file to its folder. Because layers are shared, one plane can
  hold files from several systems.
- The Outliner is a filter strip over one tree. The strip lists every system and layer with a
  live count; clicking a chip hides or shows that value (double-click or double-tap shows only it,
  and again brings every value back), and the selected systems
  and layers together decide which files the scene draws. Switching a system on also switches on
  the layers its files need when the selected layers would leave it empty, and the same for a layer
  and its systems, so one strip never locks the other out; such a chip is dotted until clicked. A
  chip with nothing to draw at all (the eyes or the tag filter hide every file in it) is dimmed and
  cannot be switched on, though a selected one can always be switched off. Non-matching files, then the folders and
  layer planes left empty, are not drawn. The tree lists each folder once, or flattens files under
  system or layer groups with the *List by* switch. A group's caret folds it (Alt folds everything
  inside); clicking a folder row chooses that folder, and clicking it again folds it. A folder's eye
  hides or shows every file beneath it, whatever hid them, and shows a half state when only some are
  drawn; a file's own eye hides or restores that one file, even inside a hidden folder. Folding every
  group keeps open any folder above an eye-hidden file or folder, so a hidden row can always be found
  again. The search
  takes several words, each of which must match a file's path or one of its symbols. Every file row
  carries a tag badge and a system dot and layer dot in the strip's colours. The tree can be driven
  from the keyboard: arrows move and fold, Enter chooses, Shift+Enter opens the source, Space flips
  the eye. The chevron at the right of the header puts the whole outliner away, leaving a narrow tab
  at the screen edge to bring it back; the choice is remembered, and `/` brings it back to focus the
  search. Until a repository declares systems, the System chips and grouping stay hidden.
- On a phone (a screen 720px wide or less) the map fills the screen and a tab bar along the bottom
  opens one sheet at a time: Files (the search and the tree, where tapping a folder folds it),
  Filters (every system and layer as a large tile, the tag filter, and the view options), Details
  (what is chosen), and View (the map's controls as big buttons). `public/mobile.ts` moves the same
  panels into the sheet rather than copying them, and puts them back on a wider screen. Choosing a
  file closes the sheet so the map can glide to it, and a strip above the tabs names the choice;
  dragging the sheet's handle down closes it.
- Shift-clicking a file, in the Outliner or on the map, adds it to the selection; shift-clicking it
  again takes it out. The first file chosen stays open as its block stack, the others are listed
  under it, and the map draws the import traces of every selected file. A tool can choose a set the
  same way with `{"action": "select", "files": [...]}`.
- A shown route draws the imports between its own files as thin blue wires under the green steps, so
  the route is also a line graph; opening a step adds that file's own wires beside it. Choosing a
  file frames its box and block stack together, and choosing one of its blocks frames that floor,
  so a small box, a tall stack, or a thin block is close enough to read.
- An import that points up the layers (a lower layer using a higher one) is a thin red line
  on the folder plates, from the importing file's tether foot to the imported file's.
- A tool can ask the map to show files with an explanation of each, which appears in the
  Showing panel, and can isolate an ad-hoc set of files so only they and their folders are
  drawn; the Outliner names the isolation in a chip whose cross removes it. See the README's
  section on ingesting a codebase from an agent.
- Live notices a file edited on disk and flashes its box at full brightness, fading over about a
  second and a half, so a save is visible without hunting for the file. The flash uses each file's
  own size and modified time, sent with the graph, so it works outside git too.
- The info panel shows the chosen file's summary, or each file's when a folder is chosen, and
  lists problems found in the architecture file: invalid JSON, entries for files that are gone,
  and systems or layers a file names that the file does not declare.
- Choosing a file opens its **file box** into a **block stack**, read from the file itself when it
  is opened: one **floor** per block, in the block's kind colour, in reading order, standing on the
  box's own footprint and reaching 1.5× its height. The cube shrinks to the lowest block and becomes
  it, then the rest of the blocks grow upward from its top. A block is
  an import run, a run of constants or types, a function or class, or a **section** of a long
  function cut at the comments that lead its steps. The block rail in the info panel lists the same
  blocks with their line ranges and a summary: the block's note in the architecture file first, then its own
  comment (an open block also lists its members' and steps' notes); a block with neither
  starts with a plain description of its shape, and the model writes a sentence for it as the file
  opens (kept in memory for the session, and skipped when no model is configured). Choosing a rail
  row or a floor opens that block's lines; the import wires its text names stay bright and start
  at that floor, while the rest fade back. An import into an open file lands on the block that
  declares the name the importing file takes, so an amber wire meets the exported block itself. Only the notes about blocks are stored in the architecture file,
  and no pass reads a whole repository for them. The open file's import wires end on the block that
  carries them rather than on the middle of its box. The words are defined in `docs/GLOSSARY.md`.
- `.codespace/` is part of the repository, so it is on the map like anything else, as an
  extra: hidden until you turn Extras on, along with `docs` and `tests`.
