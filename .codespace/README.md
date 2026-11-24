# Keeping the Codespace map true

`architecture.json` in this folder describes the repository to the Codespace map: what each file is for,
and where it sits. It was written when the repository was first mapped, and it only stays useful if every
change to the code carries its entry along. **Whoever changes a file updates its entry in the same change.**

## What to do when

- **A file is added:** add its entry (below). Until it has one, the map leaves it out while only described files are shown.
- **A file is moved or renamed:** move its entry to the new path, key and all. An entry for a path that no
  longer exists is reported as stale.
- **A file is deleted:** delete its entry.
- **A file's job changes:** rewrite its summary, and change its system, layer, or tags if they no longer fit.
- **A folder is added or its purpose changes:** add or update its entry under `folders`.

## The file

```json
{
  "layers": ["config", "data", "api", "ui", "entry", "tests"],
  "systems": { "server": { "summary": "What this part of the app is for." } },
  "files": {
    "src/api/orders.ts": {
      "system": "server",
      "layer": "api",
      "tags": ["orchestrate", "io"],
      "summary": "Serves the order endpoints and checks each request before it reaches the store.",
      "notes": {
        "OrderRoutes": "The order endpoints, each checked before it reaches the store.",
        "OrderRoutes.Create": "Takes a new order, checks it, and stores it.",
        "OrderRoutes.Create:1": "First we check the order has a customer and at least one line.",
        "OrderRoutes.Create:2": "Then we store it and answer with its number."
      }
    }
  },
  "folders": { "src/api": { "summary": "The HTTP endpoints." } }
}
```

- **summary:** one plain sentence on what the file is *for*, not how it works.
- **system:** the functional part of the app the file belongs to. It must be listed under `systems`.
- **layer:** the file's level in the stack, from `layers` (listed bottom first). It is the file's job, not its
  system and not its folder.
- **tags:** its roles, primary first, from `entry`, `orchestrate`, `core`, `data`, `io`, `ui`, `config`, `test`. Other tags are stored and shown grey.
- **notes** (optional): what the file's declarations are for, by name: a class or function as `Name`, a member
  as `Class.member`, and a function's steps in order as `Name:1`, `Name:2`. The map shows them with the file's
  blocks. Each note is at most 2000 characters.
- Use a layer and a system that already exist. Add a new one only when nothing fits, and declare it first.

Every ordinary file entry needs a summary, a system, a layer, and tags. A generated or vendored file is the
exception: its entry may be a summary alone.

## Explanations live here, not in the code

Write what a class, function, field, or step is for as a note in this file, not as a comment in the code. Do
not add JSDoc (`/** … */`) summaries or step-by-step comments to the source; keep code comments to a short line
saying *why* something unusual is done. When a declaration is renamed, moved, or deleted, rename, move, or
delete its notes too, and rewrite a note whose code no longer does what it says. Codespace's
`lift-notes` command moves comments already in the code into notes here.

## Keep the layers honest

Imports point down the stack: a file may import files on its own layer or a lower one, and never a higher one.
The map draws each import that points up as a red line, so a change that adds one has put the file on the wrong
layer, or the layers in the wrong order. Choose the layer from what the file imports and what imports it. Tests
import the code they test, so a tests layer sits above it.

## How to edit

Edit `architecture.json` directly and keep it valid JSON; the map picks the change up on its own. If you can
reach Codespace's command line (`src/cli/Cli.ts`), `apply --file change.json` writes the same shape all at once
and reports anything wrong, and `refine` lists imports that point up the layers.
