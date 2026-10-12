/**
 * `resolveTeachingTurn` — 第六步一轮对话的确定性一半，不起模型。
 *
 * 这里钉住的是这一步特有的两件事：
 *
 * 1. **缺口算在写完之后的设计上。** 模型刚补上的分镜不该继续被报成"还差分镜"，否则它
 *    会一直被告知一件它刚做完的事。反过来，它这一轮**没**补上的缺口必须留着。
 * 2. **只有被指名的条目会变。** `updateCurriculumUnit` 只写被点名的条目，所以这是
 *    "模型改一条不碰其他条"的保证：一条没被提到的条目，脚本和分镜都原样保留。
 */
import { describe, expect, it } from 'vitest';

import type { TeachingAnswer, TeachingPageDraft } from '@/lib/curriculum/design-teaching';
import { resolveTeachingTurn, teachingBoardOf } from '@/lib/server/curriculum/teaching-step';
import type { TeachingBoard, TeachingItemBoard } from '@/lib/curriculum/design-teaching';

const NODES = [
  { id: 'node-sql', name: 'SQL 查询与参数化' },
  { id: 'node-union', name: '联合查询读数据' },
];

const page = (over: Partial<TeachingPageDraft> = {}): TeachingPageDraft => ({
  order: 1,
  title: '参数拼接就是注入点',
  goal: '学员能指出注入点',
  coreInfo: '参数被拼进 SQL 的地方就是注入点',
  mode: 'explain',
  emphasis: [],
  visual: null,
  code: null,
  teaches: ['node-sql'],
  ...over,
});

function boardItem(over: Partial<TeachingItemBoard> = {}): TeachingItemBoard {
  return {
    id: 'unit-1',
    title: '1.1 SQL 注入原理',
    role: 'lecture',
    hours: 1,
    objectiveIds: ['obj-1'],
    nodes: NODES,
    allNodeNames: new Map(NODES.map((node) => [node.id, node.name])),
    teachingDesign: {},
    deckDesign: {},
    ...over,
  };
}

const board: TeachingBoard = {
  items: [
    boardItem(),
    boardItem({
      id: 'unit-2',
      title: '1.2 SQL 注入练习',
      role: 'practice',
      teachingDesign: { core: ['node-sql'], nodes: ['node-sql'], objectives: ['obj-1'] },
    }),
  ],
  objectives: [{ id: 'obj-1', title: '能独立完成注入' }],
};

function answer(over: Partial<TeachingAnswer> = {}): TeachingAnswer {
  return { message: '', plans: [], confirmRequested: false, rejectedRefs: [], ...over };
}

const kinds = (gaps: readonly { kind: string; ref?: string }[]) =>
  gaps.map((gap) => `${gap.ref ?? '-'}:${gap.kind}`).sort();

describe('resolveTeachingTurn — 缺口算在写完之后的稿子上', () => {
  it('stops reporting the storyboard gap the turn just filled', () => {
    const turn = resolveTeachingTurn({
      answer: answer({
        plans: [{ ref: 'unit-1', core: ['node-sql'], pages: [page()] }],
      }),
      board,
      history: [{ role: 'user', content: '把 1.1 的分镜写出来' }],
    });
    expect(kinds(turn.gaps)).toEqual([]);
    expect(turn.changedAnything).toBe(true);
    expect(turn.patches.size).toBe(1);
  });

  it('keeps the gap it did not fill, and says why nothing was written for the other item', () => {
    const turn = resolveTeachingTurn({
      answer: answer({ plans: [{ ref: 'unit-1', core: ['node-sql'], pages: [page()] }] }),
      board: {
        items: [
          ...board.items,
          boardItem({ id: 'unit-3', title: '1.3 SQL 注入考核', role: 'exam' }),
        ],
        objectives: board.objectives,
      },
      history: [{ role: 'user', content: '只写 1.1' }],
    });
    // unit-3 was never mentioned, so its own `no_design` gap survives — a turn
    // cannot close a hole it did not touch.
    expect(kinds(turn.gaps)).toEqual(['unit-3:no_design']);
  });

  it('leaves an item it did not mention exactly as it was', () => {
    const turn = resolveTeachingTurn({
      answer: answer({ plans: [{ ref: 'unit-2', core: ['node-union', 'node-sql'] }] }),
      board,
      history: [{ role: 'user', content: '练习那条主要是联合查询' }],
    });
    expect([...turn.patches.keys()]).toEqual(['unit-2']);
    expect(turn.patches.get('unit-1')).toBeUndefined();
    // A practice item needs no storyboard, so unit-2 is complete — and unit-1,
    // which the turn never mentioned, is still exactly as undesigned as it was.
    expect(kinds(turn.gaps)).toEqual(['unit-1:no_design']);
  });

  it('reports a storyboard that contradicts the script as a gap, not a patch', () => {
    const turn = resolveTeachingTurn({
      answer: answer({
        plans: [{ ref: 'unit-1', core: ['node-union'], pages: [page({ teaches: ['node-sql'] })] }],
      }),
      board,
      history: [{ role: 'user', content: '讲联合查询' }],
    });
    // The plan is written (the script is the author's decision); what the author
    // reads is that the two documents disagree.
    expect(turn.patches.size).toBe(1);
    expect(kinds(turn.gaps)).toContain('unit-1:script_storyboard_conflict');
  });

  it('refuses to confirm while a gap is open, and allows it once none is', () => {
    const open = resolveTeachingTurn({
      answer: answer({ plans: [{ ref: 'unit-2', core: ['node-sql'] }], confirmRequested: true }),
      board,
      history: [
        { role: 'user', content: '写吧' },
        { role: 'user', content: '确认' },
      ],
    });
    expect(open.modelRequestedConfirm).toBe(true);
    expect(open.confirmRequested).toBe(false);
    expect(kinds(open.gaps)).toEqual(['unit-1:no_design']);

    const closed = resolveTeachingTurn({
      answer: answer({
        plans: [
          { ref: 'unit-1', core: ['node-sql'], pages: [page()] },
          { ref: 'unit-2', core: ['node-sql'] },
        ],
        confirmRequested: true,
      }),
      board,
      history: [
        { role: 'user', content: '写吧' },
        { role: 'user', content: '确认' },
      ],
    });
    expect(closed.confirmRequested).toBe(true);
  });

  it('cannot confirm on the first message, even with nothing missing', () => {
    const board1: TeachingBoard = {
      items: [
        boardItem({
          teachingDesign: { core: ['node-sql'], nodes: ['node-sql'], objectives: ['obj-1'] },
          deckDesign: { estPages: 1, pages: [page() as never] },
        }),
      ],
      objectives: board.objectives,
    };
    const turn = resolveTeachingTurn({
      answer: answer({ plans: [{ ref: 'unit-1', core: ['node-sql'] }], confirmRequested: true }),
      board: board1,
      history: [],
    });
    expect(turn.userTurns).toBe(1);
    expect(turn.confirmRequested).toBe(false);
  });

  it('carries the model’s rejections and its own, so the author sees one list', () => {
    const turn = resolveTeachingTurn({
      answer: answer({
        plans: [{ ref: 'unit-1', core: ['node-ghost'] }],
        rejectedRefs: ['模型自己说的一条'],
      }),
      board,
      history: [{ role: 'user', content: '写' }],
    });
    expect(turn.rejectedRefs.join('|')).toContain('模型自己说的一条');
    expect(turn.rejectedRefs.join('|')).toContain('node-ghost');
  });

  it('separates an advisory from a gap: a miscounted page list is noted, not refused', () => {
    // `estPages` is derived at write time, so a plan cannot claim a length it does
    // not have. Saying so is an advisory: the pages themselves are the decision.
    const turn = resolveTeachingTurn({
      answer: answer({
        plans: [{ ref: 'unit-1', core: ['node-sql'], pages: [page()], estPages: 9 }],
      }),
      board: { items: [board.items[0]!], objectives: board.objectives },
      history: [{ role: 'user', content: '写一页' }],
    });
    expect(turn.gaps).toEqual([]);
    expect(turn.advisories.join('')).toContain('自报');
    expect(turn.patches.get('unit-1')?.deckDesign.estPages).toBe(1);
  });
});

describe('teachingBoardOf — 条目能点哪些节点', () => {
  it('follows item → outcome → node, and lists chapters for the panel', () => {
    const result = teachingBoardOf({
      units: [
        {
          id: 'chapter-1',
          unitType: 'chapter',
          unitRole: null,
          title: '第一章',
          parentId: null,
          hours: null,
          teachingDesign: null,
          deckDesign: null,
        },
        {
          id: 'unit-1',
          unitType: 'item',
          unitRole: 'lecture',
          title: '1.1 SQL 注入原理',
          parentId: 'chapter-1',
          hours: 1,
          teachingDesign: { core: ['node-sql'] },
          deckDesign: { estPages: 1, pages: [page() as never] },
        },
      ] as never,
      coverage: [{ unitId: 'unit-1', objectiveId: 'obj-1' }] as never,
      objectives: [{ id: 'obj-1', title: '能独立完成注入' }],
      nodes: NODES as never,
      nodeObjectives: [{ nodeId: 'node-sql', objectiveId: 'obj-1' }] as never,
    });
    // A chapter is not a lesson: only items are authored here.
    expect(result.items.map((row) => row.id)).toEqual(['unit-1']);
    expect(result.items[0]?.nodes).toEqual([{ id: 'node-sql', name: 'SQL 查询与参数化' }]);
    expect(result.chapters?.map((row) => row.id)).toEqual(['chapter-1']);
  });
});
