import { S, V3, scene, glowMaterial, materialFor, filePath, matchesFilters, nodeMatchesFilters, hasFilters } from "./state.js";
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
  lit?: boolean;
}

let edgeLines: BABYLON.Mesh | null = null;
let tetherLines: BABYLON.Mesh | null = null;
let edgeShapes: BABYLON.Mesh[] = [];
let tetherShapes: BABYLON.Mesh[] = [];

/** One solid strand that carries a travelling dot, so the direction of an import reads at a glance. */
interface Flow { edge: Edge; bow: number; hex: string }
let flowEdges: Flow[] = [];
const flowDots: BABYLON.Mesh[] = [];
const flowHexes: string[] = [];
let flowTime = 0;

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
// one nested deeper is a break. With layers declared, breaks are drawn per file by
// collectBreaks instead, so folder strands stay plain.
function collectEdges(): Edge[]
{
  const result: Edge[] = [];
  const byId = new Map(S.NODES.map((n) => [n.id, n]));
  for (const [from, to, count] of S.EDGES)
  {
    const user = byId.get(from), used = byId.get(to);
    if (!user || !used || user.hidden || used.hidden || user.cx === undefined || used.cx === undefined) continue;
    const broken = S.LAYERS.length === 0 && user.rank < used.rank;
    let state = "normal";
    if (S.trace) state = "dim";
    else if (S.selected >= 0) state = user.index === S.selected ? "out" : used.index === S.selected ? "in" : "dim";
    // A tag filter dims every import that touches neither a matching folder.
    if (hasFilters() && state !== "dim" && !nodeMatchesFilters(user.index!) && !nodeMatchesFilters(used.index!)) state = "dim";
    result.push({
      user: new V3(user.cx, user.topY! + 0.02, user.cz!),
      used: new V3(used.cx, used.topY! + 0.02, used.cz!),
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
      const p = rec.shape.position;
      return new V3(p.x, p.y + rec.shape.scaling.y / 2 + 0.03, p.z);
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
        user: user.shape.position, used: used.shape.position,
        broken, state: from === chosen ? "out" : "in", weight: 1,
      });
    }
  }
  return result;
}

/** One file import that points up the layers, from the user's tether foot to the used file's. */
interface Break { user: BABYLON.Vector3; used: BABYLON.Vector3; lit: boolean }

// Where a file's tether meets its folder's plate: the spot under its box, on the floor.
function footOf(rec: FileRecord): BABYLON.Vector3 | null
{
  const folder = S.NODES[rec.node];
  if (!folder || folder.topY === undefined) return null;
  return new V3(rec.shape.position.x, folder.topY + 0.012, rec.shape.position.z);
}

// Every file import that points up the declared layers, foot to foot on the folder plates. The
// chosen file's own breaks are left out, since collectEdges already draws them as solid strands.
function collectBreaks(): Break[]
{
  const result: Break[] = [];
  if (S.LAYERS.length === 0) return result;
  const chosen = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
  for (const [from, to] of S.FILE_EDGES)
  {
    if (from === chosen || to === chosen || !pointsUp(from, to)) continue;
    const user = S.fileRecords.get(from), used = S.fileRecords.get(to);
    if (!user || !used) continue;
    const a = footOf(user), b = footOf(used);
    if (!a || !b) continue;
    const lit = (matchesFilters(from) || matchesFilters(to)) && S.trace === null &&
      (S.focusSet === null || S.focusSet.has(user.node) || S.focusSet.has(used.node));
    result.push({ user: a, used: b, lit });
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
  const active = S.trace !== null || S.focusSet !== null || hasFilters();
  for (const rec of S.fileRecords.values())
  {
    const folder = S.NODES[rec.node];
    if (!folder || folder.topY === undefined) continue;
    const lit = matchesFilters(rec.path) && (S.trace === null || S.trace.set.has(rec.path)) && (S.focusSet === null || S.focusSet.has(rec.node));
    const pos = rec.shape.position;
    const bottomY = pos.y - rec.shape.scaling.y / 2;
    const routed = S.trace !== null && S.trace.trace && S.trace.set.has(rec.path);
    if (routed && rec.terrace)
    {
      const floor = new V3(pos.x, folder.topY, pos.z);
      const home = new V3(rec.terrace.x, folder.topY, rec.terrace.z);
      const points = [new V3(pos.x, bottomY, pos.z), floor];
      if (V3.Distance(floor, home) > 0.05) points.push(home);
      if (bottomY - folder.topY < 0.05 && points.length < 3) continue;
      tethers.push({ points, hue: hues.get(rec.node) || "#8b98a8", routed: true, lit: true });
      continue;
    }
    if (bottomY - folder.topY < 0.05) continue;
    tethers.push({ points: [new V3(pos.x, bottomY, pos.z), new V3(pos.x, folder.topY, pos.z)], hue: "#8b98a8",
      routed: false, faded: S.trace !== null && S.trace.trace, lit: active && lit });
  }
  return tethers;
}

// Redraws every import: quiet hairlines for the crowd, and solid strands with
// arrowheads for the chosen block's imports and for every layer break.
function rebuildEdges(): void
{
  if (edgeLines) edgeLines.dispose();
  edgeLines = null;
  for (const shape of edgeShapes) shape.dispose();
  edgeShapes = [];
  flowEdges = [];

  const edges = collectEdges();
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
      flowEdges.push({ edge, bow, hex });
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
  // Layer breaks: a thin red line from tether foot to tether foot, brightening toward the file
  // that uses the import, so direction reads without an arrowhead per line.
  for (const { user, used, lit } of collectBreaks())
  {
    const base = lit ? 0.85 : 0.08;
    lines.push([used, user]);
    colors.push([new BABYLON.Color4(0.97, 0.32, 0.29, base * 0.35), new BABYLON.Color4(0.97, 0.32, 0.29, base)]);
  }
  if (lines.length > 0)
  {
    edgeLines = BABYLON.MeshBuilder.CreateLineSystem("edges", { lines, colors, useVertexAlpha: true }, scene);
    edgeLines.isPickable = false;
  }

  // The tethers: a file that floats above the ground is tied straight down to its plate.
  // They are batched into one line system, because a tube and a disc per file was the single
  // heaviest part of a redraw on a large map. Only a routed file keeps its own tube.
  if (tetherLines) tetherLines.dispose();
  tetherLines = null;
  for (const shape of tetherShapes) shape.dispose();
  tetherShapes = [];
  const pillarLines: BABYLON.Vector3[][] = [], pillarColors: BABYLON.Color4[][] = [];
  const FOOT_SEGMENTS = 10;
  for (const { points, hue, routed, faded, lit } of collectTethers())
  {
    if (routed)
    {
      const tube = BABYLON.MeshBuilder.CreateTube("tether", { path: points, radius: 0.036, tessellation: 5 }, scene);
      tube.material = materialFor(hue, 0.85, 0.5);
      tube.isPickable = false;
      tetherShapes.push(tube);

      const foot = points[points.length - 1];
      const disc = BABYLON.MeshBuilder.CreateDisc("tether-foot", { radius: 0.16, tessellation: 16, sideOrientation: BABYLON.Mesh.DOUBLESIDE }, scene);
      disc.rotation.x = Math.PI / 2;
      disc.position.set(foot.x, foot.y + 0.006, foot.z);
      disc.material = materialFor(hue, 0.95, 0.6);
      disc.isPickable = false;
      tetherShapes.push(disc);
      continue;
    }

    const alpha = faded ? 0.12 : lit ? 0.6 : 0.1;
    const shade = new BABYLON.Color4(0.55, 0.64, 0.75, alpha);
    pillarLines.push(points);
    pillarColors.push(points.map(() => shade));
    // A thin ring where the pillar meets the floor, only for the files bright enough to read.
    if (lit && !faded)
    {
      const foot = points[points.length - 1];
      const ring: BABYLON.Vector3[] = [];
      for (let i = 0; i <= FOOT_SEGMENTS; i++)
      {
        const angle = (i / FOOT_SEGMENTS) * Math.PI * 2;
        ring.push(new V3(foot.x + Math.cos(angle) * 0.11, foot.y + 0.006, foot.z + Math.sin(angle) * 0.11));
      }
      pillarLines.push(ring);
      pillarColors.push(ring.map(() => new BABYLON.Color4(0.55, 0.64, 0.75, Math.min(1, alpha * 1.6))));
    }
  }
  if (pillarLines.length > 0)
  {
    tetherLines = BABYLON.MeshBuilder.CreateLineSystem("tethers", { lines: pillarLines, colors: pillarColors, useVertexAlpha: true }, scene);
    tetherLines.isPickable = false;
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

// Moves one small dot along each solid strand, from the imported side to the side that uses it,
// so an import's direction reads even before you notice the arrowhead.
export function updateFlow(seconds: number): void
{
  flowTime += seconds;
  const used = Math.min(flowEdges.length, 64);
  for (let i = 0; i < used; i++)
  {
    const { edge, bow, hex } = flowEdges[i];
    let dot = flowDots[i];
    if (!dot)
    {
      dot = BABYLON.MeshBuilder.CreateSphere("flow", { diameter: 0.14, segments: 6 }, scene);
      dot.isPickable = false;
      flowDots.push(dot);
    }
    if (flowHexes[i] !== hex) { dot.material = glowMaterial(hex); flowHexes[i] = hex; }
    const speed = 0.22 + 0.015 * Math.min(20, V3.Distance(edge.used, edge.user));
    const t = (flowTime * speed + i * 0.137) % 1;
    dot.position.copyFrom(edgePoint(edge, bow, t));
    dot.isVisible = true;
  }
  for (let i = used; i < flowDots.length; i++) flowDots[i].isVisible = false;
}

export { rebuildEdges };
