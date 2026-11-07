import { S, camera, DEFAULT_ALPHA, filePath, frameFile, frameFolder, glow, hasFilters, isFileVisible, matchesTagFilter, render, renderEdges, extraFolderIds } from "./state.js";
import { build } from "./city.js";
import { centerView, recenterTarget, pulseFile } from "./meshes.js";
import { collapseAllOutliner, folderNode, select, selectFile, setOutlinerFocus, openSymbol, openFile, renderOutliner, toggleFold } from "./panels.js";
import { loadGraph } from "./repo.js";
import type { ColorBy, GroupAxis, GroupMode } from "./types.js";

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
    catch (error) { return; }
    if (graph === null || graph.nodes.length === 0) return;
    S.fingerprint = graph.fingerprint;

    const signature = JSON.stringify(graph.nodes.map((node) => node.id + ":" + node.files.length)) +
      JSON.stringify(graph.edges) + JSON.stringify(graph.fileEdges) + JSON.stringify([...graph.lines]) +
      JSON.stringify([...graph.tags]) + JSON.stringify([...graph.summaries]) + JSON.stringify([...graph.layers]) +
      JSON.stringify([...graph.systems]) + JSON.stringify(graph.systemOrder) +
      JSON.stringify([...graph.symbols]) + JSON.stringify([...graph.changes]) +
      JSON.stringify(graph.layerOrder) + JSON.stringify(graph.notes) +
      ":" + S.undescribed;
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
    S.FILE_SYSTEMS = graph.systems;
    S.FILE_SUMMARIES = graph.summaries;
    S.SYSTEMS = graph.systemOrder.length > 0 ? graph.systemOrder : [...new Set(graph.systems.values())].sort();
    S.FILE_SYMBOLS = graph.symbols;
    S.FILE_CHANGES = graph.changes;
    S.ARCH_NOTES = graph.notes;
    S.LAYERS = graph.layerOrder !== null ? graph.layerOrder : [...new Set(graph.layers.values())].sort();
    spreadSlider.value = String(S.layerGap);
    spreadCaption.hidden = spreadSlider.hidden = S.LAYERS.length === 0;
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

document.getElementById("refresh")!.addEventListener("click", () => { S.graphSignature = ""; refreshGraph(true); });
const liveButton = document.getElementById("live") as HTMLButtonElement;
liveButton.addEventListener("click", () =>
{
  S.liveOn = !S.liveOn;
  setToggleText(liveButton, "Live", S.liveOn ? "on" : "off");
  liveButton.classList.toggle("on", S.liveOn);
});
setInterval(() => { if (S.liveOn && !document.hidden) refreshGraph(); }, 15000);

/* ------------------------------------------------------ outliner search ---- */

const searchInput = document.getElementById("search") as HTMLInputElement;

// The outliner filters in place as you type; `/` or Ctrl+K jumps here.
function openSearch(): void
{
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

// Clears the search, every chip, and the tag filter in one go; the Clear button also opens every fold.
function clearOutliner(folds = true): void
{
  const filtered = hasFilters();
  S.outliner.query = "";
  S.outliner.systems.clear();
  S.outliner.layers.clear();
  if (folds) S.outliner.collapsed.clear();
  S.tagFilter = null;
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

// Glides to the chosen folder or file, close enough to read it.
function frameSelection(): void
{
  if (S.selected < 0) return;
  if (S.selectedFile >= 0)
  {
    const rec = S.fileRecords.get(filePath(S.selected, S.selectedFile));
    if (rec) frameFile(rec, camera.radius);
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
    if (event.key === "Escape") searchInput.blur();
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
    if (hasFilters()) { clearOutliner(false); return; }
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
  const paths: string[] = [];
  S.NODES.forEach((node, nodeIndex) => node.files.forEach((_, fileIndex) => paths.push(filePath(nodeIndex, fileIndex))));
  return paths;
}

// Hides every file box at once; the rows stay, so any single file can still be brought back by its eye.
document.getElementById("outliner-hide-all")!.addEventListener("click", () =>
{
  S.outliner.shownFiles.clear();
  for (const path of allFilePaths()) S.outliner.hiddenFiles.add(path);
  build();
  recenterTarget();
  renderOutliner();
  renderEdges();
});

// Shows every file box at once: no hidden groups or files, and Extras on so nothing stays behind.
document.getElementById("outliner-show-all-files")!.addEventListener("click", () =>
{
  S.outliner.systems.clear();
  S.outliner.layers.clear();
  S.outliner.hiddenFiles.clear();
  S.outliner.shownFiles.clear();
  S.tagFilter = null;
  S.hiddenFolders.clear();
  S.extrasShown = true;
  applyExtrasToggle();
  build();
  recenterTarget();
  renderOutliner();
  renderEdges();
});

// Switches one system or layer in the filter strip. With nothing selected every value is on, so
// the first click narrows the strip to that value; switching the last one off brings them all back.
// With Alt held, a value is soloed instead: only it stays on, or, when nothing was selected and it is
// clicked from the all-on strip, everything but it; Alt-clicking the lone value brings them all back.
function toggleSlice(axis: GroupAxis, value: string, solo = false): void
{
  const set = axis === "system" ? S.outliner.systems : S.outliner.layers;
  if (solo)
  {
    const chips = [...document.querySelectorAll<HTMLElement>('#outliner-filters [data-slice="' + axis + '"]')];
    if (set.size === 0)
    {
      // From the all-on strip, Alt hides just this value: every other value that has files stays on.
      for (const chip of chips) if (chip.dataset.value !== value && !chip.classList.contains("empty")) set.add(chip.dataset.value!);
      if (set.size === 0 || set.size === chips.length) set.clear();
    }
    else
    {
      const alone = set.size === 1 && set.has(value);
      set.clear();
      if (!alone && chips.length > 1) set.add(value);
    }
  }
  else if (set.has(value)) set.delete(value);
  else
  {
    // From the all-on strip, a value hidden only by the other strip joins the ones already showing,
    // rather than narrowing the strip down to itself.
    const chip = document.querySelector<HTMLElement>('#outliner-filters [data-slice="' + axis + '"][data-value="' + CSS.escape(value) + '"]');
    if (set.size === 0 && chip?.classList.contains("cross"))
    {
      for (const shown of document.querySelectorAll<HTMLElement>('#outliner-filters .fchip.on[data-slice="' + axis + '"]')) set.add(shown.dataset.value!);
    }
    set.add(value);
  }
  reachSlices(axis);
  redrawScene();
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
  const valueOf = (path: string, which: GroupAxis) => (which === "system" ? S.FILE_SYSTEMS.get(path) : S.FILE_LAYERS.get(path)) ?? "";
  const drawable = allFilePaths().filter((path) => isFileVisible(path) && matchesTagFilter(path));
  for (const value of mine)
  {
    const files = drawable.filter((path) => valueOf(path, axis) === value);
    if (files.length === 0 || files.some((path) => theirs.has(valueOf(path, other)))) continue;
    for (const path of files) theirs.add(valueOf(path, other));
  }
  // A selection that names every value is the same as naming none, and reads more simply as "all".
  const everyOther = new Set(allFilePaths().map((path) => valueOf(path, other)));
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
      for (const path of under) { S.outliner.shownFiles.delete(path); S.outliner.hiddenFiles.delete(path); }
    }
    else
    {
      for (const id of [...S.hiddenFolders]) if (id === value || id.startsWith(value + "/")) S.hiddenFolders.delete(id);
      for (const path of under)
      {
        S.outliner.hiddenFiles.delete(path);
        if (!isFileVisible(path)) S.outliner.shownFiles.add(path);
      }
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

  // A file's system or layer dot switches that value in the strip.
  const slice = target.closest("[data-slice]") as HTMLElement | null;
  if (slice && !slice.classList.contains("empty")) { toggleSlice(slice.dataset.slice as GroupAxis, slice.dataset.value!, event.altKey); return; }

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
    const [nodeIndex, fileIndex] = locateFile(path);
    if (nodeIndex >= 0) { selectFile(nodeIndex, fileIndex); openSymbol(path, symbol.dataset.symbol!); settleOutliner(); }
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
    const now = performance.now();
    if (lastRowClick.path === path && now - lastRowClick.at < 450) { lastRowClick.path = null; void openFile(path); settleOutliner(); return; }
    lastRowClick.path = path;
    lastRowClick.at = now;
    const [nodeIndex, fileIndex] = locateFile(path);
    if (nodeIndex >= 0) selectFile(nodeIndex, fileIndex);
    settleOutliner(460);
  }
});

// The filter strip redraws its chips on every render, so one delegated handler covers them all.
document.getElementById("outliner-filters")!.addEventListener("click", (event) =>
{
  const chip = (event.target as HTMLElement).closest("[data-slice]") as HTMLElement | null;
  if (chip && chip.classList.contains("empty")) { showOutlinerNote(chip.title); return; }
  if (chip) { toggleSlice(chip.dataset.slice as GroupAxis, chip.dataset.value!, event.altKey); return; }
});

// The tag chip's cross sits above the tree, so it gets its own handler.
document.getElementById("outliner-chips")!.addEventListener("click", (event) =>
{
  const chip = (event.target as HTMLElement).closest("[data-chip]") as HTMLElement | null;
  if (!chip) return;
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
    S.outliner.group = box.dataset.group as GroupMode;
    renderOutliner();
  });
});

// The two view toggles that used to live in the bottom bar.
const extrasBox = document.getElementById("opt-extras") as HTMLInputElement;
extrasBox.addEventListener("change", () =>
{
  S.extrasShown = extrasBox.checked;
  applyExtrasToggle();
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

// Shows or hides the extras at once — tests, docs, scripts, assets, loose top-level
// files, and library code (dependencies and vendored folders). They start hidden so the
// map shows only the code that does the work.
function applyExtrasToggle(): void
{
  for (const id of extraFolderIds())
  {
    if (S.extrasShown) S.hiddenFolders.delete(id);
    else S.hiddenFolders.add(id);
  }
  extrasBox.checked = S.extrasShown;
}

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
  const [nodeIndex, fileIndex] = locateFile(path);
  if (nodeIndex >= 0) { selectFile(nodeIndex, fileIndex); return; }
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
