import { S, colorFor, colorForSystem, copyText, frameFile, frameFolder, hasFilters, inScene as isInScene, isFileVisible, matchesFilters, matchesTagFilter, passesSlice, sliceValue, systemLabel, filePath, pathIndex, render, renderEdges } from "./state.js";
import { folderColor, folderOf, labelFor, subtreeIndices } from "./rules.js";
import { ancestorFolders, foldersToKeepOpen, matchesQueryTerms, queryTerms } from "./filter.js";
import { refreshColumns } from "./meshes.js";
import { displayName, readBlockSummaries, readBlocks, readSource } from "./repo.js";
import { showNeighbourhood } from "./neighbourhood.js";
import { changeView } from "./viewcall.js";
import { blockColor, type BlockInfo, type IBlocksReport } from "./blocks.js";
import type { FileSpot, GroupAxis } from "./types.js";
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

// A run of lines with a line-number gutter and coloured tokens, numbered from the line it
// starts on, so a block's fragment reads in the file's own numbering.
function renderCode(code: string, name: string, first = 1): string
{
  const hashComments = /\.(py|sh|bash|zsh|ya?ml|rb|ex|exs|toml|ini|tf)$/i.test(name);
  const lines = code.split("\n");
  const gutter: string[] = [], body: string[] = [];
  lines.forEach((line, index) =>
  {
    gutter.push("<span>" + (index + first) + "</span>");
    body.push('<div class="code-line">' + (highlightLine(line, hashComments) || " ") + "</div>");
  });
  return '<div class="code-wrap"><pre class="code-gutter">' + gutter.join("\n") + '</pre><div class="code-body">' + body.join("") + "</div></div>";
}

/** The path of the chosen file, whose blocks are open, or null when a folder or nothing is chosen. */
function chosenFilePath(): string | null
{
  return S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
}

/** Every chosen file, the one whose blocks are open first. */
export function selectionPaths(): string[]
{
  const primary = chosenFilePath();
  return primary === null ? [] : [primary, ...S.extraFiles];
}

// Adds a file to the selection with a shift-click, or takes it out again. The file chosen first
// stays the one whose blocks are open, so its rail and floors do not move under the pointer.
export function toggleFileSelection(nodeIndex: number, fileIndex: number): void
{
  const path = filePath(nodeIndex, fileIndex);
  const primary = chosenFilePath();
  if (primary === null) { selectFile(nodeIndex, fileIndex); return; }
  if (primary === path) return;
  if (S.extraFiles.has(path)) S.extraFiles.delete(path);
  else S.extraFiles.add(path);
  renderSelection();
  renderOutliner();
  renderEdges();
  render();
}

// Takes one extra file out of the selection, keeping the one whose blocks are open.
export function removeExtraFile(path: string): void
{
  if (!S.extraFiles.delete(path)) return;
  renderSelection();
  renderOutliner();
  renderEdges();
  render();
}

/** Chooses a set of files, as a tool asks: the first one opens, and the rest are added to it. */
export function setSelection(paths: readonly string[]): void
{
  const found: Array<[number, number]> = [];
  for (const path of paths)
  {
    const spot = pathIndex().files.get(path);
    if (spot !== undefined && found.some(([node, at]) => node === spot[0] && at === spot[1]) === false) found.push(spot);
  }
  if (found.length === 0) { select(-1); return; }
  selectFile(found[0][0], found[0][1]);
  for (const [node, at] of found.slice(1)) S.extraFiles.add(filePath(node, at));
  renderSelection();
  renderOutliner();
  renderEdges();
  render();
}

// The chosen file's panel lists the other files in the selection, each one a click away or
// removed by its cross.
function selectionHtml(): string
{
  if (S.extraFiles.size === 0) return "";
  const rows = [...S.extraFiles].map((path) =>
  {
    const summary = S.FILE_SUMMARIES.get(path);
    return '<li class="selrow"><button type="button" class="selopen" data-extra="' + escapeHtml(path) + '">' +
      escapeHtml(path.split("/").pop()!) + "</button>" +
      '<button type="button" class="seldrop" data-extradrop="' + escapeHtml(path) + '" title="Remove from the selection" aria-label="Remove from the selection">✕</button>' +
      (summary ? '<span class="selsum">' + escapeHtml(summary) + "</span>" : "") + "</li>";
  }).join("");
  return '<div class="selhead">Also selected <span>' + S.extraFiles.size + "</span>" +
    '<button type="button" class="chosen-act selonly" data-only-selected title="Draw only the selected files, and hide every other file">Only these</button>' +
    '<button type="button" class="chosen-act selonly" data-show-selected title="Light up the selected files as a set, listed in the Showing panel">Show as set</button>' +
    '</div><ul class="sellist">' + rows + "</ul>";
}

export function renderSelection(): void
{
  const box = document.getElementById("selection");
  if (box) box.innerHTML = selectionHtml();
}

// Chooses one file box: the folder stays chosen, and the panel shows what the file declares —
// its functions and variables — read from its source.
function selectFile(nodeIndex: number, fileIndex: number): void
{
  // The outliner is drawn once, below, for the file; drawing it for the folder first would scroll
  // the tree to the folder's row and shift the rows under the pointer between two clicks.
  select(nodeIndex, false);
  S.selectedFile = fileIndex;
  render();

  const path = filePath(nodeIndex, fileIndex);
  syncHash(path);
  const rec = S.fileRecords.get(path);
  if (rec) frameFile(rec);
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
      '<div class="chosen-acts"><button type="button" class="chosen-act" data-neighbourhood="' + escapeHtml(path) + '" title="Keep only this file and what it imports or is imported by">Neighbourhood</button></div>' +
      (tags ? '<div class="chosen-tags">' + escapeHtml(tags.join(" · ")) + "</div>" : "") +
      (summary ? '<div class="chosen-sum">' + escapeHtml(summary) + "</div>" : "") +
    "</div>" +
    '<div id="selection">' + selectionHtml() + "</div>" +
    '<div id="symbols"><p class="hint">reading…</p></div>';
  showBlocks(path);
  renderOutliner();
}

// The last file chosen, so a slow read cannot paint over a newer choice.
let blocksWanted = 0;

// The opened file's lines, so a block's source can be shown by its line range.
let blockLines: string[] = [];

// The path whose blocks the panel is showing, for the code panel's language guess.
let shownPath = "";

// A block name a search asked for, opened once its file's blocks are read.
let pendingBlock: string | null = null;

// Asks the server for the blocks one file is made of, and lists them beside a strip of the
// whole file. The blocks are read when the file is opened, never for a whole repository.
async function showBlocks(path: string): Promise<void>
{
  const wanted = ++blocksWanted;
  shownPath = path;
  const box = document.getElementById("symbols");
  if (!box) return;
  let text = "", report: IBlocksReport | null = null;
  try
  {
    [text, report] = await Promise.all([readSource(path), readBlocks(path)]);
  }
  catch { /* an unreadable file simply lists nothing */ }
  if (wanted !== blocksWanted) return;
  // A new file's blocks replace the last list, and close any block that was open.
  blockLines = text.split("\n");
  hideCode();
  S.selectedBlock = -1;
  if (report === null || report.blocks.length === 0)
  {
    box.innerHTML = '<p class="hint">No blocks found.</p>';
    return;
  }
  // The file may be read again on a second choice. Keep the report already on the map when the
  // blocks the floors read are the same, so the stack keeps its geometry instead of rebuilding
  // and reopening; a change to a kind or a span still rebuilds.
  const known = S.BLOCKS.get(path);
  const unchanged = known !== undefined && known.lines === report.lines && known.blocks.length === report.blocks.length &&
    known.blocks.every((block, at) =>
    {
      const fresh = report!.blocks[at];
      return block.name === fresh.name && block.kind === fresh.kind && block.line === fresh.line &&
        block.endLine === fresh.endLine && block.depth === fresh.depth && block.parent === fresh.parent &&
        block.exported === fresh.exported && (block.members?.join("\u0000") ?? "") === (fresh.members?.join("\u0000") ?? "");
    });
  if (!unchanged) S.BLOCKS.set(path, report);
  box.innerHTML = railHtml(report);
  render();
  // The chosen file's wires can now meet its floors rather than its whole box.
  renderEdges();
  // Blocks with no comment show a plain description first, and the model's sentence when it comes.
  if (report.blocks.some((block) => block.fromComment === false)) void fillSummaries(path, report, wanted, box);
  // A block picked from search opens straight away, once its file's blocks are in hand.
  if (pendingBlock === null) return;
  const requested = pendingBlock;
  pendingBlock = null;
  const found = report.blocks.findIndex((block) => block.name === requested || block.members?.includes(requested));
  if (found >= 0) openBlockAt(found);
}

// The block rail: a strip of the whole file, one mark per block, beside a row of summaries.
// The strip is line-accurate in the manner of SeeSoft, so a person sees where each block sits.
function railHtml(report: IBlocksReport): string
{
  const total = Math.max(1, report.lines);
  const strip = report.blocks.map((block, index) =>
  {
    const top = (block.line - 1) / total * 100;
    const height = Math.max(0.8, (block.endLine - block.line + 1) / total * 100);
    return '<i class="rail-mark' + (block.depth > 0 ? " sub" : "") + '" data-block="' + index +
      '" style="top:' + top.toFixed(2) + "%;height:" + height.toFixed(2) + "%;background:" + blockColor(block.kind) +
      '" title="' + escapeHtml(block.name) + '"></i>';
  }).join("");
  const rows = report.blocks.map((block, index) => railRow(block, index)).join("");
  return '<h4 class="rail-title">Blocks <span>' + report.blocks.length + "</span></h4>" +
    '<div class="rail"><div class="rail-strip">' + strip + '</div><div class="rail-list">' + rows + "</div></div>";
}

// Fills in a written sentence for each block the source left without a comment. Only the text
// changes, so the strip, the rows, and the chosen block stay where they are.
async function fillSummaries(path: string, report: IBlocksReport, wanted: number, box: HTMLElement): Promise<void>
{
  let summaries: Record<string, string> | null = null;
  try { summaries = await readBlockSummaries(path); }
  catch { return; }
  if (summaries === null || wanted !== blocksWanted || shownPath !== path) return;
  report.blocks.forEach((block, index) =>
  {
    const summary = summaries![block.name + "@" + block.line];
    if (summary === undefined || block.fromComment) return;
    block.summary = summary;
    block.fromModel = true;
    const row = box.querySelector<HTMLElement>('[data-block="' + index + '"] .rail-sum');
    if (row === null) return;
    row.textContent = summary;
    row.classList.remove("made");
    row.title = "";
  });
}

// One block's row: what it is called, what it is for, and which of the file's blocks it uses.
function railRow(block: BlockInfo, index: number): string
{
  const range = "L" + block.line + (block.endLine > block.line ? "–" + block.endLine : "");
  const refs = block.refs.length === 0 ? "" : '<span class="rail-refs">uses ' + escapeHtml(block.refs.join(", ")) + "</span>";
  return '<button type="button" class="rail-row' + (block.depth > 0 ? " sub" : "") + '" data-block="' + index + '">' +
    '<span class="rail-kind" style="background:' + blockColor(block.kind) + '"></span>' +
    '<span class="rail-text"><span class="rail-head"><span class="rail-name">' + escapeHtml(block.name) + '</span>' +
    '<span class="rail-lines">' + range + '</span></span>' +
    '<span class="rail-sum' + (block.fromComment ? "" : " made") + '" title="' +
    (block.fromComment ? "" : "No comment in the source: this is a plain description of the block.") + '">' +
    escapeHtml(block.summary) + "</span>" + refs + detailsHtml(block) + "</span></button>";
}

// The notes the architecture file keeps on what a block holds, shown while the block is open.
function detailsHtml(block: BlockInfo): string
{
  if (!block.details || block.details.length === 0) return "";
  const label = (name: string) => name.replace(/:(\d+)$/, (_, step: string) => (name.startsWith(":") ? "" : " · ") + "step " + step);
  return '<span class="rail-details">' + block.details.map((detail) =>
    '<span class="rail-detail"><b>' + escapeHtml(label(detail.name)) + "</b> " + escapeHtml(detail.note) + "</span>").join("") + "</span>";
}

// Opens one block of the shown file: its lines in the code panel, and its floor on the map.
// A click on a floor calls this too, so both views pick the same block.
export function openBlockAt(index: number): void
{
  const report = S.BLOCKS.get(shownPath);
  const block = report?.blocks[index];
  if (!block) return;
  // Choosing the block that is already open closes it again, and the source with it.
  const panel = document.getElementById("codeblock")!;
  if (S.selectedBlock === index && panel.hidden === false)
  {
    S.selectedBlock = -1;
    render();
    hideCode();
    document.querySelectorAll<HTMLElement>("#symbols [data-block]").forEach((element) => element.classList.remove("sel"));
    return;
  }
  S.selectedBlock = index;
  render();
  const code = blockLines.slice(block.line - 1, block.endLine).join("\n");
  showCode(block.name, code, shownPath, block.line);
  document.querySelectorAll<HTMLElement>("#symbols [data-block]").forEach((element) =>
  {
    const chosen = Number(element.getAttribute("data-block")) === index;
    element.classList.toggle("sel", chosen);
    if (chosen) element.scrollIntoView({ block: "nearest" });
  });
}

// Opens a block's source in the code panel, or closes it again. The gutter starts at the
// block's own line, so the fragment reads in the file's numbering.
function showCode(name: string, code: string, langName?: string, first = 1): void
{
  document.getElementById("codeblock-name")!.textContent = name;
  document.getElementById("symbol-code")!.innerHTML = renderCode(code, langName ?? shownPath, first);
  document.getElementById("codeblock")!.hidden = false;
}

// Opens one block of a file in the code panel, after its file's blocks are read.
function openSymbol(path: string, name: string): void
{
  pendingBlock = name;
  showBlocks(path);
}

function hideCode(): void
{
  const panel = document.getElementById("codeblock");
  if (panel) panel.hidden = true;
}

// Reads a whole file and opens it in the code panel.
async function openFile(path: string): Promise<void>
{
  let text: string;
  try { text = await readSource(path); }
  catch { text = "(could not read this file)"; }
  showCode(path, text);
}

document.getElementById("info")!.addEventListener("click", (event) =>
{
  const target = event.target as HTMLElement;
  const toggle = target.closest("[data-info-toggle]") as HTMLElement | null;
  if (toggle)
  {
    statsCollapsed = !statsCollapsed;
    document.getElementById("info")!.classList.toggle("collapsed", statsCollapsed);
    toggle.textContent = statsCollapsed ? "Show" : "Hide";
    toggle.setAttribute("aria-expanded", String(!statsCollapsed));
    return;
  }
  const around = target.closest("[data-neighbourhood]") as HTMLElement | null;
  if (around) { void showNeighbourhood(around.dataset.neighbourhood!); return; }
  if (target.closest("[data-only-selected]")) { void changeView({ type: "isolate", files: selectionPaths() }); return; }
  if (target.closest("[data-show-selected]"))
  {
    const files = selectionPaths().map((path) => ({ path, note: S.FILE_SUMMARIES.get(path) ?? "" }));
    void changeView({ type: "show", shown: { title: "Selected files", note: "", trace: false, files } });
    return;
  }
  if (target.closest("[data-tour]")) { window.dispatchEvent(new Event("codespace:tour")); return; }
  const extra = target.closest("[data-extra]") as HTMLElement | null;
  if (extra)
  {
    const spot = pathIndex().files.get(extra.dataset.extra!);
    if (spot) selectFile(spot[0], spot[1]);
    return;
  }
  const drop = target.closest("[data-extradrop]") as HTMLElement | null;
  if (drop) { removeExtraFile(drop.dataset.extradrop!); return; }
  const block = target.closest("[data-block]") as HTMLElement | null;
  if (block)
  {
    openBlockAt(Number(block.dataset.block));
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
  if (target.closest(".repo-path") && S.repoRoot !== "") void copyRepoPath();
});

/** Copies the repository's path, so a person can paste it to their agent. */
async function copyRepoPath(): Promise<void>
{
  await copyText(S.repoRoot);
  const note = document.querySelector("#info .repo-path") as HTMLElement | null;
  if (note) { note.textContent = "copied " + S.repoRoot; setTimeout(() => { note.textContent = S.repoRoot; }, 1200); }
}

document.getElementById("codeblock-close")!.addEventListener("click", hideCode);

// Whether the repository's numbers are folded away, leaving just its name and path.
let statsCollapsed = false;

// The repository at a glance, shown until something is chosen, with the keys worth knowing.
function statsHtml(): string
{
  const folders = Math.max(0, S.NODES.length - 1);
  const files = S.NODES.reduce((sum, n) => sum + n.files.length, 0);
  const lines = [...S.FILE_LINES.values()].reduce((sum, count) => sum + count, 0);
  const stat = (value: string, label: string) => '<div class="stat"><b>' + value + "</b><span>" + label + "</span></div>";
  const toggle = '<button type="button" class="info-toggle" data-info-toggle aria-controls="info-body" aria-expanded="' +
    String(!statsCollapsed) + '">' + (statsCollapsed ? "Show" : "Hide") + "</button>";
  return '<div class="empty-head"><h3 class="empty-title">' + escapeHtml(S.repoName) + "</h3>" +
    '<p class="hint repo-path" title="Click to copy the path, to tell your agent">' + escapeHtml(S.repoRoot || "reading…") + "</p>" +
    toggle + "</div>" +
    '<div id="info-body">' +
    '<p class="hint how"><span class="key-only">Click a block to trace it, or press <kbd>/</kbd> to search.</span>' +
    '<span class="touch-only">Tap a block to trace it, or search above.</span></p>' +
    '<p class="hint how"><button type="button" class="chosen-act" data-tour title="Walk through the repository from its entry points">Start here</button> New to this code? Take the tour.</p>' +
    (S.undescribed > 0 ? '<p class="hint note"><b>' + S.undescribed.toLocaleString() + "</b> file" +
      (S.undescribed === 1 ? " is" : "s are") + " not described yet.</p>" : "") +
    S.ARCH_NOTES.map((note) => '<p class="hint note">' + escapeHtml(note) + "</p>").join("") +
    '<div class="stats">' + stat(String(folders), "folders") + stat(String(files), "files") +
    stat(String(S.FILE_LINES.size), "code files") + stat(lines.toLocaleString(), "lines") +
    stat(String(S.FILE_EDGES.length), "imports") + "</div>" +
    '<div class="keys key-only"><span><kbd>Space</kbd> spin</span><span><kbd>/</kbd> search</span>' +
    "<span><kbd>F</kbd> frame</span><span><kbd>R</kbd> reset</span><span><kbd>?</kbd> keys</span></div></div>";
}

function select(i: number, outline = true): void
{
  S.selected = i;
  S.selectedFile = -1;
  // Choosing a folder, or nothing, ends the file's block and the rest of the selection too.
  S.extraFiles.clear();
  S.selectedBlock = -1;
  hideCode();
  // A chosen folder is what you are inside, so only its own subtree stays lit; the root holds
  // everything, so choosing it (a click on the empty ground) does not fade the whole map.
  S.focusSet = i >= 0 && S.NODES[i]?.id !== "" ? subtreeIndices(S.NODES[i]) : null;
  // The columns are the chosen folder's children, so choosing a folder, file, or breadcrumb
  // redraws them one level down. The layout itself is unchanged.
  refreshColumns();
  const info = document.getElementById("info")!;
  info.classList.toggle("empty", i < 0);
  info.classList.toggle("collapsed", i < 0 && statsCollapsed);
  if (i < 0)
  {
    syncHash(null);
    info.innerHTML = statsHtml();
    renderEdges();
    renderOutliner();
    return;
  }
  const n = S.NODES[i];
  syncHash(n.id);
  // Glide the camera to the chosen folder, close enough that its files read.
  frameFolder(n);
  const outs = S.EDGES.filter((e) => e[0] === n.id).sort((a, b) => b[2] - a[2]);
  const ins = S.EDGES.filter((e) => e[1] === n.id).sort((a, b) => b[2] - a[2]);
  const line = (e: [string, string, number], target: string) => "<li>" + escapeHtml(target) + '<span class="n">' + e[2] + "</span></li>";
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
    "<h3>" + escapeHtml(displayName(n.id)) + "</h3>" +
    '<div class="layer" style="color:' + colorFor(n.layer) + '">' + labelFor(n.layer) + "</div>" +
    (S.FILE_SUMMARIES.get(n.id) ? '<div class="chosen-sum">' + escapeHtml(S.FILE_SUMMARIES.get(n.id)!) + "</div>" : "") +
    "<h4>Files (" + n.files.length + ")</h4>" +
    (n.files.length ? '<ul class="filelist">' + n.files.map(fileLine).join("") + "</ul>" : '<p class="hint">no files here</p>') +
    "<h4 class='out'>Imports (" + outs.length + ")</h4>" +
    (outs.length ? "<ul>" + outs.map((e) => line(e, e[1])).join("") + "</ul>" : '<p class="hint">nothing local</p>') +
    "<h4 class='in'>Imported by (" + ins.length + ")</h4>" +
    (ins.length ? "<ul>" + ins.map((e) => line(e, e[0])).join("") + "</ul>" : '<p class="hint">nothing — a top-level entry</p>');
  renderEdges();
  if (outline) renderOutliner();
}

// Every file the map holds, in the order the folders were built.
function outlineFiles(): FileSpot[]
{
  return pathIndex().ordered;
}

/** The name a group row or filter chip shows for one value on an axis. */
function groupLabel(axis: GroupAxis, value: string): string
{
  if (axis === "system") return systemLabel(value);
  if (axis === "layer") return value === "" ? "no layer" : labelFor(value);
  return value === "" ? "(root)" : value + "/";
}

/** The colour swatch a group row or filter chip shows. */
function groupColor(axis: GroupAxis, value: string): string
{
  if (axis === "system") return colorForSystem(value);
  if (axis === "layer") return value === "" ? "#6e7681" : colorFor(value);
  return folderColor(value === "" ? "" : value + "/x");
}

// Whether the repository has any systems yet. Until it does, the System grouping and its chips
// would only name "unassigned", so both stay out of the panel.
function hasSystems(): boolean
{
  return S.SYSTEMS.length > 0 || [...S.FILE_SYSTEMS.values()].some((value) => value !== "");
}

// Whether the repository declares any layers. Until it does, the Layer grouping and its chips
// would only name "no layer", so both stay out of the panel.
function hasLayers(): boolean
{
  return S.LAYERS.length > 0;
}

/** The values on one axis, in the repository's declared order with unassigned last. */
function groupKeys(axis: GroupAxis, present: string[]): string[]
{
  const known = axis === "system" ? S.SYSTEMS : axis === "layer" ? S.LAYERS : [...present].sort();
  const ordered = known.filter((value) => present.includes(value));
  for (const value of present) if (!ordered.includes(value)) ordered.push(value);
  return ordered.filter((value, index) => ordered.indexOf(value) === index);
}

/** The set a filter chip switches: the systems or layers the strip has selected. */
export function sliceSet(axis: GroupAxis): Set<string>
{
  return axis === "system" ? S.outliner.systems : S.outliner.layers;
}

// Whether a file is drawn for the strip's purposes, ignoring one slice so that slice can count its
// own values. A folder eye or Extras being off keeps a file out of the count, as it does the scene.
function passesSlices(path: string, skip: GroupAxis | null, eyes = true, crossed = true): boolean
{
  if (eyes && !isFileVisible(path)) return false;
  if (!crossed) return matchesTagFilter(path);
  return passesSlice(path, skip) && matchesTagFilter(path);
}

/** Whether a search names this file: each word appears in its path or in one of its symbols. */
function matchesQuery(item: FileSpot, terms: string[]): boolean
{
  return matchesQueryTerms(item.path, S.FILE_SYMBOLS.get(item.path) ?? [], terms);
}

/** The files the outliner shows: those that pass every filter and, if asked, the search. */
function shownFiles(terms: string[]): FileSpot[]
{
  return outlineFiles().filter((item) => matchesFilters(item.path) && matchesQuery(item, terms));
}

// Wraps every part of a label a search matched, so the reason a row is listed is visible.
function markQuery(text: string, terms: string[]): string
{
  if (terms.length === 0) return escapeHtml(text);
  const pattern = new RegExp(terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  let out = "", last = 0;
  for (const match of text.matchAll(pattern))
  {
    if (match[0] === "") continue;
    out += escapeHtml(text.slice(last, match.index)) + "<mark>" + escapeHtml(match[0]) + "</mark>";
    last = match.index! + match[0].length;
  }
  return out + escapeHtml(text.slice(last));
}

// Small line icons for the row actions, drawn in the text colour so hover and dimming carry over.
const ICON_EYE = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8z"/><circle cx="8" cy="8" r="2"/></svg>';
const ICON_EYE_OFF = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.5 5.5C4 4.2 5.8 3.5 8 3.5c4.1 0 6.5 4.5 6.5 4.5s-.7 1.3-2 2.6M10 12.2c-.6.2-1.3.3-2 .3-4.1 0-6.5-4.5-6.5-4.5s.5-.9 1.4-1.9"/><path d="M2 2l12 12"/></svg>';

/** How much of a row is drawn in the scene: all of it, some of it, or none. */
type Seen = "all" | "some" | "none";

// The eye that hides a row in the scene: it shows on hover, and stays put while the row is hidden
// or only partly shown.
function eyeButton(key: string, seen: Seen): string
{
  const label = seen === "all" ? "Hide in the scene" : seen === "some" ? "Some files are hidden; hide the rest" : "Show in the scene";
  return '<button type="button" tabindex="-1" class="oicon oeye' + (seen === "none" ? " on" : seen === "some" ? " part" : "") +
    '" data-eye="' + escapeHtml(key) + '" title="' + label + '" aria-label="' + label + '">' +
    (seen === "none" ? ICON_EYE_OFF : ICON_EYE) + "</button>";
}

// For each folder, how many of the files beneath it the eyes leave visible, counted once per render.
let folderSeen = new Map<string, { visible: number; total: number }>();
function countFolderSeen(): void
{
  folderSeen = new Map();
  for (const item of outlineFiles())
  {
    const visible = isFileVisible(item.path) ? 1 : 0;
    for (let dir = folderOf(item.path); dir !== ""; dir = folderOf(dir))
    {
      const entry = folderSeen.get(dir);
      if (entry) { entry.total++; entry.visible += visible; }
      else folderSeen.set(dir, { visible, total: 1 });
    }
  }
}

// Whether a folder row's files are all, partly, or not at all drawn, as far as the eyes go.
function folderState(value: string): Seen
{
  const entry = folderSeen.get(value);
  if (!entry || entry.visible === 0) return "none";
  return entry.visible === entry.total ? "all" : "some";
}

// The folder block a folder row stands for, or -1 when the map has none by that name.
function folderNode(value: string): number
{
  return S.NODES.findIndex((node) => node.id === value);
}

// Which group rows are folded while a search is typed. A search opens every group so its matches
// show, but a fold made during it still works; this set is dropped when the search changes.
const searchFolds = new Set<string>();
let searchFoldsFor = "";

// The folds that apply right now: the search's own while one is typed, otherwise the tree's.
function activeFolds(): Set<string>
{
  return S.outliner.query.trim() === "" ? S.outliner.collapsed : searchFolds;
}

function isFolded(key: string): boolean
{
  return activeFolds().has(key);
}

// Folds or opens one group row; with `deep`, every group beneath it follows.
function toggleFold(key: string, deep = false): void
{
  const folds = activeFolds();
  const fold = !folds.has(key);
  const keys = deep && key.startsWith("folder:") ? [key, ...allFolderKeys().filter((path) => path.startsWith(key.slice(7) + "/")).map((path) => "folder:" + path)] : [key];
  for (const one of keys) { if (fold) folds.add(one); else folds.delete(one); }
  renderOutliner();
}

// A group row. Folder rows choose their folder in the scene when clicked and carry an eye, since the
// filter strip does not cover folders; system and layer rows fold, and their chips sit above the tree.
function groupRow(axis: GroupAxis, value: string, count: number, depth: number, folded: boolean, name = groupLabel(axis, value)): string
{
  const key = axis + ":" + value;
  const seen = axis === "folder" ? folderState(value) : "all";
  const node = axis === "folder" ? folderNode(value) : -1;
  const chosen = node >= 0 && S.selected === node && S.selectedFile < 0;
  return '<div class="orow grp' + (seen === "none" ? " off" : "") + (chosen ? " sel" : "") + '" data-fold="' + escapeHtml(key) + '" data-key="' +
    escapeHtml(key) + '"' + (node >= 0 ? ' data-folder="' + escapeHtml(value) + '"' : "") + ' data-depth="' + depth + '" style="--depth:' + depth + '"' +
    ' role="treeitem" tabindex="-1" aria-expanded="' + String(!folded) + '"' + (chosen ? ' aria-selected="true"' : "") + ">" +
    '<span class="ocaret' + (folded ? "" : " open") + '" data-caret title="' + (folded ? "Open" : "Fold") + ' (Alt-click for everything inside)" aria-hidden="true"></span>' +
    '<span class="odot" style="background:' + groupColor(axis, value) + '"></span>' +
    '<span class="oname" title="' + escapeHtml(axis + ": " + groupLabel(axis, value)) + '">' + escapeHtml(name) + "</span>" +
    '<span class="onum">' + count + "</span>" +
    (axis === "folder" ? eyeButton(key, seen) : "") +
    "</div>";
}

// One coloured dot on a file row: its system or layer, clickable to show only that value.
function sliceDot(axis: GroupAxis, value: string): string
{
  return '<button type="button" tabindex="-1" class="odot oswitch" data-slice="' + axis + '" data-value="' + escapeHtml(value) + '" title="' +
    escapeHtml("Show only " + axis + ": " + groupLabel(axis, value)) + '" aria-label="Filter to this ' + axis + '" style="background:' +
    groupColor(axis, value) + '"></button>';
}

// The dots that name where a file sits, tied to the strip's colours.
function fileDots(path: string): string
{
  const system = S.FILE_SYSTEMS.get(path) ?? "";
  const layer = S.FILE_LAYERS.get(path) ?? "";
  return '<span class="odots">' +
    (hasSystems() ? sliceDot("system", system) : "") +
    (layer !== "" ? sliceDot("layer", layer) : "") +
    "</span>";
}

// One file row: its name, the tag it roles as, the dots for its system and layer, and its eye.
function fileRow(item: FileSpot, depth: number, terms: string[]): string
{
  const hidden = !isFileVisible(item.path);
  const chosen = (S.selected === item.node && S.selectedFile === item.file) || S.extraFiles.has(item.path);
  const tag = S.FILE_TAGS.get(item.path)?.[0];
  const tagBadge = tag
    ? '<span class="otag" data-tag="' + escapeHtml(tag) + '" title="' + (S.tagFilter === tag ? "Stop filtering to this tag" : "Filter to this tag") + '">' + escapeHtml(tag) + "</span>"
    : "";
  // In the folder tree the name is enough; a flat system or layer group shows the whole path.
  const name = S.outliner.group === "folder" ? item.path.split("/").pop()! : item.path;
  const summary = S.FILE_SUMMARIES.get(item.path);
  let html = '<div class="orow file' + (hidden ? " off" : "") + (chosen ? " sel" : "") + '" data-path="' + escapeHtml(item.path) +
    '" data-key="' + escapeHtml("file:" + item.path) + '" data-depth="' + depth + '" style="--depth:' + depth + '" role="treeitem" tabindex="-1"' +
    (chosen ? ' aria-selected="true"' : "") + ">" +
    '<span class="ocaret" aria-hidden="true"></span><span class="oname" title="' + escapeHtml(item.path + (summary ? "\n" + summary : "")) + '">' +
    markQuery(name, terms) + "</span>" +
    '<span class="ofilemeta">' + tagBadge + fileDots(item.path) + "</span>" +
    eyeButton("file:" + item.path, hidden ? "none" : "all") + "</div>";
  if (terms.length > 0)
  {
    const names = (S.FILE_SYMBOLS.get(item.path) ?? []).filter((symbol) => terms.some((term) => symbol.toLowerCase().includes(term))).slice(0, 6);
    for (const symbol of names)
    {
      html += '<div class="orow" data-depth="' + (depth + 1) + '" style="--depth:' + (depth + 1) + '" data-symbol="' + escapeHtml(symbol) +
        '" data-symbolpath="' + escapeHtml(item.path) + '" data-key="' + escapeHtml("sym:" + item.path + "#" + symbol) +
        '" role="treeitem" tabindex="-1"><span class="ocaret"></span><span class="osym">ƒ ' + markQuery(symbol, terms) + "</span></div>";
    }
  }
  return html;
}

/** One folder in the nested folder tree: the files directly in it, and the folders beneath it. */
interface FolderNode { path: string; files: FileSpot[]; children: Map<string, FolderNode>; total: number }

// Builds the folder tree the files sit in, so each folder row holds its own files and sub-folders.
function folderTree(files: FileSpot[]): FolderNode
{
  const root: FolderNode = { path: "", files: [], children: new Map(), total: 0 };
  for (const item of files)
  {
    let node = root;
    node.total++;
    const dir = folderOf(item.path);
    if (dir !== "")
    {
      let path = "";
      for (const part of dir.split("/"))
      {
        path = path === "" ? part : path + "/" + part;
        let next = node.children.get(part);
        if (!next) { next = { path, files: [], children: new Map(), total: 0 }; node.children.set(part, next); }
        node = next;
        node.total++;
      }
    }
    node.files.push(item);
  }
  return root;
}

// Draws the folders beneath one node, then its own files. A folder that holds no files itself and
// only one sub-folder is joined with it into one row (src/navigation/), so the tree has no empty hops.
function folderLevel(node: FolderNode, depth: number, terms: string[]): string
{
  let html = "";
  for (const [part, child] of [...node.children].sort(([a], [b]) => a.localeCompare(b)))
  {
    let shown = child, name = part;
    while (shown.files.length === 0 && shown.children.size === 1)
    {
      const [[nextPart, next]] = [...shown.children];
      name += "/" + nextPart;
      shown = next;
    }
    const folded = isFolded("folder:" + shown.path);
    html += groupRow("folder", shown.path, shown.total, depth, folded, name + "/");
    if (!folded) html += folderLevel(shown, depth + 1, terms);
  }
  return html + [...node.files].sort((a, b) => a.path.split("/").pop()!.localeCompare(b.path.split("/").pop()!)).map((item) => fileRow(item, depth, terms)).join("");
}

// Draws files flat under one row per system or layer value, folding each group as a whole.
function groupedLevel(files: FileSpot[], axis: GroupAxis, depth: number, terms: string[]): string
{
  const buckets = new Map<string, FileSpot[]>();
  for (const item of files)
  {
    const value = sliceValue(item.path, axis);
    const bucket = buckets.get(value);
    if (bucket) bucket.push(item);
    else buckets.set(value, [item]);
  }
  let html = "";
  for (const value of groupKeys(axis, [...buckets.keys()]))
  {
    const bucket = buckets.get(value)!.sort((a, b) => a.path.localeCompare(b.path));
    const folded = isFolded(axis + ":" + value);
    html += groupRow(axis, value, bucket.length, depth, folded);
    if (!folded) html += bucket.map((item) => fileRow(item, depth + 1, terms)).join("");
  }
  return html;
}

// The filter strip: one switch per system and per layer, each with a live count. A value is on
// when the strip holds no selection (everything) or when it is one of the selected values.
function renderFilterStrip(): void
{
  const files = outlineFiles();
  const anyShown: boolean[] = [];
  for (const axis of ["system", "layer"] as GroupAxis[])
  {
    const group = document.getElementById("filter-group-" + axis);
    const row = document.getElementById("filter-" + axis);
    if (!group || !row) continue;
    const absent = (axis === "system" && !hasSystems()) || (axis === "layer" && !hasLayers());
    const present = absent ? [] : [...new Set(files.map((item) => sliceValue(item.path, axis)))];
    const keys = groupKeys(axis, present);
    const selected = sliceSet(axis);
    const all = selected.size === 0;
    // What each value holds under the other axis's selection: drawn, and before the eyes hide any.
    // "reach" ignores the other strip too: a value can be switched on whenever it has files to draw,
    // since switching it on brings the other strip's values it needs along with it.
    const counts = new Map<string, number>(), held = new Map<string, number>(), reach = new Map<string, number>();
    const bump = (map: Map<string, number>, value: string) => map.set(value, (map.get(value) ?? 0) + 1);
    for (const item of files)
    {
      const value = sliceValue(item.path, axis);
      if (passesSlices(item.path, axis, false)) bump(held, value);
      if (passesSlices(item.path, axis)) bump(counts, value);
      if (passesSlices(item.path, axis, true, false)) bump(reach, value);
    }
    const other = axis === "system" ? "layer" : "system";
    row.innerHTML = keys.map((value) =>
    {
      const count = counts.get(value) ?? 0;
      const on = all || selected.has(value);
      // A value with nothing to draw cannot be switched on, since it would only empty the scene.
      // One that is already selected stays clickable, so it can always be switched off again.
      const unavailable = (reach.get(value) ?? 0) === 0 && !selected.has(value);
      // Off for now only because of the other strip: clicking it brings in what it needs.
      const crossing = !unavailable && count === 0 && !selected.has(value);
      const label = groupLabel(axis, value);
      const why = (held.get(value) ?? 0) > 0 && (reach.get(value) ?? 0) === 0 ? "its files are hidden in the scene (an eye, or Extras off)"
        : S.tagFilter !== null ? "no files in it carry the tag " + S.tagFilter
        : sliceSet(other).size > 0 ? "no files in it are in the selected " + other + "s"
        : "it holds no files";
      const title = unavailable ? label + ": nothing to show — " + why
        : crossing ? "Also show " + axis + ": " + label + " — also switches on its " + other + "s"
        : on ? "Hide " + axis + ": " + label + (count === 0 ? " — " + why : "") + " (double-click: show only this)"
        : "Also show " + axis + ": " + label + " (double-click: show only this)";
      return '<button type="button" class="fchip' + (on && !unavailable && !crossing ? " on" : "") + (unavailable ? " empty" : "") + (crossing ? " cross" : "") + (on && !unavailable && count === 0 ? " zero" : "") +
        '" data-slice="' + axis + '" data-value="' + escapeHtml(value) + '" aria-pressed="' + String(on && !unavailable && !crossing) + '"' +
        (unavailable ? ' aria-disabled="true"' : "") + ' style="--c:' +
        groupColor(axis, value) + '" title="' + escapeHtml(title) + '">' +
        '<span class="fdot"></span><span class="fname">' + escapeHtml(label) + '</span><span class="fcount">' + count + "</span></button>";
    }).join("");
    group.hidden = keys.length === 0;
    anyShown.push(keys.length > 0);
  }
  const strip = document.getElementById("outliner-filters");
  if (strip) strip.hidden = !anyShown.some(Boolean);
}

// The rows for filters that live outside the strip: an ad-hoc isolation, and the tag filter.
function renderChips(): void
{
  const chips: string[] = [];
  if (S.isolatedFiles !== null)
    chips.push('<span class="ochip"><b>isolate</b><span>' + S.isolatedFiles.size + (S.isolatedFiles.size === 1 ? " file" : " files") + '</span><button type="button" data-chip="isolate" title="Remove this filter" aria-label="Remove this filter">✕</button></span>');
  if (S.tagFilter !== null)
    chips.push('<span class="ochip"><b>tag</b><span>' + escapeHtml(S.tagFilter) + '</span><button type="button" data-chip="tag" title="Remove this filter" aria-label="Remove this filter">✕</button></span>');
  const box = document.getElementById("outliner-chips")!;
  box.innerHTML = chips.join("");
  box.hidden = chips.length === 0;
}

// The counts: how many files the tree lists, and how many of all files the scene draws.
function renderCounts(shown: number): void
{
  const files = outlineFiles();
  const inScene = files.filter((item) => isInScene(item.path)).length;
  const listed = document.getElementById("outliner-count");
  if (listed) listed.textContent = shown === files.length ? String(files.length) : shown + " / " + files.length;
  const note = document.getElementById("outliner-file-count");
  if (note) note.textContent = inScene + " of " + files.length + " in scene";
  const clear = document.getElementById("outliner-clear");
  if (clear) clear.hidden = S.outliner.query === "" && !hasFilters() && S.outliner.collapsed.size === 0;
  const fold = document.getElementById("outliner-collapse");
  if (fold)
  {
    const expand = allFolded();
    const label = expand ? "Open every group" : "Fold every group";
    fold.classList.toggle("expand", expand);
    fold.title = label;
    fold.setAttribute("aria-label", label);
  }
}

// Whether an eye hides this file, or a folder above it. Extras being off does not count.
function isEyeHidden(path: string): boolean
{
  if (S.outliner.shownFiles.has(path)) return false;
  if (S.outliner.hiddenFiles.has(path)) return true;
  return ancestorFolders(path).some((folder) => S.hiddenFolders.has(folder));
}

// The group rows that must stay open so an eye-hidden file or folder stays listed: a hidden
// file keeps its folder's chain open, and a hidden folder keeps its parent's chain open.
function groupsStayingOpen(): Set<string>
{
  const stay = new Set<string>();
  for (const folder of foldersToKeepOpen(S.outliner.hiddenFiles, S.hiddenFolders)) stay.add("folder:" + folder);
  for (const item of outlineFiles())
  {
    if (!isEyeHidden(item.path)) continue;
    for (const axis of ["system", "layer"] as GroupAxis[]) stay.add(axis + ":" + sliceValue(item.path, axis));
  }
  return stay;
}

// Every folder path the folder tree can fold.
function allFolderKeys(): string[]
{
  const paths = new Set<string>();
  for (const item of outlineFiles())
  {
    let dir = folderOf(item.path);
    while (dir !== "") { paths.add(dir); dir = folderOf(dir); }
  }
  return [...paths];
}

// The fold keys of every group the current listing can show.
function groupFoldKeys(): string[]
{
  if (S.outliner.group === "folder") return allFolderKeys().map((path) => "folder:" + path);
  const axis = S.outliner.group;
  return [...new Set(outlineFiles().map((item) => axis + ":" + sliceValue(item.path, axis)))];
}

// The group rows a fold-all may close: those that do not hold an eye-hidden item.
function foldableGroupKeys(): string[]
{
  const stay = groupsStayingOpen();
  return groupFoldKeys().filter((key) => !stay.has(key));
}

// Whether every group a fold-all may close is folded, so the button should open them instead.
function allFolded(): boolean
{
  const keys = foldableGroupKeys();
  if (keys.length === 0) return false;
  const folds = activeFolds();
  return keys.every((key) => folds.has(key));
}

// Folds every group in the tree, or, when they are all folded already, opens every one again.
// A group holding an eye-hidden file or folder stays open, so the hidden row is never lost.
function collapseAllOutliner(): void
{
  const folds = activeFolds();
  const stay = groupsStayingOpen();
  if (allFolded()) folds.clear();
  else
  {
    for (const key of groupFoldKeys()) folds.delete(key);
    for (const key of groupFoldKeys()) if (!stay.has(key)) folds.add(key);
  }
  renderOutliner();
}

// Opens the groups that hold a file or folder, so a choice made in the scene is never folded out of sight.
function revealInOutliner(path: string, isFolder: boolean): void
{
  if (S.outliner.group === "folder")
  {
    for (let dir = folderOf(path); dir !== ""; dir = folderOf(dir))
    {
      S.outliner.collapsed.delete("folder:" + dir);
      searchFolds.delete("folder:" + dir);
    }
    return;
  }
  if (isFolder) return;
  const key = S.outliner.group + ":" + sliceValue(path, S.outliner.group);
  S.outliner.collapsed.delete(key);
  searchFolds.delete(key);
}

// The file or folder last brought into view, so the tree scrolls to a new choice once and then leaves the scroll alone.
let revealedPath: string | null = null;

// The row the keyboard sits on, kept by key so it survives the tree being redrawn.
let focusKey: string | null = null;

/** Which row the tree's keyboard focus rests on, by its data-key; the next render restores it. */
function setOutlinerFocus(key: string | null): void
{
  focusKey = key;
}

// Fills the filter strip and the one tree, which lists files by folder or flat under a system or layer.
function renderOutliner(): void
{
  const terms = queryTerms(S.outliner.query);
  const joined = terms.join(" ");
  if (joined !== searchFoldsFor) { searchFolds.clear(); searchFoldsFor = joined; }
  const chosenFile = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
  const chosenFolder = S.selected >= 0 && S.selectedFile < 0 && S.NODES[S.selected] ? S.NODES[S.selected].id : null;
  const chosen = chosenFile ?? (chosenFolder !== null && chosenFolder !== "" ? chosenFolder + "/" : null);
  if (S.outliner.group === "system" && !hasSystems()) S.outliner.group = "folder";
  if (S.outliner.group === "layer" && !hasLayers()) S.outliner.group = "folder";
  if (chosen !== null && chosen !== revealedPath) revealInOutliner(chosenFile ?? chosenFolder!, chosenFile === null);
  const files = shownFiles(terms);
  countFolderSeen();

  document.querySelectorAll<HTMLInputElement>("[data-group]").forEach((box) =>
  {
    box.checked = box.dataset.group === S.outliner.group;
    box.disabled = (box.dataset.group === "system" && !hasSystems()) || (box.dataset.group === "layer" && !hasLayers());
  });

  const tree = document.getElementById("outliner-tree");
  if (tree)
  {
    const hadFocus = tree.contains(document.activeElement);
    const scroll = tree.scrollTop;
    const why = S.NODES.length === 0 ? "No files yet."
      : terms.length > 0 ? "Nothing matches “" + escapeHtml(S.outliner.query.trim()) + "”." : "Nothing matches these filters.";
    const empty = '<p class="oempty">' + why + "</p>";
    tree.innerHTML = S.outliner.group === "folder"
      ? folderLevel(folderTree(files), 0, terms) || empty
      : groupedLevel(files, S.outliner.group, 0, terms) || empty;
    tree.scrollTop = scroll;

    // One row takes Tab at a time: the one the keyboard was on, else the chosen one, else the first.
    const rows = [...tree.querySelectorAll<HTMLElement>(".orow")];
    const current = (focusKey !== null ? rows.find((row) => row.dataset.key === focusKey) : undefined) ??
      tree.querySelector<HTMLElement>(".orow.sel") ?? rows[0];
    if (current)
    {
      current.tabIndex = 0;
      focusKey = current.dataset.key ?? null;
      if (hadFocus) current.focus({ preventScroll: true });
    }
    if (chosen !== revealedPath)
    {
      revealedPath = chosen;
      tree.querySelector(".orow.sel")?.scrollIntoView({ block: "nearest" });
    }
  }
  renderFilterStrip();
  renderChips();
  renderCounts(files.length);
}

/* ------------------------------------------------------ outliner panel ---- */

// The outliner can be put away, leaving a narrow tab at the right edge that brings it back.
// The choice is remembered per browser, so a reload leaves the panel where it was left.
const OutlinerHiddenKey = "codespace.outliner.hidden";

function setOutlinerHidden(hidden: boolean): void
{
  document.body.classList.toggle("outliner-hidden", hidden);
  const tab = document.getElementById("outliner-show");
  const close = document.getElementById("outliner-hide");
  if (tab) tab.hidden = !hidden;
  if (close) close.setAttribute("aria-expanded", String(!hidden));
  try { localStorage.setItem(OutlinerHiddenKey, hidden ? "1" : "0"); }
  catch { /* storage can be off, and the panel still collapses for this visit */ }
}

/** Brings the outliner back, for a shortcut that needs its search box. */
export function revealOutliner(): void
{
  if (document.body.classList.contains("outliner-hidden")) setOutlinerHidden(false);
}

document.getElementById("outliner-hide")?.addEventListener("click", () => setOutlinerHidden(true));
document.getElementById("outliner-show")?.addEventListener("click", () => setOutlinerHidden(false));
try { if (localStorage.getItem(OutlinerHiddenKey) === "1") setOutlinerHidden(true); }
catch { /* storage can be off; the panel starts open */ }

export { collapseAllOutliner, escapeHtml, folderNode, select, selectFile, setOutlinerFocus, openSymbol, openFile, renderOutliner, toggleFold };
