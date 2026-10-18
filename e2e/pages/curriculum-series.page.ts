/**
 * 系列驾驶舱（`/curriculum/series/[id]`）。
 *
 * 这一页的设计目标是"一眼知道现在该干哪一件事"，所以这里只暴露三块东西：
 * 「现在做这一目」的主卡片、待办栏、出片看板。**刻意不给每一行文字写 locator**：
 * 那些字句随时会改措辞，而这一页真正的契约是"推荐的是什么、为什么、下一步点
 * 到哪里"。断言契约而不断言文案，改文案才不会连带改测试。
 *
 * 三块用 `aria-label`（`series-cockpit.tsx`）而不是文案定位，理由相同：身份是
 * 页面结构的事实，措辞不是。
 */
import { expect, type Page, type Locator } from '@playwright/test';

export class SeriesCockpitPage {
  readonly page: Page;

  /** 「现在做这一目」——页面上唯一的主角。 */
  readonly decision: Locator;
  /** 卡片上的主行动按钮，指向具体那一目的工作台。 */
  readonly primaryAction: Locator;
  /** 为什么推荐它：一句用户语言的理由。 */
  readonly reason: Locator;
  /** 待办栏。 */
  readonly todos: Locator;
  /** 出片看板。 */
  readonly matrix: Locator;
  /** 看板上一目的方块。 */
  readonly tile: Locator;

  constructor(page: Page) {
    this.page = page;
    this.decision = page.getByLabel('现在做这一目');
    this.primaryAction = this.decision.getByRole('link').first();
    this.reason = this.decision.getByTestId('decision-reason');
    this.todos = page.getByLabel('待办');
    this.matrix = page.getByLabel('系列大纲与出片');
    this.tile = this.matrix.getByRole('link');
  }

  async goto(seriesId: string) {
    await this.page.goto(`/curriculum/series/${encodeURIComponent(seriesId)}`);
    // 加载态必须真的结束，否则后面每个断言都在断言骨架屏。
    await expect
      .poll(
        () =>
          this.page
            .getByTestId('decision-title')
            .isVisible()
            .catch(() => false),
        {
          timeout: 15_000,
        },
      )
      .toBe(true);
  }

  /** 主卡片推荐的目：编号（如 `2-1-2`）与标题。 */
  async recommended(): Promise<{ code: string; title: string }> {
    // 按"有没有编号"切分，而不是"取第一个词当编号"：目可以不编号（大纲之外
    // 新建的目），而按位置切会把标题当成编号、标题返回空串——一个只在
    // 无编号时出现的假失败。
    // `textContent` 而不是 `innerText`：后者只算渲染后的可见文本，在
    // Chromium 上对一个刚由 React 插入、尚未完成布局的节点会返回空串。
    const title = (await this.decision.getByTestId('decision-title').textContent())?.trim() ?? '';
    const match = /^(\d+(?:-\d+)*)\s+(.*)$/s.exec(title);
    return match ? { code: match[1], title: match[2].trim() } : { code: '', title };
  }
}
