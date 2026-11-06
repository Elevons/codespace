import { S, colorFor, materialFor } from "./state.js";

// Whether a file stays bright under the current choice.
function isLit(rec)
{
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

// Paints every file and folder tile for the current choice.
function applyHighlight()
{
  for (const rec of S.fileRecords.values())
  {
    const n = S.NODES[rec.node];
    const chosen = rec.node === S.selected && rec.file === S.selectedFile;
    const lit = isLit(rec);
    const hovered = rec.path === S.hoveredPath;
    const glow = chosen ? 0.7 : hovered ? 0.45 : 0.14;
    rec.mesh.material = materialFor(colorFor(n.layer), lit ? 1 : 0.12, glow);
    rec.mesh.renderOutline = chosen;
  }
  for (const plate of S.plates)
  {
    const n = S.NODES[plate.metadata.node];
    const dim = S.focusSet !== null && !S.focusSet.has(n.index);
    const chosen = n.index === S.selected;
    plate.material = materialFor(colorFor(n.layer), dim ? 0.05 : chosen ? 0.4 : 0.16, chosen ? 0.4 : 0.1);
    const edge = BABYLON.Color3.FromHexString(chosen ? "#58a6ff" : colorFor(n.layer));
    plate.edgesColor = new BABYLON.Color4(edge.r, edge.g, edge.b, dim ? 0.12 : chosen ? 1 : 0.55);
  }
}

export { applyHighlight };
