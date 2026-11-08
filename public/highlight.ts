import { S, isLitRecord, materialFor, fileColor } from "./state.js";
import { placeBox, paintBox, releaseAccents, accent, retireAccents } from "./boxes.js";
import { colorOf } from "./batch.js";

// Paints every file for the current choice. The crowd is tinted in its batch; the few files
// that stand out (chosen, hovered, the start of a route, the files shown) get a mesh of their own.
function applyHighlight(): void
{
  releaseAccents();
  // A traced route keeps its first file brightest; the rest of the route stays shown.
  const start = S.trace !== null && S.trace.trace ? S.trace.paths[0] : null;
  for (const rec of S.fileRecords.values())
  {
    const chosen = rec.node === S.selected && rec.file === S.selectedFile;
    const lit = isLitRecord(rec);
    const hovered = rec.path === S.hoveredPath;
    const shown = S.trace !== null && S.trace.set.has(rec.path);
    const emphasise = start !== null && rec.path === start;
    const hex = fileColor(rec.path);
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
