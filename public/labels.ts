import { S, V3, scene, camera, canvas, labelLayer, colorFor, filePath, matchesFilters, nodeMatchesFilters, renderEdges } from "./state.js";
import { labelOf, plateLabel } from "./repo.js";
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
interface ScreenBox { left: number; right: number; top: number; bottom: number }

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
    const filtered = !nodeMatchesFilters(i);
    const labelled = hue !== undefined || i === S.selected || (S.focusSet !== null && S.focusSet.has(i)) || (n.level ?? 0) <= 1;
    if (!labelled) return;
    const pos = new V3(n.cx, n.topY! + 0.5, n.cz!);
    const dim = filtered || (S.focusSet !== null && !S.focusSet.has(i) && hue === undefined);
    wanted.push({ key: "d" + i, text: plateLabel(n), pos, cls: i === S.selected ? "folder sel" : hue && !filtered ? "folder routed" : "folder",
      caption: "",
      priority: i === S.selected || (hue && !filtered) ? 2 : dim ? 5 : 3,
      color: i === S.selected ? "" : filtered ? "#6e7681" : hue || colorFor(n.layer), opacity: dim ? 0.25 : 1 });
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
    // While a tag filter is on, dim every other file's name out of the way.
    if (!hovered && !matchesFilters(rec.path)) continue;
    const pos = rec.shape.position.clone();
    pos.y += rec.shape.scaling.y / 2 + 0.12;
    const name = rec.path.split("/").pop()!;
    const chosenFile = rec.node === S.selected && rec.file === S.selectedFile;
    const tags = S.FILE_TAGS.get(rec.path);
    // Only the file you chose or point at gets the tags line; the rest stay to one row.
    const caption = (chosenFile || hovered) && tags ? tags.join(" · ") : "";
    wanted.push({ key: "f" + rec.path, text: name, pos,
      caption,
      priority: hovered ? 0 : chosenFile ? 1 : 4,
      cls: hovered ? "file hover" : "file", color: "", opacity: 1 });
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
const ROW = 18, RAIL_GAP = 70;

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

/** Whether the page is in its phone layout (mobile.ts). */
function onPhone(): boolean { return document.body.classList.contains("phone"); }

// How much of the screen's bottom is covered by the controls: the bottom bars on a computer, or the
// tab bar and the strip naming the choice above it on a phone.
function bottomReserve(): number
{
  if (!onPhone()) return 90;
  const tabs = document.getElementById("mtabs"), peek = document.getElementById("mpeek");
  return (tabs ? tabs.offsetHeight : 67) + (peek && !peek.hidden ? peek.offsetHeight + 6 : 0) + 10;
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
function updateRail(width: number, height: number, transform: BABYLON.Matrix, viewport: BABYLON.Viewport): ScreenBox[]
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
  for (const row of Array.from(railEl.children) as HTMLElement[])
  {
    const was = row.classList.contains("chosen"), is = row.dataset.path === chosen;
    row.classList.toggle("chosen", is);
    // A step chosen on the map scrolls into view in a rail too long for the screen.
    if (is && !was) row.scrollIntoView({ block: "nearest" });
  }

  // Where each traced file is on screen: the middle of its block's near face.
  const spots = new Map<string, { x: number; y: number }>();
  for (const path of new Set(steps))
  {
    const rec = S.fileRecords.get(path);
    if (!rec) continue;
    const p = V3.Project(rec.shape.position, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    if (p.z < 0 || p.z > 1) continue;
    spots.set(path, { x: p.x, y: p.y });
  }

  // The rail stays inside the free part of the screen: no wider than the open columns allow and no taller
  // than the band above the controls, scrolling when a long route needs more.
  const phone = onPhone();
  const [open0, open1] = openSpan(width);
  const bandTop = phone ? 10 : 16, bandBottom = height - bottomReserve();
  railEl.style.maxHeight = Math.max(ROW * 2, bandBottom - bandTop).toFixed(0) + "px";
  railEl.style.maxWidth = (phone ? Math.min(230, width * 0.48) : Math.min(340, open1 - open0 - 24)).toFixed(0) + "px";
  railEl.classList.toggle("docked", phone);
  const railWidth = railEl.offsetWidth, railHeight = railEl.offsetHeight;

  const xs = [...spots.values()].map((s) => s.x), ys = [...spots.values()].map((s) => s.y);
  const minX = xs.length ? Math.min(...xs) : width / 2, maxX = xs.length ? Math.max(...xs) : width / 2;
  const midY = ys.length ? (Math.min(...ys) + Math.max(...ys)) / 2 : height / 2;
  let onRight: boolean, railX: number;
  if (phone)
  {
    // On a phone the rail docks to a screen edge, the one away from the files, so it covers less of them.
    onRight = (minX + maxX) / 2 < width / 2;
    railX = onRight ? width - railWidth - 6 : 6;
  }
  else
  {
    // On a computer it sits beside the files, on the side with room, centred on them.
    const roomRight = open1 - 12 - (maxX + RAIL_GAP + railWidth);
    const roomLeft = (minX - RAIL_GAP - railWidth) - (open0 + 12);
    onRight = roomRight >= 0 || roomRight >= roomLeft;
    railX = onRight ? maxX + RAIL_GAP : minX - RAIL_GAP - railWidth;
    railX = Math.max(open0 + 12, Math.min(open1 - 12 - railWidth, railX));
  }
  const railY = Math.max(bandTop, Math.min(bandBottom - railHeight, midY - railHeight / 2));
  railEl.style.transform = "translate(" + railX.toFixed(1) + "px," + railY.toFixed(1) + "px)";
  railEl.classList.toggle("left", !onRight);

  // A leader line from each row's inner edge to its file's block: a short level stub, then straight on.
  svgEl.setAttribute("width", String(width));
  svgEl.setAttribute("height", String(height));
  let d = "";
  const edgeX = onRight ? railX : railX + railWidth, dir = onRight ? -1 : 1;
  const rows = Array.from(railEl.children) as HTMLElement[];
  steps.forEach((path, i) =>
  {
    const spot = spots.get(path), row = rows[i];
    if (!spot || !row) return;
    // Only the rows scrolled into view get a line.
    const y0 = railY + row.offsetTop - railEl.scrollTop + row.offsetHeight / 2;
    if (y0 < railY || y0 > railY + railHeight) return;
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

/* ---------------------------------------------------------- layer legend ---- */

// The layers' names sit in a column at one side of the free screen, top plane first, each tied to its
// plane by a leader line, as the step rail is tied to its files. A double click on a name shows only
// that layer, and a double click on the layer shown alone brings them all back (controls.ts).
let legend: HTMLDivElement | null = null, legendSvg: SVGSVGElement | null = null, legendSignature = "";
const legendFeet: SVGCircleElement[] = [];
const LEGEND_ROW = 22, LEGEND_STUB = 14;
// How much nearer another corner must be, in pixels, before the lines move to it.
const LEGEND_HOLD = 40;

function ensureLegend(): void
{
  if (legend) return;
  legendSvg = document.createElementNS(SVG, "svg") as SVGSVGElement;
  legendSvg.id = "layer-lines";
  labelLayer.appendChild(legendSvg);
  legend = document.createElement("div");
  legend.id = "layer-legend";
  labelLayer.appendChild(legend);
}

// Which corner of the planes the leader lines end on: the corner nearest the legend, so the lines run a
// short way across the map and not over it. Every plane uses the same one, so the lines keep the planes'
// order. It is kept until another corner is clearly nearer, so a line rides on its corner as the map turns
// rather than hopping between them. A corner that is off the screen, as a phone's often are, is reached
// where its outline comes into view beside the legend.
let legendCorner = -1;

/** One plane's four corners on screen, in the same order for every plane. */
function planeCorners(plane: BABYLON.Mesh, transform: BABYLON.Matrix, viewport: BABYLON.Viewport): BABYLON.Vector3[]
{
  const info = plane.getBoundingInfo().boundingBox;
  const y = plane.position.y;
  const x0 = info.minimumWorld.x, x1 = info.maximumWorld.x, z0 = info.minimumWorld.z, z1 = info.maximumWorld.z;
  return [new V3(x0, y, z0), new V3(x1, y, z0), new V3(x1, y, z1), new V3(x0, y, z1)]
    .map((corner) => V3.Project(corner, BABYLON.Matrix.IdentityReadOnly, transform, viewport));
}

// Where each plane's leader line ends on screen, or null for a plane with no usable end.
function planeAnchors(planes: BABYLON.Mesh[], onRight: boolean, edgeX: number, span: [number, number], height: number,
  transform: BABYLON.Matrix, viewport: BABYLON.Viewport): ({ x: number; y: number } | null)[]
{
  const corners = planes.map((plane) => planeCorners(plane, transform, viewport));
  const dir = onRight ? -1 : 1;
  // Distance past the legend's edge, going away from it.
  const past = (p: BABYLON.Vector3) => (p.x - edgeX) * dir;
  const reach = LEGEND_STUB * 2;
  const usable = (p: BABYLON.Vector3) => p.z >= 0 && p.z <= 1 && p.y >= 0 && p.y <= height && p.x >= span[0] && p.x <= span[1];
  // The corner's own place when it is beside the legend, else where the outline to a neighbour crosses
  // `reach` past the legend's edge.
  const endOf = (four: BABYLON.Vector3[], corner: number): { x: number; y: number } | null =>
  {
    const c = four[corner];
    if (c.z < 0 || c.z > 1) return null;
    if (past(c) >= reach) return usable(c) ? { x: c.x, y: c.y } : null;
    let best: { x: number; y: number } | null = null;
    for (const next of [(corner + 1) % 4, (corner + 3) % 4])
    {
      const n = four[next];
      if (n.z < 0 || n.z > 1 || past(n) <= past(c)) continue;
      const t = (reach - past(c)) / (past(n) - past(c));
      if (t < 0 || t > 1) continue;
      const point = { x: c.x + (n.x - c.x) * t, y: c.y + (n.y - c.y) * t };
      // Of the two edges, the one that meets the line nearer the corner.
      if (usable(new V3(point.x, point.y, 0)) && (best === null || t < 0.5)) best = point;
    }
    return best;
  };
  const reached = (corner: number) => corners.filter((four) => endOf(four, corner) !== null).length;
  // How far, on average, one corner of every plane is past the legend: the nearest is the one most to its side.
  const gapOf = (corner: number) => corners.reduce((sum, four) => sum + past(four[corner]), 0) / corners.length;
  let best = -1, bestGap = Infinity;
  for (let corner = 0; corner < 4; corner++)
  {
    if (reached(corner) * 2 < planes.length) continue;
    const gap = gapOf(corner);
    if (gap < bestGap) { best = corner; bestGap = gap; }
  }
  const keep = legendCorner >= 0 && reached(legendCorner) * 2 >= planes.length && gapOf(legendCorner) <= bestGap + LEGEND_HOLD;
  if (best >= 0 && !keep) legendCorner = best;
  if (legendCorner < 0) return planes.map(() => null);
  return corners.map((four) => endOf(four, legendCorner));
}

// Places the legend and its leader lines for this frame, and returns the screen box it takes.
function updateLegend(width: number, height: number, transform: BABYLON.Matrix, viewport: BABYLON.Viewport): ScreenBox[]
{
  const planes = [...S.layerPlanes].sort((a, b) => (b.metadata as { rank: number }).rank - (a.metadata as { rank: number }).rank);
  if (planes.length === 0)
  {
    if (legend) legend.style.display = "none";
    if (legendSvg) legendSvg.style.display = "none";
    return [];
  }
  ensureLegend();
  const box = legend!, svgEl = legendSvg!;
  box.style.display = "";
  svgEl.style.display = "";

  const names = planes.map((plane) => (plane.metadata as { layer: string }).layer);
  // A picked layer that is no longer drawn lets the others back.
  if (S.spotLayer !== null && !names.includes(S.spotLayer)) { S.spotLayer = null; renderEdges(); }
  const alone = S.spotLayer;
  const signature = names.join("\n") + "|" + (alone ?? "");
  if (signature !== legendSignature)
  {
    legendSignature = signature;
    box.textContent = "";
    for (const name of names)
    {
      const row = document.createElement("div");
      row.className = "lrow" + (name === alone ? " alone" : alone !== null ? " faded" : "");
      row.dataset.layer = name;
      row.textContent = name;
      row.style.borderColor = colorFor(name);
      row.title = name === alone ? "Double-click to bring every layer back" : "Double-click to pick out this layer";
      box.appendChild(row);
    }
  }

  // The legend goes on the left of the free screen, or on the right while the step rail is on the left.
  const [open0, open1] = openSpan(width);
  const onRight = Boolean(rail && rail.style.display !== "none" && rail.classList.contains("left"));
  box.classList.toggle("right", onRight);
  const rows = Array.from(box.children) as HTMLElement[];
  const legendWidth = Math.max(...rows.map((row) => row.offsetWidth));
  const legendX = onRight ? open1 - 12 - legendWidth : open0 + 12;
  box.style.transform = "translate(" + legendX.toFixed(1) + "px,0)";

  const edgeX = onRight ? legendX : legendX + legendWidth, dir = onRight ? -1 : 1;

  // The rows are an even list, top plane first, fixed in the middle of the band above the bottom bars, so
  // it stays still as the map turns; the leader lines fan out from it, as from the step rail.
  const bars = document.getElementById("dock-bottom");
  const barsTop = bars && bars.offsetHeight > 0 && !onPhone() ? bars.getBoundingClientRect().top - 10 : height;
  const bandTop = 24, bandBottom = Math.min(height - bottomReserve(), barsTop);
  const tall = rows.length * LEGEND_ROW;
  const top = Math.max(bandTop, (bandTop + bandBottom - tall) / 2);
  const ys = rows.map((_, i) => top + i * LEGEND_ROW);
  const anchors = planeAnchors(planes, onRight, edgeX, [open0, open1], bandBottom, transform, viewport);

  svgEl.setAttribute("width", String(width));
  svgEl.setAttribute("height", String(height));
  let feet = 0;
  const paths: string[] = rows.map(() => "");
  rows.forEach((row, i) =>
  {
    row.style.transform = "translate(" + (onRight ? legendWidth - row.offsetWidth : 0).toFixed(1) + "px," + ys[i].toFixed(1) + "px)";
    const anchor = anchors[i];
    // A line only where the plane lies past the legend's inner edge, so it never doubles back over the names.
    if (!anchor || (anchor.x - edgeX) * dir < LEGEND_STUB) return;
    const rowEdge = onRight ? legendX + legendWidth - row.offsetWidth : legendX + row.offsetWidth;
    const y0 = ys[i] + row.offsetHeight / 2, stubX = edgeX + dir * LEGEND_STUB;
    paths[i] = "M" + rowEdge.toFixed(1) + " " + y0.toFixed(1) + "L" + stubX.toFixed(1) + " " + y0.toFixed(1) +
      "L" + anchor.x.toFixed(1) + " " + anchor.y.toFixed(1);
    let foot = legendFeet[feet];
    if (!foot) { foot = document.createElementNS(SVG, "circle"); foot.setAttribute("r", "2.5"); svgEl.appendChild(foot); legendFeet.push(foot); }
    feet++;
    foot.setAttribute("cx", anchor.x.toFixed(1));
    foot.setAttribute("cy", anchor.y.toFixed(1));
    foot.style.fill = colorFor(names[i]);
    foot.style.opacity = S.spotLayer !== null && names[i] !== S.spotLayer ? "0.3" : "";
    foot.style.display = "";
  });
  for (let i = feet; i < legendFeet.length; i++) legendFeet[i].style.display = "none";
  // One line per row, in its layer's colour, kept behind the feet.
  const lines = Array.from(svgEl.querySelectorAll("path"));
  paths.forEach((d, i) =>
  {
    let line = lines[i];
    if (!line) { line = document.createElementNS(SVG, "path"); svgEl.insertBefore(line, svgEl.querySelector("circle")); lines.push(line); }
    line.setAttribute("d", d);
    line.style.stroke = colorFor(names[i]);
    line.style.strokeOpacity = S.spotLayer !== null && names[i] !== S.spotLayer ? "0.2" : "";
  });
  for (let i = paths.length; i < lines.length; i++) lines[i].setAttribute("d", "");
  return [{ left: legendX, right: legendX + legendWidth, top, bottom: top + tall }];
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
  taken.push(...updateLegend(width, height, transform, viewport));
  for (const item of collectLabels())
  {
    const p = V3.Project(item.pos, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    const onScreen = p.z >= 0 && p.z <= 1 && p.x >= -80 && p.x <= width + 80 && p.y >= -30 && p.y <= height + 30;
    if (!onScreen) continue;
    // Try the label with its caption, nudged a little up or down if its spot is crowded;
    // failing that, the name alone; failing that, it is left off this frame.
    const nameHalf = item.text.length * (item.cls.startsWith("file") ? 3.1 : 3.5) + 6;
    const fits = (b: ScreenBox) => !taken.some((t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top);
    let caption = "", box: ScreenBox | null = null, shift = 0;
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
