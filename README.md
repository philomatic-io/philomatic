# Philomatic

A self-hosted **personal learning graph** — for people who learn from the open web and keep
losing the thread. One small server owns the data; every surface — the web workbench, the
browser extension, the Obsidian plugin — is a live client of the same versioned read/write
contract.

**The problems it goes after.** If you learn seriously outside a classroom, you know them:
bookmarks pile up into a graveyard nothing ever comes back out of; highlights and notes end up
scattered across apps with no connection to each other; you can't see what a saved article was
*for* — which idea it explains, which question it answered; you have no map of what you've
covered versus what's still open; and a "learning plan" lives in your head, where it quietly
falls apart. Philomatic's bet is that a little **structure** fixes this: everything you save is
connected — to the ideas it explains, the questions it raised, the path it belongs to — so your
library becomes a map of your learning instead of a pile. And while building a personal
learning graph helps you chart and retrace your own educational journey, sharing it takes the
isolation — and the wasted effort — out of learning, giving others a path they can follow,
fork, and make their own.

**[Try the live demo →](https://philomatic.io/demo)** — the full engine compiled to
WebAssembly, running and persisting entirely in your browser; nothing you do there leaves your
machine, and no install is required.

## The model, in four words

- **Source** — anything you learn from: an article, video, paper, book chapter. Identified by
  its URL, so saving the same page twice never duplicates it.
- **Snippet** — a passage you highlighted in a source (markdown, math, and images survive
  capture), with your note and a sentiment. The atom of "this exact bit mattered."
- **Concept** — an idea you're learning (*Backpropagation*, *p-values*). Sources are *about*
  concepts; concepts tie to each other (prerequisite, subfield, analogy).
- **Track** — an ordered path of sources toward a goal, with prerequisites: read this before
  that, these two together. Tracks are the unit you **publish** and others **fork**.

Questions tie it together: whatever a page made you wonder is captured as an open question,
linked to what raised it — and later to what answered it. Progress in Philomatic is questions
answered, not checkboxes ticked.

## The bigger idea

A track is more than a private reading list — it's a **shareable unit of learning**, the way a
repository is a shareable unit of code. Philomatic already treats it that way: publish a track
and it becomes a signed, self-contained, openly-licensed artifact; push it to a **registry**
and it joins a public library; anyone can **fork** it into their own graph, lineage recorded,
and take it somewhere you didn't. GitHub made code something people build *together, in the
open, on each other's work* — we think the paths people take to understanding deserve the same
treatment.

Where that leads: **learning communities**. A reading group maintaining a living curriculum
the way maintainers tend a project; a course whose track outlives the semester because
students fork and extend it; a research field whose best on-ramps are discoverable, forkable,
and credited to the people who mapped them. The primitives for this — publication, forking,
lineage, signed authorship, the registry — are built and in this repository. The communities
are the part only people can add.

One principle shapes all of it, the same one that governs what we'd ever charge for: **we
sell our own additions — computation, infrastructure, convenience — not access to what
contributors made.** Published tracks are freely readable, forking is built into the format
itself, and the formats are MIT-licensed so the ecosystem can grow bigger than any one
implementation — including ours.

## Run it (Docker)

```bash
git clone <this repo> && cd philomatic
docker compose up -d
```

Open **http://localhost:4321** — that's the workbench, served by the engine itself. Your data
persists in the `philomatic-data` volume. To require a write token or pin a learner id,
uncomment the `environment` block in `docker-compose.yml`.

## Run it (native)

```bash
pnpm install
pnpm ui:build   # the workbench the server serves at /
pnpm serve      # http://localhost:4321, db at .philomatic/philomatic.sqlite
```

## Clients

- **Workbench** (`ui/`) — browse, connect, and map everything; served at `GET /`.
- **Browser extension** (`src/extension/`) — capture sources and snippets while reading:
  `pnpm build:extension`, then load `dist-extension/` unpacked.
- **Obsidian plugin** (`obsidian/`) — live embeds, source/track note workspaces, append-only
  sync. See `obsidian/README.md` for the power-user guide.
- **CLI** (`pnpm philomatic …`) — the same engine from the terminal.

## Using it

**Capture** — right-click any page → *Save to Philomatic* (a highlight becomes a snippet), or
click the toolbar icon for the full popup: file the page into a track, relate it to concepts,
add snippets with sentiments, raise or answer questions — a live "connections to be made"
preview shows exactly what your save writes. On PDFs (where text capture can't reach), the
popup's **Capture region** crops a screenshot into an image snippet. Drafts persist per page;
nothing typed is ever lost.

**The workbench** (your server's address) — Library to browse, filter, and edit everything
(concepts, tags, authors, track membership and order — all inline, all undoable with Ctrl+Z);
Map for the live force-directed graph; Journey (experimental) for column-style track browsing.
Every open tab live-updates when you capture.

**Publish & fork** — publishing a track puts its *content* (sources, snippets, concepts,
questions — never your notes, sentiments, or progress) on a public page under an open license,
signed by your key. Push it to a registry to share it in a commons library; anyone can fork a
published track into their own Philomatic, lineage recorded. Registries are the commons layer — the part of Philomatic designed to be
shared — and anyone can run one: `philomatic registry`. A registry can also serve a
zero-install **demo** of the workbench at `/demo` (`pnpm demo:build` first) — a live one runs
at [philomatic.io/demo](https://philomatic.io/demo): the full engine compiled to WebAssembly,
running and persisting entirely in the visitor's browser — nothing they do there reaches the
server, and publishing is disabled.

**Backup & feedback** — the **Share** button exports your whole live graph as one readable
JSON file; it re-imports into any instance (`pnpm philomatic import <file>`), and the SQLite
file itself is equally copyable. `pnpm philomatic reset <file.json>` rebuilds from an export.

## For power modelers: the data model and frameworks

Under the friendly vocabulary is a deliberately expressive substrate: everything is **typed
edges carrying tags**, and tags can take subtypes and degrees (`#difficulty:4`,
`#Supports:undercuts`). The full taxonomy — entities, edge types, event verbs, id derivation
rules — lives in `DATA_MODEL.md`, and the engine enforces a strict honesty rule about it:
**unknown tags import fine and render unstyled**. Your semantics are never rejected, just not
yet understood.

That's because vocabularies are a separate, declarative layer: a **framework** is a JSON data
file that registers edge tags (what they mean, which edges they ride, their direction words)
and overlay metadata vocabularies (like the sentiment choices). The engine never interprets
any of it — frameworks are a lens the UIs render. `philomatic-core` ships built-in and is
treated exactly like a framework you'd write yourself.

To model something the core vocabulary can't say:

1. Write a framework file — see **`src/framework/experimental/`** for real ones:
   **argument-diagramming** (`#Supports` / `#Opposes` between passages),
   **hermeneutics** (`#Interprets`, `#Tension`, and a fourfold-sense reading vocabulary for
   working through the Classics, scripture, or law), **propositional-logic** (inference
   structure). Frameworks **compose** — a reading is just a passage, so the argument toolkit
   applies to interpretive disputes for free.
2. Register it in `src/framework/index.ts` and run `pnpm diagram` — the vocabulary bakes into
   the workbench and extension pickers.
3. `examples/` has a matching sample graph per experimental framework
   (`pnpm philomatic import examples/hermeneutics.json`) to see one in action.

## Status: alpha

This is an alpha stress-testing one hypothesis: *does this kind of structure actually help
while you study, or does it get in the way?* Known limits, honestly stated:

- The server must be running to capture or browse — it's local software, not a website.
- One machine for now: extension and server on the same computer (multi-device sync is
  designed, not built).
- Near-duplicate URLs (mirrors, redirects) count as different sources — dedup is designed,
  not built.

Feedback is a contribution: open an issue, or send your exported JSON with notes — specific
moments ("I expected X when I clicked Y") are gold.

## Security model (single-tenant, today)

There are **no accounts and no sessions** — that's W4, gated on the first real multi-user
deployment. What exists: reads are open, writes are guarded by one static shared secret
(`INGEST_TOKEN` → `X-Ingest-Token`, constant-time compared), and the real boundary is the
**network bind** — the server (and the Docker mapping) default to loopback only. Expose it
deliberately: an identity-bearing tunnel (Tailscale, cloudflared with access policies) beats a
raw port + token. If the token is unset, anyone who can reach the port can write; if it leaks,
rotate by restarting with a new value (all clients re-configure — there is one key, not many).
A leaked token means write access: captures and edits (edits clobber — keep backups of
`.philomatic/`), removals (recoverable — retraction, never deletion), and **publish/unpublish**
— the most sensitive write, since publishing exposes a track's content closure. Published
artifacts get integrity/authorship protection from author signing keys (Ed25519,
`author.key` beside the DB) — a separate mechanism: the token guards your instance,
signatures authenticate what leaves it.

## Data principles

How Philomatic treats your data — every bullet checkable in this repository:

- **Private by default.** Everything you create lives in your own instance (a SQLite file you
  own). Nothing is shared unless you deliberately publish it.
- **No telemetry, no phone-home.** There is no code path that reports anything to anyone.
  The only outbound requests a server ever makes are ones you initiate: metadata lookups for
  pages you captured (e.g., arXiv) and pushes to a registry you configured.
- **Publishing is an explicit act** — a button that states its terms. A publication carries
  an open license stamped at publish time, covers only the content you chose (never your
  notes, sentiments, or progress), and is signed by your key.
- **Self-hostable, copyleft.** The implementation is AGPL-3.0: every released version is
  free software you can run, audit, modify, and fork — a license grant, not a promise.

## Licensing

Two layers, deliberately:

| Layer | License | Meaning |
|---|---|---|
| Implementation — engine, server, registry, workbench, extension, plugin | **AGPL-3.0** (`LICENSE`) | Self-host freely; modify freely; if you serve a modified Philomatic to others, share your changes. No closed hosted forks. |
| Formats — payload schema, publication bundles, capture/read wire contracts | **MIT** (`LICENSE-MIT`) | Anyone may build tools that speak Philomatic's formats, open or closed. The protocol is commons. |

Contributions require a DCO sign-off (`git commit -s`) — see `CONTRIBUTING.md`.

## Where things are decided

- `DATA_MODEL.md` — the living reference for entities, edges, events, and the id rules.
