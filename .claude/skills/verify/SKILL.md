---
name: verify
description: Build, launch, and drive Philomatic end-to-end (ingest server + workbench, registry, or the extension) to verify a change at its real surface.
---

# Verify Philomatic end-to-end

Philomatic is two servers plus a workbench. Verifying a change means driving the real
surface — not only the unit suite. Pick the right harness:

- **Engine/API change** → curl the ingest server's JSON contract.
- **Workbench change** → Playwright against the BUILT `ui/dist` (rebuild first — smokes and
  manual drives both serve the build, and a stale build makes fresh code look broken).
- **Hosted/community/publish flow** → the one-origin fixture (`test/ui-smoke/one-origin.ts`)
  and the persona harness (`test/ui-smoke/lifecycle.ts`) already build the deploy shape:
  prefer writing/running a smoke over hand-rolling servers.

## Build + launch (single-tenant workbench)

```bash
pnpm install               # workspace: root engine + ui/
pnpm ui:build              # tsc + vite → ui/dist (GET / serves this)
PORT=$((30000 + RANDOM % 20000))   # ALWAYS an ephemeral port — see gotcha below
pnpm serve -- --db /tmp/claude-*/…/verify.sqlite --port $PORT
```

Seed like a tester (captures are the primary writes):

```bash
curl -s -X POST :$PORT/ingest  -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/x","title":"X","tags":["#ml"],"track":"T"}'
curl -s -X POST :$PORT/snippet -H 'Content-Type: application/json' \
  -d '{"url":"https://example.com/x","text":"…","clarifies":["Concept"],"raises":["Q?"]}'
```

## Drive the surfaces

- **HTTP:** `GET /snapshot`, `/assemble`, `/questions`, `/relations?id=…`, `/removed`;
  `POST /ask|/answer` (`{"question": …}`), `/remove|/restore|/update`, `/publish`, `/import`.
  Probe wrong-method / missing-field / unknown-ref — errors must come back as 400 JSON,
  never a stack.
- **Workbench (pixels):** Playwright Chromium against `http://127.0.0.1:$PORT/`. The smoke
  harness (`test/ui-smoke/harness.ts`) already finds a chromium and exports helpers
  (`openInLibrary`, edit-mode togglers) — copy its patterns. Landmarks: `.topbar` (loaded),
  tabs `.tab` (Library/Inbox/Journey/Map), rail `.rail`, unified list `.item`, detail pane
  `.pane.detail`, track reading rows `.rail-topic-source`, toasts `.toast`, storage chooser
  `.storage-choice`, settings `.settings-panel`.
- Assert the isolation guarantee where relevant: `page.on('request')` → zero requests off
  `127.0.0.1:$PORT`.

## Hosted / registry / community flows

Don't hand-roll: `oneOriginStack()` boots registry + hosted instance behind one origin with a
fake OAuth provider, and `cast(stack, { prof: 'Prof' })` mints signed-in personas with
provisioned libraries and API verbs (ingest / publishAndPush / join / pull / contribute …).
`openWorkbench(stack, persona)` hands you a signed-in page. See any `test/ui-smoke/lifecycle-*`
test for the idiom; run them with `npx vitest run test/ui-smoke/<file>`.

## The extension (capture client)

`pnpm build:extension` → `dist-extension/` (Chrome) and `dist-extension-firefox/`. It is a thin
HTTP client of the ingest server — no embedded engine — so most logic verifies through the
server API; load it in a real browser only for popup/context-menu UX. Chrome: full Chromium via
`launchPersistentContext(profile, { channel: 'chromium', args: ['--load-extension=<abs>',
'--disable-extensions-except=<abs>'] })` (headless-shell can't do extensions). Point it at the
server in the options page first. `pnpm package:extension` zips both browsers into `dist/`.

## Gotchas

- **Never reuse a fixed port.** This devcontainer (Podman + VSCode forwarding) leaks listeners:
  a killed server can leave the port LISTENING with no killable PID. Fresh random port per run.
- **tsx servers do not hot-reload.** Kill and restart after edits; check for stale processes
  before blaming a change.
- `pkill -f <pattern>` matching your own command line kills your own script — bracket the
  pattern: `pkill -f '[s]rc/server/ingest.ts'`.
- The DB persists learner state; rerunning a drive script against the same `--db` sees earlier
  asks/answers. Fresh DB (and fresh temp dir) per run.
- Binding non-loopback without `--token` is refused by design — use loopback for verification.
