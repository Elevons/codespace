/**
 * The map's pure layout, colour, visibility, and picking rules, kept free of the scene, the DOM,
 * and the mutable world so they can be tested under node. The state wraps these with its own data.
 */

import { ancestorFolders } from "./filter.js";

/** A point or direction the ray rules read, with the same axes as a Babylon vector. */
interface IVectorLike
{
  x: number
  y: number
  z: number
}

/** The folder a path lives in, or "" for the repository root. */
export function folderOf(path: string): string
{
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/** The words shown for one layer in the filter strip. */
export function labelFor(layer: string): string
{
  return layer.replace(/[-_]+/g, " ");
}

/** The colours a folder's boxes cycle through when the map is coloured by folder. */
const FOLDER_HUES = ["#58a6ff", "#d2a8ff", "#ffa657", "#56d4dd", "#e3b341", "#f778ba", "#7ee787", "#ff7b72"];

// A steady colour for the folder a path lives in, so neighbours read as one group.
export function folderColor(path: string): string
{
  const folder = folderOf(path);
  let hash = 0;
  for (const ch of folder) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_HUES[hash % FOLDER_HUES.length];
}

/** A layer's place among the layers that still hold a drawn file, or -1 when it holds none. */
export function layerRank(layer: string, shownLayers: readonly string[]): number
{
  return shownLayers.indexOf(layer);
}

/** What the file's own eyes and its folders say about whether it is drawn at all. */
interface IVisibilityState
{
  /** Files a person brought back with their own eye. */
  shownFiles: ReadonlySet<string>
  /** Files a person hid with their own eye. */
  hiddenFiles: ReadonlySet<string>
  /** Folder ids a person hid, with their subtrees. */
  hiddenFolders: ReadonlySet<string>
  /** Whether the Extras toggle is on. */
  extrasShown: boolean
  /** Whether the Extras toggle hides this folder. */
  hiddenByExtras: (folder: string) => boolean
}

/** Whether a file is hidden from the scene altogether: an eye on its file, or on a folder above it. */
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

/** Whether any of a folder's files passes the current filters. */
export function nodeMatchesFilters(filePaths: readonly string[], matches: (path: string) => boolean): boolean
{
  return filePaths.some(matches);
}

/** A folder node with just what the subtree walk needs, so the pure rules need no scene types. */
interface FolderLike
{
  index?: number
  children: readonly FolderLike[]
}

/** Every node index in a folder's subtree, the folder itself included, gathered for the column view. */
export function subtreeIndices(node: FolderLike, into = new Set<number>()): Set<number>
{
  if (node.index !== undefined) into.add(node.index);
  for (const child of node.children) subtreeIndices(child, into);
  return into;
}

/**
 * Where a ray enters an axis-aligned box, or null if it misses. The slab method, three slabs.
 * @param o the ray's origin
 * @param d the ray's direction
 * @param minX the box's low x
 * @param maxX the box's high x
 * @param minY the box's low y
 * @param maxY the box's high y
 * @param minZ the box's low z
 * @param maxZ the box's high z
 */
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
