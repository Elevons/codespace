// The map's pure layout, colour, visibility, and picking rules, kept free of the scene, the DOM,
// and the mutable world so they can be tested under node. The state wraps these with its own data.

import { ancestorFolders } from "./filter.js";

interface IVectorLike
{
  x: number
  y: number
  z: number
}

export function folderOf(path: string): string
{
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function labelFor(layer: string): string
{
  return layer.replace(/[-_]+/g, " ");
}

const FOLDER_HUES = ["#58a6ff", "#d2a8ff", "#ffa657", "#56d4dd", "#e3b341", "#f778ba", "#7ee787", "#ff7b72"];

// A steady colour for the folder a path lives in, so neighbours read as one group.
export function folderColor(path: string): string
{
  const folder = folderOf(path);
  let hash = 0;
  for (const ch of folder) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_HUES[hash % FOLDER_HUES.length];
}

export function layerRank(layer: string, shownLayers: readonly string[]): number
{
  return shownLayers.indexOf(layer);
}

interface IVisibilityState
{
  shownFiles: ReadonlySet<string>
  hiddenFiles: ReadonlySet<string>
  hiddenFolders: ReadonlySet<string>
  extrasShown: boolean
  hiddenByExtras: (folder: string) => boolean
}

export function isFileVisible(path: string, state: IVisibilityState): boolean
{
  // A file's own eye wins over its folder, so any file can be brought back.
  if (state.shownFiles.has(path)) return true;
  if (state.hiddenFiles.has(path)) return false;
  // Loose top-level files (readme, package files) count as extras.
  if (!state.extrasShown && !path.includes("/")) return false;
  // Every folder above the file, and the root itself, must be open.
  for (const dir of [...ancestorFolders(path), ""])
  {
    if (state.hiddenFolders.has(dir) || state.hiddenByExtras(dir)) return false;
  }
  return true;
}

export function nodeMatchesFilters(filePaths: readonly string[], matches: (path: string) => boolean): boolean
{
  return filePaths.some(matches);
}

export function rayBox(o: IVectorLike, d: IVectorLike, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): number | null
{
  let near = -Infinity, far = Infinity;
  const slab = (origin: number, dir: number, lo: number, hi: number): boolean =>
  {
    if (Math.abs(dir) < 1e-9) return origin >= lo && origin <= hi;
    let t1 = (lo - origin) / dir, t2 = (hi - origin) / dir;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    near = Math.max(near, t1); far = Math.min(far, t2);
    return far >= near;
  };
  if (!slab(o.x, d.x, minX, maxX) || !slab(o.y, d.y, minY, maxY) || !slab(o.z, d.z, minZ, maxZ)) return null;
  return far < 0 ? null : near;
}

/* ------------------------------------------------ concept spine layout ---- */

export interface IConceptLayoutInput
{
  center: { x: number; z: number }
  files: readonly { path: string; y: number }[]
  data: Record<string, { layer?: string; files?: readonly string[] }>
  operations: Record<string, { files: readonly string[]; reads: readonly string[]; writes: readonly string[]; steps?: readonly { files: readonly string[] }[] }>
  unmappedName: string
}

export interface IConceptOpSpot
{
  name: string
  x: number
  z: number
  radius: number
  files: string[]
  bank: "top" | "bottom" | "tray"
  unmapped: boolean
  index: number
}

export interface IConceptDataSpot
{
  name: string
  x: number
  z: number
  dockedTo: string | null
  spineIndex: number
  files: string[]
  radius: number
}

export interface IConceptRoute
{
  op: string
  datum: string
  kind: "reads" | "writes"
  docked: boolean
  track: number
  points: { x: number; z: number }[]
}

export interface IConceptSpineLayout
{
  operations: IConceptOpSpot[]
  data: IConceptDataSpot[]
  home: Map<string, { x: number; y: number; z: number }>
  spine: { minX: number; maxX: number; z: number; halfDepth: number } | null
  tray: { x: number; z: number; width: number; depth: number } | null
  routes: IConceptRoute[]
}

const CUBE_STEP = 0.6;
const HEX_CLEARANCE = 0.9;
const LANE_GAP = 0.25;
const CORNER_RADIUS = 0.36;

// Packs a column's files onto a centred grid so cubes line up cleanly inside their sleeve.
function gridPack(count: number): { offsets: { dx: number; dz: number }[]; radius: number }
{
  if (count === 0) return { offsets: [], radius: 0.85 };
  const cols = Math.ceil(Math.sqrt(count));
  const rows = Math.ceil(count / cols);
  const offsets: { dx: number; dz: number }[] = [];
  let maxDist = 0;
  for (let k = 0; k < count; k++)
  {
    const row = Math.floor(k / cols);
    const inRow = Math.min(cols, count - row * cols);
    const col = k - row * cols;
    const dx = (col - (inRow - 1) / 2) * CUBE_STEP;
    const dz = (row - (rows - 1) / 2) * CUBE_STEP;
    offsets.push({ dx, dz });
    maxDist = Math.max(maxDist, Math.hypot(dx, dz));
  }
  return { offsets, radius: Math.max(0.95, maxDist + 0.58) };
}

// Orders shared spine data from upstream inputs on the left to downstream outputs on the right.
function orderSpineData(
  names: readonly string[],
  operations: Record<string, { reads: readonly string[]; writes: readonly string[] }>): string[]
{
  const spineSet = new Set(names);
  const decl = new Map(names.map((name, i) => [name, i]));
  const flow = new Map<string, Map<string, number>>();
  const writesCount = new Map<string, number>();
  const readsCount = new Map<string, number>();
  for (const name of names) { flow.set(name, new Map()); writesCount.set(name, 0); readsCount.set(name, 0); }

  for (const op of Object.values(operations))
  {
    const reads = [...new Set(op.reads)].filter((n) => spineSet.has(n));
    const writes = [...new Set(op.writes)].filter((n) => spineSet.has(n));
    for (const r of reads) readsCount.set(r, (readsCount.get(r) ?? 0) + 1);
    for (const w of writes) writesCount.set(w, (writesCount.get(w) ?? 0) + 1);
    for (const r of reads)
      for (const w of writes)
        if (r !== w) flow.get(r)!.set(w, (flow.get(r)!.get(w) ?? 0) + 1);
  }

  const netOut = new Map<string, number>();
  for (const a of names)
  {
    let outSum = 0, inSum = 0;
    for (const b of names)
    {
      outSum += flow.get(a)!.get(b) ?? 0;
      inSum += flow.get(b)!.get(a) ?? 0;
    }
    netOut.set(a, outSum - inSum);
  }

  const remaining = new Set(names);
  const ordered: string[] = [];
  while (remaining.size > 0)
  {
    let best = "";
    let bestIn = Infinity, bestSource = Infinity, bestNet = -Infinity, bestDecl = Infinity;
    for (const candidate of remaining)
    {
      let incoming = 0;
      for (const other of remaining) incoming += flow.get(other)!.get(candidate) ?? 0;
      const sourceRank = writesCount.get(candidate) === 0 && (readsCount.get(candidate) ?? 0) > 0 ? 0 : 1;
      const net = netOut.get(candidate) ?? 0;
      const idx = decl.get(candidate) ?? 0;
      if (
        incoming < bestIn ||
        (incoming === bestIn && sourceRank < bestSource) ||
        (incoming === bestIn && sourceRank === bestSource && net > bestNet) ||
        (incoming === bestIn && sourceRank === bestSource && net === bestNet && idx < bestDecl))
      {
        best = candidate; bestIn = incoming; bestSource = sourceRank; bestNet = net; bestDecl = idx;
      }
    }
    ordered.push(best);
    remaining.delete(best);
  }
  return ordered;
}

// Places non-overlapping horizontal spans onto parallel bus lanes, shortest inner runs first.
function assignChannelLanes(spans: readonly { id: number; minX: number; maxX: number }[]): { lanes: Map<number, number>; count: number }
{
  const sorted = [...spans].sort((a, b) => (a.maxX - a.minX) - (b.maxX - b.minX) || a.minX - b.minX);
  const tracks: { minX: number; maxX: number }[][] = [];
  const lanes = new Map<number, number>();
  for (const span of sorted)
  {
    if (span.maxX - span.minX < 0.06) { lanes.set(span.id, 0); continue; }
    const padMin = span.minX - 0.16, padMax = span.maxX + 0.16;
    let chosen = -1;
    for (let i = 0; i < tracks.length; i++)
    {
      if (tracks[i].every((other) => padMax < other.minX || padMin > other.maxX)) { chosen = i; break; }
    }
    if (chosen < 0) { chosen = tracks.length; tracks.push([]); }
    tracks[chosen].push({ minX: padMin, maxX: padMax });
    lanes.set(span.id, chosen);
  }
  return { lanes, count: tracks.length };
}

// Turns sharp orthogonal corners into short quarter-circle arcs so bus tracks read smoothly.
function roundOrthogonalCorners(raw: readonly { x: number; z: number }[]): { x: number; z: number }[]
{
  const clean: { x: number; z: number }[] = [];
  for (const p of raw)
    if (clean.length === 0 || Math.hypot(p.x - clean[clean.length - 1].x, p.z - clean[clean.length - 1].z) > 1e-3)
      clean.push(p);
  if (clean.length <= 2) return clean;

  const out: { x: number; z: number }[] = [clean[0]];
  for (let i = 1; i < clean.length - 1; i++)
  {
    const prev = clean[i - 1], curr = clean[i], next = clean[i + 1];
    const inDx = curr.x - prev.x, inDz = curr.z - prev.z;
    const outDx = next.x - curr.x, outDz = next.z - curr.z;
    const inLen = Math.hypot(inDx, inDz), outLen = Math.hypot(outDx, outDz);
    const cross = Math.abs(inDx * outDz - inDz * outDx);
    if (inLen < 1e-3 || outLen < 1e-3 || cross < 1e-3) continue;

    const r = Math.min(CORNER_RADIUS, inLen * 0.45, outLen * 0.45);
    if (r < 0.03) { out.push(curr); continue; }
    const ux = inDx / inLen, uz = inDz / inLen;
    const vx = outDx / outLen, vz = outDz / outLen;
    const startX = curr.x - ux * r, startZ = curr.z - uz * r;
    const centerX = startX + vx * r, centerZ = startZ + vz * r;
    const steps = 4;
    for (let s = 0; s <= steps; s++)
    {
      const angle = (s / steps) * (Math.PI / 2);
      const ca = Math.cos(angle), sa = Math.sin(angle);
      out.push({ x: centerX - vx * r * ca + ux * r * sa, z: centerZ - vz * r * ca + uz * r * sa });
    }
  }
  out.push(clean[clean.length - 1]);
  return out;
}

// Lays out operations in two banks flanking a central shared-state spine, docks single-owner data
// beside their parent column, quarantines unmapped files in a corner tray, and routes orthogonal bus tracks.
// A data entry's files stand under its hexagon, except one an operation names that would leave that operation
// with no file of its own: that one stays in the operation's column so no column draws empty.
export function conceptDataClaims(
  data: Record<string, { files?: readonly string[] }>,
  ops: readonly { name: string; files: readonly string[]; steps: readonly { files: readonly string[] }[] }[],
  known: ReadonlySet<string>): Map<string, string>
{
  const naming = new Map<string, string[]>();
  const remaining = new Map<string, number>();
  for (const op of ops)
  {
    const own = new Set([...op.files, ...op.steps.flatMap((step) => step.files)].filter((path) => known.has(path)));
    remaining.set(op.name, own.size);
    for (const path of own) naming.set(path, [...(naming.get(path) ?? []), op.name]);
  }
  const claims = new Map<string, string>();
  for (const [datum, entry] of Object.entries(data))
    for (const path of entry.files ?? [])
    {
      if (!known.has(path) || claims.has(path)) continue;
      const names = naming.get(path) ?? [];
      if (names.some((name) => remaining.get(name)! <= 1)) continue;
      claims.set(path, datum);
      for (const name of names) remaining.set(name, remaining.get(name)! - 1);
    }
  return claims;
}

// A file stands in one column, so a file several operations name goes to the one whose steps cite it most
// (the smaller operation on a tie); then an operation left with no file of its own takes one back from the
// biggest column that shares it, so no operation draws as an empty column.
export function conceptFileOwners(ops: readonly { name: string; files: readonly string[]; steps: readonly { files: readonly string[] }[] }[]): Map<string, string>
{
  const cites = new Map<string, Map<string, number>>();
  for (const op of ops)
  {
    const counts = new Map<string, number>();
    for (const step of op.steps) for (const path of step.files) counts.set(path, (counts.get(path) ?? 0) + 1);
    cites.set(op.name, counts);
  }
  const size = new Map(ops.map((op) => [op.name, new Set(op.files).size]));
  const owner = new Map<string, string>();
  const paths = [...new Set(ops.flatMap((op) => op.files))];
  for (const path of paths)
  {
    let best: string | null = null, bestCites = -1, bestSize = Infinity;
    for (const op of ops)
    {
      if (!op.files.includes(path)) continue;
      const count = cites.get(op.name)!.get(path) ?? 0, opSize = size.get(op.name)!;
      if (count > bestCites || (count === bestCites && opSize < bestSize)) { best = op.name; bestCites = count; bestSize = opSize; }
    }
    if (best !== null) owner.set(path, best);
  }
  const owned = new Map<string, number>(ops.map((op) => [op.name, 0]));
  for (const name of owner.values()) owned.set(name, owned.get(name)! + 1);
  for (const op of ops)
  {
    if (owned.get(op.name)! > 0) continue;
    let pick: string | null = null, from = 1;
    for (const path of op.files)
    {
      const holder = owner.get(path)!, count = owned.get(holder)!;
      if (count > from) { pick = path; from = count; }
    }
    if (pick === null) continue;
    owned.set(owner.get(pick)!, from - 1);
    owner.set(pick, op.name);
    owned.set(op.name, 1);
  }
  return owner;
}

export function conceptSpineLayout(input: IConceptLayoutInput): IConceptSpineLayout
{
  const known = new Map<string, number>();
  for (const file of input.files) known.set(file.path, file.y);

  const opEntries = Object.entries(input.operations);
  const claims = conceptDataClaims(input.data, opEntries.map(([name, op]) => ({ name, files: op.files, steps: op.steps ?? [] })), new Set(known.keys()));
  const owner = conceptFileOwners(opEntries.map(([name, op]) => ({
    name,
    files: op.files.filter((path) => known.has(path) && !claims.has(path)),
    steps: (op.steps ?? []).map((step) => ({ files: step.files.filter((path) => !claims.has(path)) })),
  })));
  for (const path of claims.keys()) owner.set(path, "\u0000thing");
  const dataPacks = new Map<string, { files: string[]; offsets: { dx: number; dz: number }[]; radius: number }>();

  const sortFiles = (paths: string[]): string[] =>
    paths.sort((a, b) => (known.get(a)! - known.get(b)!) || a.localeCompare(b));

  const dataNames = Object.keys(input.data);
  for (const name of dataNames)
  {
    const files = sortFiles([...claims.entries()].filter(([, datum]) => datum === name).map(([path]) => path));
    const { offsets, radius } = gridPack(files.length);
    dataPacks.set(name, { files, offsets, radius: files.length === 0 ? 0.6 : radius });
  }
  const dataWidth = (name: string): number => Math.max(1.85, dataPacks.get(name)!.radius * 2 + 0.7);
  const dockedByOp = new Map<string, string[]>();
  for (const [name] of opEntries) dockedByOp.set(name, []);
  const spineCandidates: string[] = [];
  for (const dataName of dataNames)
  {
    const touching = opEntries
      .filter(([, op]) => op.reads.includes(dataName) || op.writes.includes(dataName))
      .map(([opName]) => opName);
    if (touching.length === 1) dockedByOp.get(touching[0])!.push(dataName);
    else spineCandidates.push(dataName);
  }

  const orderedSpine = orderSpineData(spineCandidates, input.operations);
  const spineIndexMap = new Map(orderedSpine.map((name, i) => [name, i]));
  const spineCount = orderedSpine.length;

  interface OpDraft
  {
    name: string;
    index: number;
    files: string[];
    offsets: { dx: number; dz: number }[];
    radius: number;
    halfW: number;
    baryX: number;
    bankScore: number;
    x: number;
    z: number;
    bank: "top" | "bottom" | "tray";
    unmapped: boolean;
  }

  const drafts: OpDraft[] = opEntries.map(([name, op], index) =>
  {
    const files = sortFiles([...owner.keys()].filter((path) => owner.get(path) === name));
    const { offsets, radius } = gridPack(files.length);
    const dockedWidth = (dockedByOp.get(name) ?? []).reduce((sum, datum) => sum + dataWidth(datum), 0);
    const halfW = Math.max(radius, dockedWidth > 1.85 ? dockedWidth / 2 : 0);

    let xSum = 0, wSum = 0;
    for (const r of new Set(op.reads))
      if (spineIndexMap.has(r)) { xSum += spineIndexMap.get(r)!; wSum += 1; }
    for (const w of new Set(op.writes))
      if (spineIndexMap.has(w)) { xSum += spineIndexMap.get(w)! * 1.5; wSum += 1.5; }
    const baryX = wSum > 0 ? xSum / wSum : (spineCount - 1) / 2;

    const sw = [...new Set(op.writes)].map((w) => spineIndexMap.get(w)).filter((v): v is number => v !== undefined);
    const writeRole = sw.length === 0 ? 2 : (sw.reduce((a, b) => a + b, 0) / sw.length) / Math.max(1, spineCount - 1);
    const meanY = files.length > 0 ? files.reduce((sum, path) => sum + known.get(path)!, 0) / files.length : 0;
    return { name, index, files, offsets, radius, halfW, baryX, bankScore: writeRole + meanY * 1e-3, x: 0, z: 0, bank: "top", unmapped: false };
  });

  let bottomBank: OpDraft[] = [];
  let topBank: OpDraft[] = [];
  if (drafts.length <= 1) topBank = [...drafts];
  else
  {
    const byBank = [...drafts].sort((a, b) => (a.bankScore - b.bankScore) || (a.index - b.index));
    const bottomCount = Math.floor(byBank.length / 2);
    bottomBank = byBank.slice(0, bottomCount);
    topBank = byBank.slice(bottomCount);
  }
  bottomBank.sort((a, b) => (a.baryX - b.baryX) || (a.index - b.index));
  topBank.sort((a, b) => (a.baryX - b.baryX) || (a.index - b.index));
  for (const d of bottomBank) d.bank = "bottom";
  for (const d of topBank) d.bank = "top";

  const looseFiles = sortFiles(input.files.map((f) => f.path).filter((path) => !owner.has(path)));
  let trayDraft: OpDraft | null = null;
  if (looseFiles.length > 0)
  {
    const { offsets, radius } = gridPack(looseFiles.length);
    trayDraft = {
      name: input.unmappedName, index: -1, files: looseFiles, offsets, radius, halfW: radius,
      baryX: 0, bankScore: 0, x: 0, z: 0, bank: "tray", unmapped: true,
    };
  }

  const placeRowX = (row: OpDraft[], extraRight: OpDraft | null): number =>
  {
    if (row.length === 0 && !extraRight) return 0;
    const xs: number[] = [];
    let cursor = 0;
    row.forEach((item, i) =>
    {
      if (i > 0) cursor += Math.max(4.1, row[i - 1].halfW + item.halfW + 1.65);
      xs.push(cursor);
    });
    let trayX = 0;
    if (extraRight)
    {
      trayX = row.length > 0
        ? cursor + row[row.length - 1].halfW + extraRight.halfW + 2.5
        : 0;
    }
    const leftEdge = row.length > 0 ? xs[0] - row[0].halfW : trayX - extraRight!.halfW;
    const rightEdge = extraRight ? trayX + extraRight.halfW : xs[xs.length - 1] + row[row.length - 1].halfW;
    const mid = (leftEdge + rightEdge) / 2;
    row.forEach((item, i) => { item.x = input.center.x + xs[i] - mid; });
    if (extraRight) extraRight.x = input.center.x + trayX - mid;
    return rightEdge - leftEdge;
  };

  const topSpan = placeRowX(topBank, null);
  const bottomSpan = placeRowX(bottomBank, trayDraft);
  const spineR = orderedSpine.reduce((m, name) => Math.max(m, dataPacks.get(name)!.radius), 0.6);
  const spineStep = Math.max(4.5, spineR * 2 + 1);
  const minSpineSpan = Math.max(0, (spineCount - 1) * spineStep);
  const activeSpan = Math.max(topSpan, bottomSpan, minSpineSpan);
  const spineSpan = spineCount <= 1 ? 0 : Math.max(minSpineSpan, activeSpan * 0.68);

  const spineSpots = new Map<string, IConceptDataSpot>();
  orderedSpine.forEach((name, i) =>
  {
    const x = spineCount === 1
      ? input.center.x
      : input.center.x - spineSpan / 2 + (i / (spineCount - 1)) * spineSpan;
    spineSpots.set(name, { name, x, z: input.center.z, dockedTo: null, spineIndex: i, files: dataPacks.get(name)!.files, radius: dataPacks.get(name)!.radius });
  });

  // Plan spine links per bank in X first so horizontal lane counts set the exact spine corridor depth.
  interface PendingSpineLink
  {
    id: number;
    op: OpDraft;
    datum: IConceptDataSpot;
    kind: "reads" | "writes";
    portDx: number;
    portX: number;
    endX: number;
    lane: number;
  }

  const planBankSpineLinks = (bank: OpDraft[]): { links: PendingSpineLink[]; laneCount: number } =>
  {
    const links: PendingSpineLink[] = [];
    for (const opDraft of bank)
    {
      const op = input.operations[opDraft.name];
      if (!op) continue;
      const mine: { datum: IConceptDataSpot; kind: "reads" | "writes" }[] = [];
      for (const kind of ["writes", "reads"] as const)
        for (const tName of new Set(op[kind]))
        {
          const spot = spineSpots.get(tName);
          if (spot) mine.push({ datum: spot, kind });
        }
      mine.sort((a, b) => (a.datum.x - b.datum.x) || (a.kind === "writes" ? -1 : 1));
      const portStep = Math.min(0.28, (opDraft.radius * 1.25) / Math.max(1, mine.length));
      mine.forEach((entry, idx) =>
      {
        const portDx = (idx - (mine.length - 1) / 2) * portStep;
        links.push({
          id: links.length, op: opDraft, datum: entry.datum, kind: entry.kind,
          portDx, portX: opDraft.x + portDx, endX: entry.datum.x, lane: 0,
        });
      });
    }

    for (const dataSpot of spineSpots.values())
    {
      const arriving = links.filter((l) => l.datum.name === dataSpot.name);
      arriving.sort((a, b) => (a.portX - b.portX) || (a.kind === "writes" ? -1 : 1));
      const endStep = Math.min(0.22, 0.84 / Math.max(1, arriving.length));
      arriving.forEach((l, idx) => { l.endX = dataSpot.x + (idx - (arriving.length - 1) / 2) * endStep; });
    }

    const { lanes, count } = assignChannelLanes(links.map((l) => ({
      id: l.id, minX: Math.min(l.portX, l.endX), maxX: Math.max(l.portX, l.endX),
    })));
    for (const l of links) l.lane = lanes.get(l.id) ?? 0;
    return { links, laneCount: count };
  };

  const topPlan = planBankSpineLinks(topBank);
  const bottomPlan = planBankSpineLinks(bottomBank);
  const maxLanes = Math.max(topPlan.laneCount, bottomPlan.laneCount);
  const spineClear = Math.max(HEX_CLEARANCE, spineR + 0.3);
  const halfDepth = spineCount > 0 ? Math.max(1.6, spineClear + maxLanes * LANE_GAP + 0.38) : 0.5;

  const maxTopR = topBank.reduce((m, d) => Math.max(m, d.radius), 1);
  const maxBotR = [...bottomBank, ...(trayDraft ? [trayDraft] : [])].reduce((m, d) => Math.max(m, d.radius), 1);
  const hasTwoSides = spineCount > 0 || (topBank.length > 0 && (bottomBank.length > 0 || trayDraft !== null));
  const topZ = input.center.z + (hasTwoSides ? halfDepth + maxTopR + 1.55 : 0);
  const bottomZ = input.center.z - (halfDepth + maxBotR + 1.55);

  for (const d of topBank) d.z = topZ;
  for (const d of bottomBank) d.z = bottomZ;
  if (trayDraft) trayDraft.z = bottomBank.length > 0 ? bottomZ : input.center.z;

  const allOpDrafts = [...drafts, ...(trayDraft ? [trayDraft] : [])];
  const home = new Map<string, { x: number; y: number; z: number }>();
  for (const d of allOpDrafts)
    d.files.forEach((path, k) =>
    {
      const off = d.offsets[k];
      home.set(path, { x: d.x + off.dx, y: known.get(path)!, z: d.z + off.dz });
    });

  // Place single-owner docked data on the outer side of their parent column, away from the spine.
  const dockedSpots = new Map<string, IConceptDataSpot>();
  for (const d of drafts)
  {
    const list = dockedByOp.get(d.name) ?? [];
    if (list.length === 0) continue;
    const bankSign = d.bank === "bottom" ? -1 : 1;
    const total = list.reduce((sum, datum) => sum + dataWidth(datum), 0);
    let cursor = d.x - total / 2;
    for (const tName of list)
    {
      const pack = dataPacks.get(tName)!;
      const width = dataWidth(tName);
      const z = d.z + bankSign * (d.radius + 0.65 + Math.max(0.6, pack.radius));
      dockedSpots.set(tName, { name: tName, x: cursor + width / 2, z, dockedTo: d.name, spineIndex: -1, files: pack.files, radius: pack.radius });
      cursor += width;
    }
  }

  const routes: IConceptRoute[] = [];
  let trackCounter = 0;

  const emitBankRoutes = (plan: PendingSpineLink[], bankSign: 1 | -1): void =>
  {
    for (const l of plan)
    {
      const rimDz = Math.sqrt(Math.max(0.05, l.op.radius * l.op.radius - l.portDx * l.portDx));
      const startZ = l.op.z - bankSign * rimDz;
      const laneZ = input.center.z + bankSign * (spineClear + l.lane * LANE_GAP);
      const endZ = input.center.z + bankSign * 0.58;
      const waypoints = Math.abs(l.portX - l.endX) < 0.06
        ? [{ x: l.endX, z: startZ }, { x: l.endX, z: endZ }]
        : [{ x: l.portX, z: startZ }, { x: l.portX, z: laneZ }, { x: l.endX, z: laneZ }, { x: l.endX, z: endZ }];
      routes.push({
        op: l.op.name, datum: l.datum.name, kind: l.kind, docked: false,
        track: trackCounter++, points: roundOrthogonalCorners(waypoints),
      });
    }
  };
  emitBankRoutes(topPlan.links, 1);
  emitBankRoutes(bottomPlan.links, -1);

  for (const d of drafts)
  {
    const op = input.operations[d.name];
    if (!op) continue;
    const bankSign = d.bank === "bottom" ? -1 : 1;
    for (const tName of dockedByOp.get(d.name) ?? [])
    {
      const spot = dockedSpots.get(tName)!;
      const hasRead = op.reads.includes(tName), hasWrite = op.writes.includes(tName);
      const both = hasRead && hasWrite;
      for (const kind of ["writes", "reads"] as const)
      {
        if ((kind === "reads" && !hasRead) || (kind === "writes" && !hasWrite)) continue;
        const side = both ? (kind === "writes" ? -0.14 : 0.14) : 0;
        const endX = spot.x + side;
        const clampedDx = Math.max(-d.radius * 0.85, Math.min(d.radius * 0.85, (spot.x - d.x) * 0.35 + side));
        const startX = d.x + clampedDx;
        const startZ = d.z + bankSign * Math.sqrt(Math.max(0.05, d.radius * d.radius - clampedDx * clampedDx));
        const endZ = spot.z - bankSign * 0.48;
        const midZ = (startZ + endZ) / 2;
        const waypoints = Math.abs(startX - endX) < 0.05
          ? [{ x: endX, z: startZ }, { x: endX, z: endZ }]
          : [{ x: startX, z: startZ }, { x: startX, z: midZ }, { x: endX, z: midZ }, { x: endX, z: endZ }];
        routes.push({
          op: d.name, datum: tName, kind, docked: true,
          track: 0, points: roundOrthogonalCorners(waypoints),
        });
      }
    }
  }

  let spine: { minX: number; maxX: number; z: number; halfDepth: number } | null = null;
  if (spineCount > 0)
  {
    const margin = Math.max(1.35, spineR + 0.45);
    let minX = input.center.x - spineSpan / 2 - margin;
    let maxX = input.center.x + spineSpan / 2 + margin;
    for (const l of [...topPlan.links, ...bottomPlan.links])
    {
      minX = Math.min(minX, l.portX - 0.6, l.endX - 0.6);
      maxX = Math.max(maxX, l.portX + 0.6, l.endX + 0.6);
    }
    spine = { minX, maxX, z: input.center.z, halfDepth };
  }

  const tray = trayDraft
    ? { x: trayDraft.x, z: trayDraft.z, width: trayDraft.radius * 2 + 1.1, depth: trayDraft.radius * 2 + 1.1 }
    : null;

  const operations: IConceptOpSpot[] = allOpDrafts.map((d) => ({
    name: d.name, x: d.x, z: d.z, radius: d.radius, files: d.files, bank: d.bank, unmapped: d.unmapped, index: d.index,
  }));
  const data: IConceptDataSpot[] = dataNames.map((name) => spineSpots.get(name) ?? dockedSpots.get(name)!);
  for (const spot of data)
  {
    const pack = dataPacks.get(spot.name)!;
    pack.files.forEach((path, k) => home.set(path, { x: spot.x + pack.offsets[k].dx, y: known.get(path)!, z: spot.z + pack.offsets[k].dz }));
  }

  return { operations, data, home, spine, tray, routes };
}

export interface IConceptTraceHop
{
  op: string
  // The steps of this operation whose files include one the data entry holds; empty when none can be matched.
  steps: string[]
}

export interface IConceptTrace
{
  comesFrom: IConceptTraceHop[]
  goesTo: IConceptTraceHop[]
}

// Where a data entry comes from and where it goes: the operations that write it and those that read it,
// each with the step text that touches the entry's own files, so the sheet can say what happens to it there.
export function conceptTrace(
  data: Record<string, { files?: readonly string[] }>,
  operations: Record<string, { reads: readonly string[]; writes: readonly string[]; steps: readonly { text: string; files: readonly string[] }[] }>,
  name: string): IConceptTrace
{
  const held = new Set(data[name]?.files ?? []);
  const hop = (op: string): IConceptTraceHop =>
    ({ op, steps: operations[op]!.steps.filter((step) => step.files.some((path) => held.has(path))).map((step) => step.text) });
  const names = Object.keys(operations);
  return {
    comesFrom: names.filter((op) => operations[op]!.writes.includes(name)).map(hop),
    goesTo: names.filter((op) => operations[op]!.reads.includes(name)).map(hop),
  };
}

export interface IConceptFilterView
{
  filtering: boolean
  operations: Set<string>
  data: Set<string>
  totalOperations: number
  totalData: number
}

// What stays of the design under the outliner's filters: an operation stays when one of its files is still
// drawn, and data stays when a remaining operation reads or writes it. With no filter on, everything stays.
export function conceptFilterView(
  data: Record<string, unknown>,
  operations: Record<string, { files: readonly string[]; reads: readonly string[]; writes: readonly string[]; steps?: readonly { files: readonly string[] }[] }>,
  filtering: boolean,
  drawn: (path: string) => boolean): IConceptFilterView
{
  const names = Object.keys(operations);
  const dataNames = Object.keys(data);
  const view: IConceptFilterView = { filtering, operations: new Set(), data: new Set(), totalOperations: names.length, totalData: dataNames.length };
  if (!filtering)
  {
    for (const name of names) view.operations.add(name);
    for (const name of dataNames) view.data.add(name);
    return view;
  }
  for (const name of names)
  {
    const op = operations[name]!;
    if ([...op.files, ...(op.steps ?? []).flatMap((step) => step.files)].some(drawn))
    {
      view.operations.add(name);
      for (const item of [...op.reads, ...op.writes]) if (item in data) view.data.add(item);
    }
  }
  return view;
}

// Where the camera should aim to hold several points at once: the middle of their box, and a distance far
// enough that the widest side fits the narrower of the screen's two directions.
export function conceptFraming(points: readonly { x: number; y: number; z: number }[], fov: number, aspect: number, minRadius: number): { center: { x: number; y: number; z: number }; radius: number } | null
{
  if (points.length === 0) return null;
  const lo = { x: Infinity, y: Infinity, z: Infinity }, hi = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const p of points)
  {
    lo.x = Math.min(lo.x, p.x); hi.x = Math.max(hi.x, p.x);
    lo.y = Math.min(lo.y, p.y); hi.y = Math.max(hi.y, p.y);
    lo.z = Math.min(lo.z, p.z); hi.z = Math.max(hi.z, p.z);
  }
  const center = { x: (lo.x + hi.x) / 2, y: (lo.y + hi.y) / 2, z: (lo.z + hi.z) / 2 };
  const half = Math.hypot(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z) / 2 + 1.5;
  const reach = Math.tan(fov / 2) * Math.min(1, aspect);
  return { center, radius: Math.max(minRadius, half / Math.max(reach, 0.1)) };
}
