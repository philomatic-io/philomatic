/**
 * The public entry: ONE bundle for every server-rendered public shell. Each shell
 * embeds its page's data island; whichever island is present decides what mounts. The shells
 * already show the essential content as static HTML — mounting replaces #root's
 * children with the live body. No island, no mount: the static shell stands alone, which is
 * exactly the degradation contract.
 */
import { createRoot } from 'react-dom/client';
import '../styles.css';
import './registry.css';
import { RegistryPage, type RegistryData } from './RegistryPage';
import { AccountControl } from '../components/AccountControl';
import type { HostedIdentity } from '../lib/hosted';

const root = document.getElementById('root');
const island = (id: string): string | undefined => {
  const text = document.getElementById(id)?.textContent;
  return text != null && text !== '' ? text : undefined;
};

if (root !== null) {
  const registry = island('registry-data');
  if (registry !== undefined) createRoot(root).render(<RegistryPage data={JSON.parse(registry) as RegistryData} />);
}

// The account corner: the SAME React dropdown as every other surface, mounted over
// the server's no-JS fallback — whose <details> toggle proved browser-dependent.
const acctRoot = document.getElementById('acct-root');
const acct = island('acct-data');
if (acctRoot !== null && acct !== undefined) {
  const data = JSON.parse(acct) as { signedIn: boolean; account?: HostedIdentity['account']; providers: { id: string; label: string }[] };
  createRoot(acctRoot).render(<AccountControl identity={{ hosted: true, signedIn: data.signedIn, ...(data.account !== undefined ? { account: data.account } : {}), providers: data.providers }} />);
}
