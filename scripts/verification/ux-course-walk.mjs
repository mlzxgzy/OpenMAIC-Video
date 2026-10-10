/**
 * A person's walk through the curriculum workspace, in a real browser.
 *
 * This is not a regression suite. It creates a course from an empty state and
 * puts one of everything into it, clicking and typing only — the same way a
 * person would — so that whatever is awkward, unexplained or missing shows up
 * as a step that needs a workaround. Every workaround is a finding.
 *
 * Run: node scripts/verification/ux-course-walk.mjs [--stages=ledger,knowledge,...]
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';
const OUT = 'artifacts/ux';
mkdirSync(OUT, { recursive: true });

const wanted = (() => {
  const arg = process.argv.find((value) => value.startsWith('--stages='));
  return arg ? arg.slice('--stages='.length).split(',') : ['ledger', 'knowledge', 'program', 'assembly', 'batch', 'design'];
})();
const shouldRun = (stage) => wanted.includes(stage) || wanted.includes('all');

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({ viewport: { width: 1600, height: 1200 }, locale: 'zh-CN' });
const page = await context.newPage();

const notes = [];
const problems = [];
const requests = [];
page.on('console', (message) => {
  if (message.type() === 'error') problems.push(`console.error: ${message.text()}`);
});
page.on('pageerror', (error) => problems.push(`pageerror: ${error.message}`));
page.on('request', (request) => {
  if (request.url().includes('/api/')) requests.push(request.url().replace(BASE, ''));
});

let stepNo = 0;
/** A finding: something I had to work around, or the UI never explained. */
function note(kind, text) {
  notes.push({ kind, text });
  console.log(`NOTE[${kind}] ${text}`);
}

async function shot(name) {
  stepNo += 1;
  const file = `${OUT}/${String(stepNo).padStart(2, '0')}-${name}.png`;
  await page.screenshot({ path: file, fullPage: true });
  console.log(`shot  ${file}`);
}

async function run(label, fn) {
  try {
    await fn();
    console.log(`ok    ${label}`);
  } catch (error) {
    console.log(`FAIL  ${label} — ${error.message.split('\n')[0]}`);
    notes.push({ kind: 'broken', text: `${label}: ${error.message.split('\n')[0]}` });
    await page.screenshot({ path: `${OUT}/fail-${stepNo}-${label}.png`, fullPage: true }).catch(() => {});
  }
}

/**
 * Every tab panel stays mounted, so the same placeholder exists several times
 * over. Everything below is scoped to what is actually on screen — which is
 * also what a person can reach.
 */
const onScreen = (locator) => locator.filter({ visible: true });
const button = (name) => onScreen(page.getByRole('button', { name, exact: true })).first();
const placeholder = (text) => onScreen(page.getByPlaceholder(text, { exact: true })).first();
const selectHaving = (optionText) =>
  onScreen(page.locator('select').filter({ has: page.locator('option', { hasText: optionText }) })).first();

/** What does the person see right now? Used to check a step actually landed. */
async function visibleText() {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
}

// ────────────────────────────────────────────────────────────── ledger ──────
if (shouldRun('ledger')) {
  await run('open /curriculum', async () => {
    requests.length = 0;
    await page.goto(`${BASE}/curriculum`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '全部课程总览' }).waitFor({ timeout: 30000 });
    await page.waitForTimeout(4000);
    note('perf', `打开台账一屏就发出 ${requests.length} 个 /api 请求：${requests.join(' , ')}`);
  });
  await run('empty state says what to do first', async () => {
    const text = await visibleText();
    if (!text.includes('还没有课程')) note('copy', '空课程台账没有引导文案');
  });
  await shot('empty-ledger');

  await run('create series', async () => {
    await placeholder('系列名称，例如 CTF综合实战').fill('CTF综合实战');
    await page.getByPlaceholder('描述（可选）').first().fill('面向零基础学生的 CTF 实战训练');
    await button('新建/复用系列').click();
    await page.waitForTimeout(1200);
  });
  await run('series is now the active scope', async () => {
    await page.getByRole('button', { name: /CTF综合实战/ }).first().click();
    await page.waitForTimeout(800);
  });
  await shot('series-created');

  await run('create course with every field filled', async () => {
    await placeholder('课程标题 *').fill('CTF Web 入门');
    await placeholder('课程编号，例如 CTF-1-1-1').fill('CTF-1-1-1');
    await placeholder('章，例如 第一章 CTF基础').fill('第一章 Web 基础');
    await placeholder('节，例如 第一节 CTF入门').fill('第一节 SQL 注入');
    await placeholder('目顺序').fill('1');
    await placeholder('学时').fill('3');
    await placeholder('学分').fill('1');
    await placeholder('学期，例如 2026春').fill('2026春');
    // the description inside the course card, not the series one
    await onScreen(page.getByPlaceholder('描述（可选）')).last().fill('从 SQL 注入入门到实战');
    await button('创建并打开课程').click();
    await page.waitForTimeout(2500);
    if (!/\/curriculum\/courses\//.test(page.url())) {
      note('broken', `创建课程后没有跳到课程页，停在 ${page.url()}`);
    }
  });
  await shot('course-created');
}

// ────────────────────────────────────────────────────────── knowledge ──────
if (shouldRun('knowledge')) {
  await run('open knowledge tab', async () => {
    await page.goto(`${BASE}/curriculum?tab=knowledge`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });

  for (const point of [
    { name: 'SQL 注入原理', code: 'KP-01' },
    { name: '联合查询注入', code: 'KP-02' },
  ]) {
    await run(`create knowledge point ${point.code}`, async () => {
      await placeholder('知识点名称 *').fill(point.name);
      await placeholder('编号，例如 KP-01').fill(point.code);
      await button('新建知识点').click();
      await page.waitForTimeout(1200);
    });
  }
  await shot('knowledge-points');

  await run('link the two points with a relation', async () => {
    await selectHaving('源知识点').selectOption({ index: 1 });
    await selectHaving('目标知识点').selectOption({ index: 2 });
    await button('新建/更新知识点关系').click();
    await page.waitForTimeout(1200);
  });
  await shot('knowledge-relation');

  await run('same point twice must explain itself', async () => {
    await selectHaving('目标知识点').selectOption({ index: 1 });
    const relationButton = button('新建/更新知识点关系');
    const disabled = await relationButton.isDisabled();
    const text = await visibleText();
    if (disabled && !/不能相同|同一知识点|请选择不同的/.test(text)) {
      note('silent-gate', '源知识点=目标知识点时按钮变灰，但页面上没有任何一句说明为什么');
    }
    await selectHaving('目标知识点').selectOption({ index: 2 });
  });

  await run('bind knowledge points to the course', async () => {
    await selectHaving('选择课程').selectOption({ index: 1 });
    await page.waitForTimeout(1200);
    const boxes = onScreen(page.getByRole('checkbox'));
    const count = await boxes.count();
    for (let index = 0; index < Math.min(count, 2); index += 1) await boxes.nth(index).check();
    await button('保存课程知识点绑定').click();
    await page.waitForTimeout(1500);
  });
  await shot('knowledge-bound');
}

// ──────────────────────────────────────────────────────────── program ──────
if (shouldRun('program')) {
  await run('open program tab', async () => {
    await page.goto(`${BASE}/curriculum?tab=program`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });
  await shot('program-empty');

  await run('create program', async () => {
    await placeholder('培养方案名称 *').fill('网络空间安全 2026 培养方案');
    await placeholder('编号/专业代码').fill('NSS-2026');
    await placeholder('说明').fill('面向 2026 级');
    await button('新建/复用培养方案').click();
    await page.waitForTimeout(1500);
  });

  await run('create version', async () => {
    await placeholder('版本名称，例如 2026版 *').fill('2026版');
    await placeholder('版本号').fill('v1');
    await placeholder('年级').fill('2026');
    await placeholder('目标学分').fill('160');
    await button('新建方案版本').click();
    await page.waitForTimeout(1500);
  });

  await run('create indicator', async () => {
    await placeholder('指标点编号，例如 1.1 *').fill('1.1');
    await placeholder('指标点描述 *').fill('能够分析并利用常见 Web 漏洞');
    await button('新建指标点').click();
    await page.waitForTimeout(1500);
  });
  await shot('program-indicator');

  await run('add the course to the plan', async () => {
    await placeholder('学期，例如 2026春').last().fill('2026春');
    await onScreen(page.getByPlaceholder(/计划课程标题|标题默认同课程/))
      .first()
      .fill('CTF Web 入门');
    await button('加入计划课程').click();
    await page.waitForTimeout(1500);
  });
  await shot('program-plan');

  await run('mark the support weight', async () => {
    await selectHaving('选择计划课程').selectOption({ index: 1 });
    await page.waitForTimeout(800);
    const box = onScreen(page.getByRole("checkbox")).first();
    await box.check();
    await page.waitForTimeout(400);
    await button('保存支撑矩阵').click();
    await page.waitForTimeout(1500);
  });
  await shot('program-support');
}

// ─────────────────────────────────────────────────────────── assembly ──────
if (shouldRun('assembly')) {
  await run('open assembly tab', async () => {
    await page.goto(`${BASE}/curriculum?tab=assembly`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });
  await shot('assembly-empty');

  await run('pick knowledge points and build the plan', async () => {
    await placeholder('课程标题 *').fill('CTF Web 实战');
    await placeholder('课程编号，例如 CTF-1-1-4').fill('CTF-1-1-2');
    await placeholder('章，例如 第一章 CTF基础').fill('第一章 Web 基础');
    await placeholder('节，例如 第二节 工具环境').fill('第二节 联合查询');
    const boxes = onScreen(page.getByRole("checkbox"));
    const count = await boxes.count();
    for (let index = 0; index < count; index += 1) await boxes.nth(index).check();
    await button('生成组装方案').click();
    await page.waitForTimeout(4000);
  });
  await shot('assembly-plan');

  await run('save the plan as a course draft', async () => {
    await button('保存为课程草稿').click();
    await page.waitForTimeout(2500);
  });
  await shot('assembly-saved');
}

// ─────────────────────────────────────────────────────────── batch ──────
if (shouldRun('batch')) {
  await run('open batch tab', async () => {
    await page.goto(`${BASE}/curriculum?tab=batch`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });
  await shot('batch-empty');

  await run('queue the course, then take it back out', async () => {
    page.on('dialog', (dialog) => void dialog.accept());
    const boxes = onScreen(page.getByRole('checkbox'));
    const count = await boxes.count();
    if (count === 0) throw new Error('队列里没有可勾选的课程');
    await boxes.first().check();
    await button('加入生成队列').click();
    await page.waitForTimeout(2500);
    await shot('batch-queued');
    // Cancelling immediately is deliberate: a queued item starts a real
    // generation run on the server, and this walk is about the interface, not
    // about spending the deployment's model quota. The cancel button is part of
    // what is being reviewed anyway.
    await button('取消').first().click();
    await page.waitForTimeout(2500);
    const text = await visibleText();
    if (!text.includes('已取消') && !text.includes('取消')) {
      note('copy', '取消批量队列之后，列表里看不出它已经取消');
    }
  });
  await shot('batch-cancelled');

  await run('clean up whatever run the queue started', async () => {
    const active = await context.request.fetch(`${BASE}/api/generation-runs?active=1`);
    const payload = await active.json().catch(() => ({ runs: [] }));
    for (const run of payload.runs ?? []) {
      const deleted = await context.request.fetch(`${BASE}/api/generation-runs/${run.id}`, {
        method: 'DELETE',
      });
      note('cleanup', `删除批量队列启动的 run ${run.id} -> ${deleted.status()}`);
    }
    if ((payload.runs ?? []).length === 0) note('cleanup', '队列没有来得及启动任何 run');
  });

  await run('open export tab', async () => {
    await page.goto(`${BASE}/curriculum?tab=export`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });
  await shot('export-empty');

  await run('what does the export tab say with nothing to export', async () => {
    const text = await visibleText();
    note('state', `视频导出台账文字：${text.replace(/\s+/g, ' ').slice(-260)}`);
  });
}

// ───────────────────────────────────────────────────────────── design ──────
if (shouldRun('design')) {
  await run('open design list', async () => {
    await page.goto(`${BASE}/curriculum/design`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(2500);
  });
  await shot('design-list');
}

writeFileSync(`${OUT}/walk-notes.json`, JSON.stringify({ notes, problems }, null, 2));
console.log('\n─── notes ───');
for (const item of notes) console.log(`${item.kind.padEnd(7)} ${item.text}`);
console.log('─── console errors ───');
for (const item of problems) console.log(item);

await browser.close();
