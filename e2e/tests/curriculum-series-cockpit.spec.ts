/**
 * 系列驾驶舱的浏览器验证。
 *
 * 这条 spec 存在的原因不是"覆盖率"：驾驶舱是整个课程生产线的**入口**，而它唯一的
 * 职责是"告诉我现在该干哪一件事"。如果推荐错了、理由丢了，或者两处排序打架，
 * 单元测试全绿也救不了——`next-item.test.ts` 只钉住纯函数在给定输入下的输出，
 * 而它钉不住"这个输出真的被渲染成了页面上唯一的主角"。
 *
 * 所以这里全部走**真实接口 + 真实数据库**播种，不用 mock：驾驶舱的两个判断
 * （推荐的目、阻塞数）一个来自 `chooseNextItem`，一个来自派生审核，都必须在
 * 真数据上跑通才有意义。
 *
 * 每个目用独立的系列 id，互不干扰，也不受真实数据影响。
 */
import { test, expect } from '../fixtures/base';
import { SeriesCockpitPage } from '../pages/curriculum-series.page';
import type { Page } from '@playwright/test';

/** 一个目录/目，字段与 `parseTaskInput` 对齐。 */
interface SeedItem {
  title: string;
  /** 填了就等于写全了简介，但**不等于**已确认——确认是另一次 POST。 */
  brief?: boolean;
}

async function seedSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

/**
 * 建若干目，逐个走"建简介 → 确认方向 → 进入学习成果阶段"。
 *
 * 走到 `outcomes` 而不是停在 `task` 是刻意的：`task` 阶段的目是骨架，看板和推荐
 * 都会把它涂成"没开始"，测不出"进行中"那一档。推进阶段要走阶段机自己的门禁
 * （简介三格齐全 + 用户确认），所以这里只用接口拼出**真实用户能到达的状态**，
 * 不去伪造一个数据库里存在但界面上走不到的状态。
 */
/**
 * 建"第一章 → 第一节"，返回节 id。
 *
 * 目必须挂在节下面（先章、再节、最后目）。没有节的系列，驾驶舱主角是
 * "先把大纲搭出来"，而不是"现在做这一目"——所以不先建骨架就直接建目，
 * 驾驶舱根本不会进入这条 spec 要断言的状态。
 */
async function seedSection(page: Page, seriesId: string): Promise<string> {
  const chapter = await page.request.post(`/api/curriculum/series/${seriesId}/outline`, {
    data: { nodeType: 'chapter', title: '第一章 测试章' },
  });
  expect(chapter.status(), await chapter.text()).toBe(201);
  const chapterId = ((await chapter.json()) as { node: { id: string } }).node.id;

  const section = await page.request.post(`/api/curriculum/series/${seriesId}/outline`, {
    data: { nodeType: 'section', parentId: chapterId, title: '第一节 测试节' },
  });
  expect(section.status(), await section.text()).toBe(201);
  return ((await section.json()) as { node: { id: string } }).node.id;
}

async function seedItems(
  page: Page,
  seriesId: string,
  items: readonly SeedItem[],
  sectionId: string,
): Promise<void> {
  for (const item of items) {
    const created = await page.request.post('/api/curriculum/design/tasks', {
      data: { seriesId, sectionId, title: item.title },
    });
    expect(created.status(), await created.text()).toBe(201);
    const taskId = ((await created.json()) as { task: { id: string } }).task.id;

    if (!item.brief) continue;

    const patched = await page.request.patch(`/api/curriculum/design/tasks/${taskId}`, {
      data: { audience: '安全岗新人', problemStatement: '会打 CTF 入门题', durationHours: 1.5 },
    });
    expect(patched.status(), await patched.text()).toBe(200);

    const confirmed = await page.request.post(`/api/curriculum/design/tasks/${taskId}/direction`, {
      data: { note: 'e2e 播种' },
    });
    expect(confirmed.status(), await confirmed.text()).toBe(200);

    const advanced = await page.request.post(`/api/curriculum/design/tasks/${taskId}/phase`);
    expect(advanced.status(), await advanced.text()).toBe(200);
  }
}

test.describe('系列驾驶舱', () => {
  test('空系列先落到系列设计：前三步定完之前不进大纲', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-空 ${crypto.randomUUID().slice(0, 6)}`);
    const cockpit = new SeriesCockpitPage(page);
    await cockpit.page.goto(`/curriculum/series/${seriesId}`);

    // 系列设计是前三步，大纲是推导结果：没有设计、也没有大纲时，驾驶舱不做
    // "空大纲"的落地页，直接把用户送到系列设计。
    await expect(page).toHaveURL(new RegExp(`/curriculum/series/${seriesId}/design$`), {
      timeout: 60_000,
    });
    await expect(page.getByRole('heading', { name: /系列设计 · / })).toBeVisible();
    // 前三步没定完时，第 4 步（大纲）是灰的，理由就在按钮上。
    await expect(page.getByTestId('design-outline-cta')).toBeDisabled();
  });

  test('多目时推荐唯一一个主角，主角与待办第一条是同一目', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-推荐 ${crypto.randomUUID().slice(0, 6)}`);
    const sectionId = await seedSection(page, seriesId);
    await seedItems(
      page,
      seriesId,
      [
        { title: 'CTF 概述与竞赛形式', brief: true },
        { title: '信息收集实操', brief: true },
        { title: '综合复盘' },
      ],
      sectionId,
    );

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.goto(seriesId);

    // 主角唯一：待办与看板都在，但只有一块卡片写着"现在做这一目"。
    await expect(cockpit.decision).toBeVisible();
    await expect(page.getByText('现在做这一目')).toHaveCount(1);

    const recommended = await cockpit.recommended();
    expect(recommended.title).not.toBe('');

    // 理由必须是人话且非空——"没有想法"的直接成因就是这里没有句子。
    await expect(cockpit.reason).not.toBeEmpty();

    // 主行动按钮指向那一目的工作台，点下去就真的到得了。
    await expect(cockpit.primaryAction).toHaveAttribute('href', new RegExp(`/curriculum/design/`));
    await cockpit.primaryAction.click();
    await cockpit.page.waitForURL(/\/curriculum\/design\//);
  });

  test('刚建的目不算"有阻塞"——还没做的事不是缺陷', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-进度 ${crypto.randomUUID().slice(0, 6)}`);
    // 只确认了方向、一步都没走的目。审核对它有 4 条 error 级发现（"还没有条目"
    // "还没有题目"…），但那些属于后面几步。驾驶舱若照数显示，用户每次打开
    // 看到的第一件事都会是"这一目有 4 处问题"，而点进去一处也修不了。
    await seedItems(
      page,
      seriesId,
      [{ title: '刚建的目', brief: true }],
      await seedSection(page, seriesId),
    );

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.goto(seriesId);

    await expect(cockpit.decision).not.toContainText('审核');
    await expect(cockpit.decision).not.toContainText('阻塞');
    // 它仍然是主角，而且理由说的是"接着干"而不是"修东西"。
    expect((await cockpit.recommended()).title).toContain('刚建的目');
  });

  test('真正走到那一步的缺陷才被算成阻塞，并压过没开始的目', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-真阻塞 ${crypto.randomUUID().slice(0, 6)}`);
    const sectionId = await seedSection(page, seriesId);
    await seedItems(page, seriesId, [{ title: '目标没写清', brief: true }], sectionId);

    // 一个不可验证的学习目标：`outcomes_verifiable` 层上的 error，而这一目
    // 已经走到 `outcomes`。这不是"还没做"，是"做了但做错了"。
    const tasks = await page.request.get(
      `/api/curriculum/design/tasks?seriesId=${encodeURIComponent(seriesId)}`,
    );
    const taskId = ((await tasks.json()) as { tasks: Array<{ id: string }> }).tasks[0].id;
    const objective = await page.request.post(`/api/curriculum/design/tasks/${taskId}/objectives`, {
      data: { title: '了解 SQL 注入', objectiveType: 'knowledge' },
    });
    expect(objective.status(), await objective.text()).toBe(201);
    await seedItems(page, seriesId, [{ title: '还没开始的那一目', brief: false }], sectionId);

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.goto(seriesId);

    // 有真阻塞的目压过一切：它出不了片，此刻任何新内容排在它后面都是错的。
    expect((await cockpit.recommended()).title).toContain('目标没写清');
    await expect(cockpit.reason).toContainText('审核');
    // 阻塞要说清楚是哪一处，否则用户到了工作台仍然不知道要修什么。
    await expect(cockpit.decision).toContainText('处审核未处理');
  });

  /**
   * 推荐卡要把"这一目在第几步"标出来，而不是一行 `text-xs` 的小字。
   *
   * 上一版在按钮旁写"这一步是第 ③ 步 · …"，用户看完说"还是不够指引"。这条用例把
   * 新的契约钉住：七格全在、唯一的当前步、而且它就在推荐卡里（不是另开一处）。
   */
  test('推荐卡里七步全在，当前那一步只有一个', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-七步 ${crypto.randomUUID().slice(0, 6)}`);
    // `brief: true` 会把这一目推进到 `outcomes`：第 1 步已签、第 2 步正在进行。
    await seedItems(
      page,
      seriesId,
      [{ title: '正在定目标的一目', brief: true }],
      await seedSection(page, seriesId),
    );

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.goto(seriesId);

    const rail = cockpit.decision.getByTestId('step-rail');
    await expect(rail).toBeVisible();
    await expect(rail.locator('li')).toHaveCount(7);
    await expect(rail.locator('li[data-step-state="done"]')).toHaveCount(1);
    await expect(rail.locator('li[data-step-state="current"]')).toHaveCount(1);
    await expect(rail.locator('li[data-step-state="current"]')).toHaveAttribute(
      'data-step',
      'outcomes',
    );
    await expect(cockpit.decision).toContainText('共 7 步');

    // 待办每一行也要读得出步数——列表里有一半行只有"有阻塞"而读不出进度，是上一版
    // 的另一个洞（两件事互斥地显示同一个位置）。
    await expect(cockpit.todos.getByRole('link').first()).toContainText('第 2 步');
  });

  test('待办第一条与推荐是同一目——两块内容不各说各话', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-一致 ${crypto.randomUUID().slice(0, 6)}`);
    await seedItems(
      page,
      seriesId,
      [
        { title: '甲', brief: true },
        { title: '乙', brief: false },
        { title: '丙', brief: false },
      ],
      await seedSection(page, seriesId),
    );

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.goto(seriesId);

    // 大卡片推甲、待办第一条却是乙，用户无从判断哪个是系统的想法——这正是
    // "看一眼没有想法"的一条来源。两块指向同一个 taskId。
    const todoFirst = cockpit.todos.getByRole('link').first();
    await expect(todoFirst).toBeVisible();
    expect(await todoFirst.getAttribute('href')).toBe(
      await cockpit.primaryAction.getAttribute('href'),
    );
  });

  test('出片看板给出"已出片 N / 共 M 目"，而序列页从不给', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-看板 ${crypto.randomUUID().slice(0, 6)}`);
    await seedItems(
      page,
      seriesId,
      [
        { title: '甲', brief: true },
        { title: '乙', brief: true },
      ],
      await seedSection(page, seriesId),
    );

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.goto(seriesId);

    // 这一条回答的是"我一共要干多少活、干完了多少"——整个系统里只有这里给出。
    // 序列页给的是 completedSteps/4，对"3 目做完 2 目"完全不敏感。
    await expect(cockpit.matrix).toContainText('2 目');
    await expect(cockpit.matrix).toContainText('已出片 0');
    await expect(cockpit.tile).toHaveCount(2);
  });

  test('接口失败时页面仍可用：推荐之外的其余部分照常渲染', async ({ page }) => {
    const seriesId = await seedSeries(page, `驾驶舱-降级 ${crypto.randomUUID().slice(0, 6)}`);
    await seedItems(
      page,
      seriesId,
      [{ title: '甲', brief: true }],
      await seedSection(page, seriesId),
    );

    // 只打掉聚合接口，系列名照常读得到。名字失败与数据失败都要能被看见，
    // 但不能把整页变成死路——那会把一个取名失败变成"系统坏了"。
    await page.route('**/api/curriculum/design/overview**', (route) =>
      route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: { message: '聚合接口挂了' } }),
      }),
    );

    const cockpit = new SeriesCockpitPage(page);
    await cockpit.page.goto(`/curriculum/series/${seriesId}`);

    await expect(page.getByText('聚合接口挂了')).toBeVisible();
    await expect(cockpit.matrix).toBeVisible();
  });
});
