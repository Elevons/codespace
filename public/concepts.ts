import { S, V3, scene, camera, canvas, layerRank, MIN_LAYER_GAP, render, renderEdges, fileIndex, glow, hasFilters, inScene, revealFiles } from "./state.js";
import { centerView, buildLayerPlanes, setConceptBounds, sceneryMeshes } from "./meshes.js";
import { build, restack } from "./city.js";
import { pickFile } from "./boxes.js";
import { revealOutliner, renderOutliner, selectFile } from "./panels.js";
import { changeView } from "./viewcall.js";
import { setLayerGap, setSpin } from "./controls.js";
import { conceptSpineLayout, conceptTrace, conceptFilterView, conceptFraming, conceptStems, type IConceptRoute, type IConceptFilterView, type IConceptTraceHop } from "./rules.js";
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
  data: Marker[];
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

interface Link { op: string; datum: string; kind: "reads" | "writes"; mesh: BABYLON.Mesh }

const DataColor = new BABYLON.Color3(0.89, 0.7, 0.26);

let layout: Layout | null = null;
let layoutKey = "";
let meshes: BABYLON.Mesh[] = [];
let links: Link[] = [];
let linkKey = "";
let riserKey = "";
let hiddenScenery: BABYLON.Mesh[] = [];
// What the outliner's filters leave of the design; rebuilt with the layout.
let filterView: IConceptFilterView | null = null;
const opShown = (name: string): boolean => filterView === null || filterView.operations.has(name);
const dataShown = (name: string): boolean => filterView === null || filterView.data.has(name);
const sizes = new WeakMap<FileRecord, { rest: BABYLON.Vector3; mine: BABYLON.Vector3 }>();

const overlay = document.createElement("div");
overlay.id = "concept-labels";
overlay.hidden = true;
// What the shapes are, kept in the concept sheet's footer on desktop.
const key = document.createElement("div");
key.id = "concept-key";
key.hidden = true;
key.innerHTML = '<div><span><i class="hex"></i><b>Data</b> hex</span><span><i class="op"></i><b>Op</b> column</span></div>' +
  '<div><span><i class="read"></i>reads</span><span><i class="write"></i>writes</span></div>';
const cityLabels = document.getElementById("labels");
if (cityLabels) cityLabels.after(overlay); else document.body.appendChild(overlay);
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

// Operations line up in two banks flanking a central data spine of shared data; single-owner
// data dock beside their parent column, and unmapped files sit in a quiet tray to the side.
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
    data: S.CONCEPTS.data,
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

  const data: Marker[] = plan.data.map((datum) => ({
    name: datum.name,
    at: new V3(datum.x, 0, datum.z),
    dockedTo: datum.dockedTo,
    y: stackMid,
    files: datum.files,
  }));

  return { operations, data, home, center, spine: plan.spine, tray: plan.tray, routes: plan.routes };
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
  for (const marker of at.data) expand(marker.at.x, marker.y, marker.at.z, 1.1, 1.1);
  if (at.spine)
  {
    const cx = (at.spine.minX + at.spine.maxX) / 2;
    const hw = (at.spine.maxX - at.spine.minX) / 2;
    // The deck sits just under the data, so the bounds reach below it too.
    expand(cx, (minY === Infinity ? 0 : minY) - 0.3, at.spine.z, hw, at.spine.halfDepth);
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

// Builds the translucent column sleeves, hexagonal data plates, central spine corridor, and unmapped tray.
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
    // Pickable only so hovering the column can name it; every other pick filters by metadata.
    pill.isPickable = true;
    pill.metadata = { op: spot.name };
    glow.addExcludedMesh(pill);
    meshes.push(pill);
  }

  // Shared spine data are full-sized hexagonal hubs; single-owner docked data entries are slightly smaller badges.
  for (const marker of at.data)
  {
    const docked = marker.dockedTo !== null;
    const plate = BABYLON.MeshBuilder.CreateCylinder("concept-data", {
      height: docked ? 0.24 : 0.32,
      diameter: docked ? 0.94 : 1.16,
      tessellation: 6,
    }, scene);
    const material = new BABYLON.StandardMaterial("concept-data", scene);
    material.emissiveColor = DataColor;
    material.diffuseColor = BABYLON.Color3.Black();
    material.alpha = 0.95;
    plate.material = material;
    plate.isPickable = true;
    plate.metadata = { datum: marker.name };
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

// Each data entry sits below the files, on a deck of its own, so the hexagons read as the ground the
// operations stand on rather than as more files among them.
function fitData(at: Layout): void
{
  let lowest = Infinity;
  for (const rec of S.fileRecords.values()) lowest = Math.min(lowest, stackY(rec.path));
  const dataY = (lowest === Infinity ? 0 : lowest) - 0.55;
  let minSpineY = Infinity;
  for (const marker of at.data)
  {
    marker.y = dataY;
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

// Anchors any shared data entry that floats above the deck down to its slot on the spine deck.
function fitSpineRisers(at: Layout, deckY: number): void
{
  const key = Math.round(deckY * 20) + "|" + at.data.filter((m) => m.dockedTo === null).map((m) => Math.round(m.y * 20)).join(",");
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
  for (const marker of at.data)
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

// Orthogonal bus tracks run flat along each data entry's layer inside the central spine, rising or
// dropping only on the stem outside the operation's column.
function fitLinks(at: Layout): void
{
  const key = at.data.map((marker) => Math.round(marker.y * 20)).join(",") + "|" + at.operations.map((spot) => Math.round(spot.lowY * 20) + ":" + Math.round(spot.highY * 20)).join(",");
  if (key === linkKey) return;
  disposeLinks();
  linkKey = key;

  const spotByName = new Map(at.operations.map((s) => [s.name, s]));
  const markerByName = new Map(at.data.map((m) => [m.name, m]));

  for (const route of at.routes)
  {
    const spot = spotByName.get(route.op);
    const marker = markerByName.get(route.datum);
    if (!spot || !marker || route.points.length < 2) continue;

    const lines: BABYLON.Vector3[][] = [];
    addRouteLink(lines, spot, marker, route);
    if (lines.length === 0) continue;
    const mesh = BABYLON.MeshBuilder.CreateLineSystem("concept-link", { lines }, scene);
    mesh.color = spot.color;
    mesh.isPickable = false;
    links.push({ op: spot.name, datum: marker.name, kind: route.kind, mesh });
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

  // The head sits where the data lands: on the data for a write, on the operation for a read.
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

function label(spot: Spot, stem: string): HTMLElement
{
  const element = document.createElement("button");
  element.type = "button";
  element.className = "concept-op stem" + (spot.unmapped ? " unmapped" : "");
  element.style.setProperty("--op", cssColor(spot.color));
  element.appendChild(el("span", stem, "stem-text"));
  element.appendChild(el("span", spot.name, "full-text"));
  const small = document.createElement("small");
  const named = spot.unmapped ? spot.files.length : (S.CONCEPTS.operations[spot.name]?.files.length ?? spot.files.length);
  small.textContent = named + (named === 1 ? " file" : " files");
  element.dataset.weight = String(named);
  element.appendChild(small);
  element.title = S.CONCEPTS.operations[spot.name]?.summary ?? "";
  element.addEventListener("pointerenter", () => { hoverFromMap = false; setHovered({ kind: "op", name: spot.name }); });
  element.addEventListener("pointerleave", () => clearHovered("op", spot.name));
  element.addEventListener("click", (event) => { event.stopPropagation(); choose("op", spot.name); });
  return element;
}

function dataLabel(marker: Marker): HTMLElement
{
  const element = document.createElement("button");
  element.type = "button";
  element.className = "concept-data" + (marker.dockedTo !== null ? " docked" : " spine");
  element.textContent = marker.name;
  const datum = S.CONCEPTS.data[marker.name];
  const held = datum?.files?.length ?? 0;
  const small = document.createElement("small");
  small.textContent = [datum?.layer ? datum.layer + " layer" : "data", held > 0 ? held + (held === 1 ? " file" : " files") : ""].filter((part) => part !== "").join(" \u00b7 ");
  element.appendChild(small);
  element.title = datum?.summary ?? "";
  element.addEventListener("pointerenter", () => { hoverFromMap = false; setHovered({ kind: "datum", name: marker.name }); });
  element.addEventListener("pointerleave", () => clearHovered("datum", marker.name));
  element.addEventListener("click", (event) => { event.stopPropagation(); choose("datum", marker.name); });
  return element;
}

// Choosing an operation or a data entry does not unpack the city: a small sheet opens beside the map,
// and everything that does not touch the choice fades back.
type Choice = { kind: "op" | "datum"; name: string } | null;
let active: Choice = null;
let hovered: Choice = null;
const expanded = new Set<number>();
const list = document.createElement("aside");
list.id = "concept-list";
list.className = "panel";
list.hidden = true;
const listHead = document.createElement("div");
listHead.className = "cl-head";
const listBody = document.createElement("div");
listBody.className = "cl-body";
list.append(listHead, listBody, key);
const dockRight = document.getElementById("dock-right");
const rightTabs = document.getElementById("dock-right-tabs");
const outlinerShow = document.getElementById("outliner-show");
const phoneQuery = window.matchMedia("(max-width: 720px)");

function mountSheet(): void
{
  if (phoneQuery.matches || !dockRight)
  {
    if (list.parentNode !== document.body) document.body.appendChild(list);
  }
  else if (rightTabs && rightTabs.parentNode === dockRight)
  {
    if (list.parentNode !== dockRight) rightTabs.after(list);
  }
  else if (list.parentNode !== dockRight) dockRight.prepend(list);
}
mountSheet();
phoneQuery.addEventListener("change", () => { mountSheet(); if (S.conceptZoom) renderSheet(); });

function setRightTab(next: "concepts" | "outliner"): void
{
  document.body.classList.toggle("rtab-concepts", S.conceptZoom && next === "concepts");
  document.body.classList.toggle("rtab-outliner", S.conceptZoom && next === "outliner");
  rightTabs?.querySelectorAll<HTMLButtonElement>("[data-rtab]").forEach((btn) =>
  {
    btn.setAttribute("aria-selected", String(btn.dataset.rtab === next));
  });
  if (outlinerShow) outlinerShow.textContent = S.conceptZoom && next === "concepts" ? "Concepts" : "Outliner";
}
rightTabs?.addEventListener("click", (event) =>
{
  const btn = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-rtab]");
  if (btn?.dataset.rtab === "concepts" || btn?.dataset.rtab === "outliner") setRightTab(btn.dataset.rtab);
});
window.addEventListener("codespace:right-tab", (event) =>
{
  const want = (event as CustomEvent<string>).detail;
  if (S.conceptZoom && (want === "concepts" || want === "outliner")) setRightTab(want);
});
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

function clearHovered(kind: "op" | "datum", name: string): void
{
  if (hovered !== null && hovered.kind === kind && hovered.name === name)
  {
    hovered = null;
    if (active === null) applyActive();
  }
}

function choose(kind: "op" | "datum", name: string): void
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
  listBody.appendChild(block);
  return block;
}

function chips(parent: HTMLElement, kind: "op" | "datum", names: string[]): void
{
  const row = el("div", "", "chips");
  for (const name of names)
  {
    const chip = el("button", name, kind === "datum" ? "chip datum" : "chip");
    chip.type = "button";
    chip.addEventListener("click", () => setActive({ kind, name }));
    chip.addEventListener("pointerenter", () => setHovered({ kind, name }));
    chip.addEventListener("pointerleave", () => clearHovered(kind, name));
    row.appendChild(chip);
  }
  parent.appendChild(row);
}

// Each operation that writes or reads a data entry, with the steps there that touch the entry's own files.
function hops(parent: HTMLElement, items: IConceptTraceHop[]): void
{
  const rows = el("ul", "", "hops");
  for (const item of items)
  {
    const row = el("li");
    const open = el("button", item.op, "chip");
    open.type = "button";
    open.title = "Open this operation";
    open.addEventListener("click", () => setActive({ kind: "op", name: item.op }));
    row.appendChild(open);
    for (const text of item.steps) row.appendChild(el("p", text, "hop-step"));
    rows.appendChild(row);
  }
  parent.appendChild(rows);
}

function head(name: string, color: string, open: (() => void) | null): void
{
  const header = el("header");
  const back = el("button", "\u2190", "cl-back");
  back.type = "button";
  back.title = "All concepts";
  back.setAttribute("aria-label", "Back to all concepts");
  back.addEventListener("click", () => setActive(null));
  header.appendChild(back);
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
  listHead.appendChild(header);
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

// The files a chosen operation or data entry names, so choosing it can bring them back into the scene.
function conceptFiles(choice: NonNullable<Choice>): string[]
{
  if (choice.kind === "op")
  {
    const op = S.CONCEPTS.operations[choice.name];
    return op ? [...op.files, ...(op.steps ?? []).flatMap((step) => step.files)] : [];
  }
  return S.CONCEPTS.data[choice.name]?.files ?? [];
}

function setActive(next: Choice): void
{
  active = next;
  expanded.clear();
  if (next !== null)
  {
    // A chosen concept whose files an eye hid brings them back, so the sheet and the map agree.
    if (revealFiles(conceptFiles(next))) { build(); renderOutliner(); }
    if (!phoneQuery.matches)
    {
      setRightTab("concepts");
      revealOutliner();
    }
  }
  renderSheet();
  if (next !== null && document.body.classList.contains("phone")) frameChoice(next);
}

// On a phone the sheet covers the lower half, so the chosen column or hexagon is brought into the
// upper half: the camera aims a quarter of the screen below it, at the distance it already has.
function frameChoice(choice: NonNullable<Choice>): void
{
  if (!layout) return;
  let point: BABYLON.Vector3 | null = null;
  if (choice.kind === "op")
  {
    const spot = layout.operations.find((candidate) => candidate.name === choice.name);
    if (spot) point = new V3(spot.at.x, (spot.lowY + spot.highY) / 2, spot.at.z);
  }
  else
  {
    const marker = layout.data.find((candidate) => candidate.name === choice.name);
    if (marker) point = new V3(marker.at.x, marker.y, marker.at.z);
    // The entry is framed together with the operations that write and read it, so both ends are in view.
    const trace = conceptTrace(S.CONCEPTS.data, S.CONCEPTS.operations, choice.name);
    const ends = new Set([...trace.comesFrom, ...trace.goesTo].map((hop) => hop.op));
    const points = layout.operations.filter((spot) => ends.has(spot.name)).map((spot) => ({ x: spot.at.x, y: (spot.lowY + spot.highY) / 2, z: spot.at.z }));
    if (marker) points.push({ x: marker.at.x, y: marker.y, z: marker.at.z });
    const frame = conceptFraming(points, camera.fov, canvas.clientWidth / Math.max(1, canvas.clientHeight), camera.radius);
    if (frame && points.length > 1)
    {
      const a = camera.alpha, b = camera.beta;
      const up = new V3(-Math.cos(a) * Math.cos(b), Math.sin(b), -Math.sin(a) * Math.cos(b));
      const lift = frame.radius * Math.tan(camera.fov / 2) * 0.5;
      S.camGoal = { target: new V3(frame.center.x, frame.center.y, frame.center.z).subtract(up.scale(lift)), radius: frame.radius };
      return;
    }
  }
  if (!point) return;
  // The screen's up direction for an orbiting camera at (alpha, beta).
  const a = camera.alpha, b = camera.beta;
  const up = new V3(-Math.cos(a) * Math.cos(b), Math.sin(b), -Math.sin(a) * Math.cos(b));
  const lift = camera.radius * Math.tan(camera.fov / 2) * 0.5;
  S.camGoal = { target: point.subtract(up.scale(lift)), radius: camera.radius };
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
  listHead.replaceChildren();
  listBody.replaceChildren();
  leaders.replaceChildren();
  const spot = active?.kind === "op" ? layout?.operations.find((candidate) => candidate.name === active!.name) : undefined;
  const marker = active?.kind === "datum" ? layout?.data.find((candidate) => candidate.name === active!.name) : undefined;
  // With nothing chosen the sheet is the index, so a name whose label is hidden is still one click away.
  const showIndex = !spot && !marker && S.conceptZoom && layout !== null;
  list.hidden = !spot && !marker && !showIndex;
  if (!spot && !marker) leaders.setAttribute("hidden", ""); else leaders.removeAttribute("hidden");
  list.classList.toggle("index", showIndex);
  list.classList.toggle("folded", showIndex && phoneQuery.matches && !indexOpen);
  listBody.hidden = showIndex && phoneQuery.matches && !indexOpen;
  if (spot) renderOperation(spot);
  else if (marker) renderData(marker.name);
  else { active = null; if (showIndex) renderIndex(layout!); }
  applyActive();
}

// On desktop the index sits inside the right panel alongside the outliner; on a phone it stays folded to one
// bar above the tabs until opened.
let indexOpen = false;
function renderIndex(at: Layout): void
{
  const ops = at.operations.filter((spot) => !spot.unmapped && opShown(spot.name));
  const shownData = at.data.filter((marker) => dataShown(marker.name));
  const filtering = filterView !== null && filterView.filtering;
  if (phoneQuery.matches)
  {
    const counts = filtering
      ? "showing " + ops.length + " of " + filterView!.totalOperations + " operations · " + shownData.length + " of " + filterView!.totalData + " data"
      : ops.length + " operations · " + at.data.length + " data";
    const toggle = el("button", counts + " " + (indexOpen ? "▾" : "▴"), "index-toggle");
    toggle.type = "button";
    toggle.addEventListener("click", () => { indexOpen = !indexOpen; renderSheet(); });
    listHead.appendChild(toggle);
    if (!indexOpen) return;
  }
  else
  {
    const counts = filtering
      ? ops.length + "/" + filterView!.totalOperations + " ops · " + shownData.length + "/" + filterView!.totalData + " data"
      : ops.length + " ops · " + at.data.length + " data";
    listHead.appendChild(el("span", "Concepts", "panel-title"));
    listHead.appendChild(el("span", counts, "cl-count"));
  }
  const opSection = section("Operations");
  const opList = el("div", "", "index-list");
  for (const spot of at.operations)
  {
    if (!spot.unmapped && !opShown(spot.name)) continue;
    const row = el("button", "", "index-op" + (spot.unmapped ? " unmapped" : ""));
    row.type = "button";
    row.dataset.op = spot.name;
    row.style.setProperty("--op", cssColor(spot.color));
    row.appendChild(el("span", spot.name));
    const named = spot.unmapped ? spot.files.length : (S.CONCEPTS.operations[spot.name]?.files.length ?? 0);
    row.appendChild(el("small", String(named)));
    row.addEventListener("click", () => setActive({ kind: "op", name: spot.name }));
    row.addEventListener("pointerenter", () => setHovered({ kind: "op", name: spot.name }));
    row.addEventListener("pointerleave", () => clearHovered("op", spot.name));
    opList.appendChild(row);
  }
  opSection.appendChild(opList);
  chips(section("Data"), "datum", shownData.map((marker) => marker.name));
}

// An operation reads as a process sheet: what comes in, the steps, what goes out, and the rules.
function renderOperation(spot: Spot): void
{
  const op = S.CONCEPTS.operations[spot.name];
  const color = cssColor(spot.color);
  head(spot.name, color, () => openOperation(spot));
  if (op?.summary) listBody.appendChild(el("p", op.summary));
  if (op && op.reads.length > 0) chips(section("In"), "datum", op.reads);

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

  if (op && op.writes.length > 0) chips(section("Out"), "datum", op.writes);
  if (op && op.rules.length > 0)
  {
    const rules = el("ul", "", "rules");
    for (const rule of op.rules) rules.appendChild(el("li", rule));
    section("Rules").appendChild(rules);
  }
}

function renderData(name: string): void
{
  const datum = S.CONCEPTS.data[name];
  head(name, cssColor(DataColor), null);
  if (datum?.summary) listBody.appendChild(el("p", datum.summary));
  if (datum?.layer) listBody.appendChild(el("p", "Held in the " + datum.layer + " layer", "meta"));
  const trace = conceptTrace(S.CONCEPTS.data, S.CONCEPTS.operations, name);
  if (trace.comesFrom.length > 0) hops(section("Comes from"), trace.comesFrom);
  if (trace.goesTo.length > 0) hops(section("Goes to"), trace.goesTo);
  const held = datum?.files ?? [];
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
      if (S.fileRecords.has(path)) addLeader(row, path, cssColor(DataColor));
    }
    section("Files").appendChild(rows);
  }
  if (datum && (datum.rules?.length ?? 0) > 0)
  {
    const rules = el("ul", "", "rules");
    for (const rule of datum.rules!) rules.appendChild(el("li", rule));
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
  const trace = focus?.kind === "datum" ? conceptTrace(S.CONCEPTS.data, S.CONCEPTS.operations, focus.name) : null;
  const writers = new Set(trace?.comesFrom.map((hop) => hop.op));
  const readers = new Set(trace?.goesTo.map((hop) => hop.op));
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
    return writers.has(name) || readers.has(name);
  };
  // An operation or data entry the filters leave nothing of stays in place as a ghost, so the layout does not
  // jump as chips are toggled, but it gives way to what remains and drops out of the index.
  for (const spot of layout.operations)
  {
    const ghost = !spot.unmapped && !opShown(spot.name);
    const on = !ghost && opTouches(spot.name);
    const full = focus !== null && on;
    const base = spot.unmapped ? 0.09 : 0.16;
    if (spot.pill?.material) spot.pill.material.alpha = ghost ? 0.02 : !on ? 0.04 : focus === null ? base : focus.kind === "op" ? 0.3 : 0.22;
    spot.tag?.classList.toggle("stem", !full);
    spot.tag?.classList.toggle("hot", focus?.kind === "op" && focus.name === spot.name);
    spot.tag?.classList.toggle("faded", !on && !ghost);
    spot.tag?.classList.toggle("ghost", ghost);
    spot.tag?.classList.toggle("source", writers.has(spot.name));
    spot.tag?.classList.toggle("sink", readers.has(spot.name) && !writers.has(spot.name));
  }
  for (const marker of layout.data)
  {
    const ghost = !dataShown(marker.name);
    const on = !ghost && touches(marker.name);
    if (marker.mesh?.material) marker.mesh.material.alpha = ghost ? 0.06 : on ? 0.95 : 0.18;
    marker.tag?.classList.toggle("faded", !on && !ghost);
    marker.tag?.classList.toggle("ghost", ghost);
    marker.tag?.classList.toggle("chosen", focus?.kind === "datum" && focus.name === marker.name);
  }
  for (const link of links)
  {
    if (!opShown(link.op) || !dataShown(link.datum)) { link.mesh.alpha = 0.02; continue; }
    if (focus === null)
    {
      link.mesh.alpha = link.kind === "writes" ? 0.84 : 0.28;
      continue;
    }
    const on = focus.kind === "op" ? link.op === focus.name : link.datum === focus.name;
    // A traced entry's own links are all bright, the writes and the reads alike.
    link.mesh.alpha = on ? (link.kind === "writes" || focus.kind === "datum" ? 1 : 0.9) : 0.05;
  }
  const hotOp = focus?.kind === "op" ? focus.name : null;
  listBody.querySelectorAll<HTMLElement>(".index-op[data-op]").forEach((row) =>
  {
    row.classList.toggle("hl", row.dataset.op === hotOp);
  });
}

// Draws each listed file's pointer: from its own row in the sheet to its dot, where the dot is now.
function placeLeaders(transform: BABYLON.Matrix, viewport: BABYLON.Viewport): void
{
  if (pointers.length === 0) return;
  const box = list.getBoundingClientRect();
  if (box.width === 0 || box.height === 0)
  {
    for (const { line } of pointers) line.style.display = "none";
    return;
  }
  const bodyBox = listBody.getBoundingClientRect();
  const midX = (box.left + box.right) / 2;
  for (const { path, row, line } of pointers)
  {
    const rec = S.fileRecords.get(path);
    const rowBox = row.getBoundingClientRect();
    const hidden = !rec || rowBox.bottom < bodyBox.top || rowBox.top > bodyBox.bottom;
    line.style.display = hidden ? "none" : "";
    if (hidden) continue;
    const p = V3.Project(rec.shape.position, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    line.setAttribute("x1", String(p.x < midX ? box.left : box.right));
    line.setAttribute("y1", String(Math.min(rowBox.bottom, Math.max(rowBox.top, (rowBox.top + rowBox.bottom) / 2))));
    line.setAttribute("x2", p.x.toFixed(1));
    line.setAttribute("y2", p.y.toFixed(1));
  }
}

function buildLabels(at: Layout): void
{
  overlay.replaceChildren();
  labelSize = new WeakMap();
  const stems = conceptStems(at.operations.filter((spot) => !spot.unmapped).map((spot) => spot.name));
  for (const spot of at.operations)
  {
    const stem = spot.unmapped ? "Unmapped" : (stems.get(spot.name) ?? spot.name);
    const element = label(spot, stem);
    element.dataset.x = String(spot.at.x);
    element.dataset.z = String(spot.at.z);
    spot.tag = element;
    overlay.appendChild(element);
  }
  for (const marker of at.data)
  {
    const element = dataLabel(marker);
    element.dataset.x = String(marker.at.x);
    element.dataset.z = String(marker.at.z);
    marker.tag = element;
    overlay.appendChild(element);
  }
}

// Labels that would cover a more important one are hidden rather than piled up; they come back as the
// camera moves, and every name stays reachable from the sheet.
let labelSize = new WeakMap<HTMLElement, { stem?: { w: number; h: number }; full?: { w: number; h: number } }>();
window.addEventListener("resize", () => { labelSize = new WeakMap(); });
function declutter(placed: { element: HTMLElement; x: number; y: number; rank: number }[], width: number, height: number): void
{
  placed.sort((a, b) => a.rank - b.rank);
  const kept: { l: number; t: number; r: number; b: number }[] = [];
  for (const { element, x, y } of placed)
  {
    const mode = element.classList.contains("stem") ? "stem" : "full";
    let entry = labelSize.get(element);
    let size = entry?.[mode];
    if (!size || size.w === 0)
    {
      size = { w: element.offsetWidth, h: element.offsetHeight };
      entry = { ...entry, [mode]: size };
      labelSize.set(element, entry);
    }
    const box = { l: x - size.w / 2 - 2, t: y - size.h - 2, r: x + size.w / 2 + 2, b: y + 2 };
    const onScreen = box.r > 0 && box.l < width && box.b > 0 && box.t < height;
    const clear = onScreen && !kept.some((k) => box.l < k.r && box.r > k.l && box.t < k.b && box.b > k.t);
    element.style.visibility = clear ? "" : "hidden";
    if (clear) kept.push(box);
  }
}

// At rest each shown operation wears a quiet stem badge and data stays unnamed; hovering or choosing an
// item expands its full name and names what it touches, while the remaining stems step back behind them.
function namedNow(): Set<HTMLElement>
{
  const named = new Set<HTMLElement>();
  if (!layout) return named;
  for (const spot of layout.operations)
    if (spot.tag && (spot.unmapped || opShown(spot.name))) named.add(spot.tag);
  const focus = active ?? hovered;
  if (focus === null) return named;
  const operation = focus.kind === "op" ? S.CONCEPTS.operations[focus.name] : undefined;
  const data = new Set(focus.kind === "datum" ? [focus.name] : [...(operation?.reads ?? []), ...(operation?.writes ?? [])]);
  for (const marker of layout.data)
    if (marker.tag && dataShown(marker.name) && data.has(marker.name)) named.add(marker.tag);
  return named;
}

// Hovering in the concept view names the first column or hexagon the pointer's ray meets, or the operation of a
// file that stands outside any column.
let hoverFromMap = false;
export function conceptHover(x: number, y: number): void
{
  if (!S.conceptZoom || !layout) return;
  const hit = scene.pick(x, y, (mesh) =>
  {
    const meta = mesh.metadata as { op?: string; datum?: string } | null;
    if (meta?.op !== undefined) return meta.op === Unmapped || opShown(meta.op);
    return meta?.datum !== undefined && dataShown(meta.datum);
  });
  const meta = hit.hit ? hit.pickedMesh!.metadata as { op?: string; datum?: string } : null;
  let next: Choice = meta?.op !== undefined ? { kind: "op", name: meta.op } : meta?.datum !== undefined ? { kind: "datum", name: meta.datum } : null;
  if (next === null)
  {
    const file = pickFile(x, y);
    const spot = file ? layout.operations.find((candidate) => candidate.files.includes(file.path)) : undefined;
    if (spot) next = { kind: "op", name: spot.name };
  }
  if (next === null && !hoverFromMap) return;
  hoverFromMap = next !== null;
  if (next?.kind !== hovered?.kind || next?.name !== hovered?.name) setHovered(next);
}

export function placeConceptLabels(): void
{
  if (overlay.hidden) return;
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const transform = scene.getTransformMatrix();
  const viewport = camera.viewport.toGlobal(width, height);
  const placed: { element: HTMLElement; x: number; y: number; rank: number }[] = [];
  const named = namedNow();
  for (const element of overlay.children as HTMLCollectionOf<HTMLElement>)
  {
    if (!named.has(element)) { element.style.visibility = "hidden"; continue; }
    const point = new V3(Number(element.dataset.x), Number(element.dataset.y ?? 0), Number(element.dataset.z));
    const p = V3.Project(point, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    element.style.transform = "translate(" + p.x.toFixed(1) + "px," + p.y.toFixed(1) + "px) translate(-50%, -100%)";
    // The focused label wins, followed by connected full operations and data, then quiet stem badges.
    const weight = Number(element.dataset.weight ?? 0);
    const primary = element.classList.contains("hot") || element.classList.contains("chosen");
    const isStem = element.classList.contains("stem");
    const isOp = element.classList.contains("concept-op");
    const rank = primary ? 0
      : !isStem ? (isOp ? 1e5 - weight : 2e5)
      : element.classList.contains("unmapped") ? 2e6 : 1e6 - weight;
    placed.push({ element, x: p.x, y: p.y, rank });
  }
  declutter(placed, width, height);
  placeLeaders(transform, viewport);
}

function filterSignature(): string
{
  return hasFilters() ? [...S.outliner.systems].sort().join(",") + "/" + [...S.outliner.layers].sort().join(",") + "/" + (S.tagFilter ?? "") + "/" + (S.isolatedFiles?.size ?? "") : "";
}

// Runs every frame, after a shown route has set its targets, so the zoom wins while it is on.
export function conceptTargets(): void
{
  if (!S.conceptZoom) return;
  // The columns are laid out again only when the files or their imports change. The layer gap moves
  // heights alone, and every vertical piece of the zoom reads the boxes' own heights as they glide,
  // so a gap change refreshes the dots' resting heights in place instead of rebuilding the layout.
  const key = S.graphSignature + "|" + S.fileRecords.size + "|" + filterSignature();
  const rebuilt = layout === null || key !== layoutKey;
  if (rebuilt)
  {
    filterView = conceptFilterView(S.CONCEPTS.data, S.CONCEPTS.operations, hasFilters(), inScene);
    layout = buildLayout();
    layoutKey = key;
    if (layout) { buildMeshes(layout); buildLabels(layout); }
    renderSheet();
  }
  if (!layout) return;
  for (const [path, spot] of layout.home) if (S.fileRecords.has(path)) spot.y = stackY(path);
  setScenery(false);
  fitPills(layout);
  fitData(layout);
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

// The city's layer gap before the concept view collapsed it, so leaving can put it back.
let cityLayerGap: number | null = null;

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
    // The concept view reads by column, not by layer height, so collapse the planes to their narrowest.
    cityLayerGap = S.layerGap;
    setLayerGap(MIN_LAYER_GAP);
    if (rightTabs) rightTabs.hidden = false;
    setRightTab("concepts");
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
    if (cityLayerGap !== null)
    {
      setLayerGap(cityLayerGap);
      restack(false);
      cityLayerGap = null;
    }
    if (rightTabs) rightTabs.hidden = true;
    document.body.classList.remove("rtab-concepts", "rtab-outliner");
    if (outlinerShow) outlinerShow.textContent = "Outliner";
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
    filterView = null;
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
  const plate = scene.pick(scene.pointerX, scene.pointerY, (mesh) => (mesh.metadata as { datum?: string } | null)?.datum !== undefined);
  if (plate.hit) { choose("datum", (plate.pickedMesh.metadata as { datum: string }).datum); return true; }
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
