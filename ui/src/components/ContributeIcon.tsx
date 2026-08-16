/**
 * The Contributions icon: a stacked source joined by a DASHED link
 * to a node — a reading being proposed into the graph. Stroke-only, currentColor. Coordinates
 * sit on clean half-unit stops on a 24 grid so the axis-aligned card edges stay crisp; the
 * front card is filled with the page ground to occlude the back one at any theme.
 */
export function ContributeIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {/* the node */}
      <circle cx="18" cy="6" r="3.25" />
      {/* the proposed link */}
      <line x1="14" y1="10" x2="15.75" y2="8.25" strokeDasharray="2 2" />
      {/* the source, stacked */}
      <rect x="7" y="9" width="8" height="8" rx="1.5" />
      <rect x="4" y="12" width="8" height="8" rx="1.5" fill="var(--bg, #161826)" />
    </svg>
  );
}
