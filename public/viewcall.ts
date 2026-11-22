// One way for the page's own buttons to change the view. A view call normally goes to the server, so
// every open page follows it. A host that serves the map read only, such as Bartleby's framed board,
// refuses that write, so the change is then made in this page alone instead of being lost.

import { api } from "./endpoint.js";
import type { IShown } from "./shown.js";

/** A change to the view, in the shape the view stream sends it. */
export type ViewChange =
  | { type: "show"; shown: IShown }
  | { type: "isolate"; files: string[] | null }
  | { type: "select"; files: string[] | null }
  | { type: "clear" };

/** The event the view listens for to make a change in this page only. */
export const LocalViewEvent = "codespace:view";

/** Whether the server refused a view write, so later calls go straight to this page. */
let readOnly = false;

/** Whether the last view write was refused, so the page knows it cannot save or share. */
export function viewIsReadOnly(): boolean
{
  return readOnly;
}

/** The request body the server's view endpoint takes for a change. */
function body(change: ViewChange): Record<string, unknown>
{
  if (change.type === "show") return { action: "show", ...change.shown };
  if (change.type === "clear") return { action: "clear" };
  return { action: change.type, files: change.files ?? [] };
}

/**
 * Changes the view for every page through the server, or for this page alone when the server
 * refuses the write.
 * @param change what to show, isolate, select, or clear
 */
export async function changeView(change: ViewChange): Promise<void>
{
  // On a phone the button sits in a sheet over the map, so put the sheet away to show the change.
  window.dispatchEvent(new Event("codespace:see-map"));
  // The server cannot take an empty selection, so clearing one is always this page's own change.
  const local = readOnly || (change.type === "select" && (change.files ?? []).length === 0);
  if (!local)
  {
    try
    {
      const response = await fetch(api("view"), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body(change)) });
      if (response.ok) return;
      // A refused write means the map is read only here; anything else is a fault in the call.
      if (response.status !== 403 && response.status !== 404 && response.status !== 405) return;
      readOnly = true;
    }
    catch
    {
      readOnly = true;
    }
  }
  window.dispatchEvent(new CustomEvent(LocalViewEvent, { detail: change }));
}
