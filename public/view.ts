import { api } from "./endpoint.js";
import { S, V3, camera, renderEdges, pathIndex } from "./state.js";
import { escapeHtml, select, selectFile, renderOutliner, setSelection } from "./panels.js";
import { refreshGraph, setSpin } from "./controls.js";
import { build } from "./city.js";
import { recenterTarget } from "./meshes.js";
import { routeTargets } from "./route.js";
import type { FileRecord } from "./types.js";

import type { IShown } from "./shown.js";
import { LocalViewEvent, type ViewChange } from "./viewcall.js";

const panel = document.getElementById("showing")!;
const body = document.getElementById("showing-body")!;

/* ------------------------------------------------------------ showing ---- */

// Lists what is shown beside the map: the heading and note, then each file, numbered when it is a route.
function renderShowing(): void
{
  const shown = S.trace;
  panel.hidden = shown === null;
  if (shown === null) { body.innerHTML = ""; return; }
  const known = pathIndex().files;
  const rows = shown.paths.map((path, step) =>
  {
    const note = shown.notes[step];
    const summary = S.FILE_SUMMARIES.get(path);
    return "<li>" + (shown.trace ? '<span class="step">' + (step + 1) + "</span>" : '<span class="dot"></span>') +
      "<div>" + (known.has(path) ? '<a href="#" class="path" data-path="' + escapeHtml(path) + '">' + escapeHtml(path) + "</a>" : "<code>" + escapeHtml(path) + "</code>") +
      (summary ? '<p class="summary">' + escapeHtml(summary) + "</p>" : "") +
      (note !== "" && note !== summary ? (summary ? "<hr>" : "") + '<p class="what">' + escapeHtml(note) + "</p>" : "") + "</div></li>";
  });
  body.innerHTML = (shown.title ? "<h3>" + escapeHtml(shown.title) + "</h3>" : "") +
    (shown.note ? '<p class="about">' + escapeHtml(shown.note) + "</p>" : "") +
    (shown.trace ? "<ol>" : "<ul>") + rows.join("") + (shown.trace ? "</ol>" : "</ul>");
}

body.addEventListener("click", (event) =>
{
  const link = (event.target as HTMLElement).closest("a.path") as HTMLElement | null;
  if (!link) return;
  event.preventDefault();
  const spot = pathIndex().files.get(link.dataset.path!);
  if (spot) selectFile(spot[0], spot[1]);
});

// A step in the rail beside a traced path selects its file, like a click on the block.
document.getElementById("labels")!.addEventListener("click", (event) =>
{
  const row = (event.target as HTMLElement).closest("#trace-rail li[data-path]") as HTMLElement | null;
  if (!row) return;
  const spot = pathIndex().files.get(row.dataset.path!);
  if (spot) selectFile(spot[0], spot[1]);
});

// Lights up what a tool asked for, and brings the camera's aim to it.
function show(shown: IShown): void
{
  S.trace = {
    paths: shown.files.map((file) => file.path), set: new Set(shown.files.map((file) => file.path)),
    notes: shown.files.map((file) => file.note),
    trace: shown.trace, title: shown.title, note: shown.note,
  };
  renderShowing();
  renderEdges();
  routeTargets();
  const spots = S.trace.paths.map((path) => S.fileRecords.get(path)).filter((rec): rec is FileRecord => Boolean(rec)).map((rec) => rec.target);
  if (spots.length === 0) return;
  let min = spots[0].clone(), max = spots[0].clone();
  for (const spot of spots) { min = V3.Minimize(min, spot); max = V3.Maximize(max, spot); }
  setSpin(false);
  // A route can spread across the city, so frame the whole of it rather than the old close radius.
  S.camGoal = { target: V3.Center(min, max), radius: Math.max(10, Math.min(120, V3.Distance(min, max) * 1.4 + 2)) };
}

function clear(): void
{
  S.trace = null;
  routeTargets();
  renderShowing();
  renderEdges();
}

// Chooses several files at once, as a tool asks, and brings the whole selection into view. A
// selection that arrives before the first graph is built waits for it.
let pendingSelection: string[] | null = null;
function selectMany(paths: string[] | null): void
{
  if (paths === null || paths.length === 0) { setSelection([]); return; }
  if (S.NODES.length === 0) { pendingSelection = [...paths]; return; }
  setSelection(paths);
  const recs = paths.map((path) => S.fileRecords.get(path)).filter((rec): rec is FileRecord => rec !== undefined);
  if (recs.length < 2) return;
  let min = recs[0].target.clone(), max = recs[0].target.clone();
  for (const rec of recs.slice(1)) { min = V3.Minimize(min, rec.target); max = V3.Maximize(max, rec.target); }
  setSpin(false);
  // Fit the whole selection: a spread-out set is framed from further back, never kept at a close
  // radius that would leave most of it off screen.
  S.camGoal = { target: V3.Center(min, max), radius: Math.max(10, Math.min(120, V3.Distance(min, max) * 1.4 + 2)) };
}

// Narrows the scene to an ad-hoc set of files, or clears that narrowing with null. Isolation is a
// filter, so the city, the Outliner, and the strands all rebuild as they do for a tag or a chip.
function isolate(paths: string[] | null): void
{
  S.isolatedFiles = paths === null || paths.length === 0 ? null : new Set(paths);
  build();
  recenterTarget();
  renderOutliner();
  renderEdges();
}

document.getElementById("showing-clear")!.addEventListener("click", () =>
{
  clear();
  // Tell the server too, so a page opened later does not light the files again. It may refuse, from a
  // page that is not on the machine running it; the page is cleared either way.
  fetch(api("view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) }).catch(() => {});
});

// Selects a file or folder and glides the camera to it.
function focus(path: string): void
{
  const { files, folders } = pathIndex();
  let target: BABYLON.Vector3 | null = null;
  if (files.has(path))
  {
    const spot = files.get(path)!;
    selectFile(spot[0], spot[1]);
    const rec = S.fileRecords.get(path);
    if (rec) target = rec.target;
  }
  else if (folders.has(path))
  {
    const folderIndex = folders.get(path)!;
    select(folderIndex);
    const n = S.NODES[folderIndex];
    if (n.cx !== undefined) target = new V3(n.cx, n.topY!, n.cz!);
  }
  if (target === null) return;
  setSpin(false);
  S.camGoal = { target, radius: Math.max(9, Math.min(camera.radius, 28)) };
}

/* ------------------------------------------------------------- events ---- */

// The server streams what tools ask for. EventSource reconnects by itself, and the server
// tells a page that connects late what is already being shown.
const events = new EventSource(api("view/events"));
events.onmessage = (message) =>
{
  const event = JSON.parse(message.data);
  if (event.type === "show") show(event.shown);
  else if (event.type === "isolate") isolate(event.files ?? null);
  else if (event.type === "select") selectMany(event.files ?? null);
  else if (event.type === "clear") clear();
  else if (event.type === "focus") focus(event.path);
  else if (event.type === "architecture") { S.graphSignature = ""; refreshGraph().then(renderShowing); window.dispatchEvent(new Event("codespace:architecture")); }
  else if (event.type === "repo") location.reload();
  else if (event.type === "chat") window.dispatchEvent(new CustomEvent("codespace:chat", { detail: event.chat }));
};

// A page whose host refuses view writes makes the change here alone (see viewcall.ts).
window.addEventListener(LocalViewEvent, (event) =>
{
  const change = (event as CustomEvent<ViewChange>).detail;
  if (change.type === "show") show(change.shown);
  else if (change.type === "isolate") isolate(change.files);
  else if (change.type === "select") selectMany(change.files);
  else if (change.type === "clear") clear();
});

// The chat leads to a file the same way a tool does.
export { focus as focusPath };

// A redraw can change which files exist, so refresh the list's links too.
window.addEventListener("codespace:built", () =>
{
  if (pendingSelection !== null)
  {
    const paths = pendingSelection;
    pendingSelection = null;
    selectMany(paths);
  }
  renderShowing();
});
