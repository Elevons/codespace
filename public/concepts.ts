import { S, V3, scene, camera, canvas, layerRank, render, renderEdges, fileIndex, glow } from "./state.js";
import { centerView, buildLayerPlanes, setConceptBounds, sceneryMeshes } from "./meshes.js";
import { pickFile } from "./boxes.js";
import { selectFile } from "./panels.js";
import { changeView } from "./viewcall.js";
import { setSpin } from "./controls.js";
import { conceptSpineLayout, type IConceptRoute } from "./rules.js";
import type { FileRecord } from "./types.js";

const Unmapped = "Not in an operation";
const DotSize = 0.32;
const DotBig = 0.55;
const ConceptAlpha = -Math.PI / 2 - 0.08;

interface Spot
{
  name: string;
  at: BABYLON.Vector3;
  color: BABYLON.Color3;
  files: string[];
  radius: number;
  unmapped: boolean;
  pill?: BABYLON.Mesh;
  tag?: HTMLElement;
  lowY: number;
  highY: number;
}

interface Marker
{
  name: string;
  at: BABYLON.Vector3;
  dockedTo: string | null;
  y: number;
  files: string[];
  mesh?: BABYLON.Mesh;
  tag?: HTMLElement;
}

interface Layout
{
  operations: Spot[];
  things: Marker[];
  home: Map<string, BABYLON.Vector3>;
  center: BABYLON.Vector3;
  spine: { minX: number; maxX: number; z: number; halfDepth: number } | null;
  tray: { x: number; z: number; width: number; depth: number } | null;
  routes: IConceptRoute[];
  spineDeck?: BABYLON.Mesh;
  spineRim?: BABYLON.Mesh;
  spineRisers?: BABYLON.Mesh;
  trayRim?: BABYLON.Mesh;
}

interface Link { op: string; thing: string; kind: "reads" | "writes"; mesh: BABYLON.Mesh }

const ThingColor = new BABYLON.Color3(0.89, 0.7, 0.26);

let layout: Layout | null = null;
let layoutKey = "";
let meshes: BABYLON.Mesh[] = [];
let links: Link[] = [];
let linkKey = "";
let riserKey = "";
let hiddenScenery: BABYLON.Mesh[] = [];
const sizes = new WeakMap<FileRecord, { rest: BABYLON.Vector3; mine: BABYLON.Vector3 }>();

const overlay = document.createElement("div");
overlay.id = "concept-labels";
overlay.hidden = true;
// What the shapes are, since nothing else on the map says: a hexagon is data, a sleeve is something that changes it.
const key = document.createElement("div");
key.id = "concept-key";
key.hidden = true;
key.innerHTML = '<div><i class="hex"></i><b>Data</b> kept or passed on; its own files stand under it</div>' +
  '<div><i class="op"></i><b>Operation</b> changes data; its files stand in its column</div>' +
  '<div><i class="read"></i>reads \u00b7 <i class="write"></i>writes</div>';
document.body.appendChild(key);
document.body.appendChild(overlay);
const button = document.getElementById("concept-zoom") as HTMLButtonElement | null;

function hueColor(index: number, count: number): BABYLON.Color3
{
  return BABYLON.Color3.FromHSV((index * 360 / Math.max(count, 1) + 20) % 360, 0.55, 0.95);
}

// While zoomed out a file sits on its own layer's plane, not on its folder's tile: the columns read
// by layer, and a deep folder must not lift a dot above the plane it belongs to. The dot's centre is
// half a dot above the plane, so its base rests on it and its ring sits just under it.
function stackY(path: string): number
{
  const layer = S.FILE_LAYERS.get(path);
  const rank = layer === undefined ? -1 : layerRank(layer);
  return (rank < 0 ? 0 : rank * S.layerGap) + DotSize / 2;
}

// Operations line up in two banks flanking a central data spine of shared things; single-owner
// things dock beside their parent column, and unmapped files sit in a quiet tray to the side.
function buildLayout(): Layout | null
{
  const records = [...S.fileRecords.values()];
  if (records.length === 0) return null;
  let min = records[0].terrace.clone(), max = min.clone();
  for (const rec of records) { min = V3.Minimize(min, rec.terrace); max = V3.Maximize(max, rec.terrace); }
  const center = new V3((min.x + max.x) / 2, 0, (min.z + max.z) / 2);

  const opCount = Object.keys(S.CONCEPTS.operations).length;
  const plan = conceptSpineLayout({
    center: { x: center.x, z: center.z },
    files: records.map((rec) => ({ path: rec.path, y: stackY(rec.path) })),
    things: S.CONCEPTS.things,
    operations: S.CONCEPTS.operations,
    unmappedName: Unmapped,
  });

  const home = new Map<string, BABYLON.Vector3>();
  for (const [path, pos] of plan.home) home.set(path, new V3(pos.x, pos.y, pos.z));

  const stackMid = (min.y + max.y) / 2;
  const operations: Spot[] = plan.operations.map((op) =>
  {
    const color = op.unmapped ? new BABYLON.Color3(0.45, 0.5, 0.56) : hueColor(op.index, opCount);
    let low = Infinity, high = -Infinity;
    for (const path of op.files)
    {
      const y = S.fileRecords.get(path)?.terrace.y;
      if (y === undefined) continue;
      low = Math.min(low, y); high = Math.max(high, y);
    }
    if (low > high) { low = stackMid - 0.5; high = stackMid + 0.5; }
    return { name: op.name, at: new V3(op.x, 0, op.z), color, files: op.files, radius: op.radius, unmapped: op.unmapped, lowY: low, highY: high };
  });

  const things: Marker[] = plan.things.map((thing) => ({
    name: thing.name,
    at: new V3(thing.x, 0, thing.z),
    dockedTo: thing.dockedTo,
    y: stackMid,
    files: thing.files,
  }));

  return { operations, things, home, center, spine: plan.spine, tray: plan.tray, routes: plan.routes };
}

// Updates the extra bounds passed to meshes.ts so layer planes and camera framing cover docked
// badges, column rims, and the spine corridor without clipping at the edges.
function updateBounds(at: Layout): void
{
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  const expand = (x: number, y: number, z: number, rx: number, rz: number): void =>
  {
    minX = Math.min(minX, x - rx); maxX = Math.max(maxX, x + rx);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    minZ = Math.min(minZ, z - rz); maxZ = Math.max(maxZ, z + rz);
  };
  for (const spot of at.operations)
  {
    expand(spot.at.x, spot.lowY, spot.at.z, spot.radius + 0.4, spot.radius + 0.4);
    expand(spot.at.x, spot.highY, spot.at.z, spot.radius + 0.4, spot.radius + 0.4);
  }
  for (const marker of at.things) expand(marker.at.x, marker.y, marker.at.z, 1.1, 1.1);
  if (at.spine)
  {
    const cx = (at.spine.minX + at.spine.maxX) / 2;
    const hw = (at.spine.maxX - at.spine.minX) / 2;
    expand(cx, minY === Infinity ? 0 : minY, at.spine.z, hw, at.spine.halfDepth);
  }
  if (at.tray) expand(at.tray.x, minY === Infinity ? 0 : minY, at.tray.z, at.tray.width / 2, at.tray.depth / 2);
  if (minX <= maxX) setConceptBounds({ min: new V3(minX, minY, minZ), max: new V3(maxX, maxY, maxZ) });
}

function roundedRectPoints(cx: number, cz: number, hw: number, hd: number, radius: number): BABYLON.Vector3[]
{
  const r = Math.min(radius, hw * 0.45, hd * 0.45);
  const corners: [number, number, number, number][] = [
    [cx + hw - r, cz + hd - r, 0, Math.PI / 2],
    [cx - hw + r, cz + hd - r, Math.PI / 2, Math.PI],
    [cx - hw + r, cz - hd + r, Math.PI, Math.PI * 1.5],
    [cx + hw - r, cz - hd + r, Math.PI * 1.5, Math.PI * 2],
  ];
  const pts: BABYLON.Vector3[] = [];
  for (const [ox, oz, a0, a1] of corners)
    for (let s = 0; s <= 5; s++)
    {
      const a = a0 + (a1 - a0) * (s / 5);
      pts.push(new V3(ox + Math.cos(a) * r, 0, oz + Math.sin(a) * r));
    }
  pts.push(pts[0].clone());
  return pts;
}

function dashedLoop(points: BABYLON.Vector3[], dash: number, gap: number): BABYLON.Vector3[][]
{
  return dashPolyline(points, dash, gap);
}

function disposeMeshes(): void
{
  for (const mesh of meshes) mesh.dispose();
  meshes = [];
  riserKey = "";
  disposeLinks();
}

function disposeLinks(): void
{
  for (const link of links) link.mesh.dispose();
  links = [];
  linkKey = "";
}

// Builds the translucent column sleeves, hexagonal thing plates, central spine corridor, and unmapped tray.
function buildMeshes(at: Layout): void
{
  disposeMeshes();
  if (at.spine)
  {
    const width = at.spine.maxX - at.spine.minX, depth = at.spine.halfDepth * 2;
    const cx = (at.spine.minX + at.spine.maxX) / 2, cz = at.spine.z;
    const deck = BABYLON.MeshBuilder.CreateGround("concept-spine", { width, height: depth }, scene);
    const deckMat = new BABYLON.StandardMaterial("concept-spine", scene);
    deckMat.diffuseColor = new BABYLON.Color3(0.04, 0.08, 0.14);
    deckMat.emissiveColor = new BABYLON.Color3(0.03, 0.07, 0.12);
    deckMat.specularColor = BABYLON.Color3.Black();
    deckMat.alpha = 0.34;
    deckMat.backFaceCulling = false;
    deck.material = deckMat;
    deck.isPickable = false;
    deck.position.set(cx, 0, cz);
    glow.addExcludedMesh(deck);
    at.spineDeck = deck;
    meshes.push(deck);

    const hw = width / 2, hd = depth / 2;
    const outer = roundedRectPoints(0, 0, hw, hd, 0.55);
    const inner = roundedRectPoints(0, 0, Math.max(0.2, hw - 0.18), Math.max(0.2, hd - 0.18), 0.42);
    const rimLines: BABYLON.Vector3[][] = [outer, inner];
    const outerC = new BABYLON.Color4(0.35, 0.68, 1, 0.62);
    const innerC = new BABYLON.Color4(0.89, 0.7, 0.26, 0.25);
    const rimColors: BABYLON.Color4[][] = [outer.map(() => outerC), inner.map(() => innerC)];
    const railC = new BABYLON.Color4(0.35, 0.68, 1, 0.09);
    for (const sign of [-1, 1])
      for (let g = 0; g < 3; g++)
      {
        const z = sign * (0.95 + g * 0.32);
        if (Math.abs(z) >= hd - 0.25) continue;
        rimLines.push([new V3(-hw + 0.45, 0, z), new V3(hw - 0.45, 0, z)]);
        rimColors.push([railC, railC]);
      }
    const rim = BABYLON.MeshBuilder.CreateLineSystem("concept-spine-rim", { lines: rimLines, colors: rimColors, useVertexAlpha: true }, scene);
    rim.isPickable = false;
    rim.position.set(cx, 0.01, cz);
    at.spineRim = rim;
    meshes.push(rim);
  }

  if (at.tray)
  {
    const pts = roundedRectPoints(0, 0, at.tray.width / 2, at.tray.depth / 2, 0.45);
    const segs = dashedLoop(pts, 0.36, 0.26);
    const col = new BABYLON.Color4(0.56, 0.63, 0.72, 0.45);
    const rim = BABYLON.MeshBuilder.CreateLineSystem("concept-tray", {
      lines: segs, colors: segs.map((s) => s.map(() => col)), useVertexAlpha: true,
    }, scene);
    rim.isPickable = false;
    rim.position.set(at.tray.x, 0, at.tray.z);
    at.trayRim = rim;
    meshes.push(rim);
  }

  for (const spot of at.operations)
  {
    const pill = BABYLON.MeshBuilder.CreateCylinder("concept-op", { height: 2, diameter: 2, tessellation: 28 }, scene);
    spot.pill = pill;
    const material = new BABYLON.StandardMaterial("concept-op", scene);
    material.diffuseColor = spot.color;
    material.emissiveColor = BABYLON.Color3.Black();
    material.specularColor = BABYLON.Color3.Black();
    material.alpha = spot.unmapped ? 0.09 : 0.16;
    material.backFaceCulling = false;
    pill.material = material;
    pill.isPickable = false;
    glow.addExcludedMesh(pill);
    meshes.push(pill);
  }

  // Shared spine things are full-sized hexagonal hubs; single-owner docked things are slightly smaller badges.
  for (const marker of at.things)
  {
    const docked = marker.dockedTo !== null;
    const plate = BABYLON.MeshBuilder.CreateCylinder("concept-thing", {
      height: docked ? 0.24 : 0.32,
      diameter: docked ? 0.94 : 1.16,
      tessellation: 6,
    }, scene);
    const material = new BABYLON.StandardMaterial("concept-thing", scene);
    material.emissiveColor = ThingColor;
    material.diffuseColor = BABYLON.Color3.Black();
    material.alpha = 0.95;
    plate.material = material;
    plate.isPickable = true;
    plate.metadata = { thing: marker.name };
    marker.mesh = plate;
    meshes.push(plate);
  }
}

// Each pill follows its files as they glide, so a moving layer gap stretches the columns with it.
function fitPills(at: Layout): void
{
  let sumY = 0, countY = 0;
  for (const rec of S.fileRecords.values()) { sumY += rec.shape.position.y; countY++; }
  const fallbackMid = countY === 0 ? 0 : sumY / countY;

  for (const spot of at.operations)
  {
    if (!spot.pill) continue;
    let low = Infinity, high = -Infinity;
    for (const path of spot.files)
    {
      const rec = S.fileRecords.get(path);
      if (!rec) continue;
      low = Math.min(low, rec.shape.position.y); high = Math.max(high, rec.shape.position.y);
    }
    if (low > high) { low = fallbackMid - 0.5; high = fallbackMid + 0.5; }
    const half = Math.max(0.7, (high - low) / 2 + 0.55);
    const middle = (low + high) / 2;
    spot.pill.scaling.set(spot.radius, half, spot.radius);
    spot.pill.position.set(spot.at.x, middle, spot.at.z);
    spot.lowY = middle - half; spot.highY = middle + half;
    if (spot.tag) spot.tag.dataset.y = String(middle + half);
    if (spot.unmapped && at.trayRim) at.trayRim.position.y = spot.lowY + 0.02;
  }
}

// Each thing floats at the height of its layer, and the central spine deck hugs beneath the shared things.
function fitThings(at: Layout): void
{
  const sum = new Map<string, number>(), count = new Map<string, number>();
  let all = 0, total = 0;
  for (const rec of S.fileRecords.values())
  {
    const layer = S.FILE_LAYERS.get(rec.path);
    const y = rec.shape.position.y;
    all += y; total++;
    if (layer === undefined) continue;
    sum.set(layer, (sum.get(layer) ?? 0) + y);
    count.set(layer, (count.get(layer) ?? 0) + 1);
  }
  const middle = total === 0 ? 0 : all / total;
  let minSpineY = Infinity;
  for (const marker of at.things)
  {
    const layer = S.CONCEPTS.things[marker.name]?.layer;
    marker.y = layer !== undefined && count.has(layer) ? sum.get(layer)! / count.get(layer)! : middle;
    if (marker.dockedTo === null) minSpineY = Math.min(minSpineY, marker.y);
    marker.mesh?.position.set(marker.at.x, marker.y, marker.at.z);
    if (marker.tag)
    {
      marker.tag.dataset.x = String(marker.at.x);
      marker.tag.dataset.z = String(marker.at.z);
      marker.tag.dataset.y = String(marker.y + (marker.dockedTo !== null ? 0.34 : 0.42));
    }
  }
  if (at.spine && minSpineY < Infinity)
  {
    const deckY = minSpineY - 0.28;
    if (at.spineDeck) at.spineDeck.position.y = deckY;
    if (at.spineRim) at.spineRim.position.y = deckY + 0.012;
    fitSpineRisers(at, deckY);
  }
  fitLinks(at);
}

// Anchors any shared thing that floats on a higher layer down to its slot on the spine deck.
function fitSpineRisers(at: Layout, deckY: number): void
{
  const key = Math.round(deckY * 20) + "|" + at.things.filter((m) => m.dockedTo === null).map((m) => Math.round(m.y * 20)).join(",");
  if (key === riserKey) return;
  riserKey = key;
  if (at.spineRisers)
  {
    const idx = meshes.indexOf(at.spineRisers);
    if (idx >= 0) meshes.splice(idx, 1);
    at.spineRisers.dispose();
    at.spineRisers = undefined;
  }
  const lines: BABYLON.Vector3[][] = [];
  const colors: BABYLON.Color4[][] = [];
  const stemCol = new BABYLON.Color4(0.89, 0.7, 0.26, 0.35);
  const ringCol = new BABYLON.Color4(0.89, 0.7, 0.26, 0.45);
  for (const marker of at.things)
  {
    if (marker.dockedTo !== null || marker.y - deckY < 0.42) continue;
    lines.push([new V3(marker.at.x, deckY + 0.02, marker.at.z), new V3(marker.at.x, marker.y - 0.16, marker.at.z)]);
    colors.push([stemCol, stemCol]);
    const ring: BABYLON.Vector3[] = [];
    for (let i = 0; i <= 6; i++)
    {
      const a = (i / 6) * Math.PI * 2;
      ring.push(new V3(marker.at.x + Math.cos(a) * 0.28, deckY + 0.02, marker.at.z + Math.sin(a) * 0.28));
    }
    lines.push(ring);
    colors.push(ring.map(() => ringCol));
  }
  if (lines.length > 0)
  {
    const mesh = BABYLON.MeshBuilder.CreateLineSystem("concept-risers", { lines, colors, useVertexAlpha: true }, scene);
    mesh.isPickable = false;
    at.spineRisers = mesh;
    meshes.push(mesh);
  }
}

// Slices a 3D polyline into uniform arc-length dashes so rounded bus corners stay smooth.
function dashPolyline(points: BABYLON.Vector3[], dash: number, gap: number): BABYLON.Vector3[][]
{
  if (points.length < 2) return [];
  const cum: number[] = [0];
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + V3.Distance(points[i - 1], points[i]));
  const total = cum[cum.length - 1];
  if (total < 1e-4) return [];

  const sampleAt = (dist: number): { pt: BABYLON.Vector3; seg: number } =>
  {
    const d = Math.max(0, Math.min(total, dist));
    let seg = 0;
    while (seg < cum.length - 2 && cum[seg + 1] < d) seg++;
    const span = cum[seg + 1] - cum[seg];
    const t = span > 1e-6 ? (d - cum[seg]) / span : 0;
    return { pt: V3.Lerp(points[seg], points[seg + 1], t), seg };
  };

  const result: BABYLON.Vector3[][] = [];
  for (let start = 0; start < total; start += dash + gap)
  {
    const end = Math.min(start + dash, total);
    if (end - start < 0.03) break;
    const a = sampleAt(start), b = sampleAt(end);
    const piece: BABYLON.Vector3[] = [a.pt];
    for (let k = a.seg + 1; k <= b.seg; k++)
      if (V3.DistanceSquared(piece[piece.length - 1], points[k]) > 1e-6) piece.push(points[k].clone());
    if (V3.DistanceSquared(piece[piece.length - 1], b.pt) > 1e-6) piece.push(b.pt);
    if (piece.length >= 2) result.push(piece);
  }
  return result;
}

// Orthogonal bus tracks run flat along each thing's layer inside the central spine, rising or
// dropping only on the stem outside the operation's column.
function fitLinks(at: Layout): void
{
  const key = at.things.map((marker) => Math.round(marker.y * 20)).join(",") + "|" + at.operations.map((spot) => Math.round(spot.lowY * 20) + ":" + Math.round(spot.highY * 20)).join(",");
  if (key === linkKey) return;
  disposeLinks();
  linkKey = key;

  const spotByName = new Map(at.operations.map((s) => [s.name, s]));
  const markerByName = new Map(at.things.map((m) => [m.name, m]));

  for (const route of at.routes)
  {
    const spot = spotByName.get(route.op);
    const marker = markerByName.get(route.thing);
    if (!spot || !marker || route.points.length < 2) continue;

    const lines: BABYLON.Vector3[][] = [];
    addRouteLink(lines, spot, marker, route);
    if (lines.length === 0) continue;
    const mesh = BABYLON.MeshBuilder.CreateLineSystem("concept-link", { lines }, scene);
    mesh.color = spot.color;
    mesh.isPickable = false;
    links.push({ op: spot.name, thing: marker.name, kind: route.kind, mesh });
  }
  applyActive();
}

function addRouteLink(lines: BABYLON.Vector3[][], spot: Spot, marker: Marker, route: IConceptRoute): void
{
  const yStart = Math.max(spot.lowY + 0.2, Math.min(spot.highY - 0.2, marker.y));
  const yEnd = marker.y;
  const trackLift = route.docked ? 0 : ((route.track % 7) - 3) * 0.014;
  const pts2D = route.points;
  const pts3D: BABYLON.Vector3[] = pts2D.map((p, idx) =>
  {
    if (idx === 0) return new V3(p.x, yStart, p.z);
    if (idx === pts2D.length - 1) return new V3(p.x, yEnd, p.z);
    return new V3(p.x, yEnd + trackLift, p.z);
  });

  if (route.kind === "writes") lines.push(pts3D);
  else lines.push(...dashPolyline(pts3D, 0.3, 0.24));

  // The head sits where the data lands: on the thing for a write, on the operation for a read.
  const tip = route.kind === "writes" ? pts3D[pts3D.length - 1] : pts3D[0];
  const prev = route.kind === "writes" ? pts3D[pts3D.length - 2] : pts3D[1];
  const bx = prev.x - tip.x, by = prev.y - tip.y, bz = prev.z - tip.z;
  const bl = Math.hypot(bx, by, bz) || 1;
  const hx = bx / bl * 0.28, hy = by / bl * 0.28, hz = bz / bl * 0.28;
  const hl = Math.hypot(bx, bz) || 1;
  const px = -bz / hl * 0.13, pz = bx / hl * 0.13;
  const wing = (sign: number) => new V3(tip.x + hx + px * sign, tip.y + hy, tip.z + hz + pz * sign);
  lines.push([wing(1), tip, wing(-1)]);
}

function setScenery(visible: boolean): void
{
  if (!visible)
  {
    const all = sceneryMeshes();
    // A rebuild replaces the ground; the old meshes are gone, so only the live ones are kept.
    hiddenScenery = hiddenScenery.filter((mesh) => all.includes(mesh));
    for (const mesh of all) if (!hiddenScenery.includes(mesh)) { mesh.setEnabled(false); hiddenScenery.push(mesh); }
    return;
  }
  for (const mesh of hiddenScenery) mesh.setEnabled(true);
  hiddenScenery = [];
}

function label(spot: Spot): HTMLElement
{
  const element = document.createElement("button");
  element.type = "button";
  element.className = "concept-op" + (spot.unmapped ? " unmapped" : "");
  element.style.setProperty("--op", cssColor(spot.color));
  element.textContent = spot.name;
  const small = document.createElement("small");
  const named = spot.unmapped ? spot.files.length : (S.CONCEPTS.operations[spot.name]?.files.length ?? spot.files.length);
  small.textContent = named + (named === 1 ? " file" : " files");
  element.dataset.weight = String(named);
  element.appendChild(small);
  element.title = S.CONCEPTS.operations[spot.name]?.summary ?? "";
  element.addEventListener("pointerenter", () => setHovered({ kind: "op", name: spot.name }));
  element.addEventListener("pointerleave", () => clearHovered("op", spot.name));
  element.addEventListener("click", (event) => { event.stopPropagation(); choose("op", spot.name); });
  return element;
}

function thingLabel(marker: Marker): HTMLElement
{
  const element = document.createElement("button");
  element.type = "button";
  element.className = "concept-thing" + (marker.dockedTo !== null ? " docked" : " spine");
  element.textContent = marker.name;
  const thing = S.CONCEPTS.things[marker.name];
  const held = thing?.files?.length ?? 0;
  const small = document.createElement("small");
  small.textContent = [thing?.layer ? thing.layer + " layer" : "data", held > 0 ? held + (held === 1 ? " file" : " files") : ""].filter((part) => part !== "").join(" \u00b7 ");
  element.appendChild(small);
  element.title = thing?.summary ?? "";
  element.addEventListener("pointerenter", () => setHovered({ kind: "thing", name: marker.name }));
  element.addEventListener("pointerleave", () => clearHovered("thing", marker.name));
  element.addEventListener("click", (event) => { event.stopPropagation(); choose("thing", marker.name); });
  return element;
}

// Choosing an operation or a thing does not unpack the city: a small sheet opens beside the map,
// and everything that does not touch the choice fades back.
type Choice = { kind: "op" | "thing"; name: string } | null;
let active: Choice = null;
let hovered: Choice = null;
const expanded = new Set<number>();
const list = document.createElement("aside");
list.id = "concept-list";
list.hidden = true;
document.body.appendChild(list);
const leaders = document.createElementNS("http://www.w3.org/2000/svg", "svg");
leaders.id = "concept-leaders";
leaders.setAttribute("hidden", "");
document.body.appendChild(leaders);
const pointers: { path: string; row: HTMLElement; line: SVGLineElement }[] = [];
let emphasised = new Set<string>();

function setHovered(next: Choice): void
{
  hovered = next;
  if (active === null) applyActive();
}

function clearHovered(kind: "op" | "thing", name: string): void
{
  if (hovered !== null && hovered.kind === kind && hovered.name === name)
  {
    hovered = null;
    if (active === null) applyActive();
  }
}

function choose(kind: "op" | "thing", name: string): void
{
  setActive(active !== null && active.kind === kind && active.name === name ? null : { kind, name });
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text = "", className = ""): HTMLElementTagNameMap[K]
{
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function section(title: string): HTMLElement
{
  const block = el("section");
  block.appendChild(el("h4", title));
  list.appendChild(block);
  return block;
}

function chips(parent: HTMLElement, kind: "op" | "thing", names: string[]): void
{
  const row = el("div", "", "chips");
  for (const name of names)
  {
    const chip = el("button", name, kind === "thing" ? "chip thing" : "chip");
    chip.type = "button";
    chip.addEventListener("click", () => setActive({ kind, name }));
    row.appendChild(chip);
  }
  parent.appendChild(row);
}

function head(name: string, color: string, open: (() => void) | null): void
{
  const header = el("header");
  const title = el("strong", name);
  title.style.setProperty("--op", color);
  header.appendChild(title);
  if (open)
  {
    const show = el("button", "Show in city");
    show.type = "button";
    show.title = "Zoom back in and light these files";
    show.addEventListener("click", open);
    header.appendChild(show);
  }
  const close = el("button", "\u00d7");
  close.type = "button";
  close.title = "Close";
  close.addEventListener("click", () => setActive(null));
  header.appendChild(close);
  list.appendChild(header);
}

function addLeader(row: HTMLElement, path: string, color: string): void
{
  const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
  line.setAttribute("stroke", color);
  leaders.appendChild(line);
  pointers.push({ path, row, line });
}

function openFile(path: string): void
{
  const [node, file] = fileIndex(path);
  if (node >= 0) selectFile(node, file);
}

function setActive(next: Choice): void
{
  active = next;
  expanded.clear();
  renderSheet();
}

function toggleStep(index: number): void
{
  if (!expanded.delete(index)) expanded.add(index);
  renderSheet();
}

function renderSheet(): void
{
  pointers.length = 0;
  emphasised = new Set();
  list.replaceChildren();
  leaders.replaceChildren();
  const spot = active?.kind === "op" ? layout?.operations.find((candidate) => candidate.name === active!.name) : undefined;
  const marker = active?.kind === "thing" ? layout?.things.find((candidate) => candidate.name === active!.name) : undefined;
  const phoneIndex = !spot && !marker && S.conceptZoom && layout !== null && document.body.classList.contains("phone");
  list.hidden = !spot && !marker && !phoneIndex;
  if (!spot && !marker) leaders.setAttribute("hidden", ""); else leaders.removeAttribute("hidden");
  list.classList.toggle("index", phoneIndex);
  if (spot) renderOperation(spot);
  else if (marker) renderThing(marker.name);
  else { active = null; if (phoneIndex) renderIndex(layout!); }
  applyActive();
}

// On a phone the labels cannot all fit, so the sheet lists every operation and thing to choose from,
// folded to one row until it is opened.
let indexOpen = false;
function renderIndex(at: Layout): void
{
  const ops = at.operations.filter((spot) => !spot.unmapped);
  const toggle = el("button", ops.length + " operations · " + at.things.length + " things " + (indexOpen ? "▾" : "▴"), "index-toggle");
  toggle.type = "button";
  toggle.addEventListener("click", () => { indexOpen = !indexOpen; renderSheet(); });
  list.appendChild(toggle);
  if (!indexOpen) return;
  const opList = el("div", "", "index-list");
  for (const spot of at.operations)
  {
    const row = el("button", "", "index-op" + (spot.unmapped ? " unmapped" : ""));
    row.type = "button";
    row.style.setProperty("--op", cssColor(spot.color));
    row.appendChild(el("span", spot.name));
    const named = spot.unmapped ? spot.files.length : (S.CONCEPTS.operations[spot.name]?.files.length ?? 0);
    row.appendChild(el("small", String(named)));
    row.addEventListener("click", () => setActive({ kind: "op", name: spot.name }));
    opList.appendChild(row);
  }
  list.appendChild(opList);
  chips(section("Things"), "thing", at.things.map((marker) => marker.name));
}

// An operation reads as a process sheet: what comes in, the steps, what goes out, and the rules.
function renderOperation(spot: Spot): void
{
  const op = S.CONCEPTS.operations[spot.name];
  const color = cssColor(spot.color);
  head(spot.name, color, () => openOperation(spot));
  if (op?.summary) list.appendChild(el("p", op.summary));
  if (op && op.reads.length > 0) chips(section("In"), "thing", op.reads);

  if (op && op.steps.length > 0)
  {
    const block = section("Steps");
    const steps = el("ol");
    op.steps.forEach((entry, index) =>
    {
      const row = el("li");
      const open = expanded.has(index);
      if (open) row.classList.add("on", "open");
      const text = el("span", entry.text, "text");
      row.appendChild(text);
      const count = entry.files.length;
      if (count > 0)
      {
        const more = el("button", count + (count === 1 ? " file" : " files"), "more");
        more.type = "button";
        more.title = open ? "Hide the files that do this" : "List the files that do this";
        more.addEventListener("click", (event) => { event.stopPropagation(); toggleStep(index); });
        row.appendChild(more);
        const names = el("ul", "", "files");
        for (const path of entry.files)
        {
          const file = el("li", path.split("/").pop() ?? path);
          file.title = path + (S.FILE_SUMMARIES.get(path) ? "\n" + S.FILE_SUMMARIES.get(path) : "");
          file.addEventListener("click", (event) => { event.stopPropagation(); openFile(path); });
          names.appendChild(file);
          // Each listed file gets its own pointer to its dot, not one line for the whole step.
          if (open) { emphasised.add(path); if (S.fileRecords.has(path)) addLeader(file, path, color); }
        }
        row.appendChild(names);
      }
      row.addEventListener("click", () => toggleStep(index));
      steps.appendChild(row);
    });
    block.appendChild(steps);
  }
  else
  {
    // An operation with no steps yet still lists its files, each with a line to its dot.
    const block = section("Files");
    const rows = el("ul", "", "files shown");
    for (const path of spot.files)
    {
      const row = el("li", path.split("/").pop() ?? path);
      row.title = path + (S.FILE_SUMMARIES.get(path) ? "\n" + S.FILE_SUMMARIES.get(path) : "");
      row.addEventListener("click", () => openFile(path));
      rows.appendChild(row);
      addLeader(row, path, color);
    }
    block.appendChild(rows);
  }

  if (op && op.writes.length > 0) chips(section("Out"), "thing", op.writes);
  if (op && op.rules.length > 0)
  {
    const rules = el("ul", "", "rules");
    for (const rule of op.rules) rules.appendChild(el("li", rule));
    section("Rules").appendChild(rules);
  }
}

function renderThing(name: string): void
{
  const thing = S.CONCEPTS.things[name];
  head(name, cssColor(ThingColor), null);
  if (thing?.summary) list.appendChild(el("p", thing.summary));
  if (thing?.layer) list.appendChild(el("p", "Held in the " + thing.layer + " layer", "meta"));
  const operations = Object.entries(S.CONCEPTS.operations);
  const writers = operations.filter(([, op]) => op.writes.includes(name)).map(([key]) => key);
  const readers = operations.filter(([, op]) => op.reads.includes(name)).map(([key]) => key);
  if (writers.length > 0) chips(section("Written by"), "op", writers);
  if (readers.length > 0) chips(section("Read by"), "op", readers);
  const held = thing?.files ?? [];
  if (held.length > 0)
  {
    const rows = el("ul", "", "files shown");
    for (const path of held)
    {
      const row = el("li", path.split("/").pop() ?? path);
      row.title = path + (S.FILE_SUMMARIES.get(path) ? "\n" + S.FILE_SUMMARIES.get(path) : "");
      row.addEventListener("click", () => openFile(path));
      rows.appendChild(row);
      emphasised.add(path);
      if (S.fileRecords.has(path)) addLeader(row, path, cssColor(ThingColor));
    }
    section("Files").appendChild(rows);
  }
  if (thing && (thing.rules?.length ?? 0) > 0)
  {
    const rules = el("ul", "", "rules");
    for (const rule of thing.rules!) rules.appendChild(el("li", rule));
    section("Rules").appendChild(rules);
  }
}

function cssColor(color: BABYLON.Color3): string
{
  return "rgb(" + [color.r, color.g, color.b].map((c) => Math.round(c * 255)).join(",") + ")";
}

// Writes stay bright while passive reads rest quieter; hovering or choosing an item lights all of
// its own reads and writes and fades everything else back.
function applyActive(): void
{
  if (!layout) return;
  const focus = active ?? hovered;
  const operation = focus?.kind === "op" ? S.CONCEPTS.operations[focus.name] : undefined;
  const touches = (name: string): boolean =>
  {
    if (focus === null) return true;
    if (focus.kind === "op") return operation !== undefined && (operation.reads.includes(name) || operation.writes.includes(name));
    return name === focus.name;
  };
  const opTouches = (name: string): boolean =>
  {
    if (focus === null) return true;
    if (focus.kind === "op") return name === focus.name;
    const op = S.CONCEPTS.operations[name];
    return op !== undefined && (op.reads.includes(focus.name) || op.writes.includes(focus.name));
  };
  for (const spot of layout.operations)
  {
    const on = opTouches(spot.name);
    const base = spot.unmapped ? 0.09 : 0.16;
    if (spot.pill?.material) spot.pill.material.alpha = !on ? 0.04 : focus === null ? base : focus.kind === "op" ? 0.3 : 0.22;
    spot.tag?.classList.toggle("faded", !on);
  }
  for (const marker of layout.things)
  {
    const on = touches(marker.name);
    if (marker.mesh?.material) marker.mesh.material.alpha = on ? 0.95 : 0.18;
    marker.tag?.classList.toggle("faded", !on);
    marker.tag?.classList.toggle("chosen", focus?.kind === "thing" && focus.name === marker.name);
  }
  for (const link of links)
  {
    if (focus === null)
    {
      link.mesh.alpha = link.kind === "writes" ? 0.84 : 0.28;
      continue;
    }
    const on = focus.kind === "op" ? link.op === focus.name : link.thing === focus.name;
    link.mesh.alpha = on ? (link.kind === "writes" ? 1 : 0.9) : 0.05;
  }
}

// Draws each listed file's pointer: from its own row in the sheet to its dot, where the dot is now.
function placeLeaders(transform: BABYLON.Matrix, viewport: BABYLON.Viewport): void
{
  if (pointers.length === 0) return;
  const box = list.getBoundingClientRect();
  for (const { path, row, line } of pointers)
  {
    const rec = S.fileRecords.get(path);
    const rowBox = row.getBoundingClientRect();
    const hidden = !rec || rowBox.bottom < box.top || rowBox.top > box.bottom;
    line.style.display = hidden ? "none" : "";
    if (hidden) continue;
    const p = V3.Project(rec.shape.position, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    line.setAttribute("x1", String(box.right));
    line.setAttribute("y1", String(Math.min(rowBox.bottom, Math.max(rowBox.top, (rowBox.top + rowBox.bottom) / 2))));
    line.setAttribute("x2", p.x.toFixed(1));
    line.setAttribute("y2", p.y.toFixed(1));
  }
}

function buildLabels(at: Layout): void
{
  overlay.replaceChildren();
  for (const spot of at.operations)
  {
    const element = label(spot);
    element.dataset.x = String(spot.at.x);
    element.dataset.z = String(spot.at.z);
    spot.tag = element;
    overlay.appendChild(element);
  }
  for (const marker of at.things)
  {
    const element = thingLabel(marker);
    element.dataset.x = String(marker.at.x);
    element.dataset.z = String(marker.at.z);
    marker.tag = element;
    overlay.appendChild(element);
  }
}

// Labels that would cover a more important one are hidden rather than piled up; they come back as the
// camera moves, and every name stays reachable from the sheet.
const labelSize = new WeakMap<HTMLElement, { w: number; h: number }>();
function declutter(placed: { element: HTMLElement; x: number; y: number; rank: number }[], width: number, height: number): void
{
  placed.sort((a, b) => a.rank - b.rank);
  const kept: { l: number; t: number; r: number; b: number }[] = [];
  for (const { element, x, y } of placed)
  {
    let size = labelSize.get(element);
    if (!size || size.w === 0) { size = { w: element.offsetWidth, h: element.offsetHeight }; labelSize.set(element, size); }
    const box = { l: x - size.w / 2 - 2, t: y - size.h - 2, r: x + size.w / 2 + 2, b: y + 2 };
    const onScreen = box.r > 0 && box.l < width && box.b > 0 && box.t < height;
    const clear = onScreen && !kept.some((k) => box.l < k.r && box.r > k.l && box.t < k.b && box.b > k.t);
    element.style.visibility = clear ? "" : "hidden";
    if (clear) kept.push(box);
  }
}

export function placeConceptLabels(): void
{
  if (overlay.hidden) return;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const transform = scene.getTransformMatrix();
  const viewport = camera.viewport.toGlobal(width, height);
  const placed: { element: HTMLElement; x: number; y: number; rank: number }[] = [];
  for (const element of overlay.children as HTMLCollectionOf<HTMLElement>)
  {
    const point = new V3(Number(element.dataset.x), Number(element.dataset.y ?? 0), Number(element.dataset.z));
    const p = V3.Project(point, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    element.style.transform = "translate(" + p.x.toFixed(1) + "px," + p.y.toFixed(1) + "px) translate(-50%, -100%)";
    // The chosen label and what it touches come first, then operations by size, then things.
    const isOp = element.classList.contains("concept-op");
    const lit = element.classList.contains("chosen") || (active !== null && !element.classList.contains("faded"));
    const rank = (lit ? 0 : 2e6) + (isOp ? 0 : 1e6) - Number(element.dataset.weight ?? 0);
    placed.push({ element, x: p.x, y: p.y, rank });
  }
  declutter(placed, width, height);
  placeLeaders(transform, viewport);
}

// Runs every frame, after a shown route has set its targets, so the zoom wins while it is on.
export function conceptTargets(): void
{
  if (!S.conceptZoom) return;
  // The columns are laid out again only when the files or their imports change. The layer gap moves
  // heights alone, and every vertical piece of the zoom reads the boxes' own heights as they glide,
  // so a gap change refreshes the dots' resting heights in place instead of rebuilding the layout.
  const key = S.graphSignature + "|" + S.fileRecords.size;
  const rebuilt = layout === null || key !== layoutKey;
  if (rebuilt)
  {
    layout = buildLayout();
    layoutKey = key;
    if (layout) { buildMeshes(layout); buildLabels(layout); }
    renderSheet();
  }
  if (!layout) return;
  for (const [path, spot] of layout.home) if (S.fileRecords.has(path)) spot.y = stackY(path);
  setScenery(false);
  fitPills(layout);
  fitThings(layout);
  for (const rec of S.fileRecords.values())
  {
    const spot = layout.home.get(rec.path);
    if (!spot) continue;
    rec.target.copyFrom(spot);
    let size = sizes.get(rec);
    if (!size || rec.targetSize !== size.mine)
    {
      size = { rest: rec.targetSize, mine: new V3(DotSize, DotSize, DotSize) };
      sizes.set(rec, size);
      rec.targetSize = size.mine;
    }
    const dot = emphasised.has(rec.path) ? DotBig : DotSize;
    if (size.mine.x !== dot && rec.targetSize === size.mine) size.mine.set(dot, dot, dot);
  }
  if (rebuilt)
  {
    updateBounds(layout);
    buildLayerPlanes();
  }
}

function setZoom(on: boolean): void
{
  if (on === S.conceptZoom) return;
  if (on && Object.keys(S.CONCEPTS.operations).length === 0)
  {
    flashHint("This repository has no operations yet: add a \"concepts\" section to its architecture file.");
    return;
  }
  S.conceptZoom = on;
  document.body.classList.toggle("concept-zoom", on);
  overlay.hidden = !on;
  key.hidden = !on;
  button?.classList.toggle("on", on);
  button?.setAttribute("aria-pressed", String(on));
  if (on)
  {
    // Labels that drift with a spinning camera are hard to click, and a steady front angle lines
    // up the central data spine horizontally across the screen.
    setSpin(false);
    hovered = null;
    layout = null;
    conceptTargets();
    centerView(false);
    if (S.camGoal) S.camGoal.alpha = ConceptAlpha;
  }
  else
  {
    for (const rec of S.fileRecords.values())
    {
      rec.target.copyFrom(rec.terrace);
      const size = sizes.get(rec);
      if (size && rec.targetSize === size.mine) rec.targetSize = size.rest;
      sizes.delete(rec);
    }
    active = null;
    hovered = null;
    renderSheet();
    disposeMeshes();
    overlay.replaceChildren();
    layout = null;
    setConceptBounds(null);
    setScenery(true);
    buildLayerPlanes();
    centerView(false);
  }
  renderEdges();
  render();
}

function openOperation(spot: Spot): void
{
  setZoom(false);
  const op = S.CONCEPTS.operations[spot.name];
  void changeView({ type: "show", shown: { title: spot.name, note: op?.summary ?? "", trace: false, files: spot.files.map((path) => ({ path, note: "" })) } });
}

// A tap in the concept view stays in it: a file opens its details, and empty space puts the sheet away.
export function conceptTap(): boolean
{
  if (!S.conceptZoom) return false;
  const plate = scene.pick(scene.pointerX, scene.pointerY, (mesh) => (mesh.metadata as { thing?: string } | null)?.thing !== undefined);
  if (plate.hit) { choose("thing", (plate.pickedMesh.metadata as { thing: string }).thing); return true; }
  const hit = pickFile(scene.pointerX, scene.pointerY);
  if (!hit) { if (active !== null) setActive(null); return true; }
  selectFile(hit.node, hit.file);
  return true;
}

let hintTimer = 0;
function flashHint(text: string): void
{
  let hint = document.getElementById("concept-hint");
  if (!hint) { hint = document.createElement("div"); hint.id = "concept-hint"; document.body.appendChild(hint); }
  hint.textContent = text;
  hint.hidden = false;
  clearTimeout(hintTimer);
  hintTimer = window.setTimeout(() => { hint!.hidden = true; }, 4000);
}

export function toggleConceptZoom(): void
{
  setZoom(!S.conceptZoom);
}

button?.addEventListener("click", toggleConceptZoom);
document.addEventListener("keydown", (event) =>
{
  if (event.key !== "Escape" || !S.conceptZoom || active === null) return;
  event.stopPropagation();
  setActive(null);
}, true);
window.addEventListener("codespace:concept-zoom", toggleConceptZoom);
