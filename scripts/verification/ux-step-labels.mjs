/**
 * 走查「每一次步骤引用都带序号」这条规则在真实界面上的效果。
 *
 * 背景是用户发来的一张截图：同一个第 3 步在四行文案里有四个名字——卡片写「知识技能与
 * 依赖」、空态写「先完成依赖图阶段…当前在学习成果阶段」、右栏红字写「当前处于
 * `outcomes` 阶段；推进到 `graph` 阶段」。用户的要求是"把每一步都标出来，1-7 这种"。
 *
 * 脚本把那个状态**造出来**（方向已确认并前进到第 2 步，第 3 步还没轮到），然后把界面
 * 上真正渲染出来的字读出来，逐条核对：
 *
 *   1. 步骤条 → 「第 2 步 / 共 7 步」且只有一个当前步；
 *   2. 卡片角标 → 每一步都带「第 N 步 / 共 7 步 · 你在这/已走过/还没轮到」；
 *   3. 门禁理由 → 说得出"第几步、哪一步、做什么"；
 *   4. 服务器 409 → 红字里不再有 `outcomes` / `graph` 这样的阶段字面量；
 *   5. 确认按钮 → 按钮文字与卡片标题同词。
 *
 * 不打桩、不碰既有数据：所有产物落在脚本自己的匿名 owner 里。
 * 运行：node scripts/verification/ux-step-labels.mjs
 */
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';
const OUT = 'artifacts/ux-step-labels';
mkdirSync(OUT, { recursive: true });

const OWNER_ID = randomUUID();
const COOKIE = `anonymous_id=${OWNER_ID}`;

/** 截图里出现过的旧名字，一个都不许再出现在用户能看到的字里。 */
const FORBIDDEN = [
  '依赖图阶段',
  '学习成果阶段',
  '知识技能图阶段',
  '大纲阶段',
  '教学设计阶段',
  '评价设计阶段',
  '审核与导出阶段',
];
/** 阶段字面量：出现在中文句子里就是泄漏。 */
const PHASE_IDS = ['outcomes', 'graph', 'assessment', 'teaching'];

const problems = [];
function check(label, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) problems.push(`${label}${detail ? `: ${detail}` : ''}`);
}

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({
  viewport: { width: 1600, height: 1400 },
  locale: 'zh-CN',
});
await context.addCookies([{ name: 'anonymous_id', value: OWNER_ID, url: BASE }]);
const page = await context.newPage();
// 开发模式的 Next.js 角标会浮在左下角，正好压住卡片里的字。
await page
  .addStyleTag({
    content: 'nextjs-portal{display:none!important}',
    // 页面还没导航过，等第一次 goto 之后再注入（见下）。
  })
  .catch(() => {});

async function api(method, path, body) {
  const response = await context.request.fetch(BASE + path, {
    method,
    headers: {
      cookie: COOKIE,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
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

const stamp = Date.now().toString(36);
const title = `步骤指引走查 ${stamp}`;

// ── 造一个停在 `outcomes` 的任务：方向已确认并前进，第 3 步还没轮到 ──────
const series = await api('POST', '/api/curriculum/series', { name: `步骤指引走查 ${stamp}` });
if (series.status !== 201) throw new Error(`建序列失败 ${series.status}`);
const created = await api('POST', '/api/curriculum/design/tasks', {
  seriesId: series.body.series.id,
  title,
});
if (created.status !== 201) throw new Error(`建目失败 ${created.status}`);
const taskId = created.body.task.id;

await api('PATCH', `/api/curriculum/design/tasks/${taskId}`, {
  audience: 'Web 安全方向的应届生',
  problemStatement: '看得懂漏洞报告，但独立打不穿一台靶机',
  durationHours: 12,
});
const confirmed = await api('POST', `/api/curriculum/design/tasks/${taskId}/direction`);
check('方向确认成功', confirmed.status === 200, `HTTP ${confirmed.status}`);
const advanced = await api('POST', `/api/curriculum/design/tasks/${taskId}/phase`);
if (advanced.status !== 200) throw new Error(`前进到第 2 步失败 ${advanced.status}`);
console.log(`taskId=${taskId} phase=${advanced.body.phase ?? advanced.body.task?.designPhase}`);

// ── 打开目工作台的设计编辑器 ─────────────────────────────────────────────
await page.goto(`${BASE}/curriculum/design/${taskId}`, { waitUntil: 'networkidle' });
await page.addStyleTag({ content: 'nextjs-portal{display:none!important}' });
await page.getByRole('tab', { name: '设计编辑器' }).first().click();
await page.waitForTimeout(1200);
const body = await page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));

// 1. 步骤条
check(
  '步骤条说的是第 2 步',
  /第\s*2\s*步\s*\/\s*共\s*7\s*步/.test(body),
  body.match(/第\s*\d+\s*步\s*\/\s*共\s*7\s*步/)?.[0],
);
const current = await page.evaluate(() =>
  Array.from(
    document.querySelectorAll('[data-testid="step-rail"] [data-step-state="current"]'),
  ).map((el) => el.getAttribute('data-step')),
);
check(
  '步骤条上只有一个当前步，且就是 outcomes',
  current.length === 1 && current[0] === 'outcomes',
  JSON.stringify(current),
);
const railSteps = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="step-rail"] [data-step]')).map((el) => ({
    step: el.getAttribute('data-step'),
    state: el.getAttribute('data-step-state'),
  })),
);
check(
  '七步都在，前三步状态是 已走过/你在这/还没轮到',
  railSteps.length === 7 &&
    railSteps[0].state === 'done' &&
    railSteps[1].state === 'current' &&
    railSteps[2].state === 'todo',
  railSteps.map((r) => `${r.step}:${r.state}`).join(' '),
);

// 2. 卡片角标
const badges = await page.evaluate(() =>
  Array.from(document.querySelectorAll('[data-testid="step-badge"]')).map((el) => ({
    step: el.getAttribute('data-step'),
    relation: el.getAttribute('data-step-relation'),
    text: (el.textContent || '').replace(/\s+/g, ' ').trim(),
  })),
);
check(
  '卡片角标都带「第 N 步 / 共 7 步」',
  badges.length > 0 && badges.every((b) => /第 \d 步 \/ 共 7 步/.test(b.text)),
  badges
    .map((b) => b.text)
    .slice(0, 3)
    .join(' | '),
);
check(
  '角标关系与步骤条同源',
  badges.some((b) => b.relation === 'todo'),
  badges.find((b) => b.relation === 'todo')?.text ?? '没有"还没轮到"',
);

// 3. 不再出现旧名字 / 阶段字面量
for (const word of FORBIDDEN) check(`界面上没有「${word}」`, !body.includes(word));
const leaked = PHASE_IDS.filter((id) => body.includes(id));
check('界面上没有阶段字面量', leaked.length === 0, leaked.join(','));

// 4. 门禁理由与按钮说明
const titles = await page.evaluate(() =>
  Array.from(document.querySelectorAll('button[title]'))
    .map((el) => el.getAttribute('title'))
    .filter((t) => t && t.includes('第')),
);
const lockTitles = titles.filter((t) => t.includes('才能'));
check('被挡住的按钮说得出"到第几步、做什么"', lockTitles.length >= 3, lockTitles[0] ?? '没找到');
check(
  '理由里没有旧阶段名',
  lockTitles.every((t) => !FORBIDDEN.some((w) => t.includes(w))),
);
check(
  '确认按钮与卡片同词',
  body.includes('确认知识技能与依赖') && body.includes('确认学习目标与证据'),
);
const verbTitle = lockTitles.find((t) => t.includes('勾上') || t.includes('排一条'));
check(
  '理由里的动词是用户真做的那件事（勾上/排一条，而不是"新建覆盖"）',
  Boolean(verbTitle),
  verbTitle ?? '没找到',
);

// 同一句缺口不许念两遍：这一步的"还没有任何条目"既是缺口也是审核发现。
const duplicated = titles.filter((t) => {
  const sentences = t
    .split('；')
    .map((part) => part.trim())
    .filter(Boolean);
  return new Set(sentences).size !== sentences.length;
});
check('悬浮说明里没有重复的同一句话', duplicated.length === 0, duplicated[0] ?? '');

// 5. 服务器 409：直接打被门禁挡住的起草接口
const draft = await api('POST', `/api/curriculum/design/tasks/${taskId}/knowledge/draft`, {});
const message = draft.body?.error?.message ?? '';
check('未被允许的起草被 409 拒绝', draft.status === 409, `HTTP ${draft.status}`);
check(
  '409 文案用步骤语言',
  /第\s*3\s*步「知识技能与依赖」/.test(message) && !PHASE_IDS.some((id) => message.includes(id)),
  message,
);

// 5b. 界面上真的点一次「让 AI 起草」：红字必须是步骤语言（这张图就是用户截图的那一处）
const instruction = page.getByLabel('给 AI 的起草指令').nth(1); // 第 3 步那一栏
await instruction.fill('帮我从学习目标反推知识点');
await page.getByRole('button', { name: '让 AI 起草' }).nth(1).click();
await page.waitForTimeout(1500);
const alert = await page
  .getByRole('alert')
  .first()
  .innerText()
  .catch(() => '');
check(
  '界面上的红字也是步骤语言',
  /第\s*3\s*步「知识技能与依赖」/.test(alert) && !PHASE_IDS.some((id) => alert.includes(id)),
  alert.replace(/\s+/g, ' '),
);

await page.screenshot({ path: `${OUT}/01-editor-step2.png`, fullPage: true });

// 卡片特写：第 3 步（还没轮到的那一步）
const step3 = await page.evaluate(() => {
  const badge = document.querySelector('[data-testid="step-badge"][data-step="graph"]');
  // 往上找到"整张卡片"：宽度超过 1200 且有一定高度的第一个祖先。
  let el = badge;
  while (el && el !== document.body) {
    const r = el.getBoundingClientRect();
    if (r.width > 1200 && r.height > 260)
      return { x: r.x, y: r.y + window.scrollY, width: r.width };
    el = el.parentElement;
  }
  return null;
});
if (step3) {
  await page.screenshot({
    path: `${OUT}/02-step3-card.png`,
    fullPage: true,
    clip: {
      x: Math.max(0, step3.x - 12),
      y: Math.max(0, step3.y - 12),
      width: Math.min(1560, step3.width + 24),
      height: 620,
    },
  });
}

// 窄屏：步骤条横向滚动、不换行
await page.setViewportSize({ width: 390, height: 900 });
await page.waitForTimeout(400);
const railOverflow = await page.evaluate(() => {
  const ol = document.querySelector('[data-testid="step-rail"]');
  const wrap = ol?.parentElement;
  return {
    rows: new Set(Array.from(ol?.children ?? []).map((li) => li.getBoundingClientRect().top)).size,
    scrollable: (wrap?.scrollWidth ?? 0) > (wrap?.clientWidth ?? 0),
  };
});
check(
  '窄屏下列不换行（一行七格 + 可横向滚动）',
  railOverflow.rows === 1 && railOverflow.scrollable,
  JSON.stringify(railOverflow),
);
await page.screenshot({ path: `${OUT}/03-narrow.png`, fullPage: true });

console.log(`\n截图：${OUT}/`);
console.log(
  problems.length === 0
    ? '\n全部通过'
    : `\n${problems.length} 条不符合：\n - ${problems.join('\n - ')}`,
);
await browser.close();
process.exit(problems.length === 0 ? 0 : 1);
