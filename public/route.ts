import { S, V3 } from "./state.js";
import type { FileRecord, GraphNode, Trace } from "./types.js";

/** One run of consecutive steps on a shown route that come from the same folder. */
interface RouteRun
{
  node: number;
  hue: string;
  recs: FileRecord[];
}

// Spreads the files of a shown route along a shallow arc in a clear lane in front of the plan, in
// order, each block held at its own layer's height. The lane sits outside the city's footprint, so
// every block's straight floor strand drops through empty space instead of an unrelated block.
// Files outside the route (and the map when no route is shown) rest back on their own terrace.
// Whether the last frame lifted files onto the route lane, so a settled map can skip this work.
let lifted = false;

function routeTargets(): void
{
  const trace = S.trace;
  const lifting = trace !== null && trace.trace && trace.paths.length >= 2;

  // With no route shown, and none shown last frame, every file is already home.
  if (!lifting && !lifted) return;
  lifted = lifting;

  for (const rec of S.fileRecords.values()) rec.target.copyFrom(rec.terrace);
  if (!lifting) return;

  // Each file is placed once, where the route first reaches it; a later step that comes back to it
  // draws its strand back to the same block.
  const recs = [...new Set(trace!.paths)].map((path) => S.fileRecords.get(path)).filter((rec): rec is FileRecord => Boolean(rec));
  if (recs.length < 2) return;

  // The plan's middle and its front edge, read from every file's resting spot.
  let min: BABYLON.Vector3 | null = null, max: BABYLON.Vector3 | null = null;
  for (const rec of S.fileRecords.values())
  {
    min = min ? V3.Minimize(min, rec.terrace) : rec.terrace.clone();
    max = max ? V3.Maximize(max, rec.terrace) : rec.terrace.clone();
  }
  if (!min) return;
  const center = V3.Center(min, max!);
  const span = Math.max(8, recs.length * 1.7);
  const frontZ = max!.z + 2.6;

  // A row out along the front, bowed gently away from the city, each block kept at its own layer
  // height, so the order reads as one arc and every straight strand has clear air beneath it.
  recs.forEach((rec, i) =>
  {
    const t = recs.length > 1 ? i / (recs.length - 1) : 0.5;
    rec.target.set(
      center.x + (t - 0.5) * span,
      rec.terrace.y,
      frontZ + Math.sin(Math.PI * t) * 0.9);
  });
}

// A colour for each folder holding a file on the shown route, in the order the route first reaches
// it, so a lifted file's strand, its folder's tile, and its folder's name all share one colour.
const ROUTE_HUES = ["#79c0ff", "#d2a8ff", "#ffa657", "#56d4dd", "#e3b341", "#f778ba"];
const NO_HUES = new Map<number, string>();
let hueCache: { trace: Trace | null; nodes: GraphNode[] | null; hues: Map<number, string> } =
  { trace: null, nodes: null, hues: NO_HUES };
function routeFolderHues(): Map<number, string>
{
  const trace = S.trace;
  if (!trace || !trace.trace) return NO_HUES;
  if (hueCache.trace === trace && hueCache.nodes === S.NODES) return hueCache.hues;
  const hues = new Map<number, string>();
  for (const path of trace.paths)
  {
    const rec = S.fileRecords.get(path);
    if (rec && !hues.has(rec.node)) hues.set(rec.node, ROUTE_HUES[hues.size % ROUTE_HUES.length]);
  }
  // Kept only once the files exist, so a route shown before the map is built is read again.
  if (hues.size > 0) hueCache = { trace, nodes: S.NODES, hues };
  return hues;
}

// The shown route cut into runs of consecutive steps from the same folder, each with that folder's
// route colour, so the lane can lay a strip on the floor under every run. A route that leaves a
// folder and comes back gets a second run for it, in the same colour.
function routeRuns(): RouteRun[]
{
  const trace = S.trace;
  if (!trace || !trace.trace) return [];
  const hues = routeFolderHues();
  const runs: RouteRun[] = [];
  for (const path of trace.paths)
  {
    const rec = S.fileRecords.get(path);
    if (!rec) continue;
    const last = runs[runs.length - 1];
    if (last && last.node === rec.node) { if (!last.recs.includes(rec)) last.recs.push(rec); }
    else runs.push({ node: rec.node, hue: hues.get(rec.node) || "#8b98a8", recs: [rec] });
  }
  return runs;
}

// The middle line of a run's floor strip: under each of its blocks where they stand now, on the
// floor their strands drop to, carried a little past the first and last block.
const STRIP_REACH = 0.65;
function runLine(run: RouteRun): BABYLON.Vector3[]
{
  const folder = S.NODES[run.node];
  const y = (folder && folder.topY !== undefined ? folder.topY : 0) + 0.012;
  const points = run.recs.map((rec) => new V3(rec.shape.position.x, y, rec.shape.position.z));
  const first = points[0], last = points[points.length - 1];
  const along = points.length > 1 ? last.subtract(first) : new V3(1, 0, 0);
  if (along.lengthSquared() < 1e-6) along.set(1, 0, 0);
  along.normalize();
  return [first.subtract(along.scale(STRIP_REACH)), ...points, last.add(along.scale(STRIP_REACH))];
}

export { routeTargets, routeFolderHues, routeRuns, runLine };
