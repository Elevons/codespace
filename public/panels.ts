import { S, V3, camera, colorFor, colorForTag, filePath, labelFor, render, renderEdges, TAG_ORDER, isExtraFolder } from "./state.js";
import { displayName, labelOf, symbolsOf, type SymbolInfo } from "./repo.js";
import type { GraphNode } from "./types.js";
/* --------------------------------------------------------------- panels ---- */

// Escapes the characters that would otherwise break the info panel's HTML.
const HTML_ENTITIES: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function escapeHtml(text: string): string
{
  return String(text).replace(/[&<>"']/g, (c) => HTML_ENTITIES[c]);
}

// Keeps the address bar in step with the choice, so a view can be shared or reloaded.
function syncHash(path: string | null): void
{
  const encoded = path === null ? "" : path.split("/").map((part) => encodeURIComponent(part)).join("/");
  const next = encoded === "" ? location.pathname + location.search : "#" + encoded;
  if (location.pathname + location.search + location.hash !== next) history.replaceState(null, "", next);
}

// A path as a row of clickable folders, ending in the file or folder itself.
function crumbsHtml(path: string, file: boolean): string
{
  const parts = path === "" ? [] : path.split("/");
  const folders = file ? parts.slice(0, -1) : parts;
  const rows: string[] = ['<a class="crumb" data-selectfolder="">(root)</a>'];
  let acc = "";
  folders.forEach((part, index) =>
  {
    acc = acc ? acc + "/" + part : part;
    const here = !file && index === folders.length - 1 ? " here" : "";
    rows.push('<span class="crumb-sep">/</span><a class="crumb' + here + '" data-selectfolder="' + escapeHtml(acc) + '">' + escapeHtml(part) + "</a>");
  });
  if (file) rows.push('<span class="crumb-sep">/</span><span class="crumb here">' + escapeHtml(parts[parts.length - 1]!) + "</span>");
  return '<nav class="crumbs">' + rows.join("") + "</nav>";
}

// The words a language reserves, so the code panel can colour them.
const KEYWORDS = new Set(("const let var function class interface type enum import export from default return if else for while do " +
  "switch case break continue new await async yield this super extends implements public private protected readonly static " +
  "true false null undefined typeof instanceof in of try catch finally throw void as satisfies declare abstract").split(" "));

// Wraps the parts of one line a reader's eye looks for first: comments, strings, numbers, keywords.
function highlightLine(line: string, hashComments: boolean): string
{
  const pattern = hashComments
    ? /(\/\/[^\n]*|\/\*.*?\*\/|#[^\n]*|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g
    : /(\/\/[^\n]*|\/\*.*?\*\/|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let out = "", last = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) !== null)
  {
    out += escapeHtml(line.slice(last, match.index));
    const token = match[0];
    let cls = "";
    if (token.startsWith("//") || token.startsWith("/*") || (hashComments && token.startsWith("#"))) cls = "c";
    else if (/^["'`]/.test(token)) cls = "s";
    else if (/^\d/.test(token)) cls = "n";
    else if (KEYWORDS.has(token)) cls = "k";
    else if (/^[A-Z]/.test(token)) cls = "t";
    out += cls ? '<span class="' + cls + '">' + escapeHtml(token) + "</span>" : escapeHtml(token);
    last = match.index + token.length;
  }
  return out + escapeHtml(line.slice(last));
}

// A whole file with a line-number gutter and coloured tokens.
function renderCode(code: string, name: string): string
{
  const hashComments = /\.(py|sh|bash|zsh|ya?ml|rb|ex|exs|toml|ini|tf)$/i.test(name);
  const lines = code.split("\n");
  const gutter: string[] = [], body: string[] = [];
  lines.forEach((line, index) =>
  {
    gutter.push("<span>" + (index + 1) + "</span>");
    body.push('<div class="code-line">' + (highlightLine(line, hashComments) || " ") + "</div>");
  });
  return '<div class="code-wrap"><pre class="code-gutter">' + gutter.join("\n") + '</pre><div class="code-body">' + body.join("") + "</div></div>";
}

// Chooses one file box: the folder stays chosen, and the panel shows what the file declares —
// its functions and variables — read from its source.
function selectFile(nodeIndex: number, fileIndex: number): void
{
  select(nodeIndex);
  S.selectedFile = fileIndex;
  render();

  const path = filePath(nodeIndex, fileIndex);
  syncHash(path);
  const rec = S.fileRecords.get(path);
  if (rec) { S.autoSpin = false; window.dispatchEvent(new Event("codespace:spin")); S.camGoal = { target: rec.target.clone(), radius: Math.min(camera.radius, 24) }; }
  const uses = S.FILE_EDGES.filter(([from]) => from === path).length;
  const usedBy = S.FILE_EDGES.filter(([, to]) => to === path).length;
  const lines = S.FILE_LINES.get(path);
  const tags = S.FILE_TAGS.get(path);
  const summary = S.FILE_SUMMARIES.get(path);
  document.getElementById("info")!.innerHTML =
    crumbsHtml(path, true) +
    '<div class="chosen-file">' +
      '<div class="chosen-name open" data-openpath="' + escapeHtml(path) + '">' + escapeHtml(path.split("/").pop()!) + "</div>" +
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

// The source of each symbol the panel lists, by index, so a click can open the one it names.
let symbolCode: string[] = [];

// The path whose symbols the code panel is showing, for the code panel's language guess.
let shownPath = "";

// A symbol a search asked for, opened once its file's list is read.
let pendingSymbol: string | null = null;

async function showSymbols(path: string): Promise<void>
{
  const wanted = ++symbolsWanted;
  shownPath = path;
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
  const section = (title: string, items: SymbolInfo[]): string => items.length === 0 ? "" :
    "<h4>" + title + " (" + items.length + ")</h4><ul>" +
    items.map((item) =>
    {
      symbolCode.push(item.code);
      return '<li class="sym" data-i="' + (symbolCode.length - 1) + '"><span>' + escapeHtml(item.name) + '</span><span class="n">L' + item.line + "</span></li>";
    }).join("") + "</ul>";
  box.innerHTML = section("Functions", functions) + section("Classes", classes) + section("Variables", variables) ||
    '<p class="hint">No functions or variables found.</p>';
  // A symbol picked from search opens straight away, once its code is in hand.
  if (pendingSymbol !== null)
  {
    const requested = pendingSymbol;
    pendingSymbol = null;
    const found = [...functions, ...classes, ...variables].find((item) => item.name === requested);
    if (found) showCode(found.name, found.code, path);
  }
}

// Opens a symbol's source in the code panel, or closes it again.
function showCode(name: string, code: string, langName?: string): void
{
  document.getElementById("codeblock-name")!.textContent = name;
  document.getElementById("symbol-code")!.innerHTML = renderCode(code, langName ?? shownPath);
  document.getElementById("codeblock")!.hidden = false;
}

// Opens one symbol of a file in the code panel, after its file's list is read.
function openSymbol(path: string, name: string): void
{
  pendingSymbol = name;
  showSymbols(path);
}

function hideCode(): void
{
  const panel = document.getElementById("codeblock");
  if (panel) panel.hidden = true;
}

// Reads a whole file and opens it in the code panel.
async function openFile(path: string): Promise<void>
{
  let text = "";
  try { text = await (await fetch("/api/source?path=" + encodeURIComponent(path))).text(); }
  catch { text = "(could not read this file)"; }
  showCode(path, text);
}

document.getElementById("info")!.addEventListener("click", (event) =>
{
  const target = event.target as HTMLElement;
  const item = target.closest("li.sym") as HTMLElement | null;
  if (item)
  {
    const code = symbolCode[Number(item.dataset.i)];
    if (code !== undefined) showCode(item.querySelector("span")?.textContent ?? "", code);
    return;
  }
  const crumb = target.closest("[data-selectfolder]") as HTMLElement | null;
  if (crumb)
  {
    const id = crumb.dataset.selectfolder!;
    select(S.NODES.findIndex((n) => n.id === id));
    return;
  }
  const open = target.closest("[data-openpath]") as HTMLElement | null;
  if (open) openFile(open.dataset.openpath!);
  if (target.closest(".repo-path") && S.repoRoot !== "") copyRepoPath();
});

/** Copies the repository's path, so a person can paste it to their agent. */
function copyRepoPath(): void
{
  const area = document.createElement("textarea");
  area.value = S.repoRoot;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  try { document.execCommand("copy"); } catch { /* the path stays visible either way */ }
  area.remove();
  const note = document.querySelector("#info .repo-path") as HTMLElement | null;
  if (note) { note.textContent = "copied " + S.repoRoot; setTimeout(() => { note.textContent = S.repoRoot; }, 1200); }
}

document.getElementById("codeblock-close")!.addEventListener("click", hideCode);

// The chosen folder and every folder it imports or is imported by.
function neighboursOf(i: number): Set<number>
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

// The repository at a glance, shown until something is chosen, with the keys worth knowing.
function statsHtml(): string
{
  const folders = Math.max(0, S.NODES.length - 1);
  const files = S.NODES.reduce((sum, n) => sum + n.files.length, 0);
  const lines = [...S.FILE_LINES.values()].reduce((sum, count) => sum + count, 0);
  const stat = (value: string, label: string) => '<div class="stat"><b>' + value + "</b><span>" + label + "</span></div>";
  return '<h3 class="empty-title">' + escapeHtml(S.repoName) + "</h3>" +
    '<p class="hint repo-path" title="Click to copy the path, to tell your agent">' + escapeHtml(S.repoRoot || "reading…") + "</p>" +
    '<p class="hint">Click a block to trace it, or press <kbd>/</kbd> to search.</p>' +
    (S.hiddenFiles > 0 ? '<p class="hint">Showing only described files. <b>' + S.hiddenFiles.toLocaleString() +
      "</b> more appear as they are described; <i>Undescribed: shown</i> draws them all.</p>" : "") +
    '<div class="stats">' + stat(String(folders), "folders") + stat(String(files), "files") +
    stat(String(S.FILE_LINES.size), "code files") + stat(lines.toLocaleString(), "lines") +
    stat(String(S.FILE_EDGES.length), "imports") + "</div>" +
    '<div class="keys"><span><kbd>Space</kbd> spin</span><span><kbd>/</kbd> search</span>' +
    "<span><kbd>F</kbd> frame</span><span><kbd>R</kbd> reset</span><span><kbd>?</kbd> keys</span></div>";
}

function select(i: number): void
{
  S.selected = i;
  S.selectedFile = -1;
  S.focusSet = i >= 0 ? neighboursOf(i) : null;
  const info = document.getElementById("info")!;
  if (i < 0)
  {
    syncHash(null);
    info.innerHTML = statsHtml();
    renderEdges();
    return;
  }
  const n = S.NODES[i];
  syncHash(n.id);
  // Glide the camera to the chosen folder, close enough that its files read.
  if (n.cx !== undefined)
  {
    const reach = Math.max(n.tileW ?? 8, n.tileD ?? 8);
    S.autoSpin = false;
    window.dispatchEvent(new Event("codespace:spin"));
    S.camGoal = { target: new V3(n.cx, n.topY!, n.cz!), radius: Math.max(8, Math.min(camera.radius, reach * 0.9 + 6)) };
  }
  const outs = S.EDGES.filter((e) => e[0] === n.id).sort((a, b) => b[2] - a[2]);
  const ins = S.EDGES.filter((e) => e[1] === n.id).sort((a, b) => b[2] - a[2]);
  const line = (e: [string, string, number], target: string) => "<li>" + target + '<span class="n">' + e[2] + "</span></li>";
  const fileLine = (name: string, fileIndex: number) =>
  {
    const path = filePath(i, fileIndex);
    const tags = S.FILE_TAGS.get(path);
    const summary = S.FILE_SUMMARIES.get(path);
    return '<li class="fileref"><b class="open" data-openpath="' + escapeHtml(path) + '">' + escapeHtml(name) + "</b>" +
      (tags ? ' <span class="tags">' + escapeHtml(tags.join(" · ")) + "</span>" : "") +
      (summary ? '<div class="sum">' + escapeHtml(summary) + "</div>" : "") + "</li>";
  };
  info.innerHTML =
    crumbsHtml(n.id, false) +
    "<h3>" + displayName(n.id) + "</h3>" +
    '<div class="layer" style="color:' + colorFor(n.layer) + '">' + labelFor(n.layer) + "</div>" +
    (S.FILE_SUMMARIES.get(n.id) ? '<div class="chosen-sum">' + escapeHtml(S.FILE_SUMMARIES.get(n.id)!) + "</div>" : "") +
    "<h4>Files (" + n.files.length + ")</h4>" +
    (n.files.length ? '<ul class="filelist">' + n.files.map(fileLine).join("") + "</ul>" : '<p class="hint">no files here</p>') +
    "<h4 class='out'>Imports (" + outs.length + ")</h4>" +
    (outs.length ? "<ul>" + outs.map((e) => line(e, e[1])).join("") + "</ul>" : '<p class="hint">nothing local</p>') +
    "<h4 class='in'>Imported by (" + ins.length + ")</h4>" +
    (ins.length ? "<ul>" + ins.map((e) => line(e, e[0])).join("") + "</ul>" : '<p class="hint">nothing — a top-level entry</p>');
  renderEdges();
}

function treeRowHtml(n: GraphNode, depth: number): string
{
  const hidden = S.hiddenFolders.has(n.id);
  const collapsed = S.collapsedFolders.has(n.id);
  const hasChildren = n.children.length > 0;
  const extra = isExtraFolder(n.id);
  let html = '<div class="hrow' + (hidden ? " hidden" : "") + '" style="padding-left:' + (depth * 12) + 'px">' +
    (hasChildren
      ? '<button type="button" class="caret' + (collapsed ? " collapsed" : "") + '" data-caret="' + escapeHtml(n.id) +
        '" aria-expanded="' + String(!collapsed) + '">' + (collapsed ? "▸" : "▾") + "</button>"
      : '<span class="caret-gap"></span>') +
    '<label><input type="checkbox" data-id="' + escapeHtml(n.id) + '"' + (hidden ? "" : " checked") + ">" +
    "<span>" + escapeHtml(labelOf(n)) + "</span></label>" +
    '<button type="button" class="extra' + (extra ? " on" : "") + '" data-extra="' + escapeHtml(n.id) +
    '" aria-pressed="' + String(extra) + '" title="Include in Extras">extra</button>' +
    "</div>";
  if (hasChildren && !collapsed) for (const child of n.children) html += treeRowHtml(child, depth + 1);
  return html;
}

function renderHierarchy(): void
{
  const root = S.NODES.find((n) => n.id === "");
  document.getElementById("hierarchy-tree")!.innerHTML = root ? treeRowHtml(root, 0) : "";
}
// Draws the legend from the tags the repository carries, falling back to layers.
function renderLegend(): void
{
  const present: string[] = [];
  for (const list of S.FILE_TAGS.values()) for (const tag of list) if (!present.includes(tag)) present.push(tag);
  present.sort((a, b) => TAG_ORDER.indexOf(a) - TAG_ORDER.indexOf(b));
  const heading = document.querySelector("#legend h2") as HTMLElement | null;
  if (heading) heading.textContent = present.length > 0 ? "Tags" : "Layers";
  // A filter for a tag the repository no longer carries is dropped, so the map comes back.
  if (S.tagFilter !== null && !present.includes(S.tagFilter)) S.tagFilter = null;
  const items = present.length > 0
    ? present.map((tag) => '<button class="swatch' + (S.tagFilter === tag ? " active" : "") + '" data-tag="' + escapeHtml(tag) + '">' +
      '<i style="background:' + colorForTag(tag) + '"></i>' + escapeHtml(tag) + "</button>")
    : layersLegend();
  document.getElementById("legend-items")!.innerHTML = items.join("");
}

// A click on a tag in the legend filters the map to it; a second click lets everything back in.
document.getElementById("legend-items")!.addEventListener("click", (event) =>
{
  const button = (event.target as HTMLElement).closest("[data-tag]") as HTMLElement | null;
  if (!button) return;
  const tag = button.dataset.tag!;
  S.tagFilter = S.tagFilter === tag ? null : tag;
  renderEdges();
  renderLegend();
  window.dispatchEvent(new Event("codespace:filter"));
});

// The fallback legend: by layer, when a repository carries no tags.
function layersLegend(): string[]
{
  const layers: string[] = [];
  for (const node of S.NODES) if (!layers.includes(node.layer)) layers.push(node.layer);
  layers.sort((a, b) =>
  {
    const rank = (name: string) => S.NODES.find((node) => node.layer === name)?.rank ?? 0;
    return rank(a) - rank(b);
  });
  return layers.map((name) =>
    '<div class="swatch"><i style="background:' + colorFor(name) + '"></i>' + escapeHtml(labelFor(name)) + "</div>");
}

export { escapeHtml, select, selectFile, openSymbol, renderLegend, renderHierarchy };
