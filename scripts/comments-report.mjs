/**
 * The comment-hygiene tripwire (CONTRIBUTING.md "Comment style"): lists every comment line
 * that violates the style of record (dates, attributions, planning-doc citations, deferred-
 * work markers) — the cleanup work queue, and CI's guard that the cleanup stays done.
 *
 *   node scripts/comments-report.mjs           per-file counts + total
 *   node scripts/comments-report.mjs --list    every offending line
 *   node scripts/comments-report.mjs --check   exit 1 if any violation exists (CI mode)
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'ui/src', 'test', 'scripts'];
const EXTS = new Set(['.ts', '.tsx', '.css', '.mjs']);
const SKIP = [/\/generated\//, /\.gen\.ts$/, /node_modules/];

const CLASSES = [
  { name: 'date', re: /\b20\d{2}-\d{2}(-\d{2})?\b/ },
  { name: 'attribution', re: /\(owner\b|\bowner (ruling|report|request|decision|feedback|spec|brief|bug|regression|redesign|gap|session|hit|question)\b|\bowner,\s*20\d\d/i },
  { name: 'doc-citation', re: /\b(ROADMAP|SHIPPED|MVP\.md|STRATEGY|DATA_GOVERNANCE|ARCHITECTURE)\b|§|\bimplementation[ _]plan\b|\bplan\s+[A-Z]-[SD]\d|\b[A-Z]{1,2}-[SD]\d+\b|\b[DSTFAQPRBMC]\d{1,2}[a-z]?(\.\d+)?\b/ },
  { name: 'todo', re: /\b(TODO|FIXME)\b/ },
];

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (SKIP.some((re) => re.test(p))) continue;
    const st = statSync(p);
    if (st.isDirectory()) yield* walk(p);
    else if (EXTS.has(p.slice(p.lastIndexOf('.')))) yield p;
  }
}

/** First `//` that starts a comment — skips protocol slashes (`https://…`) in code. */
function lineCommentIndex(s) {
  for (let i = s.indexOf('//'); i !== -1; i = s.indexOf('//', i + 1)) {
    if (i === 0 || s[i - 1] !== ':') return i;
  }
  return -1;
}

/** The comment text on each line (tracks block comments across lines). */
function commentLines(source, isCss) {
  const out = [];
  let inBlock = false;
  source.split('\n').forEach((line, i) => {
    let text = '';
    let rest = line;
    if (inBlock) {
      const end = rest.indexOf('*/');
      if (end === -1) {
        text = rest;
        rest = '';
      } else {
        text = rest.slice(0, end);
        rest = rest.slice(end + 2);
        inBlock = false;
      }
    }
    while (rest !== '') {
      const block = rest.indexOf('/*');
      const lineC = isCss ? -1 : lineCommentIndex(rest);
      if (block === -1 && lineC === -1) break;
      if (lineC !== -1 && (block === -1 || lineC < block)) {
        text += ' ' + rest.slice(lineC + 2);
        break;
      }
      const end = rest.indexOf('*/', block + 2);
      if (end === -1) {
        text += ' ' + rest.slice(block + 2);
        inBlock = true;
        break;
      }
      text += ' ' + rest.slice(block + 2, end);
      rest = rest.slice(end + 2);
    }
    if (text.trim() !== '') out.push({ line: i + 1, text });
  });
  return out;
}

const list = process.argv.includes('--list');
const check = process.argv.includes('--check');
const perFile = new Map();
let total = 0;

for (const root of ROOTS) {
  for (const file of walk(root)) {
    const isCss = file.endsWith('.css');
    for (const { line, text } of commentLines(readFileSync(file, 'utf8'), isCss)) {
      // The one sanctioned cross-reference: a deliberate twin citing its copy by path.
      if (/deliberate twin/i.test(text)) continue;
      const hits = CLASSES.filter((c) => c.re.test(text)).map((c) => c.name);
      if (hits.length === 0) continue;
      total += 1;
      perFile.set(file, (perFile.get(file) ?? 0) + 1);
      if (list) console.log(`${file}:${line} [${hits.join(',')}] ${text.trim().slice(0, 120)}`);
    }
  }
}

if (!list) {
  for (const [file, n] of [...perFile.entries()].sort((a, b) => b[1] - a[1])) console.log(String(n).padStart(5), file);
}
console.log(`\n${total} comment line(s) violate the style of record across ${perFile.size} file(s).`);
if (check && total > 0) process.exit(1);
