/**
 * `resolveKnowledgeTurn` — the deterministic half of a step-3 turn, no model.
 *
 * This is where step 3's most consequential decision lives: the store replaces a
 * task's whole link set, so the turn has to pass **every** link, not just the ones
 * the model named. A regression here does not fail a test loudly — it silently
 * deletes the parts of the graph the user never mentioned, and the graph only
 * breaks later at the outline phase. So the tests below assert on the whole set.
 */
import { describe, expect, it } from 'vitest';

import type { KnowledgeAnswer } from '@/lib/curriculum/design-knowledge';
import { resolveKnowledgeTurn, type KnowledgeBoard } from '@/lib/server/curriculum/knowledge-step';

const board: KnowledgeBoard = {
  nodes: [
    { id: 'node_a', name: 'SQL 查询与参数化', nodeType: 'knowledge' },
    { id: 'node_b', name: '联合查询读数据', nodeType: 'skill' },
    { id: 'node_c', name: '布尔盲注', nodeType: 'skill' },
  ],
  objectives: [
    { id: 'obj_1', title: '独立完成 SQL 注入并读取 flag' },
    { id: 'obj_2', title: '完整写出 Writeup' },
  ],
  linksByNode: new Map([
    ['node_a', [{ objectiveId: 'obj_1', supportLevel: 'primary' }]],
    ['node_b', [{ objectiveId: 'obj_1', supportLevel: 'primary' }]],
  ]),
};

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

const pairs = (links: readonly { nodeId: string; objectiveId: string }[]) =>
  links.map((link) => `${link.nodeId}→${link.objectiveId}`).sort();

describe('resolveKnowledgeTurn — the link set it hands the store', () => {
  it('carries over every node the turn did not name', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({ links: [{ ref: 'node_c', objectiveRef: 'obj_1' }] }),
      board,
      history: [{ role: 'user', content: '补一个盲注节点' }],
    });
    // node_a and node_b keep their links. Sending only node_c's would have wiped
    // the other two — the failure this whole function exists to prevent.
    expect(pairs(result.links)).toEqual(['node_a→obj_1', 'node_b→obj_1', 'node_c→obj_1']);
  });

  it('replaces a named node whole set, not just the link added', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({ links: [{ ref: 'node_a', objectiveRef: 'obj_2' }] }),
      board,
      history: [{ role: 'user', content: '参数化那条其实支撑的是写 Writeup' }],
    });
    const forA = result.links.filter((link) => link.nodeId === 'node_a');
    expect(pairs(forA)).toEqual(['node_a→obj_2']);
  });

  it('empties a node on an explicit clear and keeps the rest', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({ links: [{ ref: 'node_b', objectiveRef: null }] }),
      board,
      history: [{ role: 'user', content: '联合查询那条挂错了，摘掉' }],
    });
    expect(pairs(result.links)).toEqual(['node_a→obj_1']);
    expect(result.changedLinks).toBe(true);
    // node_b is now a hole, so the turn may not confirm.
    expect(result.gaps.some((gap) => gap.text.includes('联合查询读数据'))).toBe(true);
  });

  it('drops a link to an outcome that does not exist and says so', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({ links: [{ ref: 'node_c', objectiveRef: 'obj_typo' }] }),
      board,
      history: [{ role: 'user', content: '给盲注挂个目标' }],
    });
    expect(result.unmatchedRefs).toContain('node_c→obj_typo');
    expect(pairs(result.links)).toEqual(['node_a→obj_1', 'node_b→obj_1']);
  });

  it('gives a new node the links it declared', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({
        added: [
          {
            name: 'Writeup 结构',
            nodeType: 'skill',
            summary: null,
            difficulty: null,
            objectiveRefs: [{ objectiveRef: 'obj_2', supportLevel: 'primary' }],
          },
        ],
      }),
      board,
      history: [{ role: 'user', content: '补一个写 writeup 的节点' }],
    });
    // The stored set cannot contain the draft (no id yet); the route adds it from
    // `draftLinksOf`. What this function guarantees is that nothing was lost.
    expect(pairs(result.links)).toEqual(['node_a→obj_1', 'node_b→obj_1']);
    expect(result.changedLinks).toBe(true);
    // obj_2 is now supported, but node_c was already unlinked in the board — the
    // turn fixed one end and the other end is still a hole. The gap names it in
    // words, because a draft's placeholder has no id to point at.
    expect(result.gaps.map((gap) => gap.text)).toEqual([expect.stringContaining('布尔盲注')]);
  });

  it('removes a node and its links together', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({ removed: ['node_b'] }),
      board,
      history: [{ role: 'user', content: '联合查询那条不要了' }],
    });
    expect(pairs(result.links)).toEqual(['node_a→obj_1']);
    expect(result.removed.has('node_b')).toBe(true);
  });
});

describe('resolveKnowledgeTurn — gaps and confirmation', () => {
  it('reports an outcome with nothing behind it', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({
        links: [
          { ref: 'node_a', objectiveRef: 'obj_1' },
          { ref: 'node_b', objectiveRef: 'obj_1' },
          { ref: 'node_c', objectiveRef: 'obj_1' },
        ],
      }),
      board,
      history: [{ role: 'user', content: '都挂到第一个目标' }],
    });
    expect(result.gaps.map((gap) => gap.ref)).toEqual(['obj_2']);
  });

  it('confirms only when the graph is connected at both ends', () => {
    const result = resolveKnowledgeTurn({
      answer: answer({
        links: [
          { ref: 'node_a', objectiveRef: 'obj_1' },
          { ref: 'node_b', objectiveRef: 'obj_1' },
          { ref: 'node_c', objectiveRef: 'obj_1' },
          { ref: 'node_a', objectiveRef: 'obj_2' },
        ],
        confirmRequested: true,
      }),
      board,
      history: [{ role: 'user', content: '可以了' }],
    });
    expect(result.gaps).toEqual([]);
    expect(result.confirmRequested).toBe(true);
  });

  it('refuses confirmation the first turn, and a turn that changed nothing', () => {
    const first = resolveKnowledgeTurn({
      answer: answer({ confirmRequested: true, updated: [{ ref: 'node_a', name: 'A' }] }),
      board,
      history: [],
    });
    expect(first.confirmRequested).toBe(false);

    const idle = resolveKnowledgeTurn({
      answer: answer({ confirmRequested: true }),
      board,
      history: [{ role: 'user', content: '可以了' }],
    });
    expect(idle.confirmRequested).toBe(false);
    expect(idle.changedLinks).toBe(false);
  });

  it('counts a draft as a node, so the turn that builds the first graph can confirm', () => {
    const empty: KnowledgeBoard = {
      nodes: [],
      objectives: [{ id: 'obj_1', title: '独立解题' }],
      linksByNode: new Map(),
    };
    const result = resolveKnowledgeTurn({
      answer: answer({
        added: [
          {
            name: '栈布局',
            nodeType: 'knowledge',
            summary: null,
            difficulty: null,
            objectiveRefs: [{ objectiveRef: 'obj_1' }],
          },
        ],
        confirmRequested: true,
      }),
      board: empty,
      history: [{ role: 'user', content: '拆第一个知识点' }],
    });
    expect(result.gaps).toEqual([]);
    expect(result.confirmRequested).toBe(true);
  });
});
