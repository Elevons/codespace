// Where the page reaches the server. Every address is relative to the page, so the map still works when a
// proxy serves it under a path of its own, and carries the page's own ?repo=, so a page opened on one
// repository keeps reading that one whatever the server's own repository is.

/** The repository this page reads, from ?repo= in its own address, or null for the server's own. */
export const pinnedRepo: string | null = new URLSearchParams(location.search).get("repo") || null;

/**
 * The address of one endpoint, relative to the page.
 * @param path the endpoint under api/, such as "bootstrap" or "view/events"
 * @param query the query values to send, besides the page's ?repo=
 */
export function api(path: string, query: Record<string, string> = {}): string
{
  const params = new URLSearchParams(query);
  if (pinnedRepo !== null) params.set("repo", pinnedRepo);
  const text = params.toString();
  return "api/" + path + (text === "" ? "" : "?" + text);
}
