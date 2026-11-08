/**
 * The one ordered tag vocabulary, shared by the browser and the server. The describe guide lists
 * these in order; the map colours by the first tag and falls back to grey for anything else.
 */
export const TAG_VOCABULARY = ["entry", "orchestrate", "core", "data", "io", "ui", "config", "test"] as const;

/** One tag in the vocabulary. */
export type Tag = typeof TAG_VOCABULARY[number];

/** The colour for each tag, keyed by the vocabulary so a missing or extra tag fails to compile. */
export const TAG_COLORS: Record<Tag, string> = {
  entry: "#f0883e", orchestrate: "#d2a8ff", core: "#58a6ff", data: "#7ee787",
  io: "#ff7b72", ui: "#39d2c0", config: "#8b949e", test: "#e3b341",
};
