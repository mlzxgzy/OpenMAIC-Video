/**
 * 出片那一段路的浏览器验收：**归档降级 + 目工作台的生成与导出 + 首页继续上次**。
 *
 * 这三件事有一个共同点：它们的正确性都不在纯函数里，而在"页面真的连到了哪条路"。
 *
 * 1. **`/curriculum` 是一个跳转，不是页面。** 旧台账整体搬到 `/curriculum/legacy`。
 *    这条如果只在代码里改而没验过，症状会是"书签点进去看到一堵墙"——正是这次大修
 *    要消灭的东西，而且它在 `/curriculum` 这个最可能被点开的地址上。
 * 2. **生成按钮真的打到 `units/[unitId]/generate`。** 设计编辑器里做完全部七步之后，
 *    这个页面上以前**没有**任何按钮能拿到视频。这里让生成接口返回一个正在跑的 run，
 *    再让 run 轮询回一个 stage，断言界面上真的出现了「打开课堂」和「导出 MP4」。
 *    生成本身不花模型的钱（接口被替换），因为要验的是面板怎么对待这次生成。
 * 3. **导出按钮真的在队列里建了一条任务。** 断言读的是 `GET /api/curriculum/export-jobs`
 *    的返回，不是 DOM：DOM 只能证明按钮亮了。
 * 4. **首页「继续上次」直达那一目。** 排序复用 `chooseNextItem`，所以这里验的是
 *    "首页那块卡片真的用了同一个排序结果并指向了那一目"，不是排序规则本身
 *    （那是 `next-item.test.ts` 的事）。
 *
 * 门禁被 mock 成"通过"，理由：门禁本身由 `tests/curriculum/design-routes.test.ts` 与
 * `design-review.test.ts` 在真实存储上钉着；这里是面板的接线测试，而**可导出的设计
 * 是真实可达的状态**，不是编出来的。反过来，第 2 条用例专门在**真实门禁**下跑，
 * 断言灰按钮旁边有理由——那才是"禁用必须给理由"这条规则的验收。
 */
import { test, expect } from '../fixtures/base';
import type { Page } from '@playwright/test';

/**
 * 建一个走到 `outline` 结束的目：一个目标、三个知识点、一个讲课条目、一条覆盖。
 *
 * 走到这一步而不是更早，是因为「生成与导出」要的是**条目**（章不承载角色、不能
 * 生成）。每一步都断言状态码并把响应体带进失败信息：种子没种上时，症状会表现为
 * "面板上什么都没有"，那会把人引到界面上去查。
 */
async function seedDesignedTask(page: Page, title: string) {
  const series = await page.request.post('/api/curriculum/series', {
    data: { name: `出片 ${title}` },
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

  await page.request.patch(`/api/curriculum/design/tasks/${taskId}`, {
    data: { audience: '安全岗新人', problemStatement: '会打 CTF 入门题', durationHours: 1.5 },
  });
  await post('direction');
  await post('phase');

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

  for (const name of ['HTTP 基础', '目录扫描', '指纹识别']) {
    await post('nodes', { name, nodeType: 'knowledge' });
  }
  const snapshot = await page.request.get(`/api/curriculum/design/tasks/${taskId}`);
  const nodes = ((await snapshot.json()) as { nodes: { id: string }[] }).nodes;
  await page.request.put(`/api/curriculum/design/tasks/${taskId}/node-objectives`, {
    data: {
      links: nodes.map((node) => ({ nodeId: node.id, objectiveId, supportLevel: 'primary' })),
    },
  });
  await post('knowledge');
  await post('phase');

  const unit = await post('units', {
    title: '1.1 目录扫描',
    unitType: 'item',
    unitRole: 'lecture',
    hours: 1,
  });
  const unitId = ((await unit.json()) as { unit: { id: string } }).unit.id;
  await post('unit-coverage', {
    unitId,
    objectiveId,
    coverageKind: 'teach',
    depth: 'standard',
  });
  await post('outline');
  await post('phase');

  return { taskId, seriesId, unitId };
}

/** 打开某一目的「生成与导出」Tab。 */
async function openProduceTab(page: Page, taskId: string) {
  await page.goto(`/curriculum/design/${taskId}`);
  await page.getByRole('tab', { name: '生成与导出' }).click();
  // 用 testid 而不是 `getByLabel`：Tab 面板的可访问名字也来自那个 Tab（Radix 用
  // `aria-labelledby` 指过去），所以 `getByLabel('生成与导出')` 会同时命中面板和
  // 卡片两层。
  const panel = page.getByTestId('produce-panel');
  await expect(panel).toBeVisible();
  return panel;
}

test.describe('出片那一段路', () => {
  test('旧台账归档到 /legacy，/curriculum 只是一个跳转', async ({ page }) => {
    await page.goto('/curriculum');
    // 重定向之后停留的地址：旧书签与旧链接必须落到新的主路径上。
    await expect(page).toHaveURL(/\/curriculum\/series$/);

    const legacy = await page.goto('/curriculum/legacy');
    expect(legacy?.status()).toBe(200);
    await expect(page.getByLabel('存档说明')).toContainText('这是旧台账的存档页');
    // 六块功能一块都没删——它们是"还没有等价替代"的那些。
    // 用正则而不是全名：`TabsTrigger` 里还挂着这一块的说明文字，它的可访问名字
    // 是"课程台账 先建系列和课程"这种整串，写死全名会在改一次说明文案时变红。
    for (const name of ['课程台账', '知识体系', '培养方案', '课程组装', '批量生成', '视频导出']) {
      await expect(page.getByRole('tab', { name: new RegExp(name) })).toBeVisible();
    }

    // 驾驶舱的页脚指向存档页，而不是主路径。
    const series = await page.request.post('/api/curriculum/series', {
      data: { name: `归档 ${crypto.randomUUID().slice(0, 6)}` },
    });
    const seriesId = ((await series.json()) as { series: { id: string } }).series.id;
    await page.goto(`/curriculum/series/${seriesId}`);
    await expect(page.getByRole('link', { name: '课程台账（存档）' })).toHaveAttribute(
      'href',
      '/curriculum/legacy',
    );
  });

  test('门禁没过时，生成按钮是灰的，而且行内说出了理由', async ({ page }) => {
    const { taskId } = await seedDesignedTask(page, `未完成 ${crypto.randomUUID().slice(0, 6)}`);
    const panel = await openProduceTab(page, taskId);

    // 用真实门禁的答复决定断言：这一步测的是"界面忠实转述了门禁"，不是"门禁一定
    // 拒绝"。把界面的文案写死在这里，就会变成一条钉住当前数据的测试。
    const gate = await page.request.get(`/api/curriculum/design/tasks/${taskId}/export-gate`);
    const { exportable, blockers } = (await gate.json()) as {
      exportable: boolean;
      blockers: string[];
    };
    expect(exportable).toBe(false);

    await expect(panel).toContainText('现在还不能生成');
    await expect(panel).toContainText(blockers[0]!);
    const generate = panel.getByRole('button', { name: '生成' });
    await expect(generate).toBeDisabled();
    // 禁用必须给理由：`title` 上挂着门禁的第一句话。
    await expect(generate).toHaveAttribute('title', blockers[0]!);

    // 还没有 stage：给不出"打开课堂"，也给不出"导出 MP4"。
    await expect(panel.getByRole('link', { name: '打开课堂' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: '导出 MP4' })).toHaveCount(0);
    await expect(panel).toContainText('将生成：幻灯片课程');
  });

  test('生成打通到出片，导出真的在队列里建了一条任务', async ({ page }) => {
    const { taskId, unitId } = await seedDesignedTask(
      page,
      `出片 ${crypto.randomUUID().slice(0, 6)}`,
    );

    // 门禁：这一条用例验的是接线，不是审核；审核在 design-routes 的真实存储上钉着。
    await page.route('**/api/curriculum/design/tasks/*/export-gate', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ exportable: true, blockers: [], accepted: [] }),
      });
    });

    const generateCalls: string[] = [];
    await page.route('**/api/curriculum/design/tasks/*/units/*/generate', async (route) => {
      generateCalls.push(route.request().url());
      await route.fulfill({
        status: 202,
        contentType: 'application/json',
        body: JSON.stringify({
          run: { id: 'run-e2e-produce', state: 'running', step: 'outline', stageId: null },
        }),
      });
    });

    // run 轮询回一个已经出片的 run —— 真实的 stage 只会在生成 hook 提交第一页时
    // 出现，这里用回包模拟那一次提交，不花模型的钱。
    await page.route('**/api/generation-runs/run-e2e-produce', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          run: {
            id: 'run-e2e-produce',
            state: 'completed',
            step: 'done',
            stageId: 'stage-e2e-produce',
          },
        }),
      });
    });

    const panel = await openProduceTab(page, taskId);
    await panel.getByRole('button', { name: '生成' }).click();

    // 请求真的打到了那一步的生成路由，而且带的是这个条目。
    await expect.poll(() => generateCalls.length).toBe(1);
    expect(generateCalls[0]).toContain(`/units/${unitId}/generate`);

    // 跟住 run：出片之后，这一行给得出课堂和导出。
    await expect(panel.getByText('run run-e2e-produce')).toBeVisible();
    const classroom = panel.getByRole('link', { name: '打开课堂' });
    await expect(classroom).toBeVisible({ timeout: 15_000 });
    await expect(classroom).toHaveAttribute('href', '/classroom/stage-e2e-produce');

    const exportButton = panel.getByRole('button', { name: '导出 MP4' });
    await expect(exportButton).toBeEnabled();
    await exportButton.click();

    // 界面这一侧先落地：状态行渲染出来，意味着入队回包和随之而来的重新读取都到了。
    await expect(panel.getByTestId(`export-status-${unitId}`)).toBeVisible();

    // 再断言队列本身，而且**轮询**。`click()` 只等到事件派发为止，组件里的 fetch 还在
    // 飞；直接查一次就会与它赛跑，失败信息变成"队列里没有任务"，而实际只是慢了一拍。
    // 断言读的是队列而不是 DOM：按钮亮着只能证明点了，证明不了库里多了东西。
    await expect
      .poll(
        async () => {
          const response = await page.request.get(
            '/api/curriculum/export-jobs?stageIds=stage-e2e-produce',
          );
          expect(response.status()).toBe(200);
          const body = (await response.json()) as { jobs: unknown[] };
          return body.jobs.length;
        },
        { timeout: 10_000 },
      )
      .toBe(1);

    const queued = await page.request.get('/api/curriculum/export-jobs?stageIds=stage-e2e-produce');
    const { jobs } = (await queued.json()) as {
      jobs: { stageId: string; batchItemId: string | null; title: string }[];
    };
    expect(jobs[0]).toMatchObject({
      stageId: 'stage-e2e-produce',
      // 目工作台这条路没有批量项：写错会让旧台账里凭空多出一条对不上课程的任务。
      batchItemId: null,
      title: '1.1 目录扫描',
    });
  });

  test('首页「继续上次」直达那一目，用的是同一个排序', async ({ page }) => {
    const { taskId } = await seedDesignedTask(page, `继续 ${crypto.randomUUID().slice(0, 6)}`);
    await page.goto('/');

    const card = page.getByTestId('continue-last');
    await expect(card).toBeVisible();
    await expect(card).toContainText('继续上次');
    // 卡片上的理由与大卡片的理由同源：都来自 `chooseNextItem`。这里只钉住"它说了
    // 一句为什么"（非空白），具体措辞由 `next-item.test.ts` 覆盖——把整句写死在这里，
    // 改一次文案就要改两处测试，而且这一条会变成"文案没变"的测试。
    await expect(card.getByTestId('continue-last-reason')).toHaveText(/\S/);
    await card.click();
    await expect(page).toHaveURL(new RegExp(`/curriculum/design/${taskId}$`));
  });
});
