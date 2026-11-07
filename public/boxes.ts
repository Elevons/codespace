import { S, scene, camera, glow } from "./state.js";
import { Batch, batchOf } from "./batch.js";
import type { FileRecord } from "./types.js";

/**
 * Every file box on the map. The crowd is drawn as two batches, one bright and one faded, so
 * a repository of thousands of files costs two draws; only the few files that need a look of
 * their own (chosen, hovered, on a shown route) borrow a real mesh from a small pool, which
 * carries their glow and outline.
 */
let solid: Batch | null = null;
let faint: Batch | null = null;
const pool: BABYLON.Mesh[] = [];
let poolUsed = 0;

// The batch of one look: white boxes tinted per copy, with the quiet glow every box had.
// The bloom is kept for what matters; the crowd stays matte and costs no extra glow pass.
function makeBatch(name: string, alpha: number): Batch
{
  const mesh = BABYLON.MeshBuilder.CreateBox(name, { size: 1 }, scene);
  glow.addExcludedMesh(mesh);
  // The copy's colour multiplies the emissive too, so 0.28 is the glow each box once had.
  return batchOf(mesh, 0.28, alpha);
}

function batches(): [Batch, Batch]
{
  if (!solid) solid = makeBatch("files", 1);
  if (!faint) faint = makeBatch("files-faint", 0.12);
  return [solid, faint];
}

// Gives the batches one slot per file on the map.
export function resizeBoxes(count: number): void
{
  const [a, b] = batches();
  a.resize(count);
  b.resize(count);
}

// Draws one file where its shape is now: in its batch, or as its own mesh when it has one.
export function placeBox(rec: FileRecord): void
{
  const [a, b] = batches();
  const { position: p, scaling: s } = rec.shape;
  if (rec.accent)
  {
    rec.accent.position.copyFrom(p);
    rec.accent.scaling.copyFrom(s);
    a.hide(rec.slot);
    b.hide(rec.slot);
    return;
  }
  const into = rec.lit ? a : b, out = rec.lit ? b : a;
  into.place(rec.slot, p.x, p.y, p.z, s.x, s.y, s.z);
  out.hide(rec.slot);
}

// Tints one file's slot in both batches, so it keeps its colour whichever one draws it.
export function paintBox(rec: FileRecord, color: BABYLON.Color3): void
{
  const [a, b] = batches();
  a.paint(rec.slot, color.r, color.g, color.b);
  b.paint(rec.slot, color.r, color.g, color.b);
}

// Hands every file its own mesh back to the pool, before the highlight picks who needs one.
export function releaseAccents(): void
{
  for (const rec of S.fileRecords.values()) rec.accent = null;
  poolUsed = 0;
}

// Lends one file a real mesh, with its own material and outline.
export function accent(rec: FileRecord, material: BABYLON.StandardMaterial, outline: boolean): void
{
  let mesh = pool[poolUsed];
  if (!mesh)
  {
    mesh = BABYLON.MeshBuilder.CreateBox("file-accent", { size: 1 }, scene);
    mesh.isPickable = false;
    mesh.outlineColor = BABYLON.Color3.White();
    mesh.outlineWidth = 0.04;
    mesh.enableEdgesRendering();
    mesh.edgesColor = new BABYLON.Color4(0.35, 0.82, 0.98, 0.4);
    mesh.edgesWidth = 0.6;
    pool.push(mesh);
  }
  poolUsed++;
  mesh.setEnabled(true);
  mesh.material = material;
  mesh.renderOutline = outline;
  rec.accent = mesh;
}

// Puts away the pool meshes nobody borrowed this time.
export function retireAccents(): void
{
  for (let i = poolUsed; i < pool.length; i++) pool[i].setEnabled(false);
}

export function flushBoxes(): void
{
  if (solid) solid.flush();
  if (faint) faint.flush();
}

// The file box under a screen point, nearest the camera, or null. Boxes are batched, so they
// cannot be picked as meshes; a ray against each box's own bounds is quick even for thousands.
export function pickFile(x: number, y: number): FileRecord | null
{
  const ray = scene.createPickingRay(x, y, BABYLON.Matrix.IdentityReadOnly, camera);
  let best: FileRecord | null = null, bestT = Infinity;
  for (const rec of S.fileRecords.values())
  {
    const { position: p, scaling: s } = rec.shape;
    if (s.y < 0.05) continue;
    const t = rayBox(ray.origin, ray.direction, p.x - s.x / 2, p.x + s.x / 2, p.y - s.y / 2, p.y + s.y / 2, p.z - s.z / 2, p.z + s.z / 2);
    if (t !== null && t < bestT) { bestT = t; best = rec; }
  }
  return best;
}

// Where a ray enters an axis-aligned box, or null if it misses. The slab method, three slabs.
export function rayBox(o: BABYLON.Vector3, d: BABYLON.Vector3, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): number | null
{
  let near = -Infinity, far = Infinity;
  const slab = (origin: number, dir: number, lo: number, hi: number): boolean =>
  {
    if (Math.abs(dir) < 1e-9) return origin >= lo && origin <= hi;
    let t1 = (lo - origin) / dir, t2 = (hi - origin) / dir;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    near = Math.max(near, t1); far = Math.min(far, t2);
    return far >= near;
  };
  if (!slab(o.x, d.x, minX, maxX) || !slab(o.y, d.y, minY, maxY) || !slab(o.z, d.z, minZ, maxZ)) return null;
  return far < 0 ? null : near;
}
