/**
 * The crop page's logic (see crop.html for why this is a full tab and not the popup): read the
 * pending screenshot, let the learner drag a box at the page's TRUE on-screen size, crop at the
 * screenshot's native resolution, and append the `![captured region](data:image/png…)` token to
 * the originating page's draft — the same per-URL draft the popup reads, so reopening the popup
 * shows the snippet ready to save.
 */

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

interface PendingCrop {
  img: string;
  draftKey: string;
  tabId?: number;
}

const stage = el<HTMLDivElement>('stage');
const shot = el<HTMLImageElement>('shot');
const rect = el<HTMLDivElement>('rect');
const use = el<HTMLButtonElement>('use');

let sel: { x: number; y: number; w: number; h: number } | undefined;
let start: { x: number; y: number } | undefined;

/** Selection coords in the image's DISPLAYED box, clamped to it; the stage may scroll. */
const pos = (e: PointerEvent): { x: number; y: number } => {
  const r = shot.getBoundingClientRect();
  return {
    x: Math.min(Math.max(e.clientX - r.left, 0), r.width),
    y: Math.min(Math.max(e.clientY - r.top, 0), r.height),
  };
};

stage.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  stage.setPointerCapture(e.pointerId);
  start = pos(e);
});
stage.addEventListener('pointermove', (e) => {
  if (!start) return;
  const p = pos(e);
  sel = { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), w: Math.abs(p.x - start.x), h: Math.abs(p.y - start.y) };
  rect.style.left = `${sel.x}px`;
  rect.style.top = `${sel.y}px`;
  rect.style.width = `${sel.w}px`;
  rect.style.height = `${sel.h}px`;
  rect.hidden = false;
});
stage.addEventListener('pointerup', () => {
  start = undefined;
  use.disabled = !(sel && sel.w > 4 && sel.h > 4);
});

async function main(): Promise<void> {
  const stored = (await chrome.storage.session.get('pendingCrop')) as { pendingCrop?: PendingCrop };
  const pending = stored.pendingCrop;
  if (!pending) {
    el('hint').textContent = 'Nothing to crop — use “Capture region” in the popup first.';
    return;
  }
  shot.src = pending.img;
  shot.addEventListener('load', () => {
    // Render at the tab's true on-screen size (screenshots come in device pixels): 1:1 with
    // what the learner was just reading, scrollable if the window is smaller.
    shot.style.width = `${shot.naturalWidth / window.devicePixelRatio}px`;
  });

  const done = async (): Promise<void> => {
    await chrome.storage.session.remove('pendingCrop');
    if (pending.tabId !== undefined) await chrome.tabs.update(pending.tabId, { active: true }).catch(() => undefined);
    // Chrome 127+: reopen the popup so the flow ends where it started; older Chrome — the
    // toolbar icon is one click away and the draft is waiting either way.
    try {
      await chrome.action.openPopup();
    } catch {
      /* the draft survives; the learner clicks the icon */
    }
    const me = await chrome.tabs.getCurrent();
    if (me?.id !== undefined) void chrome.tabs.remove(me.id);
  };

  el('cancel').addEventListener('click', () => void done());
  use.addEventListener('click', () => {
    if (!sel) return;
    void (async () => {
      // Crop at native resolution; cap at 1600px wide so a full-page grab can't bloat the export.
      const scale = shot.naturalWidth / shot.getBoundingClientRect().width;
      const w = Math.round(sel!.w * scale);
      const h = Math.round(sel!.h * scale);
      const shrink = Math.min(1, 1600 / w);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * shrink));
      canvas.height = Math.max(1, Math.round(h * shrink));
      canvas.getContext('2d')!.drawImage(shot, sel!.x * scale, sel!.y * scale, w, h, 0, 0, canvas.width, canvas.height);

      // Append to the originating page's draft (the popup's restore fills SnippetDraft
      // defaults over a bare `{ text }`).
      const draftStore = await chrome.storage.session.get(pending.draftKey);
      const draft = (draftStore[pending.draftKey] ?? {}) as { snippets?: { text: string }[] };
      draft.snippets = [...(draft.snippets ?? []), { text: `![captured region](${canvas.toDataURL('image/png')})` }];
      await chrome.storage.session.set({ [pending.draftKey]: draft });
      await done();
    })();
  });
}

void main();
