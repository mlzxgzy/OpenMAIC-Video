/**
 * Every API message a person can read must be in Chinese.
 *
 * The product decision is that the curriculum API speaks to a human: these
 * strings are rendered verbatim in the workspace, and a teacher who cannot read
 * English has them as the only explanation of what is wrong. That makes this a
 * text policy rather than a behaviour, and a text policy cannot be enforced by
 * testing behaviour — a rule that only fires on data no test builds would stay
 * silently English forever.
 *
 * So this scans the *source* for the positions where a human-facing message is
 * written. The files are discovered by directory rather than listed by hand, so
 * a message added in a new module is covered without touching this test; a
 * hand-written list would be exactly the kind of thing that silently stops
 * covering the file someone forgot to add.
 *
 * A position is the second thing that is recognised by shape, not by file:
 *
 *   - `message:` in an object literal whose value is a string literal — a
 *     passthrough such as `message: row.message` carries data that was already
 *     stored, so it is skipped, which is why the check keys on the next
 *     character rather than on the property name
 *   - `.push('...')` — the phase gaps and the export blockers
 *   - `throw new <Something>Error('...')` — the stores' typed refusals
 *   - `curriculumJsonError(status, code, '...')` — the route-level failures
 *
 * Deliberately out of scope: text inside `${...}` interpolations (identifiers
 * and author data), developer-facing `console.*` output, error `code` values
 * and SQL. Author data is therefore allowed to be English — an objective titled
 * "Understand SQL injection" is the author's own text and must be echoed
 * unchanged — which is also why the check is "has Chinese", not "has no
 * English".
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { CURRICULUM_AUDIT_RULES, CURRICULUM_QUALITY_LAYERS } from '@/lib/curriculum/audit';
import { CURRICULUM_QUALITY_LAYER_LABELS } from '@/lib/curriculum/quality-labels';

const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Directories whose strings can reach a learner or an author through the API. */
const MESSAGE_ROOTS = ['lib/curriculum', 'lib/server/curriculum', 'app/api/curriculum'];

/**
 * A module whose strings are a prompt for the generation model, not a message
 * for a person. Excluded deliberately: its language decides what the model
 * writes, so rewriting it is a content-generation change, not a UI translation,
 * and it is out of scope for this policy. It is named here rather than matched
 * by shape because a bare English sentence there is *correct*.
 */
const PROMPT_MODULES = new Set(['lib/server/curriculum/unit-role-run.ts']);

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/;

/**
 * Whether a literal is untranslated prose.
 *
 * Two kinds of literal sit at these positions without being a message of their
 * own, and flagging them would make the policy test cry wolf until someone
 * "fixed" it by adding Chinese that does not belong:
 *
 *   - a machine token — `teach_covers`, an error code, or a payload path such
 *     as `items[${index}]: `, whose remaining prose is interpolated
 *   - a template made only of interpolations, such as `${reason}${named}`,
 *     which inherits the language of the values it composes
 *
 * Both read as a single word. English prose reads as more than one, which is
 * what this counts — so the rule needs no list of exceptions.
 */
function isUntranslatedProse(text: string): boolean {
  if (CJK.test(text)) return false;
  const words = text.split(/\s+/).filter((word) => /[A-Za-z]{2,}/.test(word));
  return words.length >= 2;
}

interface Literal {
  file: string;
  line: number;
  text: string;
}

function discoverModules(): string[] {
  const files: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(resolve(repositoryRoot, directory), { withFileTypes: true })) {
      const child = `${directory}/${entry.name}`;
      if (entry.isDirectory()) walk(child);
      else if (entry.name.endsWith('.ts') && !PROMPT_MODULES.has(child)) files.push(child);
    }
  };
  for (const root of MESSAGE_ROOTS) walk(root);
  return files.sort();
}

/** Read the string literal starting at `index`, or `null` if one does not. */
function readLiteral(source: string, index: number): { text: string; end: number } | null {
  const quote = source[index];
  if (quote !== "'" && quote !== '"' && quote !== '`') return null;
  let i = index + 1;
  let text = '';
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\\') {
      text += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (quote === '`' && ch === '$' && source[i + 1] === '{') {
      // An interpolation holds code, not prose. Skip it, contributing nothing:
      // the identifiers inside it are meant to stay as they are.
      let depth = 1;
      i += 2;
      while (i < source.length && depth > 0) {
        if (source[i] === '{') depth += 1;
        else if (source[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    if (ch === quote) return { text, end: i + 1 };
    text += ch;
    i += 1;
  }
  return null;
}

/** The top-level argument spans of the call whose `(` is at `openParen`. */
function callArguments(source: string, openParen: number): { start: number; end: number }[] {
  const spans: { start: number; end: number }[] = [];
  let depth = 0;
  let start = openParen + 1;
  let i = openParen + 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      i = readLiteral(source, i)?.end ?? i + 1;
      continue;
    }
    if (ch === '(' || ch === '[' || ch === '{') depth += 1;
    else if (ch === ')' || ch === ']' || ch === '}') {
      if (depth === 0 && ch === ')') {
        spans.push({ start, end: i });
        return spans;
      }
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      spans.push({ start, end: i });
      start = i + 1;
    }
    i += 1;
  }
  return spans;
}

/**
 * The literal an argument span is made of, or `null` when the span is a larger
 * expression (`error.message`, a ternary) rather than a string.
 */
function literalArgument(
  source: string,
  span: { start: number; end: number } | undefined,
): string | null {
  if (!span) return null;
  let start = span.start;
  while (start < span.end && /\s/.test(source[start])) start += 1;
  const literal = readLiteral(source, start);
  if (!literal) return null;
  let rest = literal.end;
  while (rest < span.end && /\s/.test(source[rest])) rest += 1;
  return rest === span.end ? literal.text : null;
}

function collectLiterals(file: string): Literal[] {
  const source = readFileSync(resolve(repositoryRoot, file), 'utf8');
  const found: Literal[] = [];
  const at = (index: number, text: string | null) => {
    if (text === null) return;
    found.push({ file, line: source.slice(0, index).split('\n').length, text });
  };
  const openParenOf = (match: RegExpMatchArray) => match.index! + match[0].length - 1;

  for (const match of source.matchAll(/\bmessage:/g)) {
    let i = match.index! + match[0].length;
    while (i < source.length && /\s/.test(source[i])) i += 1;
    at(match.index!, readLiteral(source, i)?.text ?? null);
  }

  for (const match of source.matchAll(/\.push\(/g)) {
    at(match.index!, literalArgument(source, callArguments(source, openParenOf(match))[0]));
  }

  for (const match of source.matchAll(/throw new \w*Error\(/g)) {
    at(match.index!, literalArgument(source, callArguments(source, openParenOf(match))[0]));
  }

  for (const match of source.matchAll(/\bcurriculumJsonError\(/g)) {
    at(match.index!, literalArgument(source, callArguments(source, openParenOf(match))[2]));
  }

  return found;
}

describe('human-facing API messages', () => {
  const modules = discoverModules();
  const literals = modules.flatMap(collectLiterals);
  const english = literals.filter((literal) => isUntranslatedProse(literal.text));

  it('discovers the modules and scans a meaningful number of message positions', () => {
    // Guards the guard: a marker that silently stopped matching would make the
    // policy test below pass by checking nothing at all.
    expect(modules.length).toBeGreaterThanOrEqual(30);
    expect(literals.length).toBeGreaterThanOrEqual(150);
  });

  it('writes every one of them in Chinese', () => {
    expect(english.map((literal) => `${literal.file}:${literal.line}  ${literal.text}`)).toEqual(
      [],
    );
  });

  it('keeps the machine-readable identifiers in English', () => {
    // The other half of the policy: a person reads the message, a caller reads
    // these. Translating either one breaks the other.
    expect(CURRICULUM_AUDIT_RULES.length).toBeGreaterThan(0);
    for (const rule of CURRICULUM_AUDIT_RULES) expect(rule).toMatch(/^[a-z_]+$/);
  });
});

describe('quality layer labels', () => {
  it('names every layer a person can be shown', () => {
    for (const layer of CURRICULUM_QUALITY_LAYERS) {
      const label = CURRICULUM_QUALITY_LAYER_LABELS[layer];
      expect(label, layer).toBeTruthy();
      expect(label, layer).toMatch(CJK);
    }
    expect(Object.keys(CURRICULUM_QUALITY_LAYER_LABELS).sort()).toEqual(
      [...CURRICULUM_QUALITY_LAYERS].sort(),
    );
  });
});
