/**
 * 驾驶舱那块大卡片推荐哪一目。
 *
 * 这些测试钉的是**优先级**，不是渲染。理由是这类推荐一旦漂移是看不见的：界面照
 * 常渲染，用户照常点，只是推荐的那一目次序变了，而没有任何报错。所以每条规则
 * 各有一条测试，其中两条是反直觉的（阻塞优先于进度、最近更新的优先于最早建
 * 的），它们正是最容易在重构中被"顺手统一"掉的。
 */
import { describe, expect, it } from 'vitest';

import { chooseNextItem, pendingItems, type NextItemRow } from '@/lib/curriculum/next-item';

function row(overrides: Partial<NextItemRow> = {}): NextItemRow {
  return {
    taskId: 'task-1',
    code: '1-1-1',
    title: 'CTF 概述与竞赛形式',
    phase: 'task',
    unitCount: 0,
    producedCount: 0,
    objectiveCount: 0,
    blockingCount: 0,
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('chooseNextItem', () => {
  it('已出片的目永不入选，即使它最近更新', () => {
    const decision = chooseNextItem([
      row({ taskId: 'done', producedCount: 1, updatedAt: '2026-06-01T00:00:00.000Z' }),
      row({ taskId: 'todo', phase: 'outcomes', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(decision?.taskId).toBe('todo');
  });

  it('有阻塞缺陷的目压过一切，哪怕它阶段最靠后', () => {
    const decision = chooseNextItem([
      row({ taskId: 'early', phase: 'graph', objectiveCount: 2 }),
      row({ taskId: 'blocked', phase: 'review', blockingCount: 3 }),
    ]);
    expect(decision?.taskId).toBe('blocked');
    expect(decision?.cause).toBe('blocked');
    expect(decision?.blockers).toEqual(['3 处审核未处理']);
  });

  it('进行中的目优先于还没开始的目', () => {
    const decision = chooseNextItem([
      row({ taskId: 'fresh', phase: 'task', updatedAt: '2026-06-01T00:00:00.000Z' }),
      row({ taskId: 'going', phase: 'outline', objectiveCount: 3 }),
    ]);
    expect(decision?.taskId).toBe('going');
  });

  it('同为进行中时，最近更新的在前（继续上次）', () => {
    const decision = chooseNextItem([
      row({ taskId: 'older', phase: 'graph', updatedAt: '2026-01-01T00:00:00.000Z' }),
      row({ taskId: 'newer', phase: 'graph', updatedAt: '2026-05-01T00:00:00.000Z' }),
    ]);
    expect(decision?.taskId).toBe('newer');
  });

  it('同为未开始时，最早创建的在前', () => {
    const decision = chooseNextItem([
      row({ taskId: 'later', updatedAt: '2026-05-01T00:00:00.000Z' }),
      row({ taskId: 'earlier', updatedAt: '2026-01-01T00:00:00.000Z' }),
    ]);
    expect(decision?.taskId).toBe('earlier');
  });

  it('全部已出片时返回 null，界面据此渲染空状态而不是编一个推荐', () => {
    expect(chooseNextItem([row({ producedCount: 1 })])).toBeNull();
    expect(chooseNextItem([])).toBeNull();
  });

  it('理由说的是用户语言，且每一步都有自己的动作动词', () => {
    const decision = chooseNextItem([row({ phase: 'graph', objectiveCount: 1, unitCount: 1 })]);
    expect(decision?.reason).toContain('第 3 步');
    expect(decision?.reason).toContain('需要哪些前置知识');
    expect(decision?.actionLabel).toBe('定它需要哪些前置知识');
  });

  it('骨架目会被明说成"还没开始"，而不是伪装成进行中', () => {
    const decision = chooseNextItem([row(), row({ taskId: 'other', code: '1-1-2' })]);
    expect(decision?.cause).toBe('not-started');
    expect(decision?.reason).toContain('还没开始设计');
    expect(decision?.reason).toContain('还有 1 目');
  });

  it('待办第一条与推荐项恒等（两块并排显示，顺序不能各写一套）', () => {
    const rows = [
      row({
        taskId: 'blocked',
        phase: 'review',
        blockingCount: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
      }),
      row({ taskId: 'fresh', updatedAt: '2026-06-01T00:00:00.000Z' }),
      row({
        taskId: 'going',
        phase: 'graph',
        objectiveCount: 1,
        updatedAt: '2026-03-01T00:00:00.000Z',
      }),
      row({ taskId: 'done', producedCount: 1, updatedAt: '2026-05-01T00:00:00.000Z' }),
    ];
    expect(pendingItems(rows)[0]?.taskId).toBe(chooseNextItem(rows)?.taskId);
    // 已出片的目不进待办，即使它是最近动的。
    expect(pendingItems(rows).map((item) => item.taskId)).not.toContain('done');
  });

  it('不改动输入数组（界面会把它复用成待办列表）', () => {
    const rows = [row({ taskId: 'a' }), row({ taskId: 'b', phase: 'outcomes' })];
    const before = rows.map((item) => item.taskId);
    chooseNextItem(rows);
    expect(rows.map((item) => item.taskId)).toEqual(before);
  });
});
