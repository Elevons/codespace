import { S, scene, colorFor, isLitRecord, layerRank } from "./state.js";
import { Batch, PairedBatch, batchOf, colorOf } from "./batch.js";

// A thin ring on each file's own layer plane, right under the block, in the layer's colour, so the
// layer a file belongs to reads at a glance even where the block sits above the plane or has been
// lifted out onto a route's lane. Files with no declared layer have no ring. Every ring is a copy
// in one of two batches, bright and faded, so thousands of rings cost two draws.
let pair: PairedBatch | null = null;

function makeBatch(name: string, alpha: number): Batch
{
  const mesh = BABYLON.MeshBuilder.CreateTorus(name, { diameter: 1, thickness: 0.0175, tessellation: 40 }, scene);
  return batchOf(mesh, 0.7, alpha);
}

function pairOf(): PairedBatch
{
  if (!pair) pair = new PairedBatch(makeBatch("pads", 0.9), makeBatch("pads-faint", 0.12));
  return pair;
}

// Gives the ring batches one slot per file on the map, the same slot as its box.
export function resizePads(count: number): void
{
  pairOf().resize(count);
}

function syncPads(): void
{
  const p = pairOf();
  const layered = S.LAYERS.length > 0;
  for (const rec of S.fileRecords.values())
  {
    const layer = layered ? S.FILE_LAYERS.get(rec.path) : undefined;
    const rank = layer === undefined ? -1 : layerRank(layer);
    if (rank < 0) { p.hide(rec.slot); continue; }
    const pos = rec.shape.position, size = rec.shape.scaling;
    const across = Math.max(size.x, size.z) * 1.5;
    p.place(rec.slot, isLitRecord(rec), pos.x, rank * S.layerGap + 0.012, pos.z, across, 1, across);
    p.paint(rec.slot, colorOf(colorFor(layer!)));
  }
  p.flush();
}

export { syncPads };
