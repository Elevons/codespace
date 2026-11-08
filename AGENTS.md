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

- `layers` — bottom plane first (`config`, `docs`, `tests`, `model`, `repo`, `api`, `render`,
  `panels`, `shell`, `entry` here). Layers are shared, so one layer can hold files from several systems.
- `systems` — keyed by name (`browser`, `server`, `meta` here), each with an optional `summary`.
  A system groups files; it does not own a private layer list.
- A layer is a file's level or role in the stack — its job — not its system and not its folder.
  One system's files normally land on several layers. If every file in a system lands on one
  layer, or a layer's name repeats a system's name, the layering is wrong. The map groups and filters by
  system and layer in its Outliner, and the filter strip narrows the 3D scene to the selected
  values; until a repository declares systems, those controls stay hidden.
- `files` — keyed by repository-relative path: optional `system`, `layer`, `tags`, `summary`.
- `folders` — keyed by folder path: optional `summary`.

Tags come only from: `entry`, `orchestrate`, `core`, `data`, `io`, `ui`, `config`,
`test`. Summaries are one plain sentence about what a thing is *for*, not how it works.
Write folder summaries once the files and folders inside them are described. Keep it
in sync with `docs/architecture.md`, which is the full explanation.

## Describing a repository

`src/cli/Cli.ts` reads a repository and writes its architecture file; it needs no server and
no MCP. Every command takes `--repo <folder>`, which defaults to `CODESPACE_REPO` or the
current folder.

```sh
node --experimental-transform-types src/cli/Cli.ts status --repo .
node --experimental-transform-types src/cli/Cli.ts next --repo . --size 12
node --experimental-transform-types src/cli/Cli.ts apply --file batch.json --repo .
```

`next` prints the files (or folders) that still need describing, with their source, imports,
and importers, and says what each one's entry still lacks in `missing`. Write each entry to a
JSON file shaped like
`{"files": {"src/a.ts": {"summary": "...", "system": "server", "tags": ["core"], "layer": "repo"}}, "folders": {"src": {"summary": "..."}}}`
and pass it to `apply`. **Every file entry needs a summary, a system, tags, and a layer.** A system
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

Three more commands finish the job:

```sh
node --experimental-transform-types src/cli/Cli.ts sync --repo .      # entries follow moved files; drop deleted ones
node --experimental-transform-types src/cli/Cli.ts install --repo .   # once, before the first batch
node --experimental-transform-types src/cli/Cli.ts refine --repo .    # the second pass, after "remaining": 0
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

`POST /api/view` takes one of three actions:

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
  Limits: 60 files, 600 characters per file note, 120 for the title, 1500 for the overall note.
  The reply is `{"ok": true, "shown": n, "unknown": [...]}`; any path in `unknown` was not drawn,
  so fix it and send again.
- **`focus`** — `{"action": "focus", "path": "src/repo"}` selects a file or folder and moves the
  camera to it; an empty path is the repository root.
- **`clear`** — `{"action": "clear"}` takes down whatever is shown.

A new `show` replaces the last one. `GET /api/view` returns what is shown now, or `null`.

Reading, for finding the right files and steps before you show them:

| Endpoint | Returns |
| --- | --- |
| `GET /api/repo` | the repository being read (`name`, `root`) and recent ones |
| `POST /api/repo` | `{"path": "/abs/folder"}` switches the map to another repository |
| `GET /api/files` | every repository-relative file path the map knows |
| `GET /api/architecture` | the architecture file: layers, systems, and each file's summary, tags, and layer |
| `GET /api/graph?folder=src` | the import edges, optionally only those under a folder |
| `GET /api/source?path=src/a.ts` | one file's text |
| `GET /api/changes` | each file changed since `HEAD`, with how many lines changed |

Writes (`POST /api/view`, `POST /api/repo`, `POST`/`DELETE /api/architecture`) are accepted from
this machine through `localhost` only, unless the server was started with `--allow-writes`; a
refused write answers 403 with the reason.

## The built-in chat

`src/agent/` runs a [pi](https://github.com/earendil-works/pi) agent (`@earendil-works/pi-coding-agent`)
in the repository being mapped, with pi's basic tools, against any OpenAI-compatible endpoint. Its model
comes from `.env` beside `package.json` (git-ignored; see `.env.example`): `CODESPACE_MODEL_BASE_URL`,
`CODESPACE_MODEL`, and a key, given as `CODESPACE_MODEL_API_KEY` or read by name from another env file with
`CODESPACE_MODEL_KEY_FILE` and `CODESPACE_MODEL_KEY_NAME`. What the agent is told lives in
`src/agent/Instructions.ts`; **when the map API or the CLI changes, change it there too**, as well as in the
sections above. `/api/chat` takes `GET` for the chat and `POST` with `{"action": "send", "text"}`, `"stop"`,
`"new"`, `"describe"` (Ingest Codebase), `"refine"` (Refine layers), or `{"action": "open", "id"}`; its progress reaches pages on this
machine as `chat` events on the view stream. Chats and pi's settings live in `~/.codespace/agent`.

## Layout worth knowing

- `src/cli/` — the commands an agent runs to describe a repository.
- `src/repo/` — reading a repository, its architecture file, the import graph, and
  what to ingest next. No HTTP in here.
- `src/server/` — the HTTP server, the endpoints, the view stream, the write guard,
  and the switchable workspace.
- `src/agent/` — the built-in chat: its pi agent, what that agent is told, and which model it uses.
- `public/` — the browser side: the 3D city, the Outliner with its system/layer filters,
  the panels and controls, the chat, and the phone sheet. `public/filter.ts` and `public/symbols.ts`
  hold the pure filter and symbol rules.
- `tests/` — one test file per piece of the server side, plus the dependency-free browser
  helpers; run `npm test`.
- `docs/` — architecture file details, the review rubric, and deferred ideas.
