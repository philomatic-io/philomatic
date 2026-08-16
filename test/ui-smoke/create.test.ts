/**
 * UI smoke — CREATION. Every kind is name-first: what you type is what gets saved, and the
 * creation is undoable. This is the suite that catches "Enter says 'New track'" —
 * a create-then-rename race saving the placeholder instead of the name.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enterDetailEditing, openCreateForm, startWorkbench, uiSmokeBlocker, uiSmokeReady, type Workbench } from './harness';

const blocker = uiSmokeBlocker();
if (blocker !== undefined) console.warn(`[ui-smoke] skipped — ${blocker}`);

describe.skipIf(!uiSmokeReady())('create (name-first)', () => {
  let w: Workbench;
  beforeAll(async () => {
    w = await startWorkbench();
  }, 60000);
  afterAll(async () => {
    await w?.close();
  });

  it('a track saves the typed name — not a placeholder — and Ctrl+Z removes it', async () => {
    await openCreateForm(w, 'track');
    // Type IMMEDIATELY: the old flow lost keystrokes that landed before its editor mounted.
    await w.page.keyboard.type('Typed Track Name', { delay: 10 });
    await w.page.keyboard.press('Enter');
    await w.page.waitForTimeout(1100);

    const after = await w.snapshot();
    expect(after.tracks.map((t: any) => t.title)).toContain('Typed Track Name');
    expect(after.tracks.some((t: any) => /^New track/.test(t.title))).toBe(false); // no orphan draft

    await w.undo();
    expect((await w.snapshot()).tracks.map((t: any) => t.title)).not.toContain('Typed Track Name');
  }, 60000);

  it('a track created with no goal shows the PROMPT only to an author, never to a reader', async () => {
    // A named track with no goal was showing "what is this track for?" on its read-only page,
    // where it reads as the answer rather than as an invitation to write one.
    // The prompt is an authoring affordance: it belongs to edit mode.
    await openCreateForm(w, 'track');
    await w.page.keyboard.type('Track Without A Goal', { delay: 10 });
    await w.page.keyboard.press('Enter');
    await w.page.waitForTimeout(1200);

    const shown = async (): Promise<boolean> => (await w.page.locator('.pane.detail').innerText()).includes('what is this track for');
    // Creation LANDS in edit mode, where the prompt belongs — the author is right there.
    expect(await shown(), 'editing (straight after creation)').toBe(true);

    // Leaving edit mode is what the reader sees, and there it must be gone.
    await w.page.locator('.pane.detail .edit-toggle').first().click();
    await w.page.waitForTimeout(500);
    expect(await shown(), 'reading').toBe(false);

    await enterDetailEditing(w);
    await w.page.waitForTimeout(500);
    expect(await shown(), 'editing again').toBe(true);

    // …and clicking it opens the editor, so the prompt is not merely decorative.
    await w.page.locator('.pane.detail .editable-text', { hasText: 'what is this track for' }).first().click();
    await w.page.waitForTimeout(400);
    expect(await w.page.locator('.pane.detail textarea.goal-edit').count()).toBe(1);
    await w.page.keyboard.press('Escape');
    await w.page.waitForTimeout(300);
  }, 60000);

  it('the create form’s Create and Cancel sit on the same line', async () => {
    // `.link-btn` carries a blanket 0.9rem top margin for detail-pane action rows, which dropped
    // Cancel exactly that far below the Create beside it.
    await openCreateForm(w, 'track');
    await w.page.waitForTimeout(400);
    const mids = await w.page.evaluate(() => {
      const row = document.querySelector('.detail-actions')!;
      const mid = (sel: string) => {
        const r = row.querySelector(sel)!.getBoundingClientRect();
        return Math.round(r.top + r.height / 2);
      };
      return { create: mid('.action'), cancel: mid('.link-btn') };
    });
    expect(mids.cancel).toBe(mids.create);
  }, 60000);

  it('a source keeps BOTH its title and its url (url is identity — creation is the only chance)', async () => {
    await openCreateForm(w, 'source');
    const form = w.page.locator('.draft-form');
    await form.locator('input').nth(0).fill('Titled And Urled');
    await form.locator('input').nth(1).fill('https://example.com/smoke-source');
    await form.locator('input').nth(2).fill('A Smoke Author');
    await form.locator('.action', { hasText: 'Create' }).click();
    await w.page.waitForTimeout(1200);

    const made = (await w.snapshot()).sources.find((s: any) => s.title === 'Titled And Urled');
    expect(made).toBeDefined();
    expect(made.url).toBe('https://example.com/smoke-source');
    expect(made.author).toBe('A Smoke Author');
  }, 60000);

  it('tags typed into the create form are saved with the entity (the shared TagField)', async () => {
    await openCreateForm(w, 'concept');
    const form = w.page.locator('.draft-form');
    await form.locator('input').first().fill('Tagged At Birth');
    await form.locator('.tag-add').fill('#smoke');
    await w.page.keyboard.press('Enter');
    await w.page.waitForTimeout(200);
    await form.locator('.action', { hasText: 'Create' }).click();
    await w.page.waitForTimeout(1200);

    const g = await w.graph();
    const concept = g.nodes.find((n: any) => n.kind === 'concept' && n.label === 'Tagged At Birth');
    expect(concept).toBeDefined();
    expect(concept.tags).toContain('#smoke');
  }, 60000);

  it('a question can be tied to what raised it, at birth', async () => {
    await openCreateForm(w, 'question');
    const form = w.page.locator('.draft-form');
    await form.locator('input').first().fill('Does provenance stick?');
    await form.locator('input[list="pm-draft-sources"]').fill('Alpha Reading');
    await w.page.waitForTimeout(250);
    await form.locator('.action', { hasText: 'Create' }).click();
    await w.page.waitForTimeout(1200);

    const g = await w.graph();
    const q = g.nodes.find((n: any) => n.kind === 'question' && /provenance stick/.test(n.label));
    expect(q).toBeDefined();
    const alpha = g.nodes.find((n: any) => n.kind === 'source' && n.label === 'Alpha Reading');
    expect(g.edges.some((e: any) => e.type === 'RAISES' && e.srcId === alpha.id && e.dstId === q.id)).toBe(true);
  }, 60000);
});
