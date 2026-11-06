import { S, V3, FILE_W, FILE_D, FILE_H, FILE_GAP, MARGIN, PLATE_H, isCode, linesOf, render } from "./state.js";
import { depthOf } from "./repo.js";
import { filePath } from "./panels.js";
import { syncMeshes } from "./meshes.js";

// Lays out the whole tree for the terraces, then hands it to the shapes on screen.
function build()
{
  S.boxes.length = 0;
  S.NODES.forEach((n, i) =>
  {
    n.index = i;
    n.children = n.children || [];
  });

  const root = S.NODES.find((n) => n.id === "");
  if (!root) return;

  markHidden(root, false);
  measureNode(root);
  placeNode(root, -root.tileW / 2, -root.tileD / 2);
  syncMeshes();
  render();
}

// Marks each folder hidden if it, or any folder above it, is in the hidden set.
function markHidden(n, parentHidden)
{
  n.hidden = parentHidden || S.hiddenFolders.has(n.id);
  for (const child of n.children) markHidden(child, n.hidden);
}

// Works out how big a folder's tile is: its files and subfolders packed together.
function measureNode(n)
{
  n.items = [];
  for (const child of n.children)
  {
    if (child.hidden) continue;
    measureNode(child);
    n.items.push({ dir: child, w: child.tileW, d: child.tileD });
  }
  n.files.forEach((name, fileIndex) =>
  {
    // Loose top-level files (readme, package files) count as extras.
    if (n.id === "" && !S.testsShown) return;
    n.items.push({ name, fileIndex, w: FILE_W, d: FILE_D });
  });
  n.items.sort((a, b) => b.d - a.d || b.w - a.w);

  // Pack the items onto shelves, wrapping when a row grows wide enough.
  const gap = FILE_GAP * 1.6;
  const area = n.items.reduce((sum, item) => sum + item.w * item.d, 0);
  const maxRow = Math.max(FILE_W * 3, Math.sqrt(area) * 1.4);
  let x = 0, z = 0, rowD = 0, usedW = 0;
  for (const item of n.items)
  {
    if (x > 0 && x + item.w > maxRow) { x = 0; z += rowD + gap; rowD = 0; }
    item.x = x; item.z = z;
    x += item.w + gap;
    rowD = Math.max(rowD, item.d);
    usedW = Math.max(usedW, x - gap);
  }
  n.tileW = Math.max(FILE_W + MARGIN * 2, usedW + MARGIN * 2);
  n.tileD = Math.max(FILE_D + MARGIN * 2, z + rowD + MARGIN * 2);
}

// Places a folder's tile at (ox, oz), and inside it its subfolders and file boxes.
// A code file's box is as tall as its line count suggests, so big files stand out.
function placeNode(n, ox, oz)
{
  if (n.hidden) return;
  n.cx = ox + n.tileW / 2;
  n.cz = oz + n.tileD / 2;
  n.baseY = depthOf(n.id) * S.levelGap;

  const innerX = ox + MARGIN, innerZ = oz + MARGIN;
  for (const item of n.items)
  {
    if (item.dir) { placeNode(item.dir, innerX + item.x, innerZ + item.z); continue; }
    const path = filePath(n.index, item.fileIndex);
    const height = isCode(path) ? Math.min(1.8, 0.22 + linesOf(path) / 260) : FILE_H * 0.6;
    S.boxes.push({
      path, node: n.index, file: item.fileIndex, code: isCode(path),
      terrace: new V3(innerX + item.x + FILE_W / 2, n.baseY + PLATE_H + height / 2, innerZ + item.z + FILE_D / 2),
      terraceSize: new V3(FILE_W, height, FILE_D),
    });
  }
}

export { build };
