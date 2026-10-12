/**
 * `resolveOutlineTurn` — the deterministic half of a step-5 turn, no model.
 *
 * This is where step 5's most consequential decision lives: the store replaces a
 * task's whole coverage ledger, so the turn has to pass **every** row, not just
 * the ones the model named. A regression here does not fail loudly — it silently
 * strips an item of everything it taught, and the course only breaks later at the
 * `outline → teaching` gate, which then blames the wrong thing.
 *
 * The other half is placement: chapters, sections and items arrive in one answer,
 * so a draft naming another draft as its parent has to become a real parent id in
 * the right order, and anything the store would refuse has to be dropped here
 * rather than thrown there (a throw rolls the whole turn back).
 */
import { describe, expect, it } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import type { OutlineAnswer, OutlineUnitRef } from '@/lib/curriculum/design-outline';
import {
  draftCoverageOf,
  formatOutlineGraph,
  outlineBoardOf,
  resolveOutlineTurn,
  type OutlineBoard,
} from '@/lib/server/curriculum/outline-step';

const chapter: OutlineUnitRef = {
  id: 'unit_ch',
  title: '第一章',
  unitType: 'chapter',
  unitRole: null,
  parentId: null,
  orderIndex: 0,
  hours: null,
};
const itemA: OutlineUnitRef = {
  id: 'unit_a',
  title: '目一',
  unitType: 'item',
  unitRole: 'lecture',
  parentId: 'unit_ch',
  orderIndex: 0,
  hours: 1,
};
const itemB: OutlineUnitRef = {
  id: 'unit_b',
  title: '目二',
  unitType: 'item',
  unitRole: 'practice',
  parentId: 'unit_ch',
  orderIndex: 1,
  hours: 2,
};

const board: OutlineBoard = {
  units: [chapter, itemA, itemB],
  coverageByUnit: new Map([
    ['unit_a', [{ objectiveId: 'obj_1', coverageKind: 'teach', depth: 'standard' }]],
    ['unit_b', [{ objectiveId: 'obj_1', coverageKind: 'practice', depth: 'deep' }]],
  ]),
  objectives: [
    { id: 'obj_1', title: '独立完成注入' },
    { id: 'obj_2', title: '写出 Writeup' },
  ],
  nodes: [
    { id: 'node_x', name: 'SQL 基础', nodeType: 'knowledge' },
    { id: 'node_y', name: '联合查询', nodeType: 'skill' },
  ],
  linksByNode: new Map([
    ['node_x', [{ objectiveId: 'obj_1' }]],
    ['node_y', [{ objectiveId: 'obj_1' }]],
  ]),
  edges: [
    {
      sourceId: 'node_x',
      sourceKind: 'node',
      targetId: 'node_y',
      targetKind: 'node',
      edgeType: 'prerequisite',
    },
  ],
  teachingOrder: [
    { id: 'node_x', name: 'SQL 基础' },
    { id: 'node_y', name: '联合查询' },
  ],
  declaredHours: 3,
};

function answer(overrides: Partial<OutlineAnswer> = {}): OutlineAnswer {
  return {
    message: '',
    added: [],
    updated: [],
    removed: [],
    coverage: [],
    confirmRequested: false,
    rejectedRefs: [],
    ...overrides,
  };
}

const rows = (result: ReturnType<typeof resolveOutlineTurn>) =>
  result.coverage.map((row) => `${row.unitId}:${row.objectiveId}:${row.coverageKind}`).sort();

describe('resolveOutlineTurn — 覆盖账本它交给 store 的是哪一份', () => {
  it('把没被提到的条目的覆盖原样带过来', () => {
    const result = resolveOutlineTurn({
      answer: answer({
        coverage: [{ ref: 'unit_a', objectiveRef: 'obj_2', coverageKind: 'teach' }],
      }),
      board,
      history: [{ role: 'user', content: '目一其实教的是写 Writeup' }],
    });
    // unit_b 的 practice 覆盖必须还在。只发 unit_a 的那一份，就会把它清掉——
    // 这正是这个函数存在的意义。
    expect(rows(result)).toEqual(['unit_a:obj_2:teach', 'unit_b:obj_1:practice']);
  });

  it('清空一个条目只清它自己', () => {
    const result = resolveOutlineTurn({
      answer: answer({ coverage: [{ ref: 'unit_a', objectiveRef: null }] }),
      board,
      history: [{ role: 'user', content: '目一先不覆盖任何目标' }],
    });
    expect(rows(result)).toEqual(['unit_b:obj_1:practice']);
    expect(result.changedCoverage).toBe(true);
    expect(result.changedAnything).toBe(true);
  });

  it('条目被删掉时它的覆盖不会带回来', () => {
    const result = resolveOutlineTurn({
      answer: answer({ removed: ['unit_a'] }),
      board,
      history: [{ role: 'user', content: '删掉目一' }],
    });
    expect(rows(result)).toEqual(['unit_b:obj_1:practice']);
    expect(result.removed.has('unit_a')).toBe(true);
  });

  it('空回答什么也没改：签收不该被一次提问撤回', () => {
    const result = resolveOutlineTurn({
      answer: answer(),
      board,
      history: [{ role: 'user', content: '这门课大概多少学时？' }],
    });
    expect(result.changedAnything).toBe(false);
    expect(result.changedCoverage).toBe(false);
    expect(rows(result)).toEqual(['unit_a:obj_1:teach', 'unit_b:obj_1:practice']);
  });

  it('新建条目的覆盖写在它自己的 coverage 里；写在外层记一笔账', () => {
    const result = resolveOutlineTurn({
      answer: answer({
        added: [
          {
            ref: 'i_new',
            title: '新目',
            unitType: 'item',
            unitRole: 'lecture',
            hours: 1,
            parentRef: 'unit_ch',
            order: null,
            coverage: [
              { objectiveRef: 'obj_2', coverageKind: 'teach', depth: 'standard' },
              { objectiveRef: 'obj_nope', coverageKind: 'teach', depth: 'standard' },
            ],
          },
        ],
        coverage: [{ ref: 'i_new', objectiveRef: 'obj_1', coverageKind: 'teach' }],
      }),
      board,
      history: [{ role: 'user', content: '加一个新目' }],
    });
    expect(result.creates).toHaveLength(1);
    expect(result.creates[0]?.parentId).toBe('unit_ch');
    // The outer binding names a unit that does not exist yet, so it is dropped
    // and logged rather than applied to some other row.
    expect(result.unmatchedRefs).toContain('i_new');
    expect(
      draftCoverageOf(result.creates[0]!.draft, new Set(['obj_1', 'obj_2'])).map(
        (row) => row.objectiveId,
      ),
    ).toEqual(['obj_2']);
  });

  it('章、节、目在同一轮里建：父级按 draft 的 ref 解析', () => {
    const result = resolveOutlineTurn({
      answer: answer({
        added: [
          {
            ref: 'ch2',
            title: '第二章',
            unitType: 'chapter',
            unitRole: null,
            hours: null,
            parentRef: null,
            order: null,
            coverage: [],
          },
          {
            ref: 's2',
            title: '第一节',
            unitType: 'chapter',
            unitRole: null,
            hours: null,
            parentRef: 'ch2',
            order: null,
            coverage: [],
          },
          {
            ref: 'i2',
            title: '目一',
            unitType: 'item',
            unitRole: 'lecture',
            hours: 1,
            parentRef: 's2',
            order: null,
            coverage: [{ objectiveRef: 'obj_2', coverageKind: 'teach', depth: 'deep' }],
          },
        ],
      }),
      board,
      history: [{ role: 'user', content: '按同一结构把第二章也排出来' }],
    });
    expect(result.creates.map((create) => create.draft.ref)).toEqual(['ch2', 's2', 'i2']);
    expect(result.creates[0]?.orderIndex).toBe(1);
    expect(result.changedAnything).toBe(true);
  });

  it('用户轮次从历史里数，第一步不能确认', () => {
    const result = resolveOutlineTurn({
      answer: answer({ confirmRequested: true }),
      board,
      history: [{ role: 'assistant', content: '这是大纲' }],
    });
    expect(result.userTurns).toBe(1);
    expect(result.modelRequestedConfirm).toBe(true);
  });
});

describe('outlineBoardOf / formatOutlineGraph — 模型读到的上下文', () => {
  it('覆盖按条目分组，单元按层级和顺序排', () => {
    const built = outlineBoardOf({
      units: [itemB, chapter, itemA],
      coverage: [
        { unitId: 'unit_a', objectiveId: 'obj_1', coverageKind: 'teach', depth: 'standard' },
        { unitId: 'unit_b', objectiveId: 'obj_1', coverageKind: 'practice', depth: 'deep' },
      ],
      objectives: [{ id: 'obj_1', title: '独立完成注入' }],
      nodes: [{ id: 'node_x', name: 'SQL 基础', nodeType: 'knowledge' }],
      links: [{ nodeId: 'node_x', objectiveId: 'obj_1' }],
      edges: [],
      teachingOrder: [{ id: 'node_x', name: 'SQL 基础' }],
      declaredHours: 3,
    });
    expect(built.units.map((unit) => unit.id)).toEqual(['unit_ch', 'unit_a', 'unit_b']);
    expect(built.coverageByUnit.get('unit_b')).toEqual([
      { objectiveId: 'obj_1', coverageKind: 'practice', depth: 'deep' },
    ]);
  });

  it('图里同时给出先后关系与推导出的讲授顺序', () => {
    const text = formatOutlineGraph(board);
    expect(text).toContain('SQL 基础 → 联合查询（prerequisite）');
    expect(text).toContain('1. SQL 基础');
    expect(text).toContain('2. 联合查询');
    expect(text).toContain('支撑：obj_1(独立完成注入)');
  });
});

describe('course-outline 提示词模板', () => {
  it('模板存在，且变量都被替换掉', () => {
    const prompts = buildPrompt(PROMPT_IDS.COURSE_OUTLINE, {
      direction: '方向：Web 安全',
      graph: '图：node_x',
      plan: '大纲：unit_a',
      gaps: '- 还差一个条目',
      history: '(这是这一步的第一句话)',
      instruction: '排一份大纲',
    });
    expect(prompts).not.toBeNull();
    expect(prompts?.system).toContain('第五步');
    expect(prompts?.user).toContain('方向：Web 安全');
    expect(prompts?.user).toContain('图：node_x');
    expect(prompts?.user).toContain('大纲：unit_a');
    // A template variable left unsubstituted would be sent to the model as
    // literal `{{...}}`, which reads as an instruction the model then tries to
    // follow.
    expect(prompts?.user).not.toContain('{{');
  });
});
