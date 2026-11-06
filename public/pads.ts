import { S, scene, colorFor, matchesTagFilter } from "./state.js";
import { Batch } from "./batch.js";
import type { FileRecord } from "./types.js";

// A thin ring on each file's own layer plane, right under the block, in the layer's colour, so the
// layer a file belongs to reads at a glance even where the block sits above the plane or has been
// lifted out onto a route's lane. Files with no declared layer have no ring. Every ring is a copy
// in one of two batches, bright and faded, so thousands of rings cost two draws.
let bright: Batch | null = null;
let faded: Batch | null = null;

function makeBatch(name: string, alpha: number): Batch
{
  const mesh = BABYLON.MeshBuilder.CreateTorus(name, { diameter: 1, thickness: 0.035, tessellation: 40 }, scene);
  const material = new BABYLON.StandardMaterial(name, scene);
  material.diffuseColor = BABYLON.Color3.White();
  material.emissiveColor = new BABYLON.Color3(0.7, 0.7, 0.7);
  material.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06);
  material.alpha = alpha;
  mesh.material = material;
  return new Batch(mesh);
}

function batches(): [Batch, Batch]
{
  if (!bright) bright = makeBatch("pads", 0.9);
  if (!faded) faded = makeBatch("pads-faint", 0.12);
  return [bright, faded];
}

// Gives the ring batches one slot per file on the map, the same slot as its box.
export function resizePads(count: number): void
{
  const [a, b] = batches();
  a.resize(count);
  b.resize(count);
}

const parsed = new Map<string, BABYLON.Color3>();

function syncPads(): void
{
  const [a, b] = batches();
  const layered = S.LAYERS.length > 0;
  for (const rec of S.fileRecords.values())
  {
    const layer = layered ? S.FILE_LAYERS.get(rec.path) : undefined;
    const rank = layer === undefined ? -1 : S.LAYERS.indexOf(layer);
    if (rank < 0) { a.hide(rec.slot); b.hide(rec.slot); continue; }
    const pos = rec.shape.position, size = rec.shape.scaling;
    const across = Math.max(size.x, size.z) * 1.5;
    const into = lit(rec) ? a : b, out = into === a ? b : a;
    into.place(rec.slot, pos.x, rank * S.layerGap + 0.012, pos.z, across, 1, across);
    out.hide(rec.slot);
    const hex = colorFor(layer!);
    let color = parsed.get(hex);
    if (!color) { color = BABYLON.Color3.FromHexString(hex); parsed.set(hex, color); }
    into.paint(rec.slot, color.r, color.g, color.b);
  }
  a.flush();
  b.flush();
}

// Whether a file stays bright under the current choice, as its block does.
function lit(rec: FileRecord): boolean
{
  if (!matchesTagFilter(rec.path)) return false;
  if (S.trace) return S.trace.set.has(rec.path);
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

export { syncPads };
