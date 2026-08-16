/**
 * Global test setup. Hosted mode is encrypted at rest, so the suite runs with a KEK present —
 * every hosted server a test spins up mints encrypted libraries, exactly like production.
 * Single-tenant tests are unaffected: they open a db path with no key sibling, so they stay
 * plaintext regardless. Individual tests that assert the no-KEK REFUSAL clear this locally.
 */
const TEST_KEK_B64 = Buffer.alloc(32, 7).toString('base64');
process.env.PHILOMATIC_KEK ??= TEST_KEK_B64;
