// The chat built into the map: a prompt box and the conversation above it. The server runs the
// agent in the repository being mapped; what it draws arrives on the map the usual way, and its
// reply streams in here as it is written. It keeps out of the way: closed, the Chat button (or the
// phone's Chat tab) only says when it is working or has a reply waiting. Open, a status line says
// what it is doing now, its steps fold into one line, and file names in a reply lead to the file.

import { api } from "./endpoint.js";
import { S } from "./state.js";
import { escapeHtml } from "./panels.js";
import { focusPath } from "./view.js";

import type { ChatEvent, IChatLine as ChatLine, IChatState as ChatState } from "./chatwire.js";

function byId<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }

const button = byId<HTMLButtonElement>("chat-btn");
const panel = byId<HTMLDivElement>("chat-panel");
const sheet = byId<HTMLElement>("msheet");
const tabBadge = document.querySelector<HTMLElement>('#mtabs [data-tab="chat"] .mbadge');
const modelNote = byId<HTMLParagraphElement>("chat-model");
const history = byId<HTMLSelectElement>("chat-history");
const newButton = byId<HTMLButtonElement>("chat-new");
const closeButton = byId<HTMLButtonElement>("chat-close");
const status = byId<HTMLDivElement>("chat-status");
const statusText = byId<HTMLSpanElement>("chat-status-text");
const statusTime = byId<HTMLSpanElement>("chat-status-time");
const log = byId<HTMLDivElement>("chat-log");
const form = byId<HTMLFormElement>("chat-form");
const input = byId<HTMLTextAreaElement>("chat-input");
const sendButton = byId<HTMLButtonElement>("chat-send");

/** Things worth asking first, offered while a chat is empty. */
const STARTERS = [
  "Give me a short tour of this repository on the map",
  "Trace how the main entry point starts up",
  "Describe the files the map doesn't know yet",
];

let lines: ChatLine[] = [];
let busy = false;
let available = true;
let unread = false;
let doing = "";
let startedAt = 0;
let clock = 0;

/** Whether the chat is on screen: its panel on a computer, its sheet on a phone. */
function visible(): boolean
{
  return document.body.classList.contains("phone") ? !sheet.hidden && sheet.dataset.pane === "chat" : !panel.hidden;
}

/* ------------------------------------------------------- tool words ---- */

const DONE: Record<string, string> = { read: "Read", bash: "Ran", grep: "Searched for", find: "Looked for", ls: "Listed", edit: "Edited", write: "Wrote" };
const DOING: Record<string, string> = { read: "Reading", bash: "Running", grep: "Searching for", find: "Looking for", ls: "Listing", edit: "Editing", write: "Writing" };

/** What a map request in a command does, or "" when the command does not change the map. */
function mapAction(line: ChatLine): string
{
  if (line.tool !== "bash" || !/\/api\/view\b/.test(line.text)) return "";
  if (/"action"\s*:\s*"clear"/.test(line.text)) return "Cleared the map";
  if (/"action"\s*:\s*"focus"/.test(line.text)) return "Moved the map";
  return "Drew on the map";
}

/** A command or path as it reads in a step: the curl that draws on the map becomes a plain phrase. */
function stepText(line: ChatLine, words: Record<string, string>): string
{
  const action = mapAction(line);
  if (action) return action;
  return (words[line.tool ?? ""] ?? line.tool ?? "") + " " + line.text;
}

/* ------------------------------------------------------------- text ---- */

/** A file the map knows, from a path the model wrote, with any `:line` taken off; or "". */
function knownPath(text: string): string
{
  const path = text.trim().replace(/^\.\//, "").replace(/:\d+(:\d+)?$/, "");
  return S.fileRecords.has(path) ? path : "";
}

/** A little Markdown, escaped first: code blocks, `code`, **bold**, headings, and bullets. */
function renderText(text: string): string
{
  return text.split(/```[^\n]*\n?([\s\S]*?)(?:```|$)/g).map((part, index) =>
  {
    if (index % 2 === 1) return "<pre>" + escapeHtml(part.replace(/\n$/, "")) + "</pre>";
    return part.split("\n").map((raw) =>
    {
      let line = escapeHtml(raw)
        .replace(/`([^`]+)`/g, (_, code: string) =>
        {
          const path = knownPath(code.replace(/&amp;/g, "&"));
          return path ? '<code class="path" data-path="' + escapeHtml(path) + '" title="Show on the map">' + code + "</code>" : "<code>" + code + "</code>";
        })
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
      if (/^#{1,6}\s/.test(raw)) return '<p class="h">' + line.replace(/^#{1,6}\s/, "") + "</p>";
      if (/^\s*([-*]|\d+\.)\s/.test(raw)) return '<p class="li">' + line.replace(/^\s*([-*]|\d+\.)\s/, (m) => '<span class="mk">' + (/\d/.test(m) ? m.trim() : "•") + "</span>") + "</p>";
      return line.trim() ? "<p>" + line + "</p>" : "";
    }).join("");
  }).join("");
}

/* ----------------------------------------------------------- drawing ---- */

// The conversation, newest at the bottom: the person's messages, the replies, a folded line for
// each run of steps, and a line of its own whenever the map was drawn on. It stays scrolled to
// the bottom unless the reader has scrolled up.
function renderLog(): void
{
  const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
  if (lines.length === 0)
  {
    log.innerHTML = '<p class="hint">Ask about the code, or ask it to trace something on the map.</p>' +
      '<div class="starters">' + STARTERS.map((text) => '<button type="button" class="starter">' + escapeHtml(text) + "</button>").join("") + "</div>";
    return;
  }

  const html: string[] = [];
  let steps: ChatLine[] = [];
  const flush = (last: boolean): void =>
  {
    if (steps.length === 0) return;
    const failed = steps.filter((step) => step.role === "error").length;
    const summary = (last && busy ? "Working through " : "Took ") + steps.length + (steps.length === 1 ? " step" : " steps") +
      (failed ? ' <span class="bad">· ' + failed + " failed</span>" : "");
    html.push('<details class="csteps"><summary>' + summary + "</summary>" +
      steps.map((step) => '<div class="cstep' + (step.role === "error" ? " failed" : "") + '">' + escapeHtml(stepText(step, DONE)) + "</div>").join("") +
      "</details>");
    steps = [];
  };
  lines.forEach((line, index) =>
  {
    const isStep = line.role === "tool" || (line.role === "error" && line.tool !== undefined);
    if (isStep)
    {
      steps.push(line);
      const action = mapAction(line);
      if (action && line.role !== "error")
      {
        flush(false);
        html.push('<div class="cline map"><span>' + action + '</span><button type="button" class="see">See it</button></div>');
      }
      return;
    }
    flush(index === lines.length - 1);
    if (line.role === "assistant") html.push('<div class="cline assistant">' + renderText(line.text) + "</div>");
    else html.push('<div class="cline ' + line.role + '">' + escapeHtml(line.text) + "</div>");
  });
  flush(true);
  log.innerHTML = html.join("");
  if (atBottom || busy) log.scrollTop = log.scrollHeight;
}

// The line under the header while a reply is under way: what it is doing now, and for how long.
function renderStatus(): void
{
  status.hidden = !busy;
  if (!busy) { clearInterval(clock); clock = 0; return; }
  statusText.textContent = doing || "Thinking…";
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  statusTime.textContent = seconds < 60 ? seconds + "s" : Math.floor(seconds / 60) + "m " + (seconds % 60) + "s";
  if (!clock) clock = window.setInterval(renderStatus, 1000);
}

// The Chat button and the phone's tab say when the chat is working or has a reply waiting.
function renderSignals(): void
{
  const state = busy ? "working" : unread ? "unread" : "";
  button.dataset.state = state;
  button.title = busy ? "The agent is working" : unread ? "A reply is waiting" : "Talk to the agent about this repository";
  if (tabBadge) { tabBadge.hidden = state === ""; tabBadge.classList.toggle("working", busy); }
}

function renderControls(): void
{
  sendButton.textContent = busy ? "Stop" : "Send";
  sendButton.classList.toggle("stop", busy);
  sendButton.disabled = !available && !busy;
  input.disabled = !available;
  history.disabled = busy;
  newButton.disabled = busy;
  renderStatus();
  renderSignals();
}

/* ----------------------------------------------------------- server ---- */

async function post(body: Record<string, unknown>): Promise<boolean>
{
  const response = await fetch(api("chat"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }).catch(() => null);
  if (response && response.ok) return true;
  const error = response ? ((await response.json().catch(() => ({}))) as { error?: string }).error : "The server could not be reached.";
  lines.push({ role: "error", text: error || "That did not work." });
  renderLog();
  return false;
}

// Reads the whole chat back from the server, which holds the truth once a reply has ended.
async function load(): Promise<void>
{
  const response = await fetch(api("chat"), { cache: "no-store" }).catch(() => null);
  if (!response || !response.ok)
  {
    // A server started before the chat existed has no /api/chat at all, so say to restart it.
    // A server without the chat, or a page on a repository opened with ?repo=, says why in its error.
    const said = response ? ((await response.json().catch(() => ({}))) as { error?: string }).error ?? "" : "";
    const error = !response ? "The server could not be reached."
      : said !== "" ? said
      : response.status === 404 ? "This server has no chat yet. Restart it (npm start) to load the chat."
      : "";
    available = false;
    modelNote.textContent = error || "The chat is not available.";
    modelNote.classList.add("problem");
    renderControls();
    return;
  }
  const state = (await response.json()) as ChatState;
  available = state.problem === "";
  if (state.busy && !busy) startedAt = Date.now();
  busy = state.busy;
  lines = state.lines;
  // "model at https://host/path" reads as "model · host"; the full address is in the tooltip.
  modelNote.textContent = state.problem || state.model.replace(/ at https?:\/\/([^/]+).*$/, " · $1");
  modelNote.title = state.problem || state.model;
  modelNote.classList.toggle("problem", state.problem !== "");
  history.innerHTML = '<option value="">' + (state.current ? "This chat" : "New chat") + "</option>" +
    state.chats.filter((chat) => chat.id !== state.current)
      .map((chat) => '<option value="' + escapeHtml(chat.id) + '">' + escapeHtml(chat.title) + "</option>").join("");
  history.hidden = state.chats.length === 0;
  renderControls();
  renderLog();
}

/* ----------------------------------------------------------- events ---- */

// The reply as it is written, passed on from the map's event stream (view.ts).
window.addEventListener("codespace:chat", (event) =>
{
  const chat = (event as CustomEvent<ChatEvent>).detail;
  if (chat.kind === "start") { busy = true; startedAt = Date.now(); doing = ""; renderControls(); }
  else if (chat.kind === "text")
  {
    doing = "Writing the reply";
    const last = lines[lines.length - 1];
    if (last && last.role === "assistant") last.text += chat.delta;
    else lines.push({ role: "assistant", text: chat.delta });
  }
  else if (chat.kind === "tool")
  {
    const line: ChatLine = { role: "tool", tool: chat.name, text: chat.detail };
    lines.push(line);
    doing = stepText(line, DOING);
  }
  else if (chat.kind === "tool-end")
  {
    if (chat.error)
    {
      const failed = [...lines].reverse().find((line) => line.role === "tool" && line.tool === chat.name);
      if (failed) failed.role = "error";
    }
    doing = "Thinking…";
  }
  else if (chat.kind === "end")
  {
    busy = false;
    doing = "";
    if (!visible()) unread = true;
    load();
    return;
  }
  else if (chat.kind === "changed") { load(); return; }
  renderStatus();
  renderLog();
});

form.addEventListener("submit", async (event) =>
{
  event.preventDefault();
  if (busy) { await post({ action: "stop" }); return; }
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  lines.push({ role: "user", text });
  busy = true;
  startedAt = Date.now();
  doing = "";
  renderControls();
  renderLog();
  if (!(await post({ action: "send", text }))) { busy = false; renderControls(); renderLog(); }
});

// Enter sends and Shift+Enter starts a new line; on a phone the keyboard's own key adds a line.
input.addEventListener("keydown", (event) =>
{
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing && !document.body.classList.contains("phone"))
  {
    event.preventDefault();
    form.requestSubmit();
  }
  else if (event.key === "Escape" && !document.body.classList.contains("phone")) setOpen(false);
});

// A starter fills the box rather than sending, so it can be edited first; a path leads to its file;
// "See it" on a phone closes the sheet so the map shows.
log.addEventListener("click", (event) =>
{
  const target = event.target as HTMLElement;
  const starter = target.closest(".starter");
  if (starter) { input.value = starter.textContent ?? ""; input.focus(); return; }
  const path = target.closest<HTMLElement>("code.path");
  if (path) { focusPath(path.dataset.path!); window.dispatchEvent(new Event("codespace:see-map")); return; }
  if (target.closest(".see")) window.dispatchEvent(new Event("codespace:see-map"));
});

newButton.addEventListener("click", () => { post({ action: "new" }); input.focus(); });
history.addEventListener("change", () => { if (history.value) post({ action: "open", id: history.value }); });

/** Opens or closes the chat panel on a computer. */
function setOpen(open: boolean): void
{
  panel.hidden = !open;
  button.classList.toggle("on", open);
  if (open) { unread = false; load(); input.focus(); }
  renderSignals();
}
button.addEventListener("click", () => setOpen(panel.hidden));
closeButton.addEventListener("click", () => setOpen(false));

// Another panel can open the chat, as Ingest Codebase does; on a phone mobile.ts opens its tab instead.
window.addEventListener("codespace:open-chat", () => { if (!document.body.classList.contains("phone")) setOpen(true); });

// On a phone the chat is a tab (mobile.ts); opening it reads the chat and clears the waiting dot.
window.addEventListener("codespace:pane", (event) =>
{
  if ((event as CustomEvent<string | null>).detail !== "chat") return;
  unread = false;
  load();
});

// Knowing early whether a reply is under way lets the button say so before the panel is opened.
load();
