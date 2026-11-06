# Future ideas

Living notes on things deliberately deferred. Each entry is written so it can be picked up
later without re-deriving the constraints. Nothing here is committed scope; it is a design
sketch, not a spec.

## Show every file, not just known text types

The goal is to see an entire repository's structure on the map. Today `Repo.ts` lists only
files with an extension in `TextExtensions`. Checked against this repository, only
`.gitignore` is missing (it has no extension), but a typical repository would also lose
images, `Dockerfile`, `Makefile`, `LICENSE`, and anything with an unknown extension.
`.git` and whatever the repository's own `.gitignore` excludes stay out on purpose.

How it could work:

- List every file that is not ignored, whatever its type, in `Repo.ListFilesAsync`.
- Keep reading restricted to text. `IsAllowed` and `ReadFileAsync` should still refuse
  anything outside `TextExtensions`, because the source API serves what they allow.
- The page already treats a file it cannot read as a plain box: `CODE_FILE` in `state.js`
  decides what is fetched for line counts and imports, so other files need no special case.
- Decide how a non-text file looks. A fixed low height and a neutral colour would do, since
  there is no line count to size it by.

Constraints to settle first:

- An asset-heavy folder (thousands of images) would flood the map with boxes. Options: cap a
  folder's boxes and show "+N more", collapse a folder past a threshold, or let those
  folders be hidden by default like the other extras.
- `tests/Repo.test.ts` asserts that only readable files are listed; it would change with
  this, and a new test should pin that unreadable files are listed but still refused by
  `ReadFileAsync`.
- Symlinks: today a link is not listed (`Dirent.isFile()` is false for it). Decide whether a
  link to a file shows, and keep refusing to follow one out of the repository.
