# Philomatic for Obsidian

Your Philomatic learning graph, live inside your notes. Questions, snippets, sources, concepts,
and tracks render as **live embeds** — nothing is copied into your vault, so nothing goes stale.
Backed by your self-hosted Philomatic server.

## Quick start

1. Start the server in the Philomatic repo: `pnpm serve` (defaults to `http://localhost:4321`).
2. Copy (or symlink) this folder into `<vault>/.obsidian/plugins/philomatic/` — Obsidian needs
   `manifest.json`, `main.js`, and `styles.css` side by side.
3. Enable **Philomatic** under *Settings → Community plugins* (turn off Restricted mode).
4. In the plugin's settings tab, hit **Test** to confirm the connection.
5. In any note, type `/pm` — the command menu appears.

## Settings

| Setting | What it does |
|---|---|
| Server URL | Your Philomatic server (also hosts the Library viewer) |
| Access token | Only if your server sets `X-Ingest-Token`; checked on first write |
| Learner id | Whose overlay your captures land under (empty = server default) |
| Open links in | Embed clicks open the Library in an **Obsidian tab** (default) or system browser |
| Source notes folder | Where *Create source note* puts notes (default `Philomatic sources`) |
| Track notes folder | Where *Create track notes* puts folders (default `Philomatic tracks`) |

## Embeds

Notes store only **stable entity ids**; everything renders fresh from the server, updating live
when any client writes (the browser extension, the workbench, another vault). Clicking any embed
opens that entity in the Library.

### Inline tokens

Write `` `pm:<id>` `` anywhere in text — it renders as a kind-colored chip (source, concept,
track, …). A **snippet or question token alone in its paragraph** upgrades to a card: snippets
become quote boxes with their source attribution and question ties (`? raises` / `✓ answers`
badges), questions become state cards (open / answered).

### Block embeds

A ` ```philomatic ` fence renders a detailed view. The key word is a courtesy — dispatch is by
the id's prefix, so `source: snp_…` works too:

| Fence | Renders |
|---|---|
| `source: src_…` | Source header: title, modality/duration/tags, URL, and requisite rows — **pre-requisites** (read before), **co-requisites** (same level in a track), **post-requisites** (read after) |
| `track: syl_…` | Track header: title, goal, source/concept counts, tags, then every member source in reading order with a link to its vault note |
| `snippet: snp_…` | The quote card with its **question boxes nested inside** (full state cards, badged raised vs answered) and its other relations below |
| `concept: cpt_…` / `question: qst_…` | The entity with its relations listed below |
| `map: this-note` | The Map view scoped to every entity this note references (add `height: 500` to size it) |

## Commands (`/pm` in the editor, or the command palette)

Every embeddable kind has two flavors: **`-ref`** (browse your library, pick, embed) and
**`-create`** (mint new on the server, embed). Kinds: `question`, `snippet`, `source`,
`concept`, `track`.

Highlights:

- `/pm-snippet-create` — select a quote in your note first; the quote stays, the token lands
  after it. Pick the source, add sentiment/concepts/questions in the modal.
- `/pm-question-create` — with text selected, the selection *becomes* the question.
- `/pm-source-note` — generate a structured workspace note for a source (see below).
- `/pm-track-notes` — generate a folder for a whole track (see below).
- `/pm-embed-map` — drop a `map: this-note` fence at the cursor.
- `/pm-note-sync` — append entities that are new on the server (see the sync contract).

Right-click also offers *new question*, *save selection as snippet*, and *embed from library*.

## Source notes

`/pm-source-note` generates a note bound to a source (`philomatic-source` frontmatter):

```
## Source        ← live source header (requisites and all)
## Questions     ← one token per source-level question
## Snippets      ← one detailed snippet fence per snippet
## Map           ← map scoped to this note
## My notes
```

Write your own prose anywhere — between snippets, under questions, wherever. The generated
entries are just anchors; your text is yours. Creating the note also sets the source's
`personalUrl` to the note's `obsidian://` URI, so the Library's detail view links straight
back to Obsidian.

## Track notes

`/pm-track-notes` turns a track into a folder: `0. <Track title>` (the root note) plus a
numbered source note per member — `1.`, `2.`, … in reading order, so the folder sorts exactly
as the track reads. The root note has the live track header, the track's concepts, the reading
order as wikilinks (co-requisites share a line), and a scoped map. Sources already bound to a
note anywhere in your vault are linked, never duplicated.

## The sync contract

`/pm-note-sync` brings a bound note up to date with the server, and it is **append-only**:

- It only **inserts** entries for entities missing from the note, at the end of their section.
- It never deletes, never moves, never rewrites your text. An id found anywhere in the note
  counts as present, so reorganizing embeds into your prose is respected.
- Entities deleted on the server leave their embeds rendering as "not in your library" —
  deleting the line is your call.
- On a track note it also creates notes for newly included sources, then links them.

Everything else needs no sync at all: embeds render live, so edits to existing entities appear
the moment the server changes.

---

## Development

A pure HTTP client: this workspace imports nothing from the repo's `src/` (enforced by
`test/lockline.test.ts`); vocabulary comes from `GET /framework` at runtime. The build plan
retired to git history (2026-07-17); the as-built record is ROADMAP.md's Obsidian retirement
paragraph, and this README is the reference for behavior (including the sync contract).

```bash
pnpm install
pnpm --filter philomatic-obsidian dev     # esbuild watch → main.js
pnpm --filter philomatic-obsidian build   # one-shot, typechecked
```

Release/extraction to a standalone repo is OB-S6 — this folder is structured so that diff is
approximately zero.
