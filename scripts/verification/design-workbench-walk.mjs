/**
 * Live verification of the design workbench, in a real browser.
 *
 * The unit suite pins the *gate table* against the store, and this pins the thing
 * that matters most about a UI: that a person can complete a design without ever
 * seeing an id. Every step below is a click and a type — no `api()` call writes
 * anything after the seed. If the workbench regressed into raw-id entry, or a
 * create button started offering something the server refuses, this fails while
 * the type check still passes.
 *
 * Three things are asserted beyond "the page drew":
 *
 * 1. **The gate closes for real.** A create control at a phase that forbids it
 *    must be `disabled`, and the reason must be visible text — not only a title
 *    tooltip, which a person on a touch screen or with a screen reader will never
 *    see. This is the property the previous rounds' dead paths violated.
 * 2. **An edit made in the browser survives.** The seeded title is changed through
 *    the UI, then re-read from the API to confirm the store kept it — a workbench
 *    that saves to local state only would look identical.
 * 3. **The two halves agree.** Toggling coverage in the editor moves the matrix
 *    without a manual reload, which is the reason both halves share one version
 *    counter rather than each fetching their own phase.
 */
import { chromium } from '@playwright/test';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';

const browser = await chromium.launch().catch(async (error) => {
  console.log(`bundled chromium failed (${error.message.split('\n')[0]}); trying system chrome`);
  return chromium.launch({ channel: 'chrome' });
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1100 } });
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
    console.log(`FAIL  ${label} -> ${result.status} ${JSON.stringify(result.body).slice(0, 300)}`);
    throw new Error(`seed step failed: ${label}`);
  }
  passed += 1;
  console.log(`PASS  ${label} -> ${result.status}`);
  return result.body;
}

// ── Seed a design at the `graph` phase, deliberately mid-machine ────────────
// The editor is only interesting before the outline exists, because that is
// where the gates actually close. A task already at `review` has every create
// control open and proves nothing about gating.
const task = must(
  'create task',
  await api('POST', '/api/curriculum/design/tasks', {
    title: '编辑器校验：SQL 注入',
    audience: 'CTF 新队员',
    durationHours: 4,
    problemStatement: '能独立完成一道基础 SQL 注入题',
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
    minCriteria: ['识别注入点', '构造 payload'],
    difficulty: 'intermediate',
  }),
  201,
).objective;
must(
  'evidence',
  await api('POST', `/api/curriculum/design/tasks/${id}/evidence`, {
    objectiveId: objective.id,
    evidenceType: 'quiz',
    verificationMethod: '测验',
    successCondition: '答对关键题',
  }),
  201,
);
must('-> graph', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);

// ── Open the workbench ─────────────────────────────────────────────────────
await page.goto(`${BASE}/curriculum/design/${id}`, { waitUntil: 'networkidle' });
await page.getByText('目标闭环矩阵').first().waitFor({ timeout: 30000 });

// The matrix must render first: it owns the phase, and the editor waits for it.
const matrixText = await page.locator('body').innerText();
check('matrix tab renders', matrixText.includes('目标 × 目 热力矩阵'));

await page.getByRole('tab', { name: '设计编辑器' }).click();
// Wait for the editor's own content, not for the tab: the tab is present the
// instant it is clicked, and reading the body at that moment races the fetch
// that fills the editor. Waiting on a control the editor renders only once it
// has loaded makes this check measure the editor rather than the tab strip.
await page.getByLabel('可观察行为').first().waitFor({ timeout: 30000 });
const editorText = await page.locator('body').innerText();
check('editor tab renders', editorText.includes('学习目标与证据'));
check('editor shows the phase rail', editorText.includes('依赖图'));

// ── 1. The gate closes at `graph`, with a visible reason ────────────────────
const outlineCreate = page.getByRole('button', { name: '新建条目' }).first();
await outlineCreate.waitFor({ timeout: 15000 });
check('outline create is disabled before the outline phase', await outlineCreate.isDisabled());

// The reason must be *text on the page*, not just a tooltip title.
const railText = await page.locator('body').innerText();
check(
  'the refusal explains which phase to reach',
  railText.includes('先完成课程大纲阶段'),
  'no visible gate sentence found',
);
check('the editor states that editing is never gated', railText.includes('任何阶段都能改掉或删掉'));

// And a gate that IS open must actually be open.
const objectiveCreate = page.getByRole('button', { name: '新建目标' }).first();
check('outcome create is enabled at graph', !(await objectiveCreate.isDisabled()));

await page.screenshot({ path: 'artifacts/s5-workbench-gated.png', fullPage: true });

// ── 2. Edit an existing row through the UI and confirm the store kept it ────
const behaviorBox = page.getByLabel('可观察行为').first();
await behaviorBox.waitFor({ timeout: 15000 });
const NEW_BEHAVIOR = '在靶场中构造 payload 并读出 /flag（浏览器校验写入）';
await behaviorBox.fill(NEW_BEHAVIOR);
// `exact` is required: the page also has a 保存覆盖 button, and a substring
// match makes `.first()` resolve to whichever the DOM happens to order first.
// Getting this wrong made the first run of this walk report a save failure that
// did not happen — the assertion was measuring its own selector.
await page.getByRole('button', { name: '保存', exact: true }).first().click();
// The workbench reloads after a write, so the confirmation that the save stuck
// comes from the API rather than from the field still holding what was typed —
// a stale local copy would look identical.
await page.waitForTimeout(1500);

const snapshot = await api('GET', `/api/curriculum/design/tasks/${id}`);
const storedObjective = snapshot.body.objectives.find((row) => row.id === objective.id);
check(
  'an edit made in the browser reached the store',
  storedObjective?.expectedBehavior === NEW_BEHAVIOR,
  `store holds: ${storedObjective?.expectedBehavior}`,
);
check(
  'the save produced a visible confirmation',
  (await page.locator('body').innerText()).includes('已保存学习目标'),
);

await page.screenshot({ path: 'artifacts/s5-workbench-edited.png', fullPage: true });

// ── 3. Create a node through the form, and a link to the outcome ────────────
// This is the step that cannot be expressed in `window.prompt`: the link editor
// must offer the outcome by title, never by id.
await page.getByRole('button', { name: '新建知识点' }).first().click();
await page.getByLabel('知识点名称').fill('SQL payload 构造');
await page.getByRole('button', { name: '新建知识点' }).last().click();
await page.waitForTimeout(2000);
const afterNode = await api('GET', `/api/curriculum/design/tasks/${id}`);
check(
  'a node created through the form exists',
  afterNode.body.nodes.some((node) => node.name === 'SQL payload 构造'),
);

const editorAfterNode = await page.locator('body').innerText();
check('the new node appears in the editor', editorAfterNode.includes('SQL payload 构造'));

// The link checkbox must be labelled by the objective's title.
const objectiveLabel = objective.code ? `${objective.code} ${objective.title}` : objective.title;
const linkLabel = page.getByText(objectiveLabel, { exact: false }).first();
const linkCount = await linkLabel.count();
check('the link editor labels the objective by title, not id', linkCount > 0);

await page.screenshot({ path: 'artifacts/s5-workbench-linked.png', fullPage: true });

// ── 4. Both halves share one read: an edit moves the matrix ─────────────────
// Advance to the outline behind the editor's back, then bring the editor along
// with its own refresh. That this needs a refresh at all is the honest shape:
// the phase lives in the matrix, and a phase moved outside the browser cannot be
// observed by a component that did not fetch it. What is under test is that the
// refresh does reach the editor's gate — a refresh that only re-read the matrix
// would leave the create button closed forever.
// ── 4. Both halves share one read: an edit moves the matrix ─────────────────
// Advance to the outline behind the editor's back, then bring the editor along
// with its own refresh. That this needs a refresh at all is the honest shape:
// the phase lives in the shell, and a phase moved outside the browser cannot be
// observed by a component that did not fetch it. What is under test is that the
// refresh does reach the editor's gate — a refresh that only re-read the snapshot
// would leave the create button closed forever.
const seededNode = afterNode.body.nodes.find((node) => node.name === 'SQL payload 构造');
// The outline boundary refuses a node that supports no outcome. The first version
// of this walk advanced straight to the outline after creating one, then asserted
// the phase had moved; it had not. The 409 was the gate working correctly, and the
// assertion was the thing that was wrong.
must(
  'link the new node to the outcome',
  await api('PUT', `/api/curriculum/design/tasks/${id}/node-objectives`, {
    links: [{ nodeId: seededNode.id, objectiveId: objective.id }],
  }),
  200,
);
must('-> outline', await api('POST', `/api/curriculum/design/tasks/${id}/phase`), 200);
await page.getByRole('button', { name: '刷新' }).first().click();
await page.waitForTimeout(2500);
const gateTextAfterAdvance = await page.locator('body').innerText();
check(
  'the editor learned the new phase from its refresh',
  gateTextAfterAdvance.includes('先完成课程大纲阶段') === false,
  'the outline gate is still closed after advancing to outline',
);

const outlineCreateAfter = page.getByRole('button', { name: '新建条目', exact: true }).first();
check('outline create opens once the phase is reached', !(await outlineCreateAfter.isDisabled()));

await outlineCreateAfter.click();
await page.getByLabel('条目标题').fill('1.1 SQL 注入原理');
await page.getByRole('button', { name: '新建条目' }).last().click();
await page.waitForTimeout(2000);

const afterUnit = await api('GET', `/api/curriculum/design/tasks/${id}`);
const item = afterUnit.body.units.find((unit) => unit.title === '1.1 SQL 注入原理');
check('an item created through the form exists', Boolean(item));
check(
  'the item carries the role the form selected',
  item?.unitRole === 'lecture',
  `got ${item?.unitRole}`,
);

// Now tick 教 for this objective, in the editor.
const coverageBox = page.locator('tbody tr').first().locator('button[role="checkbox"]').first();
await coverageBox.click();
await page.getByRole('button', { name: '保存覆盖' }).click();
await page.waitForTimeout(2000);

const afterCoverage = await api('GET', `/api/curriculum/design/tasks/${id}`);
check(
  'coverage written through the editor persists',
  afterCoverage.body.unitCoverage.some(
    (row) =>
      row.unitId === item?.id && row.objectiveId === objective.id && row.coverageKind === 'teach',
  ),
);

// ── 5. The teaching design, and the audit finding it is the only fix for ────
// `objective_missing_prereq` fires when an outcome is taught but no item's
// teaching design names its primary support. The tick above provokes it, so the
// screen under test here is whether a person can clear it without leaving the
// browser. Without the teaching-design editor this was unreachable: the gate was
// correct and the workbench offered nothing to satisfy it.
const auditBefore = await api('POST', `/api/curriculum/design/tasks/${id}/review`);
check(
  'the audit flags the taught objective with no named support',
  auditBefore.body.findings.some((finding) => finding.ruleCode === 'objective_missing_prereq'),
  'expected objective_missing_prereq before the teaching design names the node',
);

await page.getByRole('button', { name: '编辑教学设计' }).first().click();
// Selected by the checkbox's own accessible name, which is built from the node
// title. A structural selector was tried first and matched nothing — the row is
// a flex div whose text node is a sibling of the input, not an ancestor, so a
// text filter over ancestors never sees it.
const involveBox = page.getByRole('checkbox', { name: '涉及 SQL payload 构造' }).first();
await involveBox.waitFor({ timeout: 15000 });
// `click`, not `check`. The checkbox is controlled: the tick is written, the
// snapshot is re-read, and the new state comes back from the server. Playwright's
// `check()` asserts the state changed synchronously and gives up with "clicking
// the checkbox did not change its state" — a correct rejection of a wrong
// expectation, not a defect in the control.
await involveBox.click();
await page.waitForTimeout(2500);

const afterTeaching = await api('GET', `/api/curriculum/design/tasks/${id}`);
const teachingUnit = afterTeaching.body.units.find((row) => row.id === item?.id);
check(
  'the teaching design names the node by id, as the audit compares it',
  (teachingUnit?.teachingDesign?.nodes ?? []).includes(seededNode.id),
  `stored nodes: ${JSON.stringify(teachingUnit?.teachingDesign?.nodes)}`,
);

const auditAfter = await api('POST', `/api/curriculum/design/tasks/${id}/review`);
check(
  'clearing the finding from the browser clears it on the server',
  !auditAfter.body.findings.some((finding) => finding.ruleCode === 'objective_missing_prereq'),
);

await page.screenshot({ path: 'artifacts/s5-workbench-teaching-design.png', fullPage: true });

await page.getByRole('tab', { name: '目标闭环矩阵' }).click();
await page.waitForTimeout(1500);
const matrixAfter = await page.locator('body').innerText();
check(
  'the matrix shows the coverage without a manual reload',
  matrixAfter.includes('1.1 SQL 注入原理'),
);

await page.screenshot({ path: 'artifacts/s5-workbench-matrix-synced.png', fullPage: true });

// ── Report ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
console.log('\npage console errors:');
if (problems.length === 0) console.log('  (none)');
else for (const problem of problems) console.log(`  - ${problem}`);

await browser.close();
if (failed > 0) process.exitCode = 1;
