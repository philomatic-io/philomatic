# Contributing to Philomatic

## Comment style

Comments in this codebase are documentation, not a diary. The test for every comment:
**would a stranger maintaining this file need this sentence?** History fails that test;
invariants pass it.

**Never:**

- Dates, or citations of planning documents (roadmaps, retired plans, section references,
  and bare decision/step IDs like `D11.1` or `T-S2` — name the concept instead).
- Author attributions ("per X's request", decision credits).
- TODO/DONE notes — deferred work belongs in the issue tracker, not the margins.
- Commentary on past or present bugs and features ("this used to break when…",
  "caught by the follow suite", "added in the redesign").

**Always:**

- Short and current — a comment updates with the code it describes, or it goes.
- Explain only what the code cannot say: the WHY of tricky logic, invariants, constraints,
  the reason a simpler-looking alternative is wrong.
- Never narrate what the code already shows.

**TSDoc** on exported functions, types, and modules: `/** … */` with a one-line summary;
`@param`/`@returns` only where the names don't already carry it. Internal helpers get a
plain `//` only when non-obvious.

**Deliberate twins:** where the engine/UI boundary forbids a shared module, a copy may cite
its twin **by path** ("Deliberate twin: ui/src/…") — a live pointer, not history. These are
the one sanctioned cross-reference.

`pnpm comments:report` lists every violation by file — it is the sweep's work queue and,
in CI, the tripwire that keeps the codebase swept.
