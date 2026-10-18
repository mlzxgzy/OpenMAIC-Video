/**
 * 系列设计第 2 步（课程目标）的「AI 生成候选 → 勾选采用」。
 *
 * 这一步和另外两个 AI 入口的差别是**它不替用户决定写几条**：AI 给一批带类型的候选，
 * 用户按类型分组勾选。所以这里钉四件事：
 *
 * 1. 候选按类型分组显示（知识 / 技能 / 能力 / 任务），不是一条平铺长列表；
 * 2. 与已有目标重复的候选不出现（比较去空白，不是逐字相等）；
 * 3. 采用把选中的追加到已有目标之后，已有目标不动；
 * 4. 取消不改库；一条没勾时采用按钮是灰的。
 *
 * 接口用 `page.route` 打桩：这条 spec 测的是界面与合并语义，不是模型质量。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(process.cwd(), 'artifacts/regression/objectives-ai');
fs.mkdirSync(SHOTS, { recursive: true });

async function createSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', {
    data: { name, description: '课程目标候选 e2e' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

async function deleteSeries(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.delete(`/api/curriculum/series/${seriesId}`);
  expect([200, 204], await response.text()).toContain(response.status());
}

const EXISTING_OBJECTIVE = {
  title: '能解释注入成因',
  type: '知识',
  expectedBehavior: '说清触发条件',
  minCriteria: ['三类成因说对'],
  evidence: '理论题',
};

const CANDIDATES = [
  {
    title: '能解释 注入成因',
    type: 'knowledge',
    expectedBehavior: '与已有目标只差一个空格：必须被筛掉',
    minCriteria: ['说对'],
    evidence: '理论题',
  },
  {
    title: '能说出三种编码的区别',
    type: 'knowledge',
    expectedBehavior: '举例说明 Base / URL / Unicode 的区别',
    minCriteria: ['三类编码举例正确'],
    evidence: '理论题',
  },
  {
    title: '能解释同源策略',
    type: 'knowledge',
    expectedBehavior: '说清浏览器会拦哪些跨源请求',
    minCriteria: ['能判断哪些请求会被拦'],
    evidence: '理论题',
  },
  {
    title: '能用 sqlmap 完成联合注入',
    type: 'skill',
    expectedBehavior: '独立跑完并取出目标表数据',
    minCriteria: ['拿到目标表内容'],
    evidence: '靶场实操',
  },
  {
    title: '能独立完成目录扫描',
    type: 'skill',
    expectedBehavior: '扫出隐藏目录并判断入口',
    minCriteria: ['找到至少一个隐藏目录'],
    evidence: '靶场实操',
  },
  {
    title: '能独立拿下陌生靶场',
    type: 'competency',
    expectedBehavior: '从信息收集走到拿 flag',
    minCriteria: ['60 分钟内拿 flag'],
    evidence: '综合靶场',
  },
  {
    title: '能完成一套入门赛题',
    type: 'task',
    expectedBehavior: '限时独立完成一整套题',
    minCriteria: ['拿到至少 3 个 flag'],
    evidence: '模拟赛',
  },
];

test.describe('课程目标：AI 生成候选并勾选', () => {
  test.setTimeout(120_000);

  test('按类型分组；重复候选不出现；采用后追加进库，已有目标不动', async ({ page }) => {
    const seriesId = await createSeries(page, `目标候选 ${crypto.randomUUID().slice(0, 6)}`);
    const saved = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
      data: { objectives: [EXISTING_OBJECTIVE] },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    await page.route(`**/api/curriculum/series/${seriesId}/design/objectives/ai`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: CANDIDATES }),
      }),
    );

    await page.goto(`/curriculum/series/${seriesId}/design`);
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('课程目标与证据（1 条，属于整个系列）')).toBeVisible();

    await page.getByTestId('objectives-ai').click();
    const dialog = page.getByTestId('objective-candidates-dialog');
    await expect(dialog).toBeVisible();

    // 按类型分组：四个类型的小标题都在；与已有目标重复的那条不出现。
    for (const label of ['知识', '技能', '能力', '任务']) {
      await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(dialog.getByText('能解释 注入成因')).toHaveCount(0);
    await expect(dialog.getByTestId('objective-candidate-0')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '01-candidates.png'), fullPage: true });

    // 一条没勾时采用按钮是灰的。
    await expect(page.getByTestId('objective-candidates-adopt')).toBeDisabled();

    // 分组全选：知识组两条，选完按钮上的数字跟着变；再点一次取消。
    const selectGroup = dialog.getByRole('button', { name: '全选 / 取消' }).first();
    await selectGroup.click();
    await expect(page.getByTestId('objective-candidates-adopt')).toContainText('（2 条）');
    await selectGroup.click();
    await expect(page.getByTestId('objective-candidates-adopt')).toContainText('（0 条）');

    // 勾两条：一条技能、一条任务。
    await dialog.getByText('能用 sqlmap 完成联合注入').click();
    await dialog.getByText('能完成一套入门赛题').click();
    await expect(page.getByTestId('objective-candidates-adopt')).toContainText('（2 条）');
    await page.screenshot({ path: path.join(SHOTS, '02-selected.png'), fullPage: true });

    await page.getByTestId('objective-candidates-adopt').click();
    await expect(dialog).toBeHidden();

    // 卡片按类型分组显示：已有那条（未分类）+ 新增两条。
    await expect(page.getByText('课程目标与证据（3 条，属于整个系列）')).toBeVisible();
    await expect(page.getByText('能用 sqlmap 完成联合注入')).toBeVisible();
    await expect(page.getByText('能完成一套入门赛题')).toBeVisible();
    await expect(page.getByText('能解释注入成因', { exact: true })).toBeVisible();
    await expect(page.getByText(/分类：.*技能 1.*任务 1/)).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '03-adopted.png'), fullPage: true });

    // 刷新后仍在：写的是库，不是内存。
    await page.reload();
    await expect(page.getByText('能用 sqlmap 完成联合注入')).toBeVisible({ timeout: 60_000 });
    const design = (await (
      await page.request.get(`/api/curriculum/series/${seriesId}/design`)
    ).json()) as {
      design: { objectives: Array<{ title: string; type: string | null; nodeIds: string[] }> };
    };
    expect(design.design.objectives).toHaveLength(3);
    expect(design.design.objectives.map((objective) => objective.type)).toEqual([
      'knowledge',
      'skill',
      'task',
    ]);
    expect(design.design.objectives[0].title).toBe('能解释注入成因');

    await deleteSeries(page, seriesId);
  });

  test('取消不改库：候选只是内存里的清单', async ({ page }) => {
    const seriesId = await createSeries(page, `目标候选取消 ${crypto.randomUUID().slice(0, 6)}`);
    await page.route(`**/api/curriculum/series/${seriesId}/design/objectives/ai`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ candidates: CANDIDATES }),
      }),
    );

    await page.goto(`/curriculum/series/${seriesId}/design`);
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible({
      timeout: 60_000,
    });
    await page.getByTestId('objectives-ai').click();
    const dialog = page.getByTestId('objective-candidates-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('能独立拿下陌生靶场').click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();

    const design = (await (
      await page.request.get(`/api/curriculum/series/${seriesId}/design`)
    ).json()) as { design: { objectives: unknown[] } };
    expect(design.design.objectives).toHaveLength(0);

    await deleteSeries(page, seriesId);
  });
});
