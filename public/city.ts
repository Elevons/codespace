import { S, V3, FILE_SIZE, FILE_H, TILE_GAP, MARGIN, PLATE_H, FLOOR_STEP, AREA_PER_WEIGHT, isCode, inScene, layerRank, linesOf, renderEdges, filePath, hiddenByExtras } from "./state.js";
import { ancestorFolders } from "./filter.js";
import { syncMeshes } from "./meshes.js";
import type { Entry, GraphNode } from "./types.js";

// Lays out the whole tree as a treemap, then hands it to the shapes on screen.
function build(): void
{
  S.boxes.length = 0;
  S.NODES.forEach((n, i) =>
  {
    n.index = i;
    n.children = n.children || [];
    n.parent = null;
  });
  for (const n of S.NODES) for (const child of n.children) child.parent = n;

  const root = S.NODES.find((n) => n.id === "");
  if (!root) return;

  // Folders that hold a file whose own eye brings it back stay open, so that file can still be drawn.
  keptOpen.clear();
  for (const path of S.outliner.shownFiles) for (const folder of ancestorFolders(path)) keptOpen.add(folder);
  markHidden(root, false);
  liveLayers.clear();
  weighNode(root);
  S.shownLayers = S.LAYERS.filter((layer) => liveLayers.has(layer));
  const area = Math.max(root.weight ?? 0, 1) * AREA_PER_WEIGHT;
  const width = Math.sqrt(area * 1.5);
  placeNode(root, { x: -width / 2, z: -area / width / 2, w: width, d: area / width }, 0);
  syncMeshes();
  renderEdges();
}

// Re-stacks the boxes when the spread slider moves the layer gap. Only a file's height depends on
// the gap, never the treemap or a folder, so this skips the layout, the tiles, and every folder:
// the boxes follow the slider at once, and their rings, threads, and labels follow them. `snap`
// false moves only the resting heights, so leaving the concept view can glide back instead.
function restack(snap = true): void
{
  const layered = S.LAYERS.length > 0;
  for (const b of S.boxes)
  {
    const layer = layered ? S.FILE_LAYERS.get(b.path) : undefined;
    const rank = layer === undefined ? -1 : layerRank(layer);
    const topY = S.NODES[b.node]?.topY ?? 0;
    const baseY = rank < 0 ? topY : Math.max(topY, rank * S.layerGap);
    b.terrace.y = baseY + b.terraceSize.y / 2;
    const rec = S.fileRecords.get(b.path);
    if (!rec) continue;
    rec.terrace.y = b.terrace.y;
    rec.target.y = b.terrace.y;
    // The slider should feel attached to the boxes, so a box at rest takes its new height at once.
    // A box lifted onto a shown route's lane glides instead, since that lane is not its resting spot.
    if (snap && (S.trace === null || !S.trace.trace || !S.trace.set.has(b.path))) rec.shape.position.y = b.terrace.y;
  }
  S.shownLayers.forEach((_name, index) =>
  {
    const plane = S.layerPlanes[index];
    if (plane) plane.position.y = index * S.layerGap;
  });
  S.dirty = true;
  S.edgesDirty = true;
}

// The layers that hold at least one drawn file, gathered while the folders are weighed.
const liveLayers = new Set<string>();

// Folders above a file that is shown on its own, despite a hidden folder around it.
const keptOpen = new Set<string>();

// Marks each folder hidden if it, or any folder above it, is in the hidden set, unless it holds
// a file shown on its own; the files' own visibility then decides what is drawn inside it.
function markHidden(n: GraphNode, parentHidden: boolean): void
{
  n.hidden = (parentHidden || S.hiddenFolders.has(n.id) || hiddenByExtras(n.id)) && !keptOpen.has(n.id);
  for (const child of n.children) markHidden(child, n.hidden);
}

// Lists what each folder holds (its visible subfolders and its files) and how much floor
// the whole folder asks for: one unit per file, the subfolders' own, and room for the
// folder's margin, which grows with the edge of what it holds.
function weighNode(n: GraphNode): void
{
  n.entries = [];
  for (const child of n.children)
  {
    if (child.hidden) continue;
    weighNode(child);
    // A folder with nothing left to draw drops out, so a filter shows only what is relevant to it.
    if (child.entries!.length === 0) { child.hidden = true; continue; }
    n.entries.push({ dir: child, weight: child.weight ?? 0, x: 0, z: 0, w: 0, d: 0 });
  }
  n.files.forEach((_name, fileIndex) =>
  {
    const path = filePath(n.index!, fileIndex);
    // An eye in the outliner hides a file, its system, its layer, or its folder from the scene,
    // and a filter chip keeps only the files that match it.
    if (!inScene(path)) return;
    const layer = S.FILE_LAYERS.get(path);
    if (layer !== undefined) liveLayers.add(layer);
    n.entries!.push({ fileIndex, path, weight: 1, x: 0, z: 0, w: 0, d: 0 });
  });
  const held = n.entries.reduce((sum, entry) => sum + entry.weight, 0);
  n.weight = held + 1.6 * Math.sqrt(held) + 1;
}

// The worst aspect ratio in a row of areas laid along a side of the given length.
function worstAspect(areas: number[], sum: number, side: number): number
{
  const thickness = sum / side;
  let worst = 1;
  for (const area of areas) worst = Math.max(worst, area / (thickness * thickness), (thickness * thickness) / area);
  return worst;
}

// Squarified treemap: splits the rectangle among the entries by weight, largest first,
// adding to a row while that keeps its tiles closer to square. Sets x, z, w, d on each entry.
function squarify(entries: Entry[], x: number, z: number, w: number, d: number): void
{
  const items = [...entries].sort((a, b) => b.weight - a.weight);
  const total = items.reduce((sum, item) => sum + item.weight, 0);
  if (total <= 0 || w <= 0 || d <= 0) return;
  const scale = (w * d) / total;
  let start = 0;
  while (start < items.length)
  {
    const side = Math.min(w, d);
    const areas: number[] = [];
    let sum = 0, worst = Infinity;
    while (start + areas.length < items.length)
    {
      const area = items[start + areas.length].weight * scale;
      const nextWorst = worstAspect([...areas, area], sum + area, side);
      if (areas.length > 0 && nextWorst > worst) break;
      areas.push(area);
      sum += area;
      worst = nextWorst;
    }

    // Lay the row along the short side; it takes `thickness` off the rectangle.
    const thickness = sum / side;
    let cursor = w >= d ? z : x;
    areas.forEach((area, k) =>
    {
      const item = items[start + k], length = area / thickness;
      if (w >= d) { item.x = x; item.z = cursor; item.w = thickness; item.d = length; }
      else { item.x = cursor; item.z = z; item.w = length; item.d = thickness; }
      cursor += length;
    });
    if (w >= d) { x += thickness; w -= thickness; }
    else { z += thickness; d -= thickness; }
    start += areas.length;
  }
}

// Places a folder's tile in its rectangle, and inside it a treemap of its subfolders and
// file boxes. Nesting reads on the floor: each level is a tile laid on its parent, one thin
// step higher. Every file box has the same footprint, centred in its cell; its height is the
// line count, and it rises to its layer's plane when layers are declared.
function placeNode(n: GraphNode, rect: { x: number; z: number; w: number; d: number }, level: number): void
{
  if (n.hidden) return;
  const layered = S.LAYERS.length > 0;
  n.level = level;
  n.cx = rect.x + rect.w / 2;
  n.cz = rect.z + rect.d / 2;
  n.tileW = rect.w;
  n.tileD = rect.d;
  n.baseY = 0;
  n.topY = PLATE_H + level * FLOOR_STEP;

  const pad = Math.min(MARGIN, 0.15 * Math.min(rect.w, rect.d));
  squarify(n.entries!, rect.x + pad, rect.z + pad, rect.w - pad * 2, rect.d - pad * 2);
  for (const entry of n.entries!)
  {
    if (entry.dir)
    {
      // Sibling tiles are pulled apart by a gap, so their outlines never touch.
      const gap = Math.min(TILE_GAP, 0.15 * Math.min(entry.w, entry.d));
      placeNode(entry.dir, { x: entry.x + gap / 2, z: entry.z + gap / 2, w: entry.w - gap, d: entry.d - gap }, level + 1);
      continue;
    }
    const height = isCode(entry.path!) ? Math.min(1.8, 0.22 + linesOf(entry.path!) / 260) : FILE_H * 0.6;
    const layerIndex = layered && S.FILE_LAYERS.has(entry.path!) ? layerRank(S.FILE_LAYERS.get(entry.path!)!) : -1;
    const baseY = layerIndex >= 0 ? Math.max(n.topY!, layerIndex * S.layerGap) : n.topY!;
    const side = Math.min(FILE_SIZE, Math.min(entry.w, entry.d) - 0.2);
    S.boxes.push({
      path: entry.path!, node: n.index!, file: entry.fileIndex!,
      terrace: new V3(entry.x + entry.w / 2, baseY + height / 2, entry.z + entry.d / 2),
      terraceSize: new V3(side, height, side),
    });
  }
}

export { build, restack };
