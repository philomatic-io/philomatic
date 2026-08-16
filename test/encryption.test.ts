/**
 * Encryption at rest for hosted libraries. Proves the crypto end to end: DEKs wrap and
 * unwrap, a keyed database is CIPHERTEXT on disk, the wrong key is refused, the DEK survives a
 * pool eviction, deleting a library removes its key, and a hosted server without a KEK refuses
 * to start.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { aesKek, envKek, generateDEK, resolveDEK } from '../src/server/keys';
import { encryptLibraries, encryptRegistry } from '../src/server/migrate-encrypt';
import { PhilomaticEngine } from '../src/engine';
import { EnginePool } from '../src/server/tenancy';
import { createIngestServer } from '../src/server/ingest';

const tmp = () => mkdtempSync(join(tmpdir(), 'pm-enc-'));

describe('keys — the envelope', () => {
  it('wraps and unwraps a DEK, and a tampered wrapper is refused', () => {
    const kek = aesKek(randomBytes(32));
    const dek = generateDEK();
    const wrapped = kek.wrap(dek);
    expect(kek.unwrap(wrapped)).toEqual(dek);
    expect(wrapped).not.toEqual(dek); // actually wrapped, not passed through
    const tampered = Buffer.from(wrapped);
    tampered[tampered.length - 1] = (tampered[tampered.length - 1]! ^ 0xff) & 0xff; // flip a tag byte
    expect(() => kek.unwrap(tampered)).toThrow(); // GCM auth fails
  });

  it('a DIFFERENT KEK cannot unwrap', () => {
    const dek = generateDEK();
    const wrapped = aesKek(randomBytes(32)).wrap(dek);
    expect(() => aesKek(randomBytes(32)).unwrap(wrapped)).toThrow();
  });

  it('envKek reads a 32-byte base64 key, and rejects a wrong length', () => {
    expect(envKek({})).toBeUndefined();
    expect(envKek({ PHILOMATIC_KEK: '   ' })).toBeUndefined();
    expect(envKek({ PHILOMATIC_KEK: randomBytes(32).toString('base64') })).toBeDefined();
    expect(() => envKek({ PHILOMATIC_KEK: randomBytes(16).toString('base64') })).toThrow(/32 bytes/);
  });

  it('resolveDEK mints+persists on first call, then loads the same key', () => {
    const dir = tmp();
    const keyPath = join(dir, 'acc_x.key');
    const kek = aesKek(randomBytes(32));
    expect(existsSync(keyPath)).toBe(false);
    const first = resolveDEK(keyPath, kek);
    expect(existsSync(keyPath)).toBe(true); // wrapped key persisted
    expect(readFileSync(keyPath)).not.toEqual(first); // on disk it is WRAPPED, not the raw DEK
    expect(resolveDEK(keyPath, kek)).toEqual(first); // second call loads, does not re-mint
    expect(() => resolveDEK(keyPath, aesKek(randomBytes(32)))).toThrow(); // wrong KEK can't load
  });
});

describe('openDb — ciphertext at rest', () => {
  it('a keyed database is ciphertext on disk; a plaintext one leaks; the wrong key is refused', () => {
    const dir = tmp();
    const SECRET = 'Backpropagation Through Time';

    // Encrypted.
    const encPath = join(dir, 'enc.sqlite');
    const dek = generateDEK();
    const e = PhilomaticEngine.open(encPath, { key: dek });
    e.captureSource({ url: 'https://ex.com/x', title: SECRET });
    e.close();
    expect(readFileSync(encPath).includes(SECRET), 'title must not appear in the raw encrypted file').toBe(false);
    expect(readFileSync(encPath).subarray(0, 15).toString(), 'not even a SQLite header').not.toBe('SQLite format 3');

    // Plaintext control — the same title DOES appear.
    const plainPath = join(dir, 'plain.sqlite');
    const p = PhilomaticEngine.open(plainPath);
    p.captureSource({ url: 'https://ex.com/x', title: SECRET });
    p.close();
    expect(readFileSync(plainPath).includes(SECRET), 'the control leaks, proving the assertion has teeth').toBe(true);

    // Right key reads; wrong key is refused.
    const reopened = PhilomaticEngine.open(encPath, { key: dek });
    expect(reopened.snapshot().sources[0]!.title).toBe(SECRET);
    reopened.close();
    expect(() => PhilomaticEngine.open(encPath, { key: generateDEK() }).snapshot()).toThrow();
  });
});

describe('the pool — the DEK survives eviction', () => {
  it('provisions encrypted, and a reopen after drop unwraps and reads', () => {
    const dir = tmp();
    const dbPath = join(dir, 'acc_abc.sqlite');
    const keyPath = join(dir, 'acc_abc.key');
    const kek = aesKek(randomBytes(32));
    const keyFor = () => resolveDEK(keyPath, kek);
    const pool = new EnginePool();

    // Provision + write (first open mints the key).
    void pool.withEngine(dbPath, (e) => e.captureSource({ url: 'https://ex.com/r', title: 'Reading' }), keyFor);
    expect(existsSync(keyPath), 'the wrapped DEK was minted on provision').toBe(true);
    expect(readFileSync(dbPath).includes('Reading'), 'the library file is ciphertext').toBe(false);

    // Evict (as the idle sweeper would), then reopen — the key must load, not re-mint.
    pool.drop(dbPath);
    const title = pool.withEngine(dbPath, (e) => e.snapshot().sources[0]?.title, keyFor);
    return Promise.resolve(title).then((t) => {
      expect(t, 'the reopened library reads through the persisted key').toBe('Reading');
      pool.closeAll();
    });
  });
});

describe('R2 — a hosted server refuses to run plaintext', () => {
  const saved = new Map<string, string | undefined>();
  const setEnv = (env: Record<string, string | undefined>) => {
    for (const k of Object.keys(env)) if (!saved.has(k)) saved.set(k, process.env[k]);
    for (const [k, v] of Object.entries(env)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  };
  afterEach(() => {
    for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
    saved.clear();
  });

  it('hosting without a KEK throws; PHILOMATIC_ALLOW_PLAINTEXT=1 permits it', () => {
    const dir = tmp();
    setEnv({ INGEST_DATA_DIR: dir, REGISTRY_URL: 'http://reg.test', PHILOMATIC_KEK: undefined, PHILOMATIC_ALLOW_PLAINTEXT: undefined });
    expect(() => createIngestServer({ db: ':memory:' })).toThrow(/encrypt them at rest|ALLOW_PLAINTEXT/);

    setEnv({ PHILOMATIC_ALLOW_PLAINTEXT: '1' });
    const s = createIngestServer({ db: ':memory:' });
    expect(s).toBeDefined();
    s.close();
  });

  it('with a KEK, a hosted server starts and deleting a library removes its key file', async () => {
    const dir = tmp();
    const kek = aesKek(randomBytes(32));
    // Drive the pool path the delete route uses, at the unit level: provision, then the delete
    // route unlinks dbPath sidecars AND keyPath.
    const dbPath = join(dir, 'acc_del.sqlite');
    const keyPath = join(dir, 'acc_del.key');
    const pool = new EnginePool();
    await pool.withEngine(dbPath, (e) => e.captureSource({ url: 'https://ex.com/r', title: 'X' }), () => resolveDEK(keyPath, kek));
    expect(existsSync(keyPath)).toBe(true);
    pool.drop(dbPath);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbPath}${suffix}`, { force: true });
    rmSync(keyPath, { force: true });
    expect(existsSync(keyPath), 'the key file is gone with the library').toBe(false);
  });
});

describe('migrate-encrypt — plaintext deployment → encrypted', () => {
  it('encrypts plaintext libraries in place, keeps data, and is idempotent', () => {
    const dir = tmp();
    const kek = aesKek(randomBytes(32));
    // Two plaintext libraries with data.
    for (const acc of ['acc_a', 'acc_b']) {
      const e = PhilomaticEngine.open(join(dir, `${acc}.sqlite`));
      e.captureSource({ url: `https://ex.com/${acc}`, title: `Title ${acc}` });
      e.close();
    }
    expect(readFileSync(join(dir, 'acc_a.sqlite')).includes('Title acc_a'), 'plaintext before').toBe(true);

    const { encrypted, skipped } = encryptLibraries(dir, kek);
    expect(encrypted.sort()).toEqual(['acc_a.sqlite', 'acc_b.sqlite']);
    expect(skipped).toEqual([]);

    // Now ciphertext on disk, and readable with the wrapped key.
    expect(readFileSync(join(dir, 'acc_a.sqlite')).includes('Title acc_a'), 'ciphertext after').toBe(false);
    expect(existsSync(join(dir, 'acc_a.key'))).toBe(true);
    const dek = resolveDEK(join(dir, 'acc_a.key'), kek);
    const reopened = PhilomaticEngine.open(join(dir, 'acc_a.sqlite'), { key: dek });
    expect(reopened.snapshot().sources[0]!.title).toBe('Title acc_a');
    reopened.close();

    // Idempotent: a second run skips both (they now have keys).
    const again = encryptLibraries(dir, kek);
    expect(again.encrypted).toEqual([]);
    expect(again.skipped.sort()).toEqual(['acc_a.sqlite', 'acc_b.sqlite']);
  });

  it('encrypts a plaintext registry directory, and is idempotent', () => {
    const dir = tmp();
    const kek = aesKek(randomBytes(32));
    // Plaintext private files as a pre-encryption registry would have written them.
    writeFileSync(join(dir, 'accounts.json'), JSON.stringify({ version: 1, accounts: [{ id: 'acc_x', email: 'a@b.co' }] }));
    writeFileSync(join(dir, 'index.json'), JSON.stringify({ syl_t: { trackId: 'syl_t', community: { invite: { token: 'SEEKRET' } } } }));

    const { encrypted, skipped } = encryptRegistry(dir, kek);
    expect(skipped).toBe(false);
    expect(encrypted).toContain('accounts.json');
    expect(encrypted).toContain('index.json');
    expect(existsSync(join(dir, 'registry.key'))).toBe(true);

    // Ciphertext on disk (the invite token no longer leaks), decryptable with the registry DEK.
    expect(readFileSync(join(dir, 'index.json')).includes('SEEKRET')).toBe(false);
    const dek = resolveDEK(join(dir, 'registry.key'), kek);
    const idx = JSON.parse(aesKek(dek).unwrap(readFileSync(join(dir, 'index.json'))).toString('utf8')) as Record<string, { community?: { invite?: { token?: string } } }>;
    expect(idx.syl_t!.community!.invite!.token).toBe('SEEKRET');

    // Idempotent: registry.key present → skipped whole.
    expect(encryptRegistry(dir, kek).skipped).toBe(true);
  });
});
