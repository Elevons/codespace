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

- `src/Repo.ts` — reads a folder as a repository: file list, safe reads, ignored
  folders.
- `src/Server.ts` — the page, the file list, and the source API.
- `public/index.html` — the map page: the scene and its controls.
- `public/main.js` — the entry: pointer interaction, the render loop, and boot.
- `public/state.js` — the shared world: constants, the Babylon scene, and the live state.
- `public/repo.js` — reads the live repository into nodes and edges.
- `public/city.js` — lays out the terraces: each folder's files packed on a tile.
- `public/meshes.js` — builds the boxes and grid, and moves the camera.
- `public/highlight.js`, `public/edges.js`, `public/labels.js` — the selection glow, the import strands, and the names.
- `public/panels.js` — the info, folders, and legend panels.
- `public/controls.js` — the buttons, the live poll, and refresh.
- `public/style.css` — the page styles.
- `docs/review-rubric.md` — the code-health review rubric.

## How it draws the city

The page reads the repository live from `/api/files` and `/api/source`, following
the repository's own `.gitignore` (and a built-in list when it has none) to skip
what git ignores. Each folder becomes a tile holding its files; a code file's box
is as tall as its line count, and a strand is drawn for every import between two
files. A reload — or the 15-second poll — redraws it as the code changes.

## Limits

Import edges are read from TypeScript and JavaScript. Other languages are shown
but their imports are not resolved yet. The map reads one repository at a time.
