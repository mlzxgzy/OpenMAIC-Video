/**
 * 系列的入口顺序：**先系列设计（前三步），后大纲**。
 *
 * 这条 spec 钉的是两件在接口层看不出来的事：
 *
 * 1. 空系列打开驾驶舱会落到 `/design`——不是停在"空大纲"的驾驶舱，让用户对着
 *    一个只能靠系列名称猜的 AI 按钮；
 * 2. 驾驶舱与 AI 对话框如实转述"这次有没有课程级依据"：设计定完时给目标 /
 *    知识点计数，没定完时点名缺口；已有大纲的历史系列不跳转（否则等于把用户
 *    已经做出来的大纲藏起来），而是给横幅。
 *
 * 数据全部走真实接口 + 真实数据库（系列创建、大纲建章、系列设计 PATCH），
 * 不调模型：这一层测的是顺序与门禁，不是生成质量。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(process.cwd(), 'artifacts/regression/design-first');
fs.mkdirSync(SHOTS, { recursive: true });

const DESIGN = {
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
  ],
  objectives: [
    {
      title: '能独立完成 Web 入门题',
      expectedBehavior: '从信息收集到拿到 flag，独立完成',
      minCriteria: ['至少完成 1 道'],
      evidence: '实操考核记录',
      nodeIds: ['SQL 注入'],
    },
  ],
} as const;

async function createSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', {
    data: { name, description: '设计优先 e2e' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

async function deleteSeries(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.delete(`/api/curriculum/series/${seriesId}`);
  expect([200, 204], await response.text()).toContain(response.status());
}

test.describe('系列入口：先设计，后大纲', () => {
  test.setTimeout(180_000);

  test('空系列先被送到系列设计；设计定完后驾驶舱与 AI 才拿到依据', async ({ page }) => {
    const seriesId = await createSeries(page, `设计优先 ${crypto.randomUUID().slice(0, 6)}`);

    await page.goto(`/curriculum/series/${seriesId}`);
    await expect(page).toHaveURL(new RegExp(`/curriculum/series/${seriesId}/design$`), {
      timeout: 60_000,
    });
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible();
    await expect(page.getByText('① 方向 · 你在这')).toBeVisible();
    // 前三步没定完时，大纲不是一个可点的入口。
    await expect(page.getByTestId('design-outline-cta')).toBeDisabled();
    await page.screenshot({ path: path.join(SHOTS, '01-redirect-to-design.png'), fullPage: true });

    // 按真实用户路径补齐前三步。
    const saved = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
      data: DESIGN,
    });
    expect(saved.status(), await saved.text()).toBe(200);

    // 设计定完，驾驶舱可达；此时还没有大纲，主角卡是"先把大纲搭出来"。
    await page.goto(`/curriculum/series/${seriesId}`);
    await expect(page.getByText('这个系列还没有章。先出章，再出节，最后才是目。')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByLabel('系列设计未完成')).toHaveCount(0);
    await page.screenshot({
      path: path.join(SHOTS, '02-cockpit-design-ready.png'),
      fullPage: true,
    });

    // AI 对话框在生成之前就说清依据：几条课程目标、几个知识点。
    const aiCard = page.getByLabel('用 AI 生成大纲');
    await aiCard.getByRole('button', { name: 'AI 生成章', exact: true }).click();
    await expect(page.getByTestId('outline-ai-basis')).toContainText('依据系列设计');
    await expect(page.getByTestId('outline-ai-basis')).toContainText('课程目标 1 条');
    await expect(page.getByTestId('outline-ai-basis')).toContainText('知识体系 1 个点');
    await page.screenshot({ path: path.join(SHOTS, '03-ai-basis-complete.png'), fullPage: true });
    await page.getByRole('button', { name: '取消' }).click();

    await deleteSeries(page, seriesId);
  });

  test('已有大纲但设计未完成：不跳转、不藏大纲，横幅与对话框都说缺依据', async ({ page }) => {
    const seriesId = await createSeries(page, `历史大纲 ${crypto.randomUUID().slice(0, 6)}`);
    const chapter = await page.request.post(`/api/curriculum/series/${seriesId}/outline`, {
      data: { nodeType: 'chapter', title: '第一章 历史章' },
    });
    expect(chapter.status(), await chapter.text()).toBe(201);

    await page.goto(`/curriculum/series/${seriesId}`);
    // 历史数据不跳转：已经做出来的大纲不能因为门禁而消失。
    await expect(page.getByLabel('系列设计未完成')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByLabel('系列设计未完成')).toContainText('系列设计还没定完');
    await expect(page.getByText('1 章 · 0 节 · 0 目').first()).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '04-banner-incomplete.png'), fullPage: true });

    // 对话框里同一句话：这次只能按名称与说明猜。
    const aiCard = page.getByLabel('用 AI 生成大纲');
    await aiCard.getByRole('button', { name: 'AI 生成章', exact: true }).click();
    await expect(page.getByTestId('outline-ai-basis')).toContainText('系列设计还没定完');
    await page.screenshot({
      path: path.join(SHOTS, '05-ai-basis-incomplete.png'),
      fullPage: true,
    });
    await page.getByRole('button', { name: '取消' }).click();

    // 设计页的第 4 步同样被挡住，理由在按钮上。
    await page.goto(`/curriculum/series/${seriesId}/design`);
    await expect(page.getByTestId('design-outline-cta')).toBeDisabled();

    await deleteSeries(page, seriesId);
  });
});
