/**
 * 设计变了之后，界面必须指出"哪些还是旧版设计的产物"。
 *
 * 这一层在接口测试里只能验到数字；这里验的是用户真正看到的三个地方：
 *
 * 1. 驾驶舱页头的横幅（点名章 / 节 / 目各有多少没跟上）；
 * 2. 看板上章、节、目各自的「旧版设计」标记；
 * 3. 系列设计页保存后的提示（不然"我明明改了设计，大纲怎么没变"会被当成保存失败）。
 *
 * 数据走向与真实使用一致：系列、设计、大纲都走真实接口。唯一的例外是"这一层
 * 是从设计生成的"这条事实——正常由 AI 生成时写入，这个 spec 不调模型，所以用
 * 一条 SQL 把生成指纹补到刚建的行上（等价于 AI 落库那一步），再改设计观察提示。
 */
import { Client } from 'pg';
import path from 'node:path';
import fs from 'node:fs';

import { expect, test } from '../fixtures/base';
import type { Page } from '@playwright/test';

const SHOTS = path.join(process.cwd(), 'artifacts/regression/design-drift');
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

/** 与 Next 启动时读的同一份连接串；测试进程不经过 Next 的 dotenv。 */
function databaseUrl(): string {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  const envFile = path.join(process.cwd(), '.env.local');
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
      const match = /^\s*DATABASE_URL\s*=\s*(.+)\s*$/.exec(line);
      if (match?.[1]) return match[1].trim();
    }
  }
  return 'postgres://openmaic:openmaic-dev@127.0.0.1:5432/openmaic';
}

/**
 * 把「这一层是当前设计生成的」补到刚建的行上。
 *
 * AI 落库时写的就是这一列（`design_fingerprint`），这里只是跳过模型的那一步；
 * 之后改设计，这些行就该被标成旧版。
 */
async function stampGeneratedFromDesign(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.get(`/api/curriculum/series/${seriesId}/design`);
  expect(response.status(), await response.text()).toBe(200);
  const fingerprint = ((await response.json()) as { designFingerprint: string }).designFingerprint;
  const client = new Client({ connectionString: databaseUrl() });
  await client.connect();
  try {
    await client.query(
      `UPDATE curriculum_series_outline_node SET design_fingerprint = $1 WHERE series_id = $2`,
      [fingerprint, seriesId],
    );
    await client.query(`UPDATE curriculum_task SET design_fingerprint = $1 WHERE series_id = $2`, [
      fingerprint,
      seriesId,
    ]);
  } finally {
    await client.end();
  }
}

async function createSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', {
    data: { name, description: '设计变更提示 e2e' },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

async function patchDesign(page: Page, seriesId: string, body: unknown): Promise<void> {
  const response = await page.request.patch(`/api/curriculum/series/${seriesId}/design`, {
    data: body,
  });
  expect(response.status(), await response.text()).toBe(200);
}

async function deleteSeries(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.delete(`/api/curriculum/series/${seriesId}`);
  expect([200, 204], await response.text()).toContain(response.status());
}

test.describe('系列设计变了：提示哪里没跟上', () => {
  test.setTimeout(180_000);

  test('设计一改，驾驶舱横幅、看板标记、设计页提示同时出现', async ({ page }) => {
    const seriesId = await createSeries(page, `设计变更 ${crypto.randomUUID().slice(0, 6)}`);
    try {
      // 一版设计 + 一章一节一目；这些行标记为「由当前这版设计生成」。
      await patchDesign(page, seriesId, DESIGN);
      const chapterResponse = await page.request.post(
        `/api/curriculum/series/${seriesId}/outline`,
        {
          data: { nodeType: 'chapter', title: '第一章 Web 安全' },
        },
      );
      const chapterId = ((await chapterResponse.json()) as { node: { id: string } }).node.id;
      const sectionResponse = await page.request.post(
        `/api/curriculum/series/${seriesId}/outline`,
        {
          data: { nodeType: 'section', parentId: chapterId, title: '第一节 信息收集' },
        },
      );
      const sectionId = ((await sectionResponse.json()) as { node: { id: string } }).node.id;
      const taskResponse = await page.request.post('/api/curriculum/design/tasks', {
        data: { seriesId, sectionId, title: '1-1-1 信息收集实操', code: '1-1-1', kind: 'practice' },
      });
      expect(taskResponse.status(), await taskResponse.text()).toBe(201);
      await stampGeneratedFromDesign(page, seriesId);

      // 设计内容还没变：不该有"没跟上"的提示。
      await page.goto(`/curriculum/series/${seriesId}`);
      await expect(page.getByRole('heading', { name: '系列大纲与出片' })).toBeVisible({
        timeout: 60_000,
      });
      await expect(page.getByText('第一章 Web 安全').first()).toBeVisible();
      await expect(page.getByTestId('design-drift-banner')).toHaveCount(0);
      await expect(page.getByTestId('board-stale-badge')).toHaveCount(0);

      // 改一版设计：受众变了，之前生成的那一层就成了旧版。
      await patchDesign(page, seriesId, {
        direction: { ...DESIGN.direction, audience: '改过的授课对象：校队集训' },
      });
      await page.reload();
      const banner = page.getByTestId('design-drift-banner');
      await expect(banner).toBeVisible({ timeout: 60_000 });
      await expect(banner).toContainText('系列设计改过了，这份大纲还没跟上');
      await expect(banner).toContainText('已有 1 章 / 1 节 / 1 目仍按旧版设计生成');
      await expect(page.getByTestId('board-stale-badge')).toHaveCount(3);
      await page.screenshot({
        path: path.join(SHOTS, '01-cockpit-drift-banner.png'),
        fullPage: true,
      });

      // 设计页也要说这件事：保存成功不等于大纲已经跟上。
      await page.goto(`/curriculum/series/${seriesId}/design`);
      const notice = page.getByTestId('design-outline-drift');
      await expect(notice).toBeVisible({ timeout: 60_000 });
      await expect(notice).toContainText('已有 1 章 / 1 节 / 1 目没跟上');
      await page.screenshot({ path: path.join(SHOTS, '02-design-page-drift.png'), fullPage: true });

      // 再存一次同样的内容：指纹不变，提示不该消失、也不该翻倍。
      await patchDesign(page, seriesId, {
        direction: { ...DESIGN.direction, audience: '改过的授课对象：校队集训' },
      });
      await page.reload();
      await expect(page.getByTestId('design-outline-drift')).toContainText(
        '已有 1 章 / 1 节 / 1 目没跟上',
      );

      // 人改过章的交底，那一章就不再算旧版（它已经被改对了）。
      const patchNode = await page.request.patch(
        `/api/curriculum/series/${seriesId}/outline/${chapterId}`,
        { data: { note: '按新设计人工改写的交底：从信息收集到 SQL 注入' } },
      );
      expect(patchNode.status(), await patchNode.text()).toBe(200);
      await page.reload();
      await expect(page.getByTestId('design-outline-drift')).toContainText(
        '已有 0 章 / 1 节 / 1 目没跟上',
      );
    } finally {
      await deleteSeries(page, seriesId);
    }
  });
});
