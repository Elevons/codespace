# Codespace code-health review rubric

The standing, executable review rubric for a change set in this repo. Findings
come first; a fix phase follows only when requested.

Binding sources:

1. `README.md` — commands and repo rules.

Target: the **current working-tree state**, including any uncommitted change set.
Read-only by default: a review does not edit source and does not restart the
server unless the task says to fix.

**Solo-development note (binding).** This repo has one developer and one user. A
breaking change is expected and preferred over a compatibility shim. When a change
alters a stored shape, a route, or a rule, migrate the existing data in one pass
and delete the superseded code. Do **not** raise a finding that asks for backwards
compatibility, a legacy fallback, or a deprecation window. Grade "dead legacy
code" as a defect, not as safety.

---

## 0. Baseline automated checks (evidence)

Run each check on the tree under review and record its result. A failure here is
a finding, not a test to edit.

| Check | Command |
| --- | --- |
| Typecheck | `npm run typecheck` |
| Full tests | `npm test` |

---

## 1. Ground rules

1. **Read-only by default.** Do not edit unless the task says to fix.
2. **Evidence, not vibes.** Every finding cites `file:line` and shows the exact
   code, test, or probe output that proves it. Mark confidence.
3. **Verify before reporting.** Try to refute your own finding (grep for
   consumers, check tests). If an area is clean, say so.
4. **Follow the house rules.** A style finding names the guide rule it violates.
5. **Rank by impact on codebase health**, not ease of fix. Few high-signal
   findings over a wall of nits.
6. **Use the standard output schema** (section 4). No prose padding.

## 2. Separation calibration (core of the review)

The goal is **one owner per concept with the least indirection that achieves it**.
"Separation of concerns" is a means, not a goal.

**Over-separation signals (recommend compaction):**

- **Module earns its keep.** A file that is one constant, one type alias, or a
  one-line function has not earned a module — unless it is dependency-free and
  imported by 2+ layers (then it belongs in a `Constants.ts`-style module).
- **Rule of two.** A helper with one consumer lives beside that consumer. Extract
  only when a second real consumer appears.
- **One-method service.** A class with one method and one caller is a wrapper;
  inline it or fold it into the owner of its state.
- **Pass-through facade.** A method that forwards 1:1 and adds no validation,
  eventing, or naming value is indirection.
- **Misnamed "shared" layer.** `utils/`, `shared/`, `common/` where most files
  have one consumer.
- **Clone families.** N sibling classes differing only by constants → one
  data-driven table/factory.
- **Dead weight.** Unused exports/types/functions/fields/branches/params;
  write-only fields; producers with no consumer; unreachable branches.

**Under-separation signals (do NOT over-correct into these):**

- Two unrelated concepts sharing a file/class/state; a store doing orchestration;
  an orchestrator doing persistence.
- A **chokepoint** duplicated: network access or file access. A second path
  around a chokepoint is a defect, never a compaction.
- Dependency cycles: a layer reaching up or sideways into a peer's internals. Do
  not flatten a cycle-breaking seam.

**Reconcile with the style guide.** A *class* gets its own file; that does not
license a file per constant, type, or function. Do not split a cohesive class to
satisfy a mechanical rule.

## 3. Review dimensions (audit every one per area)

- **A. Compaction / over-separation** — name the exact merge.
- **B. Dead code** — unused exports/types/functions/fields/branches/params.
- **C. Duplication** — the same decision/logic/constant in 2+ places.
- **D. Ownership & SSOT** — who owns each field? Every copy derived and read-only?
- **E. Correctness & invariants** — ordering, races, error handling, boundaries,
  serialization round-trips.
- **F. Organization** — file placement, filename==class, folder boundaries,
  stale naming, barrels/type-only indirection.
- **G. Style** — see the style guide checklist.
- **H. Terminology & parity** — same verb/noun across surfaces.
- **I. Tests** — isolation (no real writes), determinism, coverage of risky and
  failure paths, duplicated test doubles.
- **J. Docs** — code/doc drift, missing surfaces, contradictory claims; read each
  `@param` and summary against the code beneath it and flag any that no longer say
  what the code does.
- **K. Tooling & AGENTS compliance** — typecheck/tests/build green.

## 4. Output schema (use exactly)

```
## <Area>
### <FINDING-ID> <P0|P1|P2|P3> <Compaction|DeadCode|Duplication|Correctness|Organization|Style|Tests|Docs|Tooling> — <one-line title>
- Location: path:line
- Evidence: <code excerpt or probe output>
- Why it matters: <impact on cleanliness/correctness>
- Fix: <concrete, minimal recommendation>
- Confidence: high|medium|low
```

Then a **Consolidation proposals** table:

```
| Action (merge|inline|delete|deexport|extract|move) | Files | Target/Outcome | Lines saved (est) |
```

Then an **Area scorecard** (A–F):

```
Compaction / Dead code / Duplication / Ownership / Correctness /
Organization / Style / Tests / Docs / Tooling
```

**Severity definitions:**

- **P0** — data loss, broken invariant, corruption in normal use.
- **P1** — systemic architecture flaw, silent corruption, a second path around a
  chokepoint, or a materially broken feature surface.
- **P2** — maintainability hazard: over-separation, dual ownership, dead branch,
  duplication, flaky/isolated tests.
- **P3** — naming, JSDoc, doc completeness, minor style.

## 5. Multi-pass triangulation

Run fresh agents over fixed area partitions. A finding seen in 2+ independent
passes is high confidence; a single-pass finding is a candidate to verify.
Deduplicate by primary `file:line` + category.

| Pass | Area | Scope |
| --- | --- | --- |
| A | Server & Repository | `src/repo/Repo.ts`, `src/server/Server.ts` |
| B | City & visualizer | `public/*.ts`, `public/index.html`, `public/style.css` |
| C | Tests | `tests/**` |
| D | Cross-cutting | whole-repo dead-code/duplication sweep |

## 6. Fix-phase addendum (only when instructed to fix)

1. **Work in batches by risk**, lowest first: (a) dead code and de-export,
   (b) micro-file merges, (c) shared-helper extraction, (d) factory/table
   consolidation, (e) handler/layer merges, (f) file deletions.
2. **One concept per commit-sized batch.** Keep the tree green after each:
   `npm run typecheck`, `npm test`.
3. **Prefer a breaking change over a shim** (solo-development note). Do not leave
   a legacy fallback, a dual-read path, or a deprecation branch.
4. **Report** each batch: files merged/deleted, lines removed, tests run, and any
   finding you deliberately declined because it crossed a boundary.
5. **End with a plain-English TLDR** — no file names, no type names, no jargon,
   short sentences: what was wrong, what changed, what is still open.
