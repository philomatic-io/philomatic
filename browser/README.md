# Browser capture — Stage 0 (bookmarklet + ingest service)

The shortest line to *"I clicked a button and my graph remembered this source."*
See the Browser Ingestion section of `../MVP.md` for the full plan (Stage 0 → extension → PWA).

## Run the loop

```bash
pnpm serve                       # http://127.0.0.1:4321, db: .philomatic/philomatic.sqlite
pnpm serve -- --db my.sqlite --port 4321
pnpm serve -- --token secret     # require X-Ingest-Token on writes
```

Then open [`install.html`](./install.html) and drag the **📚 Remember** button to your bookmarks
bar. Click it on any page — a toast confirms the capture. **Highlight text first** and the same
click also saves the selection as a snippet against that source.

Review what you've captured — open **`http://127.0.0.1:4321/`** in a browser tab. That page is
the **React viewer** (`../ui/`, alpha UI plan) — still a pure client of the JSON read contract,
served as static files from `ui/dist` (build it once with `pnpm ui:build`; iterate hot with
`pnpm ui:dev`). The old static `view.html` retired with the React viewer — git history has it.
Or read the same data from the CLI against the same database:

```bash
pnpm philomatic list sources
pnpm philomatic list snippets
pnpm philomatic list events
```

## The API (stable across Stage 0 and the Stage-1 extension)

| Route | Body | Effect |
|---|---|---|
| `GET /health` | — | `{ ok: true }` |
| `POST /ingest` | `{ url, title?, author?, tags?, modality?, syllabus?, stage? }` | build a sugared source → `importPayload`; stage (default `true`) records a `STAGED` edge + event; `syllabus` files it via `INCLUDES`. Returns `{ sourceId, created, staged }` |
| `POST /snippet` | `{ url \| sourceId, text, note?, sentiment?, clarifies?, contradicts? }` | capture a highlighted passage as a `Snippet` owned by its source; optional concept anchors (`CLARIFIES`/`CONTRADICTS`) and a learner `ANNOTATES` note/sentiment. Returns `{ snippetId, sourceId, created, annotated }` |
| `GET /` | — | the built React viewer (`ui/dist`) — open it in a browser tab |
| `GET /snapshot` | — | the whole versioned read envelope (syllabi + sources + snippets) as JSON |
| `GET /syllabi` | — | captured syllabi with their member source ids as JSON |
| `GET /sources` | — | captured sources (with tags) as JSON |
| `GET /snippets` | — | captured snippets (joined to source title, note/sentiment, concept anchors, tags) as JSON |

- **Idempotent by URL.** `sourceId` is derived from the canonical URL, so re-sending a page is a
  no-op (`created:false`) — "remember" is dedup for free. Tracking params (`utm_*`, `fbclid`, …)
  are stripped before hashing.
- **Modality is inferred** from the host/extension (`youtube|vimeo → video`, `*.mp3 → audio`,
  default `text`); override with `modality` in the body.
- **Thin shell.** The server maps HTTP → an engine method and formats the response; all id
  derivation, validation, and upsert stay in the pure core (`ARCHITECTURE.md` §5).

## Known Stage-0 limit

The bookmarklet's `fetch` runs in the **visited page's origin**, so a page with a strict
`Content-Security-Policy` can block the request to localhost. Works on the large majority of
pages; the Stage-1 extension (not bound by page CSP) is the robust path.

## Files

- `bookmarklet.js` — readable source; edit `PORT`/`TOKEN` and re-minify into `install.html`.
- `install.html` — draggable minified bookmarklet + instructions.
- The capture viewer lives in [`../ui/`](../ui) (React; served at `GET /` from `ui/dist`). The
  old `view.html` static client retired 2026-07 — git history has it.
