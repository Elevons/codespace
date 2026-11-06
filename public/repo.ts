import { CODE_FILE, S } from "./state.js";
import type { Graph, GraphNode } from "./types.js";

/** One declaration a source file lists: its name, the line it starts on, and the source it spans. */
export interface SymbolInfo
{
  name: string;
  line: number;
  code: string;
}

// The layer and shelf rank for a folder: its top segment names the band, and its
// depth sets how high the band sits, so any tree lands somewhere sensible.
function classifyFolder(folder: string): { layer: string; rank: number }
{
  const segments = folder === "" ? [] : folder.split("/");
  return { layer: segments.length === 0 ? "root" : segments[0], rank: Math.min(6, segments.length) };
}

function dirOf(path: string): string
{
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
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

// A short label for the map: the last two path segments, so deep folders stay legible.
function shortLabel(id: string): string
{
  if (id === "") return "(root)";
  const parts = id.split("/");
  return parts.length <= 2 ? id : parts.slice(-2).join("/");
}

// Turns a relative import specifier into a repository path, resolving "..".
function resolveRelative(fromDir: string, spec: string): string
{
  const parts = fromDir ? fromDir.split("/") : [];
  for (const segment of spec.split("/"))
  {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return parts.join("/");
}

// Every relative dependency a source file names, from `import ... from` and
// `export ... from` lines.
function parseImports(text: string): string[]
{
  const specs: string[] = [];
  const fromPattern = /(?:^|\n)[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const barePattern = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(text)) !== null)
  {
    if (match[1].startsWith(".")) specs.push(match[1]);
  }
  while ((match = barePattern.exec(text)) !== null)
  {
    if (match[1].startsWith(".")) specs.push(match[1]);
  }
  return specs;
}
// The declaration's source: from its line to the closing brace of its block, or the line itself
// when it opens no block. A rough brace count is enough for the shapes this reads.
function symbolBlock(lines: string[], start: number): string
{
  let depth = 0, opened = false;
  for (let i = start; i < lines.length; i++)
  {
    for (const ch of lines[i])
    {
      if (ch === "{") { depth++; opened = true; }
      else if (ch === "}") depth--;
      else if (ch === ";" && !opened && depth === 0) return lines.slice(start, i + 1).join("\n");
    }
    if (opened && depth <= 0) return lines.slice(start, i + 1).join("\n");
  }
  return lines.slice(start).join("\n");
}

// The top-level functions, classes, and variables a script declares, each with its source.
// Only lines starting at the left margin count, so declarations nested in a block stay out.
function symbolsOf(text: string): { functions: SymbolInfo[]; classes: SymbolInfo[]; variables: SymbolInfo[] }
{
  const lines = text.split("\n");
  const functions: SymbolInfo[] = [], classes: SymbolInfo[] = [], variables: SymbolInfo[] = [];
  lines.forEach((raw, i) =>
  {
    if (raw === "" || /^\s/.test(raw)) return;
    const line = raw.replace(/^export\s+(?:default\s+)?/, "");
    let match: RegExpExecArray | null;
    if ((match = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/.exec(line)) ||
        (match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=)[^=]*=>/.exec(line)) ||
        (match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?function\b/.exec(line)))
    {
      functions.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) });
      return;
    }
    if ((match = /^class\s+([A-Za-z_$][\w$]*)/.exec(line))) { classes.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) }); return; }
    if ((match = /^(?:const|let|var)\s+([A-Za-z_$][\w$]*)/.exec(line))) { variables.push({ name: match[1], line: i + 1, code: symbolBlock(lines, i) }); return; }
  });
  return { functions, classes, variables };
}
// Reads the whole codebase through the server and turns it into nodes and edges.
async function loadGraph(): Promise<Graph>
{
  // The architecture file is read first: it decides what the map draws, and a big repository
  // draws far faster when the files nobody has described yet are left out.
  const architecture = await fetch("/api/architecture", { cache: "no-cache" })
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null) || { layers: [], files: {}, folders: {}, warnings: [], error: "" };
  const described = new Set(Object.entries(architecture.files as Record<string, { layer?: string, tags?: string[], summary?: string }>)
    .filter(([, entry]) => entry.layer !== undefined || (entry.tags?.length ?? 0) > 0 || entry.summary !== undefined)
    .map(([path]) => path));

  const listingResponse = await fetch("/api/files", { cache: "no-cache" });
  if (!listingResponse.ok) throw new Error("file list " + listingResponse.status);
  const listing = await listingResponse.json();
  const known: string[] = listing.files || [];
  const filtering = S.ingestOnly && described.size > 0 && described.size < known.length;
  const paths = filtering ? known.filter((path) => described.has(path)) : known;
  S.hiddenFiles = filtering ? known.length - paths.length : 0;

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
    const folder = dirOf(path);
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
    node.files.push(folder ? path.slice(folder.length + 1) : path);
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

  // Read the code files for their imports; every other type is shown, not scanned. The reads
  // are capped so a large repository does not open every connection at once.
  const codeText = new Map<string, string>();
  await mapLimit(paths.filter((path) => CODE_FILE.test(path)), 12, async (path) =>
  {
    try
    {
      const response = await fetch("/api/source?path=" + encodeURIComponent(path), { cache: "no-cache" });
      if (response.ok) codeText.set(path, await response.text());
    }
    catch { /* an unreadable file is simply shown, not scanned */ }
  });

  const counts = new Map<string, number>();
  const knownSet = new Set(paths);
  const fileEdges: [string, string][] = [];
  const lines = new Map<string, number>();
  // The names each code file declares, so search can find a symbol, not only a path.
  const symbols = new Map<string, string[]>();
  for (const [path, text] of codeText) lines.set(path, text.split("\n").length);
  for (const [path, text] of codeText)
  {
    const found = symbolsOf(text);
    symbols.set(path, [...found.functions, ...found.classes, ...found.variables].map((item) => item.name));
  }
  paths.forEach((path) =>
  {
    const text = codeText.get(path);
    if (text === undefined) return;
    const realFrom = dirOf(path);
    const from = nodeIdFor(realFrom);
    for (const spec of parseImports(text))
    {
      const resolved = resolveRelative(realFrom, spec);
      const target = resolveFile(resolved, knownSet);
      if (target !== null && target !== path) fileEdges.push([path, target]);
      const to = nodeIdFor(dirOf(resolved));
      if (!to || to === from || !folderNodes.has(to)) continue;
      const key = from + "\u0001" + to;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });

  const tags = new Map<string, string[]>();
  const layers = new Map<string, string>();
  const summaries = new Map<string, string>();
  for (const [path, entry] of Object.entries(architecture.files) as [string, { tags?: string[]; layer?: string; summary?: string }][])
  {
    if (entry.tags && entry.tags.length > 0) tags.set(path, entry.tags);
    if (entry.layer) layers.set(path, entry.layer);
    if (entry.summary) summaries.set(path, entry.summary);
  }
  for (const [path, entry] of Object.entries(architecture.folders ?? {}) as [string, { summary?: string }][])
  {
    if (entry.summary) summaries.set(path, entry.summary);
  }
  const layerOrder = architecture.layers.length > 0 ? architecture.layers : null;
  const notes = architecture.error ? [architecture.error] : architecture.warnings;

  // How many lines each file has changed since HEAD, for the changes colouring. A repository that
  // is not under git, or has no git on the machine, simply has no changes.
  const changes = new Map<string, number>();
  const changeReport = await fetch("/api/changes", { cache: "no-cache" })
    .then((response) => response.ok ? response.json() : null)
    .catch(() => null) as { files?: Record<string, number> } | null;
  for (const [path, count] of Object.entries(changeReport?.files ?? {})) changes.set(path, count);

  const nodes = Array.from(folderNodes.values());
  nodes.forEach((node) => node.files.sort());

  const edges: [string, string, number][] = Array.from(counts.entries()).map(([key, count]) =>
  {
    const parts = key.split("\u0001");
    return [parts[0], parts[1], count];
  });

  return { nodes, edges, fileEdges, lines, tags, layers, summaries, symbols, changes, layerOrder, notes };
}
// The file an import names: as written, or with the extension or index file it leaves off.
function resolveFile(resolved: string, known: Set<string>): string | null
{
  const candidates = [resolved, resolved + ".ts", resolved.replace(/\.[cm]?js$/, ".ts"),
    resolved + ".tsx", resolved + ".js", resolved + ".jsx", resolved + ".mjs", resolved + ".cjs",
    resolved + "/index.ts", resolved + "/index.tsx", resolved + "/index.js", resolved + "/index.jsx"];
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}
// Reads the repository's display name before the first graph is drawn.
async function loadRepo(): Promise<void>
{
  try
  {
    const response = await fetch("/api/repo", { cache: "no-cache" });
    if (!response.ok) return;
    const repo = await response.json();
    const name = repo.name || "Codespace";
    S.repoName = name;
    S.repoRoot = repo.root ?? "";
    document.title = name + " — 3D code map";
  }
  catch
  {
    // The default name is enough when it cannot be read.
  }
}

// Runs one async job per item, with at most `limit` in flight at once, and keeps the order.
async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]>
{
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () =>
  {
    while (next < items.length)
    {
      const index = next++;
      results[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

// The repository's change stamp, or null when the server has no fingerprint endpoint.
async function loadFingerprint(): Promise<string | null>
{
  try
  {
    const response = await fetch("/api/fingerprint", { cache: "no-cache" });
    if (!response.ok) return null;
    const body = await response.json() as { fingerprint?: unknown };
    return typeof body.fingerprint === "string" ? body.fingerprint : null;
  }
  catch { return null; }
}

export { displayName, labelOf, loadFingerprint, loadGraph, loadRepo, symbolsOf };
