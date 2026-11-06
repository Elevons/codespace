import { S, V3, scene, camera, canvas, labelLayer, colorFor, filePath } from "./state.js";
import { labelOf } from "./repo.js";
import { routeFolderHues, routeRuns, runLine } from "./route.js";

/** One name, tag, or step the page wants on screen this frame. */
interface LabelItem
{
  key: string;
  text: string;
  pos: BABYLON.Vector3;
  cls: string;
  caption: string;
  priority: number;
  color: string;
  opacity: number;
}

/** A screen box already claimed, so names never pile up. */
interface Box { left: number; right: number; top: number; bottom: number }

const labelPool: HTMLDivElement[] = [];

// What to name on screen: shallow folders and the chosen block's neighbourhood,
// the chosen folder's files once you are close, and the file under the pointer.
// A traced code path's files are named in the step rail instead (see updateRail).
function collectLabels(): LabelItem[]
{
  const wanted: LabelItem[] = [];
  const hues = routeFolderHues();
  S.NODES.forEach((n, i) =>
  {
    if (n.hidden || n.cx === undefined) return;
    const hue = hues.get(i);
    const labelled = hue !== undefined || i === S.selected || (S.focusSet !== null && S.focusSet.has(i)) || (n.level ?? 0) <= 1;
    if (!labelled) return;
    const pos = new V3(n.cx, n.topY! + 0.5, n.cz!);
    const dim = S.focusSet !== null && !S.focusSet.has(i) && hue === undefined;
    wanted.push({ key: "d" + i, text: labelOf(n), pos, cls: i === S.selected ? "folder sel" : hue ? "folder routed" : "folder",
      caption: "",
      priority: i === S.selected || hue ? 2 : dim ? 5 : 3,
      color: i === S.selected ? "" : hue || colorFor(n.layer), opacity: dim ? 0.3 : 1 });
  });

  // Each floor strip under the route's lane is named for its folder at its leading end.
  routeRuns().forEach((run, i) =>
  {
    const n = S.NODES[run.node];
    if (!n) return;
    wanted.push({ key: "r" + i, text: labelOf(n), pos: runLine(run)[0], cls: "folder routed strip",
      caption: "", priority: 2, color: run.hue, opacity: 1 });
  });

  // File names: the chosen folder's files when close up, and whatever is hovered.
  const railed = S.trace && S.trace.trace;
  for (const rec of S.fileRecords.values())
  {
    const near = camera.radius < 40;
    const shown = S.trace !== null && S.trace.set.has(rec.path);
    const hovered = rec.path === S.hoveredPath;
    if (railed && shown && !hovered) continue;
    const named = shown || hovered || (near && rec.node === S.selected);
    if (!named) continue;
    const pos = rec.mesh.position.clone();
    pos.y += rec.mesh.scaling.y / 2 + 0.12;
    const name = rec.path.split("/").pop()!;
    const chosenFile = rec.node === S.selected && rec.file === S.selectedFile;
    const tags = S.FILE_TAGS.get(rec.path);
    wanted.push({ key: "f" + rec.path, text: name, pos,
      caption: tags ? tags.join(" · ") : "",
      priority: hovered ? 0 : chosenFile ? 1 : 4,
      cls: hovered ? "file hover" : "file", color: "", opacity: 1 });
  }
  // Layer band names at the plane's corner, when the repository declares layers.
  for (const plane of S.layerPlanes)
  {
    const info = plane.getBoundingInfo().boundingBox;
    const meta = plane.metadata as { layer: string; rank: number };
    wanted.push({ key: "L" + meta.rank, text: "layer · " + meta.layer,
      pos: new V3(info.minimumWorld.x, plane.position.y, info.minimumWorld.z),
      cls: "layer", caption: "", color: "", opacity: 1, priority: 0 });
  }
  return wanted.sort((a, b) => a.priority - b.priority);
}

/* ------------------------------------------------------------ step rail ---- */

// A traced code path reads as a numbered list beside the files, in order from the top,
// with a leader line from each step to a numbered pin on its file's block. The rail sits
// in the open space between the side panels, on whichever side of the files has room.
const SVG = "http://www.w3.org/2000/svg";
let rail: HTMLOListElement | null = null, railSvg: SVGSVGElement | null = null, railSignature = "";
const feet: SVGCircleElement[] = [];
const ROW = 36, RAIL_GAP = 70;

function ensureRail(): void
{
  if (rail) return;
  railSvg = document.createElementNS(SVG, "svg") as SVGSVGElement;
  railSvg.id = "trace-lines";
  labelLayer.appendChild(railSvg);
  rail = document.createElement("ol");
  rail.id = "trace-rail";
  labelLayer.appendChild(rail);
}

// The screen columns free of the side panels.
function openSpan(width: number): [number, number]
{
  let left = 0, right = width;
  const dockLeft = document.getElementById("dock-left"), dockRight = document.getElementById("dock-right");
  if (dockLeft && dockLeft.offsetHeight > 0) left = Math.max(left, dockLeft.getBoundingClientRect().right);
  if (dockRight && dockRight.offsetHeight > 0) right = Math.min(right, dockRight.getBoundingClientRect().left);
  if (right - left < 200) return [0, width];   // narrow screens stack the panels; use the full width
  return [left, right];
}

// Places the rail, its leader lines, and the pins for this frame, and returns the screen
// boxes they take so the other labels keep clear of them.
function updateRail(width: number, height: number, transform: BABYLON.Matrix, viewport: BABYLON.Viewport): Box[]
{
  const steps = S.trace && S.trace.trace ? S.trace.paths : [];
  if (steps.length === 0)
  {
    if (rail) { rail.style.display = "none"; }
    if (railSvg) { railSvg.style.display = "none"; }
    return [];
  }
  ensureRail();
  const railEl = rail!, svgEl = railSvg!;
  railEl.style.display = "";
  svgEl.style.display = "";

  // The rows: one per step, in order, each edged in its folder's route colour and naming that folder.
  const hues = routeFolderHues();
  const folderOf = (path: string): number => { const rec = S.fileRecords.get(path); return rec ? rec.node : -1; };
  const signature = steps.map((path) => path + "|" + (S.FILE_TAGS.get(path) || []).join(",") + "|" + (hues.get(folderOf(path)) || "")).join("\n");
  if (signature !== railSignature)
  {
    railSignature = signature;
    railEl.textContent = "";
    steps.forEach((path, i) =>
    {
      const row = document.createElement("li");
      row.dataset.path = path;
      row.title = path;
      const badge = document.createElement("b");
      badge.textContent = String(i + 1);
      row.appendChild(badge);
      const name = document.createElement("span");
      name.textContent = path.split("/").pop()!;
      const node = folderOf(path), hue = hues.get(node);
      if (hue) name.style.borderLeft = "3px solid " + hue;
      const tags = S.FILE_TAGS.get(path);
      const line = document.createElement("small");
      if (node >= 0)
      {
        const folder = document.createElement("i");
        folder.textContent = labelOf(S.NODES[node]);
        if (hue) folder.style.color = hue;
        line.appendChild(folder);
      }
      if (tags) line.appendChild(document.createTextNode((node >= 0 ? " · " : "") + tags.join(" · ")));
      if (line.childNodes.length) name.appendChild(line);
      row.appendChild(name);
      railEl.appendChild(row);
    });
  }
  const chosen = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
  for (const row of Array.from(railEl.children) as HTMLElement[]) row.classList.toggle("chosen", row.dataset.path === chosen);

  // Where each traced file is on screen: the middle of its block's near face.
  const spots = new Map<string, { x: number; y: number }>();
  for (const path of new Set(steps))
  {
    const rec = S.fileRecords.get(path);
    if (!rec) continue;
    const p = V3.Project(rec.mesh.position, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    if (p.z < 0 || p.z > 1) continue;
    spots.set(path, { x: p.x, y: p.y });
  }

  // Put the rail beside the files, on the side with room, centred on them.
  const railWidth = railEl.offsetWidth, railHeight = steps.length * ROW;
  const [open0, open1] = openSpan(width);
  const xs = [...spots.values()].map((s) => s.x), ys = [...spots.values()].map((s) => s.y);
  const minX = xs.length ? Math.min(...xs) : width / 2, maxX = xs.length ? Math.max(...xs) : width / 2;
  const midY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : height / 2;
  const roomRight = open1 - 12 - (maxX + RAIL_GAP + railWidth);
  const roomLeft = (minX - RAIL_GAP - railWidth) - (open0 + 12);
  const onRight = roomRight >= 0 || roomRight >= roomLeft;
  let railX = onRight ? maxX + RAIL_GAP : minX - RAIL_GAP - railWidth;
  railX = Math.max(open0 + 12, Math.min(open1 - 12 - railWidth, railX));
  const railY = Math.max(16, Math.min(height - 90 - railHeight, midY - railHeight / 2));
  railEl.style.transform = "translate(" + railX.toFixed(1) + "px," + railY.toFixed(1) + "px)";
  railEl.classList.toggle("left", !onRight);

  // A leader line from each row's inner edge to its file's block: a short level stub, then straight on.
  svgEl.setAttribute("width", String(width));
  svgEl.setAttribute("height", String(height));
  let d = "";
  const edgeX = onRight ? railX : railX + railWidth, dir = onRight ? -1 : 1;
  steps.forEach((path, i) =>
  {
    const spot = spots.get(path);
    if (!spot) return;
    const y0 = railY + i * ROW + ROW / 2;
    const stubX = edgeX + dir * 14;
    d += "M" + edgeX.toFixed(1) + " " + y0.toFixed(1) + "L" + stubX.toFixed(1) + " " + y0.toFixed(1) +
      "L" + spot.x.toFixed(1) + " " + spot.y.toFixed(1);
  });
  let line = svgEl.firstChild as SVGPathElement | null;
  if (!line) { line = document.createElementNS(SVG, "path"); svgEl.appendChild(line); }
  line.setAttribute("d", d);

  // A small foot where each line meets its block, like the tethers' feet on the floor.
  let used = 0;
  for (const spot of spots.values())
  {
    let foot = feet[used];
    if (!foot) { foot = document.createElementNS(SVG, "circle"); foot.setAttribute("r", "3"); svgEl.appendChild(foot); feet.push(foot); }
    used++;
    foot.setAttribute("cx", spot.x.toFixed(1));
    foot.setAttribute("cy", spot.y.toFixed(1));
    foot.style.display = "";
  }
  for (let i = used; i < feet.length; i++) feet[i].style.display = "none";
  return [{ left: railX, right: railX + railWidth, top: railY, bottom: railY + railHeight }];
}

// Places the HTML labels over the scene for this frame.
function updateLabels(): void
{
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const transform = scene.getTransformMatrix();
  const viewport = camera.viewport.toGlobal(width, height);
  let used = 0;
  // The screen boxes already claimed this frame, so names never pile up; the step rail goes first.
  const taken = updateRail(width, height, transform, viewport);
  for (const item of collectLabels())
  {
    const p = V3.Project(item.pos, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    if (p.z < 0 || p.z > 1 || p.x < -80 || p.x > width + 80 || p.y < -30 || p.y > height + 30) continue;
    // Try the label with its caption, nudged a little up or down if its spot is crowded;
    // failing that, the name alone; failing that, it is left off this frame.
    const nameHalf = item.text.length * (item.cls.startsWith("file") ? 3.1 : 3.5) + 6;
    const fits = (b: Box) => !taken.some((t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top);
    let caption = "", box: Box | null = null, shift = 0;
    const tries: [boolean, number][] = [];
    for (const withCaption of item.caption ? [true, false] : [false])
    {
      for (const dy of [0, -16, 16, -32, 32]) tries.push([withCaption, dy]);
    }
    for (const [withCaption, dy] of tries)
    {
      const half = withCaption ? Math.max(nameHalf, item.caption.length * 2.9 + 6) : nameHalf;
      const candidate = { left: p.x - half, right: p.x + half, top: p.y + dy - (withCaption ? 30 : 17), bottom: p.y + dy };
      if (fits(candidate)) { box = candidate; caption = withCaption ? item.caption : ""; shift = dy; break; }
    }
    if (box === null) continue;
    p.y += shift;
    taken.push(box);
    let element = labelPool[used];
    if (!element)
    {
      element = document.createElement("div");
      labelLayer.appendChild(element);
      labelPool.push(element);
    }
    used++;
    const signature = item.key + "|" + item.cls + "|" + item.text + "|" + caption;
    if (element.dataset.signature !== signature)
    {
      element.dataset.signature = signature;
      element.className = "label " + item.cls;
      element.textContent = item.text;
      if (caption)
      {
        const line = document.createElement("small");
        line.textContent = caption;
        element.appendChild(line);
      }
    }
    element.style.color = item.color;
    element.style.opacity = String(item.opacity);
    element.style.transform = "translate(" + p.x.toFixed(1) + "px," + p.y.toFixed(1) + "px) translate(-50%,-100%)";
    element.style.display = "";
  }
  for (let i = used; i < labelPool.length; i++) labelPool[i].style.display = "none";
}

export { updateLabels };
