/**
 * The blocks a source file is made of, and the rules that turn them into floors. A block is one
 * part of a file in reading order; a section is a block inside a long function or class. The words
 * are defined in docs/GLOSSARY.md. Kept dependency-free so the server, the browser, and the tests
 * share one vocabulary.
 */

/** What a block is: the role it plays in the file, which is what the rail and the floors colour by. */
export type BlockKind = "import" | "constant" | "type" | "function" | "class" | "section" | "declaration";

/** The colours blocks are drawn in, by kind. The rail and the 3D floors use the same ones. */
export const BLOCK_COLORS: Record<BlockKind, string> = {
  import: "#5fa8d3",
  constant: "#d7a747",
  type: "#8f7ce0",
  function: "#3fae7d",
  class: "#2f9c95",
  section: "#c46ecb",
  declaration: "#8a93a2",
};

/** One block: a declaration, a group of them, or a section of a long function. */
export interface BlockInfo
{
  /** What the block is called: a declaration's name, a group's count, or a section's comment. */
  name: string;
  /** The role the block plays, which sets its colour. */
  kind: BlockKind;
  /** The line the block starts on, counting from 1. */
  line: number;
  /** The line the block ends on, counting from 1 and included. */
  endLine: number;
  /** 0 for a declaration of the file, 1 for a section or member inside one. */
  depth: number;
  /** The block this one sits inside, when it is a section or a member. */
  parent?: string;
  /** What the block is for: its own comment when it has one, else a plain mechanical line. */
  summary: string;
  /** Whether the summary was written in the source, rather than made up from the block's shape. */
  fromComment: boolean;
  /** Whether the model wrote the summary, when the source gave the block no comment. */
  fromModel?: boolean;
  /** The names the block declares, when it groups several declarations. */
  members?: string[];
  /** The names of the file's other blocks this one mentions. */
  refs: string[];
}

/** One file's blocks, as the map API answers them. */
export interface IBlocksReport
{
  /** The file's repository-relative path. */
  path: string;
  /** The file's line count. */
  lines: number;
  /** The blocks in reading order, a parent before the sections inside it. */
  blocks: BlockInfo[];
}

/** One block's slab in a stack: how thick it is and where its centre sits above the base. */
export interface IFloor
{
  block: BlockInfo;
  /** The slab's thickness in the stack, from the floor weights below. */
  thickness: number;
  /** The slab's centre, measured up from the foot of the stack. */
  center: number;
}

/** The longest span, in lines, that still gets its own thickness; longer blocks stop growing. */
const MaxFloorLines = 60;

/** The thickness of a parent slab that is drawn as a header over its sections. */
const HeaderWeight = 3;

/** Whether a block holds sections or members, and so is drawn as a header. */
export function hasChildren(blocks: ReadonlyArray<BlockInfo>, block: BlockInfo): boolean
{
  return block.depth === 0 && blocks.some((other) => other.parent === block.name);
}

/** How much of a stack's height one block takes: its line span, or a thin header over its sections.
 * The span is square-rooted, so a small block still gets a floor thick enough to see and click. */
function floorWeight(blocks: ReadonlyArray<BlockInfo>, block: BlockInfo): number
{
  if (hasChildren(blocks, block)) return HeaderWeight;
  return Math.sqrt(Math.max(1, Math.min(MaxFloorLines, block.endLine - block.line + 1)));
}

/**
 * Splits a stack's height among its blocks, a slab per block, bottom to top in reverse reading
 * order so the file's first block sits highest, under the label like a page. Thickness grows with
 * the square root of a block's line span, so small blocks stay visible without hiding the large.
 * @param blocks the file's blocks in reading order
 * @param height the total height the stack should take
 */
export function stackLayout(blocks: ReadonlyArray<BlockInfo>, height: number): IFloor[]
{
  if (blocks.length === 0 || height <= 0) return [];
  const lifts = blocks.map((block) => ({ block, weight: floorWeight(blocks, block) }));
  const total = lifts.reduce((sum, lift) => sum + lift.weight, 0);
  const scale = height / total;
  const floors: IFloor[] = [];
  let bottom = 0;
  for (let i = lifts.length - 1; i >= 0; i--)
  {
    const thickness = lifts[i].weight * scale;
    floors.push({ block: lifts[i].block, thickness, center: bottom + thickness / 2 });
    bottom += thickness;
  }
  return floors;
}

/** A block's colour, by its kind. */
export function blockColor(kind: BlockKind): string
{
  return BLOCK_COLORS[kind] ?? BLOCK_COLORS.declaration;
}

/**
 * Cuts a summary to one line of the given length, at a word boundary where it can.
 * @param text the text to cut
 * @param length the most characters to keep
 */
export function shortSummary(text: string, length = 160): string
{
  const one = text.replace(/\s+/g, " ").trim();
  if (one.length <= length) return one;
  const cut = one.slice(0, length);
  const space = cut.lastIndexOf(" ");
  return (space > length * 0.6 ? cut.slice(0, space) : cut).replace(/[.,;:]$/, "") + "…";
}
