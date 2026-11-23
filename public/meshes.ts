import { S, V3, scene, camera, engine, DEFAULT_BETA, colorFor, materialFor, fileColor, layerRank } from "./state.js";
import { columnColor, subtreeIndices } from "./rules.js";
import { resizeBoxes, paintBox, flushBoxes } from "./boxes.js";
import { colorOf } from "./batch.js";
import { resizePads } from "./pads.js";
import type { GraphNode } from "./types.js";

let gridMesh: BABYLON.Mesh | null = null;
let plateMesh: BABYLON.Mesh | null = null;
let plateLines: BABYLON.Mesh | null = null;

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
  if (plateMesh) { plateMesh.dispose(); plateMesh = null; }
  if (plateLines) { plateLines.dispose(); plateLines = null; }
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
    plateMesh = BABYLON.Mesh.MergeMeshes(tileParts, true, true);
    if (plateMesh)
    {
      plateMesh.name = "tiles";
      plateMesh.material = materialFor("#22303f", 0.26, 0.08);
      plateMesh.isPickable = false;
    }
  }
  if (outlineLines.length > 0)
  {
    plateLines = BABYLON.MeshBuilder.CreateLineSystem("tile-outlines", { lines: outlineLines, colors: outlineColors, useVertexAlpha: true }, scene);
    plateLines.isPickable = false;
  }

  buildGrid();
  buildColumns();
}

// The chosen folder's visible children are drawn as glass columns, each with a floor at every
// layer its files use. A folder with no visible children is drawn as one column itself, so a
// leaf still shows the layers its files sit on.
function columnParent(): GraphNode | null
{
  const root = S.NODES.find((n) => n.id === "");
  if (!root) return null;
  if (S.columnRoot === null) return root;
  const inside = S.NODES.find((n) => n.id === S.columnRoot);
  if (inside) return inside;
  // The folder that was isolated has gone, so come back out to the repository root.
  S.columnRoot = null;
  return root;
}

function clearColumnMeshes(): void
{
  for (const mesh of S.columnMeshes) mesh.dispose();
  S.columnMeshes = [];
  S.columnTops.clear();
}

// The glass walls and the per-layer floor plates of one column. The top and the floors come from
// the files actually drawn in its subtree, so a filter or an eye that empties a layer takes its
// floor with it. Returns whether there was anything to draw.
function addColumn(n: GraphNode): boolean
{
  if (n.hidden || n.cx === undefined || n.cz === undefined || n.tileW === undefined || n.tileD === undefined) return false;
  const index = n.index;
  if (index === undefined) return false;
  const inside = subtreeIndices(n);
  const ranks = new Set<number>();
  let top = n.topY ?? 0, holdsFile = false;
  for (const rec of S.fileRecords.values())
  {
    if (!inside.has(rec.node)) continue;
    holdsFile = true;
    top = Math.max(top, rec.target.y + rec.targetSize.y / 2);
    const layer = S.LAYERS.length > 0 ? S.FILE_LAYERS.get(rec.path) : undefined;
    if (layer === undefined) continue;
    const rank = layerRank(layer);
    if (rank >= 0) ranks.add(rank);
  }
  if (!holdsFile) return false;
  top = Math.max(top, ...[...ranks].map((rank) => rank * S.layerGap)) + 0.8;
  S.columnTops.set(index, top);

  // The glass: a faint box and its vertical edges, so the column reads without hiding its files.
  const base = n.topY ?? 0;
  const height = Math.max(0.2, top - base);
  const hue = columnColor(n.id);
  const wall = BABYLON.MeshBuilder.CreateBox("column", { width: n.tileW, height, depth: n.tileD }, scene);
  wall.position.set(n.cx, base + height / 2, n.cz);
  const wallMaterial = materialFor(hue, 0.035, 0.02);
  wallMaterial.backFaceCulling = false;
  wall.material = wallMaterial;
  wall.isPickable = false;
  wall.metadata = { kind: "wall", index };
  S.columnMeshes.push(wall);

  // The edges: the four upright corners and the four top rims, each its own line so the ones on the
  // far side can fade as the camera turns (fadeBackEdges). Drawn whole, the back edges show through
  // the glass and tangle with the columns in front.
  const hw = n.tileW / 2, hd = n.tileD / 2;
  const corners = [[-hw, -hd], [hw, -hd], [hw, hd], [-hw, hd]].map(([x, z]) => new V3(n.cx! + x, base, n.cz! + z));
  const edgeColor = BABYLON.Color3.FromHexString(hue);
  const addEdge = (from: BABYLON.Vector3, to: BABYLON.Vector3, ends: number[]): void =>
  {
    const line = BABYLON.MeshBuilder.CreateLines("column-edge", { points: [from, to] }, scene);
    line.color = edgeColor;
    line.alpha = EDGE_ALPHA;
    line.isPickable = false;
    line.metadata = { kind: "edge", index, ends, corners };
    S.columnMeshes.push(line);
  };
  for (let i = 0; i < 4; i++)
  {
    const corner = corners[i], next = corners[(i + 1) % 4];
    addEdge(corner, new V3(corner.x, top, corner.z), [i]);
    addEdge(new V3(corner.x, top, corner.z), new V3(next.x, top, next.z), [i, (i + 1) % 4]);
  }

  // A thin plate at each layer the column holds, in that layer's colour.
  for (const rank of [...ranks].sort((a, b) => a - b))
  {
    const layer = S.shownLayers[rank];
    if (layer === undefined) continue;
    const y = rank === 0 ? base + 0.012 : rank * S.layerGap;
    const plate = BABYLON.MeshBuilder.CreateBox("column-floor", { width: Math.max(0.2, n.tileW - 0.3), height: 0.02, depth: Math.max(0.2, n.tileD - 0.3) }, scene);
    plate.position.set(n.cx, y, n.cz);
    plate.material = materialFor(colorFor(layer), 0.12, 0.16);
    plate.isPickable = false;
    plate.metadata = { kind: "floor", layer, index };
    S.columnMeshes.push(plate);
    const outline = BABYLON.MeshBuilder.CreateLines("column-floor-edge", {
      points: [new V3(-hw + 0.15, 0, -hd + 0.15), new V3(hw - 0.15, 0, -hd + 0.15), new V3(hw - 0.15, 0, hd - 0.15), new V3(-hw + 0.15, 0, hd - 0.15), new V3(-hw + 0.15, 0, -hd + 0.15)],
    }, scene);
    outline.position.set(n.cx, y + 0.011, n.cz);
    outline.color = BABYLON.Color3.FromHexString(colorFor(layer));
    outline.alpha = 0.5;
    outline.isPickable = false;
    outline.metadata = { kind: "floor", layer, index };
    S.columnMeshes.push(outline);
  }
  return true;
}

// Every folder column for the current choice: the chosen folder's visible children, or the folder
// itself when it has none to split into.
function buildColumns(): void
{
  clearColumnMeshes();
  const parent = columnParent();
  if (!parent) return;
  let drawn = 0;
  for (const n of parent.children) if (addColumn(n)) drawn++;
  if (drawn === 0) addColumn(parent);
}

/** How strong a column's edges are, and how far the ones on its far side fade. */
const EDGE_ALPHA = 0.42, BACK_EDGE_ALPHA = 0.06;

// Fades each column's edges on the side away from the camera: the upright at its farthest corner
// and the two rims that meet there. Cheap enough for every frame, as there are only a few columns.
function fadeBackEdges(): void
{
  const eye = camera.position;
  const far = new Map<number, number>();
  for (const mesh of S.columnMeshes)
  {
    const meta = mesh.metadata as { kind?: string; index?: number; corners?: BABYLON.Vector3[] } | undefined;
    if (meta?.kind !== "edge" || meta.index === undefined || far.has(meta.index) || !meta.corners) continue;
    let best = 0, bestDistance = -1;
    meta.corners.forEach((corner, i) => { const d = (corner.x - eye.x) ** 2 + (corner.z - eye.z) ** 2; if (d > bestDistance) { bestDistance = d; best = i; } });
    far.set(meta.index, best);
  }
  for (const mesh of S.columnMeshes)
  {
    const meta = mesh.metadata as { kind?: string; index?: number; ends?: number[] } | undefined;
    if (meta?.kind !== "edge" || meta.index === undefined || !meta.ends) continue;
    mesh.alpha = meta.ends.includes(far.get(meta.index) ?? -1) ? BACK_EDGE_ALPHA : EDGE_ALPHA;
  }
}

// Redraws the folder columns after a choice changes which folder is inside, without rebuilding the
// treemap, the boxes, or the grid, none of which move when the choice changes.
function refreshColumns(): void
{
  buildColumns();
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
  if (plateMesh)
  {
    const info = plateMesh.getBoundingInfo().boundingBox;
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

// A file box that flashes bright after a live change, alongside the ring on its folder's floor.
interface Flash { start: number }
const flashes = new Map<string, Flash>();
const FLASH_COLOR = BABYLON.Color3.FromHexString("#c8ffd2");
const FLASH_LIFE = 2.5;

// Marks a file that just changed with a green ring on its folder's floor, drawn out from its tile.
export function pulseFile(path: string): void
{
  const rec = S.fileRecords.get(path);
  if (!rec) return;
  flashes.set(path, { start: -1 });
  const folder = S.NODES[rec.node];
  const y = (folder && folder.topY !== undefined ? folder.topY : rec.terrace.y) + 0.02;
  const mesh = BABYLON.MeshBuilder.CreateTorus("pulse:" + path, { diameter: 1, thickness: 0.03, tessellation: 32 }, scene);
  mesh.position.set(rec.terrace.x, y, rec.terrace.z);
  mesh.isPickable = false;
  const material = new BABYLON.StandardMaterial("pulse", scene);
  material.disableLighting = true;
  material.emissiveColor = BABYLON.Color3.FromHexString("#3fb950");
  material.alpha = 0.9;
  mesh.material = material;
  rings.push({ mesh, material, start: -1, life: 2.5 });
}

// The base colour of a file, blended toward the flash tint by `k` (0 for its own colour).
function flashTint(path: string, k: number): BABYLON.Color3
{
  const base = colorOf(fileColor(path));
  return new BABYLON.Color3(
    base.r + (FLASH_COLOR.r - base.r) * k,
    base.g + (FLASH_COLOR.g - base.g) * k,
    base.b + (FLASH_COLOR.b - base.b) * k);
}

// Grows and fades each pulse ring and flashes each changed file's box; `now` is the page clock in seconds.
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

  // A changed file's box brightens, then settles back to its own colour.
  let painted = false;
  for (const [path, flash] of flashes)
  {
    const rec = S.fileRecords.get(path);
    if (!rec) { flashes.delete(path); continue; }
    if (flash.start < 0) flash.start = now;
    const age = now - flash.start;
    if (age > FLASH_LIFE) { paintBox(rec, colorOf(fileColor(path))); flashes.delete(path); }
    else paintBox(rec, flashTint(path, (1 - age / FLASH_LIFE) ** 2));
    painted = true;
  }
  if (painted) flushBoxes();
}

export { syncMeshes, centerView, recenterTarget, settleCamera, refreshColumns, fadeBackEdges };
