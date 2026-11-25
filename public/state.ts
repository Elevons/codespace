import { CODE_FILE } from "./symbols.js";
import { STACK_SCALE, type IBlocksReport } from "./blocks.js";
import { historyHeat, type ITimeline } from "./history.js";
import { passesSliceValues } from "./filter.js";
import { folderColor, folderOf, isFileVisible as fileVisible, layerRank as rankOf, nodeMatchesFilters as nodeMatches } from "./rules.js";
import { TAG_COLORS, type Tag } from "./tags.js";
import type { Box, CamGoal, ColorBy, Concepts, FileRecord, FileSpot, GraphNode, GroupAxis, OutlinerState, Trace } from "./types.js";

// ---- constants ----
export const V3 = BABYLON.Vector3;
export const FILE_SIZE = 0.72, FILE_H = 0.46;
// The treemap gives each file this much floor: its box, centred, with air all round.
export const AREA_PER_WEIGHT = 2.0;
// Spacing: between sibling folder tiles, and from a tile's edge to what it holds.
export const TILE_GAP = 0.7, MARGIN = 0.55, PLATE_H = 0.06, FLOOR_STEP = 0.035;
export const DEFAULT_ALPHA = -Math.PI / 2 - 0.62, DEFAULT_BETA = 0.95;
const LAYER_GAP = 3;
// The narrowest the spread slider allows, the gap the concept view collapses to.
export const MIN_LAYER_GAP = 0.3;

// ---- the mutable world ----
export const S = {
  NODES: [] as GraphNode[],                    // the live graph, read from the server
  EDGES: [] as [string, string, number][],     // [from folder id, to folder id, count]
  FILE_EDGES: [] as [string, string][],        // [importer path, imported path] for every import between two files
  FILE_LINES: new Map<string, number>(),       // each code file's line count, which sets its size
  FILE_TAGS: new Map<string, string[]>(),      // path -> the tags the architecture file gives it
  FILE_SUMMARIES: new Map<string, string>(),   // path -> what the architecture file says the file is for
  FILE_SYMBOLS: new Map<string, string[]>(),   // path -> the names it declares, for search
  FILE_STAMPS: new Map<string, string>(),      // path -> its size and modified time, to tell an edited file
  FILE_IMPORT_NAMES: new Map<string, Map<string, string[]>>(), // importer -> imported -> names it takes
  flashes: new Map<string, number>(),          // path -> how much of its edit flash is left, from 1 to 0
  BLOCKS: new Map<string, IBlocksReport>(),    // path -> the blocks its text is made of, read when the file is opened
  selectedBlock: -1,                           // which block of the opened file the rail picked, or -1
  floorAnchors: null as {
    path: string,
    user: BABYLON.Vector3,
    used: BABYLON.Vector3,
    chosen: BABYLON.Vector3 | null,
    chosenBox: { center: BABYLON.Vector3, size: BABYLON.Vector3 } | null,
    points: Map<string, BABYLON.Vector3>,
    kinds: Map<string, string>,
  } | null, // where the opened file's wires join its floors, and the chosen floor's box
  FILE_CHANGES: new Map<string, number>(),     // path -> changed lines since HEAD, for the changes colouring
  ARCH_NOTES: [] as string[],                  // problems found in the architecture file, to show
  CONCEPTS: { data: {}, operations: {} } as Concepts, // the operations and things the architecture file declares
  conceptZoom: false,                          // whether the map is zoomed out to operations and things
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
    shownExtraFolders: new Set<string>(),
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
  extraFiles: new Set<string>(),               // the other chosen files, when a selection holds several
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
  history: null as ITimeline | null,           // the git history, once the History tab has read it
  historyAt: 0,                                // the commit the history colouring stands at
  tagFilter: null as string | null,            // the tag the tag filter is set to, or null for none
  spotLayer: null as string | null,           // the layer picked from the legend: it stays bright and every other layer fades in place
  isolatedFiles: null as Set<string> | null,   // an ad-hoc filter: only these files are drawn, or null for none
  fingerprint: "",                             // the repository's change stamp from the last full read
  repoName: "Codespace",                       // the repository being shown, as the server names it
  repoRoot: "",                                // its folder on the machine running Codespace
  build: "",                                   // the page build stamp the map was loaded with
  ingestOnly: true,                            // show only files that the architecture file already describes
  undescribed: 0,                              // how many files that leaves out of the map
};

/** Folders the Extras toggle hides by default: tests, docs, scripts, assets, and library code. */
const EXTRA_FOLDER = /(^|\/)(tests|node_modules|bower_components|jspm_packages|vendor|third_party|third-party|site-packages|__pycache__|\.venv|venv|Pods|Carthage)$|^docs$|^scripts$|^\.codespace$/;

/** Whether a folder counts as an extra: tests, docs, scripts, assets, or library code. */
function isExtraFolder(id: string): boolean
{
  return EXTRA_FOLDER.test(id);
}

/** Whether the Extras toggle hides this folder: it is an extra, the extras are off, and no one re-showed it. */
export function hiddenByExtras(id: string): boolean
{
  return !S.extrasShown && pathIndex().extras.has(id) && !S.outliner.shownExtraFolders.has(id);
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

/** The label for a system in the outliner; an unassigned file gets a readable placeholder. */
export function systemLabel(system: string): string
{
  return system === "" ? "unassigned" : system;
}

/** The colour of one tag, or a neutral grey for anything unfamiliar. */
function colorForTag(tag: string): string
{
  return TAG_COLORS[tag as Tag] ?? "#8b949e";
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

// Not yet born is a dark ghost; a file the commit touched is hot, cooling to a quiet blue.
function historyColor(path: string): string
{
  const heat = S.history ? historyHeat(S.history, path, S.historyAt) : 0;
  if (heat < 0) return "#151a21";
  if (heat === 0) return "#2f5d8a";
  return heat < 0.5 ? mixHex("#2f5d8a", "#e3b341", heat * 2) : mixHex("#e3b341", "#f85149", (heat - 0.5) * 2);
}

// The colour of one file: by the map's chosen colouring, which defaults to its first tag.
export function fileColor(path: string): string
{
  const layer = S.FILE_LAYERS.get(path) ?? "";
  if (S.colorBy === "system") return colorForSystem(S.FILE_SYSTEMS.get(path) ?? "");
  if (S.colorBy === "folder") return folderColor(path);
  if (S.colorBy === "size") return sizeColor(linesOf(path));
  if (S.colorBy === "changes") return changeColor(S.FILE_CHANGES.get(path) || 0);
  if (S.colorBy === "history") return historyColor(path);
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

// One file's value on an axis, with "" for a file that has none.
export function sliceValue(path: string, axis: GroupAxis): string
{
  if (axis === "system") return S.FILE_SYSTEMS.get(path) ?? "";
  if (axis === "layer") return S.FILE_LAYERS.get(path) ?? "";
  return folderOf(path);
}

// Whether a file passes the filter strip: it must sit in a selected system and a selected layer,
// when either strip has a selection. `skip` ignores one axis, so that axis can count its own values.
export function passesSlice(path: string, skip: GroupAxis | null = null): boolean
{
  return passesSliceValues(sliceValue(path, "system"), sliceValue(path, "layer"), S.outliner.systems, S.outliner.layers, skip);
}

// Whether a file passes the ad-hoc isolation, the tag filter, and the filter strip, so the scene
// can draw only the rest.
export function matchesFilters(path: string): boolean
{
  if (S.isolatedFiles !== null && !S.isolatedFiles.has(path)) return false;
  return matchesTagFilter(path) && passesSlice(path);
}

// Whether a file is on the layer picked from the legend, or no layer is picked. A file off it is
// faded and grey, but stays where it stands, so the picked layer keeps its place in the stack.
export function inSpotLayer(path: string): boolean
{
  return S.spotLayer === null || S.FILE_LAYERS.get(path) === S.spotLayer;
}

// Whether a file stays bright under the current choice: the files being shown (S.trace) when there
// are some, the chosen folder and its neighbours otherwise, and always the filters when any are on.
export function isLitRecord(rec: FileRecord): boolean
{
  if (!matchesFilters(rec.path) || !inSpotLayer(rec.path)) return false;
  if (S.trace) return S.trace.set.has(rec.path);
  if (S.focusSet) return S.focusSet.has(rec.node);
  return true;
}

// Glides the camera to one file, close enough to read it and the block stack it opens into.
export function frameFile(rec: FileRecord): void
{
  S.autoSpin = false;
  window.dispatchEvent(new Event("codespace:spin"));
  if (S.conceptZoom)
  {
    // The concept view moves files to dots of its own, so go to where the dot is, not to the file's place in the layers.
    const radius = Math.min(camera.radius, 9);
    // On a phone the sheet covers the lower half, so aim a quarter of the screen below the dot to bring it into the upper half.
    const lift = document.body.classList.contains("phone") ? radius * Math.tan(camera.fov / 2) * 0.5 : 0;
    const a = camera.alpha, b = camera.beta;
    const up = new V3(-Math.cos(a) * Math.cos(b), Math.sin(b), -Math.sin(a) * Math.cos(b));
    S.camGoal = { target: rec.target.subtract(up.scale(lift)), radius };
    return;
  }
  // Frame the box and its block stack, not only the closed box: the stack stands 1.5× the box's
  // height, so its centre sits a quarter of a box-height above the box's. Fitting the stack keeps
  // every floor on screen and pulls a small file close enough to read.
  const height = rec.targetSize.y;
  const stack = height * STACK_SCALE;
  S.camGoal = {
    target: new V3(rec.target.x, rec.target.y + height * (STACK_SCALE - 1) / 2, rec.target.z),
    radius: Math.max(3, stack * 1.8),
  };
}

/** Glides the camera to the chosen block's floor, so one sliver of a tall stack can be read. */
export function frameBlock(rec: FileRecord): boolean
{
  const anchors = S.floorAnchors;
  if (S.conceptZoom || anchors === null || anchors.path !== rec.path || anchors.chosenBox === null) return false;
  S.autoSpin = false;
  window.dispatchEvent(new Event("codespace:spin"));
  // Fit the floor's own box: a thin block still leaves its neighbours in view, and a thick one
  // steps back rather than filling the screen.
  const { center, size } = anchors.chosenBox;
  S.camGoal = { target: center.clone(), radius: Math.max(2.5, Math.min(12, Math.max(size.y, size.x) * 6)) };
  return true;
}

// Glides the camera to one folder, close enough that its files read.
export function frameFolder(n: GraphNode, currentRadius: number): void
{
  // A folder has no place in the concept view, where files stand by operation.
  if (n.cx === undefined || S.conceptZoom) return;
  const reach = Math.max(n.tileW ?? 8, n.tileD ?? 8);
  S.autoSpin = false;
  window.dispatchEvent(new Event("codespace:spin"));
  S.camGoal = { target: new V3(n.cx, n.topY!, n.cz!), radius: Math.max(8, Math.min(currentRadius, reach * 0.9 + 6)) };
}

/** Whether any filter is active, from the tag filter or the filter strip. */
export function hasFilters(): boolean
{
  return S.isolatedFiles !== null || S.tagFilter !== null || S.outliner.systems.size > 0 || S.outliner.layers.size > 0;
}

// Whether isolation hides this file, whichever eyes and filters it passes.
export function isIsolated(path: string): boolean
{
  return S.isolatedFiles !== null && !S.isolatedFiles.has(path);
}

// Whether a folder holds a file that passes both filters.
export function nodeMatchesFilters(nodeIndex: number): boolean
{
  const n = S.NODES[nodeIndex];
  return nodeMatches(n.files.map((_, i) => filePath(nodeIndex, i)), matchesFilters);
}

// Whether a file is hidden from the scene altogether: an eye on its file, or on a folder above it.
export function isFileVisible(path: string): boolean
{
  return fileVisible(path, {
    shownFiles: S.outliner.shownFiles,
    hiddenFiles: S.outliner.hiddenFiles,
    hiddenFolders: S.hiddenFolders,
    extrasShown: S.extrasShown,
    hiddenByExtras,
  });
}

// Brings files back from an eye that hid them, so a chosen concept or slice always draws its files.
// A file's own eye wins over a folder's, so this opens the folders above it without showing the rest.
export function revealFiles(paths: Iterable<string>): boolean
{
  let changed = false;
  for (const path of paths)
  {
    if (isFileVisible(path)) continue;
    S.outliner.hiddenFiles.delete(path);
    S.outliner.shownFiles.add(path);
    changed = true;
  }
  return changed;
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
  return rankOf(layer, S.shownLayers);
}

// Whether a path names a code file whose line count sets its box height.
export function isCode(path: string): boolean { return CODE_FILE.test(path); }

// A code file's line count, or zero when it has not been read.
export function linesOf(path: string): number { return S.FILE_LINES.get(path) || 0; }

// Every redraw request just marks the scene dirty; the frame loop does the work once.
export function render(): void { S.dirty = true; }

// A change that moves the strands' endpoints or their colours: a choice, filter, trace, or layout.
export function renderEdges(): void { S.dirty = true; S.edgesDirty = true; }

/** Lights up files that were just edited, the way a chosen file is lit, and lets them fade. */
export function flashFiles(paths: readonly string[]): void
{
  for (const path of paths) S.flashes.set(path, 1);
  render();
}

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

/** Where every file and folder sits, rebuilt only when the node list itself is replaced. */
interface PathIndex
{
  nodes: GraphNode[];
  files: Map<string, [number, number]>;
  folders: Map<string, number>;
  extras: Set<string>;
  ordered: FileSpot[];
}
let pathIndexCache: PathIndex | null = null;

/** The cached path index for the current node list, so a lookup never scans the whole graph. */
export function pathIndex(): PathIndex
{
  if (pathIndexCache === null || pathIndexCache.nodes !== S.NODES)
  {
    const files = new Map<string, [number, number]>(), folders = new Map<string, number>(), extras = new Set<string>();
    const ordered: FileSpot[] = [];
    S.NODES.forEach((n, node) =>
    {
      folders.set(n.id, node);
      if (isExtraFolder(n.id)) extras.add(n.id);
      n.files.forEach((_name, file) =>
      {
        const path = filePath(node, file);
        files.set(path, [node, file]);
        ordered.push({ path, node, file });
      });
    });
    pathIndexCache = { nodes: S.NODES, files, folders, extras, ordered };
  }
  return pathIndexCache;
}

/** One file's [folder, file] indices, or [-1, -1] when no folder holds that path. */
export function fileIndex(path: string): [number, number]
{
  return pathIndex().files.get(path) ?? [-1, -1];
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
