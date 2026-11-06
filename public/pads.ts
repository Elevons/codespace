import { S, scene, colorFor, materialFor } from "./state.js";
import type { FileRecord } from "./types.js";

// A thin ring on each file's own layer plane, right under the block, in the layer's colour, so the
// layer a file belongs to reads at a glance even where the block sits above the plane or has been
// lifted out onto a route's lane. Files with no declared layer have no ring.
const pads = new Map<string, BABYLON.Mesh>();   // path -> ring mesh

function syncPads(): void
{
  const seen = new Set<string>();
  if (S.LAYERS.length > 0)
  {
    for (const rec of S.fileRecords.values())
    {
      const layer = S.FILE_LAYERS.get(rec.path);
      const rank = layer === undefined ? -1 : S.LAYERS.indexOf(layer);
      if (rank < 0) continue;
      seen.add(rec.path);
      let pad = pads.get(rec.path);
      if (!pad)
      {
        pad = BABYLON.MeshBuilder.CreateTorus("pad:" + rec.path, { diameter: 1, thickness: 0.035, tessellation: 40 }, scene);
        pad.isPickable = false;
        pads.set(rec.path, pad);
      }
      const pos = rec.mesh.position, size = rec.mesh.scaling;
      const across = Math.max(size.x, size.z) * 1.5;
      pad.scaling.set(across, 1, across);
      pad.position.set(pos.x, rank * S.layerGap + 0.012, pos.z);
      pad.material = materialFor(colorFor(layer!), lit(rec) ? 0.9 : 0.12, 0.7);
    }
  }
  for (const [path, pad] of pads)
  {
    if (seen.has(path)) continue;
    pad.dispose();
    pads.delete(path);
  }
}

// Whether a file stays bright under the current choice, as its block does.
function lit(rec: FileRecord): boolean
{
  if (S.trace) return S.trace.set.has(rec.path);
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

export { syncPads };
