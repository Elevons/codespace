import { S, camera, canvas, DEFAULT_ALPHA, filePath, frameBlock, frameFile, frameFolder, glow, hasFilters, isFileVisible, matchesTagFilter, render, renderEdges, fileIndex, pathIndex, sliceValue } from "./state.js";
import { api } from "./endpoint.js";
import { build, restack } from "./city.js";
import { centerView, recenterTarget, pulseFile } from "./meshes.js";
import { collapseAllOutliner, folderNode, select, selectFile, setOutlinerFocus, openSymbol, openFile, renderOutliner, renderSelection, revealOutliner, sliceSet, toggleFileSelection, toggleFold } from "./panels.js";
import { buildChanged, loadGraph } from "./repo.js";
import type { ColorBy, GroupAxis } from "./types.js";

function setToggleText(button: HTMLButtonElement, label: string, state: string): void
{
  button.replaceChildren(label);
  const tail = document.createElement("span");
  tail.className = "state";
  tail.textContent = state;
  button.append(tail);
}

// Fetches the live graph and, only when it has actually changed, redraws it.
async function refreshGraph(force = false): Promise<void>
{
  if (refreshing) return;
  refreshing = true;
  try
  {
    // Offering the stamp we hold lets the server answer an unchanged repository with no data.
    let graph;
    try
    {
      graph = await loadGraph(force || !S.fingerprint ? null : S.fingerprint);
    }
    catch (error) { if (S.liveOn) showLive("retry"); return; }
    if (S.liveOn) showLive("on");
    if (graph === null || graph.nodes.length === 0) return;
    S.fingerprint = graph.fingerprint;

    const signature = JSON.stringify(graph.nodes.map((node) => node.id + ":" + node.files.length)) +
      JSON.stringify(graph.edges) + JSON.stringify(graph.fileEdges) + JSON.stringify([...graph.lines]) +
      JSON.stringify([...graph.tags]) + JSON.stringify([...graph.summaries]) + JSON.stringify([...graph.layers]) +
      JSON.stringify([...graph.systems]) + JSON.stringify(graph.systemOrder) +
      JSON.stringify([...graph.symbols]) + JSON.stringify([...graph.changes]) +
      JSON.stringify(graph.layerOrder) + JSON.stringify(graph.notes) + JSON.stringify(graph.concepts) +
      ":" + S.undescribed;
    if (signature === S.graphSignature) return;
    S.graphSignature = signature;

    // What is chosen now, so the choice and the whole selection survive the redraw if they are still there.
    const keptFolder = S.selected >= 0 ? S.NODES[S.selected].id : null;
    const keptFile = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
    const keptExtras = [...S.extraFiles];
    // What each file held before, so a file that changed while Live is on can be marked.
    const previousLines = S.FILE_LINES;
    S.NODES = graph.nodes;
    S.EDGES = graph.edges;
    S.FILE_EDGES = graph.fileEdges;
    S.FILE_LINES = graph.lines;
    S.FILE_TAGS = graph.tags;
    S.FILE_LAYERS = graph.layers;
    S.FILE_SYSTEMS = graph.systems;
    S.FILE_SUMMARIES = graph.summaries;
    S.SYSTEMS = graph.systemOrder.length > 0 ? graph.systemOrder : [...new Set(graph.systems.values())].sort();
    S.FILE_SYMBOLS = graph.symbols;
    S.FILE_CHANGES = graph.changes;
    S.ARCH_NOTES = graph.notes;
    S.CONCEPTS = graph.concepts;
    S.LAYERS = graph.layerOrder !== null ? graph.layerOrder : [...new Set(graph.layers.values())].sort();
    spreadSlider.value = String(S.layerGap);
    spreadCaption.hidden = spreadSlider.hidden = S.LAYERS.length === 0;
    S.selected = -1;
    S.selectedFile = -1;
    S.focusSet = null;
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
    const file = folder >= 0 && keptFile !== null ? S.NODES[folder].files.findIndex((_name, i) => filePath(folder, i) === keptFile) : -1;
    if (file >= 0) selectFile(folder, file);
    else select(folder);
    // The other chosen files come back with it, unless they are gone from the repository.
    if (file >= 0 && keptExtras.length > 0)
    {
      for (const path of keptExtras) if (pathIndex().files.has(path)) S.extraFiles.add(path);
      renderSelection();
      renderEdges();
    }
    renderOutliner();
    window.dispatchEvent(new Event("codespace:built"));
  }
  finally
  {
    refreshing = false;
  }
}

// One refresh at a time; a poll that lands while a read is underway is dropped, not stacked.
let refreshing = false;

// Re-reads the repository, unless the page's own files were rebuilt since it loaded: then the page
// reloads, since new code and not only new files is what Refresh is being asked for.
async function refreshNow(): Promise<void>
{
  if (await buildChanged()) { location.reload(); return; }
  S.graphSignature = "";
  await refreshGraph(true);
}

document.getElementById("refresh")!.addEventListener("click", () => { void refreshNow(); });
const liveButton = document.getElementById("live") as HTMLButtonElement;

// What Live says about the last read: on, off, or retrying after a failed one, so a dead or
// restarted server does not keep looking like "nothing changed".
function showLive(state: "on" | "off" | "retry"): void
{
  setToggleText(liveButton, "Live", state === "retry" ? "retrying" : state);
  liveButton.classList.toggle("on", state === "on");
  liveButton.classList.toggle("warn", state === "retry");
  liveButton.title = state === "retry" ? "The last read failed; trying again" : "";
}

liveButton.addEventListener("click", () =>
{
  S.liveOn = !S.liveOn;
  showLive(S.liveOn ? "on" : "off");
});

// How often Live re-reads the repository while it is on and the page is visible, in milliseconds.
const PollInterval = 5000;
setInterval(() => { if (S.liveOn && !document.hidden) void refreshGraph(); }, PollInterval);

// Coming back to the page should show what changed while it was in the background, rather than
// waiting out the rest of a poll.
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.liveOn) void refreshGraph(); });
window.addEventListener("focus", () => { if (S.liveOn) void refreshGraph(); });

/* ------------------------------------------------------ outliner search ---- */

const searchInput = document.getElementById("search") as HTMLInputElement;

// The outliner filters in place as you type; `/` or Ctrl+K jumps here.
function openSearch(): void
{
  revealOutliner();
  window.dispatchEvent(new CustomEvent("codespace:right-tab", { detail: "outliner" }));
  searchInput.focus();
  searchInput.select();
}
searchInput.addEventListener("input", () =>
{
  S.outliner.query = searchInput.value;
  renderOutliner();
});
searchInput.addEventListener("keydown", (event) =>
{
  // Escape empties the search first, keeping the strip and the folds; a second Escape leaves the box.
  if (event.key === "Escape")
  {
    event.preventDefault();
    event.stopPropagation();
    if (searchInput.value !== "") { searchInput.value = ""; S.outliner.query = ""; renderOutliner(); }
    else searchInput.blur();
    return;
  }
  if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); stepMatch(event.key === "ArrowDown" ? 1 : -1); return; }
  if (event.key === "Enter")
  {
    // Enter chooses the match the arrows picked, or the first one.
    event.preventDefault();
    const tree = document.getElementById("outliner-tree")!;
    const row = tree.querySelector<HTMLElement>(".orow.hl") ?? tree.querySelector<HTMLElement>("[data-path], [data-symbol]");
    row?.click();
  }
});

// Moves the picked match up or down the file and symbol rows the tree lists, while the search keeps focus.
function stepMatch(direction: number): void
{
  const rows = [...document.querySelectorAll<HTMLElement>("#outliner-tree [data-path], #outliner-tree [data-symbol]")];
  if (rows.length === 0) return;
  const at = rows.findIndex((row) => row.classList.contains("hl"));
  rows[at]?.classList.remove("hl");
  const next = rows[at < 0 ? (direction > 0 ? 0 : rows.length - 1) : (at + direction + rows.length) % rows.length]!;
  next.classList.add("hl");
  next.scrollIntoView({ block: "nearest" });
  const path = next.dataset.path ?? next.dataset.symbolpath ?? null;
  if (path !== S.hoveredPath) { S.hoveredPath = path; render(); }
}

// Removes the ad-hoc isolation and tells the server, so a page opened later does not narrow the map
// again. A page that is not on the machine running it may be refused; this page clears either way.
function dropIsolation(): void
{
  if (S.isolatedFiles === null) return;
  S.isolatedFiles = null;
  fetch(api("view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "isolate", files: [] }) }).catch(() => {});
}

// Clears the search, every chip, the tag filter, and any isolation in one go; the Clear button also opens every fold.
function clearOutliner(folds = true): void
{
  const filtered = hasFilters();
  dropIsolation();
  S.outliner.query = "";
  S.outliner.systems.clear();
  S.outliner.layers.clear();
  if (folds) S.outliner.collapsed.clear();
  S.tagFilter = null;
  S.spotLayer = null;
  searchInput.value = "";
  if (filtered) redrawScene();
  else { renderOutliner(); renderEdges(); }
}

// Rebuilds the scene after a filter or an eye changes what it holds: the boxes, the folders and layers
// around them, and the camera's centre, then the tree and the strands that tie the files together.
function redrawScene(): void
{
  build();
  recenterTarget();
  renderOutliner();
  renderEdges();
}

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

// Glides to the chosen block, else the chosen file, else the chosen folder, close enough to read it.
function frameSelection(): void
{
  if (S.selected < 0) return;
  if (S.selectedFile >= 0)
  {
    const rec = S.fileRecords.get(filePath(S.selected, S.selectedFile));
    if (rec && (S.selectedBlock < 0 || !frameBlock(rec))) frameFile(rec);
    return;
  }
  frameFolder(S.NODES[S.selected], camera.radius);
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
function setHelp(open: boolean): void
{
  helpPanel.hidden = !open;
  document.body.classList.toggle("help-open", open);
}
function toggleHelp(): void { setHelp(helpPanel.hidden); }
document.getElementById("help-btn")!.addEventListener("click", toggleHelp);
// The card closes from its own button, or a tap or click anywhere outside it, since a phone has no Escape key.
document.getElementById("help-close")!.addEventListener("click", () => setHelp(false));
document.addEventListener("pointerdown", (event) =>
{
  const target = event.target as Node;
  if (!helpPanel.hidden && !helpPanel.contains(target) && !document.getElementById("help-btn")!.contains(target)) setHelp(false);
});

// The left column keeps one fixed order; opening a panel folds the others to their headers, so a
// window never pushes another one down.
const FoldedPanels = ["info", "showing", "insight"];
function setFolded(id: string, folded: boolean): void
{
  const panel = document.getElementById(id);
  if (!panel) return;
  panel.classList.toggle("collapsed", folded);
  const fold = document.querySelector<HTMLButtonElement>('.panel-fold[data-fold="' + id + '"]');
  if (!fold) return;
  fold.setAttribute("aria-expanded", String(!folded));
  fold.title = folded ? "Expand" : "Collapse";
}
function announcePanels(): void { window.dispatchEvent(new Event("codespace:panels-changed")); }
function openOnly(id: string): void
{
  // A shown route stays in view while you read a file under it, so the details open beside the
  // Showing panel rather than folding it away.
  const keepShowing = id === "info" && S.trace !== null;
  for (const other of FoldedPanels) if (other !== id && !(keepShowing && other === "showing")) setFolded(other, true);
  setFolded(id, false);
  announcePanels();
}
for (const fold of document.querySelectorAll<HTMLButtonElement>(".panel-fold[data-fold]"))
{
  const id = fold.dataset.fold!;
  const panel = document.getElementById(id);
  if (!panel) continue;
  if (!FoldedPanels.includes(id))
  {
    fold.addEventListener("click", () =>
    {
      const folded = panel.classList.toggle("collapsed");
      fold.setAttribute("aria-expanded", String(!folded));
      fold.title = folded ? "Expand" : "Collapse";
    });
    continue;
  }
  fold.addEventListener("click", () =>
  {
    if (panel.classList.contains("collapsed")) openOnly(id);
    else { setFolded(id, true); announcePanels(); }
  });
}
window.addEventListener("codespace:panel-open", (event) => openOnly((event as CustomEvent<string>).detail));
// When a window closes, bring back the other one still visible, or the details by default.
window.addEventListener("codespace:panel-closed", (event) =>
{
  const other = (event as CustomEvent<string>).detail === "showing" ? "insight" : "showing";
  const panel = document.getElementById(other);
  openOnly(panel && !panel.hidden ? other : "info");
});

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
    if (event.key === "Escape") searchInput.blur();
    return;
  }
  if (event.key === "/") { event.preventDefault(); openSearch(); return; }
  if (event.key === " ") { event.preventDefault(); window.dispatchEvent(new Event("codespace:concept-zoom")); return; }
  if (event.key === "r" || event.key === "R") { resetView(); return; }
  if (event.key === "f" || event.key === "F") { frameSelection(); return; }
  if (event.key === "[") { stepFile(-1); return; }
  if (event.key === "]") { stepFile(1); return; }
  if (event.key === "?") { event.preventDefault(); toggleHelp(); return; }
  if (event.key === "Escape")
  {
    setHelp(false);
    if (hasFilters()) { clearOutliner(false); return; }
    select(-1);
  }
});

/* ------------------------------------------------- bottom controls ---- */

// The spread slider: the gap between layer planes. It only shows when the repository has layers.
// Only heights move with the gap, so it re-stacks the boxes in place instead of rebuilding the
// city, and a burst of slider events redraws once per frame at most.
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
    restack();
    recenterTarget();
  });
});

// What the boxes are coloured by: role, layer, folder, size, or recent changes.
const colorSelect = document.getElementById("colorby") as HTMLSelectElement;
colorSelect.addEventListener("change", () =>
{
  const before = S.colorBy;
  S.colorBy = colorSelect.value as ColorBy;
  // Choosing History here opens its tab, which reads the commits it colours by.
  if (S.colorBy === "history" && before !== "history") window.dispatchEvent(new CustomEvent("codespace:open-history", { detail: before }));
  render();
});

// Bloom is the page's only post-processing pass; switching it off removes its cost entirely.
// A software renderer starts with it off, and the button still lets that be changed.
const glowButton = document.getElementById("glow") as HTMLButtonElement;
function setGlow(on: boolean): void
{
  glow.isEnabled = on;
  setToggleText(glowButton, "Glow", on ? "on" : "off");
  glowButton.classList.toggle("on", on);
}
glowButton.addEventListener("click", () => setGlow(!glow.isEnabled));
setGlow(glow.isEnabled);

/* --------------------------------------------------------- outliner ---- */

const outlinerTree = document.getElementById("outliner-tree") as HTMLElement;
const outlinerFilter = document.getElementById("outliner-filter") as HTMLButtonElement;
const outlinerOptions = document.getElementById("outliner-options") as HTMLElement;
outlinerFilter.addEventListener("click", () =>
{
  const open = outlinerOptions.hidden;
  outlinerOptions.hidden = !open;
  outlinerFilter.setAttribute("aria-expanded", String(open));
});
document.getElementById("outliner-clear")!.addEventListener("click", () => clearOutliner());

/* ------------------------------------------------ outliner on a phone ---- */

// Something was chosen from the outliner. On a phone, mobile.ts closes the sheet so the map can show
// it; a file row waits out the double-tap window first, so the sheet does not vanish under a second tap.
let settleTimer = 0;
function settleOutliner(delay = 0): void
{
  clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => window.dispatchEvent(new Event("codespace:chosen")), delay);
}

// Everything docked above the bottom bars keeps clear of them by their real height, which changes
// when the bar wraps or the font does.
const bottomDock = document.getElementById("dock-bottom") as HTMLElement;
new ResizeObserver(() => document.documentElement.style.setProperty("--dock-bottom-h", bottomDock.offsetHeight + "px")).observe(bottomDock);

const LeftWidthKey = "codespace.dock.leftWidth";
const RightWidthKey = "codespace.dock.rightWidth";

function maxDockWidth(): number
{
  return Math.max(280, Math.min(620, Math.floor(window.innerWidth * 0.46)));
}

function loadDockWidth(key: string, cssVar: string, min: number): void
{
  try
  {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const width = Number(raw);
    if (Number.isFinite(width) && width >= min)
      document.documentElement.style.setProperty(cssVar, Math.min(maxDockWidth(), Math.round(width)) + "px");
  }
  catch { /* storage can be off */ }
}

function bindWidthResize(handle: HTMLElement, dock: HTMLElement, side: "left" | "right"): void
{
  const cssVar = side === "left" ? "--user-left-w" : "--user-right-w";
  const storageKey = side === "left" ? LeftWidthKey : RightWidthKey;
  const minWidth = side === "left" ? 220 : 260;
  let dragging = false;
  let startX = 0;
  let startW = 0;
  let lastW = 0;

  const stop = (event: PointerEvent): void =>
  {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-x");
    handle.classList.remove("active");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    try { localStorage.setItem(storageKey, String(Math.round(lastW))); }
    catch { /* storage can be off */ }
  };

  handle.addEventListener("pointerdown", (event) =>
  {
    if (event.button !== 0 || document.body.classList.contains("phone")) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    startX = event.clientX;
    startW = dock.getBoundingClientRect().width;
    lastW = startW;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-x");
    handle.classList.add("active");
  });

  handle.addEventListener("pointermove", (event) =>
  {
    if (!dragging) return;
    const delta = side === "left" ? event.clientX - startX : startX - event.clientX;
    lastW = Math.max(minWidth, Math.min(maxDockWidth(), startW + delta));
    document.documentElement.style.setProperty(cssVar, Math.round(lastW) + "px");
  });

  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", (event) =>
  {
    event.stopPropagation();
    document.documentElement.style.removeProperty(cssVar);
    try { localStorage.removeItem(storageKey); }
    catch { /* storage can be off */ }
  });
}

function bindHeightResize(panel: HTMLElement, dockLeft: HTMLElement): void
{
  const handle = document.createElement("div");
  handle.className = "panel-resize-y";
  handle.title = "Drag to resize height · Double-click to reset";
  panel.appendChild(handle);
  let dragging = false;
  let startY = 0;
  let startH = 0;

  const stop = (event: PointerEvent): void =>
  {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-y");
    handle.classList.remove("active");
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
  };

  handle.addEventListener("pointerdown", (event) =>
  {
    if (event.button !== 0 || document.body.classList.contains("phone") || panel.classList.contains("collapsed")) return;
    event.preventDefault();
    event.stopPropagation();
    dragging = true;
    startY = event.clientY;
    startH = panel.getBoundingClientRect().height;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-y");
    handle.classList.add("active");
  });

  handle.addEventListener("pointermove", (event) =>
  {
    if (!dragging) return;
    const maxH = Math.max(140, dockLeft.clientHeight - 16);
    const nextH = Math.max(100, Math.min(maxH, startH + (event.clientY - startY)));
    panel.style.height = Math.round(nextH) + "px";
    panel.style.maxHeight = "none";
    panel.style.flex = "0 0 auto";
  });

  handle.addEventListener("pointerup", stop);
  handle.addEventListener("pointercancel", stop);
  handle.addEventListener("dblclick", (event) =>
  {
    event.stopPropagation();
    panel.style.height = "";
    panel.style.maxHeight = "";
    panel.style.flex = "";
  });
}

function setupDockResize(): void
{
  loadDockWidth(LeftWidthKey, "--user-left-w", 220);
  loadDockWidth(RightWidthKey, "--user-right-w", 260);
  const dockLeft = document.getElementById("dock-left");
  const dockRight = document.getElementById("dock-right");
  if (dockLeft)
  {
    for (const id of FoldedPanels)
    {
      const panel = document.getElementById(id);
      if (!panel) continue;
      const handle = document.createElement("div");
      handle.className = "dock-resize-x right";
      handle.title = "Drag to resize · Double-click to reset";
      panel.appendChild(handle);
      bindWidthResize(handle, dockLeft, "left");
      bindHeightResize(panel, dockLeft);
    }
  }
  if (dockRight)
  {
    const handle = document.createElement("div");
    handle.className = "dock-resize-x left";
    handle.title = "Drag to resize · Double-click to reset";
    dockRight.appendChild(handle);
    bindWidthResize(handle, dockRight, "right");
  }
}

setupDockResize();

// A chip that cannot be switched on says why in the footer, since a touch screen shows no tooltip.
let noteTimer = 0;
function showOutlinerNote(text: string): void
{
  const note = document.getElementById("outliner-file-count")!;
  note.textContent = text;
  note.classList.add("note");
  clearTimeout(noteTimer);
  noteTimer = window.setTimeout(() => { note.classList.remove("note"); renderOutliner(); }, 3200);
}
document.getElementById("outliner-collapse")!.addEventListener("click", collapseAllOutliner);

// Every file on the map, for the bulk all-or-none buttons.
function allFilePaths(): string[]
{
  return pathIndex().ordered.map((spot) => spot.path);
}

// Hides every file box at once; the rows stay, so any single file can still be brought back by its eye.
document.getElementById("outliner-hide-all")!.addEventListener("click", () =>
{
  S.outliner.shownFiles.clear();
  for (const path of allFilePaths()) S.outliner.hiddenFiles.add(path);
  S.outliner.shownExtraFolders.clear();
  build();
  recenterTarget();
  renderOutliner();
  renderEdges();
});

// Shows every file box at once: no hidden groups or files, and Extras on so nothing stays behind.
document.getElementById("outliner-show-all-files")!.addEventListener("click", () =>
{
  dropIsolation();
  S.outliner.systems.clear();
  S.outliner.layers.clear();
  S.outliner.hiddenFiles.clear();
  S.outliner.shownFiles.clear();
  S.outliner.shownExtraFolders.clear();
  S.tagFilter = null;
  S.hiddenFolders.clear();
  S.extrasShown = true;
  extrasBox.checked = true;
  build();
  recenterTarget();
  renderOutliner();
  renderEdges();
});

// Shows or hides one system or layer in the filter strip. With nothing selected every value is on,
// so hiding one keeps every other value that has files; showing one adds it to those already on,
// and a selection that comes to name every value reads as "all" again. Hiding the last value on
// brings them all back rather than emptying the scene.
function toggleSlice(axis: GroupAxis, value: string): void
{
  const set = sliceSet(axis);
  const chip = document.querySelector<HTMLElement>('#outliner-filters [data-slice="' + axis + '"][data-value="' + CSS.escape(value) + '"]');
  if (chip?.classList.contains("on"))
  {
    if (set.size === 0)
    {
      for (const other of document.querySelectorAll<HTMLElement>('#outliner-filters [data-slice="' + axis + '"]'))
        if (!other.classList.contains("empty")) set.add(other.dataset.value!);
    }
    set.delete(value);
  }
  else
  {
    // From the all-on strip, a value hidden only by the other strip joins the ones already showing,
    // rather than narrowing the strip down to itself.
    if (set.size === 0 && chip?.classList.contains("cross"))
    {
      for (const shown of document.querySelectorAll<HTMLElement>('#outliner-filters .fchip.on[data-slice="' + axis + '"]')) set.add(shown.dataset.value!);
    }
    set.add(value);
  }
  if (coversEvery(axis, set)) set.clear();
  reachSlices(axis);
  redrawScene();
}

// Shows only one system or layer; isolating the value already shown alone brings them all back.
function isolateSlice(axis: GroupAxis, value: string): void
{
  const set = sliceSet(axis);
  const alone = set.size === 1 && set.has(value);
  set.clear();
  if (!alone && !coversEvery(axis, new Set([value]))) set.add(value);
  reachSlices(axis);
  redrawScene();
}

// A press shows or hides its value at once. A second press of the same value within a moment is a
// double click (or double tap), which puts back what the first press changed and isolates instead:
// the strip redraws its chips on every render, so the pair is timed here rather than left to dblclick.
const DOUBLE_CLICK_MS = 320;
let lastSliceClick: { key: string; at: number; systems: Set<string>; layers: Set<string> } | null = null;
function clickSlice(axis: GroupAxis, value: string): void
{
  const key = axis + ":" + value;
  const now = performance.now();
  const last = lastSliceClick;
  if (last !== null && last.key === key && now - last.at < DOUBLE_CLICK_MS)
  {
    lastSliceClick = null;
    S.outliner.systems.clear(); for (const value of last.systems) S.outliner.systems.add(value);
    S.outliner.layers.clear(); for (const value of last.layers) S.outliner.layers.add(value);
    isolateSlice(axis, value);
    return;
  }
  lastSliceClick = { key, at: now, systems: new Set(S.outliner.systems), layers: new Set(S.outliner.layers) };
  toggleSlice(axis, value);
}

// Whether a selection names every value that has files, which is the same as naming none.
function coversEvery(axis: GroupAxis, set: ReadonlySet<string>): boolean
{
  return allFilePaths().every((path) => set.has(sliceValue(path, axis)));
}

// A system switched on must be able to show its files: when the layers selected leave it with none,
// its layers are switched on too, and the same goes the other way for a layer and its systems. So a
// layer selection never locks the other systems out, and choosing one always draws something.
function reachSlices(axis: GroupAxis): void
{
  const other: GroupAxis = axis === "system" ? "layer" : "system";
  const mine = axis === "system" ? S.outliner.systems : S.outliner.layers;
  const theirs = other === "system" ? S.outliner.systems : S.outliner.layers;
  if (mine.size === 0 || theirs.size === 0) return;
  const drawable = allFilePaths().filter((path) => isFileVisible(path) && matchesTagFilter(path));
  for (const value of mine)
  {
    const files = drawable.filter((path) => sliceValue(path, axis) === value);
    if (files.length === 0 || files.some((path) => theirs.has(sliceValue(path, other)))) continue;
    for (const path of files) theirs.add(sliceValue(path, other));
  }
  // A selection that names every value is the same as naming none, and reads more simply as "all".
  const everyOther = new Set(allFilePaths().map((path) => sliceValue(path, other)));
  if ([...everyOther].every((value) => theirs.has(value))) theirs.clear();
}

// Hides or shows a folder or file in the 3D scene. The filter strip covers systems and layers.
function toggleEye(key: string): void
{
  const cut = key.indexOf(":");
  const kind = key.slice(0, cut), value = key.slice(cut + 1);
  if (kind === "folder")
  {
    // A folder's eye acts on every file beneath it, whatever hid them: a folder above, its own eyes,
    // or the Extras toggle. While any of them is drawn, it hides them all; otherwise it shows them all.
    const under = allFilePaths().filter((path) => path.startsWith(value + "/"));
    if (under.some(isFileVisible))
    {
      S.hiddenFolders.add(value);
      S.outliner.shownExtraFolders.delete(value);
      for (const path of under) { S.outliner.shownFiles.delete(path); S.outliner.hiddenFiles.delete(path); }
    }
    else
    {
      for (const id of [...S.hiddenFolders]) if (id === value || id.startsWith(value + "/")) S.hiddenFolders.delete(id);
      for (const path of under) S.outliner.hiddenFiles.delete(path);
      if (pathIndex().extras.has(value)) S.outliner.shownExtraFolders.add(value);
      else for (const path of under) if (!isFileVisible(path)) S.outliner.shownFiles.add(path);
    }
  }
  else
  {
    // A file's eye follows what is actually on screen: if any folder hides it, this one eye brings it back.
    if (isFileVisible(value)) { S.outliner.shownFiles.delete(value); S.outliner.hiddenFiles.add(value); }
    else { S.outliner.hiddenFiles.delete(value); S.outliner.shownFiles.add(value); }
  }
  redrawScene();
}

// The file row clicked last, and when, so a quick second click on it opens its source.
const lastRowClick = { path: null as string | null, at: 0 };

outlinerTree.addEventListener("click", (event) =>
{
  const target = event.target as HTMLElement;

  // An eye hides its row in the scene.
  const eye = target.closest("[data-eye]") as HTMLElement | null;
  if (eye) { toggleEye(eye.dataset.eye!); return; }

  // The keyboard follows the pointer, so arrows pick up from the row last clicked.
  const clicked = target.closest(".orow") as HTMLElement | null;
  if (clicked) setOutlinerFocus(clicked.dataset.key ?? null);

  // A file's system or layer dot shows only that value, or, clicked again, every value.
  const slice = target.closest("[data-slice]") as HTMLElement | null;
  if (slice && !slice.classList.contains("empty")) { isolateSlice(slice.dataset.slice as GroupAxis, slice.dataset.value!); return; }

  // A tag badge sets the tag filter.
  const tag = target.closest("[data-tag]") as HTMLElement | null;
  if (tag)
  {
    const value = tag.dataset.tag!;
    S.tagFilter = S.tagFilter === value ? null : value;
    redrawScene();
    return;
  }

  // A symbol row opens its file's symbol in the code panel.
  const symbol = target.closest("[data-symbol]") as HTMLElement | null;
  if (symbol)
  {
    const path = symbol.dataset.symbolpath!;
    const [nodeIndex, at] = fileIndex(path);
    if (nodeIndex >= 0) { selectFile(nodeIndex, at); openSymbol(path, symbol.dataset.symbol!); settleOutliner(); }
    return;
  }

  // A group row's caret folds it (Alt folds everything inside too). Elsewhere on a folder row, the first
  // click chooses that folder in the scene and a second folds it; system and layer rows simply fold.
  const fold = target.closest("[data-fold]") as HTMLElement | null;
  if (fold)
  {
    const key = fold.dataset.fold!;
    const node = fold.dataset.folder !== undefined ? folderNode(fold.dataset.folder) : -1;
    // On a phone the tree is browsed by tapping folders open; a folder is chosen on the map instead.
    const phone = document.body.classList.contains("phone");
    if (phone || target.closest("[data-caret]") || node < 0 || (S.selected === node && S.selectedFile < 0)) { toggleFold(key, event.altKey); return; }
    if (fold.getAttribute("aria-expanded") === "false") S.outliner.collapsed.delete(key);
    select(node);
    settleOutliner();
    return;
  }

  // A file row chooses the file, the same as clicking its box in the scene; a second click soon after
  // opens its whole source. The first click redraws the tree, which replaces the row, so the browser's
  // own dblclick never reaches it: the pair is timed here instead.
  const row = target.closest("[data-path]") as HTMLElement | null;
  if (row)
  {
    const path = row.dataset.path!;
    // Shift on a file adds it to the selection, or takes it out again, without moving the map.
    if (event.shiftKey || event.metaKey || event.ctrlKey)
    {
      const [nodeIndex, at] = fileIndex(path);
      if (nodeIndex >= 0) toggleFileSelection(nodeIndex, at);
      lastRowClick.path = null;
      settleOutliner();
      return;
    }
    const now = performance.now();
    if (lastRowClick.path === path && now - lastRowClick.at < 450) { lastRowClick.path = null; void openFile(path); settleOutliner(); return; }
    lastRowClick.path = path;
    lastRowClick.at = now;
    const [nodeIndex, at] = fileIndex(path);
    if (nodeIndex >= 0) selectFile(nodeIndex, at);
    settleOutliner(460);
  }
});

// The filter strip redraws its chips on every render, so one delegated handler covers them all:
// a click hides or shows a value, a double click isolates it.
document.getElementById("outliner-filters")!.addEventListener("click", (event) =>
{
  const chip = (event.target as HTMLElement).closest("[data-slice]") as HTMLElement | null;
  if (chip && chip.classList.contains("empty")) { showOutlinerNote(chip.title); return; }
  if (chip) { clickSlice(chip.dataset.slice as GroupAxis, chip.dataset.value!); return; }
});

// A layer's name in the legend beside the map picks that layer at a double click (or double tap): every other
// layer fades grey where it stands, so the picked one keeps its place in the stack. Another layer's name moves
// the pick straight to it; the picked layer's name, or a double click anywhere on the map, brings every layer
// back. The pairs are timed here, as for the strip, so a tap counts too.
let lastLegendClick: { layer: string; at: number } | null = null;
document.getElementById("labels")!.addEventListener("click", (event) =>
{
  const row = (event.target as HTMLElement).closest("#layer-legend [data-layer]") as HTMLElement | null;
  if (!row) return;
  // The event's own time, not the time it is handled: a busy page handles the second tap late.
  const layer = row.dataset.layer!, now = event.timeStamp;
  if (lastLegendClick !== null && lastLegendClick.layer === layer && now - lastLegendClick.at < DOUBLE_CLICK_MS)
  {
    lastLegendClick = null;
    spotLayer(S.spotLayer === layer ? null : layer);
    return;
  }
  lastLegendClick = { layer, at: now };
});

function spotLayer(layer: string | null): void
{
  if (S.spotLayer === layer) return;
  S.spotLayer = layer;
  renderEdges();
}

// A double click or double tap on the map lets every layer back. A finger wobbles and lands its second tap a
// little off the first, so the pair is judged loosely: a press that moves under MAP_TAP_SLOP is still a tap,
// and a second tap within MAP_TAP_REACH of the first, inside MAP_TAP_MS, makes the pair. A press that drags
// the camera further does not count. The browser's own dblclick is taken too, for a mouse.
const MAP_TAP_MS = 450, MAP_TAP_SLOP = 16, MAP_TAP_REACH = 60;
let mapPress: { x: number; y: number } | null = null, lastMapTap: { x: number; y: number; at: number } | null = null;
canvas.addEventListener("pointerdown", (event) =>
{
  // A second finger is a pinch, not a tap.
  mapPress = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
});
canvas.addEventListener("pointercancel", () => { mapPress = null; });
canvas.addEventListener("pointerup", (event) =>
{
  const press = mapPress;
  mapPress = null;
  if (S.spotLayer === null || press === null || Math.hypot(event.clientX - press.x, event.clientY - press.y) > MAP_TAP_SLOP) return;
  // The event's own time, not the time it is handled: the first tap may select a folder and keep the page busy
  // past the window, though the finger came back in time.
  const now = event.timeStamp, last = lastMapTap;
  if (last !== null && now - last.at < MAP_TAP_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < MAP_TAP_REACH)
  {
    lastMapTap = null;
    spotLayer(null);
    return;
  }
  lastMapTap = { x: event.clientX, y: event.clientY, at: now };
});
canvas.addEventListener("dblclick", () => { lastMapTap = null; spotLayer(null); });

// The chips above the tree name filters that live outside the strip; their cross removes one.
document.getElementById("outliner-chips")!.addEventListener("click", (event) =>
{
  const chip = (event.target as HTMLElement).closest("[data-chip]") as HTMLElement | null;
  if (!chip) return;
  if (chip.dataset.chip === "isolate") { dropIsolation(); redrawScene(); return; }
  S.tagFilter = null;
  redrawScene();
});


// The keyboard walks the tree: arrows move and fold, Enter chooses, Space flips the eye, and
// typing a letter jumps to the search.
outlinerTree.addEventListener("keydown", (event) =>
{
  const row = (event.target as HTMLElement).closest(".orow") as HTMLElement | null;
  if (!row || event.ctrlKey || event.metaKey) return;
  const rows = [...outlinerTree.querySelectorAll<HTMLElement>(".orow")];
  const at = rows.indexOf(row);
  const depth = Number(row.dataset.depth ?? 0);
  const group = row.dataset.fold;
  const open = row.getAttribute("aria-expanded") === "true";
  const go = (next: HTMLElement | undefined) =>
  {
    if (!next) return;
    row.tabIndex = -1;
    next.tabIndex = 0;
    next.focus();
    next.scrollIntoView({ block: "nearest" });
    setOutlinerFocus(next.dataset.key ?? null);
    const path = next.dataset.path ?? next.dataset.symbolpath ?? null;
    if (path !== S.hoveredPath) { S.hoveredPath = path; render(); }
  };
  let handled = true;
  switch (event.key)
  {
    case "ArrowDown": go(rows[at + 1]); break;
    case "ArrowUp": go(rows[at - 1]); break;
    case "Home": go(rows[0]); break;
    case "End": go(rows[rows.length - 1]); break;
    case "PageDown": go(rows[Math.min(rows.length - 1, at + 10)]); break;
    case "PageUp": go(rows[Math.max(0, at - 10)]); break;
    case "ArrowRight":
      if (group && !open) toggleFold(group, event.altKey);
      else if (group) go(rows[at + 1]);
      break;
    case "ArrowLeft":
      if (group && open) toggleFold(group, event.altKey);
      else go(rows.slice(0, at).reverse().find((other) => Number(other.dataset.depth ?? 0) < depth && other.dataset.fold));
      break;
    case "Enter":
      if (row.dataset.path && event.shiftKey) void openFile(row.dataset.path);
      else row.click();
      break;
    case " ":
    {
      const eye = row.querySelector<HTMLElement>("[data-eye]");
      if (eye) toggleEye(eye.dataset.eye!);
      break;
    }
    default:
      handled = false;
      if (event.key.length === 1 && !event.altKey && event.key !== "/" && event.key !== "?" && !/^[frFR\[\]]$/.test(event.key))
      {
        // A printable letter starts a search with it, the way a file manager's tree does.
        searchInput.focus();
      }
  }
  if (handled) { event.preventDefault(); event.stopPropagation(); }
});

// Hovering a row lights its box in the scene, and the reverse happens in main.ts.
outlinerTree.addEventListener("mouseover", (event) =>
{
  const row = (event.target as HTMLElement).closest("[data-path], [data-symbolpath]") as HTMLElement | null;
  const path = row ? row.dataset.path ?? row.dataset.symbolpath! : null;
  if (path !== S.hoveredPath) { S.hoveredPath = path; render(); }
});
outlinerTree.addEventListener("mouseleave", () =>
{
  if (S.hoveredPath !== null) { S.hoveredPath = null; render(); }
});

// The grouping radios choose how the one tree lists files: by folder, or flat under systems or layers.
document.querySelectorAll<HTMLInputElement>("[data-group]").forEach((box) =>
{
  box.addEventListener("change", () =>
  {
    if (!box.checked) return;
    S.outliner.group = box.dataset.group as GroupAxis;
    renderOutliner();
  });
});

// The two view toggles that used to live in the bottom bar.
const extrasBox = document.getElementById("opt-extras") as HTMLInputElement;
extrasBox.addEventListener("change", () =>
{
  S.extrasShown = extrasBox.checked;
  S.outliner.shownExtraFolders.clear();
  build();
  centerView(false);
  renderOutliner();
});
const ingestedBox = document.getElementById("opt-ingested") as HTMLInputElement;
ingestedBox.addEventListener("change", () =>
{
  S.ingestOnly = ingestedBox.checked;
  applyIngestToggle();
  void refreshGraph(true);
});

function setSpin(on: boolean): void
{
  S.autoSpin = on;
  const b = document.getElementById("spin") as HTMLButtonElement;
  setToggleText(b, "Spin", on ? "on" : "off");
  b.classList.toggle("on", on);
}
document.getElementById("spin")!.addEventListener("click", () => setSpin(!S.autoSpin));
document.getElementById("reset")!.addEventListener("click", resetView);
// Choosing something on the map stops the spin, so the page's button stays truthful.
window.addEventListener("codespace:spin", () => setSpin(S.autoSpin));

// While a big repository is only partly described, only the described files are drawn, so the
// map stays quick. This shows everything, or goes back to the described files.
function applyIngestToggle(): void
{
  ingestedBox.checked = S.ingestOnly;
}
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
  const [nodeIndex, at] = fileIndex(path);
  if (nodeIndex >= 0) { selectFile(nodeIndex, at); return; }
  select(S.NODES.findIndex((n) => n.id === path));
}
window.addEventListener("codespace:built", () =>
{
  const path = pathFromHash();
  if (path !== null && S.selected < 0) openPath(path);
  renderOutliner();
});
window.addEventListener("hashchange", () =>
{
  const path = pathFromHash();
  if (path !== null) openPath(path);
});

export { setSpin, refreshGraph };
