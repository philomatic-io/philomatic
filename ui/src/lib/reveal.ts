/**
 * Keep a control clear of a FROZEN BAR.
 *
 * A pane can pin a row to its foot — the detail rail pins its actions there. That bar floats
 * above the scrolling content, so anything the content puts in the last stripe of the pane is
 * behind it: present, laid out, and unreachable. A picker opened near the bottom of the rail put
 * its "+ Add" button exactly there, which is a control you cannot see and therefore cannot use.
 *
 * The bar's height is not a constant — it wraps to two lines on a narrow rail — so this measures
 * the bar that is actually there rather than guessing a `scroll-padding-bottom`. Anything with a
 * commit button that can open near the foot of a pane should call this when it opens.
 */

/** The scrolling ancestor of `el`, or null if nothing scrolls. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p !== null; p = p.parentElement) {
    const overflow = getComputedStyle(p).overflowY;
    if ((overflow === 'auto' || overflow === 'scroll') && p.scrollHeight > p.clientHeight) return p;
  }
  return null;
}

/**
 * Scroll the least amount that brings `el` fully above the pane's frozen bar. A no-op when the
 * element is already clear, when nothing scrolls, or when there is no bar.
 */
export function revealAboveFrozenBar(el: HTMLElement, gap = 10): void {
  const scroller = scrollerOf(el);
  if (scroller === null) return;
  const bar = scroller.querySelector<HTMLElement>(':scope > .detail-foot-stick');
  // With no bar the pane's own bottom edge is the limit — the element can still be off-screen.
  const limit = (bar ?? scroller).getBoundingClientRect().top + (bar === null ? scroller.clientHeight : 0);
  const overflow = el.getBoundingClientRect().bottom - limit + gap;
  if (overflow > 0) scroller.scrollBy({ top: overflow, behavior: 'smooth' });
}
