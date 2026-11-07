# Working in this repository

Codespace is a small 3D map of a codebase: a Node server reads one repository and
serves a Babylon page, plus a small CLI that agents use to describe a repository and
write its architecture file. There is no MCP server to connect.

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

The page's Repo panel shows the current repository and its absolute path, and copies these
commands with the path filled in. It can switch repositories at runtime. The server accepts
writes from this machine and localhost, or from anywhere with `--allow-writes`.

## Layout worth knowing

- `src/cli/` — the commands an agent runs to describe a repository.
- `src/repo/` — reading a repository, its architecture file, the import graph, and
  what to ingest next. No HTTP in here.
- `src/server/` — the HTTP server, the endpoints, the view stream, the write guard,
  and the switchable workspace.
- `public/` — the browser side: the 3D city, the Outliner with its system/layer filters,
  the panels and controls, and the phone sheet. `public/filter.ts` and `public/symbols.ts`
  hold the pure filter and symbol rules.
- `tests/` — one test file per piece of the server side, plus the dependency-free browser
  helpers; run `npm test`.
- `docs/` — architecture file details, the review rubric, and deferred ideas.
