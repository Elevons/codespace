/**
 * A saved view of the map, shared by the server that keeps it and the page that draws it, so a
 * field rename cannot drift across the wire. Pure types and limits, no I/O.
 */

/** The most flows one repository may save. */
export const MaxFlows = 50

/** The longest name a flow may have, in characters. */
export const MaxFlowName = 40

/** One step of a flow: a file, and what happens there. */
export interface IFlowStep
{
    /** The repository-relative path. */
    path: string
    /** What happens at this step, or empty. */
    note: string
}

/** A saved view of the map: files in an order, with notes, shown again on demand. */
export interface IFlow
{
    /** The name the flow is saved under, and the name a tool uses to show it. */
    name: string
    /** The heading the map shows above the steps. */
    title: string
    /** One or two sentences on the whole flow. */
    note: string
    /** Whether the steps are a numbered route, rather than a set of highlighted files. */
    trace: boolean
    /** The steps, in order. A file may appear more than once, each time with its own note. */
    files: IFlowStep[]
}
