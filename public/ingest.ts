/** What the server answers for the ingest status: the counts, the second pass, and the copied prompt. */
export interface IIngestStatus
{
  /** Files that still need a summary. */
  files: number;
  /** Files whose entry is missing a system, a layer, or tags. */
  incomplete: number;
  /** Folders that still need a summary. */
  folders: number;
  /** All of them together. */
  remaining: number;
  /** Described files whose text has changed since their entry was written. */
  changed: number;
  /** Entries for files and folders that are gone. */
  stale: number;
  /** How many files already have a description, so the button can say whether this is a first ingest or an update. */
  described: number;
  /** What the second pass still finds: layer breaks and anything else worth a look. */
  refine: { remaining: number; breaks: number };
  /** The design pass: whether operations are written at all, and what still lacks
   * steps, inputs and outputs, or the layer a data entry is held on. */
  concepts: { started: boolean; operations: number; data: number; unplaced: number };
  /** The prompt handed to an agent, as the server words it. */
  prompt: string;
}
