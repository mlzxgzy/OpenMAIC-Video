/**
 * `resolveAssessmentTurn` — 第七步一轮对话的确定性一半，不起模型。
 *
 * 这里钉住的是这一步特有的两件事：
 *
 * 1. **缺口算在写完之后的状态上。** 模型这一轮补上的题目不该继续被报成"还差一道题"，
 *    否则它会一直被告知一件它刚做完的事。反过来，它这一轮**没**补上的缺口必须留着。
 * 2. **产物是独立的行。** 一轮里只改一道题时不碰另外十九道；删掉的按 id 消失；而
 *    "这一轮什么都没改"必须能被认出来，因为那正是"不能记录确认"的一条底线。
 */
import { describe, expect, it } from 'vitest';

import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  assessmentGaps,
  type AssessmentAnswer,
  type AssessmentGapInput,
} from '@/lib/curriculum/design-assessment';
import { resolveAssessmentTurn } from '@/lib/server/curriculum/assessment-step';
import type { AssessmentBoard } from '@/lib/curriculum/design-assessment';
import { assessmentBoardOf } from '@/lib/curriculum/design-assessment';
import type { CurriculumQuestionRecord } from '@/lib/curriculum/design-types';

const NOW = '2026-10-12T00:00:00.000Z';

/**
 * 一门最小的课：1 个章、1 个讲课条目（讲 obj-1）、1 个练习条目（练并考 obj-1）。
 * 讲课条目与练习条目都承担 obj-1，所以"这道题挂哪一条"必须由模型指名——这正是这一步
 * 的落点判断最常被触发的形状。
 */
function design(over: Partial<AssessmentGapInput> = {}): AssessmentGapInput {
  return {
    units: [
      { id: 'chapter-1', unitType: 'chapter', title: '第一章 Web 安全' },
      { id: 'unit-1', unitType: 'item', title: '1.1 SQL 注入原理' },
      { id: 'unit-2', unitType: 'item', title: '1.2 SQL 注入实操' },
    ],
    unitCoverage: [
      { unitId: 'unit-1', objectiveId: 'obj-1', coverageKind: 'teach' },
      { unitId: 'unit-2', objectiveId: 'obj-1', coverageKind: 'practice' },
      { unitId: 'unit-2', objectiveId: 'obj-1', coverageKind: 'assess' },
    ],
    objectives: [{ id: 'obj-1', title: '能独立完成注入' }],
    evidence: [
      { id: 'ev-quiz', objectiveId: 'obj-1', evidenceType: 'quiz', assessmentMode: 'practice' },
    ],
    questions: [],
    labTasks: [],
    ...over,
  };
}

function boardOf(input: AssessmentGapInput): AssessmentBoard {
  return assessmentBoardOf({
    units: [
      { id: 'chapter-1', unitType: 'chapter', title: '第一章 Web 安全', unitRole: null },
      { id: 'unit-1', unitType: 'item', title: '1.1 SQL 注入原理', unitRole: 'lecture', hours: 1 },
      {
        id: 'unit-2',
        unitType: 'item',
        title: '1.2 SQL 注入实操',
        unitRole: 'practice',
        hours: 1,
      },
    ],
    unitCoverage: input.unitCoverage,
    objectives: input.objectives,
    evidence: [
      { id: 'ev-quiz', objectiveId: 'obj-1', evidenceType: 'quiz', assessmentMode: 'practice' },
    ],
    questions: (input.questions ?? []) as CurriculumQuestionRecord[],
    labTasks: [],
  });
}

function question(id: string, over: Record<string, unknown> = {}): CurriculumQuestionRecord {
  return {
    id,
    taskId: 'task-1',
    unitId: 'unit-1',
    objectiveId: 'obj-1',
    evidenceId: null,
    questionType: 'single',
    stem: `题 ${id}`,
    options: [
      { key: 'A', text: 'a' },
      { key: 'B', text: 'b' },
    ],
    answer: ['A'],
    explanation: null,
    distractors: [],
    difficulty: 'basic',
    bloomLevel: null,
    score: 1,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function answer(over: Partial<AssessmentAnswer> = {}): AssessmentAnswer {
  return {
    message: '',
    questions: [],
    labTasks: [],
    removedQuestions: [],
    removedLabTasks: [],
    confirmRequested: false,
    rejectedRefs: [],
    ...over,
  };
}

const draft = (over: Record<string, unknown> = {}) => ({
  ref: null,
  itemRef: null,
  objectiveRef: 'obj-1',
  questionType: 'single' as const,
  stem: '哪一个是注入点？',
  options: [
    { key: 'A', text: 'a' },
    { key: 'B', text: 'b' },
  ],
  answer: ['A'],
  explanation: null,
  distractors: null,
  difficulty: null,
  bloomLevel: null,
  score: null,
  ...over,
});

const kinds = (gaps: readonly { kind: string; ref?: string }[]) =>
  gaps.map((gap) => `${gap.ref ?? '-'}:${gap.kind}`).sort();

describe('resolveAssessmentTurn — 缺口算在写完之后', () => {
  it('stops reporting the coverage gap the turn just filled', () => {
    const input = design();
    // 写之前：unit-2 承诺考核 obj-1，却什么都没有。
    expect(kinds(assessmentGaps(input))).toEqual(['unit-2:coverage_without_artifact']);

    const turn = resolveAssessmentTurn({
      answer: answer({ questions: [draft({ itemRef: 'unit-2' })] }),
      board: boardOf(input),
      design: input,
      history: [{ role: 'user', content: '给 1.2 出一道题' }],
    });
    expect(kinds(turn.gaps)).toEqual([]);
    expect(turn.changedAnything).toBe(true);
    expect(turn.artifactCount).toBe(1);
  });

  it('does not stop reporting a gap the turn did not touch', () => {
    const input = design({
      units: [
        { id: 'unit-1', unitType: 'item', title: '1.1 SQL 注入原理' },
        { id: 'unit-2', unitType: 'item', title: '1.2 SQL 注入实操' },
        { id: 'unit-3', unitType: 'item', title: '1.3 SQL 注入考核' },
      ],
      unitCoverage: [
        { unitId: 'unit-1', objectiveId: 'obj-1', coverageKind: 'teach' },
        { unitId: 'unit-2', objectiveId: 'obj-1', coverageKind: 'assess' },
        { unitId: 'unit-3', objectiveId: 'obj-1', coverageKind: 'assess' },
      ],
    });
    const turn = resolveAssessmentTurn({
      answer: answer({ questions: [draft({ itemRef: 'unit-2' })] }),
      board: boardOf(input),
      design: input,
      history: [{ role: 'user', content: '只给 1.2 出题' }],
    });
    // unit-3 从没被提到，它的空承诺还在——一轮补不上它没碰过的洞。
    expect(kinds(turn.gaps)).toEqual(['unit-3:coverage_without_artifact']);
  });

  it('treats a removal as making the promise empty again', () => {
    const existing = question('q-1', { unitId: 'unit-2' });
    const input = design({ questions: [existing] });
    expect(assessmentGaps(input)).toEqual([]);

    const turn = resolveAssessmentTurn({
      answer: answer({ removedQuestions: ['q-1'] }),
      board: boardOf(input),
      design: input,
      history: [{ role: 'user', content: '把这道题删了' }],
    });
    expect(kinds(turn.gaps)).toEqual(['unit-2:coverage_without_artifact']);
    expect(turn.changedAnything).toBe(true);
  });

  it('refuses an update that would empty a lab’s verification rules', () => {
    const lab = {
      id: 'lab-1',
      taskId: 'task-1',
      unitId: 'unit-2',
      objectiveId: 'obj-1',
      evidenceId: null,
      assessmentMode: 'practice' as const,
      taskGoal: '读取 /flag',
      brief: '',
      expectedResult: null,
      dockerImage: 'img',
      containerConfig: {},
      initState: {},
      resetPolicy: 'on-demand' as const,
      referenceSolution: null,
      verifyRules: [{ kind: 'flag' as const, value: 'flag{x}' }],
      keyBehaviors: [],
      finalStateRule: null,
      scoreRules: [],
      scoringMode: 'result' as const,
      timeLimitSec: null,
      hintPolicy: 'unlimited' as const,
      allowRetry: true,
      hintLadder: [],
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    };
    const input = design({ labTasks: [lab] });
    expect(assessmentGaps(input)).toEqual([]);

    const turn = resolveAssessmentTurn({
      answer: answer({
        labTasks: [{ ref: 'lab-1', itemRef: null, objectiveRef: null, verifyRules: [] }],
      }),
      board: { ...boardOf(input), labTasks: [lab] },
      design: input,
      history: [{ role: 'user', content: '把验证规则去掉' }],
    });
    // 规则层拒收，store 也拒收（`updateCurriculumLabTask` 会抛），而且 store 抛错会
    // 回滚整轮——所以这里必须是拒收加一句话，不是"写进去再报缺口"。
    expect(turn.writes.rejectedRefs.join('')).toContain('验证规则');
    expect(turn.writes.updateLabTasks).toEqual([]);
    expect(turn.changedAnything).toBe(false);
    expect(turn.gaps).toEqual([]);
  });

  it('sees a move that leaves a promise empty as the gap it is', () => {
    // unit-2 承诺考核 obj-1，唯一的题目原来挂在那里；把它挪到讲课条目上，unit-2 就
    // 只剩一句空承诺——而这正是"题目挂在哪一条"是一个声明的原因。
    const existing = question('q-1', { unitId: 'unit-2' });
    const input = design({ questions: [existing] });
    expect(assessmentGaps(input)).toEqual([]);

    const turn = resolveAssessmentTurn({
      answer: answer({
        questions: [
          {
            ref: 'q-1',
            itemRef: 'unit-1',
            objectiveRef: null,
          },
        ],
      }),
      board: boardOf(input),
      design: input,
      history: [{ role: 'user', content: '这道题挪到讲课条目里' }],
    });
    expect(turn.writes.updateQuestions.map((row) => row.id)).toEqual(['q-1']);
    expect(kinds(turn.gaps)).toEqual(['unit-2:coverage_without_artifact']);
  });

  it('reports no change when the turn only restates what is there', () => {
    const existing = question('q-1', { unitId: 'unit-2', stem: '哪一个是注入点？' });
    const input = design({ questions: [existing] });
    const turn = resolveAssessmentTurn({
      answer: answer({
        questions: [
          {
            ref: 'q-1',
            itemRef: null,
            objectiveRef: null,
            stem: '哪一个是注入点？',
          },
        ],
      }),
      board: boardOf(input),
      design: input,
      history: [{ role: 'user', content: '确认一下这道题的题干' }],
    });
    expect(turn.changedAnything).toBe(false);
    expect(turn.writes.updateQuestions).toEqual([]);
  });
});

describe('resolveAssessmentTurn — 确认是规则', () => {
  const filled = design();
  const turnWith = (over: Partial<AssessmentAnswer>, history: number) =>
    resolveAssessmentTurn({
      answer: answer(over),
      board: boardOf(filled),
      design: filled,
      history: Array.from({ length: history }, () => ({
        role: 'user' as const,
        content: '继续',
      })),
    });

  it('confirms only when the turn changed something and nothing is missing', () => {
    const turn = turnWith({ questions: [draft({ itemRef: 'unit-2' })], confirmRequested: true }, 2);
    expect(turn.confirmRequested).toBe(true);
  });

  it('refuses to confirm on the first message', () => {
    // `history` is the turns *before* this one; the count includes this message.
    const turn = turnWith({ questions: [draft({ itemRef: 'unit-2' })], confirmRequested: true }, 0);
    expect(turn.confirmRequested).toBe(false);
    expect(turn.userTurns).toBe(1);
  });

  it('refuses to confirm a turn that changed nothing', () => {
    const turn = turnWith({ confirmRequested: true }, 2);
    expect(turn.confirmRequested).toBe(false);
  });

  it('refuses to confirm while a gap is open', () => {
    const turn = resolveAssessmentTurn({
      answer: answer({
        questions: [draft({ itemRef: 'unit-1' })],
        confirmRequested: true,
      }),
      board: boardOf(filled),
      design: filled,
      history: [
        { role: 'user', content: '出题' },
        { role: 'user', content: '确认' },
      ],
    });
    // 挂在讲课条目上没问题，但 unit-2 的空承诺还在：不能带着缺口签收。
    expect(turn.gaps.some((gap) => gap.kind === 'coverage_without_artifact')).toBe(true);
    expect(turn.confirmRequested).toBe(false);
  });

  it('refuses to confirm a turn whose net result is no artifact at all', () => {
    // 只有讲授承诺的大纲：删掉唯一的题目不会留下任何缺口，但"签收一份没有任何题目和
    // 实操的设计"等于签收一份没有考核的课——这条底线是这一步独有的。
    const input = design({
      unitCoverage: [{ unitId: 'unit-1', objectiveId: 'obj-1', coverageKind: 'teach' }],
      questions: [question('q-1', { unitId: 'unit-1' })],
    });
    const turn = resolveAssessmentTurn({
      answer: answer({ removedQuestions: ['q-1'], confirmRequested: true }),
      board: boardOf(input),
      design: input,
      history: [
        { role: 'user', content: '删掉那道题' },
        { role: 'user', content: '确认' },
      ],
    });
    expect(turn.gaps).toEqual([]);
    expect(turn.changedAnything).toBe(true);
    expect(turn.artifactCount).toBe(0);
    expect(turn.confirmRequested).toBe(false);
  });
});

describe('the prompt template carries the contract the rules implement', () => {
  it('renders, says it is step 7, and asks for the placement contract', () => {
    const prompts = buildPrompt(PROMPT_IDS.COURSE_ASSESSMENT, {
      direction: '方向：Web 安全',
      plan: '条目：unit_a',
      gaps: '- 还差一道题',
      history: '(这是这一步的第一句话)',
      instruction: '给 1.2 出题',
    });
    expect(prompts).not.toBeNull();
    expect(prompts?.system).toContain('第七步');
    // 规则层强制的每一条，模型都必须被明确告知——否则它写出来的东西会被拒，而它不知道。
    expect(prompts?.system).toContain('must be an `item`');
    expect(prompts?.system).toContain('`objectiveRef` is required');
    expect(prompts?.system).toContain('must have promised that outcome');
    expect(prompts?.system).toContain('never write');
    expect(prompts?.system).toContain('{"kind": …, "target": …}');
    expect(prompts?.system).toContain('there is no sensible default for how long an exam takes');
    expect(prompts?.user).toContain('unit_a');
  });
});
