import { S, V3, scene, camera, canvas, engine, loadingNote, render } from "./state.js";
import { settleCamera } from "./meshes.js";
import { applyHighlight } from "./highlight.js";
import { rebuildEdges } from "./edges.js";
import { updateLabels } from "./labels.js";
import { select, selectFile } from "./panels.js";
import { setSpin, refreshGraph } from "./controls.js";
import { loadRepo } from "./repo.js";
import { routeTargets } from "./route.js";
import { syncPads } from "./pads.js";
import "./view.js";

/** What a mesh's metadata carries: which folder and file it stands for. */
interface MeshMeta
{
  file: number;
  node: number;
  path: string;
}
const metaOf = (mesh: BABYLON.Mesh): MeshMeta | null => mesh.metadata as MeshMeta | null;

/* -------------------------------------------------------- interaction ---- */

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
    if (event.buttons) { setSpin(false); return; }
    const hit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => { const m = metaOf(mesh); return mesh.isPickable && !!m && m.file >= 0; });
    const path = hit && hit.hit ? metaOf(hit.pickedMesh)!.path : null;
    canvas.style.cursor = path ? "pointer" : "";
    if (path !== S.hoveredPath) { S.hoveredPath = path; render(); }
    return;
  }
  if (info.type !== BABYLON.PointerEventTypes.POINTERTAP || event.button === 2) return;

  // A file always wins over the tile under it, so a tap lands on what it looks like it does.
  const fileHit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => { const m = metaOf(mesh); return !!m && m.file >= 0; });
  if (fileHit && fileHit.hit)
  {
    const meta = metaOf(fileHit.pickedMesh)!;
    selectFile(meta.node, meta.file);
    return;
  }
  const plateHit = scene.pick(scene.pointerX, scene.pointerY, (mesh) => { const m = metaOf(mesh); return !!m && m.file === -1; });
  select(plateHit && plateHit.hit ? metaOf(plateHit.pickedMesh)!.node : -1);
});

/* --------------------------------------------------------------- frame ---- */

window.addEventListener("resize", () => engine.resize());

// Each frame: spin, glide the camera and every file toward its spot, redraw the
// highlight and imports when something changed, then draw and place the labels.
let lastFrame = performance.now();
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

  let moving = false;
  for (const rec of S.fileRecords.values())
  {
    const position = rec.mesh.position, scaling = rec.mesh.scaling;
    if (V3.DistanceSquared(position, rec.target) > 1e-6 || V3.DistanceSquared(scaling, rec.targetSize) > 1e-6)
    {
      V3.LerpToRef(position, rec.target, share, position);
      V3.LerpToRef(scaling, rec.targetSize, share, scaling);
      moving = true;
    }
  }

  if (S.dirty) applyHighlight();
  if (S.dirty || moving) { rebuildEdges(); syncPads(); }
  S.dirty = false;

  loadingNote.style.display = S.NODES.length > 0 ? "none" : "";
  scene.render();
  updateLabels();
});

setSpin(true);
select(-1);
refreshGraph();
loadRepo().then(() => { S.graphSignature = ""; refreshGraph(); });
