#!/usr/bin/env -S npx tsx
/**
 * Philomatic CLI (MVP.md §4) — a thin adapter over the headless
 * PhilomaticEngine. It parses argv, calls the facade, and formats output. No business
 * logic lives here; every command maps 1:1 to an engine method.
 *
 * Run via:  pnpm philomatic <command> [args]   (or ./node_modules/.bin/tsx src/cli/index.ts)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CaptureError, PhilomaticEngine, ValidationError, rekeyLearner } from '../engine';
import { buildPublicationHtml } from './export-track';

const DEFAULT_DB = '.philomatic/philomatic.sqlite';

const USAGE = `philomatic <command>

Commands:
  init                              Create the database file + schema
  import <file.json>                Desugar → validate → idempotent upsert
  reset <file.json>                 WIPE the db and reinstantiate from JSON (old store kept
                                      as a .pre-reset-* backup; event history not carried)
  validate <file.json>              Dry-run validation; print report (no writes)
  capture <url> [opts]              Remember a source (captureSource)
                                      [--title T] [--author A] [--tags a,b] [--track S]
                                      [--modality text|video|audio|interactive|other] [--no-stage]
  snippet <url> <text> [opts]       Capture a highlighted passage (captureSnippet)
                                      [--note N] [--sentiment S] [--clarifies A,B]
                                      [--contradicts A] [--raises "Q?"] [--tags a,b]
  show [<track>]                 Assembled plan; scoped to a track if given
  list <kind>                       List tracks | concepts | sources | snippets | questions | events | edges
  ask <question>                    Record an open question for the learner (ASKS)
  answer <question>                 Record that the learner answered a question (ANSWERED)
  consume <source>                  Record consuming a source (CONSUMED + event)
  track <concept>                   Follow a concept — the freshness gate (TRACKS + event)
  remove <ref>                      Remove an entity (retraction — restorable, never deleted)
  restore <ref>                     Restore a removed entity (revives owned children)
  removed                           List removed items (the trash bin)
  update <ref> [opts]               Edit non-identity fields (only provided flags change)
                                      [--title T] [--description D] [--goal G] [--framework F]
                                      [--note N] [--sentiment S] [--anchor A] [--status S]
                                      [--modality M] [--duration mins] [--locked true|false]
                                      [--personal-url U] [--bibliographic-url U]
                                      [--tags a,b (replaces)] [--aliases a,b (replaces)]
  export [--format json|mermaid]    Dump the graph (default: json)
  publish <track> [--license L]     Stamp a track published (opens /t/<id>; DATA_GOVERNANCE 2)
  unpublish <track>                 Stop distributing (copies made while public persist)
  export-track <track> [--out F]    Self-contained HTML of a PUBLISHED track (host anywhere)
  push <track> --registry <url>     Publish the track's bundle TO a registry (keypair = identity)
  unpush <track> --registry <url>   Remove it from a registry (signed challenge; copies persist)
  registry [--dir D] [--port N]     Run a track registry (no engine, no learner data — bundles only)
                                      [--demo-dist <dir>|off] serve the in-browser demo at /demo
                                      (default: ui/dist-demo if built)
  migrate-v2                        Rebuild a pre-v2 store file as model v2 (edge collapse +
                                      author-free source ids). Keeps the old file as .v1-backup.
                                      The server also runs this automatically at boot.
  rekey-learner <old> <new> [opts]  Move a learner's whole overlay to a new id (T4/A3 —
                                      lnr_default → your real id before any multi-tenant merge).
                                      Pure rewrite; never merges into an existing learner.
                                      [--out <db>] write a fresh DB (default: payload to stdout)

  <ref> = a typed id (src_… snp_… cpt_… qst_… syl_…), a URL, or a name/title/text.

Global:
  --db <path>                       SQLite file (default: ${DEFAULT_DB})
`;

/** Pull `--db <path>` out of the argument list, leaving positional/other args behind. */
function extractDbFlag(argv: string[]): { db: string; rest: string[] } {
  const rest: string[] = [];
  let db = DEFAULT_DB;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--db') {
      db = argv[i + 1] ?? DEFAULT_DB;
      i++;
    } else {
      rest.push(arg);
    }
  }
  return { db, rest };
}

function flagValue(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** Collect a list-valued flag: repeatable (`--tag a --tag b`) and comma-split (`--tags a,b`). */
function listFlag(args: string[], ...flags: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (flags.includes(args[i]!)) {
      const v = args[i + 1];
      if (v !== undefined) out.push(...v.split(',').map((s) => s.trim()).filter(Boolean));
      i++;
    }
  }
  return out;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function fail(message: string): never {
  console.error(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

async function main(): Promise<void> {
  const { db, rest } = extractDbFlag(process.argv.slice(2));
  const [command, ...args] = rest;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE);
    return;
  }

  // Wipe-and-reinstantiate (pre-Phase-2 escape hatch). The payload is validated against a
  // scratch engine FIRST — a bad file must fail before the store is touched. The old store
  // survives as a timestamped backup; event history (undo/retraction trails) is not carried.
  if (command === 'reset') {
    const file = args[0] ?? fail('reset needs <file.json> (an exported payload to reinstantiate from)');
    const raw = readJson(file);
    const probe = PhilomaticEngine.open();
    try {
      probe.importPayload(raw); // throws on a bad file — before any wipe
    } catch (e) {
      if (e instanceof ValidationError) {
        console.error(`refusing to reset — ${file} is not a valid payload:`);
        for (const err of e.report.errors) console.error(`  - [${err.code}] ${err.message}`);
        process.exit(1);
      }
      throw e;
    } finally {
      probe.close();
    }
    const { backupPath } = PhilomaticEngine.resetDb(db);
    const fresh = PhilomaticEngine.open(db);
    try {
      const p = fresh.importPayload(raw);
      console.log(
        `Reset ${db} from ${file}: ${p.concepts.length} concepts, ${p.sources.length} sources, ` +
          `${p.snippets.length} snippets, ${p.tracks.length} tracks.`,
      );
    } finally {
      fresh.close();
    }
    if (backupPath) console.log(`Old store kept at ${backupPath} (history lives there; delete it yourself when sure).`);
    console.log('If the server is running, restart it — its open handle still points at the old file.');
    return;
  }

  // Handled before the engine opens: it renames the store file out from under any open handle.
  if (command === 'migrate-v2') {
    const result = PhilomaticEngine.migrateDbV2(db);
    console.log(result.migrated ? `Migrated ${db} to model v2 (v1 copy kept at ${result.backupPath})` : `${db} is already model v2 — nothing to do`);
    return;
  }

  // The registry mode needs no engine and no database — it stores bundles only.
  if (command === 'registry') {
    const { createRegistryServer } = await import('../registry/server');
    const port = Number(flagValue(args, '--port') ?? process.env.REGISTRY_PORT ?? 4400);
    const host = flagValue(args, '--host') ?? '0.0.0.0';
    const dir = flagValue(args, '--dir') ?? '.philomatic-registry';
    const demoArg = flagValue(args, '--demo-dist') ?? process.env.REGISTRY_DEMO_DIST;
    createRegistryServer({
      dir,
      port,
      host,
      ...(demoArg === 'off' ? { demoDist: false as const } : demoArg !== undefined ? { demoDist: demoArg } : {}),
    }).listen(port, host, () => {
      console.log(`philomatic registry listening on http://${host}:${port}  (dir: ${dir})`);
    });
    return;
  }

  const engine = PhilomaticEngine.open(db);
  try {
    switch (command) {
      case 'init': {
        // openDb already applied the schema; opening the file is the initialization.
        console.log(`Initialized ${db}`);
        break;
      }

      case 'import': {
        const file = args[0] ?? fail('import needs <file.json>');
        const raw = readJson(file);
        // A publication bundle imports as a FORK (publish plan P4): lineage recorded, parent
        // bundle archived beside the DB. Anything else is the ordinary payload path.
        if (typeof raw === 'object' && raw !== null && 'pubVersion' in raw) {
          const originFlag = args.indexOf('--origin');
          const forked = engine.importPublication(raw, originFlag >= 0 ? { originUrl: args[originFlag + 1] } : {});
          console.log(`Forked "${forked.title}" (${forked.trackId}) — lineage recorded, parent bundle archived.`);
          break;
        }
        const p = engine.importPayload(raw);
        console.log(
          `Imported: ${p.concepts.length} concepts, ${p.sources.length} sources, ` +
            `${p.edges.length} edges, ${p.learners.length} learners.`,
        );
        break;
      }

      case 'publish': {
        const ref = args[0] ?? fail('publish needs <track> (title or syl_ id)');
        const i = args.indexOf('--license');
        const result = engine.publish({ ref, ...(i >= 0 ? { license: args[i + 1] } : {}) });
        console.log(result.changed ? `Published ${result.targetId} — public at /t/${result.targetId}` : `${result.targetId} was already published (the original stamp stands)`);
        break;
      }

      case 'unpublish': {
        const ref = args[0] ?? fail('unpublish needs <track>');
        const result = engine.unpublish({ ref });
        console.log(result.changed ? `Unpublished ${result.targetId} — distribution stopped (copies made while public persist)` : `${result.targetId} was not published`);
        break;
      }

      case 'export-track': {
        const ref = args[0] ?? fail('export-track needs <track> (title or syl_ id)');
        const bundle = engine.publication(ref);
        if (!bundle) fail(`"${ref}" is not published — run: philomatic publish "${ref}"`);
        const outFlag = args.indexOf('--out');
        const out = outFlag >= 0 ? args[outFlag + 1]! : `${bundle.publication.trackId}.html`;
        const dist = fileURLToPath(new URL('../../ui/dist', import.meta.url));
        writeFileSync(out, buildPublicationHtml(bundle, dist));
        console.log(`Wrote ${out} — one self-contained file (license ${bundle.publication.license}); host it anywhere.`);
        break;
      }

      case 'push': {
        const ref = args[0] ?? fail('push needs <track> (title or syl_ id)');
        const ri = args.indexOf('--registry');
        const registry = (ri >= 0 ? args[ri + 1] : process.env.PHILOMATIC_REGISTRY) ?? fail('push needs --registry <url> (or PHILOMATIC_REGISTRY)');
        const bundle = engine.publication(ref);
        if (!bundle) fail(`"${ref}" is not published — run: philomatic publish "${ref}"`);
        const res = await fetch(`${registry.replace(/\/$/, '')}/publish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(bundle),
        });
        const out = (await res.json().catch(() => ({}))) as { error?: string; url?: string; updated?: boolean };
        if (!res.ok) fail(`registry refused (${res.status}): ${out.error ?? 'unknown error'}`);
        console.log(`${out.updated ? 'Updated' : 'Published'} on the registry — ${registry.replace(/\/$/, '')}${out.url}`);
        break;
      }

      case 'unpush': {
        const ref = args[0] ?? fail('unpush needs <track>');
        const ri = args.indexOf('--registry');
        const registry = (ri >= 0 ? args[ri + 1] : process.env.PHILOMATIC_REGISTRY) ?? fail('unpush needs --registry <url> (or PHILOMATIC_REGISTRY)');
        const base = registry.replace(/\/$/, '');
        // The challenge covers the registry's CURRENT hash for the track — fetch it, sign it.
        const idxRes = await fetch(`${base}/index.json`);
        const idx = (await idxRes.json()) as { tracks: { trackId: string; title: string; contentHash: string }[] };
        const entry = idx.tracks.find((t) => t.trackId === ref || t.title === ref) ?? fail(`"${ref}" is not on that registry`);
        const { signature } = engine.authorSign(`unpublish:${entry.trackId}:${entry.contentHash}`);
        const res = await fetch(`${base}/unpublish`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ trackId: entry.trackId, signature }),
        });
        const out = (await res.json().catch(() => ({}))) as { error?: string };
        if (!res.ok) fail(`registry refused (${res.status}): ${out.error ?? 'unknown error'}`);
        console.log(`Removed ${entry.trackId} from the registry (versions already fetched persist).`);
        break;
      }

      case 'validate': {
        const file = args[0] ?? fail('validate needs <file.json>');
        const report = engine.validate(readJson(file));
        if (report.ok) {
          console.log('✓ valid');
        } else {
          console.log(`✗ ${report.errors.length} error(s):`);
          for (const e of report.errors) console.log(`  - [${e.code}] ${e.message}`);
          process.exitCode = 1;
        }
        for (const w of report.warnings) console.log(`  ⚠ [${w.code}] ${w.message}`);
        break;
      }

      case 'capture': {
        const url = args[0] ?? fail('capture needs <url>');
        const result = engine.captureSource({
          url,
          title: flagValue(args, '--title'),
          author: flagValue(args, '--author'),
          tags: listFlag(args, '--tag', '--tags'),
          modality: flagValue(args, '--modality'),
          track: flagValue(args, '--track'),
          stage: !args.includes('--no-stage'),
        });
        console.log(
          `${result.created ? 'Remembered' : 'Already had'}: ${result.sourceId}` +
            `${result.staged ? ' (staged)' : ''}`,
        );
        break;
      }

      case 'snippet': {
        const url = args[0] ?? fail('snippet needs <url> <text>');
        const text = args[1];
        if (!text || text.startsWith('--')) fail('snippet needs <url> <text>');
        const result = engine.captureSnippet({
          url,
          text,
          note: flagValue(args, '--note'),
          sentiment: flagValue(args, '--sentiment'),
          clarifies: listFlag(args, '--clarifies'),
          contradicts: listFlag(args, '--contradicts'),
          raises: listFlag(args, '--raises'),
          tags: listFlag(args, '--tag', '--tags'),
        });
        const extras = [
          result.annotated ? 'annotated' : '',
          result.raised > 0 ? `${result.raised} question(s)` : '',
        ].filter(Boolean).join(', ');
        console.log(
          `${result.created ? 'Captured' : 'Already had'}: ${result.snippetId}` +
            `${extras ? ` (${extras})` : ''}`,
        );
        break;
      }

      case 'ask':
      case 'answer': {
        const question = args[0] ?? fail(`${command} needs <question>`);
        if (command === 'ask') engine.ask(question);
        else engine.answer(question);
        console.log(`${command === 'ask' ? 'Asked' : 'Answered'}: "${question}"`);
        break;
      }

      case 'consume': {
        const src = args[0] ?? fail('consume needs <source>');
        engine.consume(src);
        console.log(`Consumed: "${src}"`);
        break;
      }

      case 'track': {
        const concept = args[0] ?? fail('track needs <concept>');
        engine.track(concept);
        console.log(`Tracking: "${concept}"`);
        break;
      }

      case 'remove':
      case 'restore': {
        const ref = args[0] ?? fail(`${command} needs <ref>`);
        const result = command === 'remove' ? engine.remove({ ref }) : engine.restore({ ref });
        if (!result.changed) {
          console.log(command === 'remove' ? `Already removed: ${result.targetId}` : `Already live: ${result.targetId}`);
        } else {
          console.log(`${command === 'remove' ? 'Removed' : 'Restored'} ${result.kind}: ${result.targetId}`);
        }
        break;
      }

      case 'removed': {
        const items = engine.removed();
        if (items.length === 0) console.log('(nothing removed)');
        for (const item of items) {
          console.log(`${new Date(item.removedAt).toISOString()}  ${item.kind}  ${item.id}  ${item.label}`);
          for (const dep of item.hides) console.log(`    ↳ hides ${dep.kind} ${dep.id}  ${dep.label}`);
        }
        break;
      }

      case 'update': {
        const ref = args[0] ?? fail('update needs <ref>');
        const patch: Record<string, unknown> = {};
        const set = (key: string, v: unknown): void => {
          if (v !== undefined) patch[key] = v;
        };
        set('title', flagValue(args, '--title'));
        set('description', flagValue(args, '--description'));
        set('goal', flagValue(args, '--goal'));
        set('framework', flagValue(args, '--framework'));
        set('note', flagValue(args, '--note'));
        set('sentiment', flagValue(args, '--sentiment'));
        set('anchor', flagValue(args, '--anchor'));
        set('status', flagValue(args, '--status'));
        set('modality', flagValue(args, '--modality'));
        set('personalUrl', flagValue(args, '--personal-url'));
        set('bibliographicUrl', flagValue(args, '--bibliographic-url'));
        const duration = flagValue(args, '--duration');
        if (duration !== undefined) patch.estimatedDurationMins = Number(duration);
        const locked = flagValue(args, '--locked');
        if (locked !== undefined) patch.locked = locked === 'true';
        const tags = listFlag(args, '--tag', '--tags');
        if (tags.length > 0) patch.tags = tags;
        const aliases = listFlag(args, '--alias', '--aliases');
        if (aliases.length > 0) patch.aliases = aliases;
        if (Object.keys(patch).length === 0) fail('update needs at least one field flag');

        const result = engine.update({ ref, patch });
        console.log(result.changed ? `Updated ${result.kind}: ${result.targetId}` : `No change: ${result.targetId} already matches`);
        break;
      }

      case 'show': {
        // Pass the raw reference (title or syl_ id); the engine resolves it — no ids derived here.
        const ref = args[0];
        const r = engine.assemble(ref);

        if (ref) console.log(`Track: ${r.title ?? r.trackId}`);
        if (r.total > 0) {
          console.log(
            `Concepts — ${r.total} (${r.answeredCount} answered) · ` +
              `Questions — ${r.openQuestions.length} open, ${r.corpusGaps.length} gap`,
          );
          r.levels.forEach((level, i) => {
            console.log(`  Level ${i + 1}:`);
            for (const n of level) {
              const following = n.following ? ' ★following' : '';
              const engaged =
                n.lastEngagedAt !== undefined
                  ? ` · last engaged ${new Date(n.lastEngagedAt).toISOString().slice(0, 10)}`
                  : '';
              console.log(`    ${n.answered ? '✔' : '○'} ${n.name}${following}${engaged}`);
              for (const s of n.sources) console.log(`        ${s.consumed ? '✔' : '○'} ${s.title}`);
              for (const sn of n.snippets) {
                const mark = sn.relation === 'clarifies' ? '✎' : '⚠';
                const meta = [sn.sentiment && `#${sn.sentiment}`, sn.note].filter(Boolean).join(' — ');
                console.log(`        ${mark} "${sn.text}"${meta ? `  (${meta})` : ''}`);
              }
              for (const q of n.questions) {
                const flag = q.answered ? '✓' : q.asked ? '?' : '·';
                const tags = [q.asked && !q.answered ? 'open' : '', q.gap ? 'gap' : ''].filter(Boolean).join(',');
                console.log(`        ${flag} ${q.text}${tags ? `  [${tags}]` : ''}`);
              }
            }
          });
        }
        if (r.corpusGaps.length > 0) {
          console.log(`Information gaps — ${r.corpusGaps.length} question(s) no source answers:`);
          for (const q of r.corpusGaps) console.log(`    ? ${q.text}`);
        }
        if (r.sourceOrder.length > 0) {
          console.log('Reading order:');
          r.sourceOrder.forEach((level, i) => {
            console.log(`  Step ${i + 1}:`);
            for (const s of level) console.log(`    ${s.consumed ? '✔' : '○'} ${s.title}`);
          });
        }
        if (r.total === 0 && r.sourceOrder.length === 0) console.log('(empty)');
        break;
      }

      case 'list': {
        const kind = args[0] ?? fail('list needs <kind> (tracks|concepts|sources|snippets|questions|events|edges)');
        const p = engine.exportAll();
        switch (kind) {
          case 'tracks':
            for (const s of p.tracks) console.log(`${s.id}  ${s.title}`);
            break;
          case 'concepts':
            for (const c of p.concepts) console.log(`${c.id}  ${c.name}`);
            break;
          case 'sources':
            for (const s of p.sources) console.log(`${s.id}  ${s.title}`);
            break;
          case 'snippets':
            for (const s of p.snippets) console.log(`${s.id}  [${s.sourceId}]  ${s.text}`);
            break;
          case 'questions':
            for (const q of p.questions) console.log(`${q.id}  ${q.text}`);
            break;
          case 'events':
            for (const ev of p.events) {
              console.log(`${new Date(ev.occurredAt).toISOString()}  ${ev.learnerId} ${ev.verb} ${ev.targetId}`);
            }
            break;
          case 'edges':
            for (const e of p.edges) {
              const ctx = e.trackContextId ? `  @${e.trackContextId}` : '';
              console.log(`${e.srcId} -${e.type}-> ${e.dstId}${ctx}`);
            }
            break;
          default:
            fail(`unknown list kind "${kind}" (tracks|concepts|sources|snippets|questions|events|edges)`);
        }
        break;
      }

      case 'export': {
        const format = flagValue(args, '--format') ?? 'json';
        if (format === 'mermaid') console.log(engine.exportMermaid());
        else if (format === 'json') console.log(JSON.stringify(engine.exportAll(), null, 2));
        else fail(`unknown export format "${format}" (json | mermaid)`);
        break;
      }

      // Pure payload rewrite (rekey never mutates the source DB — upsert is append-only, so an
      // in-place rekey would leave the old learner's rows beside the new ones).
      case 'rekey-learner': {
        const oldId = args[0] ?? fail('rekey-learner needs <old> <new>');
        const newId = args[1] ?? fail('rekey-learner needs <old> <new>');
        const migrated = rekeyLearner(engine.exportAll(), oldId, newId);
        const out = flagValue(args, '--out');
        if (out) {
          const target = PhilomaticEngine.open(out);
          target.importPayload(migrated);
          target.close();
          console.log(`rekeyed ${oldId} → ${newId} into ${out}`);
        } else {
          console.log(JSON.stringify(migrated, null, 2));
        }
        break;
      }

      default:
        fail(`unknown command: ${command}`);
    }
  } catch (err) {
    if (err instanceof ValidationError || err instanceof CaptureError) {
      console.error(err.message);
      process.exitCode = 1;
    } else {
      throw err;
    }
  } finally {
    engine.close();
  }
}

void main();
