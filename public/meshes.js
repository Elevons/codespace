import { S, V3, scene, camera, engine, PLATE_H, DEFAULT_BETA } from "./state.js";

let gridMesh = null;

// Builds, reuses, or retires each file's box so it sits on its folder's tile.
function syncMeshes()
{
  const seen = new Set();
  for (const b of S.boxes)
  {
    seen.add(b.path);
    let rec = S.fileRecords.get(b.path);
    if (!rec)
    {
      rec = { path: b.path, mesh: null };
      S.fileRecords.set(b.path, rec);
    }
    rec.node = b.node;
    rec.file = b.file;
    rec.target = b.terrace.clone();
    rec.targetSize = b.terraceSize.clone();
    if (!rec.mesh) rec.mesh = makeBox(rec.path, b.terrace, b.terraceSize);
    rec.mesh.metadata = { node: b.node, file: b.file, path: b.path };
  }
  for (const [path, rec] of S.fileRecords)
  {
    if (seen.has(path)) continue;
    rec.mesh.dispose();
    S.fileRecords.delete(path);
  }

  for (const plate of S.plates) plate.dispose();
  S.plates = [];
  for (const n of S.NODES)
  {
    if (n.hidden || n.cx === undefined) continue;
    const plate = BABYLON.MeshBuilder.CreateBox("plate:" + n.id, { width: n.tileW, height: PLATE_H, depth: n.tileD }, scene);
    plate.position.set(n.cx, n.baseY + PLATE_H / 2, n.cz);
    plate.metadata = { node: n.index, file: -1 };
    plate.enableEdgesRendering();
    plate.edgesWidth = 2.5;
    S.plates.push(plate);
  }

  buildGrid();
}

// One file's box, starting where its terrace sits and at its terrace size.
function makeBox(path, target, size)
{
  const mesh = BABYLON.MeshBuilder.CreateBox("file:" + path, { size: 1 }, scene);
  mesh.position.copyFrom(target);
  mesh.scaling.copyFrom(size);
  mesh.outlineColor = BABYLON.Color3.White();
  mesh.outlineWidth = 0.04;
  return mesh;
}

// A ground grid under everything, the clearest hint of which way is up.
function buildGrid()
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
  const lines = [], colors = [];
  const color = new BABYLON.Color4(0.55, 0.6, 0.68, 0.12);
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
function sceneBounds()
{
  let min = null, max = null;
  for (const rec of S.fileRecords.values())
  {
    const half = rec.targetSize.scale(0.5);
    const low = rec.target.subtract(half), high = rec.target.add(half);
    min = min ? V3.Minimize(min, low) : low;
    max = max ? V3.Maximize(max, high) : high;
  }
  for (const plate of S.plates)
  {
    const info = plate.getBoundingInfo().boundingBox;
    min = min ? V3.Minimize(min, info.minimumWorld) : info.minimumWorld.clone();
    max = max ? V3.Maximize(max, info.maximumWorld) : info.maximumWorld.clone();
  }
  return min ? { min, max } : null;
}

// Glides the camera to frame everything; `instant` jumps there instead.
function centerView(instant)
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
function recenterTarget()
{
  const bounds = sceneBounds();
  if (!bounds) return;
  S.camGoal = { target: V3.Center(bounds.min, bounds.max), radius: camera.radius };
}

// Steps the camera a share of the way to where it is gliding.
function settleCamera(share)
{
  if (!S.camGoal) return;
  V3.LerpToRef(camera.target, S.camGoal.target, share, camera.target);
  camera.radius += (S.camGoal.radius - camera.radius) * share;
  if (S.camGoal.beta !== undefined) camera.beta += (S.camGoal.beta - camera.beta) * share;
  const tilted = S.camGoal.beta === undefined || Math.abs(camera.beta - S.camGoal.beta) < 0.002;
  if (tilted && V3.Distance(camera.target, S.camGoal.target) < 0.01 && Math.abs(camera.radius - S.camGoal.radius) < 0.01) S.camGoal = null;
}

export { syncMeshes, centerView, recenterTarget, settleCamera };
