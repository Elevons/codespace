# Codespace

A small 3D code map that can be pointed at any repository. It lists the files and
draws their folder tree and imports as a city you can orbit.

## Run it

```sh
npm install

# Compile the browser code in public/ to JavaScript (the output is git-ignored).
npm run build

# Serve the map at http://localhost:5190, reading the repository live.
# npm start runs the build step for you first.
npm start -- --repo /path/to/repo
```

`--repo` defaults to the current folder. `CODESPACE_REPO`, `PORT`, and `HOST` do
the same from the environment.

Add `--allow-writes` (or `CODESPACE_ALLOW_WRITES=1`) to accept changes from other
machines too — needed when you watch from a laptop over the network or through a
proxy such as Tailscale Serve. Without it, only this machine can change anything.

A big repository draws only the files that already have an architecture entry until it is
fully described — the *Undescribed: hidden* button in the bottom bar draws them all.

## Using the map

- **Find anything.** Press `/` or Ctrl/Cmd+K and type part of a file path, folder, or
  declared function; Enter flies to it and opens its code. Esc closes the search.
- **Click a block** to trace a folder, or a box to see the file's symbols, line counts,
  and what it uses. The breadcrumb at the top walks back up.
- **Filter by role.** Click a tag in the legend to dim everything that does not carry it;
  click it again (or Esc) to clear.
- **Colour by** tags, layers, folders, size, or recent changes. *Changes* colours each file
  by the lines it has changed since HEAD, and the changes endpoint needs the map to be
  reading a git checkout with `git` on the machine.
- **Stand back.** *Layer gap* pulls the layer planes apart; *Extras* shows tests, docs,
  and scripts; hidden folders can be toggled in the Folders panel. *Glow* switches bloom
  (the page's only post-processing pass) off if a slow machine wants the frames back;
  a software renderer starts with it off and at a slightly lower resolution.
- **Keys:** `Space` spin · `F` frame the chosen block · `[` `]` step through a folder's
  files · `R` reset · `Esc` clear · `?` shortcut card.
- **Point it somewhere else.** *Repo* in the bottom bar opens the folder picker: walk the
  machine's folders with *Up* and the list, type a path (`~/` works), or pick a recent
  repository. Opening another one reloads the map onto it, and the agent prompt it copies
  names the new path, so an agent can describe it without restarting anything.
- **Share a view.** The chosen file is kept in the address bar (`#public/main.ts`), so a
  reload or a pasted link opens the same place.

While *Live* is on, the 15-second poll redraws the map after edits. A file whose line
count changed gets a green ring on its folder's floor, so an agent's progress is visible
without refreshing.

## What is here

- `src/repo/Repo.ts` — reads a folder as a repository: file list, safe reads, ignored
  folders, and a cheap change fingerprint.
- `src/server/Server.ts` — the page, the file list, the source API, the changed-line counts, the change fingerprint, and switching repositories.
- `src/server/Workspace.ts` — the repository being read, and the recent ones the page can switch back to.
- `src/repo/Architecture.ts` — reads, checks, and safely changes a repository's `.codespace/architecture.json`.
- `src/server/Api.ts` — the endpoints the page uses: the architecture, the import graph, the ingest status, and what the map shows.
- `src/server/View.ts` — what the map is asked to show, streamed to every open page.
- `src/repo/Graph.ts` — the imports between code files, relative for TypeScript and
  JavaScript and by namespace for C#, for the tools.
- `src/repo/Ingest.ts` — what an agent reads next to describe a codebase: files without a summary, then folders.
- `src/server/Guard.ts` — who may change anything: this machine only.
- `src/cli/Cli.ts` — the commands an agent runs to describe a repository, with no server or MCP.
- `public/index.html` — the map page: the scene and its controls.
- `public/main.ts` — the entry: pointer interaction, the render loop, and boot.
- `public/state.ts` — the shared world: constants, the Babylon scene, and the live state.
- `public/repo.ts` — reads the live repository into nodes and edges.
- `public/city.ts` — lays out the map as a treemap: each folder a tile, each file a box of the same footprint, as tall as its line count.
- `public/meshes.ts` — builds the boxes and grid, and moves the camera.
- `public/highlight.ts`, `public/edges.ts`, `public/labels.ts`, `public/route.ts`, `public/pads.ts` — the selection glow, the import strands, the names, the route lane, and the layer rings.
- `public/view.ts` — the Showing panel, and what tools ask the map to light up or focus.
- `public/repo-switch.ts` — the Repo picker: open another folder, list recent ones, and show how much is left to describe.
- `public/panels.ts` — the summary, info, folders, and legend panels, the breadcrumbs, and the highlighted code view.
- `public/controls.ts` — the buttons, search, keyboard shortcuts, colour menu, live poll, and refresh.
- `public/style.css` — the page styles.
- `public/types.ts` — the shapes the page shares between its modules: the folder tree, each file's record, and what a tool asks to show.
- `public/babylon.d.ts` — the slice of the Babylon.js global the page uses, so the browser code type-checks.
- `tsconfig.web.json` — the compiler settings for the browser code; `npm run build` compiles `public/*.ts` to `.js` beside them.
- `AGENTS.md` — what a coding agent should know first: the commands, the architecture-file rule, and the ingest loop.
- `docs/review-rubric.md` — the code-health review rubric.
- `docs/FUTURE.md` — ideas deliberately deferred, written so they can be picked up later.
- `docs/architecture.md` — the architecture file: its fields, the tag vocabulary, and the rules for generated code.
- `.codespace/architecture.json` — this repository's own layers, tags, and summaries, which the map reads.

## Ingesting a codebase from an agent

Any coding agent with a shell can describe a repository. There is no MCP server and no client
to install: `src/cli/Cli.ts` reads the repository, writes its architecture file, and the map
picks the change up while it runs.

```sh
# which repository, and how much is left to describe
node --experimental-transform-types src/cli/Cli.ts status --repo /path/to/repo

# the next files (or folders) with their source, imports, and importers
node --experimental-transform-types src/cli/Cli.ts next --repo /path/to/repo --size 12

# write each batch back: a JSON file, or - to read it from stdin
node --experimental-transform-types src/cli/Cli.ts apply --file batch.json --repo /path/to/repo
```

`apply` takes the same shape the architecture file uses:
`{"files": {"src/a.ts": {"summary": "...", "tags": ["core"], "layer": "base"}}, "folders": {"src": {"summary": "..."}}}`.
Repeat `next` then `apply` until `next` reports `"remaining": 0`; folders come last. Generated
and vendored files are summarized for you and never handed back. `--size` is at most 40.

Every batch is written as soon as it is applied, so there is nothing to save afterwards and an
interrupted run picks up where it stopped. A batch only ever holds files and folders that still
lack a summary, so re-running never overwrites what is already written, by hand or otherwise.
The file does not exist until the first batch is written; opening a repository creates nothing.

`AGENTS.md` here spells the loop out for an agent working in this repository. For another one,
the Repo picker's **Copy agent prompt** hands over the same commands with that repository's path
filled in. Codespace has no model of its own: writing summaries and tags is judgment, which the
agent does.

Changes show up in every open page at once. Reading is open, like the rest of the map, but
anything that changes something is accepted only from this machine and only when Codespace
is reached as `localhost`, even though the server listens on the network, unless it was started
with `--allow-writes`.

## How it draws the city

The page reads the repository live from `/api/files` and `/api/source`, following
the repository's own `.gitignore` (and a built-in list when it has none) to skip
what git ignores. Each folder becomes a tile holding its files, and every file is a box of the
same footprint, as tall as its line count. Imports between folders are drawn as strands
that follow the folder tree, so imports between the same regions gather into bundles;
selecting a file draws its own imports directly. A reload — or the 15-second poll — redraws it as the code changes.

The poll first asks for a change fingerprint (a hash of the file list and each file's size and
modification time); when it has not moved, the map reads no source at all. Imports and pale
pillars are batched into line systems, the strands and labels redraw at a capped rate while
boxes move, and a settled map rebuilds nothing.

## Limits

Import edges are read from TypeScript and JavaScript, by relative specifier, and from
C#, by namespace. Other languages are shown but their imports are not resolved yet.
The map reads one repository at a time.
