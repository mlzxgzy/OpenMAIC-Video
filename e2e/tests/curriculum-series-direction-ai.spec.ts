/**
 * 系列设计第 1 步（方向）的「AI 填写」。
 *
 * 这一步和另外两个 AI 入口的差别是**它不依赖已有设计**：新建的系列往往只有名称和
 * 一句说明。所以这里钉三件事：
 *
 * 1. 点按钮 → 弹预览，六个槽位都能在保存前改（保存的是眼前这份，不是模型原样）；
 * 2. 采用后真的写库（重新加载还在），不是只改内存；
 * 3. AI 没给的槽位保留用户当前值——AI 是来补空白的，不是来抹掉手写内容的。
 *
 * 接口用 `page.route` 打桩：这条 spec 测的是界面与合并语义，不是模型质量；真实
 * 模型调用由接口层用例与一次手工验证覆盖。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(process.cwd(), 'artifacts/regression/direction-ai');
fs.mkdirSync(SHOTS, { recursive: true });

async function createSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', {
    data: { name, description: '方向 AI 填写 e2e' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

async function deleteSeries(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.delete(`/api/curriculum/series/${seriesId}`);
  expect([200, 204], await response.text()).toContain(response.status());
}

const AI_DRAFT = {
  direction: {
    audience: '零基础高校网络安全专业学生',
    learnerLevel: '会 Linux 基本命令、懂 HTTP 请求',
    trainingScenario: '线下集中实训 + 线上自学',
    applicationScene: '校内选拔赛 / 校队集训',
    problemStatement: 'CTF 五个方向全覆盖；不包含真实攻防演练',
    durationHours: 54,
  },
} as const;

test.describe('系列方向：AI 填写', () => {
  test.setTimeout(120_000);

  test('预览里可以逐格改；采用后写进库里', async ({ page }) => {
    const seriesId = await createSeries(page, `方向AI ${crypto.randomUUID().slice(0, 6)}`);
    await page.route(`**/api/curriculum/series/${seriesId}/design/direction/ai`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(AI_DRAFT),
      }),
    );

    await page.goto(`/curriculum/series/${seriesId}/design`);
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible({
      timeout: 60_000,
    });
    // 方向卡上多了「AI 填写」，和「编辑方向」并排。
    await page.getByTestId('direction-ai').click();

    const dialog = page.getByTestId('direction-ai-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('direction-ai-audience')).toHaveValue(
      '零基础高校网络安全专业学生',
    );
    await expect(page.getByTestId('direction-ai-durationHours')).toHaveValue('54');
    await page.screenshot({
      path: path.join(SHOTS, '01-preview.png'),
      fullPage: true,
    });

    // 逐格改：改一个词、清掉一格，保存的应该是改过的这份。
    await page.getByTestId('direction-ai-audience').fill('计算机学院大三学生');
    await page.getByTestId('direction-ai-learnerLevel').fill('');
    await page.getByTestId('direction-ai-adopt').click();
    await expect(dialog).toBeHidden();

    // 卡片立刻反映采用结果。
    await expect(page.getByText('计算机学院大三学生')).toBeVisible();
    await expect(page.getByText('零基础高校网络安全专业学生')).toHaveCount(0);

    // 刷新后仍在：证明写的是库，不是内存。
    await page.reload();
    await expect(page.getByText('计算机学院大三学生')).toBeVisible({ timeout: 60_000 });
    const design = (await (
      await page.request.get(`/api/curriculum/series/${seriesId}/design`)
    ).json()) as {
      design: { direction: { audience: string | null; learnerLevel: string | null } };
    };
    expect(design.design.direction.audience).toBe('计算机学院大三学生');
    expect(design.design.direction.learnerLevel).toBeNull();
    await page.screenshot({
      path: path.join(SHOTS, '02-adopted.png'),
      fullPage: true,
    });

    await deleteSeries(page, seriesId);
  });

  test('AI 没给的槽位保留用户当前值；取消不改库', async ({ page }) => {
    const seriesId = await createSeries(page, `方向AI合并 ${crypto.randomUUID().slice(0, 6)}`);
    const saved = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
      data: { direction: { learnerLevel: '会 Linux 基本命令' } },
    });
    expect(saved.status(), await saved.text()).toBe(200);

    // 模型这次没给学员基础（null），但用户已经写了一条：不能被抹掉。
    await page.route(`**/api/curriculum/series/${seriesId}/design/direction/ai`, (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          direction: { ...AI_DRAFT.direction, learnerLevel: null },
        }),
      }),
    );

    await page.goto(`/curriculum/series/${seriesId}/design`);
    await page.getByTestId('direction-ai').click();
    const dialog = page.getByTestId('direction-ai-dialog');
    await expect(dialog).toBeVisible();
    await expect(page.getByTestId('direction-ai-learnerLevel')).toHaveValue('会 Linux 基本命令');

    // 取消 = 什么都不写。
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toBeHidden();
    const design = (await (
      await page.request.get(`/api/curriculum/series/${seriesId}/design`)
    ).json()) as { design: { direction: { audience: string | null } } };
    expect(design.design.direction.audience).toBeNull();

    await deleteSeries(page, seriesId);
  });
});
