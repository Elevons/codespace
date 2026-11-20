/**
 * The health check's answer, shared by the server that builds it and the page that shows it, so a
 * field rename cannot drift across the wire. Pure types, no I/O.
 */

/** One layer break as the report names it: how many imports go up, and a pair to look at. */
export interface IBreakGroup
{
    /** The lower layer, the one doing the importing. */
    from: string
    /** The higher layer, the one being imported. */
    to: string
    /** How many imports go this way. */
    count: number
    /** How many imports between the same two layers point the right way, for scale. */
    ordinary: number
    /** Files that show the break: the importing file and the imported one, as one step each. */
    examples: Array<{ from: string, to: string }>
}

/** One file past the size worth noticing, with its line count. */
export interface IOversized
{
    path: string
    lines: number
}

/** One value that looks like a key, found in a file that can reach a browser. */
export interface ISecretFinding
{
    path: string
    /** The line it sits on, counting from 1. */
    line: number
    /** The name it is given, such as `analyticsKey`. */
    key: string
    /** The value, cut short: enough to recognise it, never enough to use it. */
    hint: string
}

/** What the map's health check finds, before the browser-readable files are scanned for keys. */
export interface IHealthReport
{
    /** Every file the map knows. */
    files: number
    /** The files it reads as code. */
    codeFiles: number
    /** Their lines together. */
    lines: number
    /** Every import between two files. */
    imports: number
    /** Files with a summary in the architecture file. */
    described: number
    /** Files still without one, not counting generated or vendored files. */
    undescribed: number
    /** A few of those files, so the report can point at them. */
    undescribedPaths: string[]
    /** Imports that go up the layers. */
    layerBreaks: number
    /** The worst of those breaks, by pair of layers. */
    breakGroups: IBreakGroup[]
    /** The largest files, most lines first. */
    oversized: IOversized[]
    /** Problems with the layers and systems as a whole, each a sentence. */
    issues: string[]
    /** What the numbers do and do not prove, in a sentence each. */
    notes: string[]
}

/** What `GET /api/health` answers: the report, plus the scan of files a browser can read. */
export interface IHealthAnswer extends IHealthReport
{
    /** Values that look like keys in files a browser can read. */
    secrets: ISecretFinding[]
    /** How many source files the scan read before it stopped. */
    scanned: number
}
