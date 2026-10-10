/**
 * Independent check that a prose-only pass changed only prose.
 *
 * Someone claims "text only". This re-derives it: strip comments, every string
 * literal and every regex literal from both HEAD and the working copy, then
 * normalize three things that legitimately change when prose is rewritten —
 *
 *   - how many chunks a message is split across (`a` + `b` vs `a` + `b` + `c`)
 *   - trailing commas, which prettier adds or drops as a call is re-wrapped
 *   - whitespace
 *
 * If the skeletons still match, nothing but prose moved. A file with a
 * deliberate structural edit has to be declared, with its reason, as a
 * `path=reason` argument:
 *
 *   node scripts/verification/prose-only-check.mjs \
 *     tests/curriculum/guard.test.ts=added a new position shape to the scan
 *
 * The allowlist is an argument rather than a table in this file because it
 * belongs to one diff, not to the tool: an entry left behind here would still
 * be excusing a file long after the pass it was written for.
 */
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const changed = execSync('git diff --name-only', { encoding: 'utf8' })
  .split('\n')
  .filter((file) => file && /\.(ts|tsx)$/.test(file));

/** Deliberate structural edits, each declared as `path=reason` on the command line. */
const INTENTIONAL = new Map(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf('=');
    if (separator < 0) throw new Error(`expected path=reason, got: ${argument}`);
    return [argument.slice(0, separator), argument.slice(separator + 1)];
  }),
);

function strip(source) {
  let out = '';
  let i = 0;
  let previous = '';
  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (ch === '/' && /[([{,;:=!&|?+\-*%<>]|^$/.test(previous)) {
      // A regex literal: `/` after an operator or an opening bracket.
      let j = i + 1;
      let inClass = false;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        else if (source[j] === '\n') break;
        j += 1;
      }
      if (source[j] === '/') {
        i = j + 1;
        while (i < source.length && /[a-z]/.test(source[i])) i += 1;
        out += 'R';
        previous = 'R';
        continue;
      }
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      i += 1;
      while (i < source.length) {
        if (source[i] === '\\') {
          i += 2;
          continue;
        }
        if (quote === '`' && source[i] === '$' && source[i + 1] === '{') {
          // Keep the interpolated code: it is skeleton, not prose.
          let depth = 1;
          i += 2;
          const start = i;
          while (i < source.length && depth > 0) {
            if (source[i] === '{') depth += 1;
            else if (source[i] === '}') depth -= 1;
            i += 1;
          }
          out += strip(source.slice(start, i - 1));
          continue;
        }
        if (source[i] === quote) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += 'S';
      previous = 'S';
      continue;
    }
    out += ch;
    if (!/\s/.test(ch)) previous = ch;
    i += 1;
  }
  return out;
}

function skeleton(source) {
  return strip(source)
    .replace(/S(\s*\+\s*S)+/g, 'S') // one message written as several chunks
    .replace(/,\s*(?=[)\]}])/g, '') // prettier's trailing comma
    .replace(/\(\s+/g, '(') // prettier's line wrap inside a call
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A second tier for the one case whitespace normalization cannot reach: a
 * message split across a different number of literals, which moves where the
 * interpolations sit relative to the `+` signs. Removing the literals and the
 * concatenations compares the remaining code while ignoring exactly that.
 */
function looseSkeleton(source) {
  return skeleton(source).replace(/S/g, '').replace(/\+/g, '').replace(/\s+/g, ' ').trim();
}

let same = 0;
const resplit = [];
const differing = [];
for (const file of changed) {
  const head = execSync(`git show HEAD:${file}`, { encoding: 'utf8' });
  const current = readFileSync(file, 'utf8');
  if (skeleton(head) === skeleton(current)) same += 1;
  else if (looseSkeleton(head) === looseSkeleton(current)) resplit.push(file);
  else differing.push(file);
}

console.log(`changed TypeScript files: ${changed.length}`);
console.log(`skeleton identical (prose-only): ${same}`);
console.log(`differ only in how a message is split into literals: ${resplit.length}`);
for (const file of resplit) console.log(`  ok  ${file}`);
console.log(`skeleton differs: ${differing.length}`);
for (const file of differing) {
  const reason = INTENTIONAL.get(file);
  console.log(`  ${reason ? 'expected' : 'UNEXPECTED'}  ${file}${reason ? ` — ${reason}` : ''}`);
  if (!reason) {
    const a = skeleton(execSync(`git show HEAD:${file}`, { encoding: 'utf8' }));
    const b = skeleton(readFileSync(file, 'utf8'));
    let k = 0;
    while (k < a.length && k < b.length && a[k] === b[k]) k += 1;
    console.log(`      HEAD …${JSON.stringify(a.slice(Math.max(0, k - 50), k + 70))}`);
    console.log(`      WORK …${JSON.stringify(b.slice(Math.max(0, k - 50), k + 70))}`);
  }
}

const unexpected = differing.filter((file) => !INTENTIONAL.has(file));
if (unexpected.length > 0) {
  console.log(`\nUNEXPECTED structural changes: ${unexpected.length}`);
  process.exit(1);
}
console.log('\nEvery other file differs only in prose.');
