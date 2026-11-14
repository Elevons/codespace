# Glossary

The words the map uses for one file and the parts inside it. Use these words in the
interface, in the code, and in a description of the map; they name one thing each.

## The file in the city

- **file box** — the standing box that stands for one file on the map. It is a cube, and it is
  the only thing a file is drawn as until it is chosen.
- **folder tile** — the flat, nested plate that holds a folder's file boxes and subfolders.
- **layer plane** — the translucent plane that gathers the files of one layer.

## The parts of a file

- **block** — one part of a file, in reading order: a run of imports, a run of constants, a run of
  types, one function, or one class. A block is what the server returns and what the rail lists.
- **section** — a block that would sit inside a bigger one, indented in the rail. Codespace keeps
  every function and class whole, so a file is not cut into sections today.
- **block kind** — what a block is, which sets its colour: `import`, `constant`, `type`,
  `function`, `class`, or `declaration`.
- **block summary** — one plain sentence about what a block is for. It has one of three sources:
  - **comment summary** — the block's own leading comment, used as it is;
  - **model summary** — written by the configured model for a block with no comment, kept for the
    session;
  - **shape summary** — the plain fallback, such as `Refine: a function of 125 lines`, shown in
    italics when no model answers.
- **block reference** — another block of the same file that a block's text mentions. The rail
  shows these as `uses …`. No line is drawn for them.
- **block wire** — an import wire the block's text names, such as a module whose symbol it uses.
  Choosing the block keeps its own wires bright and starting from its floor, and dims the rest.

## The chosen file

- **open file** — a chosen file whose box has become its blocks. Prefer "open" to "expanded",
  "drilled into", or "zoomed into".
- **floor** — the slab that draws one block of an open file. Its thickness is the block's share of
  the file's height, which grows with the square root of the block's line span.
- **block stack** — every floor of an open file, standing on the file box's footprint and reaching
  1.5× its height, so small blocks stay readable. Opening shrinks the file box to the lowest block,
  which it becomes, then grows the rest of the blocks upward from its top. Closing returns the box.
- **block rail** — the info panel's list of an open file's blocks: one row per block, with its
  kind, name, line range, summary, and references.
- **file strip** — the line-accurate vertical map of the file beside the block rail, one mark per
  block, coloured by kind. It is a SeeSoft-style strip, not a minimap of the code.

## Actions

- **choose** — select a file or folder, which opens the info panel and, for a file, its block
  rail. A block is chosen the same way: by its rail row or its floor, which both open its lines.
- **selection** — the files chosen together. Shift-click a file row or a file box to add it or take
  it out; the file chosen first stays the one whose block rail is open, and the rest are listed
  under it. Every selected file's import traces are drawn.
- **open a block** — show one block's lines in the code panel, numbered as they are in the file.
- **show** and **isolate** — the two things a tool asks the map to draw, unchanged by blocks.

## Words to avoid

- "symbol" for a block: a symbol is one declared name, and blocks group several.
- "strand" or "wire" for a block reference: references are text in the rail and draw no line.
- "sub-block" or "chunk": use **block** for every part of a file; nothing is cut into smaller
  parts.
