# Philomatic — working notes for coding agents

Orientation for a fresh context: what the pieces are, the rules that are easy to break, and
the checks that must stay green. Contributor-facing standards live in CONTRIBUTING.md — read
it before writing code or comments.

## Layout

- `src/engine` — the graph engine (SQLite; runs in node AND compiled to WASM in the browser).
  Programmatic writes go through `engine.captureSource`/`captureSnippet` (versioned Zod
  schemas in `src/engine/capture.ts`), reads through `snapshot()` and the views in
  `src/engine/read.ts`.
- `src/server/ingest.ts` — the personal instance server (one library, capture + workbench API).
- `src/registry/server.ts` — the commons server (accounts, published tracks, communities).
  `src/registry` may import `src/server`; never the reverse.
- `ui/src` — the workbench (React + Vite). Two backends behind one `EngineClient` interface:
  HTTP transport (`ui/src/client/transport.ts`) and in-browser engine (`ui/src/client/local.ts`,
  booted by `ui/src/boot/local-backend.ts`).
- `src/extension` — the browser capture extension, a thin client of the instance server.
- `test/` — vitest; `test/ui-smoke/` drives real servers (and Playwright where the assertion is
  about the UI). `test/ui-smoke/lifecycle.ts` is the persona harness for shared-track stories.
- Docs of record: `DATA_MODEL.md` (the model), `docs/OPERATIONS.md` (deploy shape, routing,
  env vars), `PHILOSOPHY.md`, `CONTRIBUTING.md`.

## Rules that are easy to break

- **The lock line**: no shared module across `src/` and `ui/`. Where the two sides must agree
  on a wire shape, each keeps its own copy annotated `Deliberate twin: <path>` — and
  `test/drift-twins.test.ts` pins the pairs. Extract shared logic *within* a side, never
  across the line.
- **Engine parity**: the two clients (HTTP and in-browser) drift wherever behavior lives in a
  client instead of the engine. Extract into the engine, don't mirror; land contract-test
  cases in the same change.
- **Comment style of record** (CONTRIBUTING.md): comments state the current WHY, nothing else.
  Never dates, author/owner attributions, planning-doc or decision-ID citations (`D11`,
  `T-S2`, `§`…), or TODOs. `pnpm comments:report` must stay at zero — it runs in `--check`
  mode as a tripwire.
- **Observations vs views**: the base stores observations; learnings/arrangements are derived
  views. Don't add stored state for something a view can compute.
- Secrets live in the environment, never in config files. Keys, tokens, and registry data dirs
  are gitignored — keep them that way.

## Git

- Never commit to `main` directly (a pre-commit hook enforces this). Branch first; merge to
  `main` only with the owner's explicit OK; delete the branch in the same step (`git branch -d`).
- Do not push anywhere unless asked.

## Checks (all must pass before a merge)

```
npx tsc --noEmit -p .          # engine/servers
npx tsc --noEmit -p ui         # workbench
pnpm test                      # root suite
npx vitest run test/ui-smoke   # deploy-shape smokes (needs a chromium; slower)
npx eslint .                   # react-hooks rules + max-lines warnings
pnpm comments:report           # must report zero
pnpm ui:build                  # smokes drive the BUILT ui — rebuild before running them
```

## Gotchas

- `tsx` servers do not hot-reload. Kill and restart after edits, and check for stale
  processes before blaming a change.
- Use ephemeral ports (`listen(0)`) for any test/smoke server. In the dev container, leaked
  fixed ports look held by an unkillable PID.
- Playwright smokes assert against `ui/dist` — a stale build makes fresh code look broken.
