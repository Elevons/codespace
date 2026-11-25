# Working in this repository

Codespace is a small 3D map of a codebase: a Node server reads one repository and
serves a Babylon page, plus a small CLI that agents use to describe a repository and
write its architecture file. The page has a chat built in: a pi agent that uses the same
CLI and map API. There is no MCP server to connect.

## Commands

```sh
npm install
npm run build        # compile public/*.ts to .js beside them (git-ignored)
npm start -- --repo /path/to/repo   # build, then serve http://localhost:5190
npm run typecheck    # both tsconfigs, no emit
npm test             # node --test over tests/*.test.ts
```

Node 22.19 or newer is required. Local edits are read live; `npm run build` is only
needed after touching `public/*.ts`.

## The one rule that matters

`.codespace/architecture.json` describes this repository to the map. **When you add,
move, rename, or repurpose a file, update its entry in the same change**, by editing the
file or with `src/cli/Cli.ts apply` (all or nothing; it validates and reports problems).
The file has:

- `layers` — bottom plane first (`config`, `docs`, `model`, `repo`, `api`, `render`,
  `panels`, `shell`, `entry`, `tests` here). Layers are shared, so one layer can hold files from several systems.
- `systems` — keyed by name (`browser`, `server`, `meta` here), each with an optional `summary`.
  A system groups files; it does not own a private layer list.
- A layer is a file's level or role in the stack — its job — not its system and not its folder.
  One system's files normally land on several layers. If every file in a system lands on one
  layer, or a layer's name repeats a system's name, the layering is wrong. The map groups and filters by
  system and layer in its Outliner, and the filter strip narrows the 3D scene to the selected
  values; until a repository declares systems, those controls stay hidden.
- `files` — keyed by repository-relative path: optional `system`, `layer`, `tags`, `summary`, and `notes`:
  what the file's declarations are for, by name (`Name`, `Class.member`, and a function's steps as `Name:1`,
  `Name:2`). Notes are where explanations of the code live, **not comments in the code**: do not add JSDoc
  summaries or step-by-step comments to source files; keep code comments to a short *why*. `apply` merges
  notes by name (null removes one; `replaceNotes: true` replaces them all). Every summary and note is at most
  2000 characters.
- `folders` — keyed by folder path: optional `summary`.
- `concepts` (optional) — what the code does, above the files: `data` (what is kept or passed, keyed by name)
  and `operations` (what changes the data, keyed by a plain name such as "Read a repository", each with a
  `summary`, the `files` it lives in, the data it `reads` and `writes`, ordered plain-word `steps`
  `{text, files}`, and `rules`). Each data entry has a `summary`, the `layer` it is held on, the few `files` that
  define or hold it (drawn in a cluster under its hexagon), and `rules`. A file written before the rename that
  still says `things` is read as `data`, and is rewritten with the new key on the next apply. Space, or the
  Concepts button, zooms the map out to them: each operation's files gather into one column, and each data
  entry is a hexagon floating at its layer's height, wired to the operations that read (dashed) and write
  (solid) it. A key in the corner says which shape is which. Clicking an operation opens its process sheet
  (In, Steps, Out, Rules); a step points at its files. The map names nothing until an item is hovered or chosen; then
  it names that item and what it touches. With nothing chosen the sheet is the index of every operation and data entry
  (open on a wide screen, folded on a phone), and hovering a row names it on the map. Choosing a file in this view opens its
  details without leaving it. Choosing a data entry traces it: its writers and readers stay lit, its links draw bright, and its sheet lists
  "Comes from" and "Goes to" with the steps that touch its files. The Outliner's system and layer filters narrow the
  design too: operations with no drawn file and data nothing remaining touches fade to ghosts and leave the
  folded index ("showing 4 of 17 operations"). Files nothing names gather under "Not in an operation". `apply` edits the section
  (merged by name, `null` removes, same validation), and `concepts` hands out the work, like `next`: first
  every described file, paged (`--page N`), with nothing picked out, so the agent decides what the data and
  operations are; then the operations and data still missing steps, reads/writes, a layer, or files; then
  every described file nothing names yet, until each is in an operation's steps or a data entry's files; then the operations
  and data whose files changed since they were written (`reason: "changed"`; `apply` stamps every file an entry
  names in `.codespace/ingested.json`, entries written before stamps count as current; re-apply the entry,
  rewritten if it no longer fits); then a review. There is no separate button for
  it: Ingest Codebase (and Update Map) writes the files, refines the layers, then runs this pass, and the
  Repo panel's status counts what is left of the design.

Tags come only from: `entry`, `orchestrate`, `core`, `data`, `io`, `ui`, `config`,
`test`. Other tags are accepted and stored, but drawn grey. Summaries are one plain sentence
about what a thing is *for*, not how it works.
Write folder summaries once the files and folders inside them are described. Keep it
in sync with `docs/architecture.md`, which is the full explanation.

## Describing a repository

`src/cli/Cli.ts` reads a repository and writes its architecture file; it needs no server and
no MCP. Every command takes `--repo <folder>`, which defaults to `CODESPACE_REPO` or the
current folder.

```sh
node --experimental-transform-types src/cli/Cli.ts repo --repo .
node --experimental-transform-types src/cli/Cli.ts status --repo .
node --experimental-transform-types src/cli/Cli.ts next --repo . --size 12
node --experimental-transform-types src/cli/Cli.ts apply --file batch.json --repo .
node --experimental-transform-types src/cli/Cli.ts concepts --repo . --size 8   # the concepts pass
```

`next` prints the files (or folders) that still need describing, with their source, imports,
and importers, and says what each one's entry still lacks in `missing`. Write each entry to a
JSON file shaped like
`{"files": {"src/a.ts": {"summary": "...", "system": "server", "tags": ["core"], "layer": "repo"}}, "folders": {"src": {"summary": "..."}}}`
and pass it to `apply`. **Every ordinary file entry needs a summary, a system, tags, and a layer.**
Generated and vendored files are the exception: `Ingest.SkippedSummary` settles them with a summary
alone (`package-lock.json` and `.codespace/architecture.json` here), so they never need the other three. The
architecture file covers the repository's readable text files; tracked root files with no extension,
such as `.gitignore` and `.env.example`, are outside it and need no entry. A system
and a layer must already be declared, so if the file has none yet, declare them in the first
apply — for example `{"systems": {"browser": {}}, "layers": ["model", "render", "entry"]}` — before
entries can name them. Layers are shared by every system, so a layer may span systems.
`next` also hands back files that have a summary but no system, layer, or tags, so fill those in too.
Repeat until `next` reports `"remaining": 0`; folders come last.
Generated and vendored files are settled for you and never handed back. `--size` is at most
40. Each `apply` writes immediately, so a stopped run picks up where it left off.

The same loop updates a repository that was described before, so run it on demand whenever the code has
changed: `next` only hands back what needs work. Each file in a batch has a `reason`: `new`, `changed` (its
text is not what its entry was written from, with the entry as `current`), or `incomplete`. For a changed
file, read it again and apply its entry once more, rewritten if it no longer fits, so it is not offered
again. Before it reads anything `next` runs `sync`: an entry follows a file that was moved (same text, new
path) and an entry for a deleted file is dropped. `apply` records each file it names in
`.codespace/ingested.json` (git-ignored, per machine), which is how a change is noticed.

`lift-notes` moves explanations already written as comments into notes: every JSDoc comment (`/** … */`) and
every step comment (`//>`) in a repository's TypeScript and JavaScript files becomes a note in its entry and is
taken out of the code; other comments stay. `--dry-run` only counts them. Run it once on a repository written
with comment-heavy rules, then remove those rules from its instructions.

Three more commands finish the job:

```sh
node --experimental-transform-types src/cli/Cli.ts sync --repo .      # entries follow moved files; drop deleted ones
node --experimental-transform-types src/cli/Cli.ts install --repo .   # once, before the first batch
node --experimental-transform-types src/cli/Cli.ts refine --repo .    # the second pass, after "remaining": 0
node --experimental-transform-types src/cli/Cli.ts lift-notes --repo . # move JSDoc and //> comments into notes
```

`install` leaves the upkeep rules in the repository being mapped: a short marked block in its `AGENTS.md`
(or `CLAUDE.md`, if that is the one it has), and the full rules in its `.codespace/README.md`, so any agent
that later works there keeps `architecture.json` true in the same change. It is safe to run again.
`refine` is the second pass: it checks the layers and systems against the imports and prints the imports
that point up the layers (the map's red lines, grouped by pair of layers), files that would sit in fewer
breaks on another layer, files whose neighbours are mostly in another system, and layering problems. It
decides nothing; read the files it names, then `apply` the layer, system, and file changes it calls for, and
run it again. A `tests` layer belongs at the top, since tests import what they test.

The page's Repo panel shows the current repository and its absolute path, and copies these
commands with the path filled in. It can switch repositories at runtime. The server accepts
writes from this machine and localhost, or from anywhere with `--allow-writes`.

## Showing things on the map

When the user asks you to show, trace, or walk through code on the map ("put it on the board",
"trace how X happens"), drive the running server's HTTP API at `http://localhost:5190`. Every open
page updates at once. Paths are repository-relative, as `GET /api/files` lists them. Check which
repository the server is reading first (`GET /api/repo`); switch it if it is the wrong one.

```sh
curl -s -X POST localhost:5190/api/view -H 'Content-Type: application/json' -d @board.json
```

`POST /api/view` takes one of five actions:

- **`show`** — light up files, with a note on each, and optionally draw them as a route:
  ```json
  {"action": "show", "trace": true, "title": "How a request is served",
   "note": "One or two sentences on the whole process.",
   "files": [{"path": "src/server/Server.ts", "note": "What happens here, at this step."},
             {"path": "src/server/Api.ts", "note": "..."}]}
  ```
  With `"trace": true` the files are numbered steps in the order given: the map lifts them into a
  row along the front of the city, joins each step to the next with a strand, and lists the steps
  in a numbered rail beside them and in the Showing panel. A file may appear in more than one
  step, each with its own note, when a process comes back to it. Without `trace` the files are
  simply highlighted as a set. A plain path string works in place of `{"path", "note"}`. Each
  step is one file, so name the function or method in its note (`Table.UpdateNeeds drains ...`).
  Limits: 1000 files, 2000 characters per file note, 120 for the title, 2000 for the overall note.
  While a route is shown, the imports between its files are drawn too, as thin blue wires, so the
  route reads as a line graph and not only a chain; opening a step shows its own wires beside it, only to
  the route's other files, and the Showing panel lists, under each step, its layer, system, and tags and which
  other steps it uses and is used by.
  The reply is `{"ok": true, "shown": n, "unknown": [...]}`; any path in `unknown` was not drawn,
  so fix it and send again.
- **`focus`** — `{"action": "focus", "path": "src/repo"}` selects a file or folder and moves the
  camera to it; an empty path is the repository root.
- **`isolate`** — `{"action": "isolate", "files": ["src/a.ts", "src/b.ts"]}` draws only those
  files and hides every other file and the folders left empty, as an ad-hoc filter; the Outliner
  lists only them. It is how "highlight only the changed files" becomes "isolate them": call
  `show` with the same paths first if they should also be lit. An empty `files` list removes the
  isolation. A new `isolate` replaces the last one. The reply is
  `{"ok": true, "isolated": n, "unknown": [...]}`; fix any path in `unknown` and send again.
- **`select`** — `{"action": "select", "files": ["src/a.ts", "src/b.ts"]}` chooses several files at
  once, as shift-clicking them does: the first opens its block stack, the rest join the selection,
  and the map draws the import traces of every selected file. It clears whatever was shown first,
  so the traces are visible. A new `select` replaces the selection. The reply is
  `{"ok": true, "selected": n, "unknown": [...]}`; fix any path in `unknown` and send again.
- **`clear`** — `{"action": "clear"}` takes down whatever is shown.

A new `show` replaces the last one, a new `isolate` replaces the last isolation, and a new `select`
replaces the selection; `clear` does not remove an isolation or a selection. `GET /api/view` returns
`{"shown": <what is shown>, "isolated": <paths or null>, "selected": <paths or null>}`.

On the page, shift-click a file row in the Outliner, or a file box on the map, to add it to the
selection or take it out. The file chosen first stays the one whose block stack is open; the rest
are listed under it, with a cross to remove each one.

### Insights: recent work, flows, history, and a health check

The bottom bar's **Start here**, **Changes**, **Flows**, **History**, and **Health** buttons open one panel with
four tabs (Start here draws the tour and opens Flows); on a phone the panel has its own Insights tab
in the tab bar. Each answer is also an endpoint:

- **Recent** lists `/api/changes` — each file changed since `HEAD`, with its line count — and
  can show or isolate them. Nothing new is read for it.
- **Flows** are saved views: a name, a title, a note, and files in order with a note each, kept
  at `.codespace/flows.json` in the repository they describe, so a flow travels with the repo and
  is drawn the same way on every page. `GET /api/flows` lists them; `POST /api/flows` with
  `{"action":"save","flow"}`, `{"action":"show","name"}`, or `{"action":"delete","name"}` keeps,
  draws, or removes one. `GET /api/flows?draft=1` drafts a **start-here tour** from the
  descriptions: the files tagged `entry` first, then their imports, one step per file, with each
  step's note taken from that file's summary. Save it as `start-here` to keep it. A flow's paths
  are checked against the repository whenever it is saved or shown, so it never lies about a file
  that has gone.
- **History** is `GET /api/history`: the last 400 commits of `git log`, oldest first, each with its hash,
  date, subject, and the files it touched, named as they are today (a renamed file is credited to its
  current path, and deleted files are left out). The History tab scrubs through them: the map is
  coloured by history while the tab is open (also the Colour menu's History), files not yet born are
  dark, a file the commit touched is red and cools to blue over ten commits, and a play button steps
  through. Outside git the list is empty.
- **Health** is `GET /api/health`: the size of the codebase, the files still undescribed, the
  imports that go up the layers (the same rule as `refine`), the largest files, and values that
  look like keys in files a browser can read. The secret scan is a pattern, not proof: a key that
  is public on purpose is reported too. It decides nothing; each item is a place to look.

A **neighbourhood** is `GET /api/neighbours?path=…&depth=1|2`: the file, what it imports, and
what imports it, ordered by distance. The file panel's Neighbourhood button isolates that set —
the honest answer to "what does this part of the app touch" without guessing at frameworks. With
several files selected, the file panel's **Only these** isolates the selection and **Show as set**
lights it up.

The page's own buttons change the view through `public/viewcall.ts`: a `POST /api/view`, so every
open page follows, or, when a host serves the map read only and refuses that write (Bartleby's
framed board does), the same change made in that page alone. Saving or deleting a flow needs a
write, so a read-only page says so instead.

Reading, for finding the right files and steps before you show them:

| Endpoint | Returns |
| --- | --- |
| `GET /api/repo` | the repository being read (`name`, `root`) and recent ones |
| `POST /api/repo` | `{"path": "/abs/folder"}` switches the map to another repository |
| `GET /api/files` | every repository-relative file path the map knows |
| `GET /api/architecture` | the architecture file: layers, systems, and each file's summary, tags, and layer |
| `GET /api/graph?folder=src` | the import edges, optionally only those under a folder |
| `GET /api/neighbours?path=src/a.ts&depth=1` | one file and the files around it, by one or two steps |
| `GET /api/source?path=src/a.ts` | one file's text |
| `GET /api/blocks?path=src/a.ts` | one file's blocks: its declarations and groups, each with a summary, a kind, a line range, and the blocks it refers to |
| `GET /api/changes` | each file changed since `HEAD`, with how many lines changed |
| `GET /api/history` | the repository's last 400 commits, oldest first, with the files each touched |
| `GET /api/health` | the codebase's size, largest files, layer breaks, undescribed files, and key-shaped values |
| `GET /api/flows` | the saved flows; `?draft=1` drafts a start-here tour instead |
| `POST /api/flows` | `{"action":"save","flow"}`, `{"action":"show","name"}`, or `{"action":"delete","name"}` |
| `GET /api/ingest/status` | how much is left to describe and to refine |
| `POST /api/ingest/next` | `{"size": n}`: the CLI's `next` over HTTP (it can settle generated files, so it is a write) |
| `GET /api/ingest/refine?size=n` | the CLI's `refine` over HTTP |
| `GET /api/tools` | every endpoint above as a tool: name, description, method, path, fixed body fields, and a JSON Schema for its arguments |

Read one file as its blocks when you need to explain how the file itself is put together. Choosing a file
opens its **file box** into its **block stack**: one **floor** per block, on the box's own footprint and
1.5× its height, and the **block rail** in the info panel lists the same blocks with their summaries and line
ranges. Choosing a rail row or a floor frames that block's floor and opens its lines, keeps the import wires its own text
names bright and starting from that floor, and dims the rest. An import into an open file ends at
the block that declares the name the importing file takes, so its wire meets that block rather
than the middle of the file. The blocks are read on demand, when the
file is opened, and never stored: a summary is the block's note in the architecture file, else its own comment,
and an open block's rail row also lists its members' and steps' notes. A block with neither
shows a plain description of its shape first, then `POST /api/blocks/summaries` (a page call, not a tool)
asks the configured model for one sentence, kept in memory for the session; a server with no model leaves
the plain description. The file's own comments are never replaced. Every function and class stays one
block, however long it is. See `src/repo/Blocks.ts`, and `docs/GLOSSARY.md` for these words.

`POST /api/architecture` is the CLI's `apply` over HTTP: same validation, same ledger stamp.

### More than one repository: `?repo=`

Any `/api/` call, and the page itself (`http://localhost:5190/?repo=/abs/folder`), may name a repository with
`?repo=<absolute path>`. That repository is opened beside the server's own, with its own view and event stream,
so pages on different repositories do not move each other's map. A pinned page cannot switch repository, and the
chat stays with the server's own. Opening a new one is accepted only from this machine (as for writes);
one already open is read like the server's own. Up to 16 are held open, the least recently used let go first.
The page reaches the server by relative addresses (`public/endpoint.ts`), so a proxy may serve it under a path.

Start the server with `--no-chat` (or `CODESPACE_CHAT=0`) when a host runs its own agent; the page then hides
the chat and its Ingest buttons. Set `HOST=127.0.0.1` to keep it off the network.

### The tool list

`src/server/Tools.ts` (`MapTools`) is the one list of what an agent can do with the map. `GET /api/tools`
serves it as `{"version": 1, "repoQuery": {...}, "tools": [...]}` so a host such as Bartleby can register each as a tool of its
own that forwards the call (a GET sends the arguments as query values, a POST sends them as the JSON body with
`fixed` merged in), and the built-in chat's endpoint list is generated from it. **When you add or change an
endpoint an agent should use, add or change its entry in `MapTools` in the same change**; `tests/Tools.test.ts`
calls every listed tool through the real server.

Writes (`POST /api/view`, `POST /api/repo`, `POST /api/flows`, `POST /api/ingest/next`, `POST`/`DELETE /api/architecture`) are accepted from
this machine through `localhost` only, unless the server was started with `--allow-writes`; a
refused write answers 403 with the reason.

## The built-in chat

`src/agent/` runs a [pi](https://github.com/earendil-works/pi) agent (`@earendil-works/pi-coding-agent`)
in the repository being mapped, with pi's basic tools, against any OpenAI-compatible endpoint. Its model
comes from `.env` beside `package.json` (git-ignored; see `.env.example`): `CODESPACE_MODEL_BASE_URL`,
`CODESPACE_MODEL`, and a key, given as `CODESPACE_MODEL_API_KEY` or read by name from another env file with
`CODESPACE_MODEL_KEY_FILE` and `CODESPACE_MODEL_KEY_NAME`. What the agent is told lives in
`src/agent/Instructions.ts`; its endpoint list is made from `MapTools`, so a new tool reaches it on its own.
**When the CLI or how the chat should use the map changes, change it there too**, as well as in the sections above. `/api/chat` takes `GET` for the chat and `POST` with `{"action": "send", "text"}`, `"stop"`,
`"new"`, `"describe"` (Ingest Codebase, which describes the files, refines the layers, then writes the
concepts), `"refine"` (Refine layers alone), or `{"action": "open", "id"}`; its progress reaches pages on this
machine as `chat` events on the view stream. Chats and pi's settings live in `~/.codespace/agent`.

## Layout worth knowing

- `src/cli/` — the commands an agent runs to describe a repository, and `Options.ts` for reading their flags.
- `src/repo/` — reading a repository, its architecture file, the import graph, and
  what to ingest next (`Next.ts` is the one `next`, shared by the CLI and the API), and its files'
  blocks on demand (`Blocks.ts`). `Flows.ts` keeps saved views and drafts the tour, `Health.ts` makes
  the health report and the secret scan, and `Neighbours.ts` walks the files around one file. No HTTP in here.
  `LiftNotes.ts` moves JSDoc and step comments out of scripts into notes.
  `DescribeGuide.ts`, `JsonStore.ts`, and `ShowLimits.ts` hold the first-pass instructions, the
  repository-scoped JSON access, and the show limits.
- `src/server/` — the HTTP server, the endpoints, the tool list (`Tools.ts`), the view stream,
  the write guard, and the switchable workspace.
- `src/agent/` — the built-in chat: its pi agent, what that agent is told, and which model it uses.
- `public/` — the browser side: the 3D city, the Outliner with its system/layer filters,
  the panels and controls, the chat, and the phone sheet. `insight.ts` is the Insights panel
  (recent work, flows, health), `viewcall.ts` makes the page's own view changes, and `neighbourhood.ts` isolates the files around one file. `public/endpoint.ts` builds every API address. `public/filter.ts`, `public/rules.ts`, and
  `public/symbols.ts` hold the pure filter, layout/visibility, and symbol rules; `public/blocks.ts` holds
  the block kinds, colours, and the rule that stacks blocks into floors, and `public/floors.ts` draws them;
  `public/flows.ts`, `public/health.ts`, and `public/neighbours.ts` hold the shapes and limits the page and
  the server share; `public/tags.ts` is the one tag vocabulary the server shares.
- `tests/` — one test file per piece of the server side, plus the dependency-free browser
  helpers; run `npm test`.
- `docs/` — architecture file details, the review rubric, and deferred ideas.
