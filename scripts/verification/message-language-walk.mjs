/**
 * Live check: the curriculum API answers a person in Chinese, and a caller in
 * identifiers.
 *
 * Runs against a running dev server. Every message a human reads must contain
 * Chinese; every machine-readable value (`code`, `details.*`, phase names, enum
 * values) must stay exactly as it was. Both halves are asserted, because the
 * policy is "translate the prose, not the protocol" and a check that only
 * looked for Chinese would pass on an API that had translated its error codes.
 *
 * Usage: node scripts/verification/message-language-walk.mjs [baseUrl]
 */
const BASE = process.argv[2] ?? 'http://localhost:3000';

const CJK = /[\u3400-\u9fff]/;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`ok   ${name}`);
  } else {
    failures.push(name);
    console.log(`FAIL ${name}${detail === undefined ? '' : ` — ${detail}`}`);
  }
}

/** A message a person reads: has Chinese, and no English sentence of its own. */
function isHumanChinese(text) {
  if (typeof text !== 'string' || !CJK.test(text)) return false;
  const englishWords = text
    .split(/[\s,;:]+/)
    .filter((word) => /^[A-Za-z]{3,}$/.test(word));
  // Field names and enum values are allowed to survive; a sentence is not.
  return englishWords.length <= 3;
}

// ── A cookie jar, because the owner is carried in a cookie ───────────────────
let cookie = '';

async function call(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) {
    const pair = setCookie.split(';')[0];
    if (pair.startsWith('anonymous_id=')) cookie = pair;
  }
  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  return { status: response.status, payload };
}

// ── 1. Route-level refusal names the field, in Chinese ───────────────────────
{
  const { status, payload } = await call('POST', '/api/curriculum/series', {});
  check('series create refuses with 400', status === 400, `got ${status}`);
  check(
    'refusal keeps the machine code',
    payload?.error?.code === 'CURRICULUM_INVALID',
    JSON.stringify(payload),
  );
  const message = payload?.error?.message;
  check('refusal message is Chinese', isHumanChinese(message), String(message));
  check('refusal still names the field', String(message).includes('name'), String(message));
}

// ── 2. A body that is not JSON ───────────────────────────────────────────────
{
  const response = await fetch(`${BASE}/api/curriculum/series`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not-json',
  });
  const payload = await response.json().catch(() => null);
  check('non-JSON body refuses with 400', response.status === 400, `got ${response.status}`);
  check(
    'non-JSON refusal is Chinese',
    isHumanChinese(payload?.error?.message),
    String(payload?.error?.message),
  );
}

// ── 3. The phase gaps, which is the line the author actually acts on ─────────
let taskId = null;
{
  const { status, payload } = await call('POST', '/api/curriculum/design/tasks', {
    title: '中文消息校验',
  });
  taskId = payload?.task?.id ?? null;
  check('design task created', status === 201 && taskId !== null, `${status} ${JSON.stringify(payload)}`);
}

if (taskId) {
  const { payload } = await call('GET', `/api/curriculum/design/tasks/${taskId}/phase`);
  const gaps = payload?.gaps ?? [];
  check('the incomplete brief reports gaps', gaps.length > 0, JSON.stringify(payload));
  check(
    'every gap is Chinese',
    gaps.length > 0 && gaps.every(isHumanChinese),
    JSON.stringify(gaps),
  );
  check(
    'the gap names what is missing, not just the phase',
    gaps.join(' ').includes('授课对象'),
    JSON.stringify(gaps),
  );
  check('phase names stay machine-readable', payload?.phase === 'task', String(payload?.phase));
  check('next phase stays machine-readable', payload?.nextPhase === 'outcomes', String(payload?.nextPhase));

  // ── 4. Both refusals of the phase machine share one shape ─────────────────
  const advance = await call('POST', `/api/curriculum/design/tasks/${taskId}/phase`);
  check('advancing early refuses with 409', advance.status === 409, `got ${advance.status}`);
  check(
    'the refusal keeps its code',
    advance.payload?.error?.code === 'CURRICULUM_DESIGN_PHASE_LOCKED',
    JSON.stringify(advance.payload),
  );
  check(
    'the phase pair stays machine-readable',
    advance.payload?.error?.details?.current === 'task' &&
      advance.payload?.error?.details?.required === 'outcomes',
    JSON.stringify(advance.payload?.error?.details),
  );
  check(
    'the refusal message is Chinese',
    isHumanChinese(advance.payload?.error?.message),
    String(advance.payload?.error?.message),
  );

  // ── 5. A write that belongs to a later phase, refused the same way ────────
  const early = await call('POST', `/api/curriculum/design/tasks/${taskId}/objectives`, {
    title: '提前写入的目标',
    objectiveType: 'skill',
  });
  check('a write ahead of the phase refuses with 409', early.status === 409, `got ${early.status}`);
  check(
    'it carries the same code and pair',
    early.payload?.error?.code === 'CURRICULUM_DESIGN_PHASE_LOCKED' &&
      early.payload?.error?.details?.required === 'outcomes',
    JSON.stringify(early.payload?.error),
  );

  // ── 6. Field validation inside a design route ────────────────────────────
  const badObjective = await call('POST', `/api/curriculum/design/tasks`, {});
  check(
    'a body missing its title names title',
    String(badObjective.payload?.error?.message).includes('title'),
    JSON.stringify(badObjective.payload),
  );

  // ── 7. The export gate, which is the only explanation of "cannot ship" ───
  const gate = await call('GET', `/api/curriculum/design/tasks/${taskId}/export-gate`);
  const blockers = gate.payload?.blockers ?? [];
  check('the export gate refuses', gate.payload?.exportable === false, JSON.stringify(gate.payload));
  check(
    'every blocker is Chinese',
    blockers.length > 0 && blockers.every(isHumanChinese),
    JSON.stringify(blockers),
  );

  // ── 8. A missing row answers 404 in Chinese, with the code unchanged ─────
  const missing = await call('GET', '/api/curriculum/design/tasks/does-not-exist-at-all/phase');
  check('a missing task answers 404', missing.status === 404, `got ${missing.status}`);
  check(
    'the missing-task answer is Chinese',
    isHumanChinese(missing.payload?.error?.message),
    String(missing.payload?.error?.message),
  );
  check(
    'the missing-task answer keeps its code',
    missing.payload?.error?.code === 'CURRICULUM_DESIGN_NOT_FOUND',
    JSON.stringify(missing.payload?.error),
  );
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  console.log(failures.join('\n'));
  process.exit(1);
}
