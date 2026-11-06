# Codespace

A small 3D code map that can be pointed at any repository. It lists the files and
draws their folder tree and imports as a city you can orbit.

## Run it

```sh
npm install

# Serve the map at http://localhost:5190, reading the repository live.
npm start -- --repo /path/to/repo
```

`--repo` defaults to the current folder. `CODESPACE_REPO`, `PORT`, and `HOST` do
the same from the environment.

## What is here

- `src/repo/Repo.ts` — reads a folder as a repository: file list, safe reads, ignored
  folders.
- `src/server/Server.ts` — the page, the file list, and the source API.
- `src/repo/Architecture.ts` — reads, checks, and safely changes a repository's `.codespace/architecture.json`.
- `src/server/Api.ts` — the endpoints tools use: the architecture, the import graph, and what the map shows.
- `src/server/View.ts` — what the map is asked to show, streamed to every open page.
- `src/repo/Graph.ts` — the relative imports between code files, for the tools.
- `src/server/Guard.ts` — who may change anything: this machine only.
- `src/mcp/Mcp.ts` — the MCP server agents connect to.
- `public/index.html` — the map page: the scene and its controls.
- `public/main.js` — the entry: pointer interaction, the render loop, and boot.
- `public/state.js` — the shared world: constants, the Babylon scene, and the live state.
- `public/repo.js` — reads the live repository into nodes and edges.
- `public/city.js` — lays out the map as a treemap: each folder a tile, each file a box of the same footprint, as tall as its line count.
- `public/meshes.js` — builds the boxes and grid, and moves the camera.
- `public/highlight.js`, `public/edges.js`, `public/labels.js` — the selection glow, the import strands, and the names.
- `public/view.js` — the Showing panel, and what tools ask the map to light up or focus.
- `public/panels.js` — the summary, info, folders, and legend panels.
- `public/controls.js` — the buttons, the live poll, and refresh.
- `public/style.css` — the page styles.
- `docs/review-rubric.md` — the code-health review rubric.
- `docs/FUTURE.md` — ideas deliberately deferred, written so they can be picked up later.
- `docs/architecture.md` — the architecture file: its fields, the tag vocabulary, and the rules for generated code.
- `.codespace/architecture.json` — this repository's own layers, tags, and summaries, which the map reads.

## Driving the map from an agent

A coding agent that is looking at the repository can reshape and explain the map through
Codespace's MCP server. It never touches the code: it reads the map's data, edits the
architecture file, and points at things.

The MCP server is part of the main server: `npm start` brings it up at `/mcp`, so there is
nothing separate to run. Register that URL once with Claude Code:

```sh
claude mcp add --scope user --transport http codespace http://127.0.0.1:5190/mcp
```

Any MCP client that speaks HTTP works the same way. For a client that can only launch a
stdio program, `src/mcp/Mcp.ts` is a fallback that talks to the running server over HTTP:

```sh
claude mcp add --scope user codespace -- node --experimental-transform-types /path/to/Codespace/src/mcp/Mcp.ts
```

`CODESPACE_URL` points the stdio fallback at a server that is not on
`http://127.0.0.1:5190`.

| Tool | What it does |
| --- | --- |
| `get_architecture` | The layers, each file's layer, tags and summary, any warnings, and the files with no layer or no summary yet. Start here. |
| `get_import_graph` | The imports between files, and which break the layers. |
| `get_view` | What the map is currently showing. |
| `update_architecture` | Move files between layers, retag them, write summaries, reorder or add layers, or move an entry after a rename. All or nothing: any invalid part writes nothing and lists the problems. |
| `show_files` | Light up files. With `trace`, draw a numbered route through them in order, and put each step's explanation in the Showing panel beside the map. |
| `focus` | Select a file or folder and bring the camera to it. |
| `clear_view` | Stop showing what `show_files` lit up. |

Changes show up in every open page at once. Reading is open, like the rest of the map, but
anything that changes something is accepted only from this machine and only when Codespace
is reached as `localhost`, even though the server listens on the network. A page opened
through a proxy such as Tailscale Serve can watch, but not change.

## How it draws the city

The page reads the repository live from `/api/files` and `/api/source`, following
the repository's own `.gitignore` (and a built-in list when it has none) to skip
what git ignores. Each folder becomes a tile holding its files, and every file is a box of the
same footprint, as tall as its line count. Imports between folders are drawn as strands
that follow the folder tree, so imports between the same regions gather into bundles;
selecting a file draws its own imports directly. A reload — or the 15-second poll — redraws it as the code changes.

## Limits

Import edges are read from TypeScript and JavaScript. Other languages are shown
but their imports are not resolved yet. The map reads one repository at a time.
