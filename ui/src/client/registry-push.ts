/**
 * The same-origin registry push — ONE implementation for both engines.
 *
 * Both clients publish to the registry the same way: POST the bundle to `<origin>/publish`, with
 * the session cookie riding along, and translate the registry's refusals into the same words.
 * This lived in each client separately and the wordings had already begun to drift — the exact
 * bug class the two-surface risk predicts (fix one, ship the other). What GENUINELY differs per
 * engine is only how the bundle is obtained, so that arrives as an argument.
 *
 * If you are changing what a push does or says, this is the only place; the contract test
 * (test/client-contract.test.ts) holds both engines to it.
 */

export async function pushBundleSameOrigin(
  registry: string,
  bundle: unknown,
): Promise<{ ok: boolean; updated: boolean; url: string }> {
  if (bundle === null || bundle === undefined) throw new Error('track is not published — publish it first');
  // Deliberate twin: src/cli/index.ts pushes with this same fetch shape (the /publish route is
  // the real contract) — keep the two call sites in step by hand.
  const res = await fetch(`${registry}/publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(bundle),
  });
  const out = (await res.json().catch(() => ({}))) as { error?: string; url?: string; updated?: boolean };
  if (res.status === 401) throw new Error(`${registry} needs an account to publish — sign in, then try again`);
  if (!res.ok) throw new Error(out.error ?? `the registry refused it (${res.status})`);
  return { ok: true, updated: out.updated === true, url: `${registry}${out.url ?? ''}` };
}
