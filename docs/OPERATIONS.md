# Operating Philomatic

How the pieces deploy and talk to each other — the knowledge a self-hoster needs, kept here
instead of scattered through server comments. Everything below is verified against the code
it describes; if the code moves, this file moves with it.

## The two servers

- **The instance** (`src/server/ingest.ts`) — serves the workbench (`ui/dist`) and the
  engine's HTTP API. Single-tenant by default: one SQLite database, one learner.
- **The registry** (`src/registry/server.ts`) — the track-sharing service: published
  bundles, accounts and sign-in, communities/mailboxes, framework archive. Plain JSON-file
  storage under its data directory; no database.

Either runs alone. A self-hosted instance needs no registry until you publish; a registry
needs no instance (it serves public pages itself).

## The one-origin deploy shape

Production runs both behind one reverse proxy on one origin, routed by path:

    /app*  /assets/*  /ask/*  /favicon.ico  /health   → the instance
    everything else                                     → the registry

The test fixture `test/ui-smoke/one-origin.ts` builds exactly this shape in-process — if you
change the routing, change the fixture in the same commit.

On a **hosted** instance (see `INGEST_DATA_DIR`), `/t/*` public pages redirect to the
registry: a publication's public face lives where accounts live.

## Configuration

Config comes from `philomatic.config.json` (path overridable via `PHILOMATIC_CONFIG`) with
environment variables taking precedence. **Secrets belong in the environment, never in the
config file.**

### Instance

| Variable | Meaning |
|---|---|
| `INGEST_PORT` | Port (loopback-bound by default — local-first). |
| `INGEST_DB` | SQLite file path; `:memory:` for ephemeral. |
| `INGEST_TOKEN` | If set, writes require the matching `X-Ingest-Token` header. |
| `INGEST_LEARNER` | The single-tenant learner id. |
| `INGEST_DATA_DIR` | **Turns on hosting mode**: one SQLite per account under this dir; requests resolve to a tenant by credential. |
| `BASE_PATH` | Mount prefix on the shared origin (the deploy uses `/app`). |
| `REGISTRY_URL` | The registry this instance publishes to and verifies credentials against. |
| `REGISTRY_TOKEN` | A personal access token for CLI/API pushes (browser sessions forward their own). |
| `POOL_CAP`, `POOL_IDLE_SECONDS` | Hosted engine-pool sizing. |
| `TOKEN_VERIFY_TTL_SECONDS` | How long a verified credential is cached (the TTL *is* the revocation delay). |

### Registry

| Variable | Meaning |
|---|---|
| `REGISTRY_PORT`, `REGISTRY_HOST` | Bind address. |
| `REGISTRY_DIR` | Data directory (index, bundles, contributions, frameworks, accounts). |
| `PUBLIC_URL` | The origin sign-in links and invite links are minted against — required for sign-in. |
| `SESSION_SECRET` | HMAC key for session cookies (≥32 chars). |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | OAuth provider credentials. **Providers are config: unset means sign-in is simply not offered** — the registry still serves public pages. |
| `TRUST_PROXY` | Honor `X-Forwarded-*` from the fronting proxy. |

### LLM (optional, both propose passes)

| Variable | Meaning |
|---|---|
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` | An OpenAI-compatible endpoint. Unset → propose routes answer 503. |
| `LLM_CALLS_PER_MONTH` | Per-account monthly budget on a hosted instance (ledger resets on the 1st). |

## Credential precedence

1. **Bearer token** (`Authorization: Bearer …`) — a deliberate credential: the CLI, scripts,
   hosted API calls. Exempt from the same-origin write guard *because* it cannot be sent
   ambiently by a browser.
2. **Session cookie** — the browser's credential. Cookie-authed writes pass the same-origin
   guard (`Sec-Fetch-Site` first, Origin/Host comparison as fallback — one implementation,
   `originAllowed` in `src/server/tenancy.ts`, used by both servers).
3. On a hosted instance, publishing forwards **the caller's own credential** to the
   registry — the instance holds no publishing identity of its own; a publication belongs
   to a user.

The instance never reads the registry's stores directly (the lock line keeps `src/server`
out of `src/registry`, and the two must be separable boxes): identity questions are HTTP
questions to `/auth/me`, cached briefly (`TOKEN_VERIFY_TTL_SECONDS`).

## Egress rules

Server-side fetches of user-supplied URLs (capture, adapters, propose) go through the
safe-fetch guards: http(s) only — script-bearing and exotic schemes are rejected — and
private/loopback address ranges are refused, so a capture URL can't be turned into an SSRF
probe of the box or its network. Registry bundle uploads are size-capped.

## Files worth backing up

- Instance: the SQLite database(s) (`INGEST_DB`, or everything under `INGEST_DATA_DIR`),
  each database's `author.key` sibling (possession of that key IS ownership continuity for
  key-pinned publications), and `<db>.frameworks.json` sidecars.
- Registry: the whole `REGISTRY_DIR` (accounts.json holds emails and token hashes — it is
  written `0600` for a reason; keep backups equally private).
