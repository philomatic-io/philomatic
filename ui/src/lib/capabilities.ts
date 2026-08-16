/**
 * What each engine can actually do.
 *
 * The in-browser engine is not a lesser Philomatic — it is a different one, and the things it
 * cannot do it cannot do for REASONS, each of which is worth stating: there is no LLM key in a
 * browser tab, no address for anyone else to reach, and a page cannot fetch arbitrary other
 * pages. Those are properties of running in a tab, not bugs to be fixed later.
 *
 * `registry` and `examples` are NOT among them. A tab may always fetch
 * the origin that served it, and this build is published BY a registry — so its tracks and its
 * examples are same-origin, and refusing them was a rule copied one step too far. Both are now
 * runtime facts: the client asks its own origin and the UI renders what came back. These two
 * strings are what is left when the answer is nothing, which is the case for a static export or a
 * page opened from disk.
 *
 * So the difference is product, not gap. The rule lives here, once, and both halves read
 * it: the client's refusal when something is called anyway, and the UI's explanation BEFORE it
 * is called. Two copies of this would eventually disagree, and the disagreement would surface
 * as a button that promises something the engine then refuses.
 */
export type Backend = 'browser' | 'server';

export type Capability =
  /** LLM passes: suggest structure for a source, or draft a whole track. */
  | 'suggest'
  /** Publish a track, unpublish it, push it to a registry. */
  | 'publish'
  /** Mint a shareable ask link — needs an address other people can reach. */
  /** Read the community registry, and fork from it. */
  | 'registry'
  /** The bundled example tracks, read from the server's examples dir. */
  | 'examples';

/** Why this engine cannot do this — present means unavailable, absent means fine. */
const BROWSER_LIMITS: Record<Capability, string> = {
  suggest:
    'Suggestions need an AI model, and a browser tab has no key to one. Run your own Philomatic to have it draft structure for you.',
  // Publishing MINTS locally and PUSHES to a registry. Minting works anywhere — the bundle is
  // signed in this tab. Pushing needs an account at the registry that served this page, which is
  // a different sentence from "needs a server": ownership
  // is the account, so an ephemeral in-tab key is no obstacle, and on the one-origin deploy the
  // push is same-origin. The refusal below is for a page NO registry served.
  publish:
    'Publishing sends a track to a registry, and this page was not served by one. Open your workbench on a Philomatic registry — philomatic.io, or your own — and publish from there.',
  registry:
    'Community tracks come through the Philomatic that served this page, and it has no registry configured. Any published track has a Fork button that downloads it as a file — use Import above to bring it in here.',
  examples:
    'Example tracks come from the Philomatic that served this page, and this address offers none. Import a file instead, or run a server.',
};

/** The reason this backend cannot do this, or undefined when it can. */
export function unavailable(cap: Capability, backend: Backend): string | undefined {
  return backend === 'browser' ? BROWSER_LIMITS[cap] : undefined;
}

/** The short form for a button's tooltip or a disabled control's label. */
export function needsServer(cap: Capability, backend: Backend): boolean {
  return unavailable(cap, backend) !== undefined;
}
