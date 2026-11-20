/**
 * The files around one file, shared by the server that walks the import graph and the page that
 * asks for a neighbourhood, so the depth rule cannot drift. Pure types and rules, no I/O.
 */

/** The most steps out a caller may ask for, from the chosen file. */
export const MaxNeighbourDepth = 2

/** The depth a caller gets when it does not ask for one. */
export const DefaultNeighbourDepth = 1

/** The most files one neighbourhood may name, so a hub file cannot return the whole repository. */
export const MaxNeighbourhood = 200

/** One file at its distance from the chosen file, as the neighbourhood answers it. */
export interface INeighbour
{
    /** The repository-relative path. */
    path: string
    /** How many imports away it is; the chosen file itself is 0. */
    depth: number
}

/**
 * The depth a request may ask for, as a whole number between 1 and `MaxNeighbourDepth`.
 * @param asked what the caller sent: a number, a numeric string, or anything else
 */
export function ClampNeighbourDepth(asked: unknown): number
{
    const depth = Math.floor(Number(asked))
    return Number.isFinite(depth) ? Math.max(1, Math.min(MaxNeighbourDepth, depth)) : DefaultNeighbourDepth
}
