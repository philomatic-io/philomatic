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

### Encryption at rest

| Variable | Meaning |
|---|---|
| `PHILOMATIC_KEK` | Base64 of a 32-byte key-encryption key. Turns on encryption at rest for hosted libraries and the registry's private state. The self-host default. |
| `PHILOMATIC_KMS_KEY` | A Cloud KMS key resource name (`projects/…/cryptoKeys/…`). Takes precedence over `PHILOMATIC_KEK`: the KEK is stored KMS-wrapped in `<dir>/kek.enc` and unwrapped by one KMS call at boot. |
| `PHILOMATIC_ALLOW_PLAINTEXT` | Set to `1` to let a multi-tenant server (hosting mode, or a sign-in registry) run WITHOUT a key. A deliberate escape for dev — never in production. |

**A multi-tenant deployment refuses to start without a key** (a KEK, a KMS key, or the explicit `PHILOMATIC_ALLOW_PLAINTEXT=1`): hosting stores other people's libraries, and a sign-in registry stores emails, tokens, and invite links, so plaintext-by-accident is disallowed. A single-tenant self-hosted instance (one library, your own machine) stays plaintext by default and needs no key. See the encryption section below.

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

## Encryption at rest

Infrastructure disk encryption (e.g. a cloud provider's default) protects a stolen or
decommissioned disk. It does **not** protect against a bug that leaks a file off a running
server, and it is invisible to the application. Application-level encryption covers that gap:

- **Hosted libraries** are SQLCipher databases. Each is encrypted with its own random 32-byte
  data key (DEK); the DEK is stored wrapped beside it as `<accountId>.key` under one
  key-encryption key (KEK).
- **The registry's private state** — `accounts.json`, `tokens.json`, `index.json` (it carries
  community invite tokens and follower cursors), `frameworks.json`, and the contributions
  mailbox — is AES-256-GCM encrypted under a registry DEK (`registry.key`). Published bundles,
  archives, framework definitions, and `featured.json` stay plaintext: a stranger already
  fetches them.

**What it does and does not defend.** It turns a leaked file into ciphertext, makes backups
useless without the key, and lets you cryptographically delete data by destroying its key. It
does **not** defend against a compromised *running* server (the process holds keys in memory to
serve requests) or a malicious operator (who holds the keys) — those are the hardening and trust
boundaries, not encryption's job.

**The KEK — where it comes from.** Exactly one of:
- `PHILOMATIC_KEK` (base64 of 32 bytes) — the self-host and dev path;
- `PHILOMATIC_KMS_KEY` (a Cloud KMS key) — the KEK is generated once, stored KMS-wrapped in
  `<dir>/kek.enc`, and unwrapped by a single KMS call at boot; the raw KEK then drives the
  synchronous envelope with no further KMS traffic.

**Lost KEK = lost data.** There is no recovery path by design — a recovery path is a backdoor.
Guard the KEK (or, for KMS, guard the GCP project's IAM and billing) as carefully as the data.

**KMS key rotation does not lock you out.** Rotation creates a new key *version* and marks it
primary for future encryptions; old versions stay enabled and decrypt their own ciphertext
automatically. Because `kek.enc` is KMS-encrypted exactly once (at first boot) and only ever
decrypted after, rotation never touches it. You can only lock yourself out by *destroying* the
key version that wrapped `kek.enc` (crypto-shred, deliberate and irreversible), disabling it
(reversible — re-enable), removing the service account's IAM role (reversible — re-grant), or
letting the GCP project die. Full recovery after total server loss needs **two independent
keys**: your backup-encryption key (to open the backup) and KMS/GCP access (to unwrap the KEK)
— split on purpose, and neither lives on the server.

**Adopting encryption on an existing plaintext deployment.** Back up first, then
`philomatic migrate-encrypt --data-dir <libraries> --registry-dir <registry>` with the new
`PHILOMATIC_KEK` set — it rekeys libraries in place and encrypts the registry's private files,
idempotently. From then on the key must stay set; the server refuses to open the wrong key-mode
and says so.

## Files worth backing up

- Instance: the SQLite database(s) (`INGEST_DB`, or everything under `INGEST_DATA_DIR`),
  each database's `author.key` sibling (possession of that key IS ownership continuity for
  key-pinned publications), `<db>.frameworks.json` sidecars, and — when encryption is on — the
  per-account `<accountId>.key` files and `kek.enc` (all ride the data dir; they are ciphertext,
  but without them the data cannot be reopened even with KMS/KEK access).
- Registry: the whole `REGISTRY_DIR` (with encryption on, `accounts.json` and the rest are
  ciphertext; `registry.key` and `kek.enc` live here and must ride the backup). With encryption
  off, `accounts.json` holds emails and token hashes in the clear — it is written `0600` for a
  reason; keep backups equally private.
- Above all, the **KEK itself**: for `PHILOMATIC_KEK`, a copy of the key stored apart from the
  data (a password manager); for KMS, the GCP key must simply stay alive. `kek.enc` in a backup
  is useless without KMS access, and the data is useless without `kek.enc`.
