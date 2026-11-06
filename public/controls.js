import { S, camera, DEFAULT_ALPHA } from "./state.js";
import { build } from "./city.js";
import { centerView, recenterTarget } from "./meshes.js";
import { select, renderLegend, renderHierarchy } from "./panels.js";
import { loadGraph } from "./repo.js";

// Fetches the live graph and, only when it has actually changed, redraws it.
async function refreshGraph()
{
  let graph;
  try
  {
    graph = await loadGraph();
  }
  catch (error) { return; }
  if (graph.nodes.length === 0) return;

  const signature = JSON.stringify(graph.nodes.map((node) => node.id + ":" + node.files.length)) +
    JSON.stringify(graph.edges) + JSON.stringify(graph.fileEdges) + JSON.stringify([...graph.lines]);
  if (signature === S.graphSignature) return;
  S.graphSignature = signature;

  S.NODES = graph.nodes;
  S.EDGES = graph.edges;
  S.FILE_EDGES = graph.fileEdges;
  S.FILE_LINES = graph.lines;
  renderLegend();
  S.selected = -1;
  S.selectedFile = -1;
  S.focusSet = null;
  if (!S.hasCentered) applyTestsToggle();
  build();
  if (!S.hasCentered) { centerView(true); S.hasCentered = true; }
  select(-1);
  renderHierarchy();
}

document.getElementById("refresh").addEventListener("click", () => { S.graphSignature = ""; refreshGraph(); });
document.getElementById("live").addEventListener("click", (event) =>
{
  S.liveOn = !S.liveOn;
  event.target.textContent = "Live: " + (S.liveOn ? "on" : "off");
  event.target.classList.toggle("on", S.liveOn);
});
setInterval(() => { if (S.liveOn && !document.hidden) refreshGraph(); }, 15000);

/* ------------------------------------------------- bottom controls ---- */

// The layer-spread slider pulls the nesting levels apart or presses them together.
const spreadSlider = document.getElementById("spread");
spreadSlider.addEventListener("input", () =>
{
  S.levelGap = Number(spreadSlider.value);
  build();
  recenterTarget();
});

// On phones the folders panel collapses to its heading.
const hierarchyPanel = document.getElementById("hierarchy");
const hierarchyToggle = document.getElementById("hierarchy-toggle");
hierarchyToggle.addEventListener("click", () =>
{
  const collapsed = hierarchyPanel.classList.toggle("collapsed");
  hierarchyToggle.textContent = collapsed ? "Show" : "Hide";
  hierarchyToggle.setAttribute("aria-expanded", String(!collapsed));
});

// The folders panel lists the whole tree; a checkbox hides a folder and its subtree.
document.getElementById("hierarchy-tree").addEventListener("change", (event) =>
{
  const box = event.target;
  if (!box || box.type !== "checkbox") return;
  const id = box.getAttribute("data-id");
  if (box.checked) S.hiddenFolders.delete(id);
  else S.hiddenFolders.add(id);
  build();
  recenterTarget();
  renderHierarchy();
});

function setSpin(on)
{
  S.autoSpin = on;
  const b = document.getElementById("spin");
  b.textContent = "Spin: " + (on ? "on" : "off");
  b.classList.toggle("on", on);
}
document.getElementById("spin").addEventListener("click", () => setSpin(!S.autoSpin));
document.getElementById("reset").addEventListener("click", () => {
  camera.alpha = DEFAULT_ALPHA;
  centerView(false);
  select(-1);
});

// Shows or hides the extras at once — tests, docs, scripts, assets, loose top-level
// files. They start hidden so the map shows only the code that does the work.
const EXTRA_FOLDER = /(^|\/)tests$|^docs$|^scripts$|^game\/public$/;
function testFolderIds() { return S.NODES.filter((n) => EXTRA_FOLDER.test(n.id)).map((n) => n.id); }
function applyTestsToggle()
{
  for (const id of testFolderIds())
  {
    if (S.testsShown) S.hiddenFolders.delete(id);
    else S.hiddenFolders.add(id);
  }
  const button = document.getElementById("tests");
  button.textContent = "Extras: " + (S.testsShown ? "shown" : "hidden");
  button.classList.toggle("on", S.testsShown);
}
document.getElementById("tests").addEventListener("click", () =>
{
  S.testsShown = !S.testsShown;
  applyTestsToggle();
  build();
  centerView(false);
  renderHierarchy();
});

export { setSpin, applyTestsToggle, refreshGraph };
