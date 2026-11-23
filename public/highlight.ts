import { S, isLitRecord, inSpotLayer, materialFor, fileColor, spotColumn } from "./state.js";
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
    // A file off the layer picked from the legend goes grey as well as faint.
    const hex = inSpotLayer(rec.path) ? fileColor(rec.path) : FADED_GREY;
    rec.lit = lit;
    if (chosen || emphasise || shown || hovered || flash > 0)
    {
      const glow = chosen ? 0.85 : emphasise ? 1 : flash > 0 ? 0.4 + 0.6 * flash : 0.55;
      const alpha = flash > 0 && !chosen && !emphasise ? 1 : lit ? 1 : 0.25;
      accent(rec, materialFor(hex, alpha, glow), chosen || emphasise || flash > 0.6);
    }
    else paintBox(rec, colorOf(hex));
    placeBox(rec);
  }
  retireAccents();
  fadeColumns();
}

const FADED_GREY = "#6e7681";

// The columns that are not the chosen one fade to a quarter, and when a layer is picked from the
// legend its floors on other layers do too, so the chosen column and layer keep their place.
function fadeColumns(): void
{
  const spot = spotColumn();
  for (const mesh of S.columnMeshes)
  {
    const meta = mesh.metadata as { kind?: string; layer?: string; index?: number } | undefined;
    const sibling = spot >= 0 && meta?.index !== spot;
    const layerOut = meta?.kind === "floor" && S.spotLayer !== null && meta.layer !== S.spotLayer;
    mesh.visibility = sibling || layerOut ? 0.25 : 1;
  }
}

export { applyHighlight };
