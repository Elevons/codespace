import { S, V3, scene, camera, engine, DEFAULT_BETA, colorFor, materialFor } from "./state.js";
import { resizeBoxes } from "./boxes.js";
import { resizePads } from "./pads.js";

let gridMesh: BABYLON.Mesh | null = null;

// Builds, reuses, or retires each file's record so its box sits on its folder's tile.
function syncMeshes(): void
{
  const seen = new Set<string>();
  // New boxes grow in one after another, but the whole build-in is held to about a second,
  // so a big repository does not keep the map busy for a minute.
  const freshCount = S.boxes.reduce((count, b) => count + (S.fileRecords.has(b.path) ? 0 : 1), 0);
  let fresh = 0;
  S.boxes.forEach((b, slot) =>
  {
    seen.add(b.path);
    let rec = S.fileRecords.get(b.path);
    if (!rec)
    {
      rec = {
        path: b.path, node: b.node, file: b.file, slot, lit: true, accent: null,
        shape: { position: b.terrace.clone(), scaling: b.terraceSize.clone() },
        terrace: b.terrace.clone(), target: b.terrace.clone(), targetSize: b.terraceSize.clone(),
      };
      // A new box starts as a sliver on its tile, and the frame loop grows it in.
      rec.shape.scaling.set(b.terraceSize.x, 0.01, b.terraceSize.z);
      rec.shape.position.set(b.terrace.x, b.terrace.y - b.terraceSize.y / 2 + 0.01, b.terrace.z);
      rec.delay = freshCount > 1 ? (fresh++ / (freshCount - 1)) * 1.1 : 0;
      S.fileRecords.set(b.path, rec);
    }
    rec.slot = slot;
    rec.node = b.node;
    rec.file = b.file;
    rec.terrace = b.terrace.clone();
    rec.target = b.terrace.clone();
    rec.targetSize = b.terraceSize.clone();
  });
  for (const path of [...S.fileRecords.keys()]) if (!seen.has(path)) S.fileRecords.delete(path);
  // The slots follow the new order; the highlight pass, due next frame, paints and places them.
  resizeBoxes(S.boxes.length);
  resizePads(S.boxes.length);

  // Every folder tile is batched into one mesh, with the outlines in one line system, so a
  // repository with thousands of folders still costs a handful of draws instead of thousands.
  if (S.plateMesh) { S.plateMesh.dispose(); S.plateMesh = null; }
  if (S.plateLines) { S.plateLines.dispose(); S.plateLines = null; }
  const tileParts: BABYLON.Mesh[] = [];
  const outlineLines: BABYLON.Vector3[][] = [];
  const outlineColors: BABYLON.Color4[][] = [];
  for (const n of S.NODES)
  {
    if (n.hidden || n.cx === undefined || n.cz === undefined) continue;
    const thickness = n.topY! - n.baseY!;
    const tile = BABYLON.MeshBuilder.CreateBox("tile", { width: n.tileW, height: thickness, depth: n.tileD }, scene);
    tile.position.set(n.cx, n.baseY! + thickness / 2, n.cz!);
    tileParts.push(tile);
    // A faint bevel of light along each tile's top edge, so folders read as solid ground.
    const y = n.topY! + 0.003, hw = n.tileW! / 2, hd = n.tileD! / 2, cx = n.cx, cz = n.cz!;
    const color = BABYLON.Color3.FromHexString(colorFor(n.layer)).toColor4(0.5);
    outlineLines.push([new V3(cx - hw, y, cz - hd), new V3(cx + hw, y, cz - hd), new V3(cx + hw, y, cz + hd), new V3(cx - hw, y, cz + hd), new V3(cx - hw, y, cz - hd)]);
    outlineColors.push([color, color, color, color, color]);
  }
  if (tileParts.length > 0)
  {
    S.plateMesh = BABYLON.Mesh.MergeMeshes(tileParts, true, true);
    if (S.plateMesh)
    {
      S.plateMesh.name = "tiles";
      S.plateMesh.material = materialFor("#22303f", 0.26, 0.08);
      S.plateMesh.isPickable = false;
    }
  }
  if (outlineLines.length > 0)
  {
    S.plateLines = BABYLON.MeshBuilder.CreateLineSystem("tile-outlines", { lines: outlineLines, colors: outlineColors, useVertexAlpha: true }, scene);
    S.plateLines.isPickable = false;
  }

  buildGrid();
  buildLayerPlanes();
}

// One translucent plane per layer, stacked so each layer's files can rise to it.
function buildLayerPlanes(): void
{
  for (const plane of S.layerPlanes) plane.dispose();
  S.layerPlanes = [];
  if (S.LAYERS.length === 0) return;
  const bounds = sceneBounds();
  const width = bounds ? bounds.max.x - bounds.min.x + 6 : 12;
  const depth = bounds ? bounds.max.z - bounds.min.z + 6 : 12;
  const cx = bounds ? (bounds.min.x + bounds.max.x) / 2 : 0;
  const cz = bounds ? (bounds.min.z + bounds.max.z) / 2 : 0;
  S.LAYERS.forEach((name, index) =>
  {
    const plane = BABYLON.MeshBuilder.CreateGround("layer:" + name, { width, height: depth }, scene);
    plane.position.set(cx, index * S.layerGap, cz);
    // The sheet is barely there; its coloured outline and the file rings do the reading.
    plane.material = materialFor(colorFor(name), 0.04, 0.06);
    (plane.material as BABYLON.StandardMaterial).backFaceCulling = false;
    plane.isPickable = false;
    plane.metadata = { layer: name, rank: index };

    const hx = width / 2, hz = depth / 2;
    const border = BABYLON.MeshBuilder.CreateLines("layer-border:" + name, {
      points: [new V3(-hx, 0, -hz), new V3(hx, 0, -hz), new V3(hx, 0, hz), new V3(-hx, 0, hz), new V3(-hx, 0, -hz)],
    }, scene);
    border.color = BABYLON.Color3.FromHexString(colorFor(name));
    border.alpha = 0.38;
    border.parent = plane;
    border.isPickable = false;
    S.layerPlanes.push(plane);
  });
}

// A ground grid under everything, the clearest hint of which way is up. A plain ruled
// sheet: the sweeps and range rings that used to sit here fought the folder tiles.
function buildGrid(): void
{
  if (gridMesh) gridMesh.dispose();
  gridMesh = null;
  const bounds = sceneBounds();
  if (!bounds) return;
  const step = 2;
  const half = Math.ceil(Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) / 2 / step + 4) * step;
  const cx = Math.round((bounds.min.x + bounds.max.x) / 2 / step) * step;
  const cz = Math.round((bounds.min.z + bounds.max.z) / 2 / step) * step;
  const y = bounds.min.y - 0.4;
  const lines: BABYLON.Vector3[][] = [], colors: BABYLON.Color4[][] = [];
  const color = new BABYLON.Color4(0.32, 0.85, 1, 0.075);
  for (let offset = -half; offset <= half; offset += step)
  {
    lines.push([new V3(cx + offset, y, cz - half), new V3(cx + offset, y, cz + half)]);
    lines.push([new V3(cx - half, y, cz + offset), new V3(cx + half, y, cz + offset)]);
    colors.push([color, color], [color, color]);
  }
  gridMesh = BABYLON.MeshBuilder.CreateLineSystem("grid", { lines, colors, useVertexAlpha: true }, scene);
  gridMesh.isPickable = false;
}

// The box that holds every visible file at its resting spot.
function sceneBounds(): { min: BABYLON.Vector3; max: BABYLON.Vector3 } | null
{
  let min: BABYLON.Vector3 | null = null, max: BABYLON.Vector3 | null = null;
  for (const rec of S.fileRecords.values())
  {
    const half = rec.targetSize.scale(0.5);
    const low = rec.target.subtract(half), high = rec.target.add(half);
    min = min ? V3.Minimize(min, low) : low;
    max = max ? V3.Maximize(max, high) : high;
  }
  if (S.plateMesh)
  {
    const info = S.plateMesh.getBoundingInfo().boundingBox;
    min = min ? V3.Minimize(min, info.minimumWorld) : info.minimumWorld.clone();
    max = max ? V3.Maximize(max, info.maximumWorld) : info.maximumWorld.clone();
  }
  return min ? { min, max: max! } : null;
}

// Glides the camera to frame everything; `instant` jumps there instead.
function centerView(instant: boolean): void
{
  const bounds = sceneBounds();
  if (!bounds) return;
  const center = V3.Center(bounds.min, bounds.max);
  const reach = V3.Distance(bounds.min, bounds.max) / 2;
  const aspect = engine.getAspectRatio(camera);
  const fit = Math.min(camera.fov, 2 * Math.atan(Math.tan(camera.fov / 2) * aspect));
  const radius = Math.max(6, (reach / Math.sin(fit / 2)) * 0.95);
  S.camGoal = { target: center, radius, beta: DEFAULT_BETA };
  if (instant) settleCamera(1);
}

// Moves the camera's aim back to the middle, leaving how far away it is alone.
function recenterTarget(): void
{
  const bounds = sceneBounds();
  if (!bounds) return;
  S.camGoal = { target: V3.Center(bounds.min, bounds.max), radius: camera.radius };
}

// Steps the camera a share of the way to where it is gliding.
function settleCamera(share: number): void
{
  if (!S.camGoal) return;
  V3.LerpToRef(camera.target, S.camGoal.target, share, camera.target);
  camera.radius += (S.camGoal.radius - camera.radius) * share;
  if (S.camGoal.beta !== undefined) camera.beta += (S.camGoal.beta - camera.beta) * share;
  const tilted = S.camGoal.beta === undefined || Math.abs(camera.beta - S.camGoal.beta) < 0.002;
  if (tilted && V3.Distance(camera.target, S.camGoal.target) < 0.01 && Math.abs(camera.radius - S.camGoal.radius) < 0.01) S.camGoal = null;
}

/** One pulse ring: a ring on a folder's floor that grows and fades after a live change. */
interface Ring { mesh: BABYLON.Mesh; material: BABYLON.StandardMaterial; start: number; life: number }
const rings: Ring[] = [];

// Marks a file that just changed with a green ring on its folder's floor, drawn out from its tile.
export function pulseFile(path: string): void
{
  const rec = S.fileRecords.get(path);
  if (!rec) return;
  const folder = S.NODES[rec.node];
  const y = (folder && folder.topY !== undefined ? folder.topY : rec.terrace.y) + 0.02;
  const mesh = BABYLON.MeshBuilder.CreateTorus("pulse:" + path, { diameter: 1, thickness: 0.06, tessellation: 32 }, scene);
  mesh.position.set(rec.terrace.x, y, rec.terrace.z);
  mesh.isPickable = false;
  const material = new BABYLON.StandardMaterial("pulse", scene);
  material.disableLighting = true;
  material.emissiveColor = BABYLON.Color3.FromHexString("#3fb950");
  material.alpha = 0.9;
  mesh.material = material;
  rings.push({ mesh, material, start: -1, life: 1.4 });
}

// Grows and fades each pulse ring; `now` is the page clock in seconds.
export function updatePulses(now: number): void
{
  for (let i = rings.length - 1; i >= 0; i--)
  {
    const ring = rings[i];
    if (ring.start < 0) ring.start = now;
    const age = now - ring.start;
    if (age > ring.life) { ring.mesh.dispose(); rings.splice(i, 1); continue; }
    const t = age / ring.life;
    const scale = 0.6 + t * 3.4;
    ring.mesh.scaling.set(scale, 1, scale);
    ring.material.alpha = 0.9 * (1 - t);
  }
}

export { syncMeshes, centerView, recenterTarget, settleCamera };
