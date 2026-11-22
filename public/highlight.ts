import { S, isLitRecord, inSpotLayer, materialFor, fileColor } from "./state.js";
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
      const alpha = flash > 0 && !chosen && !emphasise ? 1 : lit ? 1 : 0.12;
      accent(rec, materialFor(hex, alpha, glow), chosen || emphasise || flash > 0.6);
    }
    else paintBox(rec, colorOf(hex));
    placeBox(rec);
  }
  retireAccents();
  fadeLayerPlanes();
}

const FADED_GREY = "#6e7681";

// While a layer is picked from the legend, every other plane and its outline fade to a trace.
function fadeLayerPlanes(): void
{
  for (const plane of S.layerPlanes)
  {
    const faded = S.spotLayer !== null && (plane.metadata as { layer: string }).layer !== S.spotLayer;
    plane.visibility = faded ? 0.2 : 1;
    (plane.metadata as { border: BABYLON.Mesh }).border.visibility = faded ? 0.3 : 1;
  }
}

export { applyHighlight };
