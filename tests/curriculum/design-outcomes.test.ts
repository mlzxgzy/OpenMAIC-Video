/**
 * 第二步「学习目标与考核标准」的规则层，无模型、无数据库。
 *
 * 这一层回答的是第一步回答不了的那个问题：**当 AI 直接改一份清单而不是一张固定卡片
 * 时，什么是安全的写**。所以用例的重心是三类"静默失败"——
 *
 * 1. **改错行。** 模型指名了一个不存在的 `ref`，改动必须被丢弃而不是落到某一行上。
 *    落在"最近的一行"上不会报错，只会让用户读到一份自己没批准的清单。
 * 2. **重述即改写。** 模型每次回答都会重述整条目标，而清单没有"只写这一格"的安全阀，
 *    所以 `updated` 必须带 `ref`，且无改动的补丁不算改动。
 * 3. **假确认。** 一句"看起来还行"不是签收：没动过清单的轮次、还有缺口的轮次、
 *    用户第一句话，都不能确认。
 */
import { describe, expect, it } from 'vitest';

import {
  OutcomeAnswerError,
  criteriaListOf,
  formatOutcomeList,
  mergeOutcomePatch,
  outcomeGaps,
  outcomeGapsOfRecords,
  parseOutcomeAnswer,
  sanitizeEvidence,
  sanitizeObjective,
  sanitizeOutcomePatch,
  shouldConfirmOutcomes,
  type OutcomeAnswer,
} from '@/lib/curriculum/design-outcomes';
import {
  resolveOutcomesTurn,
  boardOf,
  formatDirectionLine,
} from '@/lib/server/curriculum/outcomes-step';
import type {
  CurriculumEvidenceRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';

function answer(overrides: Partial<OutcomeAnswer> = {}): OutcomeAnswer {
  return {
    message: '',
    added: [],
    updated: [],
    removed: [],
    evidence: [],
    confirmRequested: false,
    rejectedRefs: [],
    ...overrides,
  };
}

const COMPLETE_DRAFT = {
  title: '能在 Web 靶场中独立完成 SQL 注入并读取 flag',
  objectiveType: 'skill' as const,
  expectedBehavior: '在 Docker 靶场中判断注入点，手工构造注入语句并读出指定数据',
  minCriteria: ['识别注入点', '成功读取 flag'],
  description: null,
  evidence: [
    {
      evidenceType: 'lab' as const,
      verificationMethod: '提交 flag，系统自动比对',
      successCondition: '独立完成注入并读出本题 flag',
      assessmentMode: 'practice' as const,
      hintPolicy: 'unlimited' as const,
      independent: true,
    },
  ],
};

describe('a new objective needs a title and a behavior', () => {
  it('accepts one with both', () => {
    const { draft, rejected } = sanitizeObjective(COMPLETE_DRAFT);
    expect(rejected).toBe(false);
    expect(draft?.title).toBe(COMPLETE_DRAFT.title);
  });

  it('refuses one with a title but no behavior, rather than storing a topic', () => {
    const { draft, rejected } = sanitizeObjective({ ...COMPLETE_DRAFT, expectedBehavior: '' });
    expect(rejected).toBe(true);
    expect(draft).toBeNull();
  });

  it('keeps an objective with no criteria, because unverifiable is a visible state', () => {
    // Rejecting this write would hide the gap instead of surfacing it: an outcome
    // with no minimum bar is exactly what the author is meant to go and fill in.
    const { draft, rejected } = sanitizeObjective({ ...COMPLETE_DRAFT, minCriteria: [] });
    expect(rejected).toBe(false);
    expect(draft?.minCriteria).toEqual([]);
  });

  it('drops a piece of evidence with no way of being checked', () => {
    // An evidence row with nothing in it satisfies the store's "every outcome has
    // evidence" gate while proving nothing, so it must never be written.
    const { evidence, rejected } = sanitizeEvidence({
      evidenceType: 'lab',
      verificationMethod: '',
      successCondition: '做出来就算过',
    });
    expect(rejected).toBe(true);
    expect(evidence).toBeNull();
  });

  it('reads a criteria list from a newline string, as models write it', () => {
    expect(criteriaListOf('识别注入点\n成功读取 flag')).toEqual(['识别注入点', '成功读取 flag']);
    expect(criteriaListOf(['a', '', 'b'])).toEqual(['a', 'b']);
    expect(criteriaListOf(7)).toBeUndefined();
  });
});

describe('a change must name the outcome it targets', () => {
  it('accepts a patch with a ref', () => {
    const { patch, rejected } = sanitizeOutcomePatch({ ref: 'obj_1', minCriteria: ['a'] });
    expect(rejected).toBe(false);
    expect(patch).toEqual({ ref: 'obj_1', minCriteria: ['a'] });
  });

  it('refuses a patch with no ref, which has no owner', () => {
    const { patch, rejected } = sanitizeOutcomePatch({ minCriteria: ['a'] });
    expect(rejected).toBe(true);
    expect(patch).toBeNull();
  });

  it('refuses a patch that changes nothing', () => {
    // `title` is NOT NULL, so an empty patch would try to write a null title. It is
    // also not a change, so it must not count as one for the confirmation guard.
    const { rejected } = sanitizeOutcomePatch({ ref: 'obj_1' });
    expect(rejected).toBe(true);
  });

  it('applies nothing when the ref names nothing', () => {
    const merged = mergeOutcomePatch(
      [{ id: 'obj_1', title: 'A' }],
      answer({ updated: [{ ref: 'obj_nope', title: 'B' }] }),
    );
    expect(merged.patches.size).toBe(0);
    expect(merged.unmatchedRefs).toEqual(['obj_nope']);
  });

  it('lets a delete win over a patch to the same row in one turn', () => {
    const merged = mergeOutcomePatch(
      [{ id: 'obj_1', title: 'A' }],
      answer({ updated: [{ ref: 'obj_1', title: 'B' }], removed: ['obj_1'] }),
    );
    expect(merged.removed.has('obj_1')).toBe(true);
    expect(merged.patches.size).toBe(0);
  });

  it('keeps the last patch when the model rewrites one row twice', () => {
    const merged = mergeOutcomePatch(
      [{ id: 'obj_1', title: 'A' }],
      answer({
        updated: [
          { ref: 'obj_1', title: 'first' },
          { ref: 'obj_1', title: 'second' },
        ],
      }),
    );
    expect(merged.patches.get('obj_1')?.title).toBe('second');
  });
});

describe('confirming the step is a rule, not the model saying so', () => {
  const base = {
    confirmRequested: true,
    userTurns: 3,
    objectiveCount: 4,
    evidenceCount: 4,
    gaps: [],
    changedAnything: true,
  };

  it('honours a plain confirmation of a complete, changed list', () => {
    expect(shouldConfirmOutcomes(base)).toBe(true);
  });

  it("refuses the user's first sentence, when there is nothing to confirm yet", () => {
    expect(shouldConfirmOutcomes({ ...base, userTurns: 1 })).toBe(false);
  });

  it('refuses a turn that changed nothing', () => {
    // "看起来还行" is agreement with a list, but this turn put nothing on it, so
    // signing off would record a sign-off of no work.
    expect(shouldConfirmOutcomes({ ...base, changedAnything: false })).toBe(false);
  });

  it('refuses while the list still has gaps', () => {
    expect(shouldConfirmOutcomes({ ...base, gaps: [{ text: '目标「A」还没有考核方式' }] })).toBe(
      false,
    );
  });

  it('refuses an empty list even if the model insists', () => {
    expect(shouldConfirmOutcomes({ ...base, objectiveCount: 0, evidenceCount: 0 })).toBe(false);
  });

  it('refuses evidence without outcomes', () => {
    expect(shouldConfirmOutcomes({ ...base, objectiveCount: 0 })).toBe(false);
  });

  it('refuses when the model did not ask for a confirmation', () => {
    expect(shouldConfirmOutcomes({ ...base, confirmRequested: false })).toBe(false);
  });
});

describe('gaps say what to do', () => {
  it('asks for an outcome before it complains about evidence', () => {
    const gaps = outcomeGaps([]);
    expect(gaps).toHaveLength(1);
    expect(gaps[0].text).toContain('能独立完成什么');
  });

  it('names the outcome that cannot be assessed', () => {
    const gaps = outcomeGaps(
      [{ id: 'obj_1', title: '会做注入' }],
      [{ id: 'obj_1', title: '会做注入' }],
    );
    expect(gaps[0].ref).toBe('obj_1');
    expect(gaps[0].text).toContain('最低标准');
  });

  it('separates "not verifiable" from "no evidence"', () => {
    const gaps = outcomeGaps(
      [{ id: 'obj_1', title: '会做注入' }],
      [{ id: 'obj_1', title: '会做注入' }],
      [{ id: 'obj_1', title: '会做注入' }],
    );
    expect(gaps).toHaveLength(2);
    expect(gaps[0].text).toContain('可观察行为');
    expect(gaps[1].text).toContain('考核方式');
  });

  it('reads records into the same three checks', () => {
    const gaps = outcomeGapsOfRecords([{ id: 'obj_1', title: '会做注入', verifiable: false }], []);
    expect(gaps).toHaveLength(2);
  });
});

describe('the list the model reads', () => {
  it('prints a ref beside every outcome, because that is the only handle', () => {
    const text = formatOutcomeList({
      objectives: [{ id: 'obj_1', title: '会做注入' }],
      unverifiable: [{ id: 'obj_1', title: '会做注入' }],
      unevidenced: [{ id: 'obj_1', title: '会做注入' }],
      evidenceByObjective: new Map(),
    });
    expect(text).toContain('ref=obj_1');
    expect(text).toContain('[缺可验证要素]');
    expect(text).toContain('证据：无');
  });
});

describe("parsing the model's answer", () => {
  it('reads a fenced object with prose around it', () => {
    const parsed = parseOutcomeAnswer(
      '好的：\n```json\n{"message":"已加一条","added":[],"confirm":false}\n```',
    );
    expect(parsed.message).toBe('已加一条');
  });

  it('throws on something that is not an object', () => {
    expect(() => parseOutcomeAnswer('我需要更多信息')).toThrow(OutcomeAnswerError);
    expect(() => parseOutcomeAnswer('{ broken')).toThrow(OutcomeAnswerError);
  });

  it('keeps the bad entries in a log rather than dropping them silently', () => {
    const parsed = parseOutcomeAnswer(
      JSON.stringify({
        message: '',
        added: [{ title: '没有行为' }],
        updated: [{ minCriteria: ['a'] }],
        evidence: [{ ref: 'obj_1', evidenceType: 'lab' }],
        removed: [42],
      }),
    );
    expect(parsed.added).toHaveLength(0);
    expect(parsed.updated).toHaveLength(0);
    expect(parsed.evidence).toHaveLength(0);
    expect(parsed.removed).toHaveLength(0);
    expect(parsed.rejectedRefs).toHaveLength(4);
  });
});

describe('resolving a turn against the real board', () => {
  const objective = {
    id: 'obj_1',
    title: '会做注入',
    objectiveType: 'skill' as const,
    expectedBehavior: '读出 flag',
    minCriteria: ['识别注入点'],
    verifiable: true,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00Z',
  } as unknown as CurriculumObjectiveRecord;

  const evidence = {
    id: 'ev_1',
    objectiveId: 'obj_1',
    evidenceType: 'lab',
    successCondition: '拿到 flag',
  } as unknown as CurriculumEvidenceRecord;

  it('does not count an outcome as still unevidenced once this turn binds it', () => {
    // Reporting a wall the model just walked through makes it see the list as
    // unfinishable, and makes the card disagree with what is about to be stored.
    const turn = resolveOutcomesTurn({
      answer: answer({
        evidence: [
          {
            ref: 'obj_1',
            evidenceType: 'lab',
            verificationMethod: '提交 flag',
            successCondition: '拿到 flag',
          },
        ],
      }),
      board: boardOf([objective], []),
      history: [{ role: 'user', content: 'a' }],
    });
    expect(turn.gaps).toHaveLength(0);
  });

  it('drops an evidence row aimed at an outcome this turn deletes', () => {
    const turn = resolveOutcomesTurn({
      answer: answer({
        removed: ['obj_1'],
        evidence: [
          {
            ref: 'obj_1',
            evidenceType: 'lab',
            verificationMethod: '提交 flag',
            successCondition: '拿到 flag',
          },
        ],
      }),
      board: boardOf([objective], [evidence]),
      history: [],
    });
    expect(turn.evidence).toHaveLength(0);
    expect(turn.unmatchedRefs).toContain('obj_1');
  });

  it('reports a draft added without criteria as a gap, by title', () => {
    const turn = resolveOutcomesTurn({
      answer: answer({ added: [{ ...COMPLETE_DRAFT, minCriteria: [] }] }),
      board: boardOf([], []),
      history: [],
    });
    expect(turn.gaps.map((gap) => gap.text).join()).toContain(COMPLETE_DRAFT.title);
    expect(turn.confirmRequested).toBe(false);
  });

  it('counts a complete draft with its own evidence towards a confirmation', () => {
    const turn = resolveOutcomesTurn({
      answer: answer({ added: [COMPLETE_DRAFT], confirmRequested: true }),
      board: boardOf([], []),
      history: [
        { role: 'user', content: '第一句' },
        { role: 'assistant', content: 'a' },
        { role: 'user', content: '确认' },
      ],
    });
    expect(turn.confirmRequested).toBe(true);
    expect(turn.gaps).toHaveLength(0);
  });
});

describe('the direction line the model is given', () => {
  it('carries the scope, because the outcome count follows from it', () => {
    const line = formatDirectionLine({
      title: 'CTF 综合实战',
      audience: '大二学生',
      problemStatement: '6 方向 × 3 案例',
      durationHours: 48,
    });
    expect(line).toContain('CTF 综合实战');
    expect(line).toContain('48 学时');
    expect(line).toContain('6 方向');
  });
});
