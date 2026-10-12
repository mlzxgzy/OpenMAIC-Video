/**
 * `design-teaching.ts` — 第六步的领域规则，不起模型。
 *
 * 这一步的失败方式是**沉默的**：脚本说"讲透参数化"，分镜里没有一页担着它，两份文档
 * 各自看起来都完整——界面上一张表格、一个列表，没有一处变红——直到生成出一份和设计
 * 无关的课件。所以下面断言的是**两份文档的一致**，不是某一份的内容。
 *
 * 另一半是寻址：桶和页面都写 id，名称也认（名称在一个条目自己的节点集里是无歧义的），
 * 但**存下来的永远是 id**。混着存会让"脚本说讲透 X"和"第 3 页在讲 X"这两句话无法互相比
 * 较，而那正是这一步唯一真正的新检查。写名称必须落成 id、渲染必须打印名称，两侧都有
 * 断言钉住。
 */
import { describe, expect, it } from 'vitest';

import type { TeachingPageDraft } from '@/lib/curriculum/design-teaching';
import {
  applyTeachingPlan,
  deckPageAdvisories,
  formatTeachingPlan,
  nodesForObjectives,
  parseTeachingAnswer,
  resolveTeachingPlans,
  sanitizeTeachingPage,
  scriptStoryboardConflicts,
  shouldConfirmTeaching,
  teachingGapsOfItems,
  type TeachingAnswer,
  type TeachingItemBoard,
  type TeachingPlanDraft,
} from '@/lib/curriculum/design-teaching';

const NODES = [
  { id: 'node-sql', name: 'SQL 查询与参数化' },
  { id: 'node-union', name: '联合查询读数据' },
];

function item(over: Partial<TeachingItemBoard> = {}): TeachingItemBoard {
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

/** A page that carries `node-sql`, in the shape the rules layer stores. */
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

function plan(over: Partial<TeachingPlanDraft> = {}): TeachingPlanDraft {
  return { ref: 'unit-1', ...over };
}

function answer(over: Partial<TeachingAnswer> = {}): TeachingAnswer {
  return { message: '', plans: [], confirmRequested: false, rejectedRefs: [], ...over };
}

describe('parseTeachingAnswer — 模型输出', () => {
  it('reads a plan with a script and a storyboard in one object', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({
        message: '写好了',
        plans: [
          {
            ref: 'unit-1',
            core: ['node-sql'],
            pages: [page()],
            confirm: false,
          },
        ],
        confirm: true,
      }),
    );
    expect(parsed.message).toBe('写好了');
    expect(parsed.confirmRequested).toBe(true);
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0]?.core).toEqual(['node-sql']);
    expect(parsed.plans[0]?.pages?.[0]?.teaches).toEqual(['node-sql']);
  });

  it('drops a plan that names no item, because a silent change is the worst change', () => {
    const parsed = parseTeachingAnswer(JSON.stringify({ plans: [{ core: ['node-sql'] }] }));
    expect(parsed.plans).toEqual([]);
    expect(parsed.rejectedRefs.join('')).toContain('ref');
  });

  it('keeps the later of two plans for the same item and says so', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({
        plans: [
          { ref: 'unit-1', core: ['node-sql'] },
          { ref: 'unit-1', core: ['node-union'] },
        ],
      }),
    );
    expect(parsed.plans).toHaveLength(1);
    expect(parsed.plans[0]?.core).toEqual(['node-union']);
    expect(parsed.rejectedRefs.join('')).toContain('两次');
  });

  it('refuses a page that is only a heading', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({ plans: [{ ref: 'unit-1', pages: [{ title: '注入', coreInfo: 'x' }] }] }),
    );
    expect(parsed.plans[0]?.pages).toEqual([]);
    expect(parsed.rejectedRefs.join('')).toContain('目标');
  });

  it('defaults an unusable page mode to explain and reports it, rather than dropping the page', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({ plans: [{ ref: 'unit-1', pages: [page({ mode: 'lecture' as never })] }] }),
    );
    expect(parsed.plans[0]?.pages?.[0]?.mode).toBe('explain');
    expect(parsed.rejectedRefs.join('')).toContain('呈现方式');
  });

  it('drops a whole list when one entry is empty, instead of keeping half of it', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({ plans: [{ ref: 'unit-1', core: ['node-sql', ''] }] }),
    );
    // The plan survives — the ref is real — but the half-list does not: a model
    // and an author can both see a missing bucket, neither can see a missing entry.
    expect(parsed.plans[0]?.core).toBeUndefined();
    expect(parsed.rejectedRefs.join('')).toContain('整项未采用');
  });

  it('refuses `nodes` and `objectives` because the rules derive them', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({
        plans: [{ ref: 'unit-1', core: ['node-sql'] }],
        nodes: ['node-sql'],
        questions: [],
      }),
    );
    expect(parsed.rejectedRefs.join('')).toContain('推导');
    expect(parsed.rejectedRefs.join('')).toContain('下一步');
  });

  it('treats `pages: null` as "no storyboard", not as "leave it alone"', () => {
    const parsed = parseTeachingAnswer(
      JSON.stringify({ plans: [{ ref: 'unit-1', core: ['node-sql'], pages: null }] }),
    );
    expect(parsed.plans[0]?.pages).toEqual([]);
  });

  it('rejects an answer that is not a JSON object at all', () => {
    expect(() => parseTeachingAnswer('当然可以，我这就写')).toThrow();
  });

  it('sanitizes one page on its own', () => {
    const rejected: string[] = [];
    expect(
      sanitizeTeachingPage({ title: 'x', goal: 'y', coreInfo: 'z' }, 0, rejected),
    ).toMatchObject({ order: 1, mode: 'explain', emphasis: [] });
    expect(rejected).toEqual([]);
  });
});

describe('applyTeachingPlan — 一条意图落成两份文档', () => {
  it('derives `nodes` from the buckets instead of trusting the model', () => {
    const { patch } = applyTeachingPlan({
      item: item(),
      plan: plan({ core: ['node-sql'], mention: ['node-union'] }),
    });
    expect(patch.teachingDesign.core).toEqual(['node-sql']);
    expect(patch.teachingDesign.mention).toEqual(['node-union']);
    expect(patch.teachingDesign.nodes).toEqual(['node-sql', 'node-union']);
    // Derived from the item's coverage, never from the answer.
    expect(patch.teachingDesign.objectives).toEqual(['obj-1']);
  });

  it('stores the id when the plan writes a name, so both sides compare', () => {
    const { patch, rejectedRefs } = applyTeachingPlan({
      item: item(),
      plan: plan({ core: ['SQL 查询与参数化'], pages: [page({ teaches: ['SQL 查询与参数化'] })] }),
    });
    expect(patch.teachingDesign.core).toEqual(['node-sql']);
    expect(patch.deckDesign.pages?.[0]?.teaches).toEqual(['node-sql']);
    expect(rejectedRefs).toEqual([]);
  });

  it('rejects a node this item does not teach, and says which one', () => {
    const { patch, rejectedRefs } = applyTeachingPlan({
      item: item(),
      plan: plan({ core: ['node-elsewhere'] }),
    });
    expect(patch.teachingDesign.core).toEqual([]);
    expect(rejectedRefs.join('')).toContain('node-elsewhere');
  });

  it('keeps the deepest claim when one node lands in two buckets', () => {
    const { patch, advisories } = applyTeachingPlan({
      item: item(),
      plan: plan({ brief: ['node-sql'], core: ['node-sql'] }),
    });
    expect(patch.teachingDesign.core).toEqual(['node-sql']);
    expect(patch.teachingDesign.brief).toEqual([]);
    expect(advisories.join('')).toContain('更深');
  });

  it('keeps a field the plan does not name, and clears one it sets to empty', () => {
    const current = { core: ['node-sql'], cases: ['某次比赛'] };
    const { patch } = applyTeachingPlan({
      item: item({ teachingDesign: current }),
      plan: plan({ brief: ['node-union'] }),
    });
    expect(patch.teachingDesign.core).toEqual(['node-sql']);
    expect(patch.teachingDesign.cases).toEqual(['某次比赛']);
    const cleared = applyTeachingPlan({
      item: item({ teachingDesign: current }),
      plan: plan({ core: [] }),
    });
    expect(cleared.patch.teachingDesign.core).toEqual([]);
  });

  it('keeps `omit` verbatim, including things that are not nodes in this item', () => {
    const { patch } = applyTeachingPlan({
      item: item(),
      plan: plan({ omit: ['SQLMap 的安装与参数'] }),
    });
    expect(patch.teachingDesign.omit).toEqual(['SQLMap 的安装与参数']);
  });

  it('drops a sequence entry that is not this item’s node and de-duplicates the rest', () => {
    const { patch, rejectedRefs } = applyTeachingPlan({
      item: item(),
      plan: plan({ sequence: ['node-union', 'node-nope', 'node-union'] }),
    });
    expect(patch.teachingDesign.sequence).toEqual(['node-union']);
    expect(rejectedRefs.join('')).toContain('node-nope');
  });

  it('accepts a prerequisite from outside the item, but not one that does not exist', () => {
    const board = item({
      allNodeNames: new Map([
        ['node-sql', 'SQL 查询与参数化'],
        ['node-http', 'HTTP 基础'],
      ]),
    });
    const kept = applyTeachingPlan({ item: board, plan: plan({ prerequisites: ['node-http'] }) });
    expect(kept.patch.teachingDesign.prerequisites).toEqual(['node-http']);
    const dropped = applyTeachingPlan({
      item: board,
      plan: plan({ prerequisites: ['node-ghost'] }),
    });
    expect(dropped.patch.teachingDesign.prerequisites).toEqual([]);
    expect(dropped.rejectedRefs.join('')).toContain('node-ghost');
  });

  it('refuses a storyboard on a drill, because the generator ignores it', () => {
    // `deckDesignForRole` gives a non-lecture item no deck. Storing a plan there
    // would show the author a storyboard that never reaches a run.
    const { patch, rejectedRefs } = applyTeachingPlan({
      item: item({ role: 'practice' }),
      plan: plan({ pages: [page()] }),
    });
    expect(rejectedRefs.join('')).toContain('没有分镜');
    expect(patch.deckDesign.pages ?? []).toEqual([]);
  });

  it('renumbers duplicated page orders and says it did', () => {
    const { patch, advisories } = applyTeachingPlan({
      item: item(),
      plan: plan({
        pages: [page({ order: 2, title: '二' }), page({ order: 2, title: '一并' })],
      }),
    });
    expect(patch.deckDesign.pages?.map((row) => row.order)).toEqual([1, 2]);
    expect(advisories.join('')).toContain('序号');
  });

  it('derives the page count instead of trusting estPages', () => {
    const { patch, advisories } = applyTeachingPlan({
      item: item(),
      plan: plan({ pages: [page()], estPages: 12 }),
    });
    expect(patch.deckDesign.estPages).toBe(1);
    expect(advisories.join('')).toContain('自报');
  });

  it('drops a page node that is not this item’s, and keeps the page', () => {
    const { patch, rejectedRefs } = applyTeachingPlan({
      item: item(),
      plan: plan({ pages: [page({ teaches: ['node-ghost'] })] }),
    });
    expect(patch.deckDesign.pages?.[0]?.teaches).toBeUndefined();
    expect(rejectedRefs.join('')).toContain('node-ghost');
  });

  it('reports "changed" only when the documents really differ', () => {
    const stored = item({
      teachingDesign: { core: ['node-sql'], nodes: ['node-sql'], objectives: ['obj-1'] },
      deckDesign: {
        estPages: 1,
        pages: [
          {
            order: 1,
            title: '参数拼接就是注入点',
            goal: '学员能指出注入点',
            coreInfo: '参数被拼进 SQL 的地方就是注入点',
            mode: 'explain',
            teaches: ['node-sql'],
          },
        ],
      },
    });
    const same = applyTeachingPlan({
      item: stored,
      plan: plan({ core: ['node-sql'], pages: [page()] }),
    });
    expect(same.changed).toBe(false);
    const different = applyTeachingPlan({
      item: stored,
      plan: plan({ core: ['node-union', 'node-sql'] }),
    });
    expect(different.changed).toBe(true);
  });
});

describe('resolveTeachingPlans — 只有被指名的条目会变', () => {
  const board = [item(), item({ id: 'unit-2', title: '1.2 SQL 注入练习', role: 'practice' })];

  it('writes the items the answer names and leaves the rest untouched', () => {
    const { patches, unmatchedRefs } = resolveTeachingPlans({
      board: { items: board, objectives: [] },
      answer: answer({ plans: [plan({ core: ['node-sql'] })] }),
    });
    expect([...patches.keys()]).toEqual(['unit-1']);
    expect(unmatchedRefs).toEqual([]);
  });

  it('drops an item ref that does not exist and reports it', () => {
    const { patches, unmatchedRefs } = resolveTeachingPlans({
      board: { items: board, objectives: [] },
      answer: answer({ plans: [plan({ ref: 'unit-ghost', core: ['node-sql'] })] }),
    });
    expect(patches.size).toBe(0);
    expect(unmatchedRefs).toEqual(['unit-ghost']);
  });
});

describe('teachingGapsOfItems — 这一条还差什么', () => {
  it('asks for the outline when there are no items at all', () => {
    expect(teachingGapsOfItems([]).map((gap) => gap.kind)).toEqual(['no_items']);
  });

  it('calls an empty item undesigned', () => {
    const gaps = teachingGapsOfItems([item()]);
    expect(gaps.map((gap) => gap.kind)).toEqual(['no_design']);
    expect(gaps[0]?.text).toContain('1.1 SQL 注入原理');
  });

  it('refuses a script with no depth at all, even when it has cases', () => {
    const gaps = teachingGapsOfItems([item({ teachingDesign: { cases: ['某个案例'] } })]);
    expect(gaps.map((gap) => gap.kind)).toContain('no_bucket');
  });

  it('requires a storyboard of a lecture and not of a drill', () => {
    const lecture = teachingGapsOfItems([item({ teachingDesign: { core: ['node-sql'] } })]);
    expect(lecture.map((gap) => gap.kind)).toContain('no_deck');
    const drill = teachingGapsOfItems([
      item({ role: 'practice', teachingDesign: { core: ['node-sql'] } }),
    ]);
    expect(drill).toEqual([]);
  });

  it('requires every page but a summary to carry a node', () => {
    const carried = page();
    const gaps = teachingGapsOfItems([
      item({
        teachingDesign: { core: ['node-sql'] },
        deckDesign: {
          estPages: 2,
          pages: [carried as never, { ...page(), order: 2, mode: 'summary', teaches: [] } as never],
        },
      }),
    ]);
    // The summary page is exempt; the explain page carries the node.
    expect(gaps.filter((gap) => gap.kind === 'page_without_node')).toEqual([]);

    const missing = teachingGapsOfItems([
      item({
        teachingDesign: { core: ['node-sql'] },
        deckDesign: {
          estPages: 1,
          pages: [{ ...page(), teaches: [] } as never],
        },
      }),
    ]);
    expect(missing.map((gap) => gap.kind)).toContain('page_without_node');
  });

  it('does not demand a page-level node when the item has none to name', () => {
    // An item covering no outcome is `unit_orphan`'s finding; repeating it here
    // would put a second, unactionable line in front of the author.
    const gaps = teachingGapsOfItems([
      item({
        nodes: [],
        teachingDesign: { core: [] },
        deckDesign: { estPages: 1, pages: [{ ...page(), teaches: [] } as never] },
      }),
    ]);
    expect(gaps.filter((gap) => gap.kind === 'page_without_node')).toEqual([]);
  });

  it('requires the core to have a place in the sequence', () => {
    const gaps = teachingGapsOfItems([
      item({
        teachingDesign: { core: ['node-sql'], sequence: ['node-union'] },
        deckDesign: { estPages: 1, pages: [page() as never] },
      }),
    ]);
    expect(gaps.map((gap) => gap.kind)).toContain('sequence_missing_core');
  });
});

describe('scriptStoryboardConflicts — 两份文档互相矛盾', () => {
  const conflicted = (over: Parameters<typeof scriptStoryboardConflicts>[0]) =>
    scriptStoryboardConflicts(over).map((gap) => gap.kind);

  it('reports a point the script teaches in full that no page carries', () => {
    const gaps = scriptStoryboardConflicts(
      item({
        teachingDesign: { core: ['node-sql'] },
        deckDesign: { estPages: 1, pages: [page({ teaches: ['node-union'] }) as never] },
      }),
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['script_storyboard_conflict']);
    expect(gaps[0]?.text).toContain('SQL 查询与参数化');
  });

  it('reports a page teaching something the script marked out of scope', () => {
    const gaps = scriptStoryboardConflicts(
      item({
        teachingDesign: { core: ['node-sql'], omit: ['node-union'] },
        deckDesign: {
          estPages: 1,
          pages: [page({ teaches: ['node-sql', 'node-union'] }) as never],
        },
      }),
    );
    expect(gaps.map((gap) => gap.kind)).toEqual(['script_storyboard_conflict']);
    expect(gaps[0]?.text).toContain('联合查询读数据');
  });

  it('reads a script that named nodes by name, since the workbench writes what was typed', () => {
    const gaps = scriptStoryboardConflicts(
      item({
        teachingDesign: { core: ['SQL 查询与参数化'] },
        deckDesign: { estPages: 1, pages: [page({ teaches: ['SQL 查询与参数化'] }) as never] },
      }),
    );
    expect(gaps).toEqual([]);
  });

  it('treats an `omit` line that is prose as prose, not as a node reference', () => {
    const gaps = scriptStoryboardConflicts(
      item({
        teachingDesign: { core: ['node-sql'], omit: ['SQLMap 的安装'] },
        deckDesign: { estPages: 1, pages: [page() as never] },
      }),
    );
    expect(gaps).toEqual([]);
  });

  it('says nothing about a drill, which has no storyboard to contradict', () => {
    expect(
      conflicted(
        item({
          role: 'practice',
          teachingDesign: { core: ['node-sql'] },
          deckDesign: { estPages: 1, pages: [page({ teaches: [] }) as never] },
        }),
      ),
    ).toEqual([]);
  });
});

describe('shouldConfirmTeaching — 签收是规则，不是模型说了算', () => {
  const base = {
    confirmRequested: true,
    userTurns: 2,
    itemCount: 3,
    gaps: [],
    changedAnything: true,
  };

  it('accepts a complete, changed, non-first turn the model calls confirmed', () => {
    expect(shouldConfirmTeaching(base)).toBe(true);
  });

  it('refuses the first message, an unchanged turn and a design with a gap', () => {
    expect(shouldConfirmTeaching({ ...base, userTurns: 1 })).toBe(false);
    expect(shouldConfirmTeaching({ ...base, changedAnything: false })).toBe(false);
    expect(shouldConfirmTeaching({ ...base, gaps: [{ text: '还没有分镜' }] })).toBe(false);
  });

  it('refuses to confirm a task with no items', () => {
    expect(shouldConfirmTeaching({ ...base, itemCount: 0 })).toBe(false);
  });

  it('does not confirm when the model did not ask', () => {
    expect(shouldConfirmTeaching({ ...base, confirmRequested: false })).toBe(false);
  });
});

describe('formatTeachingPlan — 提示词里看到的就是面板里看到的', () => {
  const board = {
    items: [
      item({
        teachingDesign: { core: ['node-sql'], sequence: ['node-sql'] },
        deckDesign: { estPages: 1, pages: [page() as never] },
      }),
    ],
    objectives: [{ id: 'obj-1', title: '能独立完成注入' }],
  };

  it('prints both addressings, so the model knows what it may point at', () => {
    const text = formatTeachingPlan(board);
    expect(text).toContain('node-sql=SQL 查询与参数化');
    expect(text).toContain('讲透：SQL 查询与参数化');
    expect(text).toContain('obj-1(能独立完成注入)');
  });

  it('prints a page’s nodes as names, never as ids', () => {
    // The generator reads this text. `node_xxx` in it is a string it would have
    // to guess about; the whole reason pages store ids is so the prompt can print
    // names without the storyboard and the script drifting apart.
    const text = formatTeachingPlan(board);
    const pageLine = text.split('\n').find((line) => line.includes('参数拼接就是注入点'))!;
    expect(pageLine).toContain('SQL 查询与参数化');
    expect(pageLine).not.toContain('node-sql');
  });

  it('says a drill has no storyboard rather than printing an empty one', () => {
    const text = formatTeachingPlan({
      items: [item({ role: 'practice', teachingDesign: { core: ['node-sql'] } })],
      objectives: board.objectives,
    });
    expect(text).toContain('练习/考试条目没有分镜');
  });
});

describe('deckPageAdvisories — 只提示，不拦', () => {
  const pages = (count: number) =>
    Array.from({ length: count }, (_, index) => page({ order: index + 1 }));

  it('says nothing about a lesson inside the rhythm', () => {
    expect(
      deckPageAdvisories({
        title: 'x',
        role: 'lecture',
        deckDesign: { estPages: 12, pages: pages(12) as never },
      }),
    ).toEqual([]);
  });

  it('notes a lesson far off the rhythm without refusing it', () => {
    const advisories = deckPageAdvisories({
      title: '1.1 SQL 注入原理',
      role: 'lecture',
      deckDesign: { estPages: 30, pages: pages(30) as never },
    });
    expect(advisories.map((row) => row.text).join('')).toContain('1.1 SQL 注入原理');
  });
});

describe('nodesForObjectives — 条目能点哪些知识点', () => {
  it('follows the coverage relation: item → outcome → nodes', () => {
    const nodes = [
      { id: 'node-sql', name: 'SQL 查询与参数化' },
      { id: 'node-http', name: 'HTTP 基础' },
    ];
    const nodeObjectives = [
      { nodeId: 'node-sql', objectiveId: 'obj-1' },
      { nodeId: 'node-http', objectiveId: 'obj-2' },
    ];
    expect(nodesForObjectives(['obj-1'], nodeObjectives as never, nodes as never)).toEqual([
      { id: 'node-sql', name: 'SQL 查询与参数化' },
    ]);
  });
});
