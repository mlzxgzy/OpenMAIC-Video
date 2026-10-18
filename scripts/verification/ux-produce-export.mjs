/**
 * 走查后半段：出片之后的导出（真实渲染服务）。
 *
 * 从 part1（ux-produce-walk.mjs）落库的 owner/task 接着走：打开目工作台的
 * 「生成与导出」，断言出片条目长出「打开课堂」与「导出 MP4」，点导出，然后
 * 轮询 `GET /api/curriculum/export-jobs`（读库，不读 DOM）直到终态。浏览器
 * worker 的认领/构建 ZIP/提交渲染全部真实发生。
 *
 * 运行：node scripts/verification/ux-produce-export.mjs
 * （默认用最近一次 part1 的产物；--owner/--task 可指定别的）
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';
const OUT = 'artifacts/ux-produce-walk';
mkdirSync(OUT, { recursive: true });

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
let OWNER_ID = args.get('owner');
let TASK_ID = args.get('task');
if (!OWNER_ID || !TASK_ID) {
  try {
    const saved = JSON.parse(readFileSync(`${OUT}/result.json`, 'utf8'));
    OWNER_ID = OWNER_ID ?? saved.owner;
    TASK_ID = TASK_ID ?? saved.taskId;
  } catch {
    /* 需要显式参数 */
  }
}
if (!OWNER_ID || !TASK_ID) {
  console.error(
    '用法: node scripts/verification/ux-produce-export.mjs [--owner=<uuid>] [--task=<taskId>]（或先跑 ux-produce-walk.mjs 生成 result.json）',
  );
  process.exit(1);
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({
  viewport: { width: 1600, height: 1200 },
  locale: 'zh-CN',
});
await context.addCookies([{ name: 'anonymous_id', value: OWNER_ID, url: BASE }]);
const page = await context.newPage();

const problems = [];
page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') problems.push(`console.error: ${m.text().slice(0, 200)}`);
});
async function shot(name) {
  await page.screenshot({ path: `${OUT}/p2-${name}.png`, fullPage: true });
}
async function api(method, path, body) {
  const r = await context.request.fetch(BASE + path, {
    method,
    data: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  let j;
  try {
    j = JSON.parse(t);
  } catch {
    j = t;
  }
  return { status: r.status(), body: j };
}

await page.goto(`${BASE}/curriculum/design/${TASK_ID}`, { waitUntil: 'networkidle' });
await page.getByRole('tab', { name: '生成与导出' }).click();
await page.waitForTimeout(1500);
const link = page.getByRole('link', { name: '打开课堂' }).first();
const linkOk = await link.isVisible().catch(() => false);
console.log(`打开课堂可见: ${linkOk}${linkOk ? ` href=${await link.getAttribute('href')}` : ''}`);
const exportBtn = page.getByRole('button', { name: '导出 MP4' }).first();
const exportOk =
  (await exportBtn.isVisible().catch(() => false)) &&
  !(await exportBtn.isDisabled().catch(() => true));
console.log(`导出 MP4 可点: ${exportOk}`);
await shot('after-generate');

if (!exportOk) {
  console.log('导出按钮不可用，停止');
  writeFileSync(`${OUT}/p2-result.json`, JSON.stringify({ linkOk, exportOk, problems }, null, 2));
  await browser.close();
  process.exit(1);
}

await exportBtn.click();
console.log('点了导出 MP4，等待入队…');
await page.waitForTimeout(2500);
await shot('queued');

let lastLog = '';
for (let i = 0; i < 100; i += 1) {
  const jobs = await api('GET', '/api/curriculum/export-jobs');
  const list = jobs.body?.jobs ?? [];
  const j = list[0];
  const line = j
    ? `job=${j.id} status=${j.status} progress=${Math.round((j.progress || 0) * 100)}%${j.error?.message ? ` err=${j.error.message.slice(0, 120)}` : ''}`
    : '(队列空)';
  if (line !== lastLog) {
    console.log(`${new Date().toISOString().slice(11, 19)} ${line}`);
    lastLog = line;
  }
  if (j && (j.status === 'succeeded' || j.status === 'failed' || j.status === 'cancelled')) break;
  await page.waitForTimeout(5000);
}
await shot('after-export');

const final = await api('GET', '/api/curriculum/export-jobs');
const job = (final.body?.jobs ?? [])[0];
console.log(
  `最终状态: ${job ? `${job.status} progress=${Math.round((job.progress || 0) * 100)}%` : '无任务'}`,
);
if (job?.error?.message) console.log(`错误: ${job.error.message}`);
writeFileSync(`${OUT}/p2-result.json`, JSON.stringify({ job, problems }, null, 2));
console.log(`console/page errors: ${problems.length ? problems.join(' | ') : '(none)'}`);
await browser.close();
