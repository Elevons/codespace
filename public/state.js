// ---- constants ----
export const V3 = BABYLON.Vector3;
export const FILE_SIZE = 0.72, FILE_H = 0.46;
// The treemap gives each file this much floor: its box, centred, with air all round.
export const AREA_PER_WEIGHT = 2.0;
// Spacing: between sibling folder tiles, and from a tile's edge to what it holds.
export const TILE_GAP = 0.7, MARGIN = 0.55, PLATE_H = 0.06, FLOOR_STEP = 0.035;
export const DEFAULT_ALPHA = -Math.PI / 2 - 0.62, DEFAULT_BETA = 0.95;
export const LAYER_GAP = 3;
export const CODE_FILE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|cs|c|h|cc|cpp|hpp|php|vue|svelte|scala|dart|lua|ex|exs|erl|clj|jl|r|html?|css|scss|less|json|yaml|yml|svg|xml|md|sh|sql)$/;

// ---- the mutable world ----
export const S = {
  NODES: [],                  // the live graph, read from the server
  EDGES: [],                  // [from folder id, to folder id, count]
  FILE_EDGES: [],             // [importer path, imported path] for every import between two files
  FILE_LINES: new Map(),      // each code file's line count, which sets its size
  FILE_TAGS: new Map(),       // path -> the tags the architecture file gives it
  FILE_SUMMARIES: new Map(),  // path -> what the architecture file says the file is for
  ARCH_NOTES: [],             // problems found in the architecture file, to show
  FILE_LAYERS: new Map(),     // path -> the layer the architecture file puts it in
  LAYERS: [],                 // the layer names, bottom plane first
  layerPlanes: [],            // the translucent planes, one per layer
  layerGap: LAYER_GAP,        // the vertical spacing between layer planes, set by the spread slider
  boxes: [],                  // one entry per visible file, with its terrace spot
  trace: null,                // what the map is asked to show: { paths, set, trace, title, note, notes }, or null
  hiddenFolders: new Set(),   // folder ids the map has hidden, with their subtrees
  fileRecords: new Map(),     // path -> { mesh, node, file, path, target, targetSize }
  plates: [],                 // the folder tiles drawn in the terraces layout
  selected: -1,
  selectedFile: -1,           // which file inside the chosen folder is highlighted, or -1
  autoSpin: true,
  focusSet: null,             // node indices kept bright while one folder is chosen
  dirty: true,                // the highlight and edges need redrawing on the next frame
  hoveredPath: null,          // the file under the pointer, named while hovered
  camGoal: null,              // where the camera is gliding to, or null once it is there
  liveOn: true,
  hasCentered: false,
  graphSignature: "",
  extrasShown: false,         // whether the extras (tests, docs, scripts) are shown
};

// ---- the layers ----
const LAYER_PALETTE = ["#2aa198", "#3b78c2", "#e0a72e", "#9b59b6", "#3fb950", "#e06c75", "#8b949e", "#ff8ac4"];
const layerColors = new Map();   // layer name -> colour

// The colour of one layer, taken from the palette and kept for the whole run.
export function colorFor(layer)
{
  if (!layerColors.has(layer)) layerColors.set(layer, LAYER_PALETTE[layerColors.size % LAYER_PALETTE.length]);
  return layerColors.get(layer);
}

// The words shown for one layer in the legend.
export function labelFor(layer)
{
  return layer.replace(/[-_]+/g, " ");
}

/** The colour for each tag, so files read by role once they carry tags. */
const TAG_COLORS = {
  entry: "#f0883e", orchestrate: "#d2a8ff", core: "#58a6ff", data: "#7ee787",
  io: "#ff7b72", ui: "#79c0ff", config: "#8b949e", test: "#d29922",
};

/** The tag vocabulary, in the order a process reads it: entry first, foundations last. */
export const TAG_ORDER = ["entry", "orchestrate", "core", "io", "ui", "data", "config", "test"];

// The colour of one tag, or a neutral grey for anything unfamiliar.
export function colorForTag(tag)
{
  return TAG_COLORS[tag] ?? "#8b949e";
}

// The colour of one file: by its first tag when it has one, else by its layer.
export function fileColor(path, layer)
{
  const tags = S.FILE_TAGS.get(path);
  return tags && tags.length > 0 ? colorForTag(tags[0]) : colorFor(layer);
}

// Whether a path names a code file whose line count sets its box height.
export function isCode(path) { return CODE_FILE.test(path); }

// A code file's line count, or zero when it has not been read.
export function linesOf(path) { return S.FILE_LINES.get(path) || 0; }

// Every redraw request just marks the scene dirty; the frame loop does the work once.
export function render() { S.dirty = true; }

// ---- the scene ----
export const canvas = document.getElementById("scene");
export const labelLayer = document.getElementById("labels");
export const loadingNote = document.getElementById("loading");

export const engine = new BABYLON.Engine(canvas, true, { antialias: true, stencil: true }, true);
export const scene = new BABYLON.Scene(engine);
const BACKGROUND = BABYLON.Color3.FromHexString("#04070d");
scene.clearColor = BACKGROUND.toColor4(1);
scene.fogMode = BABYLON.Scene.FOGMODE_EXP2;
scene.fogColor = BABYLON.Color3.FromHexString("#0e3350");
scene.fogDensity = 0.012;

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
const materials = new Map();
export function materialFor(hex, alpha, glow)
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
export function glowMaterial(hex)
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
