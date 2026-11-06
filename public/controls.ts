import { S, V3, camera, DEFAULT_ALPHA, filePath, glow, render, renderEdges, extraFolderIds, isExtraFolder } from "./state.js";
import { build } from "./city.js";
import { centerView, recenterTarget, pulseFile } from "./meshes.js";
import { escapeHtml, select, selectFile, openSymbol, renderLegend, renderHierarchy } from "./panels.js";
import { labelOf, loadFingerprint, loadGraph } from "./repo.js";
import type { ColorBy } from "./types.js";

// Fetches the live graph and, only when it has actually changed, redraws it.
async function refreshGraph(force = false): Promise<void>
{
  if (refreshing) return;
  refreshing = true;
  try
  {
    // The fingerprint costs one stat per file; when it has not moved, there is nothing to read.
    const stamp = await loadFingerprint();
    if (!force && stamp !== null && stamp === S.fingerprint) return;

    let graph;
    try
    {
      graph = await loadGraph();
    }
    catch (error) { return; }
    if (graph.nodes.length === 0) return;
    S.fingerprint = stamp ?? S.fingerprint;

    const signature = JSON.stringify(graph.nodes.map((node) => node.id + ":" + node.files.length)) +
      JSON.stringify(graph.edges) + JSON.stringify(graph.fileEdges) + JSON.stringify([...graph.lines]) +
      JSON.stringify([...graph.tags]) + JSON.stringify([...graph.summaries]) + JSON.stringify([...graph.layers]) +
      JSON.stringify([...graph.changes]) + JSON.stringify(graph.layerOrder) + JSON.stringify(graph.notes) +
      ":" + S.hiddenFiles;
    if (signature === S.graphSignature) return;
    S.graphSignature = signature;

    // What is chosen now, so the choice survives the redraw if it is still there.
    const keptFolder = S.selected >= 0 ? S.NODES[S.selected].id : null;
    const keptFile = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
    // What each file held before, so a file that changed while Live is on can be marked.
    const previousLines = S.FILE_LINES;
    S.NODES = graph.nodes;
    S.EDGES = graph.edges;
    S.FILE_EDGES = graph.fileEdges;
    S.FILE_LINES = graph.lines;
    S.FILE_TAGS = graph.tags;
    S.FILE_LAYERS = graph.layers;
    S.FILE_SUMMARIES = graph.summaries;
    S.FILE_SYMBOLS = graph.symbols;
    S.FILE_CHANGES = graph.changes;
    S.ARCH_NOTES = graph.notes;
    S.LAYERS = graph.layerOrder !== null ? graph.layerOrder : [...new Set(graph.layers.values())].sort();
    spreadSlider.value = String(S.layerGap);
    spreadCaption.hidden = spreadSlider.hidden = S.LAYERS.length === 0;
    renderLegend();
    S.selected = -1;
    S.selectedFile = -1;
    S.focusSet = null;
    if (!S.hasCentered) applyExtrasToggle();
    build();
    if (!S.hasCentered) { centerView(true); S.hasCentered = true; }
    // A file whose line count moved since the last poll gets a ring on its folder's floor.
    if (previousLines.size > 0)
    {
      for (const [path, count] of graph.lines)
      {
        const before = previousLines.get(path);
        if (before === undefined || before !== count) pulseFile(path);
      }
    }
    const folder = keptFolder === null ? -1 : S.NODES.findIndex((n) => n.id === keptFolder);
    const file = folder >= 0 && keptFile !== null ? S.NODES[folder].files.findIndex((name, i) => filePath(folder, i) === keptFile) : -1;
    if (file >= 0) selectFile(folder, file);
    else select(folder);
    renderHierarchy();
    window.dispatchEvent(new Event("codespace:built"));
  }
  finally
  {
    refreshing = false;
  }
}

// One refresh at a time; a poll that lands while a read is underway is dropped, not stacked.
let refreshing = false;

document.getElementById("refresh")!.addEventListener("click", () => { S.graphSignature = ""; refreshGraph(true); });
document.getElementById("live")!.addEventListener("click", (event) =>
{
  S.liveOn = !S.liveOn;
  const target = event.target as HTMLElement;
  target.textContent = "Live: " + (S.liveOn ? "on" : "off");
  target.classList.toggle("on", S.liveOn);
});
setInterval(() => { if (S.liveOn && !document.hidden) refreshGraph(); }, 15000);

/* ------------------------------------------------------- the search ---- */

/** One thing search can open: a folder, a file, or a symbol inside a file. */
interface Hit { path: string; kind: "folder" | "file" | "symbol"; label: string; sub: string }

const searchInput = document.getElementById("search") as HTMLInputElement;
const resultsList = document.getElementById("search-results") as HTMLElement;
let hits: Hit[] = [];
let activeHit = 0;

// How well a hit matches the query: a name that starts with it wins over one that merely contains it.
function score(hit: Hit, query: string): number
{
  const label = hit.label.toLowerCase();
  return (label.startsWith(query) ? 3 : label.includes(query) ? 2 : 1) +
    (hit.kind === "symbol" ? 0.5 : hit.kind === "file" ? 0.4 : 0);
}

// Every folder, file, and declared symbol whose name contains the query, best matches first.
function findHits(query: string): Hit[]
{
  const q = query.trim().toLowerCase();
  if (q === "") return [];
  const found: Hit[] = [];
  const seen = new Set<string>();
  S.NODES.forEach((n, nodeIndex) =>
  {
    if (n.id !== "" && n.id.toLowerCase().includes(q)) found.push({ path: n.id, kind: "folder", label: labelOf(n), sub: n.id });
    n.files.forEach((name, fileIndex) =>
    {
      const path = filePath(nodeIndex, fileIndex);
      if (!path.toLowerCase().includes(q) || seen.has(path)) return;
      seen.add(path);
      found.push({ path, kind: "file", label: name, sub: n.id || "(root)" });
    });
  });
  for (const [path, names] of S.FILE_SYMBOLS)
  {
    for (const name of names)
    {
      if (!name.toLowerCase().includes(q)) continue;
      const key = path + "\u0001" + name;
      if (seen.has(key)) continue;
      seen.add(key);
      found.push({ path, kind: "symbol", label: name, sub: path });
    }
  }
  return found.sort((a, b) => score(b, q) - score(a, q) || a.label.length - b.label.length).slice(0, 40);
}

function renderHits(): void
{
  resultsList.hidden = hits.length === 0;
  resultsList.innerHTML = hits.map((hit, index) =>
    '<li class="hit' + (index === activeHit ? " active" : "") + '" data-i="' + index + '">' +
      '<span class="hit-kind">' + hit.kind + "</span>" +
      "<span>" + escapeHtml(hit.label) + "</span>" +
      '<small>' + escapeHtml(hit.sub) + "</small></li>").join("");
  const active = resultsList.children[activeHit] as HTMLElement | undefined;
  if (active) active.scrollIntoView({ block: "nearest" });
}

function searchChanged(): void
{
  hits = findHits(searchInput.value);
  activeHit = 0;
  renderHits();
}

function closeSearch(): void
{
  hits = [];
  resultsList.hidden = true;
  resultsList.innerHTML = "";
  searchInput.value = "";
}

function openSearch(): void
{
  searchInput.focus();
  searchInput.select();
  searchChanged();
}

// Finds the folder and file index of a path, whichever folder holds it.
function locateFile(path: string): [number, number]
{
  for (let nodeIndex = 0; nodeIndex < S.NODES.length; nodeIndex++)
  {
    const fileIndex = S.NODES[nodeIndex].files.findIndex((_, i) => filePath(nodeIndex, i) === path);
    if (fileIndex >= 0) return [nodeIndex, fileIndex];
  }
  return [-1, -1];
}

// Opens a hit: a folder is chosen, a file is chosen and framed, and a symbol also opens its code.
function openHit(hit: Hit): void
{
  closeSearch();
  searchInput.blur();
  if (hit.kind === "folder")
  {
    select(S.NODES.findIndex((n) => n.id === hit.path));
    return;
  }
  const [nodeIndex, fileIndex] = locateFile(hit.path);
  if (nodeIndex < 0) return;
  selectFile(nodeIndex, fileIndex);
  if (hit.kind === "symbol") openSymbol(hit.path, hit.label);
}

searchInput.addEventListener("input", searchChanged);
searchInput.addEventListener("keydown", (event) =>
{
  if (event.key === "ArrowDown" || event.key === "ArrowUp")
  {
    event.preventDefault();
    if (hits.length === 0) return;
    activeHit = (activeHit + (event.key === "ArrowDown" ? 1 : -1) + hits.length) % hits.length;
    renderHits();
    return;
  }
  if (event.key === "Enter")
  {
    event.preventDefault();
    const hit = hits[activeHit];
    if (hit) openHit(hit);
    return;
  }
  if (event.key === "Escape") { event.preventDefault(); closeSearch(); searchInput.blur(); }
});
resultsList.addEventListener("mousedown", (event) =>
{
  const row = (event.target as HTMLElement).closest("[data-i]") as HTMLElement | null;
  if (!row) return;
  event.preventDefault();
  const hit = hits[Number(row.dataset.i)];
  if (hit) openHit(hit);
});

/* ---------------------------------------------------------- shortcuts ---- */

// Whether a keystroke is going into something the user is typing in, which keeps its keys.
function isTyping(target: EventTarget | null): boolean
{
  const element = target as HTMLElement | null;
  return !!element && (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) || element.isContentEditable);
}

function resetView(): void
{
  camera.alpha = DEFAULT_ALPHA;
  centerView(false);
  select(-1);
}

// Glides to the chosen folder or file, close enough to read it.
function frameSelection(): void
{
  if (S.selected < 0) return;
  if (S.selectedFile >= 0)
  {
    const rec = S.fileRecords.get(filePath(S.selected, S.selectedFile));
    if (rec) S.camGoal = { target: rec.target.clone(), radius: Math.min(camera.radius, 20) };
    return;
  }
  const n = S.NODES[S.selected];
  if (n.cx === undefined) return;
  const reach = Math.max(n.tileW ?? 8, n.tileD ?? 8);
  S.camGoal = { target: new V3(n.cx, n.topY!, n.cz!), radius: Math.max(8, reach * 0.9 + 6) };
}

// Steps through the chosen folder's files, wrapping at either end.
function stepFile(direction: number): void
{
  if (S.selected < 0) return;
  const n = S.NODES[S.selected];
  if (n.files.length === 0) return;
  const from = S.selectedFile < 0 ? (direction > 0 ? -1 : 0) : S.selectedFile;
  selectFile(S.selected, (from + direction + n.files.length) % n.files.length);
}

const helpPanel = document.getElementById("help") as HTMLElement;
function toggleHelp(): void { helpPanel.hidden = !helpPanel.hidden; }
document.getElementById("help-btn")!.addEventListener("click", toggleHelp);

document.addEventListener("keydown", (event) =>
{
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k")
  {
    event.preventDefault();
    openSearch();
    return;
  }
  if (isTyping(event.target))
  {
    if (event.key === "Escape") closeSearch();
    return;
  }
  if (event.key === "/") { event.preventDefault(); openSearch(); return; }
  if (event.key === " ") { event.preventDefault(); setSpin(!S.autoSpin); return; }
  if (event.key === "r" || event.key === "R") { resetView(); return; }
  if (event.key === "f" || event.key === "F") { frameSelection(); return; }
  if (event.key === "[") { stepFile(-1); return; }
  if (event.key === "]") { stepFile(1); return; }
  if (event.key === "?") { event.preventDefault(); toggleHelp(); return; }
  if (event.key === "Escape")
  {
    helpPanel.hidden = true;
    if (S.tagFilter !== null) { S.tagFilter = null; renderLegend(); renderFilter(); renderEdges(); return; }
    select(-1);
  }
});

/* ------------------------------------------------- bottom controls ---- */

// The spread slider: the gap between layer planes. It only shows when the repository has layers.
// The builds it triggers are heavy, so a burst of slider events redraws once per frame at most.
const spreadSlider = document.getElementById("spread") as HTMLInputElement;
const spreadCaption = document.querySelector('label[for="spread"]') as HTMLElement;
let spreadFrame = 0;
spreadSlider.addEventListener("input", () =>
{
  S.layerGap = Number(spreadSlider.value);
  if (spreadFrame !== 0) return;
  spreadFrame = requestAnimationFrame(() =>
  {
    spreadFrame = 0;
    build();
    recenterTarget();
  });
});

// What the boxes are coloured by: role, layer, folder, size, or recent changes.
const colorSelect = document.getElementById("colorby") as HTMLSelectElement;
colorSelect.addEventListener("change", () =>
{
  S.colorBy = colorSelect.value as ColorBy;
  render();
});

// Bloom is the page's only post-processing pass; switching it off removes its cost entirely.
// A software renderer starts with it off, and the button still lets that be changed.
const glowButton = document.getElementById("glow") as HTMLButtonElement;
function setGlow(on: boolean): void
{
  glow.isEnabled = on;
  glowButton.textContent = "Glow: " + (on ? "on" : "off");
  glowButton.classList.toggle("on", on);
}
glowButton.addEventListener("click", () => setGlow(!glow.isEnabled));
setGlow(glow.isEnabled);

// The chip that says the legend is filtering to one tag.
const filterChip = document.getElementById("tag-filter") as HTMLElement;
function renderFilter(): void
{
  filterChip.hidden = S.tagFilter === null;
  if (S.tagFilter !== null) filterChip.textContent = "filtering · " + S.tagFilter + " ✕";
}
filterChip.addEventListener("click", () =>
{
  S.tagFilter = null;
  renderLegend();
  renderFilter();
  renderEdges();
});
window.addEventListener("codespace:filter", renderFilter);

// On phones the folders panel collapses to its heading.
const hierarchyPanel = document.getElementById("hierarchy") as HTMLElement;
const hierarchyToggle = document.getElementById("hierarchy-toggle") as HTMLElement;
hierarchyToggle.addEventListener("click", () =>
{
  const collapsed = hierarchyPanel.classList.toggle("collapsed");
  hierarchyToggle.textContent = collapsed ? "Show" : "Hide";
  hierarchyToggle.setAttribute("aria-expanded", String(!collapsed));
});

// The folders panel lists the whole tree; a checkbox hides a folder and its subtree.
document.getElementById("hierarchy-tree")!.addEventListener("change", (event) =>
{
  const box = event.target as HTMLInputElement;
  if (!box || box.type !== "checkbox") return;
  const id = box.getAttribute("data-id");
  if (id === null) return;
  if (box.checked) S.hiddenFolders.delete(id);
  else S.hiddenFolders.add(id);
  build();
  recenterTarget();
  renderHierarchy();
});

// The caret on a row collapses or expands that folder's children in the panel.
// The extras toggle on a row moves the folder in or out of the extras set.
document.getElementById("hierarchy-tree")!.addEventListener("click", (event) =>
{
  const target = event.target as HTMLElement;
  const caret = target.closest("[data-caret]") as HTMLElement | null;
  if (caret !== null)
  {
    const id = caret.getAttribute("data-caret")!;
    if (S.collapsedFolders.has(id)) S.collapsedFolders.delete(id);
    else S.collapsedFolders.add(id);
    renderHierarchy();
    return;
  }
  const extra = target.closest("[data-extra]") as HTMLElement | null;
  if (extra !== null) toggleExtraFolder(extra.getAttribute("data-extra")!);
});

// Adds a folder to the extras, or takes it out, and applies the change at once.
function toggleExtraFolder(id: string): void
{
  if (isExtraFolder(id))
  {
    S.extraFolders.delete(id);
    S.plainFolders.add(id);
    S.hiddenFolders.delete(id);
  }
  else
  {
    S.plainFolders.delete(id);
    S.extraFolders.add(id);
    if (!S.extrasShown) S.hiddenFolders.add(id);
  }
  applyExtrasToggle();
  build();
  recenterTarget();
  renderHierarchy();
}

function setSpin(on: boolean): void
{
  S.autoSpin = on;
  const b = document.getElementById("spin")!;
  b.textContent = "Spin: " + (on ? "on" : "off");
  b.classList.toggle("on", on);
}
document.getElementById("spin")!.addEventListener("click", () => setSpin(!S.autoSpin));
document.getElementById("reset")!.addEventListener("click", resetView);
// Choosing something on the map stops the spin, so the page's button stays truthful.
window.addEventListener("codespace:spin", () => setSpin(S.autoSpin));

// Shows or hides the extras at once — tests, docs, scripts, assets, loose top-level
// files, and library code (dependencies and vendored folders). They start hidden so the
// map shows only the code that does the work. A folder is moved in or out of the set with
// the toggle on its row in the Folders panel.
function applyExtrasToggle(): void
{
  for (const id of extraFolderIds())
  {
    if (S.extrasShown) S.hiddenFolders.delete(id);
    else S.hiddenFolders.add(id);
  }
  const button = document.getElementById("tests")!;
  button.textContent = "Extras: " + (S.extrasShown ? "shown" : "hidden");
  button.classList.toggle("on", S.extrasShown);
}
document.getElementById("tests")!.addEventListener("click", () =>
{
  S.extrasShown = !S.extrasShown;
  applyExtrasToggle();
  build();
  centerView(false);
  renderHierarchy();
});

// While a big repository is only partly described, only the described files are drawn, so the
// map stays quick. This shows everything, or goes back to the described files.
function applyIngestToggle(): void
{
  const button = document.getElementById("ingested")!;
  button.textContent = "Undescribed: " + (S.ingestOnly ? "hidden" : "shown");
  button.classList.toggle("on", S.ingestOnly);
}
document.getElementById("ingested")!.addEventListener("click", () =>
{
  S.ingestOnly = !S.ingestOnly;
  applyIngestToggle();
  void refreshGraph(true);
});
window.addEventListener("codespace:built", applyIngestToggle);
applyIngestToggle();

/* ------------------------------------------------------- deep links ---- */

// The file or folder named in the address bar, if any, so a view can be shared or reloaded.
function pathFromHash(): string | null
{
  if (location.hash.length < 2) return null;
  try { return location.hash.slice(1).split("/").map((part) => decodeURIComponent(part)).join("/"); }
  catch { return null; }
}
function openPath(path: string): void
{
  const [nodeIndex, fileIndex] = locateFile(path);
  if (nodeIndex >= 0) { selectFile(nodeIndex, fileIndex); return; }
  select(S.NODES.findIndex((n) => n.id === path));
}
window.addEventListener("codespace:built", () =>
{
  const path = pathFromHash();
  if (path !== null && S.selected < 0) openPath(path);
  renderFilter();
});
window.addEventListener("hashchange", () =>
{
  const path = pathFromHash();
  if (path !== null) openPath(path);
});

export { setSpin, refreshGraph };
