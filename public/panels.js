import { S, colorFor, labelFor, render } from "./state.js";
import { displayName, shortLabel } from "./repo.js";
/* --------------------------------------------------------------- panels ---- */

// Escapes the characters that would otherwise break the info panel's HTML.
function escapeHtml(text)
{
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

// The repository-relative path of one file within a folder block.
function filePath(nodeIndex, fileIndex)
{
  const n = S.NODES[nodeIndex];
  const file = n.files[fileIndex];
  if (n.id.endsWith(".ts")) return n.id;
  return n.id ? n.id + "/" + file : file;
}

// Chooses one file box: its folder stays chosen, and the info panel names it.
function selectFile(nodeIndex, fileIndex)
{
  select(nodeIndex);
  S.selectedFile = fileIndex;
  render();

  const path = filePath(nodeIndex, fileIndex);
  const uses = S.FILE_EDGES.filter(([from]) => from === path).length;
  const usedBy = S.FILE_EDGES.filter(([, to]) => to === path).length;
  const lines = S.FILE_LINES.get(path);
  const card = document.createElement("div");
  card.className = "chosen-file";
  card.innerHTML =
    '<div class="chosen-name">' + escapeHtml(path.split("/").pop()) + "</div>" +
    '<div class="chosen-meta">' + (lines ? lines + " lines · " : "") +
    "uses " + uses + " · used by " + usedBy + "</div>";
  document.getElementById("info").prepend(card);
}

// The chosen folder and every folder it imports or is imported by.
function neighboursOf(i)
{
  const id = S.NODES[i].id;
  const set = new Set([i]);
  S.EDGES.forEach(([from, to]) =>
  {
    if (from === id) { const j = S.NODES.findIndex((n) => n.id === to); if (j >= 0) set.add(j); }
    if (to === id) { const j = S.NODES.findIndex((n) => n.id === from); if (j >= 0) set.add(j); }
  });
  return set;
}

function select(i)
{
  S.selected = i;
  S.selectedFile = -1;
  S.focusSet = i >= 0 ? neighboursOf(i) : null;
  const info = document.getElementById("info");
  if (i < 0)
  {
    info.innerHTML = '<h3>Click a block</h3><p class="hint">Trace what a folder imports, and what imports it.</p>';
    render();
    return;
  }
  const n = S.NODES[i];
  const outs = S.EDGES.filter((e) => e[0] === n.id).sort((a, b) => b[2] - a[2]);
  const ins = S.EDGES.filter((e) => e[1] === n.id).sort((a, b) => b[2] - a[2]);
  const line = (e, target) => "<li>" + target + '<span class="n">' + e[2] + "</span></li>";
  info.innerHTML =
    "<h3>" + displayName(n.id) + "</h3>" +
    '<div class="layer" style="color:' + colorFor(n.layer) + '">' + labelFor(n.layer) + "</div>" +
    "<h4 class='out'>Imports (" + outs.length + ")</h4>" +
    (outs.length ? "<ul>" + outs.map((e) => line(e, e[1])).join("") + "</ul>" : '<p class="hint">nothing local</p>') +
    "<h4 class='in'>Imported by (" + ins.length + ")</h4>" +
    (ins.length ? "<ul>" + ins.map((e) => line(e, e[0])).join("") + "</ul>" : '<p class="hint">nothing — a top-level entry</p>');
  render();
}

function treeRowHtml(n, depth)
{
  const hidden = S.hiddenFolders.has(n.id);
  let html = '<label class="hrow' + (hidden ? " hidden" : "") + '" style="padding-left:' + (depth * 12) + 'px">' +
    '<input type="checkbox" data-id="' + escapeHtml(n.id) + '"' + (hidden ? "" : " checked") + ">" +
    "<span>" + escapeHtml(shortLabel(n.id)) + "</span></label>";
  for (const child of n.children) html += treeRowHtml(child, depth + 1);
  return html;
}

function renderHierarchy()
{
  const root = S.NODES.find((n) => n.id === "");
  document.getElementById("hierarchy-tree").innerHTML = root ? treeRowHtml(root, 0) : "";
}
// Draws the legend from the layers the live graph actually has, foundation first.
function renderLegend()
{
  const layers = [];
  for (const node of S.NODES) if (!layers.includes(node.layer)) layers.push(node.layer);
  layers.sort((a, b) =>
  {
    const rank = (name) => S.NODES.find((node) => node.layer === name)?.rank ?? 0;
    return rank(a) - rank(b);
  });
  document.getElementById("legend-items").innerHTML = layers.map((name) =>
    '<div class="swatch"><i style="background:' + colorFor(name) + '"></i>' + escapeHtml(labelFor(name)) + "</div>").join("");
}

export { filePath, select, selectFile, renderLegend, renderHierarchy };
