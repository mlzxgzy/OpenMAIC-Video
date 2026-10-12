/**
 * 第五步「生成课程大纲」的规则层，无模型、无数据库。
 *
 * 这一层要挡住三类静默失败：
 *
 * 1. **整表替换把用户读过的大纲拆掉。** store 的 `setCurriculumUnitCoverage` 是"删掉
 *    全部覆盖再重建"，所以 `collectCoverage` 必须把没被提到的条目原样带过来；少带一
 *    条，那个条目就"不教任何东西"，而响应体看不出来。
 * 2. **store 会抛的东西放进去，整轮回滚。** 章节带角色、条目没角色、父级不是章节——
 *    这些都在规则层丢掉并记账，而不是让 store 抛一次异常带走模型写对的部分。
 * 3. **顺序与已签收的图矛盾。** 图上说 A 先于 B，大纲把 B 排在前面；这条在确认之前就
 *    该报出来，而不是等审核在最后一步报。
 */
import { describe, expect, it } from 'vitest';

import {
  OutlineAnswerError,
  collectCoverage,
  formatOutlinePlan,
  mergeOutlinePatch,
  mergeUnitCoverage,
  outlineFindings,
  outlineGaps,
  outlineOrderConflicts,
  parseOutlineAnswer,
  planUnitWrites,
  sanitizeUnitDraft,
  sanitizeUnitPatch,
  shouldConfirmOutline,
  type OutlineAnswer,
  type OutlineUnitRef,
} from '@/lib/curriculum/design-outline';

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

const unit = (over: Partial<OutlineUnitRef> & { id: string }): OutlineUnitRef => ({
  title: over.id,
  unitType: 'item',
  unitRole: 'lecture',
  parentId: null,
  orderIndex: 0,
  hours: 1,
  ...over,
});

describe('parseOutlineAnswer — 模型能说什么', () => {
  it('章节不能带教学角色，条目必须带', () => {
    const chapter = parseOutlineAnswer(
      JSON.stringify({
        added: [{ title: '第一章', unitType: 'chapter', unitRole: 'lecture' }],
      }),
    );
    expect(chapter.added).toHaveLength(0);
    expect(chapter.rejectedRefs.join()).toContain('章节却带了教学角色');

    const item = parseOutlineAnswer(
      JSON.stringify({ added: [{ title: '目一', unitType: 'item' }] }),
    );
    expect(item.added).toHaveLength(0);
    expect(item.rejectedRefs.join()).toContain('是条目却没有角色');
  });

  it('缺省类型是条目：误标的章节要能立刻被告出来', () => {
    const parsed = parseOutlineAnswer(
      JSON.stringify({ added: [{ title: '没写类型', unitRole: 'practice' }] }),
    );
    expect(parsed.added[0]?.unitType).toBe('item');
  });

  it('挂在章节上的覆盖被丢掉并说明，单元本身保留', () => {
    const parsed = parseOutlineAnswer(
      JSON.stringify({
        added: [
          {
            ref: 'ch1',
            title: '第一章',
            unitType: 'chapter',
            coverage: [{ objectiveRef: 'obj_1', coverageKind: 'teach' }],
          },
        ],
      }),
    );
    // 丢的是那条覆盖，不是整个单元：单元是作者要的内容，缺覆盖是**看得见**的状态。
    expect(parsed.added).toHaveLength(1);
    expect(parsed.added[0]?.coverage).toEqual([]);
    expect(parsed.rejectedRefs.join()).toContain('不能承载教学覆盖');
  });

  it('覆盖的深度缺省是 standard，类型必须是三种之一', () => {
    const parsed = parseOutlineAnswer(
      JSON.stringify({
        coverage: [
          { ref: 'unit_a', objectiveRef: 'obj_1', coverageKind: 'teach' },
          { ref: 'unit_a', objectiveRef: 'obj_2', coverageKind: 'review' },
        ],
      }),
    );
    expect(parsed.coverage).toEqual([
      { ref: 'unit_a', objectiveRef: 'obj_1', coverageKind: 'teach', depth: 'standard' },
    ]);
    expect(parsed.rejectedRefs.join()).toContain('不是 teach/practice/assess');
  });

  it('`objectiveRef: null` 是清空一个条目的覆盖，不是缺字段', () => {
    const parsed = parseOutlineAnswer(
      JSON.stringify({ coverage: [{ ref: 'unit_a', objectiveRef: null }] }),
    );
    expect(parsed.coverage).toEqual([{ ref: 'unit_a', objectiveRef: null }]);
  });

  it('教学设计与题目不在这一步：写了也被丢掉并说明', () => {
    const parsed = parseOutlineAnswer(
      JSON.stringify({ pages: [{ title: 'x' }], questions: [], added: [] }),
    );
    expect(parsed.rejectedRefs.join()).toContain('不在这一步的范围内');
  });

  it('什么都没改的 patch 被丢弃，它不算一次改动', () => {
    expect(sanitizeUnitPatch({ ref: 'unit_a' }).patch).toBeNull();
    expect(sanitizeUnitPatch({ ref: 'unit_a' }).reason).toContain('改动是空的');
  });

  it('返回不了 JSON 时抛错，调用方据此回 502', () => {
    expect(() => parseOutlineAnswer('我觉得可以')).toThrow(OutlineAnswerError);
  });

  it('顺序必须是非负整数，学时必须是非负数', () => {
    expect(sanitizeUnitDraft({ title: 'x', unitRole: 'lecture', order: 1.5 }).reason).toContain(
      '顺序不是非负整数',
    );
    expect(sanitizeUnitDraft({ title: 'x', unitRole: 'lecture', hours: -1 }).reason).toContain(
      '学时不是非负数',
    );
  });
});

describe('mergeOutlinePatch — 只动被指名的单元', () => {
  const current = [unit({ id: 'unit_a' }), unit({ id: 'unit_b' })];

  it('未命中的 ref 一律丢弃并记账', () => {
    const merged = mergeOutlinePatch(
      current,
      answer({ removed: ['nope'], updated: [{ ref: 'nope' }] }),
    );
    expect(merged.removed.size).toBe(0);
    expect(merged.patches.size).toBe(0);
    expect(merged.unmatchedRefs).toEqual(['nope', 'nope']);
  });

  it('删除优先：同一轮里又删又改的单元不会被改回来', () => {
    const merged = mergeOutlinePatch(
      current,
      answer({ removed: ['unit_a'], updated: [{ ref: 'unit_a', title: '改名' }] }),
    );
    expect(merged.removed.has('unit_a')).toBe(true);
    expect(merged.patches.has('unit_a')).toBe(false);
  });

  it('同一条只认最后一次 patch', () => {
    const merged = mergeOutlinePatch(
      current,
      answer({
        updated: [
          { ref: 'unit_a', title: '第一版' },
          { ref: 'unit_a', title: '第二版' },
        ],
      }),
    );
    expect(merged.patches.get('unit_a')?.title).toBe('第二版');
  });
});

describe('planUnitWrites — 章、节、目一次给全', () => {
  it('父级可以先在数组后面出现：父级总排在子级之前', () => {
    const planned = planUnitWrites({
      current: [],
      removed: new Set(),
      drafts: sanitizeDrafts([
        { ref: 'i1', title: '目一', unitType: 'item', unitRole: 'lecture', parentRef: 's1' },
        { ref: 's1', title: '第一节', unitType: 'chapter', parentRef: 'ch1' },
        { ref: 'ch1', title: '第一章', unitType: 'chapter' },
      ]),
      patches: new Map(),
    });
    expect(planned.unmatchedRefs).toEqual([]);
    expect(planned.creates.map((create) => create.draft.ref)).toEqual(['ch1', 's1', 'i1']);
    expect(planned.creates[1]?.parentDraftRef).toBe('ch1');
    expect(planned.creates[2]?.parentDraftRef).toBe('s1');
  });

  it('父级必须是章节：条目不能挂在条目下', () => {
    const planned = planUnitWrites({
      current: [unit({ id: 'unit_item', title: '已有的目' })],
      removed: new Set(),
      drafts: sanitizeDrafts([
        { title: '新目', unitType: 'item', unitRole: 'lecture', parentRef: 'unit_item' },
      ]),
      patches: new Map(),
    });
    expect(planned.creates).toHaveLength(0);
    expect(planned.unmatchedRefs.join()).toContain('父级不是章节');
  });

  it('父级是本轮删掉的单元时拒写，否则外键会让整轮回滚', () => {
    const planned = planUnitWrites({
      current: [unit({ id: 'unit_ch', title: '要删的章', unitType: 'chapter', unitRole: null })],
      removed: new Set(['unit_ch']),
      drafts: sanitizeDrafts([
        { title: '新目', unitType: 'item', unitRole: 'lecture', parentRef: 'unit_ch' },
      ]),
      patches: new Map(),
    });
    expect(planned.creates).toHaveLength(0);
    expect(planned.unmatchedRefs.join()).toContain('这一轮被删掉了');
  });

  it('顺序缺省是追加：接在同一父级现有兄弟之后', () => {
    const planned = planUnitWrites({
      current: [
        unit({ id: 'unit_a', parentId: 'ch', orderIndex: 0 }),
        unit({ id: 'unit_b', parentId: 'ch', orderIndex: 3 }),
      ],
      removed: new Set(),
      drafts: sanitizeDrafts([
        { title: '新目', unitType: 'item', unitRole: 'lecture', parentRef: 'ch' },
        { title: '再一个', unitType: 'item', unitRole: 'lecture', parentRef: 'ch' },
      ]),
      patches: new Map(),
    });
    // `ch` 不在 current 里，所以父级解析失败——这里用它的 id 却不存在，两个都应记账。
    expect(planned.creates).toHaveLength(0);
    expect(planned.unmatchedRefs).toHaveLength(2);
  });

  it('顺序缺省追加到同一父级的现有兄弟之后', () => {
    const planned = planUnitWrites({
      current: [
        unit({ id: 'ch', title: '章', unitType: 'chapter', unitRole: null }),
        unit({ id: 'unit_a', parentId: 'ch', orderIndex: 0 }),
        unit({ id: 'unit_b', parentId: 'ch', orderIndex: 3 }),
      ],
      removed: new Set(),
      drafts: sanitizeDrafts([
        { title: '新目', unitType: 'item', unitRole: 'lecture', parentRef: 'ch' },
        { title: '再一个', unitType: 'item', unitRole: 'lecture', parentRef: 'ch' },
      ]),
      patches: new Map(),
    });
    expect(planned.creates.map((create) => create.orderIndex)).toEqual([4, 5]);
  });

  it('draft 之间互相指父级是环：环上的丢掉，环外的照写', () => {
    const planned = planUnitWrites({
      current: [],
      removed: new Set(),
      drafts: sanitizeDrafts([
        { ref: 'a', title: 'A', unitType: 'chapter', parentRef: 'b' },
        { ref: 'b', title: 'B', unitType: 'chapter', parentRef: 'a' },
        { ref: 'c', title: 'C', unitType: 'chapter' },
      ]),
      patches: new Map(),
    });
    expect(planned.unmatchedRefs.join()).toContain('父级引用成环');
    expect(planned.creates.map((create) => create.draft.ref)).toEqual(['c']);
  });

  it('已有的条目可以移到本轮新建的节下面', () => {
    const planned = planUnitWrites({
      current: [unit({ id: 'unit_a', parentId: null })],
      removed: new Set(),
      drafts: sanitizeDrafts([{ ref: 'ch1', title: '第一章', unitType: 'chapter' }]),
      patches: new Map([['unit_a', { ref: 'unit_a', parentRef: 'ch1' }]]),
    });
    expect(planned.updates).toHaveLength(1);
    expect(planned.updates[0]?.parentDraftRef).toBe('ch1');
  });

  it('章节不能通过 patch 拿到教学角色', () => {
    const planned = planUnitWrites({
      current: [unit({ id: 'unit_ch', title: '章', unitType: 'chapter', unitRole: null })],
      removed: new Set(),
      drafts: [],
      patches: new Map([['unit_ch', { ref: 'unit_ch', unitRole: 'lecture' }]]),
    });
    expect(planned.updates).toHaveLength(0);
    expect(planned.unmatchedRefs.join()).toContain('章节不能有教学角色');
  });
});

describe('mergeUnitCoverage / collectCoverage — 没提到的条目必须原样带过来', () => {
  const coverageByUnit = new Map([
    [
      'unit_a',
      [{ objectiveId: 'obj_1', coverageKind: 'teach' as const, depth: 'standard' as const }],
    ],
    [
      'unit_b',
      [{ objectiveId: 'obj_2', coverageKind: 'practice' as const, depth: 'deep' as const }],
    ],
  ]);

  const merge = (proposed: OutlineAnswer['coverage'], removed = new Set<string>()) =>
    mergeUnitCoverage({
      coverageByUnit,
      knownUnitIds: new Set(['unit_a', 'unit_b', 'unit_c']),
      knownObjectiveIds: new Set(['obj_1', 'obj_2']),
      unitTypeOf: (unitId) => (unitId === 'unit_c' ? 'chapter' : 'item'),
      removed,
      proposed,
    });

  it('只替换被指名的条目，其余的原样保留', () => {
    const { replace } = merge([{ ref: 'unit_a', objectiveRef: 'obj_2', coverageKind: 'teach' }]);
    const ledger = collectCoverage(coverageByUnit, replace, new Set());
    expect(
      ledger.map((row) => `${row.unitId}:${row.objectiveId}:${row.coverageKind}`).sort(),
    ).toEqual(['unit_a:obj_2:teach', 'unit_b:obj_2:practice']);
  });

  it('清空一个条目只清它自己', () => {
    const { replace } = merge([{ ref: 'unit_a', objectiveRef: null }]);
    const ledger = collectCoverage(coverageByUnit, replace, new Set());
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.unitId).toBe('unit_b');
  });

  it('指向不存在目标的覆盖被丢掉并记账', () => {
    const { replace, unmatchedRefs } = merge([
      { ref: 'unit_a', objectiveRef: 'obj_nope', coverageKind: 'teach' },
    ]);
    expect(replace.size).toBe(0);
    expect(unmatchedRefs).toEqual(['unit_a→obj_nope']);
  });

  it('章节上的覆盖被丢掉并记账', () => {
    const { replace, unmatchedRefs } = merge([
      { ref: 'unit_c', objectiveRef: 'obj_1', coverageKind: 'teach' },
    ]);
    expect(replace.size).toBe(0);
    expect(unmatchedRefs.join()).toContain('章节不能承载覆盖');
  });

  it('被删除的条目的覆盖不会带回来', () => {
    const { replace } = merge([], new Set(['unit_a']));
    const ledger = collectCoverage(coverageByUnit, replace, new Set(['unit_a']));
    expect(ledger.map((row) => row.unitId)).toEqual(['unit_b']);
  });

  it('同一条目的 (目标, 类型) 重复只算一次', () => {
    const { replace } = merge([
      { ref: 'unit_a', objectiveRef: 'obj_2', coverageKind: 'teach' },
      { ref: 'unit_a', objectiveRef: 'obj_2', coverageKind: 'teach', depth: 'deep' },
    ]);
    expect(replace.get('unit_a')).toHaveLength(1);
    expect(replace.get('unit_a')?.[0]?.depth).toBe('standard');
  });
});

describe('outlineGaps — 门禁的可执行说法', () => {
  const objectives = [
    { id: 'obj_1', title: '独立完成注入' },
    { id: 'obj_2', title: '写出 Writeup' },
  ];

  it('一份大纲都没有', () => {
    const gaps = outlineGaps({ units: [], coverage: [], objectives });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]?.text).toContain('还没有大纲');
  });

  it('只有章节没有条目：门禁不查，但审核会报，所以这里也说', () => {
    const gaps = outlineGaps({
      units: [unit({ id: 'ch', title: '第一章', unitType: 'chapter', unitRole: null })],
      coverage: [],
      objectives,
    });
    expect(gaps.map((gap) => gap.text).join()).toContain('只有章节没有条目');
  });

  it('条目没有覆盖、目标没人讲授、章节带覆盖，各报一次', () => {
    const gaps = outlineGaps({
      units: [
        unit({ id: 'ch', title: '第一章', unitType: 'chapter', unitRole: null }),
        unit({ id: 'unit_a', title: '目一' }),
      ],
      coverage: [{ unitId: 'ch', objectiveId: 'obj_1', coverageKind: 'teach', depth: 'standard' }],
      objectives,
    });
    const text = gaps.map((gap) => gap.text).join('\n');
    expect(text).toContain('条目「目一」不覆盖任何学习目标');
    expect(text).toContain('学习目标「独立完成注入」还没有被任何条目讲授');
    expect(text).toContain('是章节却承载了教学覆盖');
  });

  it('覆盖了目标但只有 practice 不算讲授', () => {
    const gaps = outlineGaps({
      units: [unit({ id: 'unit_a', title: '目一' })],
      coverage: [
        { unitId: 'unit_a', objectiveId: 'obj_1', coverageKind: 'practice', depth: 'standard' },
        { unitId: 'unit_a', objectiveId: 'obj_2', coverageKind: 'teach', depth: 'standard' },
      ],
      objectives,
    });
    expect(gaps.map((gap) => gap.text).join()).toContain('独立完成注入');
  });

  it('顺序冲突也算缺口', () => {
    const gaps = outlineGaps({
      units: [unit({ id: 'unit_a', title: '目一' })],
      coverage: [
        { unitId: 'unit_a', objectiveId: 'obj_1', coverageKind: 'teach', depth: 'standard' },
      ],
      objectives: [objectives[0]!],
      orderConflicts: [
        { refId: 'dep_1', sourceId: 'obj_1', targetId: 'obj_2', message: '顺序反了' },
      ],
    });
    expect(gaps.map((gap) => gap.text)).toContain('顺序反了');
  });
});

describe('outlineOrderConflicts — 图上的先后关系第一次有了读方', () => {
  const items = [
    { id: 'unit_first', orderIndex: 0 },
    { id: 'unit_second', orderIndex: 1 },
  ];
  const teachesByItem = new Map([
    ['unit_first', ['obj_a']],
    ['unit_second', ['obj_b']],
  ]);
  const labelOf = (id: string) => `标签:${id}`;

  it('节点级先后关系折到条目上：顺序对了就不报', () => {
    const conflicts = outlineOrderConflicts({
      items,
      teachesByItem,
      objectivesByNode: new Map([
        ['node_a', ['obj_a']],
        ['node_b', ['obj_b']],
      ]),
      edges: [
        {
          id: 'dep_1',
          sourceId: 'node_a',
          sourceKind: 'node',
          targetId: 'node_b',
          targetKind: 'node',
          edgeType: 'prerequisite',
        },
      ],
      labelOf,
    });
    expect(conflicts).toEqual([]);
  });

  it('顺序反了就报，并带上那条边的 id', () => {
    const conflicts = outlineOrderConflicts({
      items,
      teachesByItem,
      objectivesByNode: new Map([
        ['node_a', ['obj_a']],
        ['node_b', ['obj_b']],
      ]),
      edges: [
        {
          id: 'dep_1',
          sourceId: 'node_b',
          sourceKind: 'node',
          targetId: 'node_a',
          targetKind: 'node',
          edgeType: 'prerequisite',
        },
      ],
      labelOf,
    });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.refId).toBe('dep_1');
    expect(conflicts[0]?.message).toContain('知识/技能点');
    expect(conflicts[0]?.message).toContain('标签:node_a');
  });

  it('`composes` / `supports` 不是顺序主张：互相支撑不等于谁先谁后', () => {
    // `related` is a *unit* edge type and has no place in the knowledge graph, so
    // the two exempt knowledge-level types are the ones worth pinning.
    for (const edgeType of ['composes', 'supports'] as const) {
      const conflicts = outlineOrderConflicts({
        items,
        teachesByItem,
        objectivesByNode: new Map([
          ['node_a', ['obj_a']],
          ['node_b', ['obj_b']],
        ]),
        edges: [
          {
            id: 'dep_1',
            sourceId: 'node_b',
            sourceKind: 'node',
            targetId: 'node_a',
            targetKind: 'node',
            edgeType,
          },
        ],
        labelOf,
      });
      expect(conflicts).toEqual([]);
    }
  });

  it('没有条目的目标不参与比较：它还没有交付位置', () => {
    const conflicts = outlineOrderConflicts({
      items,
      teachesByItem,
      objectivesByNode: new Map([
        ['node_a', ['obj_a']],
        ['node_b', ['obj_missing']],
      ]),
      edges: [
        {
          id: 'dep_1',
          sourceId: 'node_b',
          sourceKind: 'node',
          targetId: 'node_a',
          targetKind: 'node',
          edgeType: 'prerequisite',
        },
      ],
      labelOf,
    });
    expect(conflicts).toEqual([]);
  });
});

describe('outlineFindings — 提醒而不是缺口', () => {
  it('学时对不上时提醒，但不拦签收', () => {
    const findings = outlineFindings({
      items: [{ hours: 1 }, { hours: 2 }],
      declaredHours: 54,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.text).toContain('3 学时');
  });

  it('对得上就不提', () => {
    expect(outlineFindings({ items: [{ hours: 2 }], declaredHours: 2 })).toEqual([]);
  });
});

describe('shouldConfirmOutline — 签收是有底线的', () => {
  const base = {
    confirmRequested: true,
    userTurns: 2,
    itemCount: 3,
    gaps: [],
    changedAnything: true,
  };

  it('第一句话不能确认', () => {
    expect(shouldConfirmOutline({ ...base, userTurns: 1 })).toBe(false);
  });

  it('这一轮什么都没改不能确认', () => {
    expect(shouldConfirmOutline({ ...base, changedAnything: false })).toBe(false);
  });

  it('有缺口不能确认', () => {
    expect(shouldConfirmOutline({ ...base, gaps: ['少了点什么'] })).toBe(false);
  });

  it('一个条目都没有不能确认：只有章节的大纲产出不了任何东西', () => {
    expect(shouldConfirmOutline({ ...base, itemCount: 0 })).toBe(false);
  });

  it('模型没请求确认就不能确认', () => {
    expect(shouldConfirmOutline({ ...base, confirmRequested: false })).toBe(false);
  });

  it('底线都满足才确认', () => {
    expect(shouldConfirmOutline(base)).toBe(true);
  });
});

describe('formatOutlinePlan — 层级要看得出来', () => {
  it('缩进表达层级，条目显示角色、学时与覆盖', () => {
    const text = formatOutlinePlan({
      units: [
        unit({ id: 'ch', title: '第一章', unitType: 'chapter', unitRole: null, orderIndex: 0 }),
        unit({ id: 'unit_a', title: '目一', parentId: 'ch', orderIndex: 0 }),
        unit({
          id: 'unit_b',
          title: '目二（练）',
          parentId: 'ch',
          orderIndex: 1,
          unitRole: 'practice',
        }),
      ],
      coverage: [
        { unitId: 'unit_a', objectiveId: 'obj_1', coverageKind: 'teach', depth: 'standard' },
      ],
      objectives: [{ id: 'obj_1', title: '独立完成注入' }],
    });
    expect(text).toContain('ref=ch 第一章');
    expect(text).toContain('  - ref=unit_a 目一（讲授） 1 学时');
    expect(text).toContain('覆盖：讲授 obj_1(独立完成注入)');
    expect(text).toContain('目二（练）（练习）');
    expect(text).toContain('覆盖：无（这是缺口');
  });
});

/** Small helper: run drafts through the same sanitiser the parser uses. */
function sanitizeDrafts(raw: unknown[]) {
  return raw.map((entry) => {
    const { draft } = sanitizeUnitDraft(entry);
    if (!draft) throw new Error(`测试数据不合法：${JSON.stringify(entry)}`);
    return draft;
  });
}
