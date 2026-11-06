import { S, V3, scene, glowMaterial } from "./state.js";
import { filePath } from "./panels.js";

let edgeLines = null;
let edgeShapes = [];
let brokenCount = 0;

// The point on a gentle arch from a to b, bowed upward so bundles read as strands.
function archPoint(a, b, bow, t)
{
  const mid = V3.Center(a, b);
  mid.y += bow;
  const u = 1 - t;
  return new V3(
    u * u * a.x + 2 * u * t * mid.x + t * t * b.x,
    u * u * a.y + 2 * u * t * mid.y + t * t * b.y,
    u * u * a.z + 2 * u * t * mid.z + t * t * b.z);
}

// Every folder import on screen, as two ends and how it should look. An import that
// points up the layers — something lower down using something built on top of it —
// is a break: the one kind that means the layers are tangled.
function collectEdges()
{
  const result = [];
  const byId = new Map(S.NODES.map((n) => [n.id, n]));
  for (const [from, to, count] of S.EDGES)
  {
    const user = byId.get(from), used = byId.get(to);
    if (!user || !used || user.hidden || used.hidden || user.cx === undefined || used.cx === undefined) continue;
    const broken = user.rank < used.rank;
    let state = "normal";
    if (S.selected >= 0) state = user.index === S.selected ? "out" : used.index === S.selected ? "in" : "dim";
    result.push({
      user: new V3(user.cx, user.baseY + 0.5, user.cz),
      used: new V3(used.cx, used.baseY + 0.5, used.cz),
      broken, state, weight: count,
    });
  }

  // The chosen file's own imports and importers, drawn file to file.
  const chosen = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : null;
  if (chosen !== null)
  {
    for (const [from, to] of S.FILE_EDGES)
    {
      if (from !== chosen && to !== chosen) continue;
      const user = S.fileRecords.get(from), used = S.fileRecords.get(to);
      if (!user || !used) continue;
      const broken = S.NODES[user.node].rank < S.NODES[used.node].rank;
      result.push({
        user: user.mesh.position, used: used.mesh.position,
        broken, state: from === chosen ? "out" : "in", weight: 1,
      });
    }
  }
  return result;
}

// Redraws every import: quiet hairlines for the crowd, and solid strands with
// arrowheads for the chosen block's imports and for every layer break.
function rebuildEdges()
{
  if (edgeLines) edgeLines.dispose();
  for (const shape of edgeShapes) shape.dispose();
  edgeLines = null;
  edgeShapes = [];

  const edges = collectEdges();
  brokenCount = edges.filter((edge) => edge.broken).length;
  updateBreaks();
  const lines = [], colors = [];
  const SEGMENTS = 16;
  for (const edge of edges)
  {
    const length = V3.Distance(edge.user, edge.used);
    const bow = Math.min(6, 0.25 * length + 0.3);
    const state = edge.state;
    const solid = state === "out" || state === "in" || (edge.broken && state !== "dim");

    if (solid)
    {
      const hex = edge.broken ? "#f85149" : state === "out" ? "#58a6ff" : "#d29922";
      addStrand(edge, bow, hex, edge.broken && state === "normal" ? 0.035 : 0.05);
      continue;
    }

    // A hairline fading from the imported end to the end that uses it, so direction still reads.
    const busy = Math.min(0.55, 0.22 + 0.06 * Math.log2(1 + edge.weight));
    const base = state === "dim" ? 0.05 : busy;
    const points = [], shades = [];
    for (let i = 0; i <= SEGMENTS; i++)
    {
      const t = i / SEGMENTS;
      points.push(archPoint(edge.used, edge.user, bow, t));
      shades.push(new BABYLON.Color4(0.55, 0.64, 0.75, base * (0.35 + 0.65 * t)));
    }
    lines.push(points);
    colors.push(shades);
  }
  if (lines.length > 0)
  {
    edgeLines = BABYLON.MeshBuilder.CreateLineSystem("edges", { lines, colors, useVertexAlpha: true }, scene);
    edgeLines.isPickable = false;
  }
}

// One solid strand from the imported end to the user, with an arrowhead where it is used.
function addStrand(edge, bow, hex, radius)
{
  const path = [];
  for (let i = 0; i <= 20; i++) path.push(archPoint(edge.used, edge.user, bow, i / 20));
  const tube = BABYLON.MeshBuilder.CreateTube("strand", { path, radius, tessellation: 6 }, scene);
  tube.material = glowMaterial(hex);
  tube.isPickable = false;
  edgeShapes.push(tube);

  const tip = path[path.length - 1], before = path[path.length - 3];
  const direction = tip.subtract(before).normalize();
  const head = BABYLON.MeshBuilder.CreateCylinder("arrow", { diameterTop: 0, diameterBottom: radius * 7, height: radius * 10, tessellation: 8 }, scene);
  head.material = glowMaterial(hex);
  head.isPickable = false;
  head.position = tip.subtract(direction.scale(radius * 9));
  head.rotationQuaternion = new BABYLON.Quaternion();
  BABYLON.Quaternion.FromUnitVectorsToRef(V3.Up(), direction, head.rotationQuaternion);
  edgeShapes.push(head);
}

// Shows how many imports break the downward-only rule, in the legend.
function updateBreaks()
{
  const note = document.getElementById("breaks-count");
  if (!note) return;
  note.textContent = brokenCount === 0
    ? "none — every import points down"
    : brokenCount + " import" + (brokenCount === 1 ? "" : "s") + " pointing up";
  note.classList.toggle("bad", brokenCount > 0);
}

export { rebuildEdges };
