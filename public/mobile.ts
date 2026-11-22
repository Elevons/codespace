// The phone layout. A narrow screen gives the map the whole screen and puts the panels behind a tab
// bar along the bottom: Files (the outliner's search and tree), Filters (the system and layer tiles,
// the tag filter, and the view options), Details (what is chosen), Insights (start here, recent changes,
// flows, and health), Chat (the built-in agent), and View (the map's controls).
// One sheet holds whichever tab is open. The panels are moved into it, not copied, so every handler
// and every render keeps working on the same elements; leaving the narrow layout puts them back.
import { S, filePath, fileColor, hasFilters } from "./state.js";
import { labelFor } from "./rules.js";
import { select } from "./panels.js";

/** The tabs that open a sheet; Map closes it. */
type Pane = "files" | "filters" | "details" | "insight" | "chat" | "view";

const narrow = window.matchMedia("(max-width: 720px)");

// What each sheet holds, by element id, in the order it is moved in.
const PANES: Record<Pane, string[]> = {
  files: ["outliner"],
  filters: ["outliner-filters", "outliner-chips", "outliner-options", "outliner-bulk"],
  details: ["showing", "info"],
  insight: ["insight"],
  chat: ["chat-panel"],
  view: ["tools", "controls"],
};
const TITLES: Record<Pane, string> = { files: "Files", filters: "Filters", details: "Details", insight: "Insights", chat: "Chat", view: "View" };

const sheet = document.getElementById("msheet") as HTMLElement;
const sheetTitle = document.getElementById("msheet-title") as HTMLElement;
const tabs = document.getElementById("mtabs") as HTMLElement;
const peek = document.getElementById("mpeek") as HTMLElement;
const search = document.getElementById("search") as HTMLInputElement;

/** Where each moved element came from, so it can be put back exactly; restored last-moved first. */
const homes: Array<{ element: HTMLElement; parent: Node; next: Node | null }> = [];

let open: Pane | null = null;

// Moves every panel into its sheet pane, recording where each one lived.
function enterPhone(): void
{
  if (homes.length > 0) return;
  for (const pane of Object.keys(PANES) as Pane[])
  {
    const target = document.getElementById("mpane-" + pane)!;
    for (const id of PANES[pane])
    {
      const element = document.getElementById(id);
      if (!element || !element.parentNode) continue;
      homes.push({ element, parent: element.parentNode, next: element.nextSibling });
      target.append(element);
    }
  }
  document.body.classList.add("phone");
  syncChrome();
}

// Puts every panel back where the desktop layout expects it.
function leavePhone(): void
{
  setPane(null);
  while (homes.length > 0)
  {
    const { element, parent, next } = homes.pop()!;
    parent.insertBefore(element, next && next.parentNode === parent ? next : null);
  }
  document.body.classList.remove("phone");
}

/** Opens one sheet, or closes the sheet with null (the Map tab). */
function setPane(pane: Pane | null): void
{
  open = pane;
  sheet.hidden = pane === null;
  sheet.dataset.pane = pane ?? "";
  sheet.classList.remove("full");
  sheet.style.transform = "";
  if (pane !== null) sheetTitle.textContent = TITLES[pane];
  tabs.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((tab) =>
  {
    tab.setAttribute("aria-pressed", String((tab.dataset.tab === "map" && pane === null) || tab.dataset.tab === pane));
  });
  // The options strip is a pop-out on the desktop; in the Filters sheet it is simply shown.
  syncChrome();
  window.dispatchEvent(new CustomEvent("codespace:pane", { detail: pane }));
}

tabs.addEventListener("click", (event) =>
{
  const tab = (event.target as HTMLElement).closest("[data-tab]") as HTMLElement | null;
  if (!tab) return;
  const pane = tab.dataset.tab === "map" ? null : tab.dataset.tab as Pane;
  // A second tap on the open tab closes it again, back to the map.
  setPane(pane === open ? null : pane);
});
document.getElementById("msheet-close")!.addEventListener("click", () => setPane(null));

// A choice made in the outliner closes the sheet, so the map can glide to it.
window.addEventListener("codespace:chosen", () => { if (narrow.matches && open === "files") setPane(null); });

// A button that opens the Insights panel brings its own sheet up on a phone.
window.addEventListener("codespace:open-insight", () => { if (narrow.matches && open !== "insight") setPane("insight"); });

// Another panel can open the chat, as Ingest Codebase does.
window.addEventListener("codespace:open-chat", () => { if (narrow.matches) setPane("chat"); });

// The chat's "See it" and its file links close the sheet, so the map shows what was drawn.
window.addEventListener("codespace:see-map", () => { if (narrow.matches && open !== null) setPane(null); });

// While the search box or the chat's box has the keyboard up, the sheet takes the whole screen so
// the box and what it is about stay above the keyboard.
for (const box of [search, document.getElementById("chat-input")!])
{
  box.addEventListener("focus", () => { if (narrow.matches) sheet.classList.add("full"); });
  box.addEventListener("blur", () => sheet.classList.remove("full"));
}

// Escape (a hardware keyboard on a tablet) closes the sheet before anything else.
document.addEventListener("keydown", (event) =>
{
  if (event.key === "Escape" && narrow.matches && open !== null && !(event.target as HTMLElement).closest?.("input, textarea"))
  {
    setPane(null);
    event.stopImmediatePropagation();
  }
}, true);

// Dragging the sheet's header down past a threshold closes it, as a phone's own sheets do.
const head = document.getElementById("msheet-head") as HTMLElement;
let dragFrom: number | null = null;
head.addEventListener("pointerdown", (event) =>
{
  if ((event.target as HTMLElement).closest("button")) return;
  dragFrom = event.clientY;
  head.setPointerCapture(event.pointerId);
});
head.addEventListener("pointermove", (event) =>
{
  if (dragFrom === null) return;
  const down = Math.max(0, event.clientY - dragFrom);
  sheet.style.transform = down > 0 ? "translateY(" + down + "px)" : "";
});
function endDrag(event: PointerEvent): void
{
  if (dragFrom === null) return;
  const down = event.clientY - dragFrom;
  dragFrom = null;
  if (down > 90) setPane(null);
  else sheet.style.transform = "";
}
head.addEventListener("pointerup", endDrag);
head.addEventListener("pointercancel", endDrag);

/* ------------------------------------------------- peek and badges ---- */

// The chosen file or folder, as a strip above the tabs while the map is showing, so a tap on a
// block says what it is without covering the map; tapping the strip opens Details.
function syncPeek(): void
{
  const chosen = S.selected >= 0 && S.NODES[S.selected];
  peek.hidden = !narrow.matches || open !== null || !chosen;
  if (!chosen) return;
  const name = document.getElementById("mpeek-name")!, sub = document.getElementById("mpeek-sub")!;
  const dot = document.getElementById("mpeek-dot")!;
  if (S.selectedFile >= 0)
  {
    const path = filePath(S.selected, S.selectedFile);
    name.textContent = path.split("/").pop()!;
    sub.textContent = S.FILE_SUMMARIES.get(path) ?? path;
    dot.style.background = fileColor(path);
  }
  else
  {
    const node = S.NODES[S.selected];
    name.textContent = node.id === "" ? "(root)" : node.id + "/";
    sub.textContent = S.FILE_SUMMARIES.get(node.id) ?? labelFor(node.layer) + " · " + node.files.length + " files";
    dot.style.background = "#8b949e";
  }
}
document.getElementById("mpeek-open")!.addEventListener("click", () => setPane("details"));
document.getElementById("mpeek-clear")!.addEventListener("click", () => select(-1));

// The Filters tab counts the filters in force, and Details carries a dot while something is chosen.
function syncBadges(): void
{
  const count = S.outliner.systems.size + S.outliner.layers.size + (S.tagFilter !== null ? 1 : 0) + (S.isolatedFiles !== null ? 1 : 0);
  const filters = tabs.querySelector<HTMLElement>('[data-tab="filters"] .mbadge')!;
  filters.hidden = !hasFilters();
  filters.textContent = String(count);
  tabs.querySelector<HTMLElement>('[data-tab="details"] .mbadge')!.hidden = S.selected < 0;
}

function syncChrome(): void
{
  syncPeek();
  syncBadges();
  // The Files sheet's title carries the outliner's count, since the outliner's own title is hidden there.
  if (open === "files") sheetTitle.textContent = "Files  " + (document.getElementById("outliner-count")?.textContent ?? "");
}

// The panels redraw their own contents; watching them is how this module hears that the choice or
// the filters moved, without the rest of the page having to call it.
const watch = new MutationObserver(() => { if (narrow.matches) syncChrome(); });
for (const id of ["info", "outliner-filters", "outliner-chips"])
{
  const element = document.getElementById(id);
  if (element) watch.observe(element, { childList: true, subtree: false });
}

// The sheet and the strip sit above the tab bar by its measured height.
new ResizeObserver(() => document.documentElement.style.setProperty("--tabs-h", tabs.offsetHeight + "px")).observe(tabs);

function apply(): void
{
  if (narrow.matches) enterPhone();
  else leavePhone();
}
narrow.addEventListener("change", apply);
apply();

