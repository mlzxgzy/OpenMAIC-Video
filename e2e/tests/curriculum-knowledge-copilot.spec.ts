/**
 * 第三步「知识技能图」的右栏 AI 副驾。
 *
 * 这条 spec 盯的是三件界面层的事，每一件都对应一个会静默出错的写操作：
 *
 * 1. **草稿不写库。** 起草之后库里一个节点都没有——这条如果只在单元测试里验证，前端
 *    多发一个 POST 就绕过去了。真实接口 + 真实数据库，断言的是**存储**。
 * 2. **采纳才写，而且只写你按的那一行。** 两个知识点的草稿，作者只按一个，库里就只
 *    多一个。整段一起接受的那个按钮已经取消了，没有别的东西会顺手全写。
 * 3. **每个按不了的行都说得出为什么。** 指向草稿节点的先后关系在被依赖的节点落地前
 *    不可按，理由必须点名那个节点——"按钮是灰的"不构成解释。
 *
 * 模型调用被 mock 成固定答案：这页要验证的是"界面怎么对待草稿"，不是"模型会说什么"。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';

interface DraftNode {
  name: string;
  objectiveId: string;
}

/** 建一个已经走到 `graph` 阶段的目，并确认了一个可观察的目标。 */
async function seedTaskAtGraph(page: Page, title: string) {
  const series = await page.request.post('/api/curriculum/series', {
    data: { name: `副驾 ${title}` },
  });
  const seriesId = ((await series.json()) as { series: { id: string } }).series.id;

  const task = await page.request.post('/api/curriculum/design/tasks', {
    data: { seriesId, title },
  });
  expect(task.status(), await task.text()).toBe(201);
  const taskId = ((await task.json()) as { task: { id: string } }).task.id;

  const brief = await page.request.patch(`/api/curriculum/design/tasks/${taskId}`, {
    data: { audience: '安全岗新人', problemStatement: '会打 CTF 入门题', durationHours: 1.5 },
  });
  expect(brief.status()).toBe(200);
  expect(
    (
      await page.request.post(`/api/curriculum/design/tasks/${taskId}/direction`, { data: {} })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(`/api/curriculum/design/tasks/${taskId}/phase`)).status()).toBe(
    200,
  );

  const objective = await page.request.post(`/api/curriculum/design/tasks/${taskId}/objectives`, {
    data: {
      title: '独立完成目录扫描并读出 flag',
      objectiveType: 'skill',
      expectedBehavior: '在靶场里扫出目录并读出 flag',
      minCriteria: ['读出 flag'],
    },
  });
  expect(objective.status(), await objective.text()).toBe(201);
  const objectiveId = ((await objective.json()) as { objective: { id: string } }).objective.id;
  const evidence = await page.request.post(`/api/curriculum/design/tasks/${taskId}/evidence`, {
    data: {
      objectiveId,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '读出 flag',
    },
  });
  expect(evidence.status()).toBe(201);

  expect(
    (
      await page.request.post(`/api/curriculum/design/tasks/${taskId}/outcomes`, { data: {} })
    ).status(),
  ).toBe(200);
  expect((await page.request.post(`/api/curriculum/design/tasks/${taskId}/phase`)).status()).toBe(
    200,
  );
  return { seriesId, taskId, objectiveId };
}

/**
 * 打开设计编辑器那一半页。
 *
 * 两个 Tab 的内容 DOM 全都渲染，切换只是加/去 `hidden` class——所以"元素存在"不等于
 * "看得到"。这条辅助函数让每个用例不必各自记得点一下，也顺便把"右栏在编辑器这一半"
 * 这件事写成一条事实。
 */
async function openWorkbench(page: Page) {
  await page.getByRole('tab', { name: '设计编辑器' }).click();
  await expect(page.getByLabel('AI 草稿')).toBeVisible();
}

const nodesOf = async (page: Page, taskId: string): Promise<{ name: string }[]> => {
  const snapshot = await (await page.request.get(`/api/curriculum/design/tasks/${taskId}`)).json();
  return (snapshot as { nodes: { name: string }[] }).nodes;
};

/**
 * 采纳之后读库，**轮询到期望结果**。
 *
 * 采纳是一条 POST 再一次刷新，`expect(...).toHaveLength` 立刻读会读在写入之前——而且
 * 那种失败长得像"采纳根本没生效"，会让人去改产品而不是改测试。这里把"等到写完"写成
 * 显式的等待，顺带让失败时的症状（等不到）不再和"写失败"混为一谈。
 */
async function expectStored(
  page: Page,
  taskId: string,
  count: number,
  name?: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const stored = await nodesOf(page, taskId);
        if (stored.length !== count) return `有 ${stored.length} 个`;
        return name === undefined ? stored.length : stored[0]?.name;
      },
      { timeout: 10_000 },
    )
    .toBe(name === undefined ? count : name);
}

/** 让起草接口返回固定答案，不碰真实模型。 */
async function mockDraft(page: Page, nodes: readonly DraftNode[]) {
  await page.route('**/api/curriculum/design/tasks/*/knowledge/draft', async (route) => {
    const before = await (
      await page.request.get(
        route
          .request()
          .url()
          .replace(/\/draft$/, ''),
      )
    ).json();
    const objectiveTitleById = Object.fromEntries(
      (before as { objectives: { id: string; title: string }[] }).objectives.map((row) => [
        row.id,
        row.title,
      ]),
    );
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: '拆了下面这些知识点。',
        warnings: [],
        instruction: '补齐知识点',
        added: nodes.map((node) => ({
          name: node.name,
          nodeType: 'skill',
          summary: null,
          difficulty: null,
          objectiveRefs: [{ objectiveRef: node.objectiveId, supportLevel: 'primary' }],
        })),
        patches: [],
        removed: [],
        // `links` 是"这一轮之后的整份连线集合"，但**只含已有节点的连线**——新节点的
        // 连线跟着节点走（路由里是 `draftLinksOf` 单独拼的），所以这里必须是空的。
        // 填了就会凭空多出一批指向不存在节点的"建议连线"。
        links: [],
        dependencies: [],
        removedDependencies: [],
        unmatchedRefs: [],
        rejectedRefs: [],
        currentLinks: (before as { nodeObjectives: unknown[] }).nodeObjectives,
        nodeNameById: Object.fromEntries(
          (before as { nodes: { id: string; name: string }[] }).nodes.map((row) => [
            row.id,
            row.name,
          ]),
        ),
        objectiveTitleById,
      }),
    });
  });
}

test.describe('知识技能图的 AI 副驾', () => {
  test('起草之后库里一个节点都没多——草稿不写库', async ({ page }) => {
    const { seriesId, taskId, objectiveId } = await seedTaskAtGraph(
      page,
      `起草 ${crypto.randomUUID().slice(0, 6)}`,
    );
    await mockDraft(page, [
      { name: '目录枚举', objectiveId },
      { name: '指纹识别', objectiveId },
    ]);

    await page.goto(`/curriculum/design/${taskId}`);
    await openWorkbench(page);
    const copilot = page.getByLabel('AI 草稿');
    await copilot.getByLabel('给 AI 的起草指令').fill('补齐知识点');
    await copilot.getByRole('button', { name: /让 AI 起草/ }).click();

    await expect(copilot.getByText('拆了下面这些知识点。')).toBeVisible();
    await expect(copilot.getByRole('button', { name: '采纳' })).toHaveCount(2);

    // 关键断言：草稿画出来了，存储没动。
    expect(await nodesOf(page, taskId)).toHaveLength(0);
    await expect(copilot).toContainText('一行都不写进库');
    expect(seriesId).toBeTruthy();
  });

  test('只采纳一行，就只写进那一个知识点', async ({ page }) => {
    const { taskId, objectiveId } = await seedTaskAtGraph(
      page,
      `采纳 ${crypto.randomUUID().slice(0, 6)}`,
    );
    await mockDraft(page, [
      { name: '目录枚举', objectiveId },
      { name: '指纹识别', objectiveId },
    ]);

    await page.goto(`/curriculum/design/${taskId}`);
    await openWorkbench(page);
    const copilot = page.getByLabel('AI 草稿');
    await copilot.getByLabel('给 AI 的起草指令').fill('补齐知识点');
    await copilot.getByRole('button', { name: /让 AI 起草/ }).click();
    await expect(copilot.getByRole('button', { name: '采纳' })).toHaveCount(2);

    await copilot.getByRole('button', { name: '采纳' }).first().click();
    await expect(copilot.getByText('已采纳', { exact: true })).toBeVisible();

    await expectStored(page, taskId, 1, '目录枚举');
    // 另一个还在待处理，而不是被顺手一起写掉。
    await expect(copilot.getByRole('button', { name: '采纳' })).toHaveCount(1);
  });

  test('"改一改"按的是作者写的名字', async ({ page }) => {
    const { taskId, objectiveId } = await seedTaskAtGraph(
      page,
      `改名 ${crypto.randomUUID().slice(0, 6)}`,
    );
    await mockDraft(page, [{ name: '目录枚举', objectiveId }]);

    await page.goto(`/curriculum/design/${taskId}`);
    await openWorkbench(page);
    const copilot = page.getByLabel('AI 草稿');
    await copilot.getByLabel('给 AI 的起草指令').fill('补齐知识点');
    await copilot.getByRole('button', { name: /让 AI 起草/ }).click();
    await copilot.getByRole('button', { name: '改一改' }).click();
    await copilot.getByLabel('改一改这个知识点的名称').fill('目录枚举与字典爆破');
    await copilot.getByRole('button', { name: '采纳' }).click();

    await expectStored(page, taskId, 1, '目录枚举与字典爆破');
  });

  test('丢弃可以撤销，作者反悔不必重开一份草稿', async ({ page }) => {
    const { taskId, objectiveId } = await seedTaskAtGraph(
      page,
      `反悔 ${crypto.randomUUID().slice(0, 6)}`,
    );
    await mockDraft(page, [{ name: '目录枚举', objectiveId }]);

    await page.goto(`/curriculum/design/${taskId}`);
    await openWorkbench(page);
    const copilot = page.getByLabel('AI 草稿');
    await copilot.getByLabel('给 AI 的起草指令').fill('补齐知识点');
    await copilot.getByRole('button', { name: /让 AI 起草/ }).click();
    await copilot.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(copilot.getByRole('button', { name: '撤销丢弃' })).toBeVisible();
    // 丢弃是纯界面状态：库里必须一个节点都没有，否则"丢弃"其实是个没有的按钮。
    await page.waitForTimeout(300);
    expect(await nodesOf(page, taskId)).toHaveLength(0);

    await copilot.getByRole('button', { name: '撤销丢弃' }).click();
    await copilot.getByRole('button', { name: '采纳' }).click();
    await expectStored(page, taskId, 1);
  });

  test('一个按不了的按钮旁边一定有理由', async ({ page }) => {
    const { taskId, objectiveId } = await seedTaskAtGraph(
      page,
      `理由 ${crypto.randomUUID().slice(0, 6)}`,
    );
    // 边指向一个草稿节点：那个节点没被采纳之前，这条边写不进去。
    await page.route('**/api/curriculum/design/tasks/*/knowledge/draft', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          message: '顺手排了个顺序。',
          warnings: [],
          instruction: '排顺序',
          added: [
            {
              name: '目录枚举',
              nodeType: 'skill',
              summary: null,
              difficulty: null,
              objectiveRefs: [{ objectiveRef: objectiveId, supportLevel: 'primary' }],
            },
            {
              name: '指纹识别',
              nodeType: 'knowledge',
              summary: null,
              difficulty: null,
              objectiveRefs: [{ objectiveRef: objectiveId, supportLevel: 'primary' }],
            },
          ],
          patches: [],
          removed: [],
          links: [],
          dependencies: [
            {
              source: { kind: 'draft', index: 0 },
              target: { kind: 'draft', index: 1 },
              edgeType: 'prerequisite',
              note: null,
            },
          ],
          removedDependencies: [],
          unmatchedRefs: [],
          rejectedRefs: [],
          currentLinks: [],
          nodeNameById: {},
          objectiveTitleById: { [objectiveId]: '独立完成目录扫描并读出 flag' },
        }),
      });
    });

    await page.goto(`/curriculum/design/${taskId}`);
    await openWorkbench(page);
    const copilot = page.getByLabel('AI 草稿');
    await copilot.getByLabel('给 AI 的起草指令').fill('排顺序');
    await copilot.getByRole('button', { name: /让 AI 起草/ }).click();

    const adoptButtons = copilot.getByRole('button', { name: '采纳' });
    await expect(adoptButtons).toHaveCount(3);
    // 三个采纳按钮：两个节点可按，边不可按。
    await expect(adoptButtons.nth(2)).toBeDisabled();
    await expect(adoptButtons.nth(2)).toHaveAttribute('title', /先采纳/);
    // 理由写在行上而不是只写在 title 里，因为 title 要悬停才看得见。
    await expect(copilot).toContainText('先采纳');
  });
});
