/**
 * 系列大纲（章 / 节 / 目）的改名与删除。
 *
 * 看板原来只能新建：写错一个字、少建一目、多建一节，用户只能去数据库里改。这条
 * spec 钉的不是"接口存在"——PATCH / DELETE 一直在——而是三件只有浏览器里才看得见
 * 的事：
 *
 * 1. **改完看板自己就换了。** 保存后不刷新页面，那一行的标题必须变成新的；
 *    "存进去了但页面还是旧的"是这一层最容易犯的错，接口测试完全测不到。
 * 2. **删除的牵连面与确认框承诺的一致。** 删章 / 删节不删目（`ON DELETE SET
 *    NULL`，目退回「未归类」），删目才连设计一起删。看完确认框点下去，结果必须
 *    和那句话一样——用户是照着那句话做决定的。
 * 3. **确认框是唯一的门。** 删目用例先点一次「取消」，库里必须什么都没发生；
 *    否则"确认框画了但没接住"会让一次误点直接删掉一目的设计。
 *
 * 全部走真实接口 + 真实数据库播种（与 `curriculum-series-cockpit.spec.ts` 同法）：
 * 刷新时机、`未归类` 的归位、"第 1 步确认被撤回"这些事，任何一环 mock 掉都会把
 * 真正的缺陷漏过去。每个用例自己建系列、结束后删掉，不依赖库里已有数据。
 *
 * 清理是两步：先删本用例建过的目，再删系列。删系列只会把 `curriculum_task.series_id`
 * 置空（`ON DELETE SET NULL`），目本身还留在库里；首页「继续上次」和总览接口会把
 * 这些无主目当成真实作品列出来，于是每跑一次就多五个幽灵目——那是实打实的污染，
 * 不是"测试数据无所谓"。
 *
 * 选择器只用契约里的 `data-testid` 与菜单项 / 按钮文字，不依赖措辞与样式。
 */
import { test, expect } from '../fixtures/base';
import type { Locator, Page } from '@playwright/test';

/** `GET /api/curriculum/series/{id}/outline` 里断言用到的字段。 */
interface OutlineNode {
  id: string;
  nodeType: 'chapter' | 'section' | 'item';
  title: string;
  note: string | null;
}

/** `GET /api/curriculum/design/tasks/{id}` 里断言用到的字段。 */
interface TaskSnapshot {
  task: {
    id: string;
    title: string;
    durationHours: number | null;
    sectionId: string | null;
  };
  confirmations: Array<{ step: string }>;
}

// ── 播种与清理 ──────────────────────────────────────────────────────────────

async function seedSeries(page: Page, name: string): Promise<string> {
  const response = await page.request.post('/api/curriculum/series', { data: { name } });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { series: { id: string } }).series.id;
}

async function createNode(
  page: Page,
  seriesId: string,
  data: { nodeType: 'chapter' | 'section'; parentId?: string; title: string },
): Promise<string> {
  const response = await page.request.post(`/api/curriculum/series/${seriesId}/outline`, {
    data,
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { node: { id: string } }).node.id;
}

async function createItem(
  page: Page,
  seriesId: string,
  sectionId: string,
  title: string,
): Promise<string> {
  const response = await page.request.post('/api/curriculum/design/tasks', {
    data: { seriesId, sectionId, title },
  });
  expect(response.status(), await response.text()).toBe(201);
  return ((await response.json()) as { task: { id: string } }).task.id;
}

async function deleteSeries(page: Page, seriesId: string): Promise<void> {
  const response = await page.request.delete(`/api/curriculum/series/${seriesId}`);
  expect([200, 204], await response.text()).toContain(response.status());
}

/**
 * 删掉本用例自己建过的目，必须在 `deleteSeries` 之前调用。
 *
 * 用例里已经由界面删掉的那条会 404，按"已经没了"处理；除此之外任何非 2xx 都算清理
 * 失败——宁可在 finally 里红，也不要留下无主目污染首页。
 */
async function deleteItems(page: Page, itemIds: string[]): Promise<void> {
  for (const itemId of itemIds) {
    const response = await page.request.delete(`/api/curriculum/design/tasks/${itemId}`);
    expect([200, 204, 404], await response.text()).toContain(response.status());
  }
}

/**
 * 把目的第 1 步（课程方向）确认掉。
 *
 * 编辑目标题 / 学时之后这次确认必须被撤回（确认属于它当时确认的那组值），
 * 所以先真的确认一次，否则"撤回"这件事在数据上根本无从观察。
 */
async function confirmDirection(page: Page, taskId: string): Promise<void> {
  const patched = await page.request.patch(`/api/curriculum/design/tasks/${taskId}`, {
    data: { audience: '安全岗新人', problemStatement: '会打 CTF 入门题', durationHours: 1.5 },
  });
  expect(patched.status(), await patched.text()).toBe(200);
  const confirmed = await page.request.post(`/api/curriculum/design/tasks/${taskId}/direction`, {
    data: { note: 'e2e 播种' },
  });
  expect(confirmed.status(), await confirmed.text()).toBe(200);
}

// ── 读接口（断言数据真的落库，而不是只看页面） ───────────────────────────────

async function readOutline(page: Page, seriesId: string): Promise<OutlineNode[]> {
  const response = await page.request.get(`/api/curriculum/series/${seriesId}/outline`);
  expect(response.status(), await response.text()).toBe(200);
  return ((await response.json()) as { nodes: OutlineNode[] }).nodes;
}

async function readNode(page: Page, seriesId: string, nodeId: string): Promise<OutlineNode | null> {
  const nodes = await readOutline(page, seriesId);
  return nodes.find((node) => node.id === nodeId) ?? null;
}

async function readTask(page: Page, taskId: string): Promise<TaskSnapshot> {
  const response = await page.request.get(`/api/curriculum/design/tasks/${taskId}`);
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()) as TaskSnapshot;
}

/** 保存是异步的（请求 → 刷新），所以断言"落库了"要等，而不是读一次就定论。 */
async function pollNodeTitle(
  page: Page,
  seriesId: string,
  nodeId: string,
  expected: string,
): Promise<void> {
  await expect
    .poll(async () => (await readNode(page, seriesId, nodeId))?.title ?? null, { timeout: 15_000 })
    .toBe(expected);
}

// ── 界面操作 ────────────────────────────────────────────────────────────────

/** 看板本身：`series-board.tsx` 的 `<section aria-label>`。所有看板断言都收在它里面。 */
function boardOf(page: Page): Locator {
  return page.getByLabel('系列大纲与出片');
}

/**
 * 打开驾驶舱并等看板真的渲染出来。
 *
 * 系列设计没定完、也还没有章时，驾驶舱会跳到系列设计页（既有行为）；所以每个
 * 用例都先建好至少一章再进来，这里断言到的才是看板。
 */
async function gotoBoard(page: Page, seriesId: string): Promise<Locator> {
  await page.goto(`/curriculum/series/${seriesId}`);
  const board = boardOf(page);
  await expect(board).toBeVisible({ timeout: 120_000 });
  return board;
}

async function clickMenuTrigger(page: Page, testId: string): Promise<void> {
  const trigger = page.getByTestId(testId);
  await expect(trigger).toBeVisible();
  await trigger.click();
}

async function clickMenuItem(page: Page, name: string): Promise<void> {
  const item = page.getByRole('menuitem', { name, exact: true });
  await expect(item).toBeVisible();
  await item.click();
}

async function expectDialogTitled(page: Page, title: string): Promise<Locator> {
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(title);
  return dialog;
}

/**
 * 删除确认框。返回 `alertdialog` 本身而不是确认按钮：调用方先用它点「取消」或
 * 点确认，两种用法都要保证拿到的是这一次打开的那个。
 */
async function expectDeleteConfirm(page: Page, confirmLabel: string): Promise<Locator> {
  const alert = page.getByRole('alertdialog');
  await expect(alert).toBeVisible();
  await expect(alert.getByTestId('outline-delete-confirm')).toContainText(confirmLabel);
  return alert;
}

test.describe('系列大纲：改名与删除', () => {
  test.setTimeout(180_000);

  test('改章标题：看板直接变成新标题，旧标题消失，接口里的 title 也变了', async ({ page }) => {
    const seriesId = await seedSeries(page, `改章 e2e ${crypto.randomUUID().slice(0, 6)}`);
    const itemIds: string[] = [];
    try {
      const chapterId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第一章 旧章名',
      });
      // 留着第二章：删到零章时驾驶舱会跳转（既有行为），这里只是改名，但多一章能
      // 保证看板的结构断言不被别的规则干扰。
      await createNode(page, seriesId, { nodeType: 'chapter', title: '第二章 留着' });
      const sectionId = await createNode(page, seriesId, {
        nodeType: 'section',
        parentId: chapterId,
        title: '第一节 测试节',
      });
      itemIds.push(await createItem(page, seriesId, sectionId, '测试目'));

      const board = await gotoBoard(page, seriesId);

      await clickMenuTrigger(page, `chapter-actions-${chapterId}`);
      await clickMenuItem(page, '编辑章');
      const dialog = await expectDialogTitled(page, '编辑章');
      await dialog.getByTestId('outline-node-title').fill('第一章 新章名');
      await dialog.getByTestId('outline-node-save').click();
      await expect(dialog).toBeHidden();

      // 数据先落库（别只在页面上看改没改），再要求看板自己换掉旧标题。
      await pollNodeTitle(page, seriesId, chapterId, '第一章 新章名');
      await expect(board.getByText('第一章 新章名', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(board.getByText('第一章 旧章名', { exact: true })).toHaveCount(0);
    } finally {
      // 先删目再删系列：删系列只把 series_id 置空，目会留下来污染首页。
      await deleteItems(page, itemIds);
      await deleteSeries(page, seriesId);
    }
  });

  test('改节标题与交底备注：看板换成新节名，备注也一起更新', async ({ page }) => {
    const seriesId = await seedSeries(page, `改节 e2e ${crypto.randomUUID().slice(0, 6)}`);
    const itemIds: string[] = [];
    try {
      const chapterId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第一章 留着',
      });
      const sectionId = await createNode(page, seriesId, {
        nodeType: 'section',
        parentId: chapterId,
        title: '第一节 旧节名',
      });
      itemIds.push(await createItem(page, seriesId, sectionId, '测试目'));

      const board = await gotoBoard(page, seriesId);

      await clickMenuTrigger(page, `section-actions-${sectionId}`);
      await clickMenuItem(page, '编辑节');
      const dialog = await expectDialogTitled(page, '编辑节');
      await dialog.getByTestId('outline-node-title').fill('第一节 新节名');
      // 备注不是装饰：生成下一层时它原样进入提示词，所以改完必须真的存进去、
      // 并在看板上显示出来（`HandoffNote`）。
      await dialog.getByTestId('outline-node-note').fill('给下一层看的交接说明');
      await dialog.getByTestId('outline-node-save').click();
      await expect(dialog).toBeHidden();

      await pollNodeTitle(page, seriesId, sectionId, '第一节 新节名');
      await expect
        .poll(async () => (await readNode(page, seriesId, sectionId))?.note ?? null, {
          timeout: 15_000,
        })
        .toBe('给下一层看的交接说明');
      await expect(board.getByText('第一节 新节名', { exact: true })).toBeVisible({
        timeout: 15_000,
      });
      await expect(board.getByText('第一节 旧节名', { exact: true })).toHaveCount(0);
      await expect(board.getByText('给下一层看的交接说明', { exact: true })).toBeVisible();
    } finally {
      await deleteItems(page, itemIds);
      await deleteSeries(page, seriesId);
    }
  });

  test('改目标题与学时：方块换成新标题，接口字段已变，第 1 步确认被撤回', async ({ page }) => {
    const seriesId = await seedSeries(page, `改目 e2e ${crypto.randomUUID().slice(0, 6)}`);
    const itemIds: string[] = [];
    try {
      const chapterId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第一章 留着',
      });
      const sectionId = await createNode(page, seriesId, {
        nodeType: 'section',
        parentId: chapterId,
        title: '第一节 测试节',
      });
      const itemId = await createItem(page, seriesId, sectionId, '旧目标题');
      itemIds.push(itemId);
      await confirmDirection(page, itemId);
      const before = await readTask(page, itemId);
      expect(before.confirmations.some((confirmation) => confirmation.step === 'task')).toBe(true);

      const board = await gotoBoard(page, seriesId);

      await clickMenuTrigger(page, `item-actions-${itemId}`);
      await clickMenuItem(page, '编辑目');
      const dialog = await expectDialogTitled(page, '编辑目');
      // 契约里的四个字段必须在：编号与类型也是目的属性（虽然本用例不改它们）。
      await expect(dialog.getByTestId('item-edit-title')).toBeVisible();
      await expect(dialog.getByTestId('item-edit-code')).toBeVisible();
      await expect(dialog.getByTestId('item-edit-kind')).toBeVisible();
      await expect(dialog.getByTestId('item-edit-hours')).toBeVisible();
      await dialog.getByTestId('item-edit-title').fill('改过的目名');
      await dialog.getByTestId('item-edit-hours').fill('3');
      await dialog.getByTestId('item-edit-save').click();
      await expect(dialog).toBeHidden();

      await expect
        .poll(async () => (await readTask(page, itemId)).task.title, { timeout: 15_000 })
        .toBe('改过的目名');
      await expect
        .poll(async () => (await readTask(page, itemId)).task.durationHours, { timeout: 15_000 })
        .toBe(3);
      // 确认属于它确认的那组值：标题和学时都改了，第 1 步的确认必须撤回，
      // 否则门禁会向用户展示一张没人点过头的卡片。
      await expect
        .poll(
          async () =>
            (await readTask(page, itemId)).confirmations.some(
              (confirmation) => confirmation.step === 'task',
            ),
          { timeout: 15_000 },
        )
        .toBe(false);

      await expect(board.getByText('改过的目名', { exact: true })).toBeVisible({ timeout: 15_000 });
      await expect(board.getByText('旧目标题', { exact: true })).toHaveCount(0);
    } finally {
      await deleteItems(page, itemIds);
      await deleteSeries(page, seriesId);
    }
  });

  test('删目：确认框先取消什么都不发生，再确认后方块消失且该目 404', async ({ page }) => {
    const seriesId = await seedSeries(page, `删目 e2e ${crypto.randomUUID().slice(0, 6)}`);
    const itemIds: string[] = [];
    try {
      const chapterId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第一章 留着',
      });
      const sectionId = await createNode(page, seriesId, {
        nodeType: 'section',
        parentId: chapterId,
        title: '第一节 测试节',
      });
      const itemId = await createItem(page, seriesId, sectionId, '要删的目');
      // 这一条目会被界面删掉，清理时按 404 放过。
      itemIds.push(itemId);

      const board = await gotoBoard(page, seriesId);
      const tile = board.getByTestId(`item-actions-${itemId}`);
      await expect(tile).toBeVisible();

      // 第一次：取消。确认框是唯一的门，门关上之后库里必须什么都没变。
      await clickMenuTrigger(page, `item-actions-${itemId}`);
      await clickMenuItem(page, '删除目');
      const cancelled = await expectDeleteConfirm(page, '删除目');
      await cancelled.getByRole('button', { name: '取消' }).click();
      await expect(page.getByRole('alertdialog')).toBeHidden();
      await expect(tile).toBeVisible();
      expect((await readTask(page, itemId)).task.id).toBe(itemId);

      // 第二次：确认。
      await clickMenuTrigger(page, `item-actions-${itemId}`);
      await clickMenuItem(page, '删除目');
      const alert = await expectDeleteConfirm(page, '删除目');
      await alert.getByTestId('outline-delete-confirm').click();
      await expect(page.getByRole('alertdialog')).toBeHidden();

      await expect(tile).toHaveCount(0, { timeout: 15_000 });
      const gone = await page.request.get(`/api/curriculum/design/tasks/${itemId}`);
      expect(gone.status()).toBe(404);
    } finally {
      await deleteItems(page, itemIds);
      await deleteSeries(page, seriesId);
    }
  });

  test('删节：节消失，节下的目退回「未归类」而不是被删掉', async ({ page }) => {
    const seriesId = await seedSeries(page, `删节 e2e ${crypto.randomUUID().slice(0, 6)}`);
    const itemIds: string[] = [];
    try {
      const chapterId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第一章 留着',
      });
      const sectionId = await createNode(page, seriesId, {
        nodeType: 'section',
        parentId: chapterId,
        title: '第一节 要删的节',
      });
      const itemId = await createItem(page, seriesId, sectionId, '节下的目');
      itemIds.push(itemId);

      const board = await gotoBoard(page, seriesId);

      await clickMenuTrigger(page, `section-actions-${sectionId}`);
      await clickMenuItem(page, '删除节');
      const alert = await expectDeleteConfirm(page, '删除节');
      await alert.getByTestId('outline-delete-confirm').click();
      await expect(page.getByRole('alertdialog')).toBeHidden();

      await expect(board.getByText('第一节 要删的节', { exact: true })).toHaveCount(0, {
        timeout: 15_000,
      });
      // 目还在看板上，并且落在「未归类」那一组里——删分类不该删掉教学内容。
      await expect(board.getByTestId(`item-actions-${itemId}`)).toBeVisible();
      await expect(board.getByText('未归类', { exact: true })).toBeVisible();
      await expect
        .poll(async () => (await readTask(page, itemId)).task.sectionId, { timeout: 15_000 })
        .toBeNull();
      const stillThere = await page.request.get(`/api/curriculum/design/tasks/${itemId}`);
      expect(stillThere.status()).toBe(200);
      // 还有一章，驾驶舱不会跳到系列设计页。
      await expect(page).toHaveURL(new RegExp(`/curriculum/series/${seriesId}$`));
    } finally {
      await deleteItems(page, itemIds);
      await deleteSeries(page, seriesId);
    }
  });

  test('删章：章与节一起消失，目回到「未归类」，另一章还在', async ({ page }) => {
    const seriesId = await seedSeries(page, `删章 e2e ${crypto.randomUUID().slice(0, 6)}`);
    const itemIds: string[] = [];
    try {
      const chapterId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第一章 要删的章',
      });
      const sectionId = await createNode(page, seriesId, {
        nodeType: 'section',
        parentId: chapterId,
        title: '第一节 跟着消失',
      });
      const itemId = await createItem(page, seriesId, sectionId, '章下的目');
      itemIds.push(itemId);
      // 留一章：删完最后一章时驾驶舱会跳去系列设计页（既有行为），那样后面的
      // 断言就落在另一个页面上了。
      const keeperId = await createNode(page, seriesId, {
        nodeType: 'chapter',
        title: '第二章 留着',
      });

      const board = await gotoBoard(page, seriesId);

      await clickMenuTrigger(page, `chapter-actions-${chapterId}`);
      await clickMenuItem(page, '删除章');
      const alert = await expectDeleteConfirm(page, '删除章');
      await alert.getByTestId('outline-delete-confirm').click();
      await expect(page.getByRole('alertdialog')).toBeHidden();

      await expect(board.getByText('第一章 要删的章', { exact: true })).toHaveCount(0, {
        timeout: 15_000,
      });
      // 节是章的下级，级联删除；目不级联，退回未归类。
      await expect(board.getByText('第一节 跟着消失', { exact: true })).toHaveCount(0);
      await expect(board.getByText('第二章 留着', { exact: true })).toBeVisible();
      await expect(board.getByTestId(`item-actions-${itemId}`)).toBeVisible();
      await expect(board.getByText('未归类', { exact: true })).toBeVisible();
      await expect
        .poll(async () => (await readTask(page, itemId)).task.sectionId, { timeout: 15_000 })
        .toBeNull();
      const stillThere = await page.request.get(`/api/curriculum/design/tasks/${itemId}`);
      expect(stillThere.status()).toBe(200);
      expect(await readNode(page, seriesId, chapterId)).toBeNull();
      expect(await readNode(page, seriesId, sectionId)).toBeNull();
      expect((await readNode(page, seriesId, keeperId))?.title).toBe('第二章 留着');
      await expect(page).toHaveURL(new RegExp(`/curriculum/series/${seriesId}$`));
    } finally {
      await deleteItems(page, itemIds);
      await deleteSeries(page, seriesId);
    }
  });
});
