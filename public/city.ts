import { S, V3, FILE_SIZE, FILE_H, TILE_GAP, MARGIN, PLATE_H, FLOOR_STEP, AREA_PER_WEIGHT, isCode, linesOf, render, filePath } from "./state.js";
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

  markHidden(root, false);
  weighNode(root);
  const area = Math.max(root.weight ?? 0, 1) * AREA_PER_WEIGHT;
  const width = Math.sqrt(area * 1.5);
  placeNode(root, { x: -width / 2, z: -area / width / 2, w: width, d: area / width }, 0);
  syncMeshes();
  render();
}

// Marks each folder hidden if it, or any folder above it, is in the hidden set.
function markHidden(n: GraphNode, parentHidden: boolean): void
{
  n.hidden = parentHidden || S.hiddenFolders.has(n.id);
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
    n.entries.push({ dir: child, weight: child.weight ?? 0, x: 0, z: 0, w: 0, d: 0 });
  }
  n.files.forEach((name, fileIndex) =>
  {
    // Loose top-level files (readme, package files) count as extras.
    if (n.id === "" && !S.extrasShown) return;
    n.entries!.push({ fileIndex, path: filePath(n.index!, fileIndex), weight: 1, x: 0, z: 0, w: 0, d: 0 });
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
    const layerIndex = layered && S.FILE_LAYERS.has(entry.path!) ? S.LAYERS.indexOf(S.FILE_LAYERS.get(entry.path!)!) : -1;
    const baseY = layerIndex >= 0 ? Math.max(n.topY!, layerIndex * S.layerGap) : n.topY!;
    const side = Math.min(FILE_SIZE, Math.min(entry.w, entry.d) - 0.2);
    S.boxes.push({
      path: entry.path!, node: n.index!, file: entry.fileIndex!,
      terrace: new V3(entry.x + entry.w / 2, baseY + height / 2, entry.z + entry.d / 2),
      terraceSize: new V3(side, height, side),
    });
  }
}

export { build };
