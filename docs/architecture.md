# The architecture file — telling the map what the code is for

The folder tree says *where* code lives. The architecture file says *what it is* and *how
it is layered*, in one place, so the map can show role and layer instead of only nesting.
It lives in the repository being mapped, at `.codespace/architecture.json`, and the code
itself carries no marker comments: changing the architecture means editing this file, not
the code.

```json
{
  "layers": ["base", "viz", "ui"],
  "files": {
    "src/repo/Repo.ts": {
      "layer": "base",
      "tags": ["core", "io"],
      "summary": "Reads a folder as a repository: lists its files and reads source safely."
    }
  },
  "folders": {
    "src/repo": { "summary": "Reads and checks a repository: its files, imports, and architecture." }
  }
}
```

The map reads it live: edit the file and the page redraws within its poll interval, or on
Refresh. A repository without one still draws, with layers coloured by folder.

## Fields

| Field | Means |
| --- | --- |
| `layers` | The layer names, bottom plane first. Each is drawn as a plane. |
| `files` | An object keyed by repository-relative path, with forward slashes. |
| `folders` | An object keyed by folder path, each with a `summary`. The repository root is not one. Optional. |
| `layer` | The layer the file belongs to. Its box rises to that layer's plane. |
| `tags` | The file's roles, primary first. The first tag sets its colour. |
| `summary` | One plain sentence on what the file is *for*: what it does and why it exists, not how. |
| `folders` entry | A `summary` saying what the folder's contents are for, written once its files and folders are described. |

Every field is optional. A file with no entry sits on the ground, uncoloured by role.

## The tag vocabulary (closed — do not invent more)

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
   run `node src/cli/Cli.ts apply`, which validates the change and redraws the map.
2. When you move or rename a file, move its entry's key to the new path. An entry for a
   path that no longer exists is ignored, and the Summary panel warns about it.
3. Draw tags only from the vocabulary above, and layers only from `layers`.
4. Keep summaries to one sentence.
5. Entries can be written by an agent in batches: `node src/cli/Cli.ts next` hands back the
   files and folders still missing a summary, a layer, or tags, and `apply` writes them back.
   Declare the layers first; a layer not listed in `layers` is refused. Generated and vendored
   files are summarized for it, so it does not spend effort on lockfiles or built output.

## What the map does with it

- Boxes are coloured by their first tag, and the legend lists the tags it finds.
- Each layer is a translucent plane with a coloured outline; files rise to their layer, and a
  vertical line ties each lifted file to its folder.
- An import that points up the layers (a lower layer using a higher one) is drawn red and
  counted in the legend.
- A tool can ask the map to show files with an explanation of each, which appears in the
  Showing panel; see the README's section on driving the map from an agent.
- The Summary panel shows the chosen file's summary, or each file's when a folder is chosen,
  and warns about problems in the file: invalid JSON, entries for files that are gone,
  layers a file names that `layers` does not list.
- `.codespace/` is part of the repository, so it is on the map like anything else, as an
  extra: hidden until you turn Extras on, along with `docs` and `tests`.
