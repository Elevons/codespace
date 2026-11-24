import { S, V3, scene, camera, canvas, engine, loadingNote, render } from "./state.js";
import { settleCamera, updatePulses } from "./meshes.js";
import { pickFile, placeBox, flushBoxes } from "./boxes.js";
import { rayBox } from "./rules.js";
import { applyHighlight } from "./highlight.js";
import { pickFloor, syncFloors } from "./floors.js";
import { rebuildEdges, updateFlow } from "./edges.js";
import { updateLabels } from "./labels.js";
import { openBlockAt, select, selectFile, toggleFileSelection } from "./panels.js";
import { setSpin, refreshGraph } from "./controls.js";
import { loadRepo } from "./repo.js";
import { routeTargets } from "./route.js";
import { conceptTargets, conceptTap, placeConceptLabels } from "./concepts.js";
import { syncPads } from "./pads.js";
import "./view.js";
import "./repo-switch.js";
import "./chat.js";
import "./insight.js";
import "./mobile.js";

/* -------------------------------------------------------- interaction ---- */

// The folder under a screen point, found by testing the pick ray against each tile's box rather
// than against a mesh. The tiles are batched into one mesh to draw fast, so they cannot name
// themselves; this keeps a click landing on the smallest, deepest tile under the pointer.
function pickFolder(x: number, y: number): number
{
  const ray = scene.createPickingRay(x, y, BABYLON.Matrix.IdentityReadOnly, camera);
  const o = ray.origin, d = ray.direction;
  let best = -1, bestArea = Infinity;
  for (let i = 0; i < S.NODES.length; i++)
  {
    const n = S.NODES[i];
    if (n.hidden || n.cx === undefined || n.tileW === undefined || n.tileD === undefined) continue;
    const t = rayBox(o, d, n.cx - n.tileW / 2, n.cx + n.tileW / 2, n.baseY!, n.topY!, n.cz! - n.tileD / 2, n.cz! + n.tileD / 2);
    if (t === null) continue;
    const area = n.tileW * n.tileD;
    if (area < bestArea) { bestArea = area; best = i; }
  }
  return best;
}

// A pointer move only marks a pick as wanted; the frame loop does one pick at most per frame,
// so a fast mouse does not cost a scene-wide hit test on every event.
let pickWanted = false;

// A tap picks the file or folder under it; dragging orbits, right-drag pans, and
// the wheel or a pinch zooms, all handled by the camera itself.
scene.onPointerObservable.add((info) =>
{
  const event = info.event;
  if (info.type === BABYLON.PointerEventTypes.POINTERDOWN || info.type === BABYLON.PointerEventTypes.POINTERWHEEL)
  {
    S.camGoal = null;
    if (info.type === BABYLON.PointerEventTypes.POINTERWHEEL) setSpin(false);
    return;
  }
  if (info.type === BABYLON.PointerEventTypes.POINTERMOVE)
  {
    if (event.buttons) { setSpin(false); pickWanted = false; return; }
    pickWanted = true;
    return;
  }
  if (info.type !== BABYLON.PointerEventTypes.POINTERTAP || event.button === 2) return;
  if (conceptTap()) return;

  // An open file's floors win over its cube, so a tap lands on the block it looks like it does.
  const blockHit = pickFloor(scene.pointerX, scene.pointerY);
  if (blockHit !== null) { openBlockAt(blockHit); return; }
  // A file always wins over the tile under it, so a tap lands on what it looks like it does.
  // Shift (or Cmd/Ctrl) on a file adds it to the selection, or takes it out again.
  const fileHit = pickFile(scene.pointerX, scene.pointerY);
  if (fileHit)
  {
    if (event.shiftKey || event.metaKey || event.ctrlKey) toggleFileSelection(fileHit.node, fileHit.file);
    else selectFile(fileHit.node, fileHit.file);
    return;
  }
  select(pickFolder(scene.pointerX, scene.pointerY));
});

/* --------------------------------------------------------------- frame ---- */

window.addEventListener("resize", () => engine.resize());

// Each frame: spin, glide the camera and every file toward its spot, redraw the
// highlight and imports when something changed, then draw and place the labels.
let lastFrame = performance.now();
// Strands and labels are the expensive redraws, so they run at their own steady rates:
// the scene still renders every frame, and a settled map rebuilds nothing.
const EDGE_INTERVAL = 1 / 12;
const LABEL_INTERVAL = 1 / 40;
let edgeClock = 0, labelClock = 0, wasMoving = false;
engine.runRenderLoop(() =>
{
  const now = performance.now();
  const seconds = Math.min(0.05, (now - lastFrame) / 1000);
  lastFrame = now;

  if (S.autoSpin) camera.alpha += seconds * 0.12;
  const share = 1 - Math.pow(0.002, seconds);
  settleCamera(share);

  // A shown route lifts its files onto an arch; everyone else heads back to their terrace.
  routeTargets();
  conceptTargets();

  let moving = false;
  for (const rec of S.fileRecords.values())
  {
    // A box that has just appeared waits its turn, then grows in from its tile.
    if (rec.delay !== undefined && rec.delay > 0) { rec.delay -= seconds; moving = true; continue; }
    const position = rec.shape.position, scaling = rec.shape.scaling;
    if (V3.DistanceSquared(position, rec.target) > 1e-6 || V3.DistanceSquared(scaling, rec.targetSize) > 1e-6)
    {
      V3.LerpToRef(position, rec.target, share, position);
      V3.LerpToRef(scaling, rec.targetSize, share, scaling);
      placeBox(rec);
      moving = true;
    }
  }

  // The hover name follows the pointer at most once per frame.
  if (pickWanted)
  {
    pickWanted = false;
    const hit = pickFile(scene.pointerX, scene.pointerY);
    const path = hit ? hit.path : null;
    canvas.style.cursor = path ? "pointer" : "";
    if (path !== S.hoveredPath)
    {
      S.hoveredPath = path;
      render();
      // The outliner row for the hovered box lights up with it, so the two views stay linked.
      document.querySelectorAll<HTMLElement>("#outliner-tree [data-path]").forEach((row) =>
      {
        row.classList.toggle("hl", row.getAttribute("data-path") === path);
      });
    }
  }

  // An edited file's flash decays over a second and a half, and the highlight redraws as it does.
  if (S.flashes.size > 0)
  {
    for (const [path, left] of S.flashes)
    {
      const next = left - seconds / 1.6;
      if (next <= 0) S.flashes.delete(path);
      else S.flashes.set(path, next);
    }
    S.dirty = true;
  }
  if (S.dirty) applyHighlight();
  syncFloors(seconds);
  flushBoxes();
  if (S.edgesDirty) { rebuildEdges(); syncPads(); edgeClock = 0; }
  else if (moving)
  {
    edgeClock += seconds;
    // Zoomed out to the concepts, only the files' own threads redraw, so they can follow every
    // frame; in the city the full wire set waits for its steady rate.
    if (S.conceptZoom || edgeClock >= EDGE_INTERVAL) { rebuildEdges(); edgeClock = 0; }
    // The layer rings are cheap to move and should not stutter behind a gliding box.
    syncPads();
  }
  else if (wasMoving) { rebuildEdges(); syncPads(); }
  S.dirty = false;
  S.edgesDirty = false;
  wasMoving = moving;

  updateFlow(seconds);
  updatePulses(now / 1000);

  loadingNote.style.display = S.NODES.length > 0 ? "none" : "";
  scene.render();
  placeConceptLabels();
  labelClock += seconds;
  if (labelClock >= LABEL_INTERVAL) { labelClock = 0; updateLabels(); }
});

setSpin(true);
select(-1);
refreshGraph();
loadRepo().then(() => { S.graphSignature = ""; refreshGraph(); });
