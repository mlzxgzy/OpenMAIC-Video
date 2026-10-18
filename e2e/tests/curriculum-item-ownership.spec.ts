/**
 * 「七步归属」的浏览器验证：目编辑器不再要求把系列层的三步重做一遍。
 *
 * 这条 spec 存在的原因是一条用户路径：系列 → 大纲 → 某个目 → 设计编辑器，进去看到
 * 课程方向、学习目标、知识技能、大纲一排卡片，用户的反应是「咋又是课程方向和目标
 * 和大纲」。卡片本身没错，错的是没人说清哪几步属于系列。单元测试能钉住归属表，
 * 钉不住"步骤条真的分成了两段"、"第 1 步真的没有输入框"、"承接按钮真的写进了库"。
 *
 * 所以这里走真实接口播种 + 真实浏览器点击，断言四件事：
 *
 * 1. 步骤条分成「系列层 3 格 / 本目 4 格」，七格仍在（序号是流程，分组是归属）。
 * 2. 第 1 步默认只读：显示继承来的值、标出来源，没有任何可见输入框。
 * 3. 第 2 步承接系列课程目标：库里的目标带上系列来源，而且每条都有证据
 *    （没有证据就过不了第 2 步的门禁，承接反而制造更多工作）。
 * 4. 第 3 步承接知识技能点：节点带来源，并按系列目标声明的支撑关系自动连线。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';

interface SeriesSeed {
  seriesId: string;
  taskId: string;
  objectiveIds: string[];
}

async function seedSeriesWithDesign(page: Page, name: string): Promise<SeriesSeed> {
  const created = await page.request.post('/api/curriculum/series', { data: { name } });
  expect(created.status(), await created.text()).toBe(201);
  const seriesId = ((await created.json()) as { series: { id: string } }).series.id;

  const design = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
    data: {
      direction: {
        audience: '大二信息安全专业学生',
        learnerLevel: '会 Linux 基本命令',
        trainingScenario: '线下集中实训',
        applicationScene: '校内选拔赛',
        problemStatement: '整个系列解决 CTF 入门到能独立打题',
        durationHours: 54,
      },
      nodes: [
        {
          name: 'SQL 注入闭合方式',
          type: 'knowledge',
          summary: '单引号 / 数字型闭合的判断',
          difficulty: 'basic',
          prerequisites: [],
        },
        {
          name: '联合查询注入',
          type: 'skill',
          summary: 'order by 判字段数、找回显位',
          difficulty: 'intermediate',
          prerequisites: ['sn_1'],
        },
      ],
      objectives: [
        {
          title: '能利用 SQL 注入读出指定数据',
          expectedBehavior: '在靶场里判断注入点并读出 flag',
          minCriteria: ['判断出注入点', '读出 flag'],
          evidence: '在 Docker 靶场中独立完成一次拖库',
          nodeIds: ['sn_1', 'sn_2'],
        },
        {
          title: '能写出注入的修复建议',
          expectedBehavior: '给出一句参数化的修复方案',
          minCriteria: ['指出参数化查询'],
          evidence: '笔试一题',
          nodeIds: ['sn_1'],
        },
      ],
    },
  });
  expect(design.status(), await design.text()).toBe(200);
  const objectiveIds = (
    (await design.json()) as { design: { objectives: { id: string }[] } }
  ).design.objectives.map((objective) => objective.id);

  const chapter = await page.request.post(`/api/curriculum/series/${seriesId}/outline`, {
    data: { nodeType: 'chapter', title: '第一章 注入基础' },
  });
  const chapterId = ((await chapter.json()) as { node: { id: string } }).node.id;
  const section = await page.request.post(`/api/curriculum/series/${seriesId}/outline`, {
    data: { nodeType: 'section', parentId: chapterId, title: '第一节 SQL 注入' },
  });
  const sectionId = ((await section.json()) as { node: { id: string } }).node.id;
  const task = await page.request.post('/api/curriculum/design/tasks', {
    data: {
      seriesId,
      sectionId,
      title: '1-1-1 SQL 注入原理',
      code: '1-1-1',
      kind: 'theory',
    },
  });
  expect(task.status(), await task.text()).toBe(201);
  const taskId = ((await task.json()) as { task: { id: string } }).task.id;

  return { seriesId, taskId, objectiveIds };
}

test.describe('七步归属：系列层与目层分开', () => {
  test('目编辑器里前 3 步只读继承/承接，后 4 步才是本目自己的活', async ({ page }) => {
    const { taskId, objectiveIds } = await seedSeriesWithDesign(
      page,
      `七步归属 ${crypto.randomUUID().slice(0, 6)}`,
    );

    await page.goto(`/curriculum/design/${taskId}`);
    await page.getByRole('tab', { name: '设计编辑器' }).click();

    // ── 步骤条：两段，但仍是七格 ──────────────────────────────────────────
    const rail = page.getByTestId('step-rail');
    await expect(rail).toBeVisible();
    await expect(rail.locator('li')).toHaveCount(7);
    const bands = rail.locator('ol');
    await expect(bands).toHaveCount(2);
    await expect(bands.nth(0).locator('li')).toHaveCount(3);
    await expect(bands.nth(1).locator('li')).toHaveCount(4);
    await expect(rail).toContainText('系列层');
    await expect(rail).toContainText('本目');

    // ── 归属横幅 ────────────────────────────────────────────────────────
    const banner = page.getByLabel('七步归属');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('第 1 步 课程方向');
    await expect(banner).toContainText('第 4 步 本目大纲');

    // ── 第 1 步：只读继承 ───────────────────────────────────────────────
    const directionCard = page
      .locator('[data-slot="card"], .card')
      .filter({ hasText: '课程方向' })
      .first();
    await expect(directionCard).toContainText('大二信息安全专业学生');
    await expect(directionCard).toContainText('（系列）');
    // 默认没有可编辑的输入框：七个 InlineEdit 在"覆盖"开关后面。
    await expect(directionCard.locator('input:visible, textarea:visible')).toHaveCount(0);

    // ── 第 2 步：确认方向 → 进入第 2 步 → 承接课程目标 ─────────────────────
    await page.getByRole('button', { name: '确认课程方向' }).click();
    await page.getByRole('button', { name: /进入第 2 步/ }).click();
    await expect(page.getByText('从系列承接课程目标').first()).toBeVisible();

    const objectiveBoxes = page.locator('input[type="checkbox"]');
    await expect(objectiveBoxes.first()).toBeVisible();
    await objectiveBoxes.nth(0).check();
    await objectiveBoxes.nth(1).check();
    await page
      .getByRole('button', { name: /承接选中的/ })
      .first()
      .click();
    await expect(page.getByText('系列里的课程目标已经全部承接。')).toBeVisible();

    // 库里真的有了目标 + 证据 + 来源：按钮说"已承接"不算数。
    const afterObjectives = (await (
      await page.request.get(`/api/curriculum/design/tasks/${taskId}`)
    ).json()) as {
      objectives: { id: string; seriesObjectiveId: string | null }[];
      evidence: { objectiveId: string }[];
    };
    expect(afterObjectives.objectives).toHaveLength(2);
    expect(afterObjectives.objectives.map((row) => row.seriesObjectiveId)).toEqual(objectiveIds);
    for (const objective of afterObjectives.objectives) {
      expect(afterObjectives.evidence.some((row) => row.objectiveId === objective.id)).toBe(true);
    }

    // ── 第 3 步：确认目标 → 进入第 3 步 → 承接知识点 ─────────────────────
    await page.getByRole('button', { name: '确认学习目标与证据' }).click();
    await page.getByRole('button', { name: /进入第 3 步/ }).click();
    await expect(page.getByText('从系列承接知识技能点').first()).toBeVisible();

    const nodeBoxes = page.locator('input[type="checkbox"]');
    await nodeBoxes.nth(0).check();
    await nodeBoxes.nth(1).check();
    await page
      .getByRole('button', { name: /承接选中的/ })
      .first()
      .click();
    await expect(page.getByText('系列里的知识技能点已经全部承接。')).toBeVisible();

    const afterNodes = (await (
      await page.request.get(`/api/curriculum/design/tasks/${taskId}`)
    ).json()) as {
      nodes: { seriesNodeId?: string | null }[];
      nodeObjectives: unknown[];
    };
    expect(afterNodes.nodes).toHaveLength(2);
    expect(afterNodes.nodes.every((node) => typeof node.seriesNodeId === 'string')).toBe(true);
    // so_1 声明由 sn_1、sn_2 支撑，so_2 只由 sn_1 支撑：承接节点时连线一起建。
    expect(afterNodes.nodeObjectives).toHaveLength(3);

    // ── 第 4 步标题：本目大纲（不再与系列大纲同名）────────────────────────
    await expect(
      page.locator('[data-slot="card-title"]').filter({ hasText: '本目大纲' }).first(),
    ).toBeVisible();
  });
});
