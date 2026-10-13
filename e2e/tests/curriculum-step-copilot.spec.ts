/**
 * 通用草稿副驾的**跨层**验收：草稿从浏览器发出、逐行采纳、真的落进库。
 *
 * 这一层要验的东西只有跨层才看得见，纯函数测试一条都验不到：
 *
 * 1. **整表替换那一跳真的活着。** 它曾经写成一个 `replaceFromLive(live)` 回调——在服务端的
 *    每一个单元测试里都成立（所以全绿），而 `JSON.stringify` 把函数变成 `undefined`，于是
 *    浏览器里那一行退化成"没有后续跳"：点采纳会建出一个知识点，而它的支撑关系一条都没写。
 *    所以每条用例断言的都是**数据库**，不是 DOM——DOM 只能证明按钮亮了，证明不了库变了。
 * 2. **多跳要么都成、要么说出是哪一跳。** 采纳不经过工作台的 `run()`（它把失败吞进页面的
 *    错误条然后正常返回，于是右栏一边显示"已采纳、左栏已经改好"、一边库里是空的）。失败必须
 *    抛回右栏，而且要说清是第几跳——作者据此知道目标建出来了、证据没建成，可以单独补。
 * 3. **冲突必须由服务端算出的那份草稿现算。** 一轮里"删掉这个目标"和"改写这个目标"同时在，
 *    改写那一行不可按，理由写在行上。只靠行序是不行的：每一行是作者**单独**按的。
 * 4. **五个步骤各有各的起草路径。** 面板是同一个组件，配置在四处各写一遍；写错一处
 *    （比如考核那一步指向了 `teaching/draft`）在界面上没有任何痕迹，只会在采纳时把一条
 *    建议写进错的地方。所以这里让五个面板各发一次请求，断言**请求打到了哪条路径**。
 *
 * 起草路由本身被 mock 成固定答复：这一页验证的是"面板怎么对待草稿"，不是"模型会说什么"。
 * 模型那一侧的规则由 `tests/curriculum/*-step.test.ts` 覆盖。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';

type SeedPhase = 'outcomes' | 'graph' | 'outline' | 'teaching' | 'assessment';

/**
 * 建一个已经走到指定阶段的目。
 *
 * 每一步都断言状态码并把响应体带进失败信息：种子数据没种上时，症状本来会表现为"面板看不见"
 * 或"按钮点不动"，而那会把人引到界面上去查——实际问题在这一行。
 */
async function seedAtPhase(page: Page, title: string, phase: SeedPhase) {
  const series = await page.request.post('/api/curriculum/series', {
    data: { name: `副驾 ${title}` },
  });
  expect(series.status(), await series.text()).toBe(201);
  const seriesId = ((await series.json()) as { series: { id: string } }).series.id;

  const task = await page.request.post('/api/curriculum/design/tasks', {
    data: { seriesId, title },
  });
  expect(task.status(), await task.text()).toBe(201);
  const taskId = ((await task.json()) as { task: { id: string } }).task.id;

  const post = async (path: string, data: unknown = {}) => {
    const response = await page.request.post(`/api/curriculum/design/tasks/${taskId}/${path}`, {
      data,
    });
    expect(response.status(), `${path}: ${await response.text()}`).toBeLessThan(300);
    return response;
  };
  const snapshot = async () => {
    const response = await page.request.get(`/api/curriculum/design/tasks/${taskId}`);
    return (await response.json()) as {
      objectives: { id: string }[];
      nodes: { id: string; name: string }[];
      units: { id: string; unitType: string }[];
      nodes: { id: string; name: string }[];
    };
  };

  await page.request.patch(`/api/curriculum/design/tasks/${taskId}`, {
    data: { audience: '安全岗新人', problemStatement: '会打 CTF 入门题', durationHours: 1.5 },
  });
  await post('direction');
  await post('phase');
  if (phase === 'outcomes') return { taskId, seriesId, objectiveId: '' };

  const objective = await post('objectives', {
    title: '独立完成目录扫描并读出 flag',
    objectiveType: 'skill',
    expectedBehavior: '在靶场里扫出目录并读出 flag',
    minCriteria: ['读出 flag'],
  });
  const objectiveId = ((await objective.json()) as { objective: { id: string } }).objective.id;
  await post('evidence', {
    objectiveId,
    evidenceType: 'lab',
    verificationMethod: '实操验证',
    successCondition: '读出 flag',
  });
  await post('outcomes');
  await post('phase');
  if (phase === 'graph') return { taskId, seriesId, objectiveId };

  for (const name of ['HTTP 基础', '目录扫描', '指纹识别']) {
    await post('nodes', { name, nodeType: 'knowledge' });
  }
  const graph = await snapshot();
  await page.request.put(`/api/curriculum/design/tasks/${taskId}/node-objectives`, {
    data: {
      links: graph.nodes.map((node) => ({
        nodeId: node.id,
        objectiveId,
        supportLevel: 'primary',
      })),
    },
  });
  await post('knowledge');
  await post('phase');
  if (phase === 'outline') return { taskId, seriesId, objectiveId };

  const unit = await post('units', {
    title: '1.1 目录扫描',
    unitType: 'item',
    unitRole: 'lecture',
    hours: 1,
  });
  const unitId = ((await unit.json()) as { unit: { id: string } }).unit.id;
  // `POST /unit-coverage` 收的是**一行**（`parseUnitCoverageInput`）；`{ rows: [...] }` 是
  // `PUT` 那个整表替换的形状。写错的表现是 400 说三个字段都必填，与"少写了一层"无关。
  await post('unit-coverage', { unitId, objectiveId, coverageKind: 'teach', depth: 'standard' });
  await post('outline');
  await post('phase');
  if (phase === 'teaching') return { taskId, seriesId, objectiveId };

  // 分镜那一页的 `coreInfo` 与 `mode` 是必填的：少一个这里就会 400，而症状会表现为
  // "考核面板点不动"。用真实形状，不用一个看起来差不多但过不了校验的。
  // 脚本说"讲透"的知识点，必须有一页担着它——门禁就是这么查的，所以两者用同一个知识点。
  const taught = (await snapshot()).nodes[0]!;
  const designed = await page.request.patch(
    `/api/curriculum/design/tasks/${taskId}/units/${unitId}`,
    {
      data: {
        teachingDesign: { core: [taught.id] },
        deckDesign: {
          estPages: 1,
          pages: [
            {
              order: 1,
              title: '什么是目录扫描',
              goal: '说清它做什么',
              coreInfo: '目录扫描是枚举服务器上存在的路径',
              mode: 'explain',
              teaches: [taught.name],
            },
          ],
        },
      },
    },
  );
  expect(designed.status(), await designed.text()).toBeLessThan(300);
  await post('teaching');
  await post('phase');
  return { taskId, seriesId, objectiveId };
}

/** 库里现在有什么。断言读的是它，不是 DOM。 */
async function snapshotOf(page: Page, taskId: string) {
  const response = await page.request.get(`/api/curriculum/design/tasks/${taskId}`);
  return (await response.json()) as {
    objectives: { id: string; title: string }[];
    nodes: { name: string }[];
    nodeObjectives: unknown[];
  };
}

/** 让起草接口返回固定答复，不碰真实模型。 */
async function mockDraft(page: Page, step: string, draft: unknown) {
  await page.route(`**/api/curriculum/design/tasks/*/${step}/draft`, async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ draft }),
    });
  });
}

const draftOf = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
  lines,
  message: '这是模型这一轮说的话。',
  warnings: [],
  instruction: '补齐',
  ...extra,
});

/** 打开设计编辑器那一半页，并拿到指定那一步的右栏。 */
async function openCopilot(page: Page, taskId: string, heading: string) {
  await page.goto(`/curriculum/design/${taskId}`);
  await page.getByRole('tab', { name: '设计编辑器' }).click();
  const copilot = page.getByLabel(`${heading}（AI 草稿）`);
  await expect(copilot).toBeVisible();
  return copilot;
}

/** 让右栏出一份草稿。 */
async function askForDraft(copilot: ReturnType<Page['getByLabel']>) {
  await copilot.getByLabel('给 AI 的起草指令').fill('补齐');
  await copilot.getByRole('button', { name: /让 AI 起草/ }).click();
}

/** 一份"新建知识点并挂上目标"的草稿，用作后面几条用例的输入。 */
function knowledgeLines(input: {
  taskId: string;
  objectiveId: string;
  objectiveTitle: string;
  names: readonly string[];
}) {
  return input.names.map((name, index) => ({
    id: `knowledge:node-${index}`,
    text: `新建知识点「${name}」，支撑 ${input.objectiveTitle}`,
    name,
    nameKey: 'name',
    create: {
      route: `/api/curriculum/design/tasks/${input.taskId}/nodes`,
      body: { name, nodeType: 'knowledge' },
      idKey: 'node',
      // 新知识点的支撑关系跟着这一行走，而且是**整表替换**：body 在采纳那一刻按当前库算。
      mergeInto: {
        method: 'PUT',
        route: `/api/curriculum/design/tasks/${input.taskId}/node-objectives`,
        rows: [{ nodeId: '#id', objectiveId: input.objectiveId, supportLevel: 'primary' }],
        source: 'nodeObjectives',
        key: ['nodeId', 'objectiveId'],
        bodyKey: 'links',
      },
    },
  }));
}

test.describe('通用草稿副驾穿过网络之后仍然成立', () => {
  test('草稿一行都不写库；按一行就只写那一行，而且整表替换那一跳真的活着', async ({ page }) => {
    const { taskId, objectiveId } = await seedAtPhase(
      page,
      `连线 ${crypto.randomUUID().slice(0, 6)}`,
      'graph',
    );
    await mockDraft(
      page,
      'knowledge',
      draftOf(
        knowledgeLines({
          taskId,
          objectiveId,
          objectiveTitle: '独立完成目录扫描并读出 flag',
          names: ['目录枚举', '指纹识别'],
        }).concat([
          {
            id: 'knowledge:note-9',
            text: '没找到「WAF 绕过」，这一条没写进去',
            note: '没找到「WAF 绕过」，这一条没写进去',
          },
        ]),
        { message: '拆了下面这些知识点。' },
      ),
    );

    const copilot = await openCopilot(page, taskId, '让 AI 帮你起草知识点');
    await askForDraft(copilot);
    await expect(copilot.getByText('拆了下面这些知识点。')).toBeVisible();
    await expect(copilot.getByRole('button', { name: '采纳' })).toHaveCount(2);
    // 说明行没有按钮，也**不算**"等你决定"：算进去的话这句计数永远到不了零。
    await expect(copilot).toContainText('还有 2 行等你决定');

    // 草稿画出来了，存储没动。这条如果只在单元测试里验，前端多发一个 POST 就绕过去了。
    expect((await snapshotOf(page, taskId)).nodes).toHaveLength(0);
    await expect(copilot).toContainText('一行都不写进库');

    await copilot.getByRole('button', { name: '采纳' }).first().click();

    // 断言的**是存储**：整表替换那一跳没发出去的话，这里会是 1 个节点、0 条连线，而界面上
    // 仍然显示"已采纳"——B2 试点坏掉的时候就是这个样子。
    await expect
      .poll(
        async () => {
          const stored = await snapshotOf(page, taskId);
          return `${stored.nodes.length}/${stored.nodeObjectives.length}`;
        },
        { timeout: 15_000 },
      )
      .toBe('1/1');
    // 另一行还在等作者决定，而不是被顺手一起写掉。
    await expect(copilot.getByRole('button', { name: '采纳' })).toHaveCount(1);
    await expect(copilot).toContainText('还有 1 行等你决定');
  });

  test('"改一改"改的是作者写的名字，采纳之后库里就是那个名字', async ({ page }) => {
    const { taskId, objectiveId } = await seedAtPhase(
      page,
      `改名 ${crypto.randomUUID().slice(0, 6)}`,
      'graph',
    );
    await mockDraft(
      page,
      'knowledge',
      draftOf(
        knowledgeLines({
          taskId,
          objectiveId,
          objectiveTitle: '独立完成目录扫描并读出 flag',
          names: ['目录枚举'],
        }),
      ),
    );

    const copilot = await openCopilot(page, taskId, '让 AI 帮你起草知识点');
    await askForDraft(copilot);
    await copilot.getByRole('button', { name: '改一改' }).click();
    await copilot.getByLabel('改一改这一行的名称').fill('目录枚举与字典爆破');
    await copilot.getByRole('button', { name: '采纳' }).click();

    // 名字是唯一必须由人拍板的东西——后面每一步都靠它寻址这一行。
    // 超时给足：采纳是一条 POST **再加两次刷新**（`load()` 与 `onChanged()`），而整套
    // e2e 并发跑时 dev server 的响应会明显变慢。默认 5 秒不够，失败会长得像"改名没生效"。
    await expect
      .poll(
        async () => {
          const body = (await (
            await page.request.get(`/api/curriculum/design/tasks/${taskId}`)
          ).json()) as { nodes: { name: string }[] };
          return body.nodes[0]?.name;
        },
        { timeout: 15_000 },
      )
      .toBe('目录枚举与字典爆破');
  });

  test('丢弃是纯界面状态，撤销之后还能按', async ({ page }) => {
    const { taskId, objectiveId } = await seedAtPhase(
      page,
      `反悔 ${crypto.randomUUID().slice(0, 6)}`,
      'graph',
    );
    await mockDraft(
      page,
      'knowledge',
      draftOf(
        knowledgeLines({
          taskId,
          objectiveId,
          objectiveTitle: '独立完成目录扫描并读出 flag',
          names: ['目录枚举'],
        }),
      ),
    );

    const copilot = await openCopilot(page, taskId, '让 AI 帮你起草知识点');
    await askForDraft(copilot);
    await copilot.getByRole('button', { name: '丢弃', exact: true }).click();
    await expect(copilot.getByRole('button', { name: '撤销丢弃' })).toBeVisible();
    // 丢弃如果顺手写了一次库，那它就不是"丢弃"——而作者要到很后面才会发现。
    expect((await snapshotOf(page, taskId)).nodes).toHaveLength(0);

    await copilot.getByRole('button', { name: '撤销丢弃' }).click();
    await copilot.getByRole('button', { name: '采纳' }).click();
    await expect
      .poll(async () => (await snapshotOf(page, taskId)).nodes.length, { timeout: 15_000 })
      .toBe(1);
  });

  test('第二跳失败要说得出是哪一跳——目标建出来了，证据没建成', async ({ page }) => {
    const { taskId } = await seedAtPhase(
      page,
      `多跳 ${crypto.randomUUID().slice(0, 6)}`,
      'outcomes',
    );
    // 第二跳单独打一个 500：草稿的两跳是同一行的两跳，而报告必须指出是哪一跳。
    await page.route('**/api/curriculum/design/tasks/*/evidence', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '证据表写不进去' } }),
      });
    });
    await mockDraft(
      page,
      'outcomes',
      draftOf([
        {
          id: 'outcome:added-0',
          text: '新建目标「能读懂 HTTP 响应」，并带上 1 条考核证据',
          name: '能读懂 HTTP 响应',
          nameKey: 'title',
          create: {
            route: `/api/curriculum/design/tasks/${taskId}/objectives`,
            body: {
              title: '能读懂 HTTP 响应',
              objectiveType: 'skill',
              expectedBehavior: '指出响应头里各字段的作用',
              minCriteria: [],
            },
            idKey: 'objective',
            then: [
              {
                method: 'POST',
                route: `/api/curriculum/design/tasks/${taskId}/evidence`,
                body: {
                  objectiveId: '#id',
                  evidenceType: 'quiz',
                  verificationMethod: '提交答案自动比对',
                  successCondition: '8 题对 6 题',
                },
              },
            ],
          },
        },
      ]),
    );

    const copilot = await openCopilot(page, taskId, '让 AI 帮你起草学习目标');
    await askForDraft(copilot);
    await copilot.getByRole('button', { name: '采纳' }).first().click();

    // 失败必须抛回右栏，而且说清是第 2 跳。
    await expect(copilot.getByRole('alert')).toContainText('第 2 跳失败');
    await expect(copilot.getByRole('alert')).toContainText('证据表写不进去');
    // 而这一行**不能**被记成"已采纳"：采纳记录与存储必须由同一次结果决定。
    await expect(copilot.getByText('已采纳', { exact: true })).toHaveCount(0);
    // 第一跳是真的写进去了——这里做的是说实话，不是回滚。
    await expect
      .poll(async () => (await snapshotOf(page, taskId)).objectives.length, { timeout: 15_000 })
      .toBe(1);
  });

  test('按不了的行必须点名要等哪一行', async ({ page }) => {
    const { taskId } = await seedAtPhase(page, `依赖 ${crypto.randomUUID().slice(0, 6)}`, 'graph');
    await mockDraft(
      page,
      'knowledge',
      draftOf([
        {
          id: 'knowledge:node-0',
          text: '新建知识点「目录枚举」',
          create: {
            route: `/api/curriculum/design/tasks/${taskId}/nodes`,
            body: { name: '目录枚举', nodeType: 'knowledge' },
            idKey: 'node',
          },
        },
        {
          id: 'knowledge:edge-draft:0->node:abc',
          text: '先后关系：目录枚举 → 别的',
          needs: [{ lineId: 'knowledge:node-0', key: 'sourceId', label: '新知识点「目录枚举」' }],
          write: {
            method: 'POST',
            route: `/api/curriculum/design/tasks/${taskId}/dependencies`,
            body: { sourceId: '#id', targetId: 'abc', sourceKind: 'node', targetKind: 'node' },
          },
        },
      ]),
    );

    const copilot = await openCopilot(page, taskId, '让 AI 帮你起草知识点');
    await askForDraft(copilot);

    const edge = copilot.locator('[data-line-id="knowledge:edge-draft:0->node:abc"]');
    await expect(edge.getByRole('button', { name: '采纳' })).toBeDisabled();
    // 理由要写在行上，而不是只在 `title` 里——`title` 要悬停才看得见。
    await expect(edge).toContainText('新知识点「目录枚举」');
  });

  test('一轮里"删掉它"和"改写它"同时出现时，改写那一行不可按', async ({ page }) => {
    const seeded = await seedAtPhase(page, `冲突 ${crypto.randomUUID().slice(0, 6)}`, 'graph');
    const objectiveId = seeded.objectiveId;
    await mockDraft(
      page,
      'outcomes',
      draftOf([
        {
          id: `outcome:removed-${objectiveId}`,
          text: '删除目标「独立完成目录扫描并读出 flag」',
          write: {
            method: 'DELETE',
            route: `/api/curriculum/design/tasks/${seeded.taskId}/objectives/${objectiveId}`,
          },
        },
        {
          id: `outcome:patch-${objectiveId}`,
          text: '改写目标「独立完成目录扫描并读出 flag」的标题',
          name: '独立完成目录扫描并读出 flag',
          nameKey: 'title',
          write: {
            method: 'PATCH',
            route: `/api/curriculum/design/tasks/${seeded.taskId}/objectives/${objectiveId}`,
            body: { title: '独立完成目录扫描并读出 flag' },
          },
        },
      ]),
    );

    const copilot = await openCopilot(page, seeded.taskId, '让 AI 帮你起草学习目标');
    await askForDraft(copilot);

    const patchLine = copilot.locator(`[data-line-id="outcome:patch-${objectiveId}"]`);
    await expect(patchLine.getByRole('button', { name: '采纳' })).toBeDisabled();
    await expect(patchLine).toContainText('已经被这一轮删掉');
    // 删除那一行本身照常可按——挡的是"先删后改"里那个改，不是删。
    const removeLine = copilot.locator(`[data-line-id="outcome:removed-${objectiveId}"]`);
    await expect(removeLine.getByRole('button', { name: '采纳' })).toBeEnabled();
  });

  test('五个步骤各发各的起草路径——面板是同一个，配置是五份', async ({ page }) => {
    const { taskId } = await seedAtPhase(
      page,
      `五步 ${crypto.randomUUID().slice(0, 6)}`,
      'assessment',
    );
    const asked: string[] = [];
    await page.route('**/api/curriculum/design/tasks/*/*/draft', async (route) => {
      asked.push(new URL(route.request().url()).pathname);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ draft: draftOf([]) }),
      });
    });

    await page.goto(`/curriculum/design/${taskId}`);
    await page.getByRole('tab', { name: '设计编辑器' }).click();
    for (const heading of [
      '让 AI 帮你起草学习目标',
      '让 AI 帮你起草知识点',
      '让 AI 帮你起草大纲',
      '让 AI 帮你写授课脚本',
      '让 AI 帮你出题与实操',
    ]) {
      const panel = page.getByLabel(`${heading}（AI 草稿）`);
      await expect(panel).toBeVisible();
      await askForDraft(panel);
      await expect(panel.getByText('这是模型这一轮说的话。')).toBeVisible();
    }

    expect(asked.sort()).toEqual([
      `/api/curriculum/design/tasks/${taskId}/assessment/draft`,
      `/api/curriculum/design/tasks/${taskId}/knowledge/draft`,
      `/api/curriculum/design/tasks/${taskId}/outcomes/draft`,
      `/api/curriculum/design/tasks/${taskId}/outline/draft`,
      `/api/curriculum/design/tasks/${taskId}/teaching/draft`,
    ]);
  });
});
