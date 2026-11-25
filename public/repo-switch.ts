// The repository switcher: point the map at another folder, keep the ones opened before, and say
// how much of the codebase is still undescribed. Describing it is an agent's job, with the CLI: this
// panel copies the command prompt for an agent outside, and the Chat panel (chat.ts) runs one inside.

import { api } from "./endpoint.js";
import { copyText } from "./state.js";
import type { IIngestStatus } from "./ingest.js";

/** What the server says about the repository it reads, and the recent ones. */
interface IRepoInfo
{
  name: string;
  root: string;
  recent: Array<{ name: string; root: string }>;
  /** Whether the page was opened on this repository with ?repo=, so it cannot switch. */
  pinned?: boolean;
  /** Whether the built-in chat is there for this page. */
  chat?: boolean;
}

/** One folder the picker can walk into. */
interface IBrowseEntry
{
  name: string;
  path: string;
}

/** What the server lists for one folder on the machine it runs on. */
interface IBrowse
{
  path: string;
  parent: string | null;
  repository: boolean;
  folders: IBrowseEntry[];
}

const button = byId<HTMLButtonElement>("repo");
const panel = byId<HTMLDivElement>("repo-panel");
const form = byId<HTMLFormElement>("repo-form");
const pathInput = byId<HTMLInputElement>("repo-path");
const openButton = form.querySelector("button")!;
const errorNote = byId<HTMLParagraphElement>("repo-error");
const ingest = byId<HTMLDivElement>("repo-ingest");
const ingestNote = byId<HTMLParagraphElement>("repo-ingest-note");
const copyButton = byId<HTMLButtonElement>("repo-ingest-copy");
const runButton = byId<HTMLButtonElement>("repo-ingest-run");
const refineButton = byId<HTMLButtonElement>("repo-ingest-refine");
const promptBox = byId<HTMLTextAreaElement>("repo-prompt");
const savedNote = byId<HTMLParagraphElement>("repo-ingest-saved");
const recent = byId<HTMLDivElement>("repo-recent");
const upButton = byId<HTMLButtonElement>("repo-up");
const browsePath = byId<HTMLParagraphElement>("repo-browse-path");
const browseList = byId<HTMLDivElement>("repo-browse-list");
const deleteButton = byId<HTMLButtonElement>("repo-delete-architecture");
const deleteConfirm = byId<HTMLDivElement>("repo-delete-confirm");
const deleteQuestion = byId<HTMLParagraphElement>("repo-delete-question");
const deleteYes = byId<HTMLButtonElement>("repo-delete-yes");
const deleteCancel = byId<HTMLButtonElement>("repo-delete-cancel");

/** The prompt handed to an agent, as the server words it, naming the CLI commands. */
let ingestPrompt = "";

/** What the server said last, so a recent entry can be opened by its root. */
let info: IRepoInfo | null = null;

/** The timer that keeps the status fresh while the panel is open, or null. */
let statusTimer: number | null = null;

/** The folder the picker is showing, or null for the repository being read. */
let browsing: string | null = null;

/** The folder above the one being shown, or null at the filesystem root. */
let browsingParent: string | null = null;

/** Finds an element the page must have. */
function byId<T extends HTMLElement>(id: string): T
{
  const element = document.getElementById(id);
  if (!element) throw new Error(`The page is missing #${id}.`);
  return element as T;
}

/** Says what is left to describe, or that everything is. */
async function refreshStatus(): Promise<void>
{
  try
  {
    const status: IIngestStatus = await fetch(api("ingest/status"), { cache: "no-cache" }).then((response) => response.json());
    ingest.hidden = false;
    ingestPrompt = status.prompt;
    savedNote.textContent = "The chat saves to .codespace/architecture.json as it goes.";
    const changed = status.changed, stale = status.stale;
    const refine = status.refine;
    const described = status.described;
    const parts: string[] = [];
    if (status.files > 0) parts.push(status.files + (status.files === 1 ? " file" : " files"));
    if (changed > 0) parts.push(changed + " changed");
    if (stale > 0) parts.push(stale + " gone");
    if (status.incomplete > 0) parts.push(status.incomplete + " to fill in");
    if (status.folders > 0) parts.push(status.folders + (status.folders === 1 ? " folder" : " folders"));
    // Once everything is described, the second pass says how many imports still point up the layers,
    // and the design pass says what is left of the operations and data, all of which the ingest runs.
    const breaks = refine.breaks;
    const design = status.concepts;
    const designLeft: string[] = [];
    if (design.operations > 0) designLeft.push(design.operations + (design.operations === 1 ? " operation" : " operations"));
    if (design.data > 0) designLeft.push(design.data + (design.data === 1 ? " data entry" : " data entries"));
    const changedOps = design.changedOperations ?? 0, changedData = design.changedData ?? 0;
    if (changedOps > 0) designLeft.push(changedOps + (changedOps === 1 ? " operation changed" : " operations changed"));
    if (changedData > 0) designLeft.push(changedData + " data changed");
    if (design.unplaced > 0) designLeft.push(design.unplaced + (design.unplaced === 1 ? " file to place" : " files to place"));
    const designNote = !design.started
      ? "No operations written yet."
      : designLeft.length > 0 ? designLeft.join(" and ") + " to finish." : "";
    const upToDate = "Up to date." + (refine.remaining > 0 ? " " + (breaks > 0 ? breaks + (breaks === 1 ? " layer break" : " layer breaks") + " to refine." : "Layers could be refined.") : "");
    ingestNote.textContent = parts.length === 0
      ? [upToDate, designNote].filter((text) => text.length > 0).join(" ")
      : (described > 0 ? "To update: " : "To describe: ") + parts.join(" · ");
    refineButton.hidden = status.remaining !== 0 || refine.remaining === 0;
    copyButton.hidden = status.remaining === 0 && described === 0;
    // Once there is a description the button stays, as Update Map, so an update can be run on demand at any
    // time: it picks up whatever changed, even when the page has not counted it yet.
    runButton.hidden = status.remaining === 0 && described === 0;
    runButton.textContent = described > 0 ? "Update Map" : "Ingest Codebase";
    runButton.title = described > 0 ? "Have the built-in agent bring the description, the layers, and the design up to date, in the chat" : "Have the built-in agent describe this repository, its layers, and its design, in the chat";
  }
  catch
  {
    ingest.hidden = true;
  }
}

/**
 * Shows the folders inside one folder of the machine running Codespace, so a repository can be
 * walked to rather than typed from memory. An empty path is the repository being read.
 * @param path the folder to show
 */
async function browse(path: string | null): Promise<void>
{
  try
  {
    const response = await fetch(api("browse", path === null ? {} : { path }), { cache: "no-cache" });
    const body: IBrowse & { error?: string } = await response.json();
    if (!response.ok) throw new Error(body.error ?? "That folder cannot be listed.");
    browsing = body.path;
    browsingParent = body.parent;
    pathInput.value = body.path;
    browsePath.textContent = body.path + (body.repository ? " · repository" : "");
    upButton.disabled = body.parent === null;
    browseList.replaceChildren();
    if (body.folders.length === 0)
    {
      const empty = document.createElement("p");
      empty.className = "hint empty";
      empty.textContent = "No folders inside.";
      browseList.append(empty);
    }
    for (const folder of body.folders)
    {
      const item = document.createElement("button");
      item.type = "button";
      item.textContent = folder.name + "/";
      item.title = folder.path;
      item.addEventListener("click", () => { void browse(folder.path); });
      browseList.append(item);
    }
  }
  catch (error)
  {
    errorNote.textContent = error instanceof Error ? error.message : String(error);
    errorNote.hidden = false;
  }
}

/** Lists the recent repositories, newest first, each opening on a click. */
function renderRecent(): void
{
  recent.replaceChildren();
  for (const entry of info?.recent ?? [])
  {
    const item = document.createElement("button");
    item.type = "button";
    item.textContent = entry.name + " — " + entry.root;
    item.title = "Open " + entry.root;
    item.addEventListener("click", () => { pathInput.value = entry.root; void open(entry.root); });
    recent.append(item);
  }
}

/** Reads what the server is reading, and updates the button and list. */
async function refreshInfo(): Promise<void>
{
  info = await fetch(api("repo"), { cache: "no-cache" }).then((response) => response.json());
  // A page opened with ?repo= keeps to that repository, and a server run by a host with its own agent has no
  // chat, so the controls for either are taken away (style.css).
  document.body.classList.toggle("pinned", info!.pinned === true);
  document.body.classList.toggle("no-chat", info!.chat === false);
  const name = document.createElement("span");
  name.className = "repo-name";
  name.textContent = info!.name;
  button.replaceChildren("Repo", name);
  button.title = info!.root + (info!.pinned ? "" : " — click to open another repository");
  pathInput.placeholder = info!.root;
  renderRecent();
}

/**
 * Points the map at a folder, and reloads the page onto it.
 * @param path the folder to open
 */
async function open(path: string): Promise<void>
{
  errorNote.hidden = true;
  openButton.disabled = true;
  try
  {
    const response = await fetch(api("repo"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "That folder could not be opened.");
    location.reload();
  }
  catch (error)
  {
    errorNote.textContent = error instanceof Error ? error.message : String(error);
    errorNote.hidden = false;
  }
  finally
  {
    openButton.disabled = false;
  }
}

/**
 * Deletes the repository's .codespace folder, so its layers, systems, and summaries are gone and an
 * agent can describe the codebase again from nothing. The map reloads onto the now-bare repository.
 */
async function deleteArchitecture(): Promise<void>
{
  errorNote.hidden = true;
  deleteYes.disabled = true;
  deleteCancel.disabled = true;
  try
  {
    const response = await fetch(api("architecture"), { method: "DELETE", headers: { "Content-Type": "application/json" } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error ?? "The architecture folder could not be deleted.");
    location.reload();
  }
  catch (error)
  {
    errorNote.textContent = error instanceof Error ? error.message : String(error);
    errorNote.hidden = false;
  }
  finally
  {
    deleteYes.disabled = false;
    deleteCancel.disabled = false;
  }
}

/** Shows the panel over the map, ready to take a path. */
function showPanel(): void
{
  document.getElementById("codeblock")!.hidden = true;
  errorNote.hidden = true;
  panel.hidden = false;
  button.classList.add("on");
  if (info !== null) pathInput.value = info.root;
  if (info?.pinned !== true)
  {
    pathInput.focus();
    pathInput.select();
    void browse(browsing);
  }
  void refreshStatus();
  // An agent may describe the codebase from outside the page, which sends no event.
  if (statusTimer === null) statusTimer = window.setInterval(() => { if (!panel.hidden) void refreshStatus(); }, 4000);
}

/** Hides the panel. */
function hidePanel(): void
{
  panel.hidden = true;
  button.classList.remove("on");
  askDelete(false);
  if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null; }
}

button.addEventListener("click", (event) =>
{
  event.stopPropagation();
  if (panel.hidden) showPanel();
  else hidePanel();
});

// The code panel and the repository picker share the middle of the screen, so one closes the other.
window.addEventListener("codespace:close-repo", () => { if (!panel.hidden) hidePanel(); });

form.addEventListener("submit", (event) =>
{
  event.preventDefault();
  void open(pathInput.value);
});

upButton.addEventListener("click", () => { if (browsingParent !== null) void browse(browsingParent); });

/**
 * Swaps the delete button for an in-panel question, or back. A native confirm box is not used,
 * since embedded previews may never show it and the click would silently do nothing.
 * @param asking whether to show the question
 */
function askDelete(asking: boolean): void
{
  deleteButton.hidden = asking;
  deleteConfirm.hidden = !asking;
  if (!asking) return;
  const where = info === null ? ".codespace" : info.root.replace(/\/+$/, "") + "/.codespace";
  deleteQuestion.textContent = `Delete ${where}? Its layers, systems, and summaries are lost, so the repository can be described again from nothing.`;
  deleteCancel.focus();
}

deleteButton.addEventListener("click", () => askDelete(true));
deleteCancel.addEventListener("click", () => askDelete(false));
deleteYes.addEventListener("click", () => void deleteArchitecture());

// Ingest hands the describing to the chat's agent: the server starts a new chat with the prompt,
// and the chat opens so its progress can be followed while the map fills in.
async function startChat(action: "describe" | "refine", from: HTMLButtonElement): Promise<void>
{
  from.disabled = true;
  try
  {
    const response = await fetch(api("chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    if (!response.ok) throw new Error(((await response.json().catch(() => ({}))) as { error?: string }).error ?? "The chat could not start.");
    hidePanel();
    window.dispatchEvent(new Event("codespace:open-chat"));
  }
  catch (error)
  {
    errorNote.textContent = (error as Error).message;
    errorNote.hidden = false;
  }
  finally { from.disabled = false; }
}

runButton.addEventListener("click", () => startChat("describe", runButton));

// Refine hands the second pass to the chat's agent the same way, on a repository already described.
refineButton.addEventListener("click", () => startChat("refine", refineButton));

copyButton.addEventListener("click", async () =>
{
  if (await copyText(ingestPrompt))
  {
    copyButton.textContent = "Copied";
    setTimeout(() => { copyButton.textContent = "Copy prompt"; }, 1400);
    return;
  }
  // Nothing could reach the clipboard, so show the prompt to copy by hand.
  promptBox.value = ingestPrompt;
  promptBox.hidden = false;
  promptBox.focus();
  promptBox.select();
  copyButton.textContent = "Select above and copy";
});

// A click anywhere else closes the panel, and Escape does from the keyboard.
document.addEventListener("pointerdown", (event) =>
{
  if (!panel.hidden && !panel.contains(event.target as Node) && !button.contains(event.target as Node)) hidePanel();
});
document.addEventListener("keydown", (event) =>
{
  if (event.key === "Escape" && !panel.hidden) { hidePanel(); event.stopPropagation(); }
});

// Describing the codebase happens while the page is open, so the count follows along.
window.addEventListener("codespace:architecture", () => { if (!panel.hidden) void refreshStatus(); });

void refreshInfo().catch(() => { button.textContent = "Repo: unavailable"; });
