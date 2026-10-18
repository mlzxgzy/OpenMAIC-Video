/**
 * 系列设计第 3 步（知识体系）的「AI 生成候选 → 勾选采用」。
 *
 * 与第 2 步同一套交互，差别在两处，这里各钉一条：
 *
 * 1. 生成的**依据是第 2 步的课程目标**：没有目标时按钮是灰的（接口 409 是同一
 *    条规则的服务端版本）；
 * 2. 候选带**先修关系**（用节点名引用）：采用时解析成 id；指向未勾选候选的引用
 *    会被丢掉，所以「先勾 A 不勾 B、B 先修 A」仍然能保存。
 *
 * 接口用 `page.route` 打桩：这条 spec 测的是界面与合并语义，不是模型质量。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const SHOTS = path.join(process.cwd(), 'artifacts/regression/knowledge-ai');
fs.mkdirSync(SHOTS, { recursive: true });

async function createSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', {
    data: { name, description: '知识体系候选 e2e' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

async function deleteSeries(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.delete(`/api/curriculum/series/${seriesId}`);
  expect([200, 204], await response.text()).toContain(response.status());
}

const OBJECTIVE = {
  title: '能独立完成入门级 Web 题',
  type: '能力',
  expectedBehavior: '独立定位并利用题目漏洞拿到 flag',
  minCriteria: ['提交的 flag 正确'],
  evidence: 'Web 方向综合靶场',
};

const EXISTING_NODES = [
  {
    name: 'HTTP 请求与响应',
    type: 'knowledge',
    summary: '请求方法、状态码、Cookie',
    difficulty: 'intro',
    prerequisites: [],
  },
  {
    name: 'SQL 注入原理',
    type: 'knowledge',
    summary: '注入成因与常见手法',
    difficulty: 'basic',
    prerequisites: ['HTTP 请求与响应'],
  },
];

const CANDIDATES = [
  // 与已有节点重名：必须被筛掉。
  {
    name: 'SQL 注入原理',
    type: 'knowledge',
    summary: '重复的候选',
    difficulty: 'basic',
    prerequisites: [],
  },
  {
    name: '联合注入',
    type: 'knowledge',
    summary: 'UNION 回显的构造',
    difficulty: 'intermediate',
    prerequisites: ['SQL 注入原理'],
  },
  {
    name: '用 sqlmap 完成联合注入',
    type: 'skill',
    summary: '跑通 sqlmap 并取出目标表数据',
    difficulty: 'basic',
    prerequisites: ['联合注入'],
  },
  {
    name: '目录扫描',
    type: 'skill',
    summary: '用 ffuf 扫出隐藏目录',
    difficulty: 'basic',
    prerequisites: ['HTTP 请求与响应'],
  },
  {
    name: '抓包分析',
    type: 'skill',
    summary: '用 Wireshark 过滤并提取文件',
    difficulty: 'intermediate',
    prerequisites: [],
  },
  {
    name: '编写 Writeup',
    type: 'skill',
    summary: '把解题过程写成别人能复现的文档',
    difficulty: 'advanced',
    prerequisites: [],
  },
  {
    name: 'RSA 数论基础',
    type: 'knowledge',
    summary: '模运算与欧拉函数',
    difficulty: 'advanced',
    prerequisites: [],
  },
  {
    name: '编码识别',
    type: 'knowledge',
    summary: 'Base / URL / Unicode 的识别',
    difficulty: 'intro',
    prerequisites: [],
  },
];

test.describe('知识体系：AI 生成候选并勾选', () => {
  test.setTimeout(120_000);

  test('没有课程目标时按钮不可用：知识体系要支撑第 2 步', async ({ page }) => {
    const seriesId = await createSeries(page, `知识候选门禁 ${crypto.randomUUID().slice(0, 6)}`);
    await page.goto(`/curriculum/series/${seriesId}/design`);
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('nodes-ai')).toBeDisabled();

    // 定下目标之后按钮才可用。
    const patched = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
      data: { objectives: [OBJECTIVE] },
    });
    expect(patched.status(), await patched.text()).toBe(200);
    await page.reload();
    await expect(page.getByTestId('nodes-ai')).toBeEnabled({ timeout: 60_000 });

    await deleteSeries(page, seriesId);
  });

  test('按类型分组；重复候选不出现；采用追加并把先修解析成 id', async ({ page }) => {
    const seriesId = await createSeries(page, `知识候选 ${crypto.randomUUID().slice(0, 6)}`);
    const saved = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
      data: { objectives: [OBJECTIVE], nodes: EXISTING_NODES },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    await page.route(`**/api/curriculum/series/${seriesId}/design/knowledge/ai`, (route) =>
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
    await expect(page.getByText('知识体系（2 个知识 / 技能点）')).toBeVisible();
    await expect(page.getByText('课程目标与证据（1 条，属于整个系列）')).toBeVisible();

    await page.getByTestId('nodes-ai').click();
    const dialog = page.getByTestId('knowledge-candidates-dialog');
    await expect(dialog).toBeVisible();

    // 按类型分组：知识与技能的小标题都在；与已有节点重名的那条不出现。
    await expect(dialog.getByText('知识', { exact: true })).toBeVisible();
    await expect(dialog.getByText('技能', { exact: true })).toBeVisible();
    await expect(dialog.getByText('SQL 注入原理', { exact: true })).toHaveCount(0);
    await expect(dialog.getByText('联合注入', { exact: true })).toBeVisible();
    await expect(dialog.getByText('先修：SQL 注入原理')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '01-candidates.png'), fullPage: true });

    // 一条没勾时采用按钮是灰的。
    await expect(page.getByTestId('knowledge-candidates-adopt')).toBeDisabled();

    // 勾两个：联合注入（知识）+ 用 sqlmap（技能，先修是联合注入）。
    await dialog.getByText('联合注入', { exact: true }).click();
    await dialog.getByText('用 sqlmap 完成联合注入').click();
    await expect(page.getByTestId('knowledge-candidates-adopt')).toContainText('（2 个）');
    await page.screenshot({ path: path.join(SHOTS, '02-selected.png'), fullPage: true });

    await page.getByTestId('knowledge-candidates-adopt').click();
    await expect(dialog).toBeHidden();

    // 卡片按类型分组显示：已有两个 + 新增两个。
    await expect(page.getByText('知识体系（4 个知识 / 技能点）')).toBeVisible();
    await expect(page.getByText(/分类：.*知识 3.*技能 1/)).toBeVisible();
    await expect(page.getByText('联合注入', { exact: true })).toBeVisible();
    await expect(page.getByText('用 sqlmap 完成联合注入')).toBeVisible();
    await page.screenshot({ path: path.join(SHOTS, '03-adopted.png'), fullPage: true });

    // 刷新后仍在：写的是库，不是内存。
    await page.reload();
    await expect(page.getByText('知识体系（4 个知识 / 技能点）')).toBeVisible({ timeout: 60_000 });

    const design = (await (
      await page.request.get(`/api/curriculum/series/${seriesId}/design`)
    ).json()) as {
      design: {
        nodes: Array<{ id: string; name: string; prerequisites: string[] }>;
      };
    };
    expect(design.design.nodes.map((node) => node.id)).toEqual(['sn_1', 'sn_2', 'sn_3', 'sn_4']);
    // 先修在采用时解析成 id；联合注入先修的是已有节点 SQL 注入原理。
    expect(design.design.nodes[2]).toMatchObject({ name: '联合注入', prerequisites: ['sn_2'] });
    expect(design.design.nodes[3]).toMatchObject({
      name: '用 sqlmap 完成联合注入',
      prerequisites: ['sn_3'],
    });

    await deleteSeries(page, seriesId);
  });

  test('取消不改库：候选只是内存里的清单', async ({ page }) => {
    const seriesId = await createSeries(page, `知识候选取消 ${crypto.randomUUID().slice(0, 6)}`);
    const saved = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
      data: { objectives: [OBJECTIVE] },
    });
    expect(saved.status(), await saved.text()).toBe(200);
    await page.route(`**/api/curriculum/series/${seriesId}/design/knowledge/ai`, (route) =>
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
    await page.getByTestId('nodes-ai').click();
    const dialog = page.getByTestId('knowledge-candidates-dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByText('联合注入', { exact: true }).click();
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await expect(dialog).toBeHidden();

    const design = (await (
      await page.request.get(`/api/curriculum/series/${seriesId}/design`)
    ).json()) as { design: { nodes: unknown[] } };
    expect(design.design.nodes).toHaveLength(0);

    await deleteSeries(page, seriesId);
  });
});
