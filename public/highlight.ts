import { S, materialFor, fileColor, matchesTagFilter } from "./state.js";
import { placeBox, paintBox, releaseAccents, accent, retireAccents } from "./boxes.js";
import type { FileRecord } from "./types.js";

// Whether a file stays bright under the current choice: the files being shown (S.trace) when there are some,
// the chosen folder and its neighbours otherwise, and always the legend's tag filter when one is on.
function isLit(rec: FileRecord): boolean
{
  if (!matchesTagFilter(rec.path)) return false;
  if (S.trace) return S.trace.set.has(rec.path);
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

// Parsed colours, kept: a repaint touches every file, and parsing hex each time adds up.
const parsed = new Map<string, BABYLON.Color3>();
function colorOf(hex: string): BABYLON.Color3
{
  let color = parsed.get(hex);
  if (!color) { color = BABYLON.Color3.FromHexString(hex); parsed.set(hex, color); }
  return color;
}

// Paints every file for the current choice. The crowd is tinted in its batch; the few files
// that stand out (chosen, hovered, the start of a route, the files shown) get a mesh of their own.
function applyHighlight(): void
{
  releaseAccents();
  // A traced route keeps its first file brightest; the rest of the route stays shown.
  const start = S.trace !== null && S.trace.trace ? S.trace.paths[0] : null;
  for (const rec of S.fileRecords.values())
  {
    const n = S.NODES[rec.node];
    const chosen = rec.node === S.selected && rec.file === S.selectedFile;
    const lit = isLit(rec);
    const hovered = rec.path === S.hoveredPath;
    const shown = S.trace !== null && S.trace.set.has(rec.path);
    const emphasise = start !== null && rec.path === start;
    const hex = fileColor(rec.path, n.layer);
    rec.lit = lit;
    if (chosen || emphasise || shown || hovered)
    {
      const glow = chosen ? 0.85 : emphasise ? 1 : 0.55;
      accent(rec, materialFor(hex, lit ? 1 : 0.12, glow), chosen || emphasise);
    }
    else paintBox(rec, colorOf(hex));
    placeBox(rec);
  }
  retireAccents();
}

export { applyHighlight };
