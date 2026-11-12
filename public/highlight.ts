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
    const chosen = (rec.node === S.selected && rec.file === S.selectedFile) || S.extraFiles.has(rec.path);
    const lit = isLitRecord(rec);
    const hovered = rec.path === S.hoveredPath;
    const shown = S.trace !== null && S.trace.set.has(rec.path);
    const emphasise = start !== null && rec.path === start;
    // A file edited on disk flashes at full brightness, then fades back to how it sat.
    const flash = S.flashes.get(rec.path) ?? 0;
    const hex = fileColor(rec.path);
    rec.lit = lit;
    if (chosen || emphasise || shown || hovered || flash > 0)
    {
      const glow = chosen ? 0.85 : emphasise ? 1 : flash > 0 ? 0.4 + 0.6 * flash : 0.55;
      const alpha = flash > 0 && !chosen && !emphasise ? 1 : lit ? 1 : 0.12;
      accent(rec, materialFor(hex, alpha, glow), chosen || emphasise || flash > 0.6);
    }
    else paintBox(rec, colorOf(hex));
    placeBox(rec);
  }
  retireAccents();
}

export { applyHighlight };
