/**
 * The shapes the page shares between its modules: the folder tree, each file's live
 * record, and what a tool asks the map to show. Kept in one dependency-light module
 * so the folder layout, the meshes, and the panels agree on one owner per field.
 */

import type { GroupAxis } from "./filter.js";
export type { GroupAxis };

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

/** One file's place in the node list. */
export interface FileSpot
{
    path: string;
    node: number;
    file: number;
}

/** Where one file's box stands and how big it is this frame. */
interface Shape
{
    position: BABYLON.Vector3;
    scaling: BABYLON.Vector3;
}

/** One file's live record: its box and where it is gliding to. */
export interface FileRecord
{
    path: string;
    /** The box as it stands this frame; drawn by its batch slot, or by `accent` when it has one. */
    shape: Shape;
    /** The file's copy in the batched boxes. */
    slot: number;
    /** Whether the file is drawn bright, or faded behind the current choice. */
    lit: boolean;
    /** A mesh of its own, lent while the file is chosen, hovered, or on a shown route. */
    accent: BABYLON.Mesh | null;
    node: number;
    file: number;
    /** Where the file rests on its terrace. */
    terrace: BABYLON.Vector3;
    /** Where the file is gliding to this frame. */
    target: BABYLON.Vector3;
    /** The size the file is gliding to this frame. */
    targetSize: BABYLON.Vector3;
    /** Seconds left before the box starts growing in, so a fresh map builds itself in. */
    delay?: number;
}

/** What the map colours files by: their role, layer, system, folder, size, or recent changes. */
export type ColorBy = "tag" | "layer" | "system" | "folder" | "size" | "changes" | "history";

/** The outliner's view state: what it filters to, how it lists files, and what the scene hides. */
export interface OutlinerState
{
  /** The text the outliner's search box holds. */
  query: string;
  /** The systems switched on in the filter strip; empty means every system. */
  systems: Set<string>;
  /** The layers switched on in the filter strip; empty means every layer. */
  layers: Set<string>;
  /** How the tree lists files. */
  group: GroupAxis;
  /** Files hidden from the 3D scene by an eye in the outliner. */
  hiddenFiles: Set<string>;
  /** Files shown in the 3D scene even when an eye hides their folder. */
  shownFiles: Set<string>;
  /** Extras folders the person re-showed while the Extras toggle is off. */
  shownExtraFolders: Set<string>;
  /** Which group rows are folded shut, keyed by "axis:value". */
  collapsed: Set<string>;
}

/** What the map is asked to show: the files, their notes, and whether it is a numbered route. */
export interface Trace
{
    paths: string[];
    set: Set<string>;
    /** Each step's note, in the same order as paths, so a file met twice keeps both. */
    notes: string[];
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
    alpha?: number;
}

/** The graph read from the server: nodes, edges, and the architecture's tags and layers. */
export interface Graph
{
    /** The repository's change stamp this was read at. */
    fingerprint: string;
    nodes: GraphNode[];
    edges: [string, string, number][];
    fileEdges: [string, string][];
    lines: Map<string, number>;
    tags: Map<string, string[]>;
    layers: Map<string, string>;
    systems: Map<string, string>;
    systemOrder: string[];
    summaries: Map<string, string>;
    symbols: Map<string, string[]>;
    changes: Map<string, number>;
    layerOrder: string[] | null;
    notes: string[];
    concepts: Concepts;
}

export interface Concepts
{
    things: Record<string, { summary?: string; layer?: string; files?: string[]; rules?: string[] }>;
    operations: Record<string, { summary?: string; files: string[]; reads: string[]; writes: string[]; steps: { text: string; files: string[] }[]; rules: string[] }>;
}
