/**
 * Live verification of the hands-on-task form, in a real browser.
 *
 * The unit suite pins the mapping (kind → condition field) and the exam rule
 * against PGlite. This pins what neither can: that a person can create a lab
 * task from the page, with the record the server actually wants, without ever
 * typing an id.
 *
 * Four things are asserted:
 *
 * 1. **The gate closes and reopens with a visible reason.** At `graph` the lab
 *    section's create control is disabled and the page says which phase to
 *    reach; advancing the task behind the editor's back and pressing 刷新 opens
 *    it. That refresh reaches this section too, which is the plumbing that made
 *    the older workbench permanently stuck.
 * 2. **The practice path stores the rule where the grader reads it.** A
 *    `file_read` whose target went into `value` stores cleanly and never
 *    matches, so the assertion is on the stored JSONB key, not on the form.
 * 3. **The exam path is accepted as the form submits it.** Choosing 考试 submits
 *    hints-forbidden / no-retry / a clock, because those are the only values
 *    `curriculum_lab_exam_strict` accepts. Built naively, the same click would
 *    be refused by the server — this is the check that the control cannot
 *    produce a body the server rejects.
 * 4. **The loop closes.** `evidence_no_artifact` fires for lab evidence with no
 *    lab task; creating the lab through the form is the only way to clear it
 *    from the browser, so the finding is asserted gone on the server afterwards.
 *
 * The seed deliberately stops at `graph` before opening the page, then continues
 * to `assessment` after, so the gate is observed closed and open on one task.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';

const browser = await chromium.launch().catch(async (error) => {
  console.log(`bundled chromium failed (${error.message.split('\n')[0]}); trying system chrome`);
  return chromium.launch({ channel: 'chrome' });
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 } });
const page = await context.newPage();

const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

let passed = 0;
let failed = 0;
function check(label, ok, detail = '') {
  if (ok) {
    passed += 1;
    console.log(`PASS  ${label}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function api(method, path, body) {
  const response = await context.request.fetch(BASE + path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: response.status(), body: parsed };
}

function must(label, result, want) {
  const ok = Array.isArray(want) ? want.includes(result.status) : result.status === want;
  if (!ok) {
    console.log(`FAIL  ${label} -> ${result.status} ${JSON.stringify(result.body).slice(0, 400)}`);
    throw new Error(`seed step failed: ${label}`);
  }
  passed += 1;
  console.log(`PASS  ${label} -> ${result.status}`);
  return result.body;
}

/**
 * Open one Radix `Select` in the open form and choose an option by its text.
 *
 * Matched on the *whole* accessible name, allowing the required-field asterisk,
 * and scoped to `combobox`. Two looser selectors were tried first and both were
 * the assertion's fault rather than the form's: a substring match on "目标" also
 * hit "任务目标" and "验证目标", and an anchored `/^条目/` hit the unit block's
 * "条目角色" select. Playwright's strict mode failed on the selector, which is
 * exactly the failure mode a walk should not mistake for a product defect.
 */
async function choose(label, optionText) {
  await page.getByRole('combobox', { name: new RegExp(`^${label}\\s*\\*?$`) }).click();
  try {
    await page.getByRole('option', { name: optionText }).click({ timeout: 10000 });
  } catch (error) {
    console.log(`  [debug] choose(${label}, ${optionText}) — ${error.message.split('\n')[0]}`);
    console.log(
      `  [debug] options: ${JSON.stringify(await page.getByRole('option').allInnerTexts())}`,
    );
    await page.screenshot({ path: 'artifacts/lab-task-walk-debug.png', fullPage: true });
    throw error;
  }
}

// ── Seed: a task at `graph`, with lab evidence and a node supporting it ─────
const task = must(
  'create task',
  await api('POST', '/api/curriculum/design/tasks', {
    title: '实操表单校验：SQL 注入',
    audience: 'CTF 新队员',
    problemStatement: '能独立完成一道基础 SQL 注入实战题',
    durationHours: 4,
  }),
  201,
).task;
const id = task.id;

must('-> outcomes', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);
const objective = must(
  'objective',
  await api('POST', `/api/curriculum/design/tasks/${id}/objectives`, {
    code: 'O1',
    title: '能够利用 SQL 注入获取指定数据',
    objectiveType: 'skill',
    level: 'course',
    expectedBehavior: '在靶场中构造 payload 读出目标数据',
    minCriteria: ['识别注入点'],
    difficulty: 'intermediate',
  }),
  201,
).objective;
must(
  'lab evidence (the artifact the lab task must deliver)',
  await api('POST', `/api/curriculum/design/tasks/${id}/evidence`, {
    objectiveId: objective.id,
    evidenceType: 'lab',
    verificationMethod: '实操验证',
    successCondition: '成功读取 /flag',
  }),
  201,
);
must('-> graph', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);
const node = must(
  'node',
  await api('POST', `/api/curriculum/design/tasks/${id}/nodes`, {
    name: 'SQL 注入原理',
    nodeType: 'knowledge',
  }),
  201,
).node;
must(
  'link node to outcome',
  await api('PUT', `/api/curriculum/design/tasks/${id}/node-objectives`, {
    links: [{ nodeId: node.id, objectiveId: objective.id }],
  }),
  200,
);

// ── 1. The gate is closed at `graph`, with the reason as page text ──────────
await page.goto(`${BASE}/curriculum/design/${id}`, { waitUntil: 'networkidle' });
await page.getByText('目标闭环矩阵').first().waitFor({ timeout: 30000 });
await page.getByRole('tab', { name: '设计编辑器' }).click();
await page.getByText('实操任务', { exact: true }).first().waitFor({ timeout: 30000 });

const labCreateClosed = page.getByRole('button', { name: '新建实操任务', exact: true }).first();
check('the hands-on create control is rendered', (await labCreateClosed.count()) === 1);
check('it is disabled before the assessment phase', await labCreateClosed.isDisabled());
check(
  'the refusal is visible text naming the phase to reach',
  (await page.locator('body').innerText()).includes('先完成评价设计阶段'),
  'no visible gate sentence for the lab section',
);
check(
  'the empty state says why the section matters',
  (await page.locator('body').innerText()).includes('有承诺、无交付'),
);
await page.screenshot({ path: 'artifacts/s5-lab-gated.png', fullPage: true });

// ── Advance the task to `assessment` behind the editor's back ──────────────
must('-> outline', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);
const unit = must(
  'practice item',
  await api('POST', `/api/curriculum/design/tasks/${id}/units`, {
    unitType: 'item',
    title: '1.1 动手检测',
    unitRole: 'practice',
    // `objective_missing_prereq` reads `teachingDesign.nodes`, which is a list of
    // node *ids*. Naming the node in `core` (a free-text topic string) is the
    // documented trap: it stores fine and satisfies nothing.
    teachingDesign: { nodes: [node.id], core: ['SQL 注入原理'] },
  }),
  201,
).unit;
must(
  'cover: taught',
  await api('POST', `/api/curriculum/design/tasks/${id}/unit-coverage`, {
    unitId: unit.id,
    objectiveId: objective.id,
    coverageKind: 'teach',
  }),
  201,
);
must('-> teaching', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);
must('-> assessment', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);

await page.getByRole('button', { name: '刷新' }).first().click();
await page.waitForTimeout(2500);

const labCreateOpen = page.getByRole('button', { name: '新建实操任务', exact: true }).first();
check(
  'the refresh reached this section and opened the control',
  !(await labCreateOpen.isDisabled()),
);
check(
  'the closed reason is gone once the phase is reached',
  (await page.locator('body').innerText()).includes('先完成评价设计阶段') === false,
);

// The finding the form exists to clear, asserted present *before* the create.
// Without this half, "the finding is gone afterwards" could be true because the
// rule never fired at all.
const auditBeforeLab = await api('POST', `/api/curriculum/design/tasks/${id}/review`);
check(
  'lab evidence with no lab task is an unmet promise before the form is used',
  (auditBeforeLab.body.findings ?? []).some(
    (finding) => finding.ruleCode === 'evidence_no_artifact',
  ),
  `findings: ${JSON.stringify((auditBeforeLab.body.findings ?? []).map((f) => f.ruleCode))}`,
);

// ── 2. A practice task, created entirely through the form ──────────────────
await labCreateOpen.click();
// The unit and the outcome are chosen from their titles. An empty one is not
// "unset": it is a lookup for a row with no id, and the form refuses it locally.
await choose('条目', '1.1 动手检测（练习）');
await choose('目标', 'O1 能够利用 SQL 注入获取指定数据');
await page.getByLabel('任务目标').fill('对给定站点完成一次注入检测并读出 /flag');
await page.getByLabel('靶场镜像').fill('sqlmap:latest');
await page.getByLabel('验证目标').fill('/flag');
// Default kind is `file_read`, whose condition field is `path`. Left at the
// default on purpose: this is the mapping an author would rely on by not
// touching the select.
const submitLab = page.getByRole('button', { name: '新建实操任务' }).last();
await submitLab.click();
await page.waitForTimeout(2500);

let snapshot = await api('GET', `/api/curriculum/design/tasks/${id}`);
const practiceLab = (snapshot.body.labTasks ?? []).find(
  (lab) => lab.taskGoal === '对给定站点完成一次注入检测并读出 /flag',
);
check('a hands-on task created through the form exists', Boolean(practiceLab));
check(
  'it is a practice task',
  practiceLab?.assessmentMode === 'practice',
  practiceLab?.assessmentMode,
);
check(
  'the verify rule landed in the field the kind is read from',
  practiceLab?.verifyRules?.[0]?.kind === 'file_read' &&
    practiceLab?.verifyRules?.[0]?.path === '/flag' &&
    practiceLab?.verifyRules?.[0]?.value === undefined,
  `stored rule: ${JSON.stringify(practiceLab?.verifyRules)}`,
);
check(
  'practice keeps hints and retries',
  practiceLab?.hintPolicy === 'unlimited' && practiceLab?.allowRetry === true,
  `${practiceLab?.hintPolicy}/${practiceLab?.allowRetry}`,
);
check(
  'the form shows the condition it stored',
  (await page.locator('body').innerText()).includes('file_read:/flag'),
);

const auditAfterPractice = await api('POST', `/api/curriculum/design/tasks/${id}/review`);
check(
  'creating the task in the browser cleared the finding on the server',
  !(auditAfterPractice.body.findings ?? []).some(
    (finding) => finding.ruleCode === 'evidence_no_artifact',
  ),
);

// The body the form *would* have sent without its exam derivation, posted
// directly. It must come back a 400 carrying the store's sentence — the three
// fields to change — rather than a 500, and not the raw constraint name the
// database would produce. Both halves matter: the previous round's defect was a
// refusal reported as a server failure, and the constraint's own message names a
// rule without naming anything to fix.
const naiveExam = await api('POST', `/api/curriculum/design/tasks/${id}/lab-tasks`, {
  unitId: unit.id,
  objectiveId: objective.id,
  assessmentMode: 'exam',
  taskGoal: '缺少冷启动设置的考试',
  dockerImage: 'sqlmap:latest',
  verifyRules: [{ kind: 'file_read', path: '/flag' }],
});
const naiveMessage = String(naiveExam.body?.error?.message ?? '');
check(
  'a warm exam is refused as a bad request, not a server failure',
  naiveExam.status === 400,
  `status ${naiveExam.status}`,
);
check(
  'the refusal names the fields to change, not the constraint',
  naiveMessage.includes('hintPolicy') &&
    naiveMessage.includes('allowRetry') &&
    naiveMessage.includes('timeLimitSec') &&
    !naiveMessage.includes('curriculum_lab_exam_strict'),
  `message: ${naiveMessage}`,
);

// ── 3. An exam, submitted exactly as the form submits it ───────────────────
// Built naively this click produces a body `curriculum_lab_exam_strict` refuses.
// The form stays open after a successful write (with its fields reset), so this
// reuses it rather than clicking the trigger again — a second click would land
// on the submit button and post an empty form.
await choose('条目', '1.1 动手检测（练习）');
await choose('目标', 'O1 能够利用 SQL 注入获取指定数据');
await page.getByLabel('任务目标').fill('限时独立完成一次注入利用');
await page.getByLabel('靶场镜像').fill('sqlmap:latest');
await choose('考核方式', '考试（无提示、不重试、限时）');
await choose('验证方式', 'flag');
await page.getByLabel('验证目标').fill('flag{probe}');
await page.getByLabel('限时（秒）').fill('1200');
await page.getByRole('button', { name: '新建实操任务' }).last().click();
await page.waitForTimeout(2500);

snapshot = await api('GET', `/api/curriculum/design/tasks/${id}`);
const examLab = (snapshot.body.labTasks ?? []).find(
  (lab) => lab.taskGoal === '限时独立完成一次注入利用',
);
check(
  'an exam created through the form is accepted by the server',
  Boolean(examLab),
  `page said: ${(await page.locator('body').innerText()).slice(-300)}`,
);
check('it is stored as an exam', examLab?.assessmentMode === 'exam', examLab?.assessmentMode);
check(
  'the form submitted the cold settings the constraint requires',
  examLab?.hintPolicy === 'forbidden' &&
    examLab?.allowRetry === false &&
    examLab?.timeLimitSec === 1200,
  `${examLab?.hintPolicy}/${examLab?.allowRetry}/${examLab?.timeLimitSec}`,
);
check(
  'the flag rule landed in `value`, per its kind',
  examLab?.verifyRules?.[0]?.kind === 'flag' && examLab?.verifyRules?.[0]?.value === 'flag{probe}',
  `stored rule: ${JSON.stringify(examLab?.verifyRules)}`,
);
check(
  'the confirmation says what an exam means',
  (await page.locator('body').innerText()).includes('无提示、不重试、限时'),
);
await page.screenshot({ path: 'artifacts/s5-lab-created.png', fullPage: true });

// ── 4. The loop: lab evidence with no lab task is a finding, and now is not ─
const audit = await api('POST', `/api/curriculum/design/tasks/${id}/review`);
check(
  'the lab evidence is no longer an unmet promise',
  !(audit.body.findings ?? []).some((finding) => finding.ruleCode === 'evidence_no_artifact'),
  `findings: ${JSON.stringify((audit.body.findings ?? []).map((f) => f.ruleCode))}`,
);
check(
  'no lab is left without a verification rule',
  !(audit.body.findings ?? []).some((finding) => finding.ruleCode === 'lab_no_verify_rule'),
);

// ── 5. Deleting is never gated, even at `assessment` ───────────────────────
const labRow = page.locator('li').filter({ hasText: '限时独立完成一次注入利用' }).first();
await labRow.getByRole('button').click();
await page.waitForTimeout(2000);
snapshot = await api('GET', `/api/curriculum/design/tasks/${id}`);
check(
  'a task deleted from the page is gone from the store',
  !(snapshot.body.labTasks ?? []).some((lab) => lab.taskGoal === '限时独立完成一次注入利用'),
);
check(
  'the practice task was left alone',
  (snapshot.body.labTasks ?? []).some(
    (lab) => lab.taskGoal === '对给定站点完成一次注入检测并读出 /flag',
  ),
);

console.log(`\n${passed} passed, ${failed} failed`);
console.log('\npage console errors:');
if (problems.length === 0) console.log('  (none)');
else for (const problem of problems) console.log(`  - ${problem}`);

await browser.close();
if (failed > 0) process.exitCode = 1;
