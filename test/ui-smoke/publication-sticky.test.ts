/**
 * The publication page's frozen chrome, in a browser.
 *
 * The map stopped pinning on a narrow screen and nothing failed — a sticky element travels only
 * as far as its own parent, and stacked, `.pub-aside` is exactly as tall as the description and
 * map inside it. That is a CSS rule, so it is checked here rather than in the unit suite, where
 * there is no layout to be wrong about.
 *
 * The markup is a MINIATURE of Publication.tsx, not the page itself, so the first assertion is
 * that the real component still nests things this way — otherwise this passes on a shape the app
 * no longer has.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { startWorkbench, uiSmokeReady } from './harness';

describe.runIf(uiSmokeReady())('the publication map stays put while the reading scrolls', () => {
  it('pins under the frozen header at both widths', async () => {
    const source = readFileSync('ui/src/views/Publication.tsx', 'utf8');
    // Not vacuous: the miniature below only means something while the page nests these three.
    for (const cls of ['pub-track', 'pub-aside', 'pub-mapstick']) expect(source, cls).toContain(`"${cls}"`);

    const w = await startWorkbench();
    const css = readFileSync('ui/src/tokens.css', 'utf8') + readFileSync('ui/src/styles.css', 'utf8');
    const HEAD = 58; // what the frozen header measures into --pub-head-h at runtime
    const page = `<style>${css}</style><div class="pub"><div class="pub-frozen" style="height:${HEAD}px"></div>
<div class="pub-doc"><div class="pub-track">
<div class="pub-aside"><p class="pub-goal">goal</p><div class="pub-meta">meta</div>
<div class="pub-mapstick"><div class="pub-map" style="height:200px">MAP</div></div></div>
<div style="height:3000px">the reading</div></div></div></div>`;

    // 900: the stacked page. 1700: the two-column split, where the aside is a real box again.
    for (const width of [900, 1700]) {
      await w.page.setViewportSize({ width, height: 800 });
      await w.page.setContent(page);
      await w.page.evaluate((h: number) => document.documentElement.style.setProperty('--pub-head-h', `${h}px`), HEAD);

      const start = await w.page.evaluate(() => document.querySelector('.pub-mapstick')!.getBoundingClientRect().top);
      // The description and byline are ABOVE the map and scroll away — they are not frozen with it.
      expect(start, `${width}: map starts below the metadata`).toBeGreaterThan(HEAD);

      await w.page.evaluate(() => { document.querySelector('.pub')!.scrollTop = 1200; });
      const after = await w.page.evaluate(() => ({
        top: document.querySelector('.pub-mapstick')!.getBoundingClientRect().top,
        goal: document.querySelector('.pub-goal')!.getBoundingClientRect().bottom,
      }));
      expect(after.top, `${width}: map pinned under the header`).toBeCloseTo(HEAD, 0);
      expect(after.goal, `${width}: the metadata scrolled away`).toBeLessThan(HEAD);
    }
    await w.close();
  }, 120000);
});
