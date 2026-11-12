import { api } from "./endpoint.js";
import { S, flashFiles } from "./state.js";
import { folderOf } from "./rules.js";
import type { Graph, GraphNode } from "./types.js";
import type { IBlocksReport } from "./blocks.js";

// The layer and shelf rank for a folder: its top segment names the band, and its
// depth sets how high the band sits, so any tree lands somewhere sensible.
function classifyFolder(folder: string): { layer: string; rank: number }
{
  const segments = folder === "" ? [] : folder.split("/");
  return { layer: segments.length === 0 ? "root" : segments[0], rank: Math.min(6, segments.length) };
}

// The folder a file rolls up to: test trees collapse to one node each, and nests
// deeper than four levels fold into their ancestor, so the map stays legible.
function nodeIdFor(dir: string): string
{
  const segments = dir === "" ? [] : dir.split("/");
  const tests = segments.indexOf("tests");
  if (tests >= 0) return segments.slice(0, tests + 1).join("/");
  if (segments.length > 4) return segments.slice(0, 4).join("/");
  return dir;
}

// How a folder is named on screen; the repository root has no path of its own.
function displayName(id: string): string
{
  return id === "" ? "(repo root)" : id;
}

// How a folder is named on the map: its name below the nearest folder drawn above it
// (a merged chain reads whole, like "src/game"), else the last two path segments.
function labelOf(n: GraphNode): string
{
  if (n.id === "") return "(root)";
  return n.name && n.name.includes("/") ? n.name : shortLabel(n.id);
}

// A folder's name on its plate: only what it adds below the folder drawn around it, since the plate
// sits inside that folder's plate already; a top-level folder shows its whole name. Two segments of
// a deep path, as labelOf gives, would read as a different, top-level folder.
function plateLabel(n: GraphNode): string
{
  if (n.id === "") return "(root)";
  if (n.name) return n.name;
  const parent = n.parent;
  return parent && parent.id !== "" && n.id.startsWith(parent.id + "/") ? n.id.slice(parent.id.length + 1) : n.id;
}

// A short label for the map: the last two path segments, so deep folders stay legible.
function shortLabel(id: string): string
{
  if (id === "") return "(root)";
  const parts = id.split("/");
  return parts.length <= 2 ? id : parts.slice(-2).join("/");
}

// What /api/bootstrap answers: the whole repository in one response.
interface Bootstrap
{
  fingerprint: string;
  unchanged?: boolean;
  files: string[];
  architecture: any;
  edges: [string, string][];
  lines: Record<string, number>;
  symbols: Record<string, string[]>;
  stamps: Record<string, string>;
  changes: Record<string, number>;
}

// The page starts this request before the scene library has downloaded; the first read takes it
// instead of asking again.
function takePrefetched(): Promise<Bootstrap | null> | undefined
{
  const early = (window as { __bootstrap?: Promise<Bootstrap | null> }).__bootstrap;
  delete (window as { __bootstrap?: Promise<Bootstrap | null> }).__bootstrap;
  return early;
}

// How long the page waits for one answer before treating the read as failed, in milliseconds. A
// request that never settles would otherwise hold the one refresh the page allows at a time forever,
// so Live would stop for the rest of the session.
const BootstrapTimeout = 10000;

// Resolves to null after a delay, so a read that never settles can be abandoned.
function after(ms: number): Promise<null>
{
  return new Promise((done) => setTimeout(() => done(null), ms));
}

// Asks the server for everything in one request. With a stamp the page already holds, an
// unchanged repository answers with the stamp alone.
async function fetchBootstrap(since: string | null): Promise<Bootstrap>
{
  const early = since === null ? takePrefetched() : undefined;
  const started = early === undefined ? null : await Promise.race([early, after(BootstrapTimeout)]);
  if (started !== null) return started;
  const wait = new AbortController();
  const timer = setTimeout(() => wait.abort(), BootstrapTimeout);
  try
  {
    const response = await fetch(api("bootstrap", since === null ? {} : { since }), { cache: "no-cache", signal: wait.signal });
    if (!response.ok) throw new Error("bootstrap " + response.status);
    return await response.json() as Bootstrap;
  }
  finally { clearTimeout(timer); }
}

// Reads the whole codebase through the server and turns it into nodes and edges. Returns null
// when `since` is still the repository's stamp, so there is nothing new to draw.
async function loadGraph(since: string | null = null): Promise<Graph | null>
{
  const data = await fetchBootstrap(since);
  if (data.unchanged) return null;

  // The architecture file decides what the map draws, and a big repository draws far faster
  // when the files nobody has described yet are left out.
  const architecture = data.architecture;
  const described = new Set(Object.entries(architecture.files as Record<string, { system?: string, layer?: string, tags?: string[], summary?: string }>)
    .filter(([, entry]) => entry.system !== undefined || entry.layer !== undefined || (entry.tags?.length ?? 0) > 0 || entry.summary !== undefined)
    .map(([path]) => path));

  const known: string[] = data.files;
  const filtering = S.ingestOnly && described.size > 0 && described.size < known.length;
  const paths = filtering ? known.filter((path) => described.has(path)) : known;
  S.undescribed = filtering ? known.length - paths.length : 0;

  // One node per folder, linked into a tree: the root at the top, each folder
  // holding its own files and its subfolders.
  const folderNodes = new Map<string, GraphNode>();
  function nodeFor(id: string): GraphNode
  {
    let node = folderNodes.get(id);
    if (!node)
    {
      const info = classifyFolder(id);
      node = {
        id, layer: info.layer, rank: info.rank, files: [], children: [],
      };
      folderNodes.set(id, node);
    }
    return node;
  }

  const root = nodeFor("");
  for (const path of paths)
  {
    const folder = folderOf(path);
    const nodeId = nodeIdFor(folder);
    let node = root;
    let acc = "";
    for (const segment of (nodeId === "" ? [] : nodeId.split("/")))
    {
      acc = acc ? acc + "/" + segment : segment;
      const child = nodeFor(acc);
      if (!node.children.includes(child)) node.children.push(child);
      node = child;
    }
    // The name is relative to the node that holds the file, not to its real folder: when a deep
    // folder folds into a shallower ancestor, keeping the rest of the path is what lets filePath()
    // rebuild the file's true path for its lines, symbols, and imports.
    node.files.push(nodeId === "" ? path : path.slice(nodeId.length + 1));
  }

  // A folder that holds no files and one subfolder is only a hop on the way down, so it
  // folds into that subfolder, which is then named by the whole chain below its parent.
  function foldChains(parent: GraphNode): void
  {
    parent.children = parent.children.map((child) =>
    {
      while (child.files.length === 0 && child.children.length === 1)
      {
        folderNodes.delete(child.id);
        child = child.children[0];
      }
      child.name = parent.id === "" ? child.id : child.id.slice(parent.id.length + 1);
      foldChains(child);
      return child;
    });
  }
  foldChains(root);

  // The server has already read every code file for its line count and declared names, and
  // resolved every import, so the page takes those answers rather than reading the sources again.
  const knownSet = new Set(paths);
  const counts = new Map<string, number>();
  const fileEdges: [string, string][] = [];
  const lines = new Map<string, number>();
  const symbols = new Map<string, string[]>();
  for (const path of paths)
  {
    const count = data.lines[path];
    if (count !== undefined) lines.set(path, count);
    const names = data.symbols[path];
    if (names !== undefined) symbols.set(path, names);
  }

  // A file whose own stamp moved since the last read was edited on disk: flash its box, so a
  // save is visible on the map without hunting for it. The first read has nothing to compare.
  if (S.FILE_STAMPS.size > 0)
  {
    const edited = paths.filter((path) =>
    {
      const was = S.FILE_STAMPS.get(path);
      const now = data.stamps?.[path];
      return was !== undefined && now !== undefined && was !== now;
    });
    if (edited.length > 0) flashFiles(edited);
  }
  S.FILE_STAMPS = new Map(Object.entries(data.stamps ?? {}));
  for (const [from, to] of data.edges)
  {
    if (from === to || !knownSet.has(from) || !knownSet.has(to)) continue;
    fileEdges.push([from, to]);
    const fromNode = nodeIdFor(folderOf(from));
    const toNode = nodeIdFor(folderOf(to));
    if (!toNode || toNode === fromNode || !folderNodes.has(toNode)) continue;
    const key = fromNode + "\u0001" + toNode;
    counts.set(key, (counts.get(key) || 0) + 1);
  }

  const tags = new Map<string, string[]>();
  const layers = new Map<string, string>();
  const systems = new Map<string, string>();
  const summaries = new Map<string, string>();
  for (const [path, entry] of Object.entries(architecture.files) as [string, { system?: string; tags?: string[]; layer?: string; summary?: string }][])
  {
    if (entry.system) systems.set(path, entry.system);
    if (entry.tags && entry.tags.length > 0) tags.set(path, entry.tags);
    if (entry.layer) layers.set(path, entry.layer);
    if (entry.summary) summaries.set(path, entry.summary);
  }
  for (const [path, summary] of Object.entries(architecture.folders) as [string, string][])
  {
    if (summary) summaries.set(path, summary);
  }
  const layerOrder = architecture.layers.length > 0 ? architecture.layers : null;
  const systemOrder = Object.keys(architecture.systems);
  const notes = architecture.error ? [architecture.error] : architecture.warnings;

  // How many lines each file has changed since HEAD, for the changes colouring. A repository that
  // is not under git, or has no git on the machine, simply has no changes.
  const changes = new Map<string, number>(Object.entries(data.changes));

  const nodes = Array.from(folderNodes.values());
  nodes.forEach((node) => node.files.sort());

  const edges: [string, string, number][] = Array.from(counts.entries()).map(([key, count]) =>
  {
    const parts = key.split("\u0001");
    return [parts[0], parts[1], count];
  });

  return { fingerprint: data.fingerprint, nodes, edges, fileEdges, lines, tags, layers, systems, systemOrder, summaries, symbols, changes, layerOrder, notes };
}
// Reads one file's text from the server, refusing a stale cached copy.
async function readSource(path: string): Promise<string>
{
  const response = await fetch(api("source", { path }), { cache: "no-cache" });
  if (!response.ok) throw new Error("source " + response.status);
  return response.text();
}

// Reads the repository's display name before the first graph is drawn.
async function loadRepo(): Promise<void>
{
  try
  {
    const response = await fetch(api("repo"), { cache: "no-cache" });
    if (!response.ok) return;
    const repo = await response.json();
    const name = repo.name || "Codespace";
    S.repoName = name;
    S.repoRoot = repo.root ?? "";
    S.build = typeof repo.build === "string" ? repo.build : "";
    document.title = name + " — 3D code map";
  }
  catch
  {
    // The default name is enough when it cannot be read.
  }
}

// Whether the page's own files were rebuilt since it loaded. A page holds the stamp it loaded with,
// so a changed stamp means the running code is old. False when either side has no stamp.
async function buildChanged(): Promise<boolean>
{
  try
  {
    const response = await fetch(api("repo"), { cache: "no-cache" });
    if (!response.ok) return false;
    const repo = await response.json();
    return typeof repo.build === "string" && S.build !== "" && repo.build !== S.build;
  }
  catch
  {
    return false;
  }
}

// Reads the blocks one file is made of, on demand, when the panel opens it. The repository's
// other files are never cut into blocks, so describing a file costs nothing until it is read.
async function readBlocks(path: string): Promise<IBlocksReport>
{
  const response = await fetch(api("blocks", { path }), { cache: "no-cache" });
  if (!response.ok) throw new Error("blocks " + response.status);
  return await response.json() as IBlocksReport;
}

// Asks the server to write a sentence for each block of a file that the source leaves without a
// comment. The page shows the plain descriptions straight away and swaps them in when they arrive;
// a server with no model answers 503, and the plain ones stay.
async function readBlockSummaries(path: string): Promise<Record<string, string> | null>
{
  const response = await fetch(api("blocks/summaries"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    cache: "no-cache",
    body: JSON.stringify({ path }),
  });
  if (!response.ok) return null;
  const data = await response.json() as { summaries?: Record<string, string> };
  return data.summaries ?? null;
}

export { displayName, labelOf, plateLabel, loadGraph, loadRepo, readSource, readBlocks, readBlockSummaries, buildChanged };
