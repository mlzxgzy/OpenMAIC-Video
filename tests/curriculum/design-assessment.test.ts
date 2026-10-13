/**
 * `design-assessment.ts` — 第七步的领域规则，不起模型。
 *
 * 这一步的失败方式同样是**沉默的**：一个有题干、有选项、有答案、有目标、有验证规则的
 * 题目，挂在了一个从来不承担这个目标的条目上。它通过了审核的每一条题目规则，出现在
 * 每一步的列表里，而覆盖闭环里永远没有它——学员没有在那个条目里见过它。所以下面断言
 * 最多的是**落点**：挂对了地方吗、挂错了会不会被说出来。
 *
 * 另一半是"store 会拒的这里先拒"：store 抛错回滚**整轮**，所以一道答案引用了不存在选项
 * 的题不能带走同轮另外十道题。这里逐条钉住 store 的硬规则。
 */
import { describe, expect, it } from 'vitest';

import {
  applyAssessmentAnswer,
  assessmentBoardOf,
  assessmentGaps,
  AssessmentAnswerError,
  describeVerifyRule,
  formatAssessmentPlan,
  parseAssessmentAnswer,
  sanitizeLabDraft,
  sanitizeQuestionDraft,
  shouldConfirmAssessment,
  type AssessmentAnswer,
  type AssessmentBoard,
} from '@/lib/curriculum/design-assessment';
import type {
  CurriculumEvidenceRecord,
  CurriculumLabTaskRecord,
  CurriculumObjectiveRecord,
  CurriculumQuestionRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

const NOW = '2026-10-12T00:00:00.000Z';

function unit(over: Partial<CurriculumUnitRecord> = {}): CurriculumUnitRecord {
  return {
    id: 'unit-1',
    taskId: 'task-1',
    parentId: null,
    unitType: 'item',
    title: '1.1 SQL 注入原理',
    code: null,
    unitRole: 'lecture',
    hours: 1,
    orderIndex: 0,
    teachingDesign: {},
    deckDesign: {},
    stageId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function coverage(over: Partial<CurriculumUnitCoverageRecord> = {}): CurriculumUnitCoverageRecord {
  return {
    id: 'uc-1',
    taskId: 'task-1',
    unitId: 'unit-1',
    objectiveId: 'obj-1',
    coverageKind: 'teach',
    depth: 'standard',
    orderIndex: 0,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function objective(over: Partial<CurriculumObjectiveRecord> = {}): CurriculumObjectiveRecord {
  return {
    id: 'obj-1',
    taskId: 'task-1',
    parentId: null,
    code: null,
    title: '能够利用 SQL 注入读取指定数据',
    description: null,
    objectiveType: 'skill',
    bloomLevel: null,
    level: 'component',
    expectedBehavior: '在靶场中构造 payload 读取 flag',
    minCriteria: ['识别注入点'],
    proficientCriteria: [],
    excellentCriteria: [],
    difficulty: 'basic',
    verifiable: true,
    unverifiableReason: null,
    status: 'approved',
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function evidence(over: Partial<CurriculumEvidenceRecord> = {}): CurriculumEvidenceRecord {
  return {
    id: 'ev-quiz',
    taskId: 'task-1',
    objectiveId: 'obj-1',
    evidenceType: 'quiz',
    verificationMethod: '笔试',
    successCondition: '答对',
    conditionExpression: null,
    auxiliaryCondition: null,
    assessmentMode: 'practice',
    thresholdPass: 0.6,
    thresholdProficient: 0.8,
    thresholdExcellent: 0.95,
    timeLimitSec: null,
    hintPolicy: 'unlimited',
    independent: true,
    processRecord: false,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

function question(over: Partial<CurriculumQuestionRecord> = {}): CurriculumQuestionRecord {
  return {
    id: 'q-1',
    taskId: 'task-1',
    unitId: 'unit-1',
    objectiveId: 'obj-1',
    evidenceId: null,
    questionType: 'single',
    stem: '哪个参数可注入？',
    options: [
      { key: 'A', text: 'id' },
      { key: 'B', text: 'page' },
    ],
    answer: ['A'],
    explanation: 'id 被拼进了 SQL',
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

function labTask(over: Partial<CurriculumLabTaskRecord> = {}): CurriculumLabTaskRecord {
  return {
    id: 'lab-1',
    taskId: 'task-1',
    unitId: 'unit-2',
    objectiveId: 'obj-1',
    evidenceId: null,
    assessmentMode: 'practice',
    taskGoal: '读取 /flag',
    brief: '服务存在注入',
    expectedResult: '/flag 可读',
    dockerImage: 'ctf/sql:latest',
    containerConfig: {},
    initState: {},
    resetPolicy: 'on-demand',
    referenceSolution: null,
    verifyRules: [{ kind: 'file_read', path: '/flag' }],
    keyBehaviors: [],
    finalStateRule: null,
    scoreRules: [],
    scoringMode: 'result',
    timeLimitSec: null,
    hintPolicy: 'unlimited',
    allowRetry: true,
    hintLadder: [],
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...over,
  };
}

/** 一门最小的课：1 个讲课条目（讲 obj-1）、1 个练习条目（练 obj-1）、1 条章。 */
function board(
  over: {
    units?: CurriculumUnitRecord[];
    coverage?: CurriculumUnitCoverageRecord[];
    objectives?: CurriculumObjectiveRecord[];
    evidence?: CurriculumEvidenceRecord[];
    questions?: CurriculumQuestionRecord[];
    labTasks?: CurriculumLabTaskRecord[];
  } = {},
): AssessmentBoard {
  const units = over.units ?? [
    unit({ id: 'chapter-1', unitType: 'chapter', unitRole: null, title: '第一章 Web 安全' }),
    unit({ id: 'unit-1' }),
    unit({ id: 'unit-2', unitRole: 'practice', title: '1.2 SQL 注入实操' }),
  ];
  const unitCoverage = over.coverage ?? [
    coverage({ id: 'uc-1', unitId: 'unit-1', coverageKind: 'teach' }),
    coverage({ id: 'uc-2', unitId: 'unit-2', coverageKind: 'practice' }),
    coverage({ id: 'uc-3', unitId: 'unit-2', coverageKind: 'assess' }),
  ];
  return assessmentBoardOf({
    units,
    unitCoverage,
    objectives: over.objectives ?? [objective()],
    evidence: over.evidence ?? [evidence()],
    questions: over.questions ?? [],
    labTasks: over.labTasks ?? [],
  });
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

function questionDraft(over: Partial<AssessmentAnswer['questions'][number]> = {}) {
  return {
    ref: null,
    itemRef: null,
    objectiveRef: 'obj-1',
    questionType: 'single' as const,
    stem: '哪一个是注入点？',
    options: [
      { key: 'A', text: 'id' },
      { key: 'B', text: 'page' },
    ],
    answer: ['A'],
    explanation: null,
    distractors: null,
    difficulty: null,
    bloomLevel: null,
    score: null,
    ...over,
  };
}

/** 改一道已存在的题：只带它真正要改的字段（没提到的保持原值）。 */
function questionUpdate(over: Record<string, unknown> = {}) {
  return { ref: 'q-1', itemRef: null, objectiveRef: null, ...over };
}

function labDraft(over: Partial<AssessmentAnswer['labTasks'][number]> = {}) {
  return {
    ref: null,
    itemRef: null,
    objectiveRef: 'obj-1',
    assessmentMode: 'practice' as const,
    taskGoal: '读取 /flag',
    brief: null,
    expectedResult: null,
    dockerImage: 'ctf/sql:latest',
    resetPolicy: null,
    referenceSolution: null,
    verifyRules: [{ kind: 'file_read' as const, path: '/flag' }],
    keyBehaviors: null,
    finalStateRule: null,
    scoreRules: null,
    scoringMode: null,
    timeLimitSec: null,
    hintPolicy: null,
    allowRetry: null,
    hintLadder: null,
    ...over,
  };
}

/**
 * 模型写的那一条实操，**原始形状**：验证规则是 `{kind, target}`，
 * 字段映射由 `labVerifyRuleFrom` 负责。`labDraft` 是清洗之后的形状（落库字段），
 * 两者不能混——混了就会写出"能存下去、永远匹配不上"的规则。
 */
function rawLab(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    itemRef: 'unit-2',
    objectiveRef: 'obj-1',
    assessmentMode: 'practice',
    taskGoal: '读取 /flag',
    dockerImage: 'ctf/sql:latest',
    verifyRules: [{ kind: 'file_read', target: '/flag' }],
    ...over,
  };
}

// ── 解析 ────────────────────────────────────────────────────────────────────

describe('parseAssessmentAnswer — 模型输出', () => {
  it('reads questions, labs, removals and the confirm flag from one object', () => {
    const parsed = parseAssessmentAnswer(
      JSON.stringify({
        message: '出好了',
        questions: [questionDraft({ ref: 'q-1' })],
        labTasks: [rawLab()],
        removedQuestions: ['q-9'],
        removedLabTasks: ['lab-9'],
        confirm: true,
      }),
    );
    expect(parsed.message).toBe('出好了');
    expect(parsed.questions[0]?.ref).toBe('q-1');
    expect(parsed.labTasks).toHaveLength(1);
    expect(parsed.removedQuestions).toEqual(['q-9']);
    expect(parsed.removedLabTasks).toEqual(['lab-9']);
    expect(parsed.confirmRequested).toBe(true);
  });

  it('reads a fenced JSON block, because models fence it half the time', () => {
    const parsed = parseAssessmentAnswer('```json\n{"questions":[],"labTasks":[]}\n```');
    expect(parsed.questions).toEqual([]);
  });

  it('throws when the answer is not JSON at all', () => {
    expect(() => parseAssessmentAnswer('好的，我来出题')).toThrow(AssessmentAnswerError);
  });

  it('maps a verify rule through the kind, never through a field the model picks', () => {
    const parsed = parseAssessmentAnswer(
      JSON.stringify({
        labTasks: [
          rawLab({
            verifyRules: [
              { kind: 'flag', target: 'flag{abc}' },
              { kind: 'env_state', target: 'FLAG_SET' },
              { kind: 'process_exec', target: 'cat /flag' },
            ],
          }),
        ],
      }),
    );
    const rules = parsed.labTasks[0]?.verifyRules ?? [];
    // flag 的判定值是 value；环境变量是 key；命令是 argv。写进别的字段就是
    // "存得下去、永远匹配不上"——S5 的 lab-authoring 就是为这件事存在的。
    expect(rules[0]).toMatchObject({ kind: 'flag', value: 'flag{abc}' });
    expect(rules[1]).toMatchObject({ kind: 'env_state', key: 'FLAG_SET' });
    expect(rules[2]).toMatchObject({ kind: 'process_exec', argv: ['cat', '/flag'] });
  });

  it('drops a verify rule that asserts nothing rather than storing an empty one', () => {
    const parsed = parseAssessmentAnswer(
      JSON.stringify({ labTasks: [rawLab({ verifyRules: [{ kind: 'flag', target: '  ' }] })] }),
    );
    expect(parsed.labTasks[0]?.verifyRules).toEqual([]);
  });

  it('rejects the fields that belong to other steps, and says which step', () => {
    const parsed = parseAssessmentAnswer(
      JSON.stringify({ teachingDesign: {}, coverage: [], evidence: [], questions: [] }),
    );
    const text = parsed.rejectedRefs.join('；');
    expect(text).toContain('上一步');
    expect(text).toContain('大纲');
    expect(text).toContain('第二步');
  });

  it('drops a lab whose verification rules are not a list, and keeps the reason', () => {
    const parsed = parseAssessmentAnswer(
      JSON.stringify({ labTasks: [rawLab({ verifyRules: 'flag{abc}' })] }),
    );
    expect(parsed.labTasks).toEqual([]);
    expect(parsed.rejectedRefs.join('')).toContain('验证规则');
  });

  it('keeps a question whose only problem is a difficulty outside the enum', () => {
    const { draft, reason } = sanitizeQuestionDraft({
      objectiveRef: 'obj-1',
      stem: 'x',
      options: [{ key: 'A', text: 'a' }],
      answer: ['A'],
      difficulty: 'very-hard',
    });
    expect(draft?.stem).toBe('x');
    // 没提到的字段就是 undefined（"保持原值"），不是 null（"清空"）。
    expect(draft?.difficulty).toBeUndefined();
    expect(reason).toContain('难度');
  });

  it('rejects a question whose options are not a list', () => {
    const { draft, reason } = sanitizeQuestionDraft({ stem: 'x', options: 'A、B' });
    expect(draft).toBeNull();
    expect(reason).toContain('选项');
  });

  it('accepts a lab that only names hints, since `hints` is how it gets written in prose', () => {
    const { draft } = sanitizeLabDraft({
      itemRef: 'unit-2',
      objectiveRef: 'obj-1',
      taskGoal: 'x',
      dockerImage: 'img',
      verifyRules: [{ kind: 'flag', target: 'flag{x}' }],
      hints: [{ level: 1, content: '看看 id 参数' }],
    });
    expect(draft?.hintLadder).toEqual([{ level: 1, content: '看看 id 参数' }]);
  });
});

// ── 落点：这一步的核心判断 ───────────────────────────────────────────────────

describe('applyAssessmentAnswer — 挂在哪个条目上', () => {
  it('creates a question on the item that teaches the outcome', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ questions: [questionDraft({ itemRef: 'unit-1' })] }),
    });
    expect(written.rejectedRefs).toEqual([]);
    expect(written.createQuestions[0]?.unitId).toBe('unit-1');
    expect(written.createQuestions[0]?.objectiveId).toBe('obj-1');
    expect(written.changed).toBe(true);
  });

  it('derives the item when exactly one claims the outcome, so the common case needs no id', () => {
    const written = applyAssessmentAnswer({
      board: board({
        coverage: [coverage({ id: 'uc-1', unitId: 'unit-1', coverageKind: 'teach' })],
      }),
      answer: answer({ questions: [questionDraft()] }),
    });
    expect(written.createQuestions[0]?.unitId).toBe('unit-1');
  });

  it('refuses to guess when several items claim the outcome, and names them', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ questions: [questionDraft()] }),
    });
    expect(written.createQuestions).toEqual([]);
    const text = written.rejectedRefs.join('；');
    expect(text).toContain('多个条目');
    expect(text).toContain('unit-1');
    expect(text).toContain('unit-2');
  });

  it('refuses a chapter as the home of a question, naming it as a chapter', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ questions: [questionDraft({ itemRef: 'chapter-1' })] }),
    });
    expect(written.createQuestions).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('章/节');
  });

  it('refuses an item that never promised the outcome, and lists the ones that did', () => {
    const written = applyAssessmentAnswer({
      board: board({
        units: [unit({ id: 'unit-1' }), unit({ id: 'unit-3', title: '1.3 无关条目' })],
        coverage: [coverage({ id: 'uc-1', unitId: 'unit-1', coverageKind: 'teach' })],
      }),
      answer: answer({ questions: [questionDraft({ itemRef: 'unit-3' })] }),
    });
    expect(written.createQuestions).toEqual([]);
    const text = written.rejectedRefs.join('；');
    expect(text).toContain('没有承担目标');
    expect(text).toContain('unit-1');
  });

  it('tells the author to go back to the outline when no item claims the outcome', () => {
    const written = applyAssessmentAnswer({
      board: board({
        coverage: [coverage({ id: 'uc-1', unitId: 'unit-1', objectiveId: 'obj-2' })],
      }),
      answer: answer({ questions: [questionDraft()] }),
    });
    expect(written.rejectedRefs.join('')).toContain('大纲');
  });

  it('refuses an outcome that is not in this course', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ questions: [questionDraft({ objectiveRef: 'obj-404' })] }),
    });
    expect(written.rejectedRefs.join('')).toContain('不属于这门课');
  });

  it('refuses a lab on an item that only teaches the outcome', () => {
    // 实操是"练"的东西：挂在只讲课的条目上，学员看完视频就被拉去做题，而课程里
    // 没有任何一条练习条目承担它。落点不对，实操就落在一个没有练习承诺的地方。
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ labTasks: [labDraft({ itemRef: 'unit-1' })] }),
    });
    expect(written.createLabTasks).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('练习');
  });

  it('creates the lab on the practising item', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ labTasks: [labDraft({ itemRef: 'unit-2' })] }),
    });
    expect(written.createLabTasks[0]).toMatchObject({ unitId: 'unit-2', objectiveId: 'obj-1' });
  });
});

// ── store 会拒的，这里先拒 ───────────────────────────────────────────────────

describe('applyAssessmentAnswer — store 的硬规则在这里先拒', () => {
  it('rejects one question without taking the others down with it', () => {
    // store 抛错回滚整轮：一道答案引用了不存在选项的题不该带走同轮另外九道。
    const written = applyAssessmentAnswer({
      board: board({ coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })] }),
      answer: answer({
        questions: [
          questionDraft({ itemRef: 'unit-1', stem: '好的题' }),
          questionDraft({ itemRef: 'unit-1', stem: '坏题', answer: ['C'] }),
        ],
      }),
    });
    expect(written.createQuestions.map((row) => row.stem)).toEqual(['好的题']);
    expect(written.rejectedRefs.join('')).toContain('不存在的选项');
  });

  it('rejects a single-choice question with two answers', () => {
    const written = applyAssessmentAnswer({
      board: board({ coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })] }),
      answer: answer({
        questions: [questionDraft({ itemRef: 'unit-1', answer: ['A', 'B'] })],
      }),
    });
    expect(written.createQuestions).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('只能有一个答案');
  });

  it('rejects a choice question with fewer than two options', () => {
    const written = applyAssessmentAnswer({
      board: board({ coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })] }),
      answer: answer({
        questions: [questionDraft({ itemRef: 'unit-1', options: [{ key: 'A', text: 'only' }] })],
      }),
    });
    expect(written.rejectedRefs.join('')).toContain('两个选项');
  });

  it('accepts a true/false question with no option list', () => {
    const written = applyAssessmentAnswer({
      board: board({ coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })] }),
      answer: answer({
        questions: [
          questionDraft({
            itemRef: 'unit-1',
            questionType: 'true_false',
            options: [],
            answer: ['对'],
          }),
        ],
      }),
    });
    expect(written.createQuestions).toHaveLength(1);
  });

  it('rejects a new question with no stem', () => {
    const written = applyAssessmentAnswer({
      board: board({ coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })] }),
      answer: answer({ questions: [questionDraft({ itemRef: 'unit-1', stem: null })] }),
    });
    expect(written.createQuestions).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('题干');
  });

  it('rejects a new lab with no docker image', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ labTasks: [labDraft({ itemRef: 'unit-2', dockerImage: null })] }),
    });
    expect(written.createLabTasks).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('dockerImage');
  });

  it('rejects a lab with no verification rule, in the store’s own words', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ labTasks: [labDraft({ itemRef: 'unit-2', verifyRules: [] })] }),
    });
    expect(written.createLabTasks).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('验证规则');
  });

  it('rejects an exam with no time limit rather than inventing how long an exam takes', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ labTasks: [labDraft({ itemRef: 'unit-2', assessmentMode: 'exam' })] }),
    });
    expect(written.createLabTasks).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('限时');
  });

  it('forces an exam cold and hint-free, because those have one legal value', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({
        labTasks: [
          labDraft({
            itemRef: 'unit-2',
            assessmentMode: 'exam',
            timeLimitSec: 1800,
            hintPolicy: 'unlimited',
            allowRetry: true,
          }),
        ],
      }),
    });
    expect(written.createLabTasks[0]).toMatchObject({
      hintPolicy: 'forbidden',
      allowRetry: false,
      timeLimitSec: 1800,
    });
  });

  it('lets practice keep its hints and retries', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({
        labTasks: [labDraft({ itemRef: 'unit-2', hintPolicy: 'limited', allowRetry: true })],
      }),
    });
    expect(written.createLabTasks[0]).toMatchObject({ hintPolicy: 'limited', allowRetry: true });
  });
});

// ── 改与删 ──────────────────────────────────────────────────────────────────

describe('applyAssessmentAnswer — 改一道、删一道', () => {
  it('writes only the fields an update names', () => {
    const existing = question({ id: 'q-1' });
    const written = applyAssessmentAnswer({
      board: board({ questions: [existing] }),
      answer: answer({ questions: [questionUpdate({ stem: '换个问法' })] }),
    });
    expect(written.createQuestions).toEqual([]);
    expect(written.updateQuestions).toHaveLength(1);
    expect(written.updateQuestions[0]?.id).toBe('q-1');
    // 只改了题干：选项、答案、分值都不在 patch 里，落库时保持原样。
    expect(Object.keys(written.updateQuestions[0]?.patch ?? {})).toEqual(['stem']);
  });

  it('treats a restatement as no change, so the sign-off does not flicker', () => {
    const existing = question({ id: 'q-1' });
    const written = applyAssessmentAnswer({
      board: board({ questions: [existing] }),
      answer: answer({ questions: [questionUpdate()] }),
    });
    expect(written.updateQuestions).toEqual([]);
    expect(written.changed).toBe(false);
  });

  it('rejects an update that names a question which does not exist', () => {
    const written = applyAssessmentAnswer({
      board: board(),
      answer: answer({ questions: [{ ref: 'q-404', itemRef: null, objectiveRef: null }] }),
    });
    expect(written.updateQuestions).toEqual([]);
    expect(written.rejectedRefs.join('')).toContain('q-404');
  });

  it('removes by id, and says so when the id is not there', () => {
    const written = applyAssessmentAnswer({
      board: board({ questions: [question({ id: 'q-1' })] }),
      answer: answer({ removedQuestions: ['q-1', 'q-404'] }),
    });
    expect(written.removeQuestionIds).toEqual(['q-1']);
    expect(written.rejectedRefs.join('')).toContain('q-404');
    expect(written.changed).toBe(true);
  });

  it('removes a lab by id too', () => {
    const written = applyAssessmentAnswer({
      board: board({ labTasks: [labTask({ id: 'lab-1' })] }),
      answer: answer({ removedLabTasks: ['lab-1'] }),
    });
    expect(written.removeLabTaskIds).toEqual(['lab-1']);
  });

  it('does not touch questions this turn did not mention', () => {
    const written = applyAssessmentAnswer({
      board: board({ questions: [question({ id: 'q-1' }), question({ id: 'q-2' })] }),
      answer: answer({ questions: [questionUpdate({ stem: '改了' })] }),
    });
    expect(written.updateQuestions.map((row) => row.id)).toEqual(['q-1']);
    expect(written.removeQuestionIds).toEqual([]);
  });

  it('numbers new questions after the ones already on the item', () => {
    const written = applyAssessmentAnswer({
      board: board({
        coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
        questions: [question({ id: 'q-1', sortOrder: 7 })],
      }),
      answer: answer({
        questions: [
          questionDraft({ itemRef: 'unit-1', stem: 'a' }),
          questionDraft({ itemRef: 'unit-1', stem: 'b' }),
        ],
      }),
    });
    expect(written.createQuestions.map((row) => row.sortOrder)).toEqual([8, 9]);
  });

  it('binds the unique evidence of the matching kind, and never a wrong one', () => {
    const written = applyAssessmentAnswer({
      board: board({
        coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
        evidence: [
          evidence({ id: 'ev-quiz', evidenceType: 'quiz' }),
          evidence({ id: 'ev-lab', evidenceType: 'lab' }),
        ],
      }),
      answer: answer({ questions: [questionDraft({ itemRef: 'unit-1' })] }),
    });
    expect(written.createQuestions[0]?.evidenceId).toBe('ev-quiz');
  });

  it('does not guess when the outcome has several quiz evidences', () => {
    const written = applyAssessmentAnswer({
      board: board({
        coverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
        evidence: [evidence({ id: 'ev-1' }), evidence({ id: 'ev-2' })],
      }),
      answer: answer({ questions: [questionDraft({ itemRef: 'unit-1' })] }),
    });
    expect(written.createQuestions[0]?.evidenceId).toBeNull();
    expect(written.advisories.join('')).toContain('多条');
  });
});

// ── 缺口 ────────────────────────────────────────────────────────────────────

describe('assessmentGaps — 还差什么', () => {
  it('reports that there are no items to hang anything on', () => {
    const gaps = assessmentGaps({
      units: [],
      unitCoverage: [],
      objectives: [objective()],
      evidence: [],
      questions: [],
      labTasks: [],
    });
    expect(gaps.map((gap) => gap.kind)).toEqual(['no_items']);
  });

  it('reports a question hanging on a chapter', () => {
    const gaps = assessmentGaps({
      units: [
        unit({ id: 'chapter-1', unitType: 'chapter', unitRole: null, title: '第一章' }),
        unit({ id: 'unit-1' }),
      ],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
      objectives: [objective()],
      evidence: [evidence()],
      questions: [question({ unitId: 'chapter-1' })],
      labTasks: [],
    });
    const gap = gaps.find((row) => row.kind === 'question_on_chapter');
    expect(gap?.text).toContain('第一章');
  });

  it('reports a question on an item that never promised the outcome', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' }), unit({ id: 'unit-2' })],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
      objectives: [objective()],
      evidence: [],
      questions: [question({ unitId: 'unit-2' })],
      labTasks: [],
    });
    expect(gaps.some((row) => row.kind === 'question_off_item')).toBe(true);
  });

  it('reports a lab that is adrift the same way', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' }), unit({ id: 'unit-2' })],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
      objectives: [objective()],
      evidence: [],
      questions: [],
      labTasks: [labTask({ unitId: 'unit-2' })],
    });
    expect(gaps.some((row) => row.kind === 'lab_off_item')).toBe(true);
  });

  it('accepts a question that hangs where the outcome is taught', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' })],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
      objectives: [objective()],
      evidence: [],
      questions: [question({ unitId: 'unit-1' })],
      labTasks: [],
    });
    expect(gaps).toEqual([]);
  });

  it('reports an assess promise with nothing to grade with', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' })],
      unitCoverage: [
        coverage({ id: 'uc-1', unitId: 'unit-1', coverageKind: 'teach' }),
        coverage({ id: 'uc-2', unitId: 'unit-1', coverageKind: 'assess' }),
      ],
      objectives: [objective()],
      evidence: [],
      questions: [],
      labTasks: [],
    });
    const gap = gaps.find((row) => row.kind === 'coverage_without_artifact');
    expect(gap?.text).toContain('空承诺');
  });

  it('does not demand an artifact for a practice promise, because generation delivers it', () => {
    // 大纲提示词写明练习条目生成幻灯片、测验和互动流程：练习承诺不是由题目或实操
    // 兑现的。把它也要求成"必须有实操"会把每一个正常的练习条目都报成缺口。
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' })],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'practice' })],
      objectives: [objective()],
      evidence: [],
      questions: [],
      labTasks: [],
    });
    expect(gaps).toEqual([]);
  });

  it('clears the assess promise once a question is there', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' })],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'assess' })],
      objectives: [objective()],
      evidence: [],
      questions: [question({ unitId: 'unit-1' })],
      labTasks: [],
    });
    expect(gaps).toEqual([]);
  });

  it('reports an exam promise delivered by a practice lab', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-2', unitRole: 'practice' })],
      unitCoverage: [coverage({ unitId: 'unit-2', coverageKind: 'practice' })],
      objectives: [objective()],
      evidence: [evidence({ id: 'ev-exam', evidenceType: 'lab', assessmentMode: 'exam' })],
      questions: [],
      labTasks: [labTask({ unitId: 'unit-2', assessmentMode: 'practice' })],
    });
    const gap = gaps.find((row) => row.kind === 'exam_evidence_practice_lab');
    expect(gap?.text).toContain('练习模式');
  });

  it('accepts an exam promise delivered by an exam lab', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-2', unitRole: 'exam' })],
      unitCoverage: [coverage({ unitId: 'unit-2', coverageKind: 'assess' })],
      objectives: [objective()],
      evidence: [evidence({ id: 'ev-exam', evidenceType: 'lab', assessmentMode: 'exam' })],
      questions: [],
      labTasks: [
        labTask({
          unitId: 'unit-2',
          assessmentMode: 'exam',
          timeLimitSec: 1800,
          hintPolicy: 'forbidden',
          allowRetry: false,
        }),
      ],
    });
    expect(gaps).toEqual([]);
  });

  it('stays silent when an exam promise has no lab yet, because another rule owns that', () => {
    // "考试证据没有对应实操"是 `evidence_no_artifact` 的发现；这里再说一遍就是
    // 同一条缺口两个来源。
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-1' })],
      unitCoverage: [coverage({ unitId: 'unit-1', coverageKind: 'teach' })],
      objectives: [objective()],
      evidence: [evidence({ id: 'ev-exam', evidenceType: 'lab', assessmentMode: 'exam' })],
      questions: [],
      labTasks: [],
    });
    expect(gaps).toEqual([]);
  });

  it('reports a lab with no verification rule', () => {
    const gaps = assessmentGaps({
      units: [unit({ id: 'unit-2' })],
      unitCoverage: [coverage({ unitId: 'unit-2', coverageKind: 'practice' })],
      objectives: [objective()],
      evidence: [],
      questions: [],
      labTasks: [labTask({ unitId: 'unit-2', verifyRules: [] })],
    });
    expect(gaps.map((row) => row.kind)).toEqual(['lab_without_verify_rule']);
  });
});

// ── 签收与渲染 ──────────────────────────────────────────────────────────────

describe('shouldConfirmAssessment — 确认是规则，不是模型说了算', () => {
  const base = {
    confirmRequested: true,
    userTurns: 2,
    gaps: [],
    changedAnything: true,
    artifactCount: 3,
    itemCount: 2,
  };

  it('confirms only when everything holds', () => {
    expect(shouldConfirmAssessment(base)).toBe(true);
  });

  it('refuses on the first message', () => {
    expect(shouldConfirmAssessment({ ...base, userTurns: 1 })).toBe(false);
  });

  it('refuses when the turn changed nothing', () => {
    expect(shouldConfirmAssessment({ ...base, changedAnything: false })).toBe(false);
  });

  it('refuses while any gap is open', () => {
    expect(shouldConfirmAssessment({ ...base, gaps: [{ text: 'x' }] })).toBe(false);
  });

  it('refuses an empty assessment, because signing nothing promises nothing', () => {
    expect(shouldConfirmAssessment({ ...base, artifactCount: 0 })).toBe(false);
  });

  it('refuses when the model did not ask', () => {
    expect(shouldConfirmAssessment({ ...base, confirmRequested: false })).toBe(false);
  });
});

describe('formatAssessmentPlan — 提示词与面板读同一份', () => {
  it('prints items with their promises and the ids of what is already there', () => {
    const plan = formatAssessmentPlan(
      board({
        coverage: [
          coverage({ id: 'uc-1', unitId: 'unit-1', coverageKind: 'teach' }),
          coverage({ id: 'uc-2', unitId: 'unit-2', coverageKind: 'practice' }),
        ],
        evidence: [evidence({ id: 'ev-quiz' })],
        questions: [question({ id: 'q-1', stem: '哪个参数可注入？' })],
        labTasks: [labTask({ id: 'lab-1', unitId: 'unit-2' })],
      }),
    );
    expect(plan).toContain('ref=unit-1');
    expect(plan).toContain('讲授');
    expect(plan).toContain('q-1');
    expect(plan).toContain('哪个参数可注入？');
    expect(plan).toContain('lab-1');
    expect(plan).toContain('ev-quiz');
  });

  it('says there is nothing to hang anything on when the outline is empty', () => {
    const plan = formatAssessmentPlan(
      assessmentBoardOf({
        units: [],
        unitCoverage: [],
        objectives: [],
        evidence: [],
        questions: [],
        labTasks: [],
      }),
    );
    expect(plan).toContain('还没有条目');
  });

  it('reads a verify rule by what it checks, not by which field it was stored in', () => {
    expect(describeVerifyRule({ kind: 'flag', value: 'flag{x}' })).toBe('提交的 flag：flag{x}');
    expect(describeVerifyRule({ kind: 'process_exec', argv: ['cat', '/flag'] })).toBe(
      '执行的命令：cat /flag',
    );
    // 字段写错时显示为空，而不是把 kind 永远不会读的 value 显示出来。
    expect(describeVerifyRule({ kind: 'file_read', value: '/flag' })).toBe(
      '读取的文件路径：（空）',
    );
  });
});
