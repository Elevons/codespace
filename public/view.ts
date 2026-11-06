import { S, V3, camera, render, filePath } from "./state.js";
import { escapeHtml, select, selectFile } from "./panels.js";
import { refreshGraph, setSpin } from "./controls.js";
import { routeTargets } from "./route.js";
import type { FileRecord, GraphNode } from "./types.js";

/** One file a tool asks the map to show, with an optional explanation. */
interface ShownFile { path: string; note?: string }
/** The payload the server streams when a tool asks the map to show something. */
interface ShownPayload { files: ShownFile[]; trace: boolean; title: string; note: string }

const panel = document.getElementById("showing")!;
const body = document.getElementById("showing-body")!;

// Where each file and folder is in the node list, by path, so a path can be selected and clicked.
let cache: { nodes: GraphNode[] | null; files: Map<string, [number, number]>; folders: Map<string, number> } =
  { nodes: null, files: new Map(), folders: new Map() };
function index(): typeof cache
{
  if (cache.nodes !== S.NODES)
  {
    const files = new Map<string, [number, number]>(), folders = new Map<string, number>();
    S.NODES.forEach((n, nodeIndex) =>
    {
      folders.set(n.id, nodeIndex);
      n.files.forEach((name, fileIndex) => files.set(filePath(nodeIndex, fileIndex), [nodeIndex, fileIndex]));
    });
    cache = { nodes: S.NODES, files, folders };
  }
  return cache;
}

/* ------------------------------------------------------------ showing ---- */

// Lists what is shown beside the map: the heading and note, then each file, numbered when it is a route.
function renderShowing(): void
{
  const shown = S.trace;
  panel.hidden = shown === null;
  if (shown === null) { body.innerHTML = ""; return; }
  const known = index().files;
  const rows = shown.paths.map((path, step) =>
  {
    const note = shown.notes.get(path);
    const summary = S.FILE_SUMMARIES.get(path);
    return "<li>" + (shown.trace ? '<span class="step">' + (step + 1) + "</span>" : '<span class="dot"></span>') +
      "<div>" + (known.has(path) ? '<a href="#" class="path" data-path="' + escapeHtml(path) + '">' + escapeHtml(path) + "</a>" : "<code>" + escapeHtml(path) + "</code>") +
      (summary ? '<p class="summary">' + escapeHtml(summary) + "</p>" : "") +
      (note ? (summary ? "<hr>" : "") + '<p class="what">' + escapeHtml(note) + "</p>" : "") + "</div></li>";
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
  const spot = index().files.get(link.dataset.path!);
  if (spot) selectFile(spot[0], spot[1]);
});

// A step in the rail beside a traced path selects its file, like a click on the block.
document.getElementById("labels")!.addEventListener("click", (event) =>
{
  const row = (event.target as HTMLElement).closest("#trace-rail li[data-path]") as HTMLElement | null;
  if (!row) return;
  const spot = index().files.get(row.dataset.path!);
  if (spot) selectFile(spot[0], spot[1]);
});

// Lights up what a tool asked for, and brings the camera's aim to it.
function show(shown: ShownPayload): void
{
  S.trace = {
    paths: shown.files.map((file) => file.path), set: new Set(shown.files.map((file) => file.path)),
    notes: new Map(shown.files.filter((file) => file.note).map((file) => [file.path, file.note!])),
    trace: shown.trace, title: shown.title, note: shown.note,
  };
  renderShowing();
  render();
  routeTargets();
  const spots = S.trace.paths.map((path) => S.fileRecords.get(path)).filter((rec): rec is FileRecord => Boolean(rec)).map((rec) => rec.target);
  if (spots.length === 0) return;
  let min = spots[0].clone(), max = spots[0].clone();
  for (const spot of spots) { min = V3.Minimize(min, spot); max = V3.Maximize(max, spot); }
  setSpin(false);
  S.camGoal = { target: V3.Center(min, max), radius: camera.radius };
}

function clear(): void
{
  S.trace = null;
  routeTargets();
  renderShowing();
  render();
}

document.getElementById("showing-clear")!.addEventListener("click", () =>
{
  clear();
  // Tell the server too, so a page opened later does not light the files again. It may refuse, from a
  // page that is not on the machine running it; the page is cleared either way.
  fetch("/api/view", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "clear" }) }).catch(() => {});
});

// Selects a file or folder and glides the camera to it.
function focus(path: string): void
{
  const { files, folders } = index();
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
  S.camGoal = { target, radius: Math.min(camera.radius, 28) };
}

/* ------------------------------------------------------------- events ---- */

// The server streams what tools ask for. EventSource reconnects by itself, and the server
// tells a page that connects late what is already being shown.
const events = new EventSource("/api/view/events");
events.onmessage = (message) =>
{
  const event = JSON.parse(message.data);
  if (event.type === "show") show(event.shown);
  else if (event.type === "clear") clear();
  else if (event.type === "focus") focus(event.path);
  else if (event.type === "architecture") { S.graphSignature = ""; refreshGraph().then(renderShowing); }
};

// A redraw can change which files exist, so refresh the list's links too.
window.addEventListener("codespace:built", renderShowing);
