/** Browser stand-in for node:path (demo build only) — the two calls the engine makes. */
export const join = (...parts: string[]): string => parts.join('/');
export const dirname = (p: string): string => p.split('/').slice(0, -1).join('/') || '.';
