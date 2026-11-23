// Build mode: the page's other controls step aside and a bar of shapes stands down the left edge, as in
// a 3D tool. Drag a shape onto the map and let go to make something:
//   plane  a layer, added above the one it lands on (or on top of the stack)
//   cube   a file, on the layer it lands on
//   cloud  a concept: drag a loop around files to gather them
// Every one ends in the same prompt (prompt.ts): a default name, all selected, Continue or Cancel.
// A concept is saved as a flow with no route, so it is named, kept with the repository, and lights its files.

import { S, V3, scene, camera, canvas, matchesFilters, renderEdges, pathIndex } from "./state.js";
import { api } from "./endpoint.js";
import { build } from "./city.js";
import { refreshGraph, clearBoard } from "./controls.js";
import { changeView } from "./viewcall.js";
import { layerDefaults, postNewFile } from "./newfile.js";
import { ask, promptOpen } from "./prompt.js";

type Tool = "plane" | "cube" | "cloud";

const SVG = "http://www.w3.org/2000/svg";

/** How far a finger may move and still be a tap, in pixels. */
const TAP_SLOP = 8;

/** The longest a concept's name may be: a flow's name limit. */
const MAX_NAME = 40;

const ICONS: Record<Tool, string> =
{
  plane: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M3 20 L13 9 H29 L19 20 Z"/></svg>',
  cube: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4 L27 10 V22 L16 28 L5 22 V10 Z"/><path d="M5 10 L16 16 L27 10 M16 16 V28"/></svg>',
  cloud: '<svg viewBox="0 0 32 32" aria-hidden="true"><path d="M9 23 a5 5 0 0 1 -.5 -9.97 A7 7 0 0 1 22 11.5 a5.5 5.5 0 0 1 1 10.9 L23 23 Z"/></svg>',
};

const LABELS: Record<Tool, string> = { plane: "Layer", cube: "File", cloud: "Concept" };

let bar: HTMLDivElement | null = null;
let toast: HTMLDivElement | null = null;
let toastTimer = 0;

/* ------------------------------------------------------------------ modes ---- */

/** Whether build mode is on. */
export function isBuilding(): boolean
{
  return S.building;
}

/** Turns build mode on or off, and draws the scene again, since build mode also shows the layers that hold no file. */
export function setBuilding(on: boolean): void
{
  if (S.building === on) return;
  S.building = on;
  document.body.classList.toggle("building", on);
  if (on) ensureBar();
  if (bar) bar.hidden = !on;
  if (!on) endDrag();
  build();
  renderEdges();
}

function say(text: string): void
{
  toast ??= (() =>
  {
    const element = document.createElement("div");
    element.id = "buildtoast";
    element.setAttribute("role", "status");
    document.body.appendChild(element);
    return element;
  })();
  toast.textContent = text;
  toast.classList.add("on");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast!.classList.remove("on"), 2600);
}

function ensureBar(): void
{
  if (bar) return;
  bar = document.createElement("div");
  bar.id = "buildbar";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Build");
  for (const tool of ["plane", "cube", "cloud"] as Tool[])
  {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "btool";
    button.dataset.tool = tool;
    button.innerHTML = ICONS[tool] + "<span>" + LABELS[tool] + "</span>";
    button.title = tool === "plane" ? "Drag onto the map to make a layer"
      : tool === "cube" ? "Drag onto a layer to make a file" : "Drag a loop around files to gather them into a concept";
    bar.appendChild(button);
  }
  // New codebase clears the board: every file is hidden, so there is an empty map to build on. Nothing is deleted.
  const fresh = document.createElement("button");
  fresh.type = "button";
  fresh.className = "bnew";
  fresh.innerHTML = "New<br>codebase";
  fresh.title = "Clear the board to start a new codebase (Show all in the Outliner brings everything back)";
  fresh.addEventListener("click", () =>
  {
    clearBoard();
    void changeView({ type: "clear" });
    say("Board cleared. Drag a layer onto the map.");
  });
  bar.appendChild(fresh);
  const done = document.createElement("button");
  done.type = "button";
  done.className = "bdone";
  done.textContent = "Done";
  done.title = "Leave build mode";
  done.addEventListener("click", () => setBuilding(false));
  bar.appendChild(done);
  document.body.appendChild(bar);
  bar.addEventListener("pointerdown", onPress);
}

/* ------------------------------------------------------------------ drag ---- */

interface IDrag
{
  tool: Tool;
  pointer: number;
  from: { x: number; y: number };
  moved: boolean;
  ghost: HTMLDivElement | null;
  /** The layer picked from the legend before the drag, put back after it. */
  spot: string | null;
  /** The lasso's points, for a cloud, once it has left the bar. */
  loop: { x: number; y: number }[];
  hover: string | null;
}

let drag: IDrag | null = null;
let lassoSvg: SVGSVGElement | null = null;

function onPress(event: PointerEvent): void
{
  const button = (event.target as HTMLElement).closest(".btool") as HTMLButtonElement | null;
  if (!button || drag !== null || promptOpen()) return;
  event.preventDefault();
  // The capture keeps the drag coming to the button after the finger leaves it; a pointer that is not active cannot be captured.
  try { button.setPointerCapture(event.pointerId); } catch { /* the drag still follows events on the button */ }
  drag = { tool: button.dataset.tool as Tool, pointer: event.pointerId, from: { x: event.clientX, y: event.clientY },
    moved: false, ghost: null, spot: S.spotLayer, loop: [], hover: null };
  button.addEventListener("pointermove", onMove);
  button.addEventListener("pointerup", onRelease);
  button.addEventListener("pointercancel", onCancel);
}

function release(button: HTMLElement): void
{
  button.removeEventListener("pointermove", onMove);
  button.removeEventListener("pointerup", onRelease);
  button.removeEventListener("pointercancel", onCancel);
}

// Takes down the ghost, the lasso, and the layer highlight a drag put up.
function endDrag(): void
{
  if (drag === null) { clearLasso(); return; }
  drag.ghost?.remove();
  setHover(null);
  clearLasso();
  drag = null;
}

function setHover(layer: string | null): void
{
  if (drag === null || drag.hover === layer) return;
  drag.hover = layer;
  // The layer under a cube stays bright and the rest fade, as when a layer is picked from the legend.
  S.spotLayer = layer ?? drag.spot;
  renderEdges();
}

function onMove(event: PointerEvent): void
{
  if (drag === null || event.pointerId !== drag.pointer) return;
  const x = event.clientX, y = event.clientY;
  if (!drag.moved && Math.hypot(x - drag.from.x, y - drag.from.y) > TAP_SLOP) drag.moved = true;
  if (!drag.moved) return;

  if (drag.tool === "cloud")
  {
    // The loop starts where the finger leaves the bar, so the bar's own width is not part of it.
    const barRight = bar!.getBoundingClientRect().right;
    if (drag.loop.length === 0 && x <= barRight + 4) return;
    const last = drag.loop[drag.loop.length - 1];
    if (last === undefined || Math.hypot(x - last.x, y - last.y) >= 4) drag.loop.push({ x, y });
    drawLasso(drag.loop);
    return;
  }

  if (drag.ghost === null)
  {
    const ghost = document.createElement("div");
    ghost.className = "bghost";
    ghost.innerHTML = ICONS[drag.tool];
    document.body.appendChild(ghost);
    drag.ghost = ghost;
  }
  // The ghost rides above the finger, so the finger does not hide where it will land.
  drag.ghost.style.transform = "translate(" + x.toFixed(0) + "px," + y.toFixed(0) + "px) translate(-50%,-135%)";
  if (drag.tool === "cube") setHover(layerAt(x, y));
}

function onCancel(event: PointerEvent): void
{
  if (drag === null || event.pointerId !== drag.pointer) return;
  release(event.currentTarget as HTMLElement);
  endDrag();
}

function onRelease(event: PointerEvent): void
{
  if (drag === null || event.pointerId !== drag.pointer) return;
  release(event.currentTarget as HTMLElement);
  const done = drag, x = event.clientX, y = event.clientY;
  if (!done.moved)
  {
    endDrag();
    say(done.tool === "cloud" ? "Drag a loop around files." : "Drag it onto the map.");
    return;
  }

  if (done.tool === "cloud")
  {
    // The lasso stays on screen while the prompt is open, so the loop and what it caught can be seen.
    drag = null;
    void finishConcept(done.loop);
    return;
  }

  // The layer under the finger, taken before the highlight is put away.
  const layer = layerAt(x, y);
  const overBar = bar!.contains(document.elementFromPoint(x, y));
  endDrag();
  S.spotLayer = done.spot;
  renderEdges();
  if (overBar) return;
  if (done.tool === "plane") void makeLayer(layer);
  else void makeFile(layer);
}

/* ------------------------------------------------------------- hit tests ---- */

// The layer under a screen point: a name in the legend, or the nearest plane the point's ray crosses. The
// planes are flat, so the ray is crossed with each one's height and kept where it lands inside the plane.
function layerAt(x: number, y: number): string | null
{
  const over = document.elementFromPoint(x, y);
  const row = over?.closest("#layer-legend [data-layer]") as HTMLElement | null;
  if (row) return row.dataset.layer!;
  if (over !== canvas) return null;
  const ray = scene.createPickingRay(x, y, BABYLON.Matrix.IdentityReadOnly, camera);
  const o = ray.origin, d = ray.direction;
  let best: string | null = null, bestT = Infinity;
  for (const plane of S.layerPlanes)
  {
    if (Math.abs(d.y) < 1e-6) continue;
    const t = (plane.position.y - o.y) / d.y;
    if (t < 0 || t >= bestT) continue;
    const info = plane.getBoundingInfo().boundingBox;
    const hitX = o.x + d.x * t, hitZ = o.z + d.z * t;
    if (hitX < info.minimumWorld.x || hitX > info.maximumWorld.x || hitZ < info.minimumWorld.z || hitZ > info.maximumWorld.z) continue;
    bestT = t;
    best = (plane.metadata as { layer: string }).layer;
  }
  return best;
}

// Whether a point is inside a loop, by counting the sides a rightward line from it crosses.
function inside(loop: readonly { x: number; y: number }[], x: number, y: number): boolean
{
  let crossings = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++)
  {
    const a = loop[i], b = loop[j];
    if ((a.y > y) !== (b.y > y) && x < (b.x - a.x) * (y - a.y) / (b.y - a.y) + a.x) crossings = !crossings;
  }
  return crossings;
}

// The files whose boxes stand inside a loop on screen, found by projecting each box's middle through the camera.
function filesIn(loop: readonly { x: number; y: number }[]): string[]
{
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const transform = scene.getTransformMatrix();
  const viewport = camera.viewport.toGlobal(width, height);
  const found: string[] = [];
  for (const rec of S.fileRecords.values())
  {
    if (rec.shape.scaling.y < 0.05 || !matchesFilters(rec.path)) continue;
    const p = V3.Project(rec.shape.position, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    if (p.z < 0 || p.z > 1) continue;
    if (inside(loop, p.x, p.y)) found.push(rec.path);
  }
  return found.sort();
}

/* ----------------------------------------------------------------- lasso ---- */

function drawLasso(loop: readonly { x: number; y: number }[]): void
{
  if (lassoSvg === null)
  {
    lassoSvg = document.createElementNS(SVG, "svg") as SVGSVGElement;
    lassoSvg.id = "lasso";
    lassoSvg.appendChild(document.createElementNS(SVG, "path"));
    document.body.appendChild(lassoSvg);
  }
  const path = lassoSvg.firstChild as SVGPathElement;
  path.setAttribute("d", loop.length === 0 ? "" : "M" + loop.map((p) => p.x.toFixed(0) + " " + p.y.toFixed(0)).join("L") + "Z");
}

function clearLasso(): void
{
  lassoSvg?.remove();
  lassoSvg = null;
}

/* ----------------------------------------------------------------- steps ---- */

// A plane: a layer, above the one it landed on, or on top of the stack when it landed on none.
async function makeLayer(over: string | null): Promise<void>
{
  const taken = new Set(S.LAYERS.map((name) => name.toLowerCase()));
  let n = S.LAYERS.length + 1;
  while (taken.has("layer " + n)) n++;
  const at = over === null ? S.LAYERS.length : S.LAYERS.indexOf(over) + 1;
  await ask({
    title: "New layer",
    caption: over === null || at >= S.LAYERS.length ? "On top of the stack." : "Above " + S.LAYERS[at - 1] + ".",
    value: "Layer " + n,
    submit: async (name) =>
    {
      if (name === "") return "Give the layer a name.";
      if (name.length > MAX_NAME) return "Keep the name to " + MAX_NAME + " characters.";
      if (taken.has(name.toLowerCase())) return "There is already a layer called " + name + ".";
      const layers = [...S.LAYERS];
      layers.splice(at, 0, name);
      const problem = await postJson("architecture", { layers });
      if (problem !== null) return problem;
      await refreshGraph(true);
      return null;
    },
  });
}

// A cube: a file on the layer it landed on, in the folder and kind most of that layer's files are.
async function makeFile(layer: string | null): Promise<void>
{
  if (layer === null)
  {
    say(S.LAYERS.length === 0 ? "Make a layer first: drop a plane." : "Drop the cube onto a layer.");
    return;
  }
  const defaults = layerDefaults(layer);
  const known = pathIndex().files;
  let name = "untitled" + defaults.extension, n = 2;
  while (known.has(defaults.folder + name)) name = "untitled" + n++ + defaults.extension;
  await ask({
    title: "New file",
    caption: "On " + layer + ", in " + (defaults.folder === "" ? "the repository's root" : defaults.folder) + ".",
    value: name,
    submit: async (typed) =>
    {
      if (typed === "") return "Give the file a name.";
      // A name with a slash is a path from the root; a bare name goes in the layer's usual folder, and a name with no dot gets its usual extension.
      let path = typed.includes("/") ? typed.replace(/^\/+/, "") : defaults.folder + typed;
      if (!path.slice(path.lastIndexOf("/") + 1).includes(".")) path += defaults.extension;
      if (known.has(path)) return path + " already exists.";
      return postNewFile({
        path, layer, tags: defaults.tags,
        summary: "A new file on the " + layer + " layer; what it is for is not written yet.",
        ...(defaults.system !== "" ? { system: defaults.system } : {}),
      });
    },
  });
}

// A cloud: the files inside the loop, kept as a named concept (a flow with no route), then lit.
async function finishConcept(loop: readonly { x: number; y: number }[]): Promise<void>
{
  try
  {
    const paths = loop.length < 3 ? [] : filesIn(loop);
    if (paths.length === 0) { say(loop.length < 3 ? "Drag a loop around files." : "No files inside the loop."); return; }
    const taken = await flowNames();
    let n = taken.size + 1;
    while (taken.has("concept " + n)) n++;
    await ask({
      title: "New concept",
      caption: paths.length + (paths.length === 1 ? " file" : " files") + " in the loop.",
      value: "Concept " + n,
      submit: async (name) =>
      {
        if (name === "") return "Give the concept a name.";
        if (name.length > MAX_NAME) return "Keep the name to " + MAX_NAME + " characters.";
        if ((await flowNames()).has(name.toLowerCase())) return name + " is already a saved flow or concept.";
        const flow = { name, title: name, note: "A concept of " + paths.length + (paths.length === 1 ? " file." : " files."), trace: false, files: paths.map((path) => ({ path, note: "" })) };
        const problem = await postJson("flows", { action: "save", flow });
        if (problem !== null) return problem;
        // The concept lights its files, so it can be seen where it landed.
        return postJson("flows", { action: "show", name });
      },
    });
  }
  finally { clearLasso(); }
}

// The saved flows' names, lower case, since a flow and a concept share one list.
async function flowNames(): Promise<Set<string>>
{
  try
  {
    const answer = await (await fetch(api("flows"))).json() as { flows?: { name: string }[] };
    return new Set((answer.flows ?? []).map((flow) => flow.name.toLowerCase()));
  }
  catch { return new Set(); }
}

// Posts a change to the server. Returns the reason it was refused, or null.
async function postJson(endpoint: string, body: unknown): Promise<string | null>
{
  try
  {
    const response = await fetch(api(endpoint), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return null;
    if (response.status === 403) return "This map is read only here, so it cannot change anything.";
    const answer = await response.json().catch(() => ({})) as { error?: string };
    return answer.error || "The change was not made.";
  }
  catch { return "The map server did not answer."; }
}

/* --------------------------------------------------------------- entries ---- */

for (const button of document.querySelectorAll<HTMLElement>("[data-build]")) button.addEventListener("click", () => setBuilding(true));

// Escape leaves build mode, unless a prompt is open, which takes the key for itself.
document.addEventListener("keydown", (event) =>
{
  if (event.key === "Escape" && S.building && !promptOpen() && drag === null) setBuilding(false);
});
