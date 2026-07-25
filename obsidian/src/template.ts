/**
 * Source notes (owner idea, 2026-07-16): a note that acts as the learner's structured workspace
 * FOR a public source. Structure (owner ruling): ## Source (live block — header + requisites),
 * ## Questions (source-level question tokens), ## Snippets (one detailed `snippet:` fence per
 * snippet, so the user can write notes between them), ## Map (scoped embed), ## My notes.
 * Entities appear as individual markdown anchors (tokens/fences) precisely so user prose can
 * interleave them — see syncNote for why that makes resync safe. The backlink is the model's own field: the source's `personalUrl`
 * is set to this note's obsidian:// URI, so the workbench links straight back here.
 *
 * Track notes (owner idea, same day): a track becomes a FOLDER — a root track note (the
 * track chip, its concepts, the reading order as wikilinks — co-requisite sources share a
 * line, from the snapshot's PRECEDES-layered sourceLevels) plus a source note per member.
 * Sources already bound to a note anywhere in the vault are linked, never duplicated.
 *
 * Creating notes is user-triggered file creation; an existing note is opened, never rewritten.
 */
import { Notice, TFile, normalizePath } from 'obsidian';
import { api, errText } from './api';
import { EntityPickModal, NewSourceModal, SourcePickModal, type SourceRef } from './modals';
import type PhilomaticPlugin from './main';

const safeName = (t: string): string =>
  t.replace(/[\\/:*?"<>|#^[\]]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Untitled source';

interface RelationRow {
  direction: 'out' | 'in';
  type: string;
  otherId: string;
  otherKind: string;
}

interface TrackRef {
  id: string;
  title: string;
  sourceLevels: string[][];
}

/** The source's section entities: source-level questions and its snippets. */
async function sectionEntities(plugin: PhilomaticPlugin, sourceId: string): Promise<{ questions: string[]; snippets: string[] }> {
  const rel = await api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(sourceId)}`);
  return {
    questions: rel.relations.filter((r) => r.type === 'RAISES' && r.direction === 'out' && r.otherKind === 'question').map((r) => r.otherId),
    snippets: rel.relations.filter((r) => r.type === 'SNIPPET_OF' && r.direction === 'in').map((r) => r.otherId),
  };
}

const tokenPara = (ids: string[]): string => ids.map((id) => `\`pm:${id}\``).join('\n\n');

/** Detailed fence per entity (the block views) — templates use this for snippets. */
const fencePara = (kind: string, ids: string[]): string =>
  ids.map((id) => `\`\`\`philomatic\n${kind}: ${id}\n\`\`\``).join('\n\n');

/** A note already bound to this entity, anywhere in the vault — link it, never duplicate it. */
export function findBoundNote(plugin: PhilomaticPlugin, frontmatterKey: string, id: string): TFile | null {
  for (const f of plugin.app.vault.getMarkdownFiles()) {
    if (plugin.app.metadataCache.getFileCache(f)?.frontmatter?.[frontmatterKey] === id) return f;
  }
  return null;
}

async function ensureFolder(plugin: PhilomaticPlugin, path: string): Promise<void> {
  if (plugin.app.vault.getAbstractFileByPath(path) === null) {
    await plugin.app.vault.createFolder(path).catch(() => {});
  }
}

/** The obsidian:// URI for a vault file — what the source's personalUrl backlink stores. */
const noteUri = (plugin: PhilomaticPlugin, path: string): string =>
  `obsidian://open?vault=${encodeURIComponent(plugin.app.vault.getName())}&file=${encodeURIComponent(path.replace(/\.md$/, ''))}`;

/**
 * Find-or-create the source's note (binding checked vault-wide, so a moved or renamed note is
 * found, not duplicated) and refresh the personalUrl backlink to wherever it lives now.
 */
async function ensureSourceNote(plugin: PhilomaticPlugin, sourceId: string, title: string, folder: string): Promise<TFile> {
  let file: TFile | null = findBoundNote(plugin, 'philomatic-source', sourceId);
  if (!file) {
    await ensureFolder(plugin, folder);
    const path = normalizePath(`${folder}/${safeName(title)}.md`);
    const existing = plugin.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      file = existing; // a same-named note the user already has — never overwrite it
    } else {
      const { questions, snippets } = await sectionEntities(plugin, sourceId);
      const content = [
        '---',
        `philomatic-source: ${sourceId}`,
        '---',
        '',
        '## Source',
        '',
        '```philomatic',
        `source: ${sourceId}`,
        '```',
        '',
        '## Questions',
        '',
        ...(questions.length > 0 ? [tokenPara(questions), ''] : []),
        '## Snippets',
        '',
        ...(snippets.length > 0 ? [fencePara('snippet', snippets), ''] : []),
        '## Map',
        '',
        '```philomatic',
        'map: this-note',
        '```',
        '',
        '## My notes',
        '',
        '',
      ].join('\n');
      file = await plugin.app.vault.create(path, content);
    }
  }
  // The backlink: the source's personalUrl → this note (the workbench's "Open note in Obsidian").
  await api(plugin.settings, '/update', { ref: sourceId, patch: { personalUrl: noteUri(plugin, file.path) } });
  return file;
}

export async function createSourceNote(plugin: PhilomaticPlugin): Promise<void> {
  try {
    const snap = await api<{ sources: SourceRef[] }>(plugin.settings, '/snapshot');
    new SourcePickModal(plugin.app, snap.sources, (pick) => {
      if (pick === 'new') new NewSourceModal(plugin.app, plugin.settings, (id) => void generate(plugin, id)).open();
      else void generate(plugin, pick.id);
    }).open();
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

async function generate(plugin: PhilomaticPlugin, sourceId: string): Promise<void> {
  try {
    const snap = await api<{ sources: SourceRef[] }>(plugin.settings, '/snapshot');
    const title = snap.sources.find((s) => s.id === sourceId)?.title ?? sourceId;
    const folder = normalizePath(plugin.settings.sourceNotesFolder.trim() || 'Philomatic sources');
    const file = await ensureSourceNote(plugin, sourceId, title, folder);
    await plugin.app.workspace.getLeaf('tab').openFile(file);
    new Notice('Philomatic: source note ready ✓ — the library links back to it');
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

// ── Track notes: a track as a folder ────────────────────────────────────────────────────────

export async function createTrackNotes(plugin: PhilomaticPlugin): Promise<void> {
  try {
    const snap = await api<{ tracks: TrackRef[]; sources: SourceRef[] }>(plugin.settings, '/snapshot');
    if (snap.tracks.length === 0) {
      new Notice('Philomatic: no tracks in your library yet — try /pm-track-create');
      return;
    }
    const items = snap.tracks.map((s) => ({ id: s.id, label: s.title })).sort((a, b) => a.label.localeCompare(b.label));
    new EntityPickModal(plugin.app, items, 'Create notes for a track…', (pick) => {
      const syl = snap.tracks.find((s) => s.id === pick.id);
      if (syl) void generateTrack(plugin, syl, snap.sources);
    }).open();
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

const titleOf = (sources: SourceRef[], id: string): string => sources.find((s) => s.id === id)?.title ?? id;

async function generateTrack(plugin: PhilomaticPlugin, syl: TrackRef, sources: SourceRef[]): Promise<void> {
  try {
    const parent = normalizePath(plugin.settings.trackNotesFolder.trim() || 'Philomatic tracks');
    const folder = normalizePath(`${parent}/${safeName(syl.title)}`);
    await ensureFolder(plugin, parent);
    await ensureFolder(plugin, folder);

    // A source note per member, numbered in reading order ("1. <title>", so the folder sorts
    // like the track reads); co-requisites (same PRECEDES level) share a line.
    let created = 0;
    let position = 0;
    const lines: string[] = [];
    for (const level of syl.sourceLevels) {
      const names: string[] = [];
      for (const id of level) {
        position += 1;
        const before = findBoundNote(plugin, 'philomatic-source', id);
        const f = await ensureSourceNote(plugin, id, `${position}. ${titleOf(sources, id)}`, folder);
        if (!before) created += 1;
        names.push(f.basename);
      }
      if (names.length > 0) lines.push(`- ${names.map((n) => `[[${n}]]`).join(' · ')}`);
    }

    let root = findBoundNote(plugin, 'philomatic-track', syl.id);
    if (!root) {
      const rel = await api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(syl.id)}`);
      const concepts = rel.relations.filter((r) => r.type === 'INCLUDES' && r.direction === 'out' && r.otherKind === 'concept');
      const content = [
        '---',
        `philomatic-track: ${syl.id}`,
        '---',
        '',
        '## Track',
        '',
        '```philomatic',
        `track: ${syl.id}`,
        '```',
        '',
        '## Concepts',
        '',
        ...(concepts.length > 0 ? [tokenPara(concepts.map((c) => c.otherId)), ''] : []),
        '## Reading order',
        '',
        ...(lines.length > 0 ? [lines.join('\n'), ''] : []),
        '## Map',
        '',
        '```philomatic',
        'map: this-note',
        '```',
        '',
        '## My notes',
        '',
        '',
      ].join('\n');
      // "0." continues the members' reading-order numbering: the root note sorts first.
      root = await plugin.app.vault.create(normalizePath(`${folder}/0. ${safeName(syl.title)}.md`), content);
    }
    await plugin.app.workspace.getLeaf('tab').openFile(root);
    new Notice(`Philomatic: track folder ready ✓ — ${syl.sourceLevels.flat().length} source notes (${created} created)`);
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

// ── Append-only sync ───────────────────────────────────────────────────────────────────────────

/** Append-only insertion at the end of a `## heading` section (heading created at EOF if gone). */
function appendToSection(content: string, heading: string, block: string): string {
  const headingMatch = new RegExp(`^##\\s+${heading}\\b.*$`, 'm').exec(content);
  if (!headingMatch) return `${content.trimEnd()}\n\n## ${heading}\n\n${block}\n`;
  const afterHeading = headingMatch.index + headingMatch[0].length;
  const nextHeading = /^#{1,6}\s/m.exec(content.slice(afterHeading));
  const insertAt = nextHeading ? afterHeading + nextHeading.index : content.length;
  return `${content.slice(0, insertAt).replace(/\n*$/, '\n\n')}${block}\n\n${content.slice(insertAt)}`;
}

/**
 * Append-only sync (OB4 amendment, ratified 2026-07-16): bring the note up to date with the
 * server by INSERTING missing entries at the end of their sections — never delete, never
 * move, never rewrite user text. An entry found anywhere in the note counts as present (the
 * user's reorganization is respected); a missing section heading is appended at the end.
 * Tokens for entities removed server-side stay and render dashed — the user deletes the line.
 * Dispatches on the note's binding: source notes gain question/snippet tokens; track notes
 * gain concept tokens, plus source notes (created on demand) linked into the reading order.
 */
export async function syncNote(plugin: PhilomaticPlugin): Promise<void> {
  const file = plugin.app.workspace.getActiveFile();
  if (!file) {
    new Notice('Philomatic: open a Philomatic note first');
    return;
  }
  const fm = plugin.app.metadataCache.getFileCache(file)?.frontmatter;
  const sourceId = fm?.['philomatic-source'] as unknown;
  const trackId = fm?.['philomatic-track'] as unknown;
  try {
    if (typeof sourceId === 'string') await syncSourceNote(plugin, file, sourceId);
    else if (typeof trackId === 'string') await syncTrackNote(plugin, file, trackId);
    else new Notice('Philomatic: this note has no philomatic-source or philomatic-track binding');
  } catch (e) {
    new Notice(`Philomatic: ${errText(e)}`, 8000);
  }
}

const syncedNotice = (added: number): void => {
  new Notice(added > 0 ? `Philomatic: synced — ${added} new entr${added === 1 ? 'y' : 'ies'} added ✓` : 'Philomatic: note is in sync ✓');
};

async function syncSourceNote(plugin: PhilomaticPlugin, file: TFile, sourceId: string): Promise<void> {
  const { questions, snippets } = await sectionEntities(plugin, sourceId);
  let added = 0;
  await plugin.app.vault.process(file, (content) => {
    let out = content;
    for (const section of [
      { heading: 'Questions', ids: questions, block: tokenPara },
      { heading: 'Snippets', ids: snippets, block: (ids: string[]) => fencePara('snippet', ids) },
    ]) {
      // Presence = the raw id anywhere in the note (a pm: token, a fence, even prose).
      const missing = section.ids.filter((id) => !out.includes(id));
      if (missing.length === 0) continue;
      added += missing.length;
      out = appendToSection(out, section.heading, section.block(missing));
    }
    return out;
  });
  syncedNotice(added);
}

async function syncTrackNote(plugin: PhilomaticPlugin, file: TFile, trackId: string): Promise<void> {
  const snap = await api<{ tracks: TrackRef[]; sources: SourceRef[] }>(plugin.settings, '/snapshot');
  const syl = snap.tracks.find((s) => s.id === trackId);
  if (!syl) {
    new Notice(`Philomatic: ${trackId} — not in your library`);
    return;
  }
  const rel = await api<{ relations: RelationRow[] }>(plugin.settings, `/relations?id=${encodeURIComponent(trackId)}`);
  const concepts = rel.relations
    .filter((r) => r.type === 'INCLUDES' && r.direction === 'out' && r.otherKind === 'concept')
    .map((r) => r.otherId);

  // Notes first (created into this note's own folder), so the links have somewhere to point.
  // New notes get their reading-order number; existing bound notes keep their names.
  const folder = file.parent?.path ?? '';
  const names: string[] = [];
  let position = 0;
  for (const id of syl.sourceLevels.flat()) {
    position += 1;
    const f = await ensureSourceNote(plugin, id, `${position}. ${titleOf(snap.sources, id)}`, folder);
    names.push(f.basename);
  }

  let added = 0;
  await plugin.app.vault.process(file, (content) => {
    let out = content;
    const missingConcepts = concepts.filter((id) => !out.includes(`pm:${id}`));
    if (missingConcepts.length > 0) {
      added += missingConcepts.length;
      out = appendToSection(out, 'Concepts', tokenPara(missingConcepts));
    }
    const missingLinks = names.filter((n) => !new RegExp(`\\[\\[${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\]|\\||#)`).test(out));
    if (missingLinks.length > 0) {
      added += missingLinks.length;
      out = appendToSection(out, 'Reading order', missingLinks.map((n) => `- [[${n}]]`).join('\n'));
    }
    return out;
  });
  syncedNotice(added);
}
