import { scene } from "./state.js";

// A batch's shared look: white copies tinted per slot, with a quiet glow and the one alpha.
export function batchOf(mesh: BABYLON.Mesh, emissive: number, alpha: number): Batch
{
  const material = new BABYLON.StandardMaterial(mesh.name, scene);
  material.diffuseColor = BABYLON.Color3.White();
  material.emissiveColor = new BABYLON.Color3(emissive, emissive, emissive);
  material.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06);
  material.alpha = alpha;
  mesh.material = material;
  return new Batch(mesh);
}

// Parsed colours, kept: a repaint touches every file, and parsing hex each time adds up.
const parsedColors = new Map<string, BABYLON.Color3>();
export function colorOf(hex: string): BABYLON.Color3
{
  let color = parsedColors.get(hex);
  if (!color) { color = BABYLON.Color3.FromHexString(hex); parsedColors.set(hex, color); }
  return color;
}

/**
 * Many copies of one shape drawn in a single call: a Babylon mesh with thin instances, one
 * slot per copy, each slot with its own spot, size, and colour. A thousand file boxes cost one
 * draw this way instead of a thousand. A slot is hidden by giving it no size.
 */
export class Batch
{
  readonly mesh: BABYLON.Mesh;
  private matrices = new Float32Array(0);
  private colors = new Float32Array(0);
  private count = 0;
  private matricesDirty = false;
  private colorsDirty = false;

  constructor(mesh: BABYLON.Mesh)
  {
    this.mesh = mesh;
    mesh.isPickable = false;
    // The copies move every frame while they glide, so skip culling and bounds upkeep entirely.
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.doNotSyncBoundingInfo = true;
  }

  // Makes room for exactly `count` slots, every one hidden until it is placed.
  resize(count: number): void
  {
    if (count === this.count && this.matrices.length > 0) return;
    this.count = count;
    this.matrices = new Float32Array(Math.max(1, count) * 16);
    this.colors = new Float32Array(Math.max(1, count) * 4).fill(1);
    this.mesh.thinInstanceSetBuffer("matrix", this.matrices, 16, false);
    this.mesh.thinInstanceSetBuffer("color", this.colors, 4, false);
    this.mesh.thinInstanceCount = count;
    this.matricesDirty = this.colorsDirty = false;
  }

  // Puts one slot at a spot and size; a slot with no size is not drawn.
  place(slot: number, x: number, y: number, z: number, sx: number, sy: number, sz: number): void
  {
    const m = this.matrices, o = slot * 16;
    m[o] = sx; m[o + 1] = 0; m[o + 2] = 0; m[o + 3] = 0;
    m[o + 4] = 0; m[o + 5] = sy; m[o + 6] = 0; m[o + 7] = 0;
    m[o + 8] = 0; m[o + 9] = 0; m[o + 10] = sz; m[o + 11] = 0;
    m[o + 12] = x; m[o + 13] = y; m[o + 14] = z; m[o + 15] = 1;
    this.matricesDirty = true;
  }

  hide(slot: number): void
  {
    this.matrices.fill(0, slot * 16, slot * 16 + 16);
    this.matricesDirty = true;
  }

  paint(slot: number, r: number, g: number, b: number): void
  {
    const c = this.colors, o = slot * 4;
    c[o] = r; c[o + 1] = g; c[o + 2] = b; c[o + 3] = 1;
    this.colorsDirty = true;
  }

  // Sends what changed this frame to the GPU, once.
  flush(): void
  {
    if (this.count === 0) return;
    if (this.matricesDirty) this.mesh.thinInstanceBufferUpdated("matrix");
    if (this.colorsDirty) this.mesh.thinInstanceBufferUpdated("color");
    this.matricesDirty = this.colorsDirty = false;
  }
}
