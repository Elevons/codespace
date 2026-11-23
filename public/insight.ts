// The insights panel: three answers to questions the map itself does not ask. Recent lists the
// files that differ from the last commit. Flows keeps views of the map that can be shown again,
// and drafts a start-here tour from the descriptions. Health checks the shape of the codebase.
// None of it draws anything new: every action ends in a view call the whole page already follows,
// made in this page alone when the host serves the map read only (see viewcall.ts).

import { api } from "./endpoint.js";
import { S, copyText, pathIndex } from "./state.js";
import { escapeHtml, selectFile } from "./panels.js";
import { MaxFlowName, type IFlow } from "./flows.js";
import type { IHealthAnswer } from "./health.js";
import type { IShownFile } from "./shown.js";
import { changeView } from "./viewcall.js";

/** The three tabs the panel holds. */
type Tab = "recent" | "flows" | "health";

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

const openers = [...document.querySelectorAll<HTMLButtonElement>(".insight-open")];
const panel = byId<HTMLElement>("insight");
const body = byId<HTMLElement>("insight-body");
const closeButton = byId<HTMLButtonElement>("insight-close");
const tabs = byId<HTMLElement>("insight-tabs");

let tab: Tab = "recent";
let flowName = "";
let healthReport: IHealthAnswer | null = null;
/** The flows the Flows tab last listed, so one is drawn from what the page already holds. */
let listedFlows: IFlow[] = [];

/** The number of reads started, so a slow one cannot paint over a newer tab. */
let wanted = 0;

// ---- talking to the server ----

async function getJson(path: string, query: Record<string, string> = {}): Promise<any>
{
  const response = await fetch(api(path, query), { cache: "no-cache" });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error ?? "The server could not answer.");
  return data;
}

async function post(path: string, payload: unknown): Promise<any>
{
  const response = await fetch(api(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
  const data = await response.json().catch(() => ({}));
  // A host that serves the map read only refuses every write, or does not pass it on at all.
  if (response.status === 404 || response.status === 405) throw new Error("This map is read only here, so flows cannot be saved or deleted. Open Codespace itself to change them.");
  if (!response.ok) throw new Error(data.error ?? "The server refused the change.");
  return data;
}

/** Draws a set of files on the map, as a route when asked. */
async function draw(title: string, files: IShownFile[], trace = false, note = ""): Promise<void>
{
  const known = files.filter((file) => pathIndex().files.has(file.path));
  if (known.length === 0) return;
  await changeView({ type: "show", shown: { title, note, trace, files: known } });
}

/** Narrows the map to a set of files, or clears the narrowing with an empty set. */
async function only(files: string[]): Promise<void>
{
  await changeView({ type: "isolate", files });
}

/** Chooses one file in the page, so its blocks open beside the map. */
function choose(path: string): void
{
  const spot = pathIndex().files.get(path);
  if (spot) selectFile(spot[0], spot[1]);
}

// ---- the panel ----

/** Opens the panel on one tab, or on the last tab it showed. */
export function openInsight(next: Tab = tab): void
{
  panel.hidden = false;
  window.dispatchEvent(new CustomEvent("codespace:panel-open", { detail: "insight" }));
  tab = next;
  paintOpeners();
  if (document.body.classList.contains("phone")) window.dispatchEvent(new Event("codespace:open-insight"));
  void render();
}

function close(): void
{
  panel.hidden = true;
  paintOpeners();
  window.dispatchEvent(new CustomEvent("codespace:panel-closed", { detail: "insight" }));
}

/** Marks the bottom bar's button for the open tab, so the bar says which one is showing. */
function paintOpeners(): void
{
  for (const opener of openers) opener.classList.toggle("on", !panel.hidden && !panel.classList.contains("collapsed") && opener.dataset.openTab === tab);
}

function paintTabs(): void
{
  paintOpeners();
  tabs.querySelectorAll<HTMLButtonElement>("[data-itab]").forEach((element) =>
  {
    const on = element.dataset.itab === tab;
    element.classList.toggle("on", on);
    element.setAttribute("aria-selected", String(on));
  });
}

async function render(): Promise<void>
{
  const mine = ++wanted;
  paintTabs();
  body.innerHTML = '<p class="hint">Reading…</p>';
  try
  {
    if (tab === "recent") renderRecent();
    else if (tab === "flows") await renderFlows(mine);
    else await renderHealth(mine);
  }
  catch (error)
  {
    if (mine === wanted) body.innerHTML = '<p class="hint bad">' + escapeHtml((error as Error).message) + "</p>";
  }
}

function stat(value: number | string, label: string): string
{
  return '<div class="istat"><b>' + escapeHtml(String(value)) + "</b><span>" + escapeHtml(label) + "</span></div>";
}

/** A row that chooses a file, with a right-hand value. */
function fileRow(path: string, value: string): string
{
  return '<button type="button" class="irow" data-path="' + escapeHtml(path) + '">' +
    '<span class="iname">' + escapeHtml(path) + '</span><span class="inum">' + escapeHtml(value) + "</span></button>";
}

/* ---- recent ---- */

function renderRecent(): void
{
  const changes = [...S.FILE_CHANGES.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const lines = changes.reduce((sum, [, count]) => sum + count, 0);
  if (changes.length === 0)
  {
    body.innerHTML = '<p class="hint">No file differs from the last commit. Work that is already committed is not listed.</p>';
    return;
  }
  body.innerHTML =
    '<div class="istats">' + stat(changes.length, "files changed") + stat(lines.toLocaleString(), "lines changed") + "</div>" +
    '<div class="iacts"><button type="button" class="iact" data-act="show-changes">Show changed files</button>' +
    '<button type="button" class="iact" data-act="only-changes">Only changed files</button></div>' +
    '<div class="ilist">' + changes.map(([path, count]) => fileRow(path, "+" + count)).join("") + "</div>" +
    '<p class="hint">Counted against HEAD with git, so an uncommitted file shows and a committed one does not.</p>';
}

/* ---- flows ---- */

async function renderFlows(mine: number): Promise<void>
{
  const data = await getJson("flows");
  if (mine !== wanted) return;
  const flows: IFlow[] = Array.isArray(data.flows) ? data.flows : [];
  listedFlows = flows;
  const rows = flows.length === 0
    ? '<p class="hint">No flows saved yet. Show something on the map, then save it here by name.</p>'
    : '<div class="ilist">' + flows.map((flow) =>
      '<div class="irow rich">' +
        '<button type="button" class="iname" data-flow-show="' + escapeHtml(flow.name) + '">' + escapeHtml(flow.title) + "</button>" +
        '<button type="button" class="iact small" data-flow-show="' + escapeHtml(flow.name) + '">Show</button>' +
        '<button type="button" class="ix" data-flow-del="' + escapeHtml(flow.name) + '" title="Delete this flow" aria-label="Delete this flow">✕</button>' +
        '<span class="isub">' + escapeHtml(flow.name) + " · " + flow.files.length + (flow.trace ? " steps" : " files") + "</span>" +
      "</div>").join("") + "</div>";
  body.innerHTML =
    '<div class="iacts">' +
      '<button type="button" class="iact" data-act="tour">Start here</button>' +
      '<input id="flow-name" type="text" maxlength="' + MaxFlowName + '" placeholder="Name this view" value="' + escapeHtml(flowName) + '" autocomplete="off" spellcheck="false">' +
      '<button type="button" class="iact" data-act="save-flow">Save showing</button>' +
    "</div>" +
    '<p class="hint">Start here draws a tour from the entry points. A flow is a saved view of the map, kept in this repository at .codespace/flows.json.</p>' +
    '<p class="hint bad" id="flow-msg" hidden></p>' + rows;
}

/* ---- health ---- */

async function renderHealth(mine: number): Promise<void>
{
  const health: IHealthAnswer = await getJson("health");
  if (mine !== wanted) return;
  healthReport = health;
  const breaks = health.breakGroups.map((group) =>
  {
    const examples = group.examples.flatMap((example) => [example.from, example.to]);
    return '<div class="irow rich">' +
      '<span class="iname">' + escapeHtml(group.from) + " → " + escapeHtml(group.to) + "</span>" +
      '<span class="inum">' + group.count + "</span>" +
      '<button type="button" class="iact small" data-show-paths="' + escapeHtml(examples.join("\n")) + '" data-show-title="' +
        escapeHtml("Imports up a layer: " + group.from + " → " + group.to) + '">Show</button>' +
      '<span class="isub">' + (group.ordinary > 0 ? group.ordinary + " go the right way" : "none go the right way") + "</span></div>";
  }).join("");
  const oversized = health.oversized.map((file) => fileRow(file.path, file.lines + " lines")).join("");
  const secrets = health.secrets.map((finding) =>
    '<button type="button" class="irow" data-path="' + escapeHtml(finding.path) + '">' +
      '<span class="iname">' + escapeHtml(finding.path) + ":" + finding.line + "</span>" +
      '<span class="inum">' + escapeHtml(finding.key) + "</span><span class=\"isub\">" + escapeHtml(finding.hint) + "</span></button>").join("");
  const issues = health.issues.map((issue) => '<p class="hint">' + escapeHtml(issue) + "</p>").join("");
  const undescribed = health.undescribed > 0
    ? '<h4 class="ihead">Not described · ' + health.undescribed + "</h4>" +
      '<div class="ilist">' + health.undescribedPaths.map((path) => fileRow(path, "")).join("") + "</div>"
    : "";
  body.innerHTML =
    '<div class="istats">' + stat(health.files, "files") + stat(health.codeFiles, "code files") +
      stat(health.lines.toLocaleString(), "lines") + stat(health.imports, "imports") + "</div>" +
    '<div class="iacts"><button type="button" class="iact" data-act="copy-health">Copy findings</button>' +
      '<button type="button" class="iact" data-act="only-undescribed">Only undescribed</button></div>' +
    '<h4 class="ihead">Imports up a layer · ' + health.layerBreaks + "</h4>" +
    (breaks || '<p class="hint">No import points up the layer order.</p>') +
    '<h4 class="ihead">Largest files</h4>' +
    (oversized ? '<div class="ilist">' + oversized + "</div>" : '<p class="hint">No file passes the size worth noticing.</p>') +
    '<h4 class="ihead">Values that look like keys · ' + health.secrets.length + "</h4>" +
    (secrets ? '<div class="ilist">' + secrets + "</div>" : '<p class="hint">None found in the ' + health.scanned + " files a browser can read.</p>") +
    (issues ? '<h4 class="ihead">Layering</h4>' + issues : "") +
    undescribed +
    '<h4 class="ihead">How to read this</h4>' +
    health.notes.map((note) => '<p class="hint">' + escapeHtml(note) + "</p>").join("");
}

// ---- actions ----

function message(text: string, bad = true): void
{
  const note = document.getElementById("flow-msg");
  if (note === null) return;
  note.hidden = false;
  note.classList.toggle("bad", bad);
  note.textContent = text;
}

async function saveShowing(): Promise<void>
{
  if (S.trace === null)
  {
    message("Draw something on the map first, then save it.");
    return;
  }
  const name = (flowName || S.trace.title || "view").trim();
  const flow: IFlow = {
    name,
    title: S.trace.title || name,
    note: S.trace.note,
    trace: S.trace.trace,
    files: S.trace.paths.map((path, index) => ({ path, note: S.trace!.notes[index] ?? "" })),
  };
  try
  {
    await post("flows", { action: "save", flow });
    flowName = name;
    await render();
  }
  catch (error) { message((error as Error).message); }
}

async function showTour(): Promise<void>
{
  // The panel is drawn again first, so a message has somewhere to go.
  let problem = "";
  try
  {
    const data = await getJson("flows", { draft: "1" });
    const flow: IFlow | null = data.flow ?? null;
    if (flow === null) problem = "Too few files have a description yet, so there is nothing to build a tour from.";
    else
    {
      flowName = flow.name;
      await draw(flow.title, flow.files, flow.trace, flow.note);
    }
  }
  catch (error) { problem = (error as Error).message; }
  await render();
  if (problem) message(problem);
}

body.addEventListener("click", (event) =>
{
  const target = event.target as HTMLElement;
  const file = target.closest("[data-path]") as HTMLElement | null;
  if (file) { choose(file.dataset.path!); return; }

  const showFlow = target.closest("[data-flow-show]") as HTMLElement | null;
  if (showFlow)
  {
    const flow = listedFlows.find((each) => each.name === showFlow.dataset.flowShow);
    if (flow) draw(flow.title, flow.files, flow.trace, flow.note).catch((error) => message((error as Error).message));
    return;
  }

  const remove = target.closest("[data-flow-del]") as HTMLElement | null;
  if (remove)
  {
    post("flows", { action: "delete", name: remove.dataset.flowDel })
      .then(() => render())
      .catch((error) => message((error as Error).message));
    return;
  }

  const showPaths = target.closest("[data-show-paths]") as HTMLElement | null;
  if (showPaths)
  {
    const paths = (showPaths.dataset.showPaths ?? "").split("\n").filter(Boolean);
    void draw(showPaths.dataset.showTitle ?? "Layer break", paths.map((path) => ({ path, note: "" })));
    return;
  }

  const action = target.closest("[data-act]") as HTMLElement | null;
  if (!action) return;
  const name = action.dataset.act;
  if (name === "show-changes") void showChanges();
  else if (name === "only-changes") void onlyChanges();
  else if (name === "only-undescribed") void onlyUndescribed();
  else if (name === "save-flow") void saveShowing();
  else if (name === "tour") void showTour();
  else if (name === "copy-health") void copyHealth(action);
});

body.addEventListener("input", (event) =>
{
  const input = event.target as HTMLInputElement;
  if (input.id === "flow-name") flowName = input.value;
});

function changedPaths(): string[]
{
  return [...S.FILE_CHANGES.entries()].sort((a, b) => b[1] - a[1]).map(([path]) => path).filter((path) => pathIndex().files.has(path));
}

async function showChanges(): Promise<void>
{
  const paths = changedPaths();
  if (paths.length === 0) return;
  await draw("Changed since HEAD", paths.map((path) => ({ path, note: "+" + S.FILE_CHANGES.get(path) + " lines" })));
}

async function onlyChanges(): Promise<void>
{
  await only(changedPaths());
}

/** Copies the findings as plain text, so they can be pasted into any agent. */
async function copyHealth(button: HTMLElement): Promise<void>
{
  const health = healthReport;
  if (health === null) return;
  const lines = [`Codespace health for ${S.repoName} (${health.files} files, ${health.lines} lines).`]
  for (const group of health.breakGroups) lines.push(`${group.count} imports go up a layer: ${group.from} → ${group.to}.`)
  for (const issue of health.issues) lines.push(issue)
  for (const file of health.oversized) lines.push(`${file.path} has ${file.lines} lines.`)
  for (const finding of health.secrets) lines.push(`${finding.path}:${finding.line} holds a value named ${finding.key} that looks like a key; it may be public on purpose.`)
  if (health.undescribed > 0) lines.push(`${health.undescribed} files have no description yet.`)
  lines.push("Read the files named above and change what is real. These are patterns, not proof.")
  const before = button.textContent;
  const copied = await copyText(lines.join("\n"));
  button.textContent = copied ? "Copied" : "Copy failed";
  setTimeout(() => { button.textContent = before; }, 1600);
}

async function onlyUndescribed(): Promise<void>
{
  const paths = healthReport?.undescribedPaths ?? [];
  if (paths.length === 0) return;
  // The map hides undescribed files while "Described only" is on, so turn it off and wait for the
  // redraw that brings them onto the map before narrowing to them.
  const box = document.getElementById("opt-ingested") as HTMLInputElement | null;
  if (box !== null && box.checked)
  {
    box.checked = false;
    box.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise<void>((done) =>
    {
      const timer = setTimeout(done, 2000);
      window.addEventListener("codespace:built", () => { clearTimeout(timer); done(); }, { once: true });
    });
  }
  await only(paths);
}

// Each of the bottom bar's buttons opens the panel on its own tab, and closes it when that tab is
// already showing. On a phone a button always opens it, since a panel moved into a closed sheet is
// out of sight but not hidden. Start here draws the tour and opens Flows, where it can be saved.
for (const opener of openers)
{
  opener.addEventListener("click", () =>
  {
    const want = opener.dataset.openTab;
    if (want === "tour") { openInsight("flows"); void showTour(); return; }
    const next = want as Tab;
    if (!document.body.classList.contains("phone") && !panel.hidden && !panel.classList.contains("collapsed") && tab === next) { close(); return; }
    openInsight(next);
  });
}
// On a phone the Insights tab opens the panel's sheet, so the panel shows whatever tab it was on.
window.addEventListener("codespace:pane", (event) => { if ((event as CustomEvent).detail === "insight" && panel.hidden) openInsight(); });
window.addEventListener("codespace:panels-changed", () => paintOpeners());
// The repository's first panel offers the tour too.
window.addEventListener("codespace:tour", () => { openInsight("flows"); void showTour(); });
closeButton.addEventListener("click", close);
tabs.addEventListener("click", (event) =>
{
  const chosen = (event.target as HTMLElement).closest("[data-itab]") as HTMLElement | null;
  if (!chosen) return;
  tab = chosen.dataset.itab as Tab;
  void render();
});

// A redraw can change the changed files and the undescribed ones, so an open tab reads them again.
window.addEventListener("codespace:built", () => { if (!panel.hidden && (tab === "recent" || tab === "health")) void render(); });
window.addEventListener("codespace:architecture", () => { if (!panel.hidden && tab === "health") void render(); });
