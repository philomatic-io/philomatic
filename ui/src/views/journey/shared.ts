/** Small shared helpers for the Journey columns. */
export const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

export type Focus = { kind: 'question' | 'snippet'; id: string };
export type Rel = 'raised' | 'answered' | undefined;
