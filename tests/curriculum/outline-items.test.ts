import { describe, expect, it } from 'vitest';

import { outlineItems } from '@/lib/curriculum/outline-items';
import type { CurriculumUnitRecord } from '@/lib/curriculum/design-types';

/**
 * 这一条测的是"条目按什么顺序、属于哪一章"，因为两个页面都在用它：
 * 目工作台的出片面板和旧台账的课程组装面板。它们对"这一目的条目"必须给出同一份
 * 列表——否则同一个设计在两处显示的顺序不同，而作者无从判断哪个是真的。
 */
function unit(partial: Partial<CurriculumUnitRecord> & { id: string }): CurriculumUnitRecord {
  return {
    taskId: 'task-1',
    parentId: null,
    unitType: 'item',
    title: partial.id,
    code: null,
    unitRole: 'lecture',
    hours: null,
    orderIndex: 0,
    teachingDesign: { core: [] },
    deckDesign: { estPages: null, pages: [] },
    stageId: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  } as CurriculumUnitRecord;
}

describe('outlineItems', () => {
  it('keeps chapters out of the list but uses them as the group label', () => {
    const items = outlineItems([
      unit({ id: 'chapter-1', unitType: 'chapter', title: '第一章 CTF 基础', orderIndex: 0 }),
      unit({ id: 'item-1', title: '1.1 概述', parentId: 'chapter-1', orderIndex: 0 }),
      unit({ id: 'chapter-2', unitType: 'chapter', title: '第二章 Web 安全', orderIndex: 1 }),
      unit({ id: 'item-2', title: '2.1 注入', parentId: 'chapter-2', orderIndex: 0 }),
    ]);
    expect(items.map((entry) => entry.unit.id)).toEqual(['item-1', 'item-2']);
    expect(items.map((entry) => entry.chapterTitle)).toEqual([
      '第一章 CTF 基础',
      '第二章 Web 安全',
    ]);
  });

  /**
   * 顺序读 `orderIndex`，而不是数组顺序。快照是按 `order_index` 之外的字段取回来的
   * （`ORDER BY` 在 SQL 里，但测试与将来的调用方都不该依赖它），而"第 4 步的大纲"
   * 在界面上就是按 `orderIndex` 排的。
   */
  it('sorts by orderIndex instead of trusting array order', () => {
    const items = outlineItems([
      unit({ id: 'item-b', orderIndex: 2 }),
      unit({ id: 'item-a', orderIndex: 1 }),
    ]);
    expect(items.map((entry) => entry.unit.id)).toEqual(['item-a', 'item-b']);
  });

  it('reports a null chapter for an orphan item rather than inventing one', () => {
    const items = outlineItems([unit({ id: 'item-1', parentId: 'missing-chapter' })]);
    expect(items[0]?.chapterTitle).toBeNull();
  });
});
