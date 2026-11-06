import { S, colorFor, colorForTag, labelFor, render, TAG_ORDER } from "./state.js";
import { displayName, labelOf, symbolsOf } from "./repo.js";
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
  return n.id ? n.id + "/" + file : file;
}

// Chooses one file box: the folder stays chosen, and the panel shows what the file declares —
// its functions and variables — read from its source.
function selectFile(nodeIndex, fileIndex)
{
  select(nodeIndex);
  S.selectedFile = fileIndex;
  render();

  const path = filePath(nodeIndex, fileIndex);
  const uses = S.FILE_EDGES.filter(([from]) => from === path).length;
  const usedBy = S.FILE_EDGES.filter(([, to]) => to === path).length;
  const lines = S.FILE_LINES.get(path);
  const tags = S.FILE_TAGS.get(path);
  const summary = S.FILE_SUMMARIES.get(path);
  document.getElementById("info").innerHTML =
    '<div class="chosen-file">' +
      '<div class="chosen-name open" data-openpath="' + escapeHtml(path) + '">' + escapeHtml(path.split("/").pop()) + "</div>" +
      '<div class="chosen-meta">' + (lines ? lines + " lines · " : "") +
      "uses " + uses + " · used by " + usedBy + "</div>" +
      (tags ? '<div class="chosen-tags">' + escapeHtml(tags.join(" · ")) + "</div>" : "") +
      (summary ? '<div class="chosen-sum">' + escapeHtml(summary) + "</div>" : "") +
    "</div>" +
    '<div id="symbols"><p class="hint">reading…</p></div>';
  showSymbols(path);
}

// The last file chosen, so a slow source read cannot paint over a newer choice.
let symbolsWanted = 0;

// Reads the chosen file's source and lists what it declares, by section.
// The source of each symbol the panel lists, by index, so a click can open the one it names.
let symbolCode = [];

async function showSymbols(path)
{
  const wanted = ++symbolsWanted;
  const box = document.getElementById("symbols");
  if (!box) return;
  let text = "";
  try { text = await (await fetch("/api/source?path=" + encodeURIComponent(path))).text(); }
  catch { /* an unreadable file simply lists nothing */ }
  if (wanted !== symbolsWanted) return;
  // A new file's symbols replace the last list, and close any snippet that was open.
  symbolCode = [];
  hideCode();
  const { functions, classes, variables } = symbolsOf(text);
  const section = (title, items) => items.length === 0 ? "" :
    "<h4>" + title + " (" + items.length + ")</h4><ul>" +
    items.map((item) =>
    {
      symbolCode.push(item.code);
      return '<li class="sym" data-i="' + (symbolCode.length - 1) + '"><span>' + escapeHtml(item.name) + "</span></li>";
    }).join("") + "</ul>";
  box.innerHTML = section("Functions", functions) + section("Classes", classes) + section("Variables", variables) ||
    '<p class="hint">No functions or variables found.</p>';
}

// Opens a symbol's source in the code panel, or closes it again.
function showCode(name, code)
{
  document.getElementById("codeblock-name").textContent = name;
  document.getElementById("symbol-code").textContent = code;
  document.getElementById("codeblock").hidden = false;
}

function hideCode()
{
  const panel = document.getElementById("codeblock");
  if (panel) panel.hidden = true;
}

// Reads a whole file and opens it in the code panel.
async function openFile(path)
{
  let text = "";
  try { text = await (await fetch("/api/source?path=" + encodeURIComponent(path))).text(); }
  catch { text = "(could not read this file)"; }
  showCode(path, text);
}

document.getElementById("info").addEventListener("click", (event) =>
{
  const item = event.target.closest("li.sym");
  if (item)
  {
    const code = symbolCode[Number(item.dataset.i)];
    if (code !== undefined) showCode(item.textContent, code);
    return;
  }
  const open = event.target.closest("[data-openpath]");
  if (open) openFile(open.dataset.openpath);
});

document.getElementById("codeblock-close").addEventListener("click", hideCode);

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
  const fileLine = (name, fileIndex) =>
  {
    const path = filePath(i, fileIndex);
    const tags = S.FILE_TAGS.get(path);
    const summary = S.FILE_SUMMARIES.get(path);
    return '<li class="fileref"><b class="open" data-openpath="' + escapeHtml(path) + '">' + escapeHtml(name) + "</b>" +
      (tags ? ' <span class="tags">' + escapeHtml(tags.join(" · ")) + "</span>" : "") +
      (summary ? '<div class="sum">' + escapeHtml(summary) + "</div>" : "") + "</li>";
  };
  info.innerHTML =
    "<h3>" + displayName(n.id) + "</h3>" +
    '<div class="layer" style="color:' + colorFor(n.layer) + '">' + labelFor(n.layer) + "</div>" +
    "<h4>Files (" + n.files.length + ")</h4>" +
    (n.files.length ? '<ul class="filelist">' + n.files.map(fileLine).join("") + "</ul>" : '<p class="hint">no files here</p>') +
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
    "<span>" + escapeHtml(labelOf(n)) + "</span></label>";
  for (const child of n.children) html += treeRowHtml(child, depth + 1);
  return html;
}

function renderHierarchy()
{
  const root = S.NODES.find((n) => n.id === "");
  document.getElementById("hierarchy-tree").innerHTML = root ? treeRowHtml(root, 0) : "";
}
// Draws the legend from the tags the repository carries, falling back to layers.
function renderLegend()
{
  const present = [];
  for (const list of S.FILE_TAGS.values()) for (const tag of list) if (!present.includes(tag)) present.push(tag);
  present.sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b));
  const heading = document.querySelector("#legend h2");
  if (heading) heading.textContent = present.length > 0 ? "Tags" : "Layers";
  const items = present.length > 0
    ? present.map((tag) => '<div class="swatch"><i style="background:' + colorForTag(tag) + '"></i>' + escapeHtml(tag) + "</div>")
    : layersLegend();
  document.getElementById("legend-items").innerHTML = items.join("");
}

// The fallback legend: by layer, when a repository carries no tags.
function layersLegend()
{
  const layers = [];
  for (const node of S.NODES) if (!layers.includes(node.layer)) layers.push(node.layer);
  layers.sort((a, b) =>
  {
    const rank = (name) => S.NODES.find((node) => node.layer === name)?.rank ?? 0;
    return rank(a) - rank(b);
  });
  return layers.map((name) =>
    '<div class="swatch"><i style="background:' + colorFor(name) + '"></i>' + escapeHtml(labelFor(name)) + "</div>");
}

export { escapeHtml, filePath, select, selectFile, renderLegend, renderHierarchy };
