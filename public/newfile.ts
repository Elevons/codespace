// The form that makes a new file on a layer. It opens from the + beside a layer's name in the legend,
// already set to that layer, and suggests the folder, system, and tag the layer's own files use most.
// Create writes the file, opening with its summary as a comment, and its architecture entry in one
// step (POST /api/files); the map then reads the repository again and chooses the new file.

import { S, fileIndex, flashFiles } from "./state.js";
import { api } from "./endpoint.js";
import { TAG_VOCABULARY } from "./tags.js";
import { refreshGraph } from "./controls.js";
import { selectFile } from "./panels.js";

let panel: HTMLFormElement | null = null;

function byName<T extends HTMLElement>(name: string): T
{
  return panel!.querySelector("[data-field='" + name + "']") as T;
}

// The value most of a layer's files share, or "" when the layer holds none.
function mostCommon(values: string[]): string
{
  const counts = new Map<string, number>();
  for (const value of values) if (value) counts.set(value, (counts.get(value) ?? 0) + 1);
  let best = "", most = 0;
  for (const [value, count] of counts) if (count > most) { best = value; most = count; }
  return best;
}

function filesOn(layer: string): string[]
{
  return [...S.FILE_LAYERS].filter(([, at]) => at === layer).map(([path]) => path);
}

/** What a layer's own files usually have, to start a new file on that layer from. */
export interface ILayerDefaults
{
  /** The folder most of the layer's files are in, ending in "/", or "" for the repository's root. */
  folder: string;
  /** The extension most of them have, with its dot; ".ts" for a layer with no files. */
  extension: string;
  /** The system most of them belong to, or "". */
  system: string;
  /** The first tag most of them carry, as a list of one, or none. */
  tags: string[];
}

/**
 * Reads what a layer's files have in common.
 * @param layer the layer
 */
export function layerDefaults(layer: string): ILayerDefaults
{
  const files = filesOn(layer);
  const folder = mostCommon(files.map((file) => file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : ""));
  const extension = mostCommon(files.map((file) => { const name = file.slice(file.lastIndexOf("/") + 1); return name.includes(".") ? name.slice(name.lastIndexOf(".")) : ""; })) || ".ts";
  const tag = mostCommon(files.map((file) => (S.FILE_TAGS.get(file) ?? [])[0] ?? ""));
  return { folder, extension, system: mostCommon(files.map((file) => S.FILE_SYSTEMS.get(file) ?? "")), tags: tag ? [tag] : [] };
}

/** What a new file is made from. */
export interface INewFileBody
{
  path: string;
  summary: string;
  layer: string;
  system?: string;
  tags: string[];
}

/**
 * Asks the server to make a file, then has the map read the repository again, choose the new file,
 * and light it.
 * @param body the new file
 * @returns the reason it was not made, or null when it was
 */
export async function postNewFile(body: INewFileBody): Promise<string | null>
{
  try
  {
    const response = await fetch(api("files"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const answer = await response.json().catch(() => ({})) as { path?: string; error?: string };
    if (!response.ok || !answer.path)
      return response.status === 403 ? "This map is read only here, so it cannot make files." : answer.error || "The file was not made.";
    await refreshGraph(true);
    const [node, file] = fileIndex(answer.path);
    if (node >= 0) selectFile(node, file);
    flashFiles([answer.path]);
    return null;
  }
  catch { return "The map server did not answer."; }
}

function build(): HTMLFormElement
{
  const form = document.createElement("form");
  form.className = "panel";
  form.id = "newfile";
  form.hidden = true;
  form.autocomplete = "off";
  form.innerHTML =
    '<div class="nf-head"><h2 class="panel-title">New file</h2><button type="button" data-field="close" title="Close">Close</button></div>' +
    '<label>Layer<select data-field="layer"></select></label>' +
    '<label>Path<input data-field="path" type="text" spellcheck="false" placeholder="src/folder/Name.ts" list="newfile-folders"></label>' +
    '<datalist id="newfile-folders"></datalist>' +
    '<label data-field="system-row">System<select data-field="system"></select></label>' +
    '<fieldset><legend>Tags</legend><div data-field="tags"></div></fieldset>' +
    '<label>Summary<input data-field="summary" type="text" maxlength="400" placeholder="One sentence: what this file is for"></label>' +
    '<p class="hint" data-field="error" hidden></p>' +
    '<div class="nf-actions"><button type="submit" data-field="create">Create</button></div>';
  document.body.appendChild(form);

  const tags = form.querySelector("[data-field='tags']")!;
  for (const tag of TAG_VOCABULARY)
  {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "nf-tag";
    chip.dataset.tag = tag;
    chip.textContent = tag;
    chip.setAttribute("aria-pressed", "false");
    tags.appendChild(chip);
  }
  tags.addEventListener("click", (event) =>
  {
    const chip = (event.target as HTMLElement).closest("[data-tag]");
    if (chip) chip.setAttribute("aria-pressed", chip.getAttribute("aria-pressed") === "true" ? "false" : "true");
  });
  form.querySelector("[data-field='close']")!.addEventListener("click", closeNewFile);
  form.addEventListener("keydown", (event) => { if (event.key === "Escape") { event.stopPropagation(); closeNewFile(); } });
  form.querySelector("[data-field='layer']")!.addEventListener("change", () => suggest(byName<HTMLSelectElement>("layer").value, true));
  form.addEventListener("submit", (event) => { event.preventDefault(); void create(); });
  return form;
}

// Fills the folder, system, and tag the layer's own files use most. The path is only filled while the
// person has not typed a name of their own into it.
function suggest(layer: string, keepName: boolean): void
{
  const files = filesOn(layer);
  const path = byName<HTMLInputElement>("path");
  const folder = mostCommon(files.map((file) => file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : ""));
  const typed = path.value.slice(path.value.lastIndexOf("/") + 1);
  if (!keepName || typed === "") path.value = folder;
  const system = byName<HTMLSelectElement>("system");
  const usual = mostCommon(files.map((file) => S.FILE_SYSTEMS.get(file) ?? ""));
  if (usual) system.value = usual;
  const tag = mostCommon(files.map((file) => (S.FILE_TAGS.get(file) ?? [])[0] ?? ""));
  for (const chip of panel!.querySelectorAll<HTMLElement>("[data-tag]")) chip.setAttribute("aria-pressed", String(chip.dataset.tag === tag));
}

/**
 * Opens the form for a new file on one layer.
 * @param layer the layer the new file goes on
 */
export function openNewFile(layer: string): void
{
  panel ??= build();
  const layers = byName<HTMLSelectElement>("layer");
  layers.replaceChildren(...[...S.LAYERS].reverse().map((name) => new Option(name, name)));
  layers.value = layer;
  const systems = byName<HTMLSelectElement>("system");
  systems.replaceChildren(...S.SYSTEMS.map((name) => new Option(name, name)));
  byName<HTMLElement>("system-row").hidden = S.SYSTEMS.length === 0;
  const folders = panel.querySelector("#newfile-folders")!;
  folders.replaceChildren(...S.NODES.filter((n) => n.id !== "").map((n) => new Option(n.id + "/")));
  byName<HTMLInputElement>("summary").value = "";
  byName<HTMLInputElement>("path").value = "";
  showError("");
  suggest(layer, false);
  panel.hidden = false;
  const path = byName<HTMLInputElement>("path");
  path.focus();
  path.setSelectionRange(path.value.length, path.value.length);
}

/** Closes the form without making anything. */
export function closeNewFile(): void
{
  if (panel) panel.hidden = true;
}

function showError(text: string): void
{
  const error = byName<HTMLElement>("error");
  error.textContent = text;
  error.hidden = text === "";
}

async function create(): Promise<void>
{
  const button = byName<HTMLButtonElement>("create");
  const tags = [...panel!.querySelectorAll<HTMLElement>("[data-tag][aria-pressed='true']")].map((chip) => chip.dataset.tag!);
  const body: INewFileBody = {
    path: byName<HTMLInputElement>("path").value,
    summary: byName<HTMLInputElement>("summary").value,
    layer: byName<HTMLSelectElement>("layer").value,
    ...(S.SYSTEMS.length > 0 ? { system: byName<HTMLSelectElement>("system").value } : {}),
    tags,
  };
  button.disabled = true;
  showError("");
  const problem = await postNewFile(body);
  button.disabled = false;
  if (problem === null) closeNewFile();
  else showError(problem);
}
