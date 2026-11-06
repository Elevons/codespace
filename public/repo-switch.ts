// The repository switcher: point the map at another folder, keep the ones opened before, and say
// how much of the codebase is still undescribed. Describing it is the agent's job, with the CLI, so
// this panel offers the command prompt rather than calling a model itself.

/** What the server says about the repository it reads, and the recent ones. */
interface IRepoInfo
{
  name: string;
  root: string;
  recent: Array<{ name: string; root: string }>;
}

/** How much of the codebase still has no summary. */
interface IIngestStatus
{
  files: number;
  incomplete: number;
  folders: number;
  remaining: number;
  prompt: string;
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
const promptBox = byId<HTMLTextAreaElement>("repo-prompt");
const savedNote = byId<HTMLParagraphElement>("repo-ingest-saved");
const recent = byId<HTMLDivElement>("repo-recent");
const upButton = byId<HTMLButtonElement>("repo-up");
const browsePath = byId<HTMLParagraphElement>("repo-browse-path");
const browseList = byId<HTMLDivElement>("repo-browse-list");

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
    const status: IIngestStatus = await fetch("/api/ingest/status", { cache: "no-cache" }).then((response) => response.json());
    ingest.hidden = false;
    ingestPrompt = status.prompt;
    savedNote.textContent = "Your agent saves to .codespace/architecture.json as it goes.";
    const parts: string[] = [];
    if (status.files > 0) parts.push(status.files + (status.files === 1 ? " file" : " files"));
    if (status.incomplete > 0) parts.push(status.incomplete + " to fill in");
    if (status.folders > 0) parts.push(status.folders + (status.folders === 1 ? " folder" : " folders"));
    ingestNote.textContent = parts.length === 0 ? "Fully described." : parts.join(" · ") + " to describe";
    copyButton.hidden = status.remaining === 0;
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
    const query = path === null ? "" : "?path=" + encodeURIComponent(path);
    const response = await fetch("/api/browse" + query, { cache: "no-cache" });
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
  info = await fetch("/api/repo", { cache: "no-cache" }).then((response) => response.json());
  button.textContent = "Repo: " + info!.name;
  button.title = info!.root + " — click to open another repository";
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
    const response = await fetch("/api/repo", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }) });
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

/** Shows the panel over the map, ready to take a path. */
function showPanel(): void
{
  panel.hidden = false;
  button.classList.add("on");
  if (info !== null) pathInput.value = info.root;
  pathInput.focus();
  pathInput.select();
  void refreshStatus();
  void browse(browsing);
  // An agent may describe the codebase from outside the page, which sends no event.
  if (statusTimer === null) statusTimer = window.setInterval(() => { if (!panel.hidden) void refreshStatus(); }, 4000);
}

/** Hides the panel. */
function hidePanel(): void
{
  panel.hidden = true;
  button.classList.remove("on");
  if (statusTimer !== null) { clearInterval(statusTimer); statusTimer = null; }
}

button.addEventListener("click", (event) =>
{
  event.stopPropagation();
  if (panel.hidden) showPanel();
  else hidePanel();
});

form.addEventListener("submit", (event) =>
{
  event.preventDefault();
  void open(pathInput.value);
});

upButton.addEventListener("click", () => { if (browsingParent !== null) void browse(browsingParent); });

/**
 * Puts text on the clipboard. The Clipboard API needs a secure page, which a map watched over
 * plain http on the network is not, so a hidden box and the old copy command stand in for it.
 * @param text what to copy
 */
async function copyText(text: string): Promise<boolean>
{
  try
  {
    if (navigator.clipboard !== undefined && window.isSecureContext) { await navigator.clipboard.writeText(text); return true; }
  }
  catch { /* fall through to the old way */ }
  try
  {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  }
  catch { return false; }
}

copyButton.addEventListener("click", async () =>
{
  if (await copyText(ingestPrompt))
  {
    copyButton.textContent = "Copied";
    setTimeout(() => { copyButton.textContent = "Copy agent prompt"; }, 1400);
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
