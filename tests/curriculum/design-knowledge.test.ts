/**
 * `lib/curriculum/design-knowledge.ts` — the step-3 rules, with no model and no
 * database.
 *
 * These are the tests that pin the decisions the file's header argues for, because
 * each of them is a decision a reasonable implementer would get wrong:
 *
 * - **Links merge per node, never per task.** A model turn that re-links one node
 *   must not delete another node's links. That is the failure that makes a graph
 *   look fine and break at the outline phase, so it is tested on the merge
 *   function rather than left to the route.
 * - **Deletions win** over both patches and links in the same turn.
 * - **An unmatched ref changes nothing**, and is accounted for.
 * - **Chapters and units are out of scope**: a model that volunteers them gets a
 *   said-out-loud rejection, not a silent drop.
 * - **A node with no link is a gap, not a refusal**; a link to a goal that does
 *   not exist is refused and logged.
 * - **Confirming needs a real change and a gap-free graph**, and a graph is
 *   gap-free only when it is connected at *both* ends.
 */
import { describe, expect, it } from 'vitest';

import type { CurriculumSupportLevel } from '@/lib/curriculum/design-types';

import {
  KnowledgeAnswerError,
  formatKnowledgeList,
  knowledgeGaps,
  knowledgeGapsOfRecords,
  mergeKnowledgePatch,
  mergeNodeLinks,
  parseKnowledgeAnswer,
  sanitizeNodeDraft,
  sanitizeNodePatch,
  shouldConfirmKnowledge,
  type KnowledgeAnswer,
} from '@/lib/curriculum/design-knowledge';

const node = (id: string, name: string) => ({ id, name, nodeType: 'knowledge' as const });
const objective = (id: string, title: string) => ({ id, title });

function answer(over: Partial<KnowledgeAnswer> = {}): KnowledgeAnswer {
  return {
    message: '',
    added: [],
    updated: [],
    removed: [],
    links: [],
    confirmRequested: false,
    rejectedRefs: [],
    ...over,
  };
}

const linksOf = (
  rows: readonly { nodeId: string; objectiveId: string; supportLevel: CurriculumSupportLevel }[],
) => new Map(rows.map((r) => [r.nodeId, rows]));

describe('parseKnowledgeAnswer', () => {
  it('reads a node with its own links', () => {
    const parsed = parseKnowledgeAnswer(
      JSON.stringify({
        message: '先拆了 3 个知识点。',
        added: [
          {
            name: 'SQL 注入原理',
            nodeType: 'knowledge',
            summary: '拼接查询导致注入',
            objectiveRefs: [{ objectiveRef: 'obj_1', supportLevel: 'primary' }],
          },
        ],
        confirm: false,
      }),
    );
    expect(parsed.added).toHaveLength(1);
    expect(parsed.added[0]).toMatchObject({
      name: 'SQL 注入原理',
      nodeType: 'knowledge',
      summary: '拼接查询导致注入',
    });
    expect(parsed.added[0].objectiveRefs).toEqual([
      { objectiveRef: 'obj_1', supportLevel: 'primary' },
    ]);
    expect(parsed.rejectedRefs).toEqual([]);
  });

  it('unwraps a fenced block and rejects text that is not an object', () => {
    expect(parseKnowledgeAnswer('```json\n{"added":[]}\n```').added).toEqual([]);
    expect(() => parseKnowledgeAnswer('这是我的答案，没有 JSON')).toThrow(KnowledgeAnswerError);
  });

  it('says out loud that chapters and units belong to a later step', () => {
    const parsed = parseKnowledgeAnswer(
      JSON.stringify({ added: [], chapters: [{ name: '第二章 Web' }], units: [] }),
    );
    expect(parsed.rejectedRefs.some((line) => line.includes('chapters'))).toBe(true);
    // Nothing about the chapter reached the answer: step 4 arranges the outline.
    expect(parsed).not.toHaveProperty('chapters');
  });

  it('drops a node with no name, and says which one', () => {
    const parsed = parseKnowledgeAnswer(
      JSON.stringify({ added: [{ nodeType: 'skill' }, { name: '  ' }] }),
    );
    expect(parsed.added).toEqual([]);
    expect(parsed.rejectedRefs.filter((line) => line.includes('名称')).length).toBe(2);
  });

  it('drops a link with no goal, and keeps the node it belongs to', () => {
    const parsed = parseKnowledgeAnswer(
      JSON.stringify({
        added: [{ name: '抓包分析', objectiveRefs: [{ supportLevel: 'primary' }] }],
      }),
    );
    expect(parsed.added).toHaveLength(1);
    expect(parsed.added[0].objectiveRefs).toEqual([]);
    expect(parsed.rejectedRefs.some((line) => line.includes('目标引用'))).toBe(true);
  });

  it('rejects a bad support level rather than defaulting it, and keeps the node', () => {
    const parsed = parseKnowledgeAnswer(
      JSON.stringify({
        added: [{ name: 'X', objectiveRefs: [{ objectiveRef: 'obj_1', supportLevel: 'strong' }] }],
      }),
    );
    // The link is dropped, not coerced to `primary`: defaulting would attach the
    // node to a goal with a support level the model did not choose, and the
    // audit reads `secondary` as "may never be named". A wrong enum stored here
    // would also be a CHECK violation, i.e. a 500, at write time.
    expect(parsed.added).toHaveLength(1);
    expect(parsed.added[0].objectiveRefs).toEqual([]);
    expect(parsed.rejectedRefs.some((line) => line.includes('支撑强度'))).toBe(true);
  });

  it('reads removals as bare refs and confirms only on a literal true', () => {
    const parsed = parseKnowledgeAnswer(
      JSON.stringify({ removed: ['node_a', '', 7], confirm: 'yes' }),
    );
    expect(parsed.removed).toEqual(['node_a']);
    expect(parsed.confirmRequested).toBe(false);
  });
});

describe('sanitizeNodeDraft / sanitizeNodePatch', () => {
  it('defaults an untyped node to knowledge, the weaker promise', () => {
    const { draft } = sanitizeNodeDraft({ name: '栈布局' });
    expect(draft?.nodeType).toBe('knowledge');
    expect(draft?.summary).toBeNull();
    expect(draft?.difficulty).toBeNull();
  });

  it('rejects a patch with no fields, so it cannot look like a change', () => {
    expect(sanitizeNodePatch({ ref: 'node_a' }).patch).toBeNull();
    expect(sanitizeNodePatch({ ref: 'node_a', summary: '' }).patch).toEqual({
      ref: 'node_a',
      summary: null,
    });
  });

  it('accepts clearing the difficulty but not clearing the name', () => {
    expect(sanitizeNodePatch({ ref: 'node_a', difficulty: null }).patch).toEqual({
      ref: 'node_a',
      difficulty: null,
    });
    expect(sanitizeNodePatch({ ref: 'node_a', name: '' }).patch).toBeNull();
  });
});

describe('mergeKnowledgePatch', () => {
  const current = [node('node_a', 'A'), node('node_b', 'B')];

  it('applies a named patch and ignores one aimed at a node that is not there', () => {
    const { patches, unmatchedRefs } = mergeKnowledgePatch(
      current,
      answer({
        updated: [
          { ref: 'node_a', name: 'A（改）' },
          { ref: 'node_zz', name: '不存在' },
        ],
      }),
    );
    expect([...patches.keys()]).toEqual(['node_a']);
    expect(unmatchedRefs).toEqual(['node_zz']);
  });

  it('lets a deletion win over a patch to the same node', () => {
    const { patches, removed } = mergeKnowledgePatch(
      current,
      answer({ removed: ['node_a'], updated: [{ ref: 'node_a', name: '复活' }] }),
    );
    expect(removed.has('node_a')).toBe(true);
    expect(patches.has('node_a')).toBe(false);
  });

  it('takes the last patch for the same node', () => {
    const { patches } = mergeKnowledgePatch(
      current,
      answer({
        updated: [
          { ref: 'node_b', summary: '第一版' },
          { ref: 'node_b', summary: '第二版' },
        ],
      }),
    );
    expect(patches.get('node_b')?.summary).toBe('第二版');
  });
});

describe('mergeNodeLinks', () => {
  const knownNodeIds = new Set(['node_a', 'node_b']);
  const knownObjectiveIds = new Set(['obj_1', 'obj_2']);

  it('replaces only the nodes the turn named', () => {
    const { replace } = mergeNodeLinks({
      linksByNode: new Map([
        ['node_a', [{ objectiveId: 'obj_1', supportLevel: 'primary' }]],
        ['node_b', [{ objectiveId: 'obj_2', supportLevel: 'primary' }]],
      ]),
      knownNodeIds,
      knownObjectiveIds,
      removed: new Set(),
      proposed: [{ ref: 'node_a', objectiveRef: 'obj_2' }],
    });
    // node_b is absent from `replace`, which is what keeps its link intact. The
    // whole-task replace this replaces would have deleted it.
    expect([...replace.keys()]).toEqual(['node_a']);
    expect(replace.get('node_a')).toEqual([
      { objectiveId: 'obj_2', supportLevel: 'primary', note: null },
    ]);
  });

  it('defaults the support level to primary', () => {
    const { replace } = mergeNodeLinks({
      linksByNode: new Map(),
      knownNodeIds,
      knownObjectiveIds,
      removed: new Set(),
      proposed: [{ ref: 'node_a', objectiveRef: 'obj_1' }],
    });
    expect(replace.get('node_a')?.[0].supportLevel).toBe('primary');
  });

  it('refuses a link to a goal that does not exist, and accounts for it', () => {
    const { replace, unmatchedRefs } = mergeNodeLinks({
      linksByNode: new Map(),
      knownNodeIds,
      knownObjectiveIds,
      removed: new Set(),
      proposed: [{ ref: 'node_a', objectiveRef: 'obj_missing' }],
    });
    expect(replace.size).toBe(0);
    expect(unmatchedRefs).toEqual(['node_a→obj_missing']);
  });

  it('collapses the same pair twice, because the pair is the store key', () => {
    const { replace } = mergeNodeLinks({
      linksByNode: new Map(),
      knownNodeIds,
      knownObjectiveIds,
      removed: new Set(),
      proposed: [
        { ref: 'node_a', objectiveRef: 'obj_1' },
        { ref: 'node_a', objectiveRef: 'obj_1', supportLevel: 'secondary' },
      ],
    });
    expect(replace.get('node_a')).toHaveLength(1);
  });

  it('drops a link to a node the same turn deletes', () => {
    const { replace, unmatchedRefs } = mergeNodeLinks({
      linksByNode: new Map(),
      knownNodeIds,
      knownObjectiveIds,
      removed: new Set(['node_b']),
      proposed: [{ ref: 'node_b', objectiveRef: 'obj_1' }],
    });
    expect(replace.size).toBe(0);
    expect(unmatchedRefs).toEqual([]);
  });

  it('empties a node on an explicit clear, because that is how a link comes off', () => {
    const { replace } = mergeNodeLinks({
      linksByNode: new Map([['node_a', [{ objectiveId: 'obj_1', supportLevel: 'primary' }]]]),
      knownNodeIds,
      knownObjectiveIds,
      removed: new Set(),
      proposed: [{ ref: 'node_a', objectiveRef: null }],
    });
    // Present but empty, not absent: absent means "untouched", and the author
    // would have no way to take a wrong link back off.
    expect(replace.has('node_a')).toBe(true);
    expect(replace.get('node_a')).toEqual([]);
  });
});

describe('knowledgeGaps', () => {
  it('says what to do when there is no graph at all', () => {
    expect(knowledgeGaps([])[0].text).toContain('从已确认的学习目标反推');
  });

  it('names both ends of a half-connected graph', () => {
    const gaps = knowledgeGaps(
      [node('node_a', 'A')],
      [{ id: 'node_a', name: 'A' }],
      [{ id: 'obj_1', title: '独立解题' }],
    );
    expect(gaps).toHaveLength(2);
    expect(gaps[0].text).toContain('A');
    expect(gaps[0].ref).toBe('node_a');
    expect(gaps[1].text).toContain('独立解题');
    expect(gaps[1].ref).toBe('obj_1');
  });

  it('is empty once every node and every goal has the other', () => {
    const gaps = knowledgeGapsOfRecords(
      [node('node_a', 'A')],
      [{ nodeId: 'node_a', objectiveId: 'obj_1' }],
      [objective('obj_1', '独立解题')],
    );
    expect(gaps).toEqual([]);
  });

  it('reports an unbacked goal even when the nodes are all linked', () => {
    const gaps = knowledgeGapsOfRecords(
      [node('node_a', 'A')],
      [{ nodeId: 'node_a', objectiveId: 'obj_1' }],
      [objective('obj_1', '独立解题'), objective('obj_2', '写 Writeup')],
    );
    expect(gaps.map((gap) => gap.ref)).toEqual(['obj_2']);
  });
});

describe('shouldConfirmKnowledge', () => {
  const clean = knowledgeGapsOfRecords(
    [node('node_a', 'A')],
    [{ nodeId: 'node_a', objectiveId: 'obj_1' }],
    [objective('obj_1', '独立解题')],
  );

  it('accepts a plain agreement after a real change', () => {
    expect(
      shouldConfirmKnowledge({
        confirmRequested: true,
        userTurns: 2,
        nodeCount: 1,
        objectiveCount: 1,
        gaps: clean,
        changedAnything: true,
      }),
    ).toBe(true);
  });

  it('refuses the first user message, an agreement to nothing, and a half-built graph', () => {
    const base = {
      confirmRequested: true,
      nodeCount: 1,
      objectiveCount: 1,
      gaps: clean,
      changedAnything: true,
    };
    expect(shouldConfirmKnowledge({ ...base, userTurns: 1 })).toBe(false);
    expect(shouldConfirmKnowledge({ ...base, userTurns: 2, changedAnything: false })).toBe(false);
    expect(
      shouldConfirmKnowledge({
        ...base,
        userTurns: 2,
        gaps: [{ text: '「A」没有支撑任何学习目标' }],
      }),
    ).toBe(false);
  });

  it('refuses when the model did not ask to confirm', () => {
    expect(
      shouldConfirmKnowledge({
        confirmRequested: false,
        userTurns: 3,
        nodeCount: 1,
        objectiveCount: 1,
        gaps: clean,
        changedAnything: true,
      }),
    ).toBe(false);
  });
});

describe('formatKnowledgeList', () => {
  it('prints the node id, the goal id and a hole the model should fill', () => {
    const text = formatKnowledgeList({
      nodes: [node('node_a', 'A'), node('node_b', 'B')],
      objectives: [objective('obj_1', '独立解题')],
      linksByNode: new Map([['node_a', [{ objectiveId: 'obj_1' }]]]),
    });
    expect(text).toContain('ref=node_a');
    expect(text).toContain('obj_1(独立解题)');
    expect(text).toContain('ref=node_b');
    expect(text).toContain('无（这是缺口');
    expect(text).toContain('obj=obj_1');
  });
});

/** Unused import guard: `linksOf` documents the map shape the merge takes. */
it('the links map is keyed by node id', () => {
  const map = linksOf([
    { nodeId: 'node_a', objectiveId: 'obj_1', supportLevel: 'primary' as const },
  ]);
  expect([...map.keys()]).toEqual(['node_a']);
});
