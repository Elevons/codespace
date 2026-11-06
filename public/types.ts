/**
 * The shapes the page shares between its modules: the folder tree, each file's live
 * record, and what a tool asks the map to show. Kept in one dependency-light module
 * so the folder layout, the meshes, and the panels agree on one owner per field.
 */

/** One folder node in the live graph, keyed by its repository-relative path. */
export interface GraphNode
{
    /** The folder's repository-relative path; the repository root is "". */
    id: string;
    /** The folder's band: its top path segment, or "root". */
    layer: string;
    /** How deep the folder is, capped, which sets how high its band sits. */
    rank: number;
    /** The names of the files the folder holds directly. */
    files: string[];
    /** The subfolders of this folder, as a tree. */
    children: GraphNode[];
    /** The folder's name below the nearest drawn folder above it, set when chains fold. */
    name?: string;
    /** The folder's index in `S.NODES`. */
    index?: number;
    /** The folder this one sits under, set when the tree is linked. */
    parent?: GraphNode | null;
    /** Whether the folder, or a folder above it, is hidden. */
    hidden?: boolean;
    /** The floor the folder asks for: one unit per file, plus its subfolders and margin. */
    weight?: number;
    /** What the folder holds in the treemap: its visible subfolders and its files. */
    entries?: Entry[];
    /** The nesting level, which sets the tile's thin step height. */
    level?: number;
    /** The floor centre of the folder's tile. */
    cx?: number;
    cz?: number;
    /** The width and depth of the folder's tile. */
    tileW?: number;
    tileD?: number;
    /** The tile's base and top heights, one step per level. */
    baseY?: number;
    topY?: number;
}

/** One child of a folder in the treemap: a subfolder or a file, with its share of the floor. */
export interface Entry
{
    /** The subfolder this entry places, when it is a folder. */
    dir?: GraphNode;
    /** The file's index within its folder, when it is a file. */
    fileIndex?: number;
    /** The file's repository-relative path, when it is a file. */
    path?: string;
    /** The entry's share of the floor. */
    weight: number;
    /** The entry's cell within its folder's rectangle. */
    x: number;
    z: number;
    w: number;
    d: number;
}

/** One visible file's resting spot: where its box sits and how big it starts. */
export interface Box
{
    path: string;
    node: number;
    file: number;
    terrace: BABYLON.Vector3;
    terraceSize: BABYLON.Vector3;
}

/** One file's live record: its mesh and where it is gliding to. */
export interface FileRecord
{
    path: string;
    mesh: BABYLON.Mesh;
    node: number;
    file: number;
    /** Where the file rests on its terrace. */
    terrace: BABYLON.Vector3;
    /** Where the file is gliding to this frame. */
    target: BABYLON.Vector3;
    /** The size the file is gliding to this frame. */
    targetSize: BABYLON.Vector3;
}

/** What the map is asked to show: the files, their notes, and whether it is a numbered route. */
export interface Trace
{
    paths: string[];
    set: Set<string>;
    notes: Map<string, string>;
    trace: boolean;
    title: string;
    note: string;
}

/** Where the camera is gliding to, or null once it is there. */
export interface CamGoal
{
    target: BABYLON.Vector3;
    radius: number;
    beta?: number;
}

/** The graph read from the server: nodes, edges, and the architecture's tags and layers. */
export interface Graph
{
    nodes: GraphNode[];
    edges: [string, string, number][];
    fileEdges: [string, string][];
    lines: Map<string, number>;
    tags: Map<string, string[]>;
    layers: Map<string, string>;
    summaries: Map<string, string>;
    layerOrder: string[] | null;
    notes: string[];
}
