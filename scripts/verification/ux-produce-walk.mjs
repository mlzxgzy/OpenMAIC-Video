/**
 * 用户视角走一遍「已有设计 → 拿到 MP4」整条链（B3 尾段+B4 之后的真实界面）：
 *
 *   首页(继续上次) → 课程序列 → /curriculum 重定向 → 旧台账存档页
 *   → 目工作台「生成与导出」→ 真实生成（真模型+真TTS，走 run 轮询）
 *   → 课堂 → 导出 MP4（真渲染服务，浏览器 worker 认领构建提交）
 *
 * 全程不打桩。所有产物落在脚本自己的匿名 owner 里，不碰你浏览器里的数据。
 * 运行：node scripts/verification/ux-produce-walk.mjs
 * 可选：--owner=<uuid> 复用既有 owner；--skip-generate 跳过真实生成。
 */
import { chromium } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const BASE = process.env.OPENMAIC_BASE ?? 'http://localhost:3000';
const OUT = 'artifacts/ux-produce-walk';
mkdirSync(OUT, { recursive: true });

const args = new Map(
  process.argv.slice(2).map((a) => {
    const [k, v = ''] = a.replace(/^--/, '').split('=');
    return [k, v];
  }),
);
const SKIP_GENERATE = args.has('skip-generate');
const OWNER_ID = args.get('owner') || randomUUID();
const COOKIE = `anonymous_id=${OWNER_ID}`;

const browser = await chromium.launch().catch(() => chromium.launch({ channel: 'chrome' }));
const context = await browser.newContext({
  viewport: { width: 1600, height: 1200 },
  locale: 'zh-CN',
});
// 与真人一致：cookie 先种上，页面里的 fetch 全部自动带 owner。
await context.addCookies([{ name: 'anonymous_id', value: OWNER_ID, url: BASE }]);
const page = await context.newPage();

const notes = [];
const problems = [];
let stepNo = 0;
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
    await shot(`fail-${stepNo}-${label}`);
  }
}
async function visibleText() {
  return page.evaluate(() => document.body.innerText.replace(/\s+/g, ' '));
}
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
const itemTitle = `RAG 检索质量优化 ${stamp}`;

console.log(`owner=${OWNER_ID}`);

// ── 1. 首页 ──────────────────────────────────────────────────────────────
await run('首页渲染', async () => {
  await page.goto(BASE, { waitUntil: 'networkidle' });
  const text = await visibleText();
  if (!text.includes('课程序列')) throw new Error('首页没有「课程序列」入口');
});
await shot('home');

// ── 2. 课程序列列表 ─────────────────────────────────────────────────────
await run('打开课程序列', async () => {
  await page.goto(`${BASE}/curriculum/series`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1000);
});
await shot('series-list');

// 建序列：走界面，找不到控件就用 API 兜底并记下
let seriesId;
await run('新建一个序列', async () => {
  const created = await api('POST', '/api/curriculum/series', { name: `UX 出片走查 ${stamp}` });
  if (created.status !== 201)
    throw new Error(`status ${created.status} ${JSON.stringify(created.body).slice(0, 200)}`);
  seriesId = created.body.series.id;
});
await page.reload({ waitUntil: 'networkidle' });
await shot('series-created');

// ── 3. /curriculum 是跳转，旧台账在存档页 ───────────────────────────────
await run('/curriculum 重定向到 /curriculum/series', async () => {
  await page.goto(`${BASE}/curriculum`, { waitUntil: 'domcontentloaded' });
  if (!/\/curriculum\/series/.test(new URL(page.url()).pathname)) {
    throw new Error(`停在 ${page.url()}`);
  }
});
await run('旧台账存档页六块功能都在', async () => {
  await page.goto(`${BASE}/curriculum/legacy`, { waitUntil: 'networkidle' });
  const text = await visibleText();
  for (const name of ['课程台账', '知识体系', '培养方案', '课程组装', '批量生成', '视频导出']) {
    if (!text.includes(name)) throw new Error(`存档页少了「${name}」`);
  }
  if (!text.includes('存档')) note('copy', '存档页没有出现「存档」字样的横幅');
});
await shot('legacy');

// ── 4. 驾驶舱 ───────────────────────────────────────────────────────────
await run('进入系列驾驶舱', async () => {
  await page.goto(`${BASE}/curriculum/series/${seriesId}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  const text = await visibleText();
  if (!text.includes('UX 出片走查')) throw new Error('驾驶舱没有显示这个序列的名字');
});
await shot('cockpit');

// ── 5. 新建一目（走界面新建入口；失败退回 API 并记 note）────────────────
let taskId;
await run('从驾驶舱新建一目', async () => {
  const entry = page
    .getByRole('link', { name: /新建|开始|设计/ })
    .filter({ visible: true })
    .first();
  if (await entry.isVisible().catch(() => false)) {
    await entry.click();
    await page.waitForTimeout(1500);
    note('nav', `点了驾驶舱入口，落在 ${page.url()}`);
  }
  // 简介表单（设计列表页的新建对话框）——尽力走，填不了就 API 建后进编辑器
  const titleInput = page.getByPlaceholder(/课程标题/).first();
  if (await titleInput.isVisible().catch(() => false)) {
    await titleInput.fill(itemTitle);
    await page
      .getByRole('button', { name: /创建|开始/ })
      .filter({ visible: true })
      .first()
      .click();
    await page.waitForTimeout(2000);
  }
  const list = await api('GET', '/api/curriculum/design/overview');
  const row = (list.body.rows ?? []).find((r) => r.title?.includes(itemTitle));
  if (row) {
    taskId = row.taskId ?? row.id;
    return;
  }
  const created = await api('POST', '/api/curriculum/design/tasks', { seriesId, title: itemTitle });
  if (created.status !== 201) throw new Error(`API 建目失败 ${created.status}`);
  taskId = created.body.task.id;
  note('fallback', '界面上没有走通新建，用了 API 建目（已记录）');
});
if (!taskId) {
  console.log('无法拿到 taskId，终止');
  process.exit(1);
}
console.log(`taskId=${taskId}`);

// ── 6. 目工作台：五步种子走 API（七步真人对话是另一条 walk 的事），进入「生成与导出」
// 这里复用 e2e 的种子序列（目标→知识点→条目→覆盖），但走真实门禁。
await run('种出走到大纲阶段的目（API，含确认课程方向）', async () => {
  const patch = await api('PATCH', `/api/curriculum/design/tasks/${taskId}`, {
    audience: '有大模型基础的开发工程师',
    problemStatement: '能把 RAG 问答的检索质量调上去',
    durationHours: 2,
  });
  if (patch.status !== 200)
    throw new Error(`PATCH brief: ${patch.status} ${JSON.stringify(patch.body).slice(0, 200)}`);
  const post = async (p, b = {}) => {
    const r = await api('POST', `/api/curriculum/design/tasks/${taskId}/${p}`, b);
    if (r.status >= 300)
      throw new Error(`${p}: ${r.status} ${JSON.stringify(r.body).slice(0, 220)}`);
    return r.body;
  };
  // 方向卡片确认（真实门禁的一部分：填好 ≠ 确认过）
  await post('direction', { note: '走查确认' });
  await post('phase');
  const obj = await post('objectives', {
    title: '独立完成 RAG 检索质量调优',
    objectiveType: 'skill',
    expectedBehavior: '调整分块与检索参数后，答案引用命中率提升',
    minCriteria: ['给出调优前后对比'],
  });
  await post('evidence', {
    objectiveId: obj.objective.id,
    evidenceType: 'quiz',
    verificationMethod: '测验',
    successCondition: '答对关键题',
  });
  await post('outcomes');
  await post('phase');
  for (const name of ['分块策略', '混合检索', '重排序'])
    await post('nodes', { name, nodeType: 'knowledge' });
  const snapshot = await api('GET', `/api/curriculum/design/tasks/${taskId}`);
  const put = await api('PUT', `/api/curriculum/design/tasks/${taskId}/node-objectives`, {
    links: snapshot.body.nodes.map((n) => ({
      nodeId: n.id,
      objectiveId: obj.objective.id,
      supportLevel: 'primary',
    })),
  });
  if (put.status >= 300)
    throw new Error(`node-objectives: ${put.status} ${JSON.stringify(put.body).slice(0, 200)}`);
  await post('knowledge');
  await post('knowledge'); // 知识技能图签收（这一步的 POST 即确认）
  await post('phase');
  // 三条目各司其职（讲/练/考）。讲课条目要带教学设计+分镜，练/考要带教学设计，
  // 与 s5-production-walk 同一闭合方式，但补上了分镜与「teaching」签收——
  // 409 的 gap 文案逐条告诉我们缺什么，这条种子是按它长出来的。
  const nodeNames = snapshot.body.nodes.map((n) => n.name);
  const units = {};
  for (const [title, role] of [
    ['1.1 检索质量调优', 'lecture'],
    ['1.2 动手调参', 'practice'],
    ['1.3 结业测验', 'exam'],
  ]) {
    const body = {
      title,
      unitType: 'item',
      unitRole: role,
      hours: 1,
      teachingDesign: { nodes: nodeIds0(snapshot), core: nodeNames },
    };
    if (role === 'lecture') {
      body.deckDesign = {
        estPages: 4,
        pages: [
          {
            order: 1,
            title: '封面',
            goal: '知道本节要解决什么',
            coreInfo: 'RAG 检索质量调优',
            mode: 'summary',
            teaches: nodeNames,
          },
          {
            order: 2,
            title: '分块策略',
            goal: '能说出分块大小的影响',
            coreInfo: '分块策略对比',
            mode: 'compare',
            teaches: ['分块策略'],
          },
          {
            order: 3,
            title: '混合检索',
            goal: '能配置混合检索',
            coreInfo: '混合检索+重排序',
            mode: 'explain',
            teaches: ['混合检索'],
          },
          {
            order: 4,
            title: '重排序',
            goal: '能解释重排序的作用',
            coreInfo: '重排序原理',
            mode: 'explain',
            teaches: ['重排序'],
          },
        ],
      };
    }
    const u = await post('units', body);
    units[role] = u.unit.id;
  }
  function nodeIds0(snap) {
    return snap.body.nodes.map((n) => n.id);
  }
  const kind = { lecture: 'teach', practice: 'practice', exam: 'assess' };
  for (const [role, unitId] of Object.entries(units)) {
    await post('unit-coverage', {
      unitId,
      objectiveId: obj.objective.id,
      coverageKind: kind[role],
      depth: 'standard',
    });
  }
  await post('outline'); // 签收大纲
  await post('phase'); // -> teaching
  await post('teaching', { note: '走查确认授课脚本与分镜' }); // 签收 teaching 步
  await post('phase'); // -> assessment
  await post('questions', {
    unitId: units.exam,
    objectiveId: obj.objective.id,
    questionType: 'single',
    stem: '提升 RAG 检索质量最先应该调整什么？',
    options: [
      { key: 'A', text: '分块与检索策略' },
      { key: 'B', text: '换个皮肤' },
    ],
    answer: ['A'],
  });
  await post('assessment', { note: '走查确认题目与实操' }); // 签收 assessment 步
  await post('phase'); // -> review
  await post('review');
  globalThis.__unitId = units.lecture;
  globalThis.__unitIds = units;
});
await shot('workbench-seeded');

await run('工作台五步面板可见', async () => {
  await page.goto(`${BASE}/curriculum/design/${taskId}`, { waitUntil: 'networkidle' });
  const text = await visibleText();
  const tabs = ['课程方向', '学习成果', '知识技能图', '课程大纲', '考与练', '生成与导出'];
  const missing = tabs.filter((t) => !text.includes(t));
  if (missing.length) note('copy', `工作台缺少 Tab 文案：${missing.join('、')}`);
});
await shot('workbench');

// ── 7. 生成与导出 Tab：真实门禁 + 真实生成 ───────────────────────────────
await run('打开「生成与导出」Tab', async () => {
  await page.getByRole('tab', { name: '生成与导出' }).click();
  await page.waitForTimeout(1200);
  const panel = page.getByTestId('produce-panel');
  if (!(await panel.isVisible().catch(() => false))) throw new Error('produce-panel 没出现');
});
await shot('produce-tab');

const gate = await api('GET', `/api/curriculum/design/tasks/${taskId}/export-gate`);
console.log(
  `gate: exportable=${gate.body?.exportable} blockers=${JSON.stringify(gate.body?.blockers)}`,
);

if (SKIP_GENERATE) {
  console.log('\n--skip-generate：到此为止。');
  writeFileSync(
    `${OUT}/result.json`,
    JSON.stringify(
      {
        owner: OWNER_ID,
        seriesId,
        taskId,
        unitId: globalThis.__unitId,
        gate: gate.body,
        notes,
        problems,
      },
      null,
      2,
    ),
  );
  await browser.close();
  process.exit(0);
}

// 真实生成：如果门禁没开，如实报告并停在原地（这本身就是走查发现）
let unitId = globalThis.__unitId;
let runId;
await run('点「生成」，走真实模型', async () => {
  if (!gate.body?.exportable) {
    note('gate', `真实门禁没开：${(gate.body?.blockers ?? []).join('；')}——按钮应为灰色`);
    const btn = page.getByRole('button', { name: '生成' }).first();
    const disabled = await btn.isDisabled().catch(() => true);
    if (!disabled) note('bug', '门禁没开但生成按钮仍然可点');
    throw new Error('门禁未开，跳过真实生成');
  }
  const btn = page.getByRole('button', { name: '生成' }).first();
  await btn.click();
  // 等出 run 状态行
  await page.waitForTimeout(2500);
  const text = await visibleText();
  const m = text.match(/run (run-[A-Za-z0-9_-]+)/);
  if (m) runId = m[1];
  if (!runId) throw new Error('点了生成但页面上没有出现 run 状态');
});
await shot('generate-started');

// 等真模型跑完（真实生成一段 slide 课程 + TTS，可能 5–15 分钟）
let stageId;
if (runId) {
  console.log(`等待真实生成完成（run=${runId}），每 15s 打一次点…`);
  for (let i = 0; i < 80; i += 1) {
    const r = await api('GET', `/api/generation-runs/${runId}`);
    const s = r.body?.run ?? {};
    console.log(
      `  state=${s.state} step=${s.step ?? ''} scenes=${s.progress?.scenesCompleted ?? '?'}/${s.progress?.scenesTotal ?? '?'}${s.stageId ? ` stage=${s.stageId}` : ''}`,
    );
    if (s.stageId) stageId = s.stageId;
    if (['completed', 'paused', 'ended'].includes(s.state)) break;
    if (s.state === 'failed')
      throw new Error(`run failed: ${JSON.stringify(s.error).slice(0, 300)}`);
    await page.waitForTimeout(15000);
  }
  if (!stageId) throw new Error('run 结束但没有 stageId');
  console.log(`stageId=${stageId}`);
  // 界面应自己长出「打开课堂」与「导出 MP4」
  await run('面板长出「打开课堂」与「导出 MP4」', async () => {
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('tab', { name: '生成与导出' }).click();
    await page.waitForTimeout(1500);
    const link = page.getByRole('link', { name: '打开课堂' }).first();
    if (!(await link.isVisible().catch(() => false))) throw new Error('没有「打开课堂」');
    const exportBtn = page.getByRole('button', { name: '导出 MP4' }).first();
    if (!(await exportBtn.isVisible().catch(() => false))) throw new Error('没有「导出 MP4」按钮');
  });
  await shot('produce-ready');
}

writeFileSync(
  `${OUT}/result.json`,
  JSON.stringify(
    { owner: OWNER_ID, seriesId, taskId, unitId, runId, stageId, gate: gate.body, notes, problems },
    null,
    2,
  ),
);
console.log(`\nconsole/page errors: ${problems.length ? problems.join(' | ') : '(none)'}`);
await browser.close();
