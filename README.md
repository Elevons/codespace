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
fully described — the *Described only* toggle in the Outliner's grouping menu draws them all.

## The chat

The **Chat** button (the Chat tab on a phone) opens an agent built into the map. Ask it how
something works and it finds the code, draws it on the map as a numbered route, and answers in a
few lines; file names in its reply lead to the file. It is a [pi](https://github.com/earendil-works/pi)
agent working in the repository being mapped, with pi's basic tools (read, bash, edit, write,
grep, find, ls), and it uses the same map API and CLI an outside agent would. Pi runs the agent
loop and keeps each repository's chats, which the chat's menu reopens. While the panel is
closed, its button only says when the agent is working or a reply is waiting.

The Repo panel's **Ingest Codebase** starts a chat that describes the whole repository for the
map, so nothing has to be copied into another agent. It has two passes. The first writes each
file's summary, system, layer, and tags. The second, `refine`, checks those against the imports: it
looks for imports that point up the layers (the red lines), files that would fit another layer or
system better, and layers or systems that look wrong as a whole, and the agent fixes what it finds.
Once a repository is described, **Refine layers** runs the second pass alone.

Ingest is incremental, so the same button updates a map on demand: once a repository has a
description it reads **Update Map**, and it hands the agent only what is new or changed. Each description
is recorded against the file's text when it is written (in `.codespace/ingested.json`, kept out of git),
so a rewritten file comes back for review with its current entry to judge against, an entry follows a
file that was moved and drops with one that was deleted, and an untouched file is never read again.

It talks to any OpenAI-compatible endpoint, set in a `.env` beside `package.json` (see
`.env.example`): `CODESPACE_MODEL_BASE_URL`, `CODESPACE_MODEL`, and the key, either directly as
`CODESPACE_MODEL_API_KEY` or read by name from another program's env file with
`CODESPACE_MODEL_KEY_FILE` and `CODESPACE_MODEL_KEY_NAME`. With nothing set it uses OpenRouter
and asks for a key. Its settings and chats live in `~/.codespace/agent`, apart from your own pi
setup. Like any change, the chat is only open to this machine unless the server was started
with `--allow-writes`.

## Using the map

- **Find anything.** Press `/` or Ctrl/Cmd+K and type part of a file path, folder, or
  declared function; the Outliner filters in place and lists matching symbols under their
  file. The arrow keys pick a match and Enter chooses it. Double-click a file row to open its
  code, or choose it to fly there.
- **Click a block** to trace a folder, or a box to see the file's symbols, line counts,
  and what it uses. The breadcrumb at the top walks back up.
- **One outliner for everything.** A filter strip at the top lists every system and layer with a
  live count. Clicking a chip narrows the scene to that value, and chips combine: a system and a
  layer narrow together, and selecting one switches on the values its files need on the other axis,
  so a choice never draws nothing. Only matching files are drawn, with just the folders and layer
  planes that still hold one, and the planes close up so no empty layer leaves a gap. The tree
  below lists each folder once; the *List by* switch can instead flatten files under system or
  layer groups. Click a group to fold it. Every file row carries a tag badge and coloured dots for
  its system and layer, and clicking a dot switches that value in the strip. Choosing a file
  anywhere opens its folder and scrolls it into view. An eye on a folder row hides its subtree in
  the scene, and a file's own eye hides or restores just that file. Folding every group leaves open any
  folder above an eye-hidden row, so you can always find it again. *Hide all* and *Show all*
  below the tree act on every file at once, and *Show all* also turns Extras on so nothing stays
  hidden. Until a repository declares systems, the System chips and grouping stay hidden.
- **Tag filters.** A file's tag badge filters by role. Layers are shared, so one layer can hold
  files from several systems.
- **Colour by** tags, systems, layers, folders, size, or recent changes. *Changes* colours
  each file by the lines it has changed since HEAD, and the changes endpoint needs the map to
  be reading a git checkout with `git` on the machine.
- **Stand back.** *Layer gap* pulls the layer planes apart; *Extras* shows tests, docs,
  and scripts. *Glow* switches bloom (the page's only post-processing pass) off if a slow
  machine wants the frames back; a software renderer starts with it off and at a slightly
  lower resolution.
- **Keys:** `Space` spin · `F` frame the chosen block · `[` `]` step through a folder's
  files · `R` reset · `Esc` clear · `?` shortcut card.
- **Point it somewhere else.** *Repo* in the bottom bar opens the folder picker: walk the
  machine's folders with *Up* and the list, type a path (`~/` works), or pick a recent
  repository. Opening another one reloads the map onto it, and the agent prompt it copies
  names the new path, so an agent can describe it without restarting anything. *Delete
  architecture* removes the repository's `.codespace` folder, so it can be described again
  from nothing.
- **Share a view.** The chosen file is kept in the address bar (`#public/main.ts`), so a
  reload or a pasted link opens the same place.

While *Live* is on, the 15-second poll redraws the map after edits. A file whose line
count changed gets a green ring on its folder's floor, so an agent's progress is visible
without refreshing.

## What is here

- `src/repo/Repo.ts` — reads a folder as a repository: file list, safe reads, ignored
  folders, and a cheap change stamp.
- `src/server/Server.ts` — the page (compressed, with validators), the installed Babylon at one unversioned address, `/api/bootstrap`, the source API, the changed-line counts, and switching repositories.
- `src/server/Workspace.ts` — the repository being read, and the recent ones the page can switch back to.
- `src/repo/Architecture.ts` — reads, checks, and safely changes a repository's `.codespace/architecture.json`.
- `src/server/Api.ts` — the endpoints the page uses: the architecture, the import graph, the ingest status, what the map shows, and the chat.
- `src/server/View.ts` — what the map is asked to show, streamed to every open page.
- `src/repo/Snapshot.ts` — one cached read of a repository's files, imports, line counts, and declared names, rebuilt only when a file changes.
- `src/repo/Graph.ts` — the imports between code files, relative for TypeScript and
  JavaScript and by namespace for C#, for the tools.
- `src/repo/Ingest.ts` — what an agent reads next to describe a codebase: files whose entry is incomplete, then folders.
- `src/repo/Refine.ts`, `src/repo/RefineGuide.ts` — the second pass: layer breaks, better-fitting layers and systems, and the instructions for acting on them.
- `src/repo/DescribeGuide.ts` — the first-pass instructions for describing a repository, shared by the copied prompt and the built-in chat.
- `src/repo/JsonStore.ts` — reads and writes the JSON files Codespace keeps in a repository, refusing any path that leaves it.
- `src/repo/ShowLimits.ts` — the limits on one show request: how many files, and how long each note, the title, and the overall note may be.
- `src/repo/Ledger.ts`, `src/repo/Sync.ts` — what each description was based on, and the housekeeping before an update: moved files keep their entries and deleted ones lose theirs.
- `src/repo/Install.ts` — leaves the upkeep rules in the repository being mapped, so its architecture file is kept true.
- `src/server/Guard.ts` — who may change anything or use the chat: this machine only.
- `src/agent/Chat.ts` — the chat built into the map: a pi agent in the repository, its saved chats, and its reply streamed to the page.
- `src/agent/Instructions.ts` — what the chat's agent is told: drawing on the map and describing the repository.
- `src/agent/ModelSettings.ts` — which OpenAI-compatible endpoint, model, and key the chat uses.
- `src/cli/Cli.ts` — the commands an agent runs to describe a repository, with no server or MCP.
- `src/cli/Options.ts` — reads `--name value` or `--name=value` options from a command line.
- `public/index.html` — the map page: the scene and its controls.
- `public/main.ts` — the entry: pointer interaction, the render loop, and boot.
- `public/state.ts` — the shared world: constants, the Babylon scene, and the live state.
- `public/repo.ts` — reads the live repository into nodes and edges, taking the import graph from the server.
- `public/symbols.ts` — reads the declarations a source file lists, for the code panel and search.
- `public/filter.ts` — the pure rules behind the systems/layers filter and the outliner search.
- `public/rules.ts` — the pure folder, colour, layer-rank, visibility, and ray-picking rules, kept testable away from the scene.
- `public/tags.ts` — the one ordered tag vocabulary and its colours, shared by the browser and the server.
- `public/ingest.ts` — the shape of the ingest-status response, shared by the page and the server.
- `public/city.ts` — lays out the map as a treemap: each folder a tile, each file a box of the same footprint, as tall as its line count.
- `public/meshes.ts` — builds, reuses, and retires each file's mesh so its box sits on its folder's tile and animates into place.
- `public/boxes.ts` — draws and places every file box, batching the crowd and borrowing a real mesh for the few files that stand out.
- `public/batch.ts` — draws many copies of one shape in a single Babylon batch, tinted per slot for the file boxes and layer pads.
- `public/highlight.ts`, `public/edges.ts`, `public/labels.ts`, `public/route.ts`, `public/pads.ts` — the selection glow, the import strands, the names, the route lane, and the layer rings.
- `public/view.ts` — the Showing panel, and what tools ask the map to light up or focus.
- `public/repo-switch.ts` — the Repo picker: open another folder, list recent ones, show how much is left to describe, and hand that to the chat.
- `public/chat.ts` — the Chat panel: the prompt box, the conversation, and what the agent is doing now.
- `public/panels.ts` — the info panel, the Outliner tree, its search and filters, the breadcrumbs, and the highlighted code view.
- `public/controls.ts` — the buttons, Outliner interactions, keyboard shortcuts, colour menu, live poll, and refresh.
- `public/mobile.ts` — the phone layout: moves the panels into one sheet behind a tab bar.
- `public/style.css` — the page styles.
- `public/types.ts` — the shapes the page shares between its modules: the folder tree, each file's record, and what a tool asks to show.
- `public/babylon.d.ts` — the slice of the Babylon.js global the page uses, so the browser code type-checks.
- `tsconfig.web.json` — the compiler settings for the browser code; `npm run build` compiles `public/*.ts` to `.js` beside them.
- `AGENTS.md` — what a coding agent should know first: the commands, the architecture-file rule, the ingest loop, and the map's API.
- `docs/review-rubric.md` — the code-health review rubric.
- `docs/FUTURE.md` — ideas deliberately deferred, written so they can be picked up later.
- `docs/architecture.md` — the architecture file: its fields, the tag vocabulary, and the rules for generated code.
- `.codespace/architecture.json` — this repository's own layers, systems, tags, and summaries, which the map reads.

## Ingesting a codebase from an agent

The simplest way is the Repo panel's **Ingest Codebase**, which has the built-in chat do it (see
*The chat* above). Any other coding agent with a shell can do the same. There is no MCP server and
no client to install: `src/cli/Cli.ts` reads the repository, writes its architecture file, and the
map picks the change up while it runs.

```sh
# which repository it reads, and where
node --experimental-transform-types src/cli/Cli.ts repo --repo /path/to/repo

# which repository, and how much is left to describe
node --experimental-transform-types src/cli/Cli.ts status --repo /path/to/repo

# the next files (or folders) with their source, imports, and importers
node --experimental-transform-types src/cli/Cli.ts next --repo /path/to/repo --size 12

# write each batch back: a JSON file, or - to read it from stdin
node --experimental-transform-types src/cli/Cli.ts apply --file batch.json --repo /path/to/repo
```

`apply` takes the same shape the architecture file uses:
`{"systems": {"server": {"summary": "..."}}, "files": {"src/a.ts": {"summary": "...", "system": "server", "tags": ["core"], "layer": "repo"}}, "folders": {"src": {"summary": "..."}}}`. Layers and systems are declared once and shared: a layer may hold files from several systems.
Repeat `next` then `apply` until `next` reports `"remaining": 0`; folders come last. Generated
and vendored files are summarized for you and never handed back. `--size` is at most 40.

## Keeping it current

The first thing ingest does is `install`: it leaves a short marked note in the repository's own
`AGENTS.md` (or `CLAUDE.md`; one is created if there is neither) and the full upkeep rules in
`.codespace/README.md`. After that, any agent that works in the repository is told to update a file's
entry in the same change as the file, so the map stays true without another ingest. Running `install`
again only refreshes its own marked block. While only described files are shown, a file added
without an entry is left off the map, and the Repo panel counts it, along with changed files, and
**Update Map** describes just what is new or changed.

Every batch is written as soon as it is applied, so there is nothing to save afterwards and an
interrupted run picks up where it stopped. A batch holds files and folders that are undescribed,
changed, or incomplete, so a changed file may already be complete and comes back for review with its
current entry to judge against. Re-running never overwrites what is already current, by hand or otherwise.
The file does not exist until the first batch is written; opening a repository creates nothing.

`AGENTS.md` here spells the loop out for an agent working in this repository. For another one,
the Repo picker's **Copy prompt** hands over the same commands with that repository's path
filled in. Writing summaries and tags is judgment, which the agent does, built in or not.

Changes show up in every open page at once. Reading is open, like the rest of the map, but
anything that changes something is accepted only from this machine and only when Codespace
is reached as `localhost`, even though the server listens on the network, unless it was started
with `--allow-writes`.

## How it draws the city

The page reads the repository live from one `/api/bootstrap` request (started before Babylon finishes downloading, and answered with just a stamp when nothing has changed), and `/api/source` for a file's text, following
the repository's own `.gitignore` (and a built-in list when it has none) to skip
what git ignores. Each folder becomes a tile holding its files, and every file is a box of the
same footprint, as tall as its line count. Imports are drawn only for what is chosen, so the
map stays readable. Choosing a folder draws the imports crossing its edge as circuit-board traces
from the imported file's tether pad to the importing file's, blue going out and amber coming in:
each rises from its pad, runs in straight lines with cut corners, and drops onto the other pad.
The traces to one other folder run side by side in a shared corridor, like a bus, and each bus
has its own small height, so crossing buses pass over one another. Choosing a file draws just its own imports, arching block to
block. A folder's plate is labelled with what it adds below the folder around it. A layer break — a file importing one on a
higher layer — is a thin red line on the folder plates, from the importing file's tether foot
to the imported file's, brightest at the end that uses it. A reload — or the 15-second poll —
redraws it as the code changes.

The poll sends the change stamp it already holds to `/api/bootstrap?since=`; when the files have not
moved, the server answers with just the stamp and the map reads no source at all. Imports and pale
pillars are batched into line systems, the strands and labels redraw at a capped rate while
boxes move, and a settled map rebuilds nothing.

## Limits

Import edges are read from TypeScript and JavaScript, by relative specifier, and from
C#, by namespace. Other languages are shown but their imports are not resolved yet.
The map reads one repository at a time.
