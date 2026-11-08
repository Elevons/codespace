/**
 * The pure rules behind the map's filters and search, kept away from the scene and the DOM so
 * they can be tested under node. The state and the outliner both call these, so the scene and
 * the chip counts cannot disagree.
 */

/** One axis a filter or group row can name: a system, a layer, or a folder. */
export type GroupAxis = "system" | "layer" | "folder";

/**
 * Whether a file passes the selected systems and layers. An empty set means every value, and
 * `skip` ignores one axis so that axis can count its own values.
 * @param fileSystem the file's system, or undefined
 * @param fileLayer the file's layer, or undefined
 * @param systems the selected systems
 * @param layers the selected layers
 * @param skip the axis to ignore, or null for both
 */
export function passesSliceValues(fileSystem: string | undefined, fileLayer: string | undefined, systems: ReadonlySet<string>, layers: ReadonlySet<string>, skip: GroupAxis | null = null): boolean
{
    if (skip !== 'system' && systems.size > 0 && !systems.has(fileSystem ?? '')) return false;
    if (skip !== 'layer' && layers.size > 0 && !layers.has(fileLayer ?? '')) return false;
    return true;
}

/** The words of a search, lowercased; every one must match for a file to be listed. */
export function queryTerms(query: string): string[]
{
    return query.trim().toLowerCase().split(/\s+/).filter((term) => term !== '');
}

/**
 * Whether a search names a file: each word appears in its path or in one of its symbols.
 * @param path the file's repository-relative path
 * @param symbols the names the file declares
 * @param terms the lowercased search words
 */
export function matchesQueryTerms(path: string, symbols: readonly string[], terms: readonly string[]): boolean
{
    if (terms.length === 0) return true;
    const lower = path.toLowerCase();
    return terms.every((term) => lower.includes(term) || symbols.some((name) => name.toLowerCase().includes(term)));
}

/** Every folder above a path, nearest first, or none for a top-level path. */
export function ancestorFolders(path: string): string[]
{
    const folders: string[] = [];
    for (let cut = path.lastIndexOf('/'); cut > 0; cut = path.lastIndexOf('/', cut - 1)) folders.push(path.slice(0, cut));
    return folders;
}

/**
 * The folders that must stay open so a hidden file or folder stays listed: every folder above
 * each one. A hidden folder keeps its own parent open, not itself, so its row remains reachable.
 * @param hiddenFiles paths a file's eye hid
 * @param hiddenFolders folder ids a folder's eye hid
 */
export function foldersToKeepOpen(hiddenFiles: Iterable<string>, hiddenFolders: Iterable<string>): Set<string>
{
    const open = new Set<string>();
    for (const path of hiddenFiles) for (const folder of ancestorFolders(path)) open.add(folder);
    for (const path of hiddenFolders) for (const folder of ancestorFolders(path)) open.add(folder);
    return open;
}
