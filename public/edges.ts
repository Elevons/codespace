import { S, V3, scene, glowMaterial, materialFor, filePath, matchesFilters, hasFilters, inScene } from "./state.js";
import { routeFolderHues, routeRuns, runLine } from "./route.js";
import type { FileRecord } from "./types.js";

/** The width of a folder's bus, the corridor its traces to one other folder share. */
const STRIP_WIDTH = 1.25;

/** One import on screen: its two ends, its trace when it has one, and how it should look. */
interface Edge
{
  user: BABYLON.Vector3;
  used: BABYLON.Vector3;
  /** A circuit-board trace: straight runs from end to end, used in place of a curve when set. */
  trace?: BABYLON.Vector3[];
  broken: boolean;
  state: string;
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

// The point at t along an edge, from the imported end to the user: along its circuit trace when it
// has one, else on a plain arch.
function edgePoint(edge: Edge, bow: number, t: number): BABYLON.Vector3
{
  if (t >= 1) return edge.user.clone();
  if (edge.trace) return polylinePoint(edge.trace, t);
  return archPoint(edge.used, edge.user, bow, t);
}

// The point a fraction t of the way along a run of straight segments, by length.
function polylinePoint(points: BABYLON.Vector3[], t: number): BABYLON.Vector3
{
  let total = 0;
  for (let i = 1; i < points.length; i++) total += V3.Distance(points[i - 1], points[i]);
  let left = Math.max(0, Math.min(1, t)) * total;
  for (let i = 1; i < points.length; i++)
  {
    const length = V3.Distance(points[i - 1], points[i]);
    if (left <= length && length > 0) return points[i - 1].add(points[i].subtract(points[i - 1]).scale(left / length));
    left -= length;
  }
  return points[points.length - 1].clone();
}

/* --------------------------------------------------- circuit traces ---- */

// A chosen folder's imports are drawn like the traces on a circuit board, so many of them stay
// readable: each rises straight up from its pad to a routing level just above the plates, runs in
// straight lines with cut corners, and drops straight onto the other pad. The traces between the
// chosen folder and one other folder share a corridor and run side by side, like a bus; each bus
// runs at its own small height, so buses that cross pass over one another instead of merging.
const TRACE_LIFT = 0.3, TRACE_LAYER = 0.06, TRACE_GAP = 0.1, TRACE_CHAMFER = 0.3;

/**
 * Lays out circuit traces for a set of edges, one bus per group.
 * @param edges the edges to route, each given its trace
 * @param groups the group each edge belongs to, by index into edges
 */
function routeTraces(edges: Edge[], groups: string[]): void
{
  const buses = new Map<string, number[]>();
  groups.forEach((key, i) => { const bus = buses.get(key); if (bus) bus.push(i); else buses.set(key, [i]); });
  let layer = 0;
  for (const members of buses.values())
  {
    // The bus runs along whichever way its two ends lie farther apart, in a corridor halfway between
    // them the other way, and lifts one routing layer above the bus before it.
    let dx = 0, dz = 0, middle = 0;
    for (const i of members)
    {
      const { used, user } = edges[i];
      dx += Math.abs(user.x - used.x);
      dz += Math.abs(user.z - used.z);
    }
    const alongX = dx >= dz;
    for (const i of members) middle += alongX ? (edges[i].used.z + edges[i].user.z) / 2 : (edges[i].used.x + edges[i].user.x) / 2;
    middle /= members.length;
    // Lanes are ordered by where each trace starts across the bus, so neighbours never cross.
    const ordered = [...members].sort((a, b) => alongX ? edges[a].used.z - edges[b].used.z : edges[a].used.x - edges[b].used.x);
    ordered.forEach((i, lane) =>
    {
      const edge = edges[i];
      const corridor = middle + (lane - (ordered.length - 1) / 2) * TRACE_GAP;
      const height = Math.max(edge.used.y, edge.user.y) + TRACE_LIFT + layer * TRACE_LAYER;
      edge.trace = traceThrough(edge.used, edge.user, height, corridor, alongX);
    });
    layer++;
  }
}

/**
 * One trace: up from a pad, along to the corridor, down the corridor, across to the other pad, and
 * down onto it, with the level corners cut at forty-five degrees.
 * @param from the imported file's pad
 * @param to the using file's pad
 * @param height the routing level
 * @param corridor where the bus runs, across its length
 * @param alongX whether the bus runs along x
 */
function traceThrough(from: BABYLON.Vector3, to: BABYLON.Vector3, height: number, corridor: number, alongX: boolean): BABYLON.Vector3[]
{
  const corners = alongX
    ? [new V3(from.x, height, from.z), new V3(from.x, height, corridor), new V3(to.x, height, corridor), new V3(to.x, height, to.z)]
    : [new V3(from.x, height, from.z), new V3(corridor, height, from.z), new V3(corridor, height, to.z), new V3(to.x, height, to.z)];
  // Drop corners that do not turn, so a trace already on its corridor is one straight run.
  const level: BABYLON.Vector3[] = [];
  for (const point of corners) if (level.length === 0 || V3.Distance(level[level.length - 1], point) > 1e-3) level.push(point);
  const cut: BABYLON.Vector3[] = [level[0]];
  for (let i = 1; i < level.length - 1; i++)
  {
    const before = level[i - 1], at = level[i], after = level[i + 1];
    const into = at.subtract(before), out = after.subtract(at);
    const r = Math.min(TRACE_CHAMFER, V3.Distance(before, at) / 2, V3.Distance(at, after) / 2);
    cut.push(at.subtract(into.normalize().scale(r)), at.add(out.normalize().scale(r)));
  }
  if (level.length > 1) cut.push(level[level.length - 1]);
  return [from.clone(), ...cut, to.clone()];
}

// Whether one file using another points up the layers the repository declares.
function pointsUp(userPath: string, usedPath: string): boolean
{
  const user = S.FILE_LAYERS.get(userPath), used = S.FILE_LAYERS.get(usedPath);
  return user !== undefined && used !== undefined && S.LAYERS.indexOf(user) < S.LAYERS.indexOf(used);
}

// The import wires, drawn only for what is chosen so the map stays readable. A chosen folder's
// imports in and out are one strand per file import, from the imported file's tether pad to the pad
// of the file that uses it; between folders the strand follows the folder tree, so a folder's imports
// from one region travel together and fan out to their files. A chosen file's own imports arch
// straight from block to block instead, with nothing drawn on the pads.
// Nothing chosen, or a route shown, draws no wires; the layer breaks (collectBreaks) still show.
// A file chosen shows only its own imports, not its folder's as well. Without declared layers, an
// import into a folder nested deeper is drawn as a break; with them, it is a file using a higher layer.
function collectEdges(): Edge[]
{
  const result: Edge[] = [];
  const folderChosen = S.selected >= 0 && S.selectedFile < 0 && S.trace === null;
  const chosen = S.selected >= 0 && S.selectedFile >= 0 && S.trace === null ? filePath(S.selected, S.selectedFile) : null;
  // The bus each chosen folder's wire joins: its direction and the folder at its other end.
  const busOf: string[] = [];
  if (folderChosen || chosen !== null)
  {
    for (const [from, to] of S.FILE_EDGES)
    {
      const userRec = S.fileRecords.get(from), usedRec = S.fileRecords.get(to);
      if (!userRec || !usedRec || !inScene(from) || !inScene(to)) continue;
      // A folder's wires are the imports crossing its edge; a file's are its own, inside its folder too.
      let state: string;
      if (chosen !== null)
      {
        if (from !== chosen && to !== chosen) continue;
        state = from === chosen ? "out" : "in";
      }
      else
      {
        if (userRec.node === usedRec.node || (userRec.node !== S.selected && usedRec.node !== S.selected)) continue;
        state = userRec.node === S.selected ? "out" : "in";
      }
      const user = S.NODES[userRec.node], used = S.NODES[usedRec.node];
      if (!user || !used || user.hidden || used.hidden || user.cx === undefined || used.cx === undefined) continue;
      const broken = S.LAYERS.length > 0 ? pointsUp(from, to) : user.rank < used.rank;
      // A chosen file's wires join its floors when it is open, and its box until then,
      // with nothing drawn on the folder pads.
      if (chosen !== null)
      {
        result.push({ user: WireEnd(userRec, "user"), used: WireEnd(usedRec, "used"), broken, state });
        continue;
      }
      const userPad = footOf(userRec), usedPad = footOf(usedRec);
      if (!userPad || !usedPad) continue;
      result.push({ user: userPad, used: usedPad, broken, state });
      busOf.push(state + ":" + (state === "out" ? usedRec.node : userRec.node));
    }
    if (folderChosen) routeTraces(result, busOf);
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
      result.push({ user, used, broken: false, state: "trace",
        bow: Math.min(5, Math.max(1.1, 0.35 * length + 0.6)) });
    }
  }

  return result;
}

// Where one end of a chosen file's wire meets the file: the floor that carries the block
// when the file is open, and the middle of its box otherwise.
function WireEnd(rec: FileRecord, role: "user" | "used"): BABYLON.Vector3
{
  const anchors = S.floorAnchors;
  if (anchors !== null && anchors.path === rec.path) return role === "used" ? anchors.used : anchors.user;
  return rec.shape.position;
}

/** One file import that points up the layers, from the user's tether foot to the used file's. */
interface Break { user: BABYLON.Vector3; used: BABYLON.Vector3; lit: boolean; from: number; to: number }

// Where a file's tether meets its folder's plate: the spot under its box, on the floor.
function footOf(rec: FileRecord): BABYLON.Vector3 | null
{
  const folder = S.NODES[rec.node];
  if (!folder || folder.topY === undefined) return null;
  return new V3(rec.shape.position.x, folder.topY + 0.012, rec.shape.position.z);
}

// Every file import that points up the declared layers, foot to foot on the folder plates. The
// chosen file's or folder's own breaks are left out, since collectEdges draws them as its wires.
function collectBreaks(): Break[]
{
  const result: Break[] = [];
  if (S.LAYERS.length === 0) return result;
  const chosen = S.selected >= 0 && S.selectedFile >= 0 && S.trace === null ? filePath(S.selected, S.selectedFile) : null;
  const folderChosen = S.selected >= 0 && S.selectedFile < 0 && S.trace === null;
  for (const [from, to] of S.FILE_EDGES)
  {
    if (from === chosen || to === chosen || !pointsUp(from, to)) continue;
    const user = S.fileRecords.get(from), used = S.fileRecords.get(to);
    if (!user || !used) continue;
    if (folderChosen && user.node !== used.node && (user.node === S.selected || used.node === S.selected)) continue;
    const a = footOf(user), b = footOf(used);
    if (!a || !b) continue;
    const lit = (matchesFilters(from) || matchesFilters(to)) && S.trace === null &&
      (S.focusSet === null || S.focusSet.has(user.node) || S.focusSet.has(used.node));
    result.push({ user: a, used: b, lit, from: user.node, to: used.node });
  }
  return result;
}

// The colour of each point along a break's trace, fading in from the imported side to the file that
// uses it, so direction reads without an arrowhead per line.
function breakTraceColors(points: BABYLON.Vector3[], start: number, end: number): BABYLON.Color4[]
{
  const reach: number[] = [0];
  for (let i = 1; i < points.length; i++) reach.push(reach[i - 1] + V3.Distance(points[i - 1], points[i]));
  const total = reach[reach.length - 1];
  return points.map((_point, i) =>
  {
    const f = total > 0 ? reach[i] / total : 1;
    return new BABYLON.Color4(0.97, 0.32, 0.29, start + (end - start) * f);
  });
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

  // Every wire is for something chosen (a folder, a file, or a route), so each is a solid strand
  // with a travelling dot: green along a route, red for a layer break, blue going out, amber coming in.
  const lines: BABYLON.Vector3[][] = [], colors: BABYLON.Color4[][] = [];
  for (const edge of collectEdges())
  {
    const length = V3.Distance(edge.user, edge.used);
    const bow = edge.bow !== undefined ? edge.bow : Math.min(6, 0.25 * length + 0.3);
    const state = edge.state;
    const hex = state === "trace" ? "#3fb950" : edge.broken ? "#f85149" : state === "out" ? "#58a6ff" : "#d29922";
    addStrand(edge, bow, hex, state === "trace" ? 0.04 : 0.05);
    flowEdges.push({ edge, bow, hex });
  }
  // Layer breaks: a thin red line from tether foot to tether foot, brightening toward the file
  // that uses the import, so direction reads without an arrowhead per line. Each follows the same
  // circuit routing as a chosen folder's traces, so a break bends with the rest of the wiring
  // instead of cutting straight across the plates.
  const breaks = collectBreaks();
  const breakEdges: Edge[] = breaks.map(({ user, used }) => ({ user, used, broken: true, state: "break" }));
  routeTraces(breakEdges, breaks.map(({ from, to }) => `break:${Math.min(from, to)}>${Math.max(from, to)}`));
  breaks.forEach(({ user, used, lit }, i) =>
  {
    const base = lit ? 0.85 : 0.08;
    const trace = breakEdges[i].trace ?? [used, user];
    lines.push(trace);
    colors.push(breakTraceColors(trace, base * 0.35, base));
  });
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
      const tube = BABYLON.MeshBuilder.CreateTube("tether", { path: points, radius: 0.018, tessellation: 5 }, scene);
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

    const alpha = faded ? 0.06 : lit ? 0.3 : 0.05;
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

// One solid strand from the imported end to the user, with an arrowhead where it is used.
// A trace's strand follows its straight runs exactly; any other is sampled along its curve.
// The strand and its arrowhead are both drawn at half the given radius, a hairline that leaves the map readable.
function addStrand(edge: Edge, bow: number, hex: string, given: number): void
{
  const radius = given / 2;
  const path: BABYLON.Vector3[] = [];
  if (edge.trace) path.push(...edge.trace);
  else for (let i = 0; i <= 20; i++) path.push(edgePoint(edge, bow, i / 20));
  const tube = BABYLON.MeshBuilder.CreateTube("strand", { path, radius, tessellation: 6 }, scene);
  tube.material = glowMaterial(hex);
  tube.isPickable = false;
  edgeShapes.push(tube);

  const tip = path[path.length - 1];
  let before = path[path.length - 2];
  for (let i = path.length - 2; i >= 0 && V3.Distance(path[i], tip) < 1e-3; i--) before = path[Math.max(0, i - 1)];
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
