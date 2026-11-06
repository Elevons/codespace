import { S, V3, scene, camera, canvas, labelLayer, colorFor } from "./state.js";
import { shortLabel, depthOf } from "./repo.js";

const labelPool = [];

// What to name on screen: shallow folders and the chosen block's neighbourhood,
// the chosen folder's files once you are close, and the file under the pointer.
function collectLabels()
{
  const wanted = [];
  S.NODES.forEach((n, i) =>
  {
    if (n.hidden || n.cx === undefined) return;
    const labelled = i === S.selected || (S.focusSet !== null && S.focusSet.has(i)) || depthOf(n.id) <= 1;
    if (!labelled) return;
    const pos = new V3(n.cx, n.baseY + 0.55, n.cz);
    const dim = S.focusSet !== null && !S.focusSet.has(i);
    wanted.push({ key: "d" + i, text: shortLabel(n.id), pos, cls: i === S.selected ? "folder sel" : "folder",
      caption: "",
      priority: i === S.selected ? 2 : dim ? 5 : 3,
      color: i === S.selected ? "" : colorFor(n.layer), opacity: dim ? 0.3 : 1 });
  });

  // File names: the chosen folder's files when close up, and whatever is hovered.
  for (const rec of S.fileRecords.values())
  {
    const near = camera.radius < 40;
    const named = rec.path === S.hoveredPath || (near && rec.node === S.selected);
    if (!named) continue;
    const pos = rec.mesh.position.clone();
    pos.y += rec.mesh.scaling.y / 2 + 0.12;
    const name = rec.path.split("/").pop();
    const chosenFile = rec.node === S.selected && rec.file === S.selectedFile;
    wanted.push({ key: "f" + rec.path, text: name, pos,
      priority: rec.path === S.hoveredPath ? 0 : chosenFile ? 1 : 4,
      cls: rec.path === S.hoveredPath ? "file hover" : "file", color: "", opacity: 1 });
  }
  return wanted.sort((a, b) => a.priority - b.priority);
}

// Places the HTML labels over the scene for this frame.
function updateLabels()
{
  const width = canvas.clientWidth, height = canvas.clientHeight;
  const transform = scene.getTransformMatrix();
  const viewport = camera.viewport.toGlobal(width, height);
  let used = 0;
  const taken = [];   // the screen boxes already claimed this frame, so names never pile up
  for (const item of collectLabels())
  {
    const p = V3.Project(item.pos, BABYLON.Matrix.IdentityReadOnly, transform, viewport);
    if (p.z < 0 || p.z > 1 || p.x < -80 || p.x > width + 80 || p.y < -30 || p.y > height + 30) continue;
    // Try the label with its caption, nudged a little up or down if its spot is crowded;
    // failing that, the name alone; failing that, it is left off this frame.
    const nameHalf = item.text.length * (item.cls.startsWith("file") ? 3.1 : 3.5) + 6;
    const fits = (b) => !taken.some((t) => b.left < t.right && b.right > t.left && b.top < t.bottom && b.bottom > t.top);
    let caption = "", box = null, shift = 0;
    const tries = [];
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
