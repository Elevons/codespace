import { CODE_FILE } from "./symbols.js";
import { passesSliceValues, type SliceAxis } from "./filter.js";
import type { Box, CamGoal, ColorBy, FileRecord, GraphNode, OutlinerState, Trace } from "./types.js";

// ---- constants ----
export const V3 = BABYLON.Vector3;
export const FILE_SIZE = 0.72, FILE_H = 0.46;
// The treemap gives each file this much floor: its box, centred, with air all round.
export const AREA_PER_WEIGHT = 2.0;
// Spacing: between sibling folder tiles, and from a tile's edge to what it holds.
export const TILE_GAP = 0.7, MARGIN = 0.55, PLATE_H = 0.06, FLOOR_STEP = 0.035;
export const DEFAULT_ALPHA = -Math.PI / 2 - 0.62, DEFAULT_BETA = 0.95;
const LAYER_GAP = 3;
export { CODE_FILE };

// ---- the mutable world ----
export const S = {
  NODES: [] as GraphNode[],                    // the live graph, read from the server
  EDGES: [] as [string, string, number][],     // [from folder id, to folder id, count]
  FILE_EDGES: [] as [string, string][],        // [importer path, imported path] for every import between two files
  FILE_LINES: new Map<string, number>(),       // each code file's line count, which sets its size
  FILE_TAGS: new Map<string, string[]>(),      // path -> the tags the architecture file gives it
  FILE_SUMMARIES: new Map<string, string>(),   // path -> what the architecture file says the file is for
  FILE_SYMBOLS: new Map<string, string[]>(),   // path -> the names it declares, for search
  FILE_CHANGES: new Map<string, number>(),     // path -> changed lines since HEAD, for the changes colouring
  ARCH_NOTES: [] as string[],                  // problems found in the architecture file, to show
  FILE_LAYERS: new Map<string, string>(),      // path -> the layer the architecture file puts it in
  FILE_SYSTEMS: new Map<string, string>(),     // path -> the system the architecture file puts it in
  LAYERS: [] as string[],                      // the layer names, bottom plane first
  SYSTEMS: [] as string[],                     // the declared system names, in deck order
  outliner: {
    query: "",
    systems: new Set<string>(),
    layers: new Set<string>(),
    group: "folder",
    hiddenFiles: new Set<string>(),
    shownFiles: new Set<string>(),
    collapsed: new Set<string>(),
  } as OutlinerState,
  layerPlanes: [] as BABYLON.Mesh[],           // the translucent planes, one per layer
  shownLayers: [] as string[],                 // the layers that still hold a drawn file, bottom plane first
  layerGap: LAYER_GAP,                         // the vertical spacing between layer planes, set by the spread slider
  boxes: [] as Box[],                          // one entry per visible file, with its terrace spot
  trace: null as Trace | null,                 // what the map is asked to show: { paths, set, trace, title, note, notes }, or null
  hiddenFolders: new Set<string>(),            // folder ids the map has hidden, with their subtrees
  fileRecords: new Map<string, FileRecord>(),  // path -> { shape, slot, node, file, path, target, targetSize }
  selected: -1,
  selectedFile: -1,                            // which file inside the chosen folder is highlighted, or -1
  autoSpin: true,
  focusSet: null as Set<number> | null,        // node indices kept bright while one folder is chosen
  dirty: true,                                 // the highlight and edges need redrawing on the next frame
  edgesDirty: false,                           // the import strands and pillars need rebuilding, not just recolouring
  hoveredPath: null as string | null,          // the file under the pointer, named while hovered
  camGoal: null as CamGoal | null,             // where the camera is gliding to, or null once it is there
  liveOn: true,
  hasCentered: false,
  graphSignature: "",
  extrasShown: false,                          // whether the extras (tests, docs, library code) are shown
  colorBy: "tag" as ColorBy,                   // what the boxes are coloured by
  tagFilter: null as string | null,            // the tag the tag filter is set to, or null for none
  fingerprint: "",                             // the repository's change stamp from the last full read
  repoName: "Codespace",                       // the repository being shown, as the server names it
  repoRoot: "",                                // its folder on the machine running Codespace
  ingestOnly: true,                            // show only files that the architecture file already describes
  undescribed: 0,                              // how many files that leaves out of the map
  plateMesh: null as BABYLON.Mesh | null,      // every folder tile, batched into one mesh
  plateLines: null as BABYLON.Mesh | null,     // the tile outlines, batched into one line system
};

/** Folders the Extras toggle hides by default: tests, docs, scripts, assets, and library code. */
const EXTRA_FOLDER = /(^|\/)(tests|node_modules|bower_components|jspm_packages|vendor|third_party|third-party|site-packages|__pycache__|\.venv|venv|Pods|Carthage)$|^docs$|^scripts$|^\.codespace$|^game\/public$/;

/** Whether a folder counts as an extra: tests, docs, scripts, assets, or library code. */
function isExtraFolder(id: string): boolean
{
  return EXTRA_FOLDER.test(id);
}

/** Every folder the Extras toggle acts on, named or user-chosen. */
export function extraFolderIds(): string[]
{
  return S.NODES.filter((node) => isExtraFolder(node.id)).map((node) => node.id);
}

// ---- the layers ----

const LAYER_PALETTE = ["#2aa198", "#3b78c2", "#e0a72e", "#9b59b6", "#3fb950", "#e06c75", "#8b949e", "#ff8ac4"];
const layerColors = new Map<string, string>();   // layer name -> colour

// The colour of one layer, taken from the palette and kept for the whole run.
export function colorFor(layer: string): string
{
  if (!layerColors.has(layer)) layerColors.set(layer, LAYER_PALETTE[layerColors.size % LAYER_PALETTE.length]);
  return layerColors.get(layer)!;
}

// Systems are slices of the repository; each keeps a steady colour, apart from the layer palette.
const SYSTEM_PALETTE = ["#58a6ff", "#3fb950", "#c297ff", "#ffa657", "#56d4dd", "#e3b341", "#f778ba", "#ff7b72"];
const systemColors = new Map<string, string>();

/** The colour for one system, or a neutral grey for a file with none. */
export function colorForSystem(system: string): string
{
  if (system === "") return "#6e7681";
  if (!systemColors.has(system))
  {
    const index = S.SYSTEMS.indexOf(system);
    systemColors.set(system, index >= 0 ? SYSTEM_PALETTE[index % SYSTEM_PALETTE.length] : "#8b949e");
  }
  return systemColors.get(system)!;
}

/** The folder a path lives in, or "" for the repository root. */
export function folderOf(path: string): string
{
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

/** The label for a system in the outliner; an unassigned file gets a readable placeholder. */
export function systemLabel(system: string): string
{
  return system === "" ? "unassigned" : system;
}

// The words shown for one layer in the filter strip.
export function labelFor(layer: string): string
{
  return layer.replace(/[-_]+/g, " ");
}

/** The colour for each tag, so files read by role once they carry tags. */
const TAG_COLORS: Record<string, string> = {
  entry: "#f0883e", orchestrate: "#d2a8ff", core: "#58a6ff", data: "#7ee787",
  io: "#ff7b72", ui: "#39d2c0", config: "#8b949e", test: "#e3b341",
};

// The colour of one tag, or a neutral grey for anything unfamiliar.
function colorForTag(tag: string): string
{
  return TAG_COLORS[tag] ?? "#8b949e";
}

/** The colours a folder's boxes cycle through when the map is coloured by folder. */
const FOLDER_HUES = ["#58a6ff", "#d2a8ff", "#ffa657", "#56d4dd", "#e3b341", "#f778ba", "#7ee787", "#ff7b72"];

// A steady colour for the folder a path lives in, so neighbours read as one group.
export function folderColor(path: string): string
{
  const folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  let hash = 0;
  for (const ch of folder) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return FOLDER_HUES[hash % FOLDER_HUES.length];
}

// Blends two hex colours, t from 0 for the first to 1 for the second.
function mixHex(a: string, b: string, t: number): string
{
  const from = BABYLON.Color3.FromHexString(a), to = BABYLON.Color3.FromHexString(b);
  const channel = (low: number, high: number) => Math.round((low + (high - low) * t) * 255).toString(16).padStart(2, "0");
  return "#" + channel(from.r, to.r) + channel(from.g, to.g) + channel(from.b, to.b);
}

// A cool-to-warm ramp by line count, so the big files stand out.
function sizeColor(lines: number): string
{
  return mixHex("#24476b", "#f0b03e", Math.min(1, Math.sqrt(Math.max(0, lines) / 500)));
}

// A warm-to-hot ramp by changed lines, with neutral grey for a file untouched since HEAD.
function changeColor(weight: number): string
{
  if (weight <= 0) return "#2b3440";
  return mixHex("#e3b341", "#f85149", Math.min(1, Math.sqrt(weight / 60)));
}

// The colour of one file: by the map's chosen colouring, which defaults to its first tag.
export function fileColor(path: string, layer: string): string
{
  if (S.colorBy === "system") return colorForSystem(S.FILE_SYSTEMS.get(path) ?? "");
  if (S.colorBy === "folder") return folderColor(path);
  if (S.colorBy === "size") return sizeColor(linesOf(path));
  if (S.colorBy === "changes") return changeColor(S.FILE_CHANGES.get(path) || 0);
  if (S.colorBy === "layer") return colorFor(layer);
  const tags = S.FILE_TAGS.get(path);
  return tags && tags.length > 0 ? colorForTag(tags[0]) : colorFor(layer);
}

// Whether a file carries the tag the tag filter is set to, or any tag when nothing is filtered.
export function matchesTagFilter(path: string): boolean
{
  if (S.tagFilter === null) return true;
  return (S.FILE_TAGS.get(path) || []).includes(S.tagFilter);
}

// Whether a file passes the filter strip: it must sit in a selected system and a selected layer,
// when either strip has a selection. `skip` ignores one axis, so that axis can count its own values.
export function passesSlice(path: string, skip: SliceAxis | null = null): boolean
{
  return passesSliceValues(S.FILE_SYSTEMS.get(path), S.FILE_LAYERS.get(path), S.outliner.systems, S.outliner.layers, skip);
}

// Whether a file passes both the tag filter and the filter strip, so the scene can draw only the rest.
export function matchesFilters(path: string): boolean
{
  return matchesTagFilter(path) && passesSlice(path);
}

// Whether a file stays bright under the current choice: the files being shown (S.trace) when there
// are some, the chosen folder and its neighbours otherwise, and always the filters when any are on.
export function isLitRecord(rec: FileRecord): boolean
{
  if (!matchesFilters(rec.path)) return false;
  if (S.trace) return S.trace.set.has(rec.path);
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

// Glides the camera to one file, close enough to read it.
export function frameFile(rec: FileRecord, currentRadius: number): void
{
  S.autoSpin = false;
  window.dispatchEvent(new Event("codespace:spin"));
  S.camGoal = { target: rec.target.clone(), radius: Math.min(currentRadius, 24) };
}

// Glides the camera to one folder, close enough that its files read.
export function frameFolder(n: GraphNode, currentRadius: number): void
{
  if (n.cx === undefined) return;
  const reach = Math.max(n.tileW ?? 8, n.tileD ?? 8);
  S.autoSpin = false;
  window.dispatchEvent(new Event("codespace:spin"));
  S.camGoal = { target: new V3(n.cx, n.topY!, n.cz!), radius: Math.max(8, Math.min(currentRadius, reach * 0.9 + 6)) };
}

/** Whether any filter is active, from the tag filter or the filter strip. */
export function hasFilters(): boolean
{
  return S.tagFilter !== null || S.outliner.systems.size > 0 || S.outliner.layers.size > 0;
}

// Whether a folder holds a file that passes both filters.
export function nodeMatchesFilters(nodeIndex: number): boolean
{
  const n = S.NODES[nodeIndex];
  return n.files.some((_, i) => matchesFilters(filePath(nodeIndex, i)));
}

// Whether a file is hidden from the scene altogether: an eye on its file, or on a folder above it.
export function isFileVisible(path: string): boolean
{
  // A file's own eye wins over its folder, so any file can be brought back.
  if (S.outliner.shownFiles.has(path)) return true;
  if (S.outliner.hiddenFiles.has(path)) return false;
  // Loose top-level files (readme, package files) count as extras.
  if (!S.extrasShown && !path.includes("/")) return false;
  for (let dir = folderOf(path); ; dir = folderOf(dir))
  {
    if (S.hiddenFolders.has(dir)) return false;
    if (dir === "") break;
  }
  return true;
}

// Whether a file is drawn in the scene: no eye hides it, and it passes every active filter.
export function inScene(path: string): boolean
{
  return isFileVisible(path) && matchesFilters(path);
}

// A layer's place among the layers that still hold a drawn file, or -1 when it holds none. Planes
// stack by this rank, so hiding or filtering a layer away closes the gap it leaves.
export function layerRank(layer: string): number
{
  return S.shownLayers.indexOf(layer);
}

// Whether a path names a code file whose line count sets its box height.
export function isCode(path: string): boolean { return CODE_FILE.test(path); }

// A code file's line count, or zero when it has not been read.
export function linesOf(path: string): number { return S.FILE_LINES.get(path) || 0; }

// Every redraw request just marks the scene dirty; the frame loop does the work once.
export function render(): void { S.dirty = true; }

// A change that moves the strands' endpoints or their colours: a choice, filter, trace, or layout.
export function renderEdges(): void { S.dirty = true; S.edgesDirty = true; }

// Copies text, falling back to a hidden box when the page is not secure enough for the Clipboard API.
export async function copyText(text: string): Promise<boolean>
{
  try
  {
    if (navigator.clipboard !== undefined && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  }
  catch { /* fall through to the old way */ }
  try
  {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
  catch { return false; }
}

// The repository-relative path of one file within a folder block. Read from the node list,
// so the layout, the edges, and the panels all name files the same way.
export function filePath(nodeIndex: number, fileIndex: number): string
{
  const n = S.NODES[nodeIndex];
  const file = n.files[fileIndex];
  return n.id ? n.id + "/" + file : file;
}

// ---- the scene ----
export const canvas = document.getElementById("scene") as HTMLCanvasElement;
export const labelLayer = document.getElementById("labels") as HTMLElement;
export const loadingNote = document.getElementById("loading") as HTMLElement;

export const engine = new BABYLON.Engine(canvas, true, { antialias: true, stencil: true }, true);
export const scene = new BABYLON.Scene(engine);

// A software rasteriser (a headless preview, a VM) cannot afford the frame's full pixel work.
// There, the page renders a little smaller and starts with bloom off; a real GPU keeps both.
const softwareRenderer = (() =>
{
  const gl = (engine as unknown as { _gl?: WebGLRenderingContext })._gl;
  if (!gl) return false;
  const debug = gl.getExtension("WEBGL_debug_renderer_info");
  const name = String((debug ? gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) ?? "");
  return /swiftshader|llvmpipe|software|basic render|mesa offscreen/i.test(name);
})();
if (softwareRenderer) engine.setHardwareScalingLevel(1.5);
// A phone's screen can be three device pixels to each CSS pixel; past two, the extra pixels cost
// frame time and battery without making the map any easier to read.
else if (window.devicePixelRatio > 2) engine.setHardwareScalingLevel(1 / 2);
const BACKGROUND = BABYLON.Color3.FromHexString("#04070d");
scene.clearColor = BACKGROUND.toColor4(1);
scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
scene.fogColor = BABYLON.Color3.FromHexString("#0e3350");
scene.fogDensity = 0.007;

// Quiet bloom, so what matters (the chosen file, a traced route, a layer break) lights up
// against a matte city instead of every box glowing alike. The buffers stay small and the
// blur is tight: a full-size, wide-kernel glow was a measurable slice of every frame.
export const glow = new BABYLON.GlowLayer("glow", scene, {
  mainTextureFixedSize: 256,
  blurKernelSize: 16,
  blurTextureSizeRatio: 0.5,
  mainTextureSamples: 1,
});
glow.intensity = 0.55;
if (softwareRenderer) glow.isEnabled = false;

export const camera = new BABYLON.ArcRotateCamera("camera", DEFAULT_ALPHA, DEFAULT_BETA, 46, V3.Zero(), scene);
camera.attachControl(canvas, true);
camera.minZ = 0.1;
camera.maxZ = 2000;
camera.lowerRadiusLimit = 2;
camera.upperRadiusLimit = 600;
camera.lowerBetaLimit = 0.02;
camera.upperBetaLimit = Math.PI - 0.02;
camera.wheelDeltaPercentage = 0.02;

// The camera zooms on the wheel, but the browser would also scroll the page that
// holds this view (a board preview iframe, for one). Keep the wheel on the canvas:
// cancel the page scroll while the camera still reads the same event.
canvas.addEventListener("wheel", (event) => event.preventDefault(), { passive: false });
camera.pinchDeltaPercentage = 0.004;
camera.panningSensibility = 80;
camera.inertia = 0.82;

const sky = new BABYLON.HemisphericLight("sky", new V3(0.35, 1, 0.2), scene);
sky.intensity = 0.95;
sky.groundColor = new BABYLON.Color3(0.22, 0.25, 0.3);

// One material per colour, opacity, and glow, shared by every shape that uses it.
const materials = new Map<string, BABYLON.StandardMaterial>();
export function materialFor(hex: string, alpha: number, glow: number): BABYLON.StandardMaterial
{
  const key = hex + "|" + alpha.toFixed(2) + "|" + glow.toFixed(2);
  let material = materials.get(key);
  if (material) return material;
  const color = BABYLON.Color3.FromHexString(hex);
  material = new BABYLON.StandardMaterial("m" + materials.size, scene);
  material.diffuseColor = color;
  material.emissiveColor = color.scale(glow);
  material.specularColor = new BABYLON.Color3(0.06, 0.06, 0.06);
  material.alpha = alpha;
  materials.set(key, material);
  return material;
}

// A flat-coloured material that ignores the light, for edges and arrowheads.
export function glowMaterial(hex: string): BABYLON.StandardMaterial
{
  const key = "glow|" + hex;
  let material = materials.get(key);
  if (material) return material;
  material = new BABYLON.StandardMaterial(key, scene);
  material.disableLighting = true;
  material.emissiveColor = BABYLON.Color3.FromHexString(hex);
  materials.set(key, material);
  return material;
}
