import { S, V3, camera, scene, filePath, materialFor } from "./state.js";
import { rayBox } from "./rules.js";
import { blockColor, stackLayout, type BlockInfo, type IBlocksReport, type IFloor } from "./blocks.js";

/**
 * A chosen file opened into floors. The file's cube shrinks to the height of its lowest block
 * and becomes it, then the rest of the blocks grow upward from the cube's top, one per block,
 * to a stack taller than the cube so small blocks stay readable. A click on a slab picks its block.
 */

/** One block's slab on screen. */
interface Slab
{
  /** The block's place in the report's reading order. */
  index: number;
  block: BlockInfo;
  mesh: BABYLON.Mesh;
}

let slabs: Slab[] = [];

/** The stack currently built, by the file and the blocks it holds, so a re-choice rebuilds it. */
let openKey = "";

/** The path whose cube is hidden behind the stack, so its accent can come back when it closes. */
let hiddenPath = "";

/** Seconds since the cube started opening, which drives the two stages below. */
let opened = 0;

/** How much taller the block stack is than the file cube, so small blocks still read. */
const StackScale = 1.5;

/** How long the cube takes to shrink into its lowest block, in seconds. */
const ShrinkTime = 0.18;

/** How long the rest of the blocks then take to grow from the cube's top, in seconds. */
const GrowTime = 0.32;

/** The share of a floor's slot filled by the slab; the rest is the gap between blocks. */
const SlabFill = 0.88;

/** The floors of the last frame, by block, so a block can be found by the one it draws. */
let floorsByBlock = new Map<BlockInfo, IFloor>();

/** The chosen file's blocks as floors, rebuilt when the choice changes and opened in two stages. */
export function syncFloors(seconds = 1 / 60): void
{
  const path = S.selected >= 0 && S.selectedFile >= 0 ? filePath(S.selected, S.selectedFile) : "";
  const rec = path === "" ? undefined : S.fileRecords.get(path);
  const report = path === "" ? undefined : S.BLOCKS.get(path);
  if (rec === undefined || report === undefined || report.blocks.length === 0) { closeFloors(); return; }

  const key = path + "|" + report.blocks.map((block) => block.name + ":" + block.line + "-" + block.endLine).join("|");
  if (key !== openKey) { build(report); openKey = key; opened = 0; }

  if (hiddenPath !== "" && hiddenPath !== path) RestoreCube(hiddenPath);
  hiddenPath = path;
  opened = Math.min(ShrinkTime + GrowTime, opened + seconds);

  const position = rec.shape.position, scaling = rec.shape.scaling;
  const width = scaling.x, depth = scaling.z, height = scaling.y;
  const base = position.y - height / 2;
  const totalHeight = height * StackScale;
  const floors = stackLayout(report.blocks, totalHeight);
  floorsByBlock = new Map(floors.map((floor) => [floor.block, floor]));
  const order = new Map(floors.map((floor, at) => [floor.block, at]));
  const bottom = floors[0];
  const bottomFill = Math.max(0.004, bottom.thickness * SlabFill);

  // Stage one: the file's own cube shrinks to the lowest block's height, still at the bottom.
  const shrink = rec.accent === null ? 1 : Ease(Math.min(1, opened / ShrinkTime));
  if (rec.accent !== null)
  {
    rec.accent.setEnabled(shrink < 1);
    if (shrink < 1)
    {
      const size = height + (bottomFill - height) * shrink;
      rec.accent.scaling.y = size;
      rec.accent.position.y = base + size / 2;
    }
  }

  // Stage two: from the cube's new top, each block above it grows in turn, so the stack rises.
  const grown = Math.max(0, opened - ShrinkTime);
  const last = Math.max(1, floors.length - 1);
  for (const slab of slabs)
  {
    const floor = floorsByBlock.get(slab.block);
    if (floor === undefined) continue;
    const at = order.get(slab.block) ?? 0;
    const chosen = report.blocks[S.selectedBlock] === slab.block;
    if (at === 0)
    {
      slab.mesh.setEnabled(shrink >= 1);
      slab.mesh.position.set(position.x, base + floor.center, position.z);
      slab.mesh.scaling.set(width * 0.98, bottomFill, depth * 0.98);
    }
    else
    {
      const delay = ((at - 1) / last) * GrowTime * 0.6;
      const grow = Ease(Math.max(0, Math.min(1, (grown - delay) / (GrowTime * 0.4))));
      const fill = Math.max(0.004, floor.thickness * SlabFill);
      const size = Math.max(0.0001, fill * grow);
      const foot = base + floor.center - fill / 2;
      slab.mesh.setEnabled(shrink >= 1 && grow > 0);
      slab.mesh.position.set(position.x, foot + size / 2, position.z);
      slab.mesh.scaling.set(width * 0.98, size, depth * 0.98);
    }
    // The block the rail picked glows brighter and wears an outline, so the two views point at one part.
    slab.mesh.material = materialFor(blockColor(slab.block.kind), 1, chosen ? 0.95 : 0.5);
    slab.mesh.renderOutline = chosen;
  }

  S.floorAnchors = { path, user: AnchorOf(floors, "user", position, width, base), used: AnchorOf(floors, "used", position, width, base) };
}

/** The share of an open animation's time that has passed, eased out so a block settles gently. */
function Ease(t: number): number
{
  return 1 - Math.pow(1 - t, 3);
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

/** Which block's slab sits under a screen point, or null. Only once the cube has opened.
 * The whole cube answers, not each slab on its own, so a tap in the hairline gap between two
 * floors still picks one; the point where the ray enters the cube sets which. */
export function pickFloor(x: number, y: number): number | null
{
  if (slabs.length === 0 || opened < ShrinkTime + GrowTime || hiddenPath === "") return null;
  const rec = S.fileRecords.get(hiddenPath);
  if (rec === undefined) return null;
  const position = rec.shape.position, scaling = rec.shape.scaling;
  const base = position.y - scaling.y / 2;
  const top = base + scaling.y * StackScale;
  const ray = scene.createPickingRay(x, y, BABYLON.Matrix.IdentityReadOnly, camera);
  const t = rayBox(ray.origin, ray.direction,
    position.x - scaling.x / 2, position.x + scaling.x / 2,
    base, top,
    position.z - scaling.z / 2, position.z + scaling.z / 2);
  if (t === null) return null;

  // The height of the point where the ray meets the cube chooses the floor it belongs to.
  const at = ray.origin.y + ray.direction.y * t;
  let best: Slab | null = null, bestGap = Infinity;
  for (const slab of slabs)
  {
    const centre = slab.mesh.position.y, half = slab.mesh.scaling.y / 2;
    const gap = at > centre + half ? at - centre - half : at < centre - half ? centre - half - at : 0;
    if (gap < bestGap) { bestGap = gap; best = slab; }
  }
  return best === null ? null : best.index;
}

/** Builds one slab per block, in the block's kind colour, and gives the chosen one an outline. */
function build(report: IBlocksReport): void
{
  closeFloors();
  report.blocks.forEach((block, index) =>
  {
    const mesh = BABYLON.MeshBuilder.CreateBox("floor", { size: 1 }, scene);
    mesh.isPickable = false;
    mesh.material = materialFor(blockColor(block.kind), 1, 0.5);
    mesh.enableEdgesRendering();
    mesh.edgesColor = new BABYLON.Color4(1, 1, 1, 0.18);
    mesh.edgesWidth = 0.5;
    mesh.outlineColor = BABYLON.Color3.White();
    mesh.outlineWidth = 0.03;
    slabs.push({ index, block, mesh });
  });
}

/** Puts a file's cube back to its full size, after the open animation left it short. */
function RestoreCube(path: string): void
{
  const rec = S.fileRecords.get(path);
  if (rec === undefined || rec.accent === null) return;
  rec.accent.scaling.copyFrom(rec.shape.scaling);
  rec.accent.position.copyFrom(rec.shape.position);
  rec.accent.setEnabled(true);
}

/** Takes the floors down and gives the file its cube back. */
function closeFloors(): void
{
  for (const slab of slabs) slab.mesh.dispose();
  const restore = hiddenPath;
  slabs = [];
  floorsByBlock = new Map();
  if (openKey === "" && restore === "") return;
  openKey = "";
  hiddenPath = "";
  opened = 0;
  S.floorAnchors = null;
  S.selectedBlock = -1;
  if (restore !== "") RestoreCube(restore);
}
