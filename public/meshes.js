import { S, V3, scene, camera, engine, DEFAULT_BETA, colorFor, materialFor } from "./state.js";

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
    const thickness = n.topY - n.baseY;
    const plate = BABYLON.MeshBuilder.CreateBox("plate:" + n.id, { width: n.tileW, height: thickness, depth: n.tileD }, scene);
    plate.position.set(n.cx, n.baseY + thickness / 2, n.cz);
    plate.metadata = { node: n.index, file: -1 };
    plate.enableEdgesRendering();
    plate.edgesWidth = 2.5;
    S.plates.push(plate);
  }

  buildGrid();
  buildLayerPlanes();
}

// One translucent plane per layer, stacked so each layer's files can rise to it.
function buildLayerPlanes()
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
    plane.material = materialFor("#1f7f9c", 0.08, 0.1);
    plane.material.backFaceCulling = false;
    plane.isPickable = false;
    plane.metadata = { layer: name, rank: index };

    // A bright outline in the layer's own colour, so the level reads even though the sheet is faint.
    const hx = width / 2, hz = depth / 2;
    const border = BABYLON.MeshBuilder.CreateLines("layer-border:" + name, {
      points: [new V3(-hx, 0, -hz), new V3(hx, 0, -hz), new V3(hx, 0, hz), new V3(-hx, 0, hz), new V3(-hx, 0, -hz)],
    }, scene);
    border.color = BABYLON.Color3.FromHexString(colorFor(name));
    border.parent = plane;
    border.isPickable = false;
    S.layerPlanes.push(plane);
  });
}

// One file's box, starting where its terrace sits and at its terrace size.
function makeBox(path, target, size)
{
  const mesh = BABYLON.MeshBuilder.CreateBox("file:" + path, { size: 1 }, scene);
  mesh.position.copyFrom(target);
  mesh.scaling.copyFrom(size);
  mesh.outlineColor = BABYLON.Color3.White();
  mesh.outlineWidth = 0.04;
  mesh.enableEdgesRendering();
  mesh.edgesColor = new BABYLON.Color4(0.35, 0.82, 0.98, 0.4);
  mesh.edgesWidth = 1.2;
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
  const color = new BABYLON.Color4(0.32, 0.85, 1, 0.1);
  for (let offset = -half; offset <= half; offset += step)
  {
    lines.push([new V3(cx + offset, y, cz - half), new V3(cx + offset, y, cz + half)]);
    lines.push([new V3(cx - half, y, cz + offset), new V3(cx + half, y, cz + offset)]);
    colors.push([color, color], [color, color]);
  }
  // Spokes out from the centre, then range rings, like a sensor sweep.
  const spokeColor = new BABYLON.Color4(0.32, 0.85, 1, 0.05);
  for (let i = 0; i < 16; i++)
  {
    const angle = (i / 16) * Math.PI * 2;
    lines.push([new V3(cx, y, cz), new V3(cx + Math.cos(angle) * half, y, cz + Math.sin(angle) * half)]);
    colors.push([spokeColor, spokeColor]);
  }
  const ringColor = new BABYLON.Color4(0.4, 0.9, 1, 0.08);
  for (const radius of [half * 0.2, half * 0.4, half * 0.6, half * 0.8, half])
  {
    const points = [];
    for (let i = 0; i <= 96; i++)
    {
      const angle = (i / 96) * Math.PI * 2;
      points.push(new V3(cx + Math.cos(angle) * radius, y, cz + Math.sin(angle) * radius));
    }
    lines.push(points);
    colors.push(points.map(() => ringColor));
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
