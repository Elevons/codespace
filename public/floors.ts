import { S, V3, scene, filePath, materialFor } from "./state.js";
import { blockColor, stackLayout, type BlockInfo, type IBlocksReport, type IFloor } from "./blocks.js";

/**
 * A chosen file opened into floors: one slab per block, stacked above its box in reading
 * order, so the file's own structure shows in the same city language as the map. Strands
 * join a block to the blocks it uses, and the file's import wires end on the floors rather
 * than on the box, once the block that carries them is known.
 */

/** One block's slab on screen. */
interface Slab
{
  block: BlockInfo;
  mesh: BABYLON.Mesh;
}

let slabs: Slab[] = [];

/** The strands between blocks, and the points last drawn, so an unmoved stack is not rebuilt. */
let strands: BABYLON.Mesh | null = null;
let strandPoints = "";

/** The stack currently built, by the file and the blocks it holds, so a re-choice rebuilds it. */
let openKey = "";

/** The floors of the last frame, by block, so a block can be found by the one it draws. */
let floorsByBlock = new Map<BlockInfo, IFloor>();

/** The chosen file's blocks as floors, rebuilt when the choice changes and moved with its box. */
export function syncFloors(): void
{
  const path = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : "";
  const rec = path === "" ? undefined : S.fileRecords.get(path);
  const report = path === "" ? undefined : S.BLOCKS.get(path);
  if (rec === undefined || report === undefined || report.blocks.length === 0) { closeFloors(); return; }

  const key = path + "|" + report.blocks.map((block) => block.name + ":" + block.line + "-" + block.endLine).join("|");
  if (key !== openKey) { build(report); openKey = key; }

  const position = rec.shape.position, scaling = rec.shape.scaling;
  const width = Math.max(0.95, scaling.x * 1.6);
  const height = Math.max(2.4, Math.min(6, 1 + report.lines * 0.022));
  const base = position.y + scaling.y / 2 + 0.04;
  const floors = stackLayout(report.blocks, height);
  floorsByBlock = new Map(floors.map((floor) => [floor.block, floor]));

  for (const slab of slabs)
  {
    const floor = floorsByBlock.get(slab.block);
    if (floor === undefined) continue;
    const chosen = report.blocks[S.selectedBlock] === slab.block;
    slab.mesh.position.set(position.x, base + floor.center, position.z);
    slab.mesh.scaling.set(width, Math.max(0.04, floor.thickness * 0.9), width);
    // The block the rail picked glows brighter and wears an outline, so the two views point at one part.
    slab.mesh.material = materialFor(blockColor(slab.block.kind), 1, chosen ? 0.95 : 0.5);
    slab.mesh.renderOutline = chosen;
  }

  S.floorAnchors = { path, user: AnchorOf(floors, "user", position, width, base), used: AnchorOf(floors, "used", position, width, base) };
  updateStrands(report, base, width, position);
}

/** The point on the stack a wire joins: the top block for what the file imports, the
 * first block the file itself declares for what imports it. */
function AnchorOf(floors: IFloor[], role: "user" | "used", position: BABYLON.Vector3, width: number, base: number): BABYLON.Vector3
{
  const top = floors[floors.length - 1];
  const target = role === "user"
    ? top
    : (floors.find((floor) => floor.block.kind !== "import" && floor.block.depth === 0) ?? top);
  const y = base + target.center + (target === top ? target.thickness / 2 : 0);
  return new V3(position.x + (role === "user" ? width * 0.25 : -width * 0.25), y, position.z);
}

/** Builds one slab per block, in the block's kind colour, and gives the chosen one an outline. */
function build(report: IBlocksReport): void
{
  closeFloors();
  for (const block of report.blocks)
  {
    const mesh = BABYLON.MeshBuilder.CreateBox("floor", { size: 1 }, scene);
    mesh.isPickable = false;
    mesh.material = materialFor(blockColor(block.kind), 1, 0.5);
    mesh.enableEdgesRendering();
    mesh.edgesColor = new BABYLON.Color4(1, 1, 1, 0.18);
    mesh.edgesWidth = 0.5;
    mesh.outlineColor = BABYLON.Color3.White();
    mesh.outlineWidth = 0.03;
    slabs.push({ block, mesh });
  }
}

/** Rebuilds the strands between a block and the blocks it uses, unless the stack has not moved. */
function updateStrands(report: IBlocksReport, base: number, width: number, position: BABYLON.Vector3): void
{
  const lines: BABYLON.Vector3[][] = [];
  const colors: BABYLON.Color4[][] = [];
  for (const block of report.blocks)
  {
    const from = floorsByBlock.get(block);
    if (from === undefined) continue;
    for (const ref of block.refs)
    {
      const to = report.blocks.find((other) => other.name === ref);
      const toFloor = to === undefined ? undefined : floorsByBlock.get(to);
      if (toFloor === undefined) continue;
      const y1 = base + from.center, y2 = base + toFloor.center;
      const side = position.x - width / 2;
      lines.push([
        new V3(side, y1, position.z),
        new V3(side - width * 0.55, (y1 + y2) / 2, position.z),
        new V3(side, y2, position.z),
      ]);
      const color = BABYLON.Color3.FromHexString(blockColor(toFloor.block.kind));
      const fade = new BABYLON.Color4(color.r, color.g, color.b, 0.55);
      colors.push([fade, fade, fade]);
    }
  }

  // The same strands in the same places need no new mesh; a moved box moves them.
  const points = lines.flatMap((line) => line.map((point) => point.x.toFixed(2) + "," + point.y.toFixed(2) + "," + point.z.toFixed(2))).join(";");
  if (points === strandPoints && strands !== null) return;
  strandPoints = points;
  strands?.dispose();
  strands = null;
  if (lines.length === 0) return;
  strands = BABYLON.MeshBuilder.CreateLineSystem("block-strands", { lines, colors, useVertexAlpha: true }, scene);
  strands.isPickable = false;
}

/** Takes the floors down, when no file is open or its blocks are gone. */
function closeFloors(): void
{
  if (slabs.length === 0 && strands === null && openKey === "") return;
  for (const slab of slabs) slab.mesh.dispose();
  slabs = [];
  strands?.dispose();
  strands = null;
  strandPoints = "";
  floorsByBlock = new Map();
  if (openKey !== "")
  {
    openKey = "";
    S.floorAnchors = null;
    S.selectedBlock = -1;
  }
}
