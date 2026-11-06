import { S, V3, scene, glowMaterial, materialFor, filePath } from "./state.js";
import { routeFolderHues, routeRuns, runLine } from "./route.js";
import type { FileRecord, GraphNode } from "./types.js";

/** One import on screen: its two ends, its route when bundled, and how it should look. */
interface Edge
{
  user: BABYLON.Vector3;
  used: BABYLON.Vector3;
  route?: BABYLON.Vector3[] | null;
  broken: boolean;
  state: string;
  weight: number;
  bow?: number;
}

/** One strand from a lifted file down to its folder's floor. */
interface Tether
{
  points: BABYLON.Vector3[];
  hue: string;
  routed: boolean;
  faded?: boolean;
}

let edgeLines: BABYLON.Mesh | null = null;
let edgeShapes: BABYLON.Mesh[] = [];
let tetherShapes: BABYLON.Mesh[] = [];
let brokenCount = 0;

// The point on a gentle arch from a to b, bowed upward so bundles read as strands.
function archPoint(a: BABYLON.Vector3, b: BABYLON.Vector3, bow: number, t: number): BABYLON.Vector3
{
  const mid = V3.Center(a, b);
  mid.y += bow;
  const u = 1 - t;
  return new V3(
    u * u * a.x + 2 * u * t * mid.x + t * t * b.x,
    u * u * a.y + 2 * u * t * mid.y + t * t * b.y,
    u * u * a.z + 2 * u * t * mid.z + t * t * b.z);
}

// How tightly folder imports hug the folder tree: 0 is a straight line, 1 follows it exactly.
const BUNDLE = 0.85;

// The folders from one up to the root, itself first.
function ancestry(n: GraphNode): GraphNode[]
{
  const chain: GraphNode[] = [];
  for (let at: GraphNode | null = n; at; at = at.parent ?? null) chain.push(at);
  return chain;
}

// Where an import's strand passes: from the imported folder up the tree to the nearest folder
// above both, then down to the folder that uses it. Imports between the same regions share
// this route, so they gather into bundles. The strand is straightened toward the direct line
// by BUNDLE, and the top of the route is lifted so the bundle arches over the tiles. A folder
// and its own subfolder have no route between them, so they keep the plain arch (null).
function bundleRoute(used: GraphNode, user: GraphNode, lift: number): BABYLON.Vector3[] | null
{
  const up = ancestry(used), down = ancestry(user);
  const shared = new Set(down);
  const top = up.findIndex((n) => shared.has(n));
  const route = up.slice(0, top + 1).concat(down.slice(0, down.indexOf(up[top])).reverse());
  if (route.length < 3) return null;
  const points = route.map((n) => new V3(n.cx!, n.topY! + 0.45, n.cz!));
  points[top > 0 && top < route.length - 1 ? top : Math.floor(route.length / 2)].y += lift;
  const first = points[0], last = points[points.length - 1];
  return points.map((p, i) =>
  {
    if (i === 0 || i === points.length - 1) return p;
    const along = i / (points.length - 1);
    return new V3(
      BUNDLE * p.x + (1 - BUNDLE) * (first.x + along * (last.x - first.x)),
      BUNDLE * p.y + (1 - BUNDLE) * (first.y + along * (last.y - first.y)),
      BUNDLE * p.z + (1 - BUNDLE) * (first.z + along * (last.z - first.z)));
  });
}

// The point at t (0 to 1) along a smooth cubic B-spline through a route's control points.
// The ends are tripled so the curve starts and finishes exactly on the first and last.
function splinePoint(route: BABYLON.Vector3[], t: number): BABYLON.Vector3
{
  const p = [route[0], route[0], ...route, route[route.length - 1], route[route.length - 1]];
  const segments = p.length - 3;
  const s = Math.min(t, 0.999999) * segments;
  const i = Math.floor(s), u = s - i;
  const u2 = u * u, u3 = u2 * u;
  const b0 = (1 - u) * (1 - u) * (1 - u) / 6, b1 = (3 * u3 - 6 * u2 + 4) / 6;
  const b2 = (-3 * u3 + 3 * u2 + 3 * u + 1) / 6, b3 = u3 / 6;
  return new V3(
    b0 * p[i].x + b1 * p[i + 1].x + b2 * p[i + 2].x + b3 * p[i + 3].x,
    b0 * p[i].y + b1 * p[i + 1].y + b2 * p[i + 2].y + b3 * p[i + 3].y,
    b0 * p[i].z + b1 * p[i + 1].z + b2 * p[i + 2].z + b3 * p[i + 3].z);
}

// The point at t along an edge, from the imported end to the user: along its bundle
// route when it has one, else on a plain arch.
function edgePoint(edge: Edge, bow: number, t: number): BABYLON.Vector3
{
  if (t >= 1) return edge.user.clone();
  return edge.route ? splinePoint(edge.route, t) : archPoint(edge.used, edge.user, bow, t);
}

// The folder pairs, as "user\u0001used" ids, that have an import pointing up the declared layers:
// a file in a lower layer using one in a higher. Kept until the graph is read again.
let breakCache: { edges: [string, string][] | null; layers: string[] | null; pairs: Set<string> } =
  { edges: null, layers: null, pairs: new Set() };
function brokenPairs(): Set<string>
{
  if (breakCache.edges === S.FILE_EDGES && breakCache.layers === S.LAYERS) return breakCache.pairs;
  const folderOf = new Map<string, string>();
  S.NODES.forEach((n, nodeIndex) => n.files.forEach((name, fileIndex) => folderOf.set(filePath(nodeIndex, fileIndex), n.id)));
  const pairs = new Set<string>();
  for (const [from, to] of S.FILE_EDGES) if (pointsUp(from, to)) pairs.add(folderOf.get(from) + "\u0001" + folderOf.get(to));
  breakCache = { edges: S.FILE_EDGES, layers: S.LAYERS, pairs };
  return pairs;
}

// Whether one file using another points up the layers the repository declares.
function pointsUp(userPath: string, usedPath: string): boolean
{
  const user = S.FILE_LAYERS.get(userPath), used = S.FILE_LAYERS.get(usedPath);
  return user !== undefined && used !== undefined && S.LAYERS.indexOf(user) < S.LAYERS.indexOf(used);
}

// Every folder import on screen, as two ends and how it should look. An import that
// points up the layers — something lower down using something built on top of it —
// is a break: the one kind that means the layers are tangled. With layers declared, that is
// read from the layer each file is given in the architecture file; without, a folder using
// one nested deeper is a break.
function collectEdges(): Edge[]
{
  const result: Edge[] = [];
  const byId = new Map(S.NODES.map((n) => [n.id, n]));
  for (const [from, to, count] of S.EDGES)
  {
    const user = byId.get(from), used = byId.get(to);
    if (!user || !used || user.hidden || used.hidden || user.cx === undefined || used.cx === undefined) continue;
    const broken = S.LAYERS.length > 0 ? brokenPairs().has(from + "\u0001" + to) : user.rank < used.rank;
    let state = "normal";
    if (S.trace) state = "dim";
    else if (S.selected >= 0) state = user.index === S.selected ? "out" : used.index === S.selected ? "in" : "dim";
    result.push({
      user: new V3(user.cx, user.topY! + 0.45, user.cz!),
      used: new V3(used.cx, used.topY! + 0.45, used.cz!),
      route: bundleRoute(used, user, 0.5),
      broken, state, weight: count,
    });
  }

  // A code path being traced (S.trace): a strand from each file to the next, in order. Each
  // strand leaves the top of one block and lands on the top of the next, arching clear of the
  // blocks between, so its arrowhead sits in view instead of buried in the block's middle.
  if (S.trace && S.trace.trace)
  {
    const topOf = (rec: FileRecord): BABYLON.Vector3 =>
    {
      const p = rec.mesh.position;
      return new V3(p.x, p.y + rec.mesh.scaling.y / 2 + 0.03, p.z);
    };
    for (let i = 0; i + 1 < S.trace.paths.length; i++)
    {
      const from = S.fileRecords.get(S.trace.paths[i]), to = S.fileRecords.get(S.trace.paths[i + 1]);
      if (!from || !to || from === to) continue;
      const used = topOf(from), user = topOf(to);
      const length = V3.Distance(used, user);
      result.push({ user, used, broken: false, state: "trace", weight: 1,
        bow: Math.min(5, Math.max(1.1, 0.35 * length + 0.6)) });
    }
  }

  // The chosen file's own imports and importers, drawn file to file.
  const chosen = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
  if (chosen !== null)
  {
    for (const [from, to] of S.FILE_EDGES)
    {
      if (from !== chosen && to !== chosen) continue;
      const user = S.fileRecords.get(from), used = S.fileRecords.get(to);
      if (!user || !used) continue;
      const broken = S.LAYERS.length > 0 ? pointsUp(from, to) : S.NODES[user.node].rank < S.NODES[used.node].rank;
      result.push({
        user: user.mesh.position, used: used.mesh.position,
        broken, state: from === chosen ? "out" : "in", weight: 1,
      });
    }
  }
  return result;
}

// A straight strand from a file down to its folder's floor. A file on a route has been drawn out
// to a clear lane off the city, so its strand drops plumb in the lane and then runs along the floor
// back to the spot it normally stands on, in its folder's route colour, so each lifted file still
// reads as part of its folder. While a route is shown, every other strand fades back.
function collectTethers(): Tether[]
{
  const tethers: Tether[] = [];
  const hues = routeFolderHues();
  for (const rec of S.fileRecords.values())
  {
    const folder = S.NODES[rec.node];
    if (!folder || folder.topY === undefined) continue;
    const pos = rec.mesh.position;
    const bottomY = pos.y - rec.mesh.scaling.y / 2;
    const routed = S.trace !== null && S.trace.trace && S.trace.set.has(rec.path);
    if (routed && rec.terrace)
    {
      const floor = new V3(pos.x, folder.topY, pos.z);
      const home = new V3(rec.terrace.x, folder.topY, rec.terrace.z);
      const points = [new V3(pos.x, bottomY, pos.z), floor];
      if (V3.Distance(floor, home) > 0.05) points.push(home);
      if (bottomY - folder.topY < 0.05 && points.length < 3) continue;
      tethers.push({ points, hue: hues.get(rec.node) || "#8b98a8", routed: true });
      continue;
    }
    if (bottomY - folder.topY < 0.05) continue;
    tethers.push({ points: [new V3(pos.x, bottomY, pos.z), new V3(pos.x, folder.topY, pos.z)], hue: "#8b98a8",
      routed: false, faded: S.trace !== null && S.trace.trace });
  }
  return tethers;
}

// Redraws every import: quiet hairlines for the crowd, and solid strands with
// arrowheads for the chosen block's imports and for every layer break.
function rebuildEdges(): void
{
  if (edgeLines) edgeLines.dispose();
  for (const shape of edgeShapes) shape.dispose();
  edgeLines = null;
  edgeShapes = [];

  const edges = collectEdges();
  brokenCount = edges.filter((edge) => edge.broken).length;
  updateBreaks();
  const lines: BABYLON.Vector3[][] = [], colors: BABYLON.Color4[][] = [];
  const SEGMENTS = 16;
  for (const edge of edges)
  {
    const length = V3.Distance(edge.user, edge.used);
    const bow = edge.bow !== undefined ? edge.bow : Math.min(6, 0.25 * length + 0.3);
    const state = edge.state;
    const solid = state === "out" || state === "in" || state === "trace" || (edge.broken && state !== "dim");

    if (solid)
    {
      const hex = state === "trace" ? "#3fb950" : edge.broken ? "#f85149" : state === "out" ? "#58a6ff" : "#d29922";
      addStrand(edge, bow, hex, state === "trace" ? 0.04 : edge.broken && state === "normal" ? 0.035 : 0.05);
      continue;
    }

    // A hairline fading from the imported end to the end that uses it, so direction still reads.
    const busy = Math.min(0.55, 0.22 + 0.06 * Math.log2(1 + edge.weight));
    const base = state === "dim" ? 0.05 : busy;
    const points: BABYLON.Vector3[] = [], shades: BABYLON.Color4[] = [];
    for (let i = 0; i <= SEGMENTS; i++)
    {
      const t = i / SEGMENTS;
      points.push(edgePoint(edge, bow, t));
      shades.push(new BABYLON.Color4(0.55, 0.64, 0.75, base * (0.35 + 0.65 * t)));
    }
    lines.push(points);
    colors.push(shades);
  }
  if (lines.length > 0)
  {
    edgeLines = BABYLON.MeshBuilder.CreateLineSystem("edges", { lines, colors, useVertexAlpha: true }, scene);
    edgeLines.isPickable = false;
  }

  // The tethers: a file that floats above the ground is tied straight down to its plate.
  for (const shape of tetherShapes) shape.dispose();
  tetherShapes = [];
  for (const { points, hue, routed, faded } of collectTethers())
  {
    const tube = BABYLON.MeshBuilder.CreateTube("tether", { path: points, radius: routed ? 0.036 : 0.028, tessellation: 5 }, scene);
    tube.material = materialFor(hue, routed ? 0.85 : faded ? 0.12 : 0.6, routed ? 0.5 : 0.15);
    tube.isPickable = false;
    tetherShapes.push(tube);

    // A small flat circle where the pillar meets the floor: for a routed file, the spot it came from.
    const foot = points[points.length - 1];
    const disc = BABYLON.MeshBuilder.CreateDisc("tether-foot", { radius: routed ? 0.16 : 0.11, tessellation: 20, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    disc.rotation.x = Math.PI / 2;
    disc.position.set(foot.x, foot.y + 0.006, foot.z);
    disc.material = materialFor(hue, routed ? 0.95 : faded ? 0.15 : 0.9, routed ? 0.6 : 0.3);
    disc.isPickable = false;
    tetherShapes.push(disc);
  }

  // Under the route's lane, a strip on the floor for each run of steps from one folder, in that
  // folder's colour, so the blocks that belong together read as a group where they stand.
  for (const run of routeRuns())
  {
    const line = runLine(run);
    const left: BABYLON.Vector3[] = [], right: BABYLON.Vector3[] = [];
    line.forEach((p, i) =>
    {
      const ahead = line[Math.min(i + 1, line.length - 1)], behind = line[Math.max(i - 1, 0)];
      const tangent = ahead.subtract(behind);
      tangent.y = 0;
      if (tangent.lengthSquared() < 1e-6) tangent.set(1, 0, 0);
      tangent.normalize();
      const side = new V3(-tangent.z, 0, tangent.x).scale(STRIP_WIDTH / 2);
      left.push(p.add(side));
      right.push(p.subtract(side));
    });
    const strip = BABYLON.MeshBuilder.CreateRibbon("route-strip", { pathArray: [left, right], sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
    strip.material = materialFor(run.hue, 0.16, 0.5);
    strip.isPickable = false;
    tetherShapes.push(strip);
    const rim = BABYLON.MeshBuilder.CreateLines("route-strip-rim", { points: [...left, ...right.slice().reverse(), left[0]] }, scene);
    rim.color = BABYLON.Color3.FromHexString(run.hue);
    rim.alpha = 0.85;
    rim.isPickable = false;
    tetherShapes.push(rim);
  }
}

const STRIP_WIDTH = 1.25;

// One solid strand from the imported end to the user, with an arrowhead where it is used.
function addStrand(edge: Edge, bow: number, hex: string, radius: number): void
{
  const path: BABYLON.Vector3[] = [];
  for (let i = 0; i <= 20; i++) path.push(edgePoint(edge, bow, i / 20));
  const tube = BABYLON.MeshBuilder.CreateTube("strand", { path, radius, tessellation: 6 }, scene);
  tube.material = glowMaterial(hex);
  tube.isPickable = false;
  edgeShapes.push(tube);

  const tip = path[path.length - 1], before = path[path.length - 3];
  const direction = tip.subtract(before).normalize();
  const head = BABYLON.MeshBuilder.CreateCylinder("arrow", { diameterTop: 0, diameterBottom: radius * 7, height: radius * 10, tessellation: 8 }, scene);
  head.material = glowMaterial(hex);
  head.isPickable = false;
  head.position = tip.subtract(direction.scale(radius * 9));
  const rq = new BABYLON.Quaternion();
  head.rotationQuaternion = rq;
  BABYLON.Quaternion.FromUnitVectorsToRef(V3.Up(), direction, rq);
  edgeShapes.push(head);
}

// Shows how many imports break the downward-only rule, in the legend.
function updateBreaks(): void
{
  const note = document.getElementById("breaks-count");
  if (!note) return;
  note.textContent = brokenCount === 0
    ? "none — every import points down"
    : brokenCount + " import" + (brokenCount === 1 ? "" : "s") + " pointing up";
  note.classList.toggle("bad", brokenCount > 0);
}

export { rebuildEdges };
