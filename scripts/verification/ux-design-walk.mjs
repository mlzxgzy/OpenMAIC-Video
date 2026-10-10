/**
 * A person's walk from the design list into the first authoring step.
 *
 * The full seven-phase authoring path is already pinned by
 * `design-workbench-walk.mjs` (28 checks). What this adds is the part that walk
 * seeds over the API and therefore never touches: clicking 新建课程设计,
 * filling the brief, and landing somewhere a person can actually work.
 *
 * Run: node scripts/verification/ux-design-walk.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';
const OUT = 'artifacts/ux';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, locale: 'zh-CN' });
const page = await context.newPage();

const notes = [];
const problems = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));

let stepNo = 0;
function note(kind, text) {
  notes.push({ kind, text });
  console.log(`NOTE[${kind}] ${text}`);
}
async function shot(name) {
  stepNo += 1;
  await page.screenshot({ path: `${OUT}/d${String(stepNo).padStart(2, '0')}-${name}.png`, fullPage: true });
}
async function run(label, fn) {
  try {
    await fn();
    console.log(`ok    ${label}`);
  } catch (error) {
    console.log(`FAIL  ${label} — ${error.message.split('\n')[0]}`);
    notes.push({ kind: 'broken', text: `${label}: ${error.message.split('\n')[0]}` });
    await page.screenshot({ path: `${OUT}/dfail-${stepNo}-${label}.png`, fullPage: true }).catch(() => {});
  }
}
const onScreen = (locator) => locator.filter({ visible: true });
const button = (name) => onScreen(page.getByRole('button', { name, exact: true })).first();

/**
 * Fill the control a person sees, by its label — including Radix selects.
 *
 * Not `exact`: a required field's label reads 目标标题* on screen, so an exact
 * match finds nothing and the walk reports a missing form that is right there.
 */
async function fillLabel(label, value) {
  const field = onScreen(page.getByLabel(label)).first();
  if ((await field.count()) === 0) throw new Error(`表单里没有「${label}」这一项`);
  const tag = await field.evaluate((element) => element.tagName.toLowerCase());
  if (tag === 'input' || tag === 'textarea') {
    await field.fill(value);
    return;
  }
  await field.click();
  await page.waitForTimeout(300);
  await onScreen(page.getByRole('option')).filter({ hasText: value }).first().click();
}

// ── list → brief → the design itself ───────────────────────────────────────
await run('open the design list', async () => {
  await page.goto(`${BASE}/curriculum/design`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '课程设计' }).waitFor({ timeout: 30000 });
  await page.waitForTimeout(1500);
});
await shot('design-list-empty');

await run('fill the brief and press 创建并开始设计', async () => {
  await button('新建课程设计').click();
  await page.getByPlaceholder('课程标题，例如：CTF Web 入门实战').fill('UX 走查：SQL 注入实战');
  await page.getByPlaceholder('培训对象，例如：零基础高校网络安全专业学生').fill('零基础学员');
  await page.getByPlaceholder('学时').fill('4');
  await page
    .getByPlaceholder('要解决的问题：这门课要让学员最终能做什么？')
    .fill('能独立完成一道基础 SQL 注入题并说清原理');
  await button('创建并开始设计').click();
  await page.waitForTimeout(3000);
  if (!/\/curriculum\/design\/[^/]+/.test(page.url())) {
    note('dead-end', `「创建并开始设计」没有打开刚建的设计，停在 ${page.url()}`);
  }
});
await shot('design-created');

await run('the empty matrix points at the editor', async () => {
  const text = await visibleText();
  if (/No learning outcomes yet/.test(text)) {
    note('copy', '闭环进度里出现了英文 "No learning outcomes yet"，其余界面都是中文');
  }
  if (!/设计编辑器/.test(text)) note('copy', '新建设计之后，页面上看不到通往设计编辑器的入口');
});

await run('open the design editor', async () => {
  await page.getByRole('tab', { name: '设计编辑器' }).click();
  await page.waitForTimeout(2000);
});
await shot('design-editor');

await run('leave the task phase with the brief that was just written', async () => {
  const advance = button('进入学习成果');
  if ((await advance.count()) === 0) throw new Error('任务阶段没有「进入学习成果」按钮');
  const text = await visibleText();
  if (await advance.isDisabled()) {
    const gap = text.match(/还差：([^\n]{0,160})/);
    note('gate', `刚填完的简介推不动阶段：还差 ${gap ? gap[1] : '（页面上没有说明）'}`);
    throw new Error('阶段推进被挡住');
  }
  await advance.click();
  await page.waitForTimeout(2000);
});
await shot('design-outcomes');

// ── one outcome, with every field, and one piece of evidence ───────────────
await run('create an objective with every field filled', async () => {
  await button('新建目标').click();
  await page.waitForTimeout(800);
  await fillLabel('目标标题', '能够利用 SQL 注入读出目标数据');
  await fillLabel('可观察行为', '在靶场中构造 payload 读出 /flag');
  await fillLabel('最低标准（每行一条）', '定位注入点\n构造 payload 并回显数据');
  await button('新建目标').last().click();
  await page.waitForTimeout(2500);
});
await shot('design-objective');

await run('attach evidence to it', async () => {
  await button('加证据').first().click();
  await page.waitForTimeout(800);
  await fillLabel('验证方式', '在靶场中完成并提交 flag');
  await fillLabel('成功条件', '成功读出 /flag 并说明 payload 的作用');
  await button('加证据').last().click();
  await page.waitForTimeout(2500);
});
await shot('design-evidence');

await run('the objective loop now has one row', async () => {
  const text = await visibleText();
  if (text.includes('证据（0）')) note('state', '加完证据之后卡片上仍显示「证据（0）」');
  const advance = button('进入依赖图');
  if ((await advance.count()) === 0) {
    note('state', '学习成果阶段找不到「进入依赖图」按钮');
    return;
  }
  const disabled = await advance.isDisabled();
  const gap = text.match(/还差：([^\n]{0,120})/);
  note('gate', `一个目标加一条证据之后，「进入依赖图」禁用=${disabled}${gap ? `，还差：${gap[1]}` : ''}`);
});

async function visibleText() {
  return page.locator('body').innerText();
}

writeFileSync(`${OUT}/design-notes.json`, JSON.stringify({ notes, problems }, null, 2));
console.log('\n─── notes ───');
for (const item of notes) console.log(`${item.kind.padEnd(9)} ${item.text}`);
console.log('─── console errors ───');
for (const item of problems) console.log(item);

await browser.close();
