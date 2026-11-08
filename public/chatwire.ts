/**
 * The shapes the chat's event stream and state use, shared by the server that sends them and the
 * page that shows them, so a field rename cannot drift across the wire. Pure types, no DOM.
 */

/** One line of a chat, as the page shows it. */
export interface IChatLine
{
    /** Who it is from: the person, the model, a tool the model ran, or a failure. */
    role: 'user' | 'assistant' | 'tool' | 'error'
    /** What it says. For a tool, a short account of what it was asked. */
    text: string
    /** The tool's name, for a tool line. */
    tool?: string
}

/** One past chat in the list. */
export interface IChatSummary
{
    /** The chat's id, for reopening it. */
    id: string
    /** Its first message, shortened. */
    title: string
    /** When it last changed, as an ISO date. */
    updated: string
}

/** Something the page is told while a reply is under way. */
export type ChatEvent =
    | { kind: 'start' }
    | { kind: 'text', delta: string }
    | { kind: 'tool', name: string, detail: string }
    | { kind: 'tool-end', name: string, error: boolean }
    | { kind: 'end', error?: string }
    | { kind: 'changed' }

/** What the page shows of the chat. */
export interface IChatState
{
    /** The model, as `model at endpoint`. */
    model: string
    /** Why the chat cannot run, or empty when it can. */
    problem: string
    /** Whether a reply is under way. */
    busy: boolean
    /** The open chat's id, or empty before the first message. */
    current: string
    /** The open chat, line by line. */
    lines: IChatLine[]
    /** The repository's past chats, newest first. */
    chats: IChatSummary[]
}
