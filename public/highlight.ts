import { S, colorFor, materialFor, fileColor } from "./state.js";
import { routeFolderHues } from "./route.js";
import type { FileRecord } from "./types.js";

// Whether a file stays bright under the current choice: the files being shown (S.trace) when there are some
// showing some, else the chosen folder and its neighbours.
function isLit(rec: FileRecord): boolean
{
  if (S.trace) return S.trace.set.has(rec.path);
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

// Paints every file and folder tile for the current choice.
function applyHighlight(): void
{
  for (const rec of S.fileRecords.values())
  {
    const n = S.NODES[rec.node];
    const chosen = rec.node === S.selected && rec.file === S.selectedFile;
    const lit = isLit(rec);
    const hovered = rec.path === S.hoveredPath;
    const shown = S.trace !== null && S.trace.set.has(rec.path);
    // A traced route keeps its first file brightest; the rest of the route stays shown.
    const start = S.trace !== null && S.trace.trace ? S.trace.paths[0] : null;
    const emphasise = start !== null && rec.path === start;
    const glow = chosen ? 0.85 : emphasise ? 1 : shown ? 0.55 : hovered ? 0.55 : 0.28;
    rec.mesh.material = materialFor(fileColor(rec.path, n.layer), lit ? 1 : 0.12, glow);
    rec.mesh.renderOutline = chosen || emphasise;
  }
  const shownNodes = new Set<number>();
  if (S.trace) for (const rec of S.fileRecords.values()) if (S.trace.set.has(rec.path)) shownNodes.add(rec.node);
  // On a route, each folder holding one of its files wears that folder's route colour.
  const hues = routeFolderHues();
  for (const plate of S.plates)
  {
    const n = S.NODES[(plate.metadata as { node: number }).node];
    const dim = S.trace ? !shownNodes.has(n.index!) : S.focusSet !== null && !S.focusSet.has(n.index!);
    const chosen = n.index === S.selected;
    const hue = hues.get(n.index!);
    if (hue && !chosen)
    {
      plate.material = materialFor(hue, 0.22, 0.35);
      const edge = BABYLON.Color3.FromHexString(hue);
      plate.edgesColor = new BABYLON.Color4(edge.r, edge.g, edge.b, 1);
      continue;
    }
    plate.material = materialFor(colorFor(n.layer), dim ? 0.05 : chosen ? 0.4 : 0.16, chosen ? 0.4 : 0.1);
    const edge = BABYLON.Color3.FromHexString(chosen ? "#58a6ff" : colorFor(n.layer));
    plate.edgesColor = new BABYLON.Color4(edge.r, edge.g, edge.b, dim ? 0.12 : chosen ? 1 : 0.55);
  }
}

export { applyHighlight };
