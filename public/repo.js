import { CODE_FILE } from "./state.js";
// The layer and shelf rank for a folder: its top segment names the band, and its
// depth sets how high the band sits, so any tree lands somewhere sensible.
function classifyFolder(folder)
{
  const segments = folder === "" ? [] : folder.split("/");
  return { layer: segments.length === 0 ? "root" : segments[0], rank: Math.min(6, segments.length) };
}

function dirOf(path)
{
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

// The folder a file rolls up to: test trees collapse to one node each, and nests
// deeper than four levels fold into their ancestor, so the map stays legible.
function nodeIdFor(dir)
{
  const segments = dir === "" ? [] : dir.split("/");
  const tests = segments.indexOf("tests");
  if (tests >= 0) return segments.slice(0, tests + 1).join("/");
  if (segments.length > 4) return segments.slice(0, 4).join("/");
  return dir;
}

// How far a folder sits below the root, in path segments minus one.
function depthOf(id)
{
  return id === "" ? 0 : id.split("/").length - 1;
}

// How a folder is named on screen; the repository root has no path of its own.
function displayName(id)
{
  return id === "" ? "(repo root)" : id;
}

// A short label for the map: the last two path segments, so deep folders stay legible.
function shortLabel(id)
{
  if (id === "") return "(root)";
  const parts = id.split("/");
  return parts.length <= 2 ? id : parts.slice(-2).join("/");
}

// Turns a relative import specifier into a repository path, resolving "..".
function resolveRelative(fromDir, spec)
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
function parseImports(text)
{
  const specs = [];
  const fromPattern = /(?:^|\n)[ \t]*(?:import|export)\b[^\n]*?\bfrom\s*['"]([^'"]+)['"]/g;
  const barePattern = /(?:^|\n)[ \t]*import\s*['"]([^'"]+)['"]/g;
  let match;
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
// Reads the whole codebase through the server and turns it into nodes and edges.
async function loadGraph()
{
  const listingResponse = await fetch("/api/files", { cache: "no-cache" });
  if (!listingResponse.ok) throw new Error("file list " + listingResponse.status);
  const listing = await listingResponse.json();
  const paths = listing.files || [];

  // One node per folder, linked into a tree: the root at the top, each folder
  // holding its own files and its subfolders.
  const folderNodes = new Map();
  function nodeFor(id)
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

  // Read the code files for their imports; every other type is shown, not scanned.
  const codeText = new Map();
  await Promise.all(paths.filter((path) => CODE_FILE.test(path)).map((path) =>
    fetch("/api/source?path=" + encodeURIComponent(path), { cache: "no-cache" })
      .then((response) => response.ok ? response.text() : "")
      .then((text) => { codeText.set(path, text); })
      .catch(() => {})));

  const counts = new Map();
  const known = new Set(paths);
  const fileEdges = [];
  const lines = new Map();
  for (const [path, text] of codeText) lines.set(path, text.split("\n").length);
  paths.forEach((path) =>
  {
    const text = codeText.get(path);
    if (text === undefined) return;
    const realFrom = dirOf(path);
    const from = nodeIdFor(realFrom);
    for (const spec of parseImports(text))
    {
      const resolved = resolveRelative(realFrom, spec);
      const target = resolveFile(resolved, known);
      if (target !== null && target !== path) fileEdges.push([path, target]);
      const to = nodeIdFor(dirOf(resolved));
      if (!to || to === from || !folderNodes.has(to)) continue;
      const key = from + "\u0001" + to;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  });

  const nodes = Array.from(folderNodes.values());
  nodes.forEach((node) => node.files.sort());

  const edges = Array.from(counts.entries()).map(([key, count]) =>
  {
    const parts = key.split("\u0001");
    return [parts[0], parts[1], count];
  });

  return { nodes, edges, fileEdges, lines };
}
// The file an import names: as written, or with the extension or index file it leaves off.
function resolveFile(resolved, known)
{
  const candidates = [resolved, resolved + ".ts", resolved.replace(/\.[cm]?js$/, ".ts"),
    resolved + ".tsx", resolved + ".js", resolved + ".jsx", resolved + ".mjs", resolved + ".cjs",
    resolved + "/index.ts", resolved + "/index.tsx", resolved + "/index.js", resolved + "/index.jsx"];
  for (const candidate of candidates) if (known.has(candidate)) return candidate;
  return null;
}
// Reads the repository's display name before the first graph is drawn.
async function loadRepo()
{
  try
  {
    const response = await fetch("/api/repo", { cache: "no-cache" });
    if (!response.ok) return;
    const repo = await response.json();
    const name = repo.name || "Codespace";
    document.title = name + " — 3D code map";
  }
  catch
  {
    // The default name is enough when it cannot be read.
  }
}

export { classifyFolder, dirOf, nodeIdFor, depthOf, displayName, shortLabel, resolveRelative, parseImports, resolveFile, loadGraph, loadRepo };
