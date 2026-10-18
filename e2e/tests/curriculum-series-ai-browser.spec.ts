/**
 * 系列驾驶舱与系列设计页的**真实浏览器**验证。
 *
 * 存在的理由：前几轮所有"界面已接好"的结论都来自 tsc / lint / 接口层活体
 * walk——它们证不了"按钮点下去对话框真的开、预览真的渲染、写入之后看板真的变"。
 * 这条 spec 就是补那一格：真的开一个 Chromium，真的点。
 *
 * 模型这一层用 `page.route` 拦掉（预览是唯一会调模型的动作），其余全部走
 * **真实接口 + 真实数据库**：写入、章节目的约束、驾驶舱推荐都是真数据算出来的。
 * 拦掉模型不是走捷径，是让验证可重复——否则每次运行拿到的章名都不同，断言只能
 * 写成"有东西"。而 commit 不拦：它不调模型，正好用来验"预览之后原样写进去"。
 *
 * 预检（"没有章就不能生成节"这类）刻意**不拦**：它在调模型之前就返回，不花钱，
 * 是本 spec 里唯一能零成本验真实规则层的地方。
 *
 * 跑法（两个环境细节都会让 spec 假失败）：
 * - `E2E_BASE_URL` 用 `http://localhost:<port>`，不要用 `127.0.0.1` —— Next dev 把
 *   后者当外部 origin，`/_next/static/*` 会整批 403，页面永远停在加载态。
 * - 起一个**新**的 dev server。长跑的 `next dev` 会把已经求值过的 route 模块留在内存里，
 *   改完导入路径后即使磁盘上的 chunk 已重写，运行时仍是旧绑定（表现为提交 500）。
 */
import { test, expect } from '../fixtures/base';
import type { Cookie, Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(process.cwd(), 'artifacts/regression/browser-verify');
fs.mkdirSync(SHOTS, { recursive: true });

interface OutlineNode {
  id: string;
  parentId: string | null;
  nodeType: 'chapter' | 'section';
  code: string | null;
  title: string;
}

interface OutlinePayload {
  nodes: OutlineNode[];
}

/** 拦截到的预览计划：只在 `action=preview` 时用，commit 一律放行给真服务端。 */
type QueuedPreview = { preview: Record<string, unknown>; plan: Record<string, unknown> };
let queued: QueuedPreview | null = null;

/**
 * 所有者是**匿名 cookie**：`/api/curriculum/*` 用一个匿名身份把系列圈给创建者。
 * 每个 Playwright test 拿到的是全新 context（空 cookie 罐），所以播种用的
 * cookie 必须显式带进来——否则第二个测试看到的是别人的 404，而不是自己的系列。
 */
let ownerCookies: Cookie[] = [];

/**
 * 前三步（方向 / 课程目标 / 知识体系）是系列级依据：驾驶舱在"没有设计也没有
 * 大纲"时会直接跳到系列设计页，所以播种必须先把设计定下来，否则这一 spec 永远
 * 到不了大纲。这里走真实 PATCH 接口，形状与界面保存的完全一致。
 */
async function seedSeriesDesign(page: Page, targetSeriesId: string): Promise<void> {
  const response = await page.request.patch(`/api/curriculum/series/${targetSeriesId}/design`, {
    data: {
      direction: {
        audience: '零基础高校网络安全专业学生',
        learnerLevel: '会 Linux 基本命令、懂 HTTP 请求',
        trainingScenario: '线下集中实训 + 线上自学',
        applicationScene: '校内选拔赛 / 校队集训',
        problemStatement: 'CTF 五个方向全覆盖；不包含真实攻防演练',
        durationHours: 54,
      },
      nodes: [
        {
          name: 'SQL 注入',
          type: 'knowledge',
          summary: '联合查询与报错注入',
          difficulty: 'basic',
          prerequisites: [],
        },
        {
          name: '信息收集',
          type: 'knowledge',
          summary: '目录扫描与源码泄露',
          difficulty: 'intro',
          prerequisites: [],
        },
      ],
      objectives: [
        {
          title: '能独立完成 Web 入门题',
          expectedBehavior: '从信息收集到拿到 flag，独立完成',
          minCriteria: ['至少完成 1 道'],
          evidence: '实操考核记录',
          nodeIds: ['SQL 注入', '信息收集'],
        },
      ],
    },
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function interceptPreview(page: Page): Promise<void> {
  await page.route('**/api/curriculum/series/*/outline/ai', async (route) => {
    const body = route.request().postDataJSON() as { action?: string } | null;
    if (body?.action !== 'preview' || !queued) {
      await route.continue();
      return;
    }
    const payload = queued;
    queued = null;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(payload),
    });
  });
}

function summaryFields(level: string, writes: Record<string, number>) {
  return {
    level,
    mode: 'fill',
    chapters: [] as unknown[],
    sections: [] as unknown[],
    items: [] as unknown[],
    removeChapterIds: [] as string[],
    removeSectionIds: [] as string[],
    removeItemIds: [] as string[],
    skipped: [] as unknown[],
    warnings: [] as string[],
    replaceAllowed: true,
    replaceBlockedReason: null,
    writes,
    removes: { chapters: 0, sections: 0, items: 0 },
    canCommit: true,
    blockedReason: null,
  };
}

function chapterPreview(titles: readonly string[]): QueuedPreview {
  const chapters = titles.map((title) => ({ title, note: `${title}：本章要覆盖的内容面与边界` }));
  const summary = {
    ...summaryFields('chapter', { chapters: chapters.length, sections: 0, items: 0 }),
    chapters,
  };
  return { preview: summary, plan: { level: 'chapter', chapters } };
}

function sectionPreview(chapterCodes: readonly string[]): QueuedPreview {
  const plan = {
    level: 'section',
    chapters: chapterCodes.map((chapterCode) => ({
      chapterCode,
      sections: [
        { title: `第 ${chapterCode} 章案例一`, note: '交底：本节的案例与 2–3 目的分工' },
        { title: `第 ${chapterCode} 章案例二`, note: '交底：本节的案例与 2–3 目的分工' },
      ],
    })),
  };
  const sections = plan.chapters.flatMap((chapter) =>
    chapter.sections.map((section) => ({ chapterCode: chapter.chapterCode, ...section })),
  );
  const summary = {
    ...summaryFields('section', { chapters: 0, sections: sections.length, items: 0 }),
    sections,
  };
  return { preview: summary, plan };
}

function itemPreview(sectionCodes: readonly string[]): QueuedPreview {
  const plan = {
    level: 'item',
    sections: sectionCodes.map((sectionCode) => ({
      sectionCode,
      items: [
        { title: `${sectionCode} 理论精讲`, kind: 'theory', hours: 1, note: '讲清楚判断依据' },
        { title: `${sectionCode} 靶场实操`, kind: 'practice', hours: 2, note: '动手拿 flag' },
        { title: `${sectionCode} 复盘测验`, kind: 'review', hours: 1, note: '复盘与测验' },
      ],
    })),
  };
  const items = plan.sections.flatMap((section) =>
    section.items.map((item) => ({ sectionCode: section.sectionCode, ...item })),
  );
  const summary = {
    ...summaryFields('item', { chapters: 0, sections: 0, items: items.length }),
    items,
  };
  return { preview: summary, plan };
}

async function readOutline(page: Page, seriesId: string): Promise<OutlinePayload> {
  const response = await page.request.get(`/api/curriculum/series/${seriesId}/outline`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as OutlinePayload;
}

function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const text = message.text();
    // Next dev 的 React DevTools 提示不是页面错误；favicon 404 也一样。
    if (text.includes('Download the React DevTools')) return;
    if (text.includes('favicon')) return;
    errors.push(text);
  });
  page.on('pageerror', (error) => errors.push(String(error)));
  return errors;
}

test.describe.configure({ mode: 'serial' });

test.describe('系列驾驶舱：AI 生成大纲的真实浏览器路径', () => {
  let seriesId = '';

  test.setTimeout(300_000);

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    const page = await context.newPage();
    const response = await page.request.post('/api/curriculum/series', {
      data: {
        name: `浏览器验证系列 ${crypto.randomUUID().slice(0, 6)}`,
        description:
          '面向零基础高校学生，6 个方向各 1 个案例，理论用 slide 视频、实操用 Docker 靶场。',
      },
    });
    expect(response.status(), await response.text()).toBe(201);
    const created = (await response.json()) as { series: { id: string } };
    seriesId = created.series.id;
    // 驾驶舱的门禁要求前三步先定下来；这里先按真实用户路径把系列设计补完。
    await seedSeriesDesign(page, seriesId);
    ownerCookies = await context.cookies();
    await context.close();
  });

  test.afterAll(async ({ browser }) => {
    if (!seriesId) return;
    const context = await browser.newContext();
    await context.addCookies(ownerCookies);
    // 系列下还有目时删除会被拒（FK）：先把目清掉，再删系列。清理失败不算测试失败，
    // 但要真的清干净——这是临时数据，留在开发库里会污染下一次人工验收。
    const overview = await context.request.get(
      `/api/curriculum/design/overview?seriesId=${seriesId}`,
    );
    if (overview.ok()) {
      const payload = (await overview.json()) as { items?: { id: string }[] };
      for (const item of payload.items ?? []) {
        await context.request.delete(`/api/curriculum/design/tasks/${item.id}`);
      }
    }
    const response = await context.request.delete(`/api/curriculum/series/${seriesId}`);
    const status = response.status();
    const body = status === 204 ? '' : await response.text();
    await context.close();
    expect([200, 204], body).toContain(status);
  });

  test('三层生成：章 → 节 → 目，按钮状态、预览、写入与既有内容的护栏', async ({ page }) => {
    const errors = collectErrors(page);
    await interceptPreview(page);

    await page.context().addCookies(ownerCookies);
    await page.goto(`/curriculum/series/${seriesId}`);
    await expect(page.getByText('这个系列还没有章。先出章，再出节，最后才是目。')).toBeVisible({
      timeout: 60_000,
    });
    await page.screenshot({ path: path.join(SHOTS, '01-cockpit-empty.png'), fullPage: true });

    // 没有章时，节/目两个按钮必须是禁用状态——不是因为没接好，而是因为没有可生成的目标。
    const aiCard = page.getByLabel('用 AI 生成大纲');
    await expect(aiCard.getByRole('button', { name: 'AI 生成章', exact: true })).toBeEnabled();
    await expect(aiCard.getByRole('button', { name: 'AI 生成节', exact: true })).toBeDisabled();
    await expect(aiCard.getByRole('button', { name: 'AI 生成目', exact: true })).toBeDisabled();

    // ── 章 ────────────────────────────────────────────────────────────────
    await aiCard.getByRole('button', { name: 'AI 生成章', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI 生成章' })).toBeVisible();
    await expect(page.getByRole('button', { name: /补充新章/ })).toBeEnabled();
    await page.screenshot({ path: path.join(SHOTS, '02-dialog-chapter.png'), fullPage: true });

    queued = chapterPreview(['基础与环境', 'Web 安全', '综合实战']);
    await page.getByRole('button', { name: '生成预览' }).click();
    const chapterPreviewBox = page.getByTestId('outline-ai-preview');
    await expect(chapterPreviewBox).toContainText('新增 3 章', { timeout: 20_000 });
    await expect(chapterPreviewBox).toContainText('Web 安全');
    await page.screenshot({ path: path.join(SHOTS, '03-preview-chapter.png'), fullPage: true });

    await page.getByRole('button', { name: /写入/ }).click();
    await expect(page.getByRole('heading', { name: 'AI 生成章' })).toBeHidden();
    await expect(page.getByText('3 章 · 0 节 · 0 目').first()).toBeVisible({ timeout: 20_000 });

    let outline = await readOutline(page, seriesId);
    const chapterCodes = outline.nodes
      .filter((node) => node.nodeType === 'chapter')
      .map((node) => node.code ?? '');
    expect([...chapterCodes].sort()).toEqual(['1', '2', '3']);
    await page.screenshot({ path: path.join(SHOTS, '04-board-chapters.png'), fullPage: true });

    // ── 节 ────────────────────────────────────────────────────────────────
    await expect(aiCard.getByRole('button', { name: 'AI 生成节', exact: true })).toBeEnabled();
    await aiCard.getByRole('button', { name: 'AI 生成节', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI 生成节' })).toBeVisible();
    queued = sectionPreview(chapterCodes);
    await page.getByRole('button', { name: '生成预览' }).click();
    await expect(page.getByTestId('outline-ai-preview')).toContainText('新增 6 节', {
      timeout: 20_000,
    });
    await page.screenshot({ path: path.join(SHOTS, '05-preview-sections.png'), fullPage: true });
    await page.getByRole('button', { name: /写入/ }).click();
    await expect(page.getByRole('heading', { name: 'AI 生成节' })).toBeHidden();
    await expect(page.getByText('3 章 · 6 节 · 0 目').first()).toBeVisible({ timeout: 20_000 });

    outline = await readOutline(page, seriesId);
    const sectionCodes = outline.nodes
      .filter((node) => node.nodeType === 'section')
      .map((node) => node.code ?? '');
    expect([...sectionCodes].sort()).toEqual(['1-1', '1-2', '2-1', '2-2', '3-1', '3-2']);
    // 看板把章交底 / 节交底显示出来：这是"下一层不脱节"的唯一可见证据。
    await expect(page.getByText('交底：本节的案例与 2–3 目的分工').first()).toBeVisible();

    // ── 目 ────────────────────────────────────────────────────────────────
    await expect(aiCard.getByRole('button', { name: 'AI 生成目', exact: true })).toBeEnabled();
    await aiCard.getByRole('button', { name: 'AI 生成目', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'AI 生成目' })).toBeVisible();
    queued = itemPreview(sectionCodes);
    await page.getByRole('button', { name: '生成预览' }).click();
    await expect(page.getByTestId('outline-ai-preview')).toContainText('新增 18 目', {
      timeout: 20_000,
    });
    await page.screenshot({ path: path.join(SHOTS, '06-preview-items.png'), fullPage: true });
    await page.getByRole('button', { name: /写入/ }).click();
    await expect(page.getByRole('heading', { name: 'AI 生成目' })).toBeHidden();
    await expect(page.getByText('3 章 · 6 节 · 18 目').first()).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: path.join(SHOTS, '07-board-items.png'), fullPage: true });

    // 有目之后主角卡换成"现在做这一目"，推荐的是大纲里第一个目，编号 1-1-1。
    await page.reload();
    await expect(page.getByLabel('现在做这一目')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('decision-title')).toContainText('1-1-1');
    await page.screenshot({ path: path.join(SHOTS, '08-cockpit-decision.png'), fullPage: true });

    // ── 既有内容的护栏（真实规则层，不拦模型）──────────────────────────────
    // 每一章都已经有节、每一节都已经有目。这时再点生成：预检在调模型之前就拒绝。
    await aiCard.getByRole('button', { name: 'AI 生成节', exact: true }).click();
    await page.getByRole('button', { name: '生成预览' }).click();
    const blockedSection = page.getByTestId('outline-ai-preview');
    await expect(blockedSection).toContainText('每一章都已经有节了', { timeout: 20_000 });
    await expect(page.getByRole('button', { name: /^写入/ })).toBeDisabled();
    // 系列里已经有目：覆盖重建节会让目失去归属，服务端把 replace 置为不可用。
    await expect(page.getByRole('button', { name: /覆盖重建节/ })).toBeDisabled();
    await expect(page.getByText(/已有.*个目|会让.*目|归属/).first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '09-guardrail-sections.png'), fullPage: true });
    await page.getByRole('button', { name: '取消' }).click();

    await aiCard.getByRole('button', { name: 'AI 生成目', exact: true }).click();
    await page.getByRole('button', { name: '生成预览' }).click();
    await expect(page.getByTestId('outline-ai-preview')).toContainText('每一节都已经有目了', {
      timeout: 20_000,
    });
    await page.getByRole('button', { name: '取消' }).click();

    expect(errors, errors.join('\n---\n')).toEqual([]);
  });

  test('系列设计页：方向保存、步骤条推进、AI 起草采用', async ({ page }) => {
    const errors = collectErrors(page);
    // 用独立系列：上面的共享系列已经被 seedSeriesDesign 定完，而这一条要验的
    // 正是"空设计 → 填方向 → 采用草稿"的过程。
    await page.context().addCookies(ownerCookies);
    const created = await page.request.post('/api/curriculum/series', {
      data: { name: `设计页验证 ${crypto.randomUUID().slice(0, 6)}`, description: '设计页 e2e' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const designSeriesId = ((await created.json()) as { series: { id: string } }).series.id;
    await page.route('**/api/curriculum/series/*/design/ai', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          draft: {
            objectives: [
              {
                id: 'obj-1',
                title: '能独立完成一道 Web 入门题',
                expectedBehavior: '从信息收集到拿到 flag，独立完成并不借助 writeup',
                minCriteria: ['至少完成 1 道'],
                evidence: '实操考核记录',
                // 与 normalizeSeriesDesignDoc / parseNodes 的 id 约定一致：sn_<序号>。
                // 采用草稿是一次 PATCH 同时写目标与节点，目标里的引用必须能落到
                // 同一次写入的节点上；id 用别的命名会被 store 判成"节点不存在"。
                nodeIds: ['sn_1'],
              },
            ],
            nodes: [
              {
                id: 'sn_1',
                name: '信息收集',
                type: 'knowledge',
                summary: '目录扫描与源码泄露的识别',
                difficulty: 'basic',
                prerequisites: [],
              },
            ],
          },
        }),
      });
    });

    await page.goto(`/curriculum/series/${designSeriesId}/design`);
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('未填写').first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '10-design-empty.png'), fullPage: true });

    await page.getByRole('button', { name: '编辑方向' }).click();
    await expect(page.getByRole('heading', { name: '系列方向' })).toBeVisible();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('授课对象').fill('零基础高校网络安全专业学生');
    await dialog.getByLabel('学员基础').fill('会 Linux 基本命令、懂 HTTP 请求');
    await dialog.getByLabel('训练场景').fill('线下集中实训 + 线上自学');
    await dialog.getByLabel('应用场景').fill('校内选拔赛 / 校队集训');
    await dialog.getByLabel('课程范围').fill('CTF 五个方向全覆盖；不包含真实攻防演练');
    await dialog.getByLabel('系列总学时').fill('54');
    await dialog.getByRole('button', { name: '保存方向' }).click();
    await expect(page.getByText('方向已完整，目会继承它。')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({
      path: path.join(SHOTS, '11-design-direction-saved.png'),
      fullPage: true,
    });

    await page.getByRole('button', { name: 'AI 起草' }).first().click();
    await expect(page.getByRole('heading', { name: 'AI 起草结果' })).toBeVisible();
    await expect(page.getByText('能独立完成一道 Web 入门题')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '12-design-ai-draft.png'), fullPage: true });
    await page.getByRole('button', { name: '采用这份草稿' }).click();
    await expect(page.getByText('课程目标与证据（1 条，属于整个系列）')).toBeVisible({
      timeout: 20_000,
    });
    await expect(page.getByText('知识体系（1 个知识 / 技能点）')).toBeVisible();
    // 前三步定完：步骤条三个都打勾，第 4 步（大纲）成为下一步。
    await expect(page.getByText('④ 大纲（驾驶舱） · 下一步')).toBeVisible();
    await expect(page.getByTestId('design-outline-cta')).toBeEnabled();

    await page.reload();
    await expect(page.getByText('课程目标与证据（1 条，属于整个系列）')).toBeVisible({
      timeout: 30_000,
    });
    await page.screenshot({ path: path.join(SHOTS, '13-design-persisted.png'), fullPage: true });

    expect(errors, errors.join('\n---\n')).toEqual([]);

    const removed = await page.request.delete(`/api/curriculum/series/${designSeriesId}`);
    expect([200, 204], await removed.text()).toContain(removed.status());
  });

  test('目第 1 步：继承系列方向，确认按钮直接可用', async ({ page }) => {
    const errors = collectErrors(page);
    await page.context().addCookies(ownerCookies);
    const outline = await readOutline(page, seriesId);
    const section = outline.nodes.find((node) => node.nodeType === 'section');
    expect(section).toBeTruthy();

    const created = await page.request.post('/api/curriculum/design/tasks', {
      data: { seriesId, sectionId: section?.id, title: '浏览器验证：继承方向的目' },
    });
    expect(created.status(), await created.text()).toBe(201);
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;

    // 建目时会把系列方向**拷贝**进来（这样系列后来改方向不会追溯改动已建的目）。
    // 要验证"留空即继承"，先把它清空——这正是用户在卡片上点"清空"的效果。
    const cleared = await page.request.patch(`/api/curriculum/design/tasks/${taskId}`, {
      data: {
        audience: null,
        learnerLevel: null,
        trainingScenario: null,
        applicationScene: null,
        durationHours: null,
        problemStatement: '这一目只做信息收集与拿 flag',
      },
    });
    expect(cleared.status(), await cleared.text()).toBe(200);

    await page.goto(`/curriculum/design/${taskId}`);
    // 工作台默认停在「目标闭环矩阵」tab；方向卡片在设计编辑器里。
    await expect(page.getByRole('tab', { name: '设计编辑器' })).toBeVisible({ timeout: 60_000 });
    await page.getByRole('tab', { name: '设计编辑器' }).click();
    // 这一版把第 1 步改成**只读继承**：系列方向一次定完，目默认继承，只有本目
    // 确实不同时才点「覆盖」打开输入框。所以这里断言的是静态文本 + 来源标记，
    // 而不是输入框里的 value——上一版那两条断言对应的正是被这次改掉的交互。
    await expect(page.getByText('这一目继承的课程方向（来自系列）')).toBeVisible({
      timeout: 60_000,
    });
    const directionCard = page
      .locator('[data-slot="card"], .card')
      .filter({ hasText: '课程方向' })
      .first();
    await expect(directionCard).toContainText('零基础高校网络安全专业学生');
    await expect(directionCard).toContainText('（系列）');
    await expect(directionCard.locator('input:visible, textarea:visible')).toHaveCount(0);
    await expect(page.getByText('必填项已齐，可以确认。')).toBeVisible();

    const confirm = page.getByRole('button', { name: '确认课程方向' });
    await expect(confirm).toBeEnabled();
    await page.screenshot({ path: path.join(SHOTS, '14-workbench-inherited.png'), fullPage: true });
    await confirm.click();
    // 确认之后的持久证据：按钮被替换成"撤回确认"，确认按钮本身锁死。
    await expect(page.getByRole('button', { name: '撤回确认' })).toBeVisible({ timeout: 20_000 });
    await expect(confirm).toBeDisabled();
    await page.screenshot({ path: path.join(SHOTS, '15-workbench-confirmed.png'), fullPage: true });

    expect(errors, errors.join('\n---\n')).toEqual([]);
  });
});
