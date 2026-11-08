/**
 * The shape a tool asks the map to show, shared by the server that streams it and the page that
 * draws it, so a field rename cannot drift across the wire. Pure types, no scene and no DOM.
 */

/** One file the map is showing, with what to say about it. */
export interface IShownFile
{
    /** The repository-relative path. */
    path: string
    /** What to say about this file, or empty. */
    note: string
}

/** What a tool has asked the map to show. */
export interface IShown
{
    /** The files, in order. */
    files: IShownFile[]
    /** Whether to draw a route through them in that order, as a code path. */
    trace: boolean
    /** A heading for what is shown, or empty. */
    title: string
    /** A short explanation of what is shown, or empty. */
    note: string
}
