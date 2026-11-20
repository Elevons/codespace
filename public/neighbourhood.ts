// One file's neighbourhood: the file, the files it imports, and the files that import it. It is
// the smallest honest answer to "what does this part of the code touch", and it needs no guess
// about frameworks: the server walks the same imports the map draws.

import { api } from "./endpoint.js";
import { DefaultNeighbourDepth } from "./neighbours.js";

/**
 * Narrows the map to one file and its neighbours, and chooses the file so its blocks open.
 * @param path the file to stand at, as the map names it
 */
export async function showNeighbourhood(path: string): Promise<void>
{
  try
  {
    const response = await fetch(api("neighbours", { path, depth: String(DefaultNeighbourDepth) }), { cache: "no-cache" });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) return;
    const paths: string[] = Array.isArray(data.paths) ? data.paths : [];
    if (paths.length === 0) return;
    // Isolation and selection are both view calls, so every open page follows them.
    await fetch(api("view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "isolate", files: paths }) });
    await fetch(api("view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "select", files: [path] }) });
  }
  catch
  {
    // A page that cannot reach the server leaves the map as it is.
  }
}
