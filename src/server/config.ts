/**
 * One file an operator can put their settings in.
 *
 * JSON rather than YAML: no new dependency, and this server already stores everything else it
 * owns as JSON. The shape is flat and every key optional.
 *
 * **Secrets do not go here.** A config file sits beside the code and gets committed by accident,
 * which is exactly how a client secret leaks — so tokens, keys and the session secret stay in the
 * environment, where `.gitignore` and file permissions already protect them. This file is for
 * the knobs: where things live, how long things last, how much a tenant may spend.
 *
 * Precedence is **environment > file > default**, so a container can override one setting without
 * rebuilding an image, and a file cannot silently countermand what an operator typed on the
 * command line.
 */
import { existsSync, readFileSync } from 'node:fs';

export interface ServerConfig {
  /** Hosting: where libraries live. Absent = single-tenant. */
  dataDir?: string;
  /** The registry this instance publishes to and verifies tokens against. */
  registryUrl?: string;
  /**
   * This server's credential AT that registry — an account access token (`pmt_…`), used only
   * when pushing.
   *
   * A registry that offers sign-in requires an account to publish. A self-hosted workbench is
   * exactly the case that has no session and never will: it is one person's laptop pushing to
   * philomatic.io, so it carries a token minted on their account page. Env-only, like every
   * other secret — `loadConfig` refuses a config file that contains one.
   */
  registryToken?: string;
  /** Set when a proxy in front sets `X-Forwarded-For` — see `callerKey`. */
  trustProxy: boolean;
  /** How long a "whose token is this?" answer is remembered. THE REVOCATION DELAY. */
  tokenVerifyTtlMs: number;
  /** LLM passes one account may run per calendar month on a hosted instance. 0 disables the
   *  feature here; negative means no budget at all. */
  llmCallsPerMonth: number;
  /** Libraries held open at once, and how long an idle one lingers. */
  poolCap: number;
  poolIdleMs: number;
  /** Where this server is MOUNTED on its origin. '' = the root, as ever.
   *  '/app' = the one-origin deploy, where the registry owns `/` and this server answers under
   *  the prefix; requests arrive with it and the router strips it before matching. Normalized:
   *  leading slash, no trailing slash. */
  basePath: string;
}

const DEFAULTS: ServerConfig = {
  basePath: '',
  trustProxy: false,
  tokenVerifyTtlMs: 60_000,
  llmCallsPerMonth: 50,
  poolCap: 64,
  poolIdleMs: 10 * 60_000,
};

/** Every key an operator may set in the file, and how it maps onto the shape above. */
interface FileShape {
  dataDir?: string;
  registryUrl?: string;
  trustProxy?: boolean;
  tokenVerifyTtlSeconds?: number;
  llmCallsPerMonth?: number;
  poolCap?: number;
  poolIdleSeconds?: number;
  basePath?: string;
}

/** '' stays ''; anything else gets a leading slash and loses trailing ones — `/app`, never `app/`. */
const normBase = (v: string | undefined): string | undefined => {
  if (v === undefined) return undefined;
  const t = v.trim().replace(/\/+$/, '');
  if (t === '' || t === '/') return '';
  return t.startsWith('/') ? t : `/${t}`;
};

const truthy = (v: string | undefined): boolean | undefined =>
  v === undefined || v === '' ? undefined : v === '1' || v.toLowerCase() === 'true';

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/**
 * Read the file (if any), then let the environment win.
 *
 * A malformed file THROWS rather than being ignored. An operator who mistypes a brace has said
 * something about how this server should run, and starting anyway with defaults would run a
 * configuration nobody chose — silently, and differently from what they are reading on screen.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env, readFile = readFileSync): ServerConfig {
  const path = env.PHILOMATIC_CONFIG ?? 'philomatic.config.json';
  let file: FileShape = {};
  if (existsSync(path)) {
    try {
      file = JSON.parse(String(readFile(path, 'utf8'))) as FileShape;
    } catch (e) {
      throw new Error(`${path} is not valid JSON — fix it or remove it: ${e instanceof Error ? e.message : String(e)}`);
    }
    for (const key of ['token', 'secret', 'clientSecret', 'apiKey', 'sessionSecret'] as const) {
      if (key in (file as Record<string, unknown>)) {
        throw new Error(`${path} contains "${key}" — secrets belong in the environment, not in a file that gets committed`);
      }
    }
  }
  const ttlSeconds = num(env.TOKEN_VERIFY_TTL_SECONDS) ?? file.tokenVerifyTtlSeconds;
  const idleSeconds = num(env.POOL_IDLE_SECONDS) ?? file.poolIdleSeconds;
  const dataDir = env.INGEST_DATA_DIR ?? file.dataDir;
  const registryUrl = env.REGISTRY_URL ?? file.registryUrl;
  return {
    ...(dataDir !== undefined && dataDir !== '' ? { dataDir } : {}),
    ...(registryUrl !== undefined && registryUrl !== '' ? { registryUrl } : {}),
    ...(env.REGISTRY_TOKEN !== undefined && env.REGISTRY_TOKEN.trim() !== '' ? { registryToken: env.REGISTRY_TOKEN.trim() } : {}),
    trustProxy: truthy(env.TRUST_PROXY) ?? file.trustProxy ?? DEFAULTS.trustProxy,
    tokenVerifyTtlMs: ttlSeconds !== undefined && ttlSeconds >= 0 ? ttlSeconds * 1000 : DEFAULTS.tokenVerifyTtlMs,
    llmCallsPerMonth: num(env.LLM_CALLS_PER_MONTH) ?? file.llmCallsPerMonth ?? DEFAULTS.llmCallsPerMonth,
    poolCap: num(env.POOL_CAP) ?? file.poolCap ?? DEFAULTS.poolCap,
    poolIdleMs: idleSeconds !== undefined && idleSeconds >= 0 ? idleSeconds * 1000 : DEFAULTS.poolIdleMs,
    basePath: normBase(env.BASE_PATH) ?? normBase(file.basePath) ?? DEFAULTS.basePath,
  };
}
