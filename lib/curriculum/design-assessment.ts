/**
 * 第七步「题目与实操」的规则层：把模型的意图落成可写入的题目与实操任务，并说清楚
 * 还差什么。
 *
 * 这一步的核心判断只有一句：**题目和实操是挂在某一个条目上的，而"挂在哪个条目上"
 * 是一个关于"哪个条目交付它"的声明。** 一个挂错条目的题目看起来完全正常——有题干、
 * 有选项、有答案、有关系到的学习目标，审核的每一条题目规则都满意——但没有任何一条
 * 它会出现在覆盖闭环里：讲这个目标的条目在讲课，而题目长在另一个条目上，学员从头到尾
 * 没在那个条目里见过它。**这类错误在界面上不可见**，所以它必须在这里被抓住。
 *
 * 四件事在这里定：
 *
 * 1. **地址**。`itemRef` 可以省略：省略时由目标推导出**唯一**承担它的条目；有多个
 *    候选（讲一次、练一次、考一次）就必须指名，因为"这道题考在哪一条"是作者的决定，
 *    不是机器的。指到一个章/节，指到一个不承担这个目标的条目，都拒收并说明为什么——
 *    store 两个都不检查，而它写下去之后一切照旧正常。
 *
 * 2. **`evidenceId` 与 `sortOrder` 是推导的，不是接的。** 证据是大纲那一步签过的文件，
 *    这里是第七步，不能让模型随手造一条证据来挂题目（那会撤回第二步的签收——见
 *    `design-store.ts` 的 `withdrawOutcomesSignOff`）；目标下恰好有一条对口证据时自动
 *    绑定，多条时不猜、只说。题号同理：同一轮里新写的题按条目已有题号往后排。
 *
 * 3. **store 会拒的，这里先拒。** store 抛错会回滚**整轮**，一道答案引用了不存在选项的
 *    题目不该带走同轮另外十道题（同 S8 的教训）。所以写入前把 store 的每一条硬规则
 *    都先走一遍：选项与答案、至少一条验证规则、考试三项严格性。
 *
 * 4. **验真规则按"结果"写，不按"路径"写。** `verifyRules` 由模型给出 `{kind, target}`，
 *    字段映射交给 `lab-authoring.ts` 的 {@link labVerifyRuleFrom}——S5 已经为"七选一的
 *    字段写错就永远匹配不上"做了一版，这里不再写第二版。
 */
import {
  EXAM_FORCED_VALUES,
  examStrictGaps,
  labVerifyKindLabel,
  labVerifyRuleFrom,
  labVerifyTargetOf,
  LAB_VERIFY_KINDS,
  type LabVerifyKind,
} from '@/lib/curriculum/lab-authoring';
import { COVERAGE_KIND_LABELS, ROLE_LABELS } from '@/lib/curriculum/design-teaching';
import {
  CURRICULUM_ASSESSMENT_MODES,
  CURRICULUM_DIFFICULTIES,
  CURRICULUM_HINT_POLICIES,
  CURRICULUM_QUESTION_TYPES,
  CURRICULUM_RESET_POLICIES,
  CURRICULUM_SCORING_MODES,
  type CurriculumAssessmentMode,
  type CurriculumBloomLevel,
  type CurriculumCoverageKind,
  type CurriculumDifficulty,
  type CurriculumEvidenceRecord,
  type CurriculumHintPolicy,
  type CurriculumLabTaskRecord,
  type CurriculumQuestionDistractor,
  type CurriculumQuestionOption,
  type CurriculumQuestionRecord,
  type CurriculumQuestionType,
  type CurriculumUnitRecord,
  type LabHint,
  type LabKeyBehavior,
  type LabReferenceStep,
  type LabScoreRule,
  type LabVerifyRule,
} from '@/lib/curriculum/design-types';

// ── 面板事实 ────────────────────────────────────────────────────────────────

/**
 * 缺口判定读的记录，**只写它真正读到的字段**。
 *
 * 刻意不是完整的记录类型：缺口要能在"这一轮写完之后"的**假设状态**上跑（模型刚补上的
 * 题目不该继续被报成缺口），在完整记录上做那件事就得伪造二十个字段。而
 * `CurriculumDesignSnapshot` 是它的超集，所以审核与阶段门禁可以直接把快照传进来，
 * 不需要适配层——多一层适配就是多一个可以接错的地方。
 */
export interface AssessmentGapInput {
  units: readonly { id: string; unitType: string; title: string }[];
  unitCoverage: readonly {
    unitId: string;
    objectiveId: string;
    coverageKind: CurriculumCoverageKind;
  }[];
  objectives: readonly { id: string; title: string }[];
  evidence: readonly {
    id: string;
    objectiveId: string;
    evidenceType: string;
    assessmentMode: string;
  }[];
  questions: readonly { id: string; unitId: string; objectiveId: string }[];
  labTasks: readonly {
    id: string;
    unitId: string;
    objectiveId: string;
    assessmentMode: string;
    taskGoal: string;
    verifyRules: readonly LabVerifyRule[];
  }[];
}

/**
 * 面板要的记录：缺口那部分同样只读几个字段，但**题目与实操是完整的记录**，因为
 * "改一道题只改它提到的字段"要比对现有行的每一个字段。快照同样是它的超集。
 */
export interface AssessmentBoardInput {
  units: readonly {
    id: string;
    unitType: string;
    title: string;
    unitRole: string | null;
    hours?: number | null;
  }[];
  unitCoverage: AssessmentGapInput['unitCoverage'];
  objectives: AssessmentGapInput['objectives'];
  evidence: AssessmentGapInput['evidence'];
  questions: readonly CurriculumQuestionRecord[];
  labTasks: readonly CurriculumLabTaskRecord[];
}

/** 一个条目在提示词里要交代的东西：它承担哪些目标、承担到什么程度。 */
export interface AssessmentItemBoard {
  id: string;
  title: string;
  role: NonNullable<CurriculumUnitRecord['unitRole']>;
  hours: number | null;
  /** 这个条目管辖的目标，以及它是以哪种方式承担的。 */
  objectives: { id: string; title: string; kinds: CurriculumCoverageKind[] }[];
}

export interface AssessmentBoard {
  items: AssessmentItemBoard[];
  objectives: { id: string; title: string; evidence: CurriculumEvidenceRecord[] }[];
  /** 章与节：它们只归类，所以题目挂上去是错的，需要能被指名。 */
  chapters: { id: string; title: string }[];
  questions: readonly CurriculumQuestionRecord[];
  labTasks: readonly CurriculumLabTaskRecord[];
}

export const QUESTION_TYPE_LABELS: Record<CurriculumQuestionType, string> = {
  single: '单选',
  multiple: '多选',
  true_false: '判断',
};

export const ASSESSMENT_MODE_LABELS: Record<CurriculumAssessmentMode, string> = {
  practice: '练习',
  exam: '考试',
};

export const DIFFICULTY_LABELS: Record<CurriculumDifficulty, string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
  advanced: '高阶',
};

/**
 * 从记录拼出规则层与提示词要的面板。
 *
 * 章/节在这里是**一等公民**：模型把题目挂到章上时，报错必须能说出"你挂到了第 2 章
 * 上"，而不是"单元不存在"——后者会让它以为是自己编了一个 id。
 */
export function assessmentBoardOf(design: AssessmentBoardInput): AssessmentBoard {
  const objectiveTitle = new Map(design.objectives.map((row) => [row.id, row.title]));
  const items: AssessmentItemBoard[] = design.units
    .filter((unit) => unit.unitType === 'item')
    .map((unit) => {
      const byObjective = new Map<string, CurriculumCoverageKind[]>();
      for (const row of design.unitCoverage) {
        if (row.unitId !== unit.id) continue;
        const kinds = byObjective.get(row.objectiveId) ?? [];
        kinds.push(row.coverageKind);
        byObjective.set(row.objectiveId, kinds);
      }
      return {
        id: unit.id,
        title: unit.title,
        role: (unit.unitRole as NonNullable<CurriculumUnitRecord['unitRole']>) ?? 'lecture',
        hours: unit.hours ?? null,
        objectives: [...byObjective.entries()].map(([id, kinds]) => ({
          id,
          title: objectiveTitle.get(id) ?? id,
          kinds,
        })),
      };
    });
  return {
    items,
    objectives: design.objectives.map((row) => ({
      id: row.id,
      title: row.title,
      evidence: design.evidence
        .filter((entry) => entry.objectiveId === row.id)
        .map((entry) => entry as unknown as CurriculumEvidenceRecord),
    })),
    chapters: design.units
      .filter((unit) => unit.unitType === 'chapter')
      .map((unit) => ({ id: unit.id, title: unit.title })),
    questions: design.questions as unknown as CurriculumQuestionRecord[],
    labTasks: design.labTasks as unknown as CurriculumLabTaskRecord[],
  };
}

// ── 模型输出 ────────────────────────────────────────────────────────────────

export class AssessmentAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AssessmentAnswerError';
  }
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取一行文本；空串算 null（"没写"），非字符串算 undefined（"这不是文本"）。 */
function textOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 这道题/这个实操当前的样子，用来决定"改了没有"。
 *
 * 比较是**逐字段**的而不是整行 JSON：题目记录里带着 `updatedAt`，整行比较会让每一次
 * 重述都算成改动，于是签收在每一轮对话里闪一次（前六步都踩过这个坑）。
 */
function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

// ── 题目草稿 ────────────────────────────────────────────────────────────────

/**
 * 题目草稿。字段全部可选是刻意的：**给了 `ref` 就是改那一道，只改提到的字段**；
 * 没有 `ref` 就是新建，新建时缺的字段在 {@link applyAssessmentAnswer} 里被判成拒收。
 */
export interface QuestionDraft {
  ref: string | null;
  itemRef: string | null;
  objectiveRef: string | null;
  /**
   * 其余字段都是 `?`：**没提到 = 保持原值，提到了（哪怕是 null 或空列表）= 改。**
   * 这个约定是"改一道题"能成立的前提——一个只想换题干的模型不该因为没写 `options`
   * 就把选项清空。编辑路径和渲染路径都读这一条约定。
   */
  questionType?: CurriculumQuestionType | null;
  stem?: string | null;
  options?: CurriculumQuestionOption[] | null;
  answer?: string[] | null;
  explanation?: string | null;
  distractors?: CurriculumQuestionDistractor[] | null;
  difficulty?: CurriculumDifficulty | null;
  bloomLevel?: string | null;
  score?: number | null;
}

export interface LabDraft {
  ref: string | null;
  itemRef: string | null;
  objectiveRef: string | null;
  /** 同 {@link QuestionDraft}：没提到的字段保持原值。 */
  assessmentMode?: CurriculumAssessmentMode | null;
  taskGoal?: string | null;
  brief?: string | null;
  expectedResult?: string | null;
  dockerImage?: string | null;
  resetPolicy?: string | null;
  referenceSolution?: LabReferenceStep[] | null;
  verifyRules?: LabVerifyRule[] | null;
  keyBehaviors?: LabKeyBehavior[] | null;
  finalStateRule?: string | null;
  scoreRules?: LabScoreRule[] | null;
  scoringMode?: string | null;
  timeLimitSec?: number | null;
  hintPolicy?: CurriculumHintPolicy | null;
  allowRetry?: boolean | null;
  hintLadder?: LabHint[] | null;
}

export interface AssessmentAnswer {
  message: string;
  questions: QuestionDraft[];
  labTasks: LabDraft[];
  removedQuestions: string[];
  removedLabTasks: string[];
  confirmRequested: boolean;
  /** 解析阶段就已经不能采纳的东西（形状不对、越界字段）。 */
  rejectedRefs: string[];
}

/**
 * 这一步之外、但会被顺手写进来的字段。
 *
 * 每一条都说清楚"为什么不在这一步"，因为模型的下一句话就是照着自己刚写的那份 JSON
 * 再写一遍——不解释，它会把同一个字段再送一次。
 */
const OUT_OF_SCOPE_KEYS: Record<string, string> = {
  plans: '教学设计是上一步的事，已忽略',
  teachingDesign: '授课脚本是上一步的事，已忽略',
  deckDesign: '分镜是上一步的事，已忽略',
  pages: '分镜是上一步的事，已忽略',
  coverage:
    '覆盖关系在大纲那一步签过字，这里不改：题目要么挂到承担该目标的条目上，要么先回大纲补覆盖',
  objectives: '学习目标在第二步签过字，这里不改',
  evidence: '证据在第二步签过字，这里不改',
  units: '大纲在大纲那一步签过字，这里不改',
  nodes: '知识技能图在第三步签过字，这里不改',
};

/**
 * 列表字段的三态：**不在 raw 里 = undefined（保持原值）**，显式 `null` 或 `[]` = 空列表
 * （清空），字符串/对象数组 = 解析结果。非数组一律 undefined，由调用方决定这是不是
 * 让整条作废。
 */
function readOptions(value: unknown): CurriculumQuestionOption[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const options: CurriculumQuestionOption[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const key = textOf(entry.key);
    const text = textOf(entry.text);
    if (!key || !text) return undefined;
    options.push({ key, text });
  }
  return options;
}

function readDistractors(value: unknown): CurriculumQuestionDistractor[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const distractors: CurriculumQuestionDistractor[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const optionKey = textOf(entry.optionKey);
    const misconception = textOf(entry.misconception);
    if (!optionKey || !misconception) return undefined;
    distractors.push({ optionKey, misconception });
  }
  return distractors;
}

/** 文本列表：`null` 是"清空"，非数组或含空项则是"这不是列表"。 */
function readTextList(value: unknown): string[] | undefined {
  if (value === null) return [];
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    const text = textOf(entry);
    if (text === null || text === undefined) return undefined;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

/** 参考解答：不是评分的输入，只是给提示和解析用的一条可能路径。 */
function readReferenceSolution(value: unknown): LabReferenceStep[] | null | undefined {
  if (value === null) return null;
  if (!Array.isArray(value)) return undefined;
  const steps: LabReferenceStep[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return undefined;
    const action = textOf(entry.action);
    if (!action) return undefined;
    steps.push({
      step: positiveInt(entry.step) ?? index + 1,
      action,
      ...(textOf(entry.detail) ? { detail: textOf(entry.detail) as string } : {}),
    });
  }
  return steps;
}

/**
 * 验证规则：**只收 `{kind, target}`，不收那七个字段名**。
 *
 * store 的记录带七个可能的字段（`value`/`path`/`key`/`argv`/`expression`/…），而"哪一个是
 * 条件"由 `kind` 决定。让模型自己挑字段，就是把"字段写错、永远匹配不上、还存得下去"
 * 这个坑交给它踩——S5 的 `lab-authoring.ts` 已经把这个映射写好了。
 */
function readVerifyRules(value: unknown): LabVerifyRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: LabVerifyRule[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const kind = oneOf(entry.kind, LAB_VERIFY_KINDS) as LabVerifyKind | undefined;
    // An unknown `kind` takes the whole lab down: it is the one enum the database
    // cannot guard, so a typo there is stored and then silently never matches.
    // A blank *target* only drops that rule — `labVerifyRuleFrom` refuses to build
    // a rule that asserts nothing, and a lab left with no rules is refused loudly
    // at write time instead of quietly grading less than it says.
    if (!kind) return undefined;
    const target = textOf(entry.target);
    if (!target) continue;
    const rule = labVerifyRuleFrom(kind, target, textOf(entry.note) ?? undefined);
    if (rule) rules.push(rule);
  }
  return rules;
}

function readHintLadder(value: unknown): LabHint[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const hints: LabHint[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return undefined;
    const content = textOf(entry.content);
    if (!content) return undefined;
    hints.push({ level: positiveInt(entry.level) ?? index + 1, content });
  }
  return hints;
}

function readKeyBehaviors(value: unknown): LabKeyBehavior[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const behaviors: LabKeyBehavior[] = [];
  for (const [index, entry] of value.entries()) {
    if (!isRecord(entry)) return undefined;
    const description = textOf(entry.description);
    if (!description) return undefined;
    behaviors.push({
      id: textOf(entry.id) ?? `b${index + 1}`,
      description,
      ...(textOf(entry.stepId) ? { stepId: textOf(entry.stepId) as string } : {}),
    });
  }
  return behaviors;
}

function readScoreRules(value: unknown): LabScoreRule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: LabScoreRule[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) return undefined;
    const kind = oneOf(entry.kind, ['result', 'process', 'key_step', 'time'] as const);
    const weight = typeof entry.weight === 'number' ? entry.weight : undefined;
    if (!kind || weight === undefined || !Number.isFinite(weight)) return undefined;
    rules.push({
      kind,
      weight,
      ...(textOf(entry.stepId) ? { stepId: textOf(entry.stepId) as string } : {}),
      ...(textOf(entry.note) ? { note: textOf(entry.note) as string } : {}),
    });
  }
  return rules;
}

/**
 * 清洗一道题目。
 *
 * 只有三条形状规则会让整道题作废：不是一个对象、`ref`/`itemRef` 不是文本、选项或
 * 干扰项不是列表。**内容是否够格不在这里判**——那属于 {@link applyAssessmentAnswer}，
 * 因为"缺什么"取决于它是新建还是修改。
 */
export function sanitizeQuestionDraft(raw: unknown): {
  draft: QuestionDraft | null;
  reason?: string;
} {
  if (!isRecord(raw)) return { draft: null, reason: '题目不是一个对象' };
  const rejected: string[] = [];
  const label = textOf(raw.stem) ?? '（无题干）';
  const short = label.slice(0, 24);

  const draft: QuestionDraft = {
    ref: textOf(raw.ref) ?? null,
    itemRef: textOf(raw.itemRef) ?? null,
    objectiveRef: textOf(raw.objectiveRef) ?? null,
  };

  if ('questionType' in raw || 'type' in raw) {
    const value = raw.questionType ?? raw.type;
    const questionType = oneOf(value, CURRICULUM_QUESTION_TYPES);
    if (questionType) draft.questionType = questionType;
    else if (value !== null && value !== undefined) {
      rejected.push(`题目「${short}」的题型不是 single/multiple/true_false，按选择题处理`);
    }
  }

  if ('stem' in raw) {
    const stem = textOf(raw.stem);
    if (stem === undefined) {
      rejected.push(`题目「${short}」的题干不是文本，整道题未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.stem = stem;
  }

  if ('options' in raw) {
    if (raw.options === null) draft.options = [];
    else {
      const options = readOptions(raw.options);
      if (!options) {
        rejected.push(`题目「${short}」的选项不是合法列表，整道题未采用`);
        return { draft: null, reason: rejected.join('；') };
      }
      draft.options = options;
    }
  }

  if ('answer' in raw) {
    const answer = raw.answer === null ? [] : readTextList(raw.answer);
    if (!answer) {
      rejected.push(`题目「${short}」的答案不是文本列表，整道题未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.answer = answer;
  }

  if ('explanation' in raw) draft.explanation = textOf(raw.explanation) ?? null;

  if ('distractors' in raw) {
    if (raw.distractors === null) draft.distractors = [];
    else {
      const distractors = readDistractors(raw.distractors);
      if (!distractors) {
        rejected.push(`题目「${short}」的干扰项不是合法列表，整道题未采用`);
        return { draft: null, reason: rejected.join('；') };
      }
      draft.distractors = distractors;
    }
  }

  if ('difficulty' in raw) {
    const difficulty = oneOf(raw.difficulty, CURRICULUM_DIFFICULTIES);
    if (difficulty) draft.difficulty = difficulty;
    else if (raw.difficulty !== null && raw.difficulty !== undefined) {
      rejected.push(`题目「${short}」的难度不在允许取值内，按基础处理`);
    }
  }

  if ('bloomLevel' in raw) {
    const bloom = textOf(raw.bloomLevel);
    draft.bloomLevel = (bloom ?? null) as CurriculumBloomLevel | null;
  }

  if ('score' in raw) {
    if (raw.score === null) draft.score = null;
    else {
      const score = Number(raw.score);
      if (!Number.isFinite(score) || score < 0) {
        rejected.push(`题目「${short}」的分值不是数字，按 1 分处理`);
      } else {
        draft.score = score;
      }
    }
  }

  return { draft, reason: rejected.length > 0 ? rejected.join('；') : undefined };
}

/** 清洗一个实操草稿。形状不对整项作废；内容够不够格同样留给写入意图那一步。 */
export function sanitizeLabDraft(raw: unknown): { draft: LabDraft | null; reason?: string } {
  if (!isRecord(raw)) return { draft: null, reason: '实操任务不是一个对象' };
  const label = textOf(raw.taskGoal) ?? '（无任务目标）';
  const short = label.slice(0, 24);
  const rejected: string[] = [];

  const draft: LabDraft = {
    ref: textOf(raw.ref) ?? null,
    itemRef: textOf(raw.itemRef) ?? null,
    objectiveRef: textOf(raw.objectiveRef) ?? null,
  };

  if ('assessmentMode' in raw || 'mode' in raw) {
    const value = raw.assessmentMode ?? raw.mode;
    const assessmentMode = oneOf(value, CURRICULUM_ASSESSMENT_MODES);
    if (assessmentMode) draft.assessmentMode = assessmentMode;
    else if (value !== null && value !== undefined) {
      rejected.push(`实操「${short}」的模式不是 practice/exam，按练习处理`);
    }
  }

  for (const key of [
    'taskGoal',
    'brief',
    'expectedResult',
    'dockerImage',
    'finalStateRule',
  ] as const) {
    if (!(key in raw)) continue;
    const text = textOf(raw[key]);
    if (text === undefined) {
      rejected.push(`实操「${short}」的 ${key} 不是文本，整项未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft[key] = text;
  }

  if ('referenceSolution' in raw) {
    const steps = readReferenceSolution(raw.referenceSolution);
    if (steps === undefined) {
      rejected.push(`实操「${short}」的参考解答不是合法列表，整项未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.referenceSolution = steps;
  }

  if ('verifyRules' in raw) {
    const rules = raw.verifyRules === null ? [] : readVerifyRules(raw.verifyRules);
    if (!rules) {
      rejected.push(`实操「${short}」的验证规则不是合法列表，整项未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.verifyRules = rules;
  }

  const hintsKey = 'hintLadder' in raw ? 'hintLadder' : 'hints' in raw ? 'hints' : null;
  if (hintsKey) {
    const hints = raw[hintsKey] === null ? [] : readHintLadder(raw[hintsKey]);
    if (!hints) {
      rejected.push(`实操「${short}」的提示不是合法列表，整项未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.hintLadder = hints;
  }

  if ('keyBehaviors' in raw) {
    const behaviors = raw.keyBehaviors === null ? [] : readKeyBehaviors(raw.keyBehaviors);
    if (!behaviors) {
      rejected.push(`实操「${short}」的关键行为不是合法列表，整项未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.keyBehaviors = behaviors;
  }

  if ('scoreRules' in raw) {
    const scoreRules = raw.scoreRules === null ? [] : readScoreRules(raw.scoreRules);
    if (!scoreRules) {
      rejected.push(`实操「${short}」的评分规则不是合法列表，整项未采用`);
      return { draft: null, reason: rejected.join('；') };
    }
    draft.scoreRules = scoreRules;
  }

  if ('resetPolicy' in raw) {
    const resetPolicy = oneOf(raw.resetPolicy, CURRICULUM_RESET_POLICIES);
    if (resetPolicy) draft.resetPolicy = resetPolicy;
    else if (raw.resetPolicy !== null && raw.resetPolicy !== undefined) {
      rejected.push(`实操「${short}」的重置策略不在允许取值内，按按需重置处理`);
    }
  }

  if ('scoringMode' in raw) {
    const scoringMode = oneOf(raw.scoringMode, CURRICULUM_SCORING_MODES);
    if (scoringMode) draft.scoringMode = scoringMode;
    else if (raw.scoringMode !== null && raw.scoringMode !== undefined) {
      rejected.push(`实操「${short}」的评分方式不在允许取值内，按结果评分处理`);
    }
  }

  if ('hintPolicy' in raw) {
    const hintPolicy = oneOf(raw.hintPolicy, CURRICULUM_HINT_POLICIES);
    if (hintPolicy) draft.hintPolicy = hintPolicy;
    else if (raw.hintPolicy !== null && raw.hintPolicy !== undefined) {
      rejected.push(`实操「${short}」的提示策略不在允许取值内`);
    }
  }

  if ('timeLimitSec' in raw) {
    if (raw.timeLimitSec === null) draft.timeLimitSec = null;
    else {
      const seconds = Number(raw.timeLimitSec);
      draft.timeLimitSec = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds) : null;
    }
  }

  if ('allowRetry' in raw) {
    draft.allowRetry = typeof raw.allowRetry === 'boolean' ? raw.allowRetry : null;
  }

  return { draft, reason: rejected.length > 0 ? rejected.join('；') : undefined };
}

export function parseAssessmentAnswer(text: string): AssessmentAnswer {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new AssessmentAnswerError('模型没有返回 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new AssessmentAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) throw new AssessmentAnswerError('模型返回的不是一个 JSON 对象');

  const rejectedRefs: string[] = [];
  for (const [key, reason] of Object.entries(OUT_OF_SCOPE_KEYS)) {
    if (key in parsed) rejectedRefs.push(`「${key}」${reason}`);
  }

  const questions: QuestionDraft[] = [];
  for (const entry of asArray(parsed.questions)) {
    const { draft, reason } = sanitizeQuestionDraft(entry);
    if (!draft) {
      if (reason) rejectedRefs.push(reason);
      continue;
    }
    if (reason) rejectedRefs.push(reason);
    questions.push(draft);
  }

  const labTasks: LabDraft[] = [];
  for (const entry of asArray(parsed.labTasks)) {
    const { draft, reason } = sanitizeLabDraft(entry);
    if (!draft) {
      if (reason) rejectedRefs.push(reason);
      continue;
    }
    if (reason) rejectedRefs.push(reason);
    labTasks.push(draft);
  }

  return {
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    questions,
    labTasks,
    removedQuestions: idList(parsed.removedQuestions),
    removedLabTasks: idList(parsed.removedLabTasks),
    confirmRequested: parsed.confirm === true,
    rejectedRefs,
  };
}

/** 删除列表：只收文本 id；非列表就是空（删除是"没提到就不动"，不是"整表替换"）。 */
function idList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const entry of value) {
    const text = textOf(entry);
    if (!text) continue;
    if (!out.includes(text)) out.push(text);
  }
  return out;
}

// ── 写入意图 ────────────────────────────────────────────────────────────────

/** 一条新建的题目，字段与 store 的 `CurriculumQuestionInput` 一致。 */
export interface QuestionWrite {
  unitId: string;
  objectiveId: string;
  evidenceId: string | null;
  questionType: CurriculumQuestionType;
  stem: string;
  options: CurriculumQuestionOption[];
  answer: string[];
  explanation: string | null;
  distractors: CurriculumQuestionDistractor[];
  difficulty: CurriculumDifficulty;
  bloomLevel: string | null;
  score: number;
  sortOrder: number;
}

/** 一条新建的实操任务，字段与 store 的 `CurriculumLabTaskInput` 一致。 */
export interface LabWrite {
  unitId: string;
  objectiveId: string;
  evidenceId: string | null;
  assessmentMode: CurriculumAssessmentMode;
  taskGoal: string;
  brief: string;
  expectedResult: string | null;
  dockerImage: string;
  resetPolicy: string;
  referenceSolution: LabReferenceStep[] | null;
  verifyRules: LabVerifyRule[];
  keyBehaviors: LabKeyBehavior[];
  finalStateRule: string | null;
  scoreRules: LabScoreRule[];
  scoringMode: string;
  timeLimitSec: number | null;
  hintPolicy: CurriculumHintPolicy;
  allowRetry: boolean;
  hintLadder: LabHint[];
  sortOrder: number;
}

export interface AssessmentUpdates {
  /**
   * 模型的意图，已经解析成真实 id 与完整记录。
   *
   * 删除是**按 id 指名**的，不是"整表替换"：题目和实操是独立的行（同第三步的依赖边），
   * 一个模型改一道题时不会因此删掉同轮没提到的另外十九道。
   */
  createQuestions: QuestionWrite[];
  updateQuestions: { id: string; patch: Partial<QuestionWrite> }[];
  createLabTasks: LabWrite[];
  updateLabTasks: { id: string; patch: Partial<LabWrite> }[];
  removeQuestionIds: string[];
  removeLabTaskIds: string[];
  /** 写不进去的东西，和为什么。作者必须看得见——被静默丢掉的题目在界面上没有痕迹。 */
  rejectedRefs: string[];
  /** 只提示不拦签收的观察。 */
  advisories: string[];
  /** 这一轮真的动了东西吗——没动就不该撤回签收（同前六步）。 */
  changed: boolean;
}

/** 一条意图要挂的目标与条目，解析完的落点。 */
interface Placement {
  unitId: string;
  objectiveId: string;
  evidenceId: string | null;
}

/**
 * 把一条意图的落点算出来，算不出来就说明为什么。
 *
 * 顺序是刻意的：**先看目标，再看条目。** 目标不存在，条目就没有可选项；目标存在而
 * 没有任何条目承担它，那是一个大纲缺口（讲都没讲，题从哪来），而报成"条目不存在"
 * 会把作者引到错的地方去。
 */
function resolvePlacement(input: {
  board: AssessmentBoard;
  objectiveRef: string | null;
  itemRef: string | null;
  /** 这个产物要在哪些覆盖类型下才说得通：题目=任意承担，实操=练或考。 */
  allowedKinds: readonly CurriculumCoverageKind[];
  artifactLabel: string;
}): Placement | { reason: string } {
  const { board, objectiveRef, itemRef } = input;
  if (!objectiveRef)
    return { reason: `这道${input.artifactLabel}没有写它考哪个目标（objectiveRef）` };
  const objective = board.objectives.find((row) => row.id === objectiveRef);
  if (!objective) {
    return {
      reason: `目标 ${objectiveRef} 不属于这门课：${input.artifactLabel}必须挂在课内已有的目标上`,
    };
  }

  const candidates = board.items.filter((item) =>
    item.objectives.some(
      (row) =>
        row.id === objective.id && row.kinds.some((kind) => input.allowedKinds.includes(kind)),
    ),
  );
  if (candidates.length === 0) {
    const anyItem = board.items.filter((item) =>
      item.objectives.some((row) => row.id === objective.id),
    );
    if (anyItem.length === 0) {
      return {
        reason:
          `目标「${objective.title}」还没有任何条目承担它：先回大纲，把这一条排出条目并给它` +
          `${input.allowedKinds.map((kind) => COVERAGE_KIND_LABELS[kind]).join('/')}的覆盖`,
      };
    }
    return {
      reason:
        `目标「${objective.title}」目前只被这些条目承担：` +
        `${anyItem.map((item) => `${item.title}(${item.id})`).join('、')}，` +
        `没有一个承担${input.allowedKinds.map((kind) => COVERAGE_KIND_LABELS[kind]).join('/')}：` +
        '覆盖关系在大纲那一步签过字，这里不替你改',
    };
  }

  if (itemRef) {
    const chapter = board.chapters.find((row) => row.id === itemRef);
    if (chapter) {
      return {
        reason:
          `「${chapter.title}」是章/节，只做归类，不讲课也不考试：` +
          `${input.artifactLabel}要挂在目（item）上`,
      };
    }
    const named = candidates.find((item) => item.id === itemRef);
    if (!named) {
      const exists = board.items.find((item) => item.id === itemRef);
      const kindsHere = exists?.objectives.find((row) => row.id === objective.id)?.kinds ?? [];
      const wanted = input.allowedKinds.map((kind) => COVERAGE_KIND_LABELS[kind]).join('/');
      return {
        reason: !exists
          ? `条目 ${itemRef} 不在大纲里：${input.artifactLabel}必须挂在课内已有的目上`
          : kindsHere.length > 0
            ? `「${exists.title}」对目标「${objective.title}」只做了${kindsHere
                .map((kind) => COVERAGE_KIND_LABELS[kind])
                .join(
                  '/',
                )}，没有${wanted}：${input.artifactLabel}要挂在${wanted}它的条目上（可选：${candidates
                .map((item) => `${item.title}(${item.id})`)
                .join('、')}）`
            : `「${exists.title}」没有承担目标「${objective.title}」：${input.artifactLabel}只能挂在承担它的条目上（可选：${candidates
                .map((item) => `${item.title}(${item.id})`)
                .join('、')}）`,
      };
    }
    return { unitId: named.id, objectiveId: objective.id, evidenceId: null };
  }

  // 没指名：只在**唯一**候选时推导。多个候选意味着"考在哪一条"是作者的决定，
  // 机器猜一个会把题放进一个作者没想到的条目里，而界面上它看起来完全正常。
  if (candidates.length === 1) {
    return { unitId: candidates[0].id, objectiveId: objective.id, evidenceId: null };
  }
  return {
    reason:
      `目标「${objective.title}」有多个条目承担，请指名 itemRef：` +
      candidates.map((item) => `${item.title}(${item.id})`).join('、'),
  };
}

/**
 * 证据绑定：目标下**恰好一条**对口证据时自动绑定，多条时不猜。
 *
 * 猜错一条证据比不绑定更糟：覆盖闭环读的是证据，绑错意味着"这个目标被考了"指向了
 * 另一条考核标准。所以多条时只提示，让作者自己决定要不要在界面上改。
 */
function deriveEvidence(
  board: AssessmentBoard,
  objectiveId: string,
  evidenceType: 'quiz' | 'lab',
  advisories: string[],
  artifactLabel: string,
): string | null {
  const objective = board.objectives.find((row) => row.id === objectiveId);
  const matching = (objective?.evidence ?? []).filter((row) => row.evidenceType === evidenceType);
  if (matching.length === 1) return matching[0].id;
  if (matching.length > 1) {
    advisories.push(
      `目标「${objective?.title ?? objectiveId}」有多条${
        evidenceType === 'quiz' ? '测验' : '实操'
      }证据，这条${artifactLabel}没有绑定其中任何一条（机器不猜）`,
    );
  }
  return null;
}

/** 同一轮里新写的题按条目已有的最大题号往后排；题号是推导的，不是接的。 */
function nextSortOrder(existing: readonly number[]): number {
  return existing.length === 0 ? 0 : Math.max(...existing) + 1;
}

function answerProblem(
  options: CurriculumQuestionOption[],
  answer: string[],
  type: CurriculumQuestionType,
) {
  if (type !== 'true_false' && options.length < 2) {
    return '选择题至少需要两个选项';
  }
  if (answer.length === 0) return '题目需要答案';
  if (options.length > 0) {
    const keys = new Set(options.map((option) => option.key));
    const stray = answer.filter((key) => !keys.has(key));
    if (stray.length > 0) return `答案引用了不存在的选项：${stray.join('、')}`;
  }
  if (type !== 'multiple' && answer.length > 1) {
    return `${type === 'single' ? '单选' : '判断题'}只能有一个答案，这里给了 ${answer.length} 个`;
  }
  return null;
}

/**
 * 把一整轮意图落成写入。
 *
 * 拒收的层次是刻意的，和前三步一致：
 *
 * - **落点错**（目标是别人的、条目是章、条目不承担该目标）→ 整条拒收。写下去之后
 *   覆盖闭环读不到它，而界面上它看起来正常。
 * - **内容不全**（新建缺题干/答案/镜像少验证规则）→ 整条拒收，理由用 store 的话说，
 *   因为 store 拒收会连累整轮。
 * - **非致命**（难度取值不对、证据绑不上）→ 写入 + 记账/提示。
 *
 * 改（`ref` 指到已有一道题）只写它给出的字段：一道题只改题干时，其余字段保持原样。
 */
export function applyAssessmentAnswer(input: {
  board: AssessmentBoard;
  answer: AssessmentAnswer;
}): AssessmentUpdates {
  const { board, answer } = input;
  const rejectedRefs: string[] = [];
  const advisories: string[] = [];
  const createQuestions: QuestionWrite[] = [];
  const updateQuestions: { id: string; patch: Partial<QuestionWrite> }[] = [];
  const createLabTasks: LabWrite[] = [];
  const updateLabTasks: { id: string; patch: Partial<LabWrite> }[] = [];
  let changed = false;

  const questionById = new Map(board.questions.map((row) => [row.id, row]));
  const labById = new Map(board.labTasks.map((row) => [row.id, row]));

  for (const draft of answer.questions) {
    const existing = draft.ref ? questionById.get(draft.ref) : undefined;
    if (draft.ref && !existing) {
      rejectedRefs.push(`题目 ${draft.ref} 不存在，改不了它（新建时不要写 ref）`);
      continue;
    }
    const placement = resolvePlacement({
      board,
      objectiveRef: draft.objectiveRef ?? existing?.objectiveId ?? null,
      // An update that does not name a home keeps the one it already has. Without
      // this, fixing one question's stem would be refused on any course where two
      // items are accountable for the outcome ("name the item") — the machine
      // asking the author to re-decide something nobody changed.
      itemRef: draft.itemRef ?? existing?.unitId ?? null,
      allowedKinds: ['teach', 'practice', 'assess'],
      artifactLabel: '题',
    });
    if ('reason' in placement) {
      rejectedRefs.push(placement.reason);
      continue;
    }
    const type =
      draft.questionType ?? (existing?.questionType as CurriculumQuestionType) ?? 'single';
    // `undefined` = 没提到（用现有值），`null`/`[]` = 明确清空。两者混起来会让
    // "只改题干"变成"顺手把选项清空"。
    const options = draft.options === undefined ? (existing?.options ?? []) : (draft.options ?? []);
    const answerKey = draft.answer === undefined ? (existing?.answer ?? []) : (draft.answer ?? []);
    const problem = answerProblem(options, answerKey, type);
    if (problem) {
      rejectedRefs.push(
        `题目「${(draft.stem ?? existing?.stem ?? '').slice(0, 24)}」${problem}，没有写入`,
      );
      continue;
    }

    if (!existing) {
      if (!draft.stem) {
        rejectedRefs.push('新建的题目缺少题干（stem），没有写入');
        continue;
      }
      const create: QuestionWrite = {
        unitId: placement.unitId,
        objectiveId: placement.objectiveId,
        evidenceId: deriveEvidence(board, placement.objectiveId, 'quiz', advisories, '题'),
        questionType: type,
        stem: draft.stem,
        options,
        answer: answerKey,
        explanation: draft.explanation ?? null,
        distractors: draft.distractors ?? [],
        difficulty: draft.difficulty ?? 'basic',
        bloomLevel: draft.bloomLevel ?? null,
        score: draft.score ?? 1,
        sortOrder: nextSortOrder([
          ...board.questions
            .filter((row) => row.unitId === placement.unitId)
            .map((row) => row.sortOrder),
          ...createQuestions
            .filter((row) => row.unitId === placement.unitId)
            .map((row) => row.sortOrder),
        ]),
      };
      createQuestions.push(create);
      changed = true;
      continue;
    }

    // 改：只写它给出的字段。`evidenceId` 与 `sortOrder` 不接——前者是第二步签过的
    // 证据，后者是题号，两者都由推导给出。
    const patch: Partial<QuestionWrite> = {};
    if (draft.itemRef !== undefined && draft.itemRef !== null) patch.unitId = placement.unitId;
    if (draft.objectiveRef !== undefined && draft.objectiveRef !== null) {
      patch.objectiveId = placement.objectiveId;
    }
    if (draft.questionType !== undefined && draft.questionType !== null) {
      patch.questionType = draft.questionType;
    }
    if (draft.stem !== undefined && draft.stem !== null) patch.stem = draft.stem;
    if (draft.options !== undefined) patch.options = draft.options ?? [];
    if (draft.answer !== undefined) patch.answer = draft.answer ?? [];
    if (draft.explanation !== undefined) patch.explanation = draft.explanation;
    if (draft.distractors !== undefined) patch.distractors = draft.distractors ?? [];
    if (draft.difficulty !== undefined && draft.difficulty !== null) {
      patch.difficulty = draft.difficulty;
    }
    if (draft.bloomLevel !== undefined) patch.bloomLevel = draft.bloomLevel;
    if (draft.score !== undefined) patch.score = draft.score ?? 0;
    if (questionPatchChanges(patch, existing)) {
      updateQuestions.push({ id: existing.id, patch });
      changed = true;
    }
  }

  for (const draft of answer.labTasks) {
    const existing = draft.ref ? labById.get(draft.ref) : undefined;
    if (draft.ref && !existing) {
      rejectedRefs.push(`实操 ${draft.ref} 不存在，改不了它（新建时不要写 ref）`);
      continue;
    }
    const placement = resolvePlacement({
      board,
      objectiveRef: draft.objectiveRef ?? existing?.objectiveId ?? null,
      itemRef: draft.itemRef ?? existing?.unitId ?? null,
      allowedKinds: ['practice', 'assess'],
      artifactLabel: '实操任务',
    });
    if ('reason' in placement) {
      rejectedRefs.push(placement.reason);
      continue;
    }

    const mode =
      draft.assessmentMode ?? (existing?.assessmentMode as CurriculumAssessmentMode) ?? 'practice';
    // 考试三项：提示与重试没有第二种合法取值，直接写成唯一合法的；时限没有合理默认，
    // 所以缺了就拒收——替作者编一个"考试多长"是这一步不该做的决定。
    const hintPolicy =
      mode === 'exam'
        ? EXAM_FORCED_VALUES.hintPolicy
        : (draft.hintPolicy ?? existing?.hintPolicy ?? 'unlimited');
    const allowRetry =
      mode === 'exam'
        ? EXAM_FORCED_VALUES.allowRetry
        : (draft.allowRetry ?? existing?.allowRetry ?? true);
    const timeLimitSec = draft.timeLimitSec ?? existing?.timeLimitSec ?? null;
    const verifyRules = draft.verifyRules ?? existing?.verifyRules ?? [];
    const strictGaps = examStrictGaps({
      assessmentMode: mode,
      hintPolicy,
      allowRetry,
      timeLimitSec,
    });
    if (strictGaps.length > 0) {
      rejectedRefs.push(
        `实操「${(draft.taskGoal ?? existing?.taskGoal ?? '').slice(0, 24)}」${strictGaps.join('；')}`,
      );
      continue;
    }
    if (verifyRules.length === 0) {
      rejectedRefs.push(
        `实操「${(draft.taskGoal ?? existing?.taskGoal ?? '').slice(0, 24)}」没有可用的验证规则：` +
          '验证规则判的是结果（flag、文件、命令输出…），参考解答判的是某一种解法',
      );
      continue;
    }

    if (!existing) {
      if (!draft.taskGoal) {
        rejectedRefs.push('新建的实操任务缺少任务目标（taskGoal），没有写入');
        continue;
      }
      if (!draft.dockerImage) {
        rejectedRefs.push(`实操「${draft.taskGoal.slice(0, 24)}」缺少 dockerImage，没有写入`);
        continue;
      }
      createLabTasks.push({
        unitId: placement.unitId,
        objectiveId: placement.objectiveId,
        evidenceId: deriveEvidence(board, placement.objectiveId, 'lab', advisories, '实操任务'),
        assessmentMode: mode,
        taskGoal: draft.taskGoal,
        brief: draft.brief ?? '',
        expectedResult: draft.expectedResult ?? null,
        dockerImage: draft.dockerImage,
        resetPolicy: draft.resetPolicy ?? 'on-demand',
        referenceSolution: draft.referenceSolution ?? null,
        verifyRules,
        keyBehaviors: draft.keyBehaviors ?? [],
        finalStateRule: draft.finalStateRule ?? null,
        scoreRules: draft.scoreRules ?? [],
        scoringMode: draft.scoringMode ?? 'result',
        timeLimitSec,
        hintPolicy,
        allowRetry,
        hintLadder: draft.hintLadder ?? [],
        sortOrder: nextSortOrder([
          ...board.labTasks
            .filter((row) => row.unitId === placement.unitId)
            .map((row) => row.sortOrder),
          ...createLabTasks
            .filter((row) => row.unitId === placement.unitId)
            .map((row) => row.sortOrder),
        ]),
      });
      changed = true;
      continue;
    }

    const patch: Partial<LabWrite> = {};
    if (draft.itemRef !== undefined && draft.itemRef !== null) patch.unitId = placement.unitId;
    if (draft.objectiveRef !== undefined && draft.objectiveRef !== null) {
      patch.objectiveId = placement.objectiveId;
    }
    // 考试的三项：模式被点名改成考试时，提示与重试的合法取值只有一种，所以它们
    // 跟着一起写——否则 store 会以 `curriculum_lab_exam_strict` 拒掉整轮。
    const examNow = mode === 'exam';
    if (draft.assessmentMode !== undefined && draft.assessmentMode !== null) {
      patch.assessmentMode = mode;
    }
    if (draft.taskGoal !== undefined && draft.taskGoal !== null) patch.taskGoal = draft.taskGoal;
    if (draft.brief !== undefined) patch.brief = draft.brief ?? '';
    if (draft.expectedResult !== undefined) patch.expectedResult = draft.expectedResult;
    if (draft.dockerImage !== undefined && draft.dockerImage !== null) {
      patch.dockerImage = draft.dockerImage;
    }
    if (draft.resetPolicy !== undefined && draft.resetPolicy !== null) {
      patch.resetPolicy = draft.resetPolicy;
    }
    if (draft.referenceSolution !== undefined) patch.referenceSolution = draft.referenceSolution;
    if (draft.verifyRules !== undefined) patch.verifyRules = draft.verifyRules ?? [];
    if (draft.keyBehaviors !== undefined) patch.keyBehaviors = draft.keyBehaviors ?? [];
    if (draft.finalStateRule !== undefined) patch.finalStateRule = draft.finalStateRule;
    if (draft.scoreRules !== undefined) patch.scoreRules = draft.scoreRules ?? [];
    if (draft.scoringMode !== undefined && draft.scoringMode !== null) {
      patch.scoringMode = draft.scoringMode;
    }
    if (draft.timeLimitSec !== undefined || examNow) patch.timeLimitSec = timeLimitSec;
    if (draft.hintPolicy !== undefined || examNow) patch.hintPolicy = hintPolicy;
    if (draft.allowRetry !== undefined || examNow) patch.allowRetry = allowRetry;
    if (draft.hintLadder !== undefined) patch.hintLadder = draft.hintLadder ?? [];
    if (labPatchChanges(patch, existing)) {
      updateLabTasks.push({ id: existing.id, patch });
      changed = true;
    }
  }

  // 删除：按 id 指名。指名了一个不存在的东西要说出来——静默忽略会让作者以为自己删了。
  const removeQuestionIds: string[] = [];
  for (const id of answer.removedQuestions) {
    if (!questionById.has(id)) {
      rejectedRefs.push(`要删的题目 ${id} 不存在，没有删除`);
      continue;
    }
    removeQuestionIds.push(id);
    changed = true;
  }
  const removeLabTaskIds: string[] = [];
  for (const id of answer.removedLabTasks) {
    if (!labById.has(id)) {
      rejectedRefs.push(`要删的实操 ${id} 不存在，没有删除`);
      continue;
    }
    removeLabTaskIds.push(id);
    changed = true;
  }

  return {
    createQuestions,
    updateQuestions,
    createLabTasks,
    updateLabTasks,
    removeQuestionIds,
    removeLabTaskIds,
    rejectedRefs: [...answer.rejectedRefs, ...rejectedRefs],
    advisories,
    changed,
  };
}

/** 一道题改没改：只比 patch 提到的字段。 */
function questionPatchChanges(
  patch: Partial<QuestionWrite>,
  row: CurriculumQuestionRecord,
): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const current = (row as unknown as Record<string, unknown>)[key];
    if (!sameJson(value, current)) return true;
  }
  return false;
}

/** 一个实操改没改：只比 patch 提到的字段。 */
function labPatchChanges(patch: Partial<LabWrite>, row: CurriculumLabTaskRecord): boolean {
  for (const [key, value] of Object.entries(patch)) {
    const current = (row as unknown as Record<string, unknown>)[key];
    if (!sameJson(value, current)) return true;
  }
  return false;
}

// ── 缺口 ────────────────────────────────────────────────────────────────────

/**
 * 缺口的种类。
 *
 * 存在的理由和第六步一样：审核只该把**某几类**缺口变成 error，而规则靠 kind 挑，
 * 不靠匹配消息文本——匹配文案的规则会在有人改一句措辞时静默失效。
 */
export const ASSESSMENT_GAP_KINDS = [
  /** 一个条目都没有，题目无处可挂。 */
  'no_items',
  /** 题目挂在一个章/节上。 */
  'question_on_chapter',
  /** 题目挂在一个不承担该目标的条目上。 */
  'question_off_item',
  /** 实操挂在章/节或不承担该目标的条目上。 */
  'lab_off_item',
  /** 条目承诺了"考核在这个条目里"，但那里没有任何题目或实操。 */
  'coverage_without_artifact',
  /** 实操没有验证规则：判不了分。 */
  'lab_without_verify_rule',
  /** 考试证据由一个练习模式的实操交付：承诺的是考试，交的是练习。 */
  'exam_evidence_practice_lab',
] as const;
export type AssessmentGapKind = (typeof ASSESSMENT_GAP_KINDS)[number];

export interface AssessmentGap {
  /** 条目/题目/实操 id；整体性缺口（一个条目都没有）没有。 */
  ref?: string;
  kind: AssessmentGapKind;
  text: string;
}

/**
 * 这一步还差什么。
 *
 * 三条判定，合成一次实现，供提示词、面板、阶段门禁与审核四处共用：
 *
 * 1. **产物挂对了地方吗。** 挂在章上（章不讲课）、挂在没承担该目标的条目上——两者
 *    store 都不检查，写下去之后覆盖闭环里都没有它，而界面上一切正常。
 * 2. **"考核在这里"兑现了吗。** 一个条目写着 `assess` 覆盖，却没有任何题目或实操挂在
 *    它身上，那么大纲里签下的那句"这里考它"就是空的。**只查 `assess`**：`practice`
 *    承诺由生成交付（大纲提示词里写明练习条目生成幻灯片、测验和互动流程），把它也算成
 *    "必须有实操"会把正常的练习条目全报成缺口。
 * 3. **考试是不是考试。** 证据写着 `exam`，交付它的实操却是 `practice`——学员拿到的
 *    是有提示、可重做、不限时的东西，而成绩单上它是考试。
 */
export function assessmentGaps(input: AssessmentGapInput): AssessmentGap[] {
  const gaps: AssessmentGap[] = [];
  const items = input.units.filter((unit) => unit.unitType === 'item');
  if (items.length === 0) {
    return [
      {
        kind: 'no_items',
        text: '还没有任何条目：题目与实操是逐条挂上去的，先在大纲阶段排出条目',
      },
    ];
  }

  const itemById = new Map(items.map((unit) => [unit.id, unit]));
  const objectiveById = new Map(input.objectives.map((row) => [row.id, row]));
  /** (条目, 目标) → 覆盖类型集合。 */
  const coverageOf = new Map<string, Set<CurriculumCoverageKind>>();
  for (const row of input.unitCoverage) {
    if (!itemById.has(row.unitId)) continue;
    const key = `${row.unitId}::${row.objectiveId}`;
    const kinds = coverageOf.get(key) ?? new Set<CurriculumCoverageKind>();
    kinds.add(row.coverageKind);
    coverageOf.set(key, kinds);
  }

  const placeOf = (
    artifact: { id: string; unitId: string; objectiveId: string },
    artifactLabel: string,
  ): boolean => {
    const item = itemById.get(artifact.unitId);
    const objective = objectiveById.get(artifact.objectiveId);
    const name = artifactLabel === '题目' ? '题目' : '实操任务';
    if (!item) {
      const chapter = input.units.find((unit) => unit.id === artifact.unitId);
      gaps.push({
        ref: artifact.id,
        kind: artifactLabel === '题目' ? 'question_on_chapter' : 'lab_off_item',
        text: chapter
          ? `${name}挂在了「${chapter.title}」上，而章/节只做归类、不讲课也不考试：要挂在目（item）上`
          : `${name}挂的条目 ${artifact.unitId} 不在大纲里`,
      });
      return false;
    }
    if (!coverageOf.has(`${item.id}::${artifact.objectiveId}`)) {
      gaps.push({
        ref: artifact.id,
        kind: artifactLabel === '题目' ? 'question_off_item' : 'lab_off_item',
        text:
          `${name}挂在「${item.title}」上，但这个条目没有承担目标` +
          `「${objective?.title ?? artifact.objectiveId}」：` +
          '题目与实操必须挂在交付它的那个条目上，否则覆盖闭环里看不到它',
      });
      return false;
    }
    return true;
  };

  for (const question of input.questions) {
    placeOf(
      { id: question.id, unitId: question.unitId, objectiveId: question.objectiveId },
      '题目',
    );
  }
  for (const lab of input.labTasks) {
    placeOf({ id: lab.id, unitId: lab.unitId, objectiveId: lab.objectiveId }, '实操任务');
  }

  // 2. `assess` 覆盖必须有一个交付物。
  const artifactKeys = new Set<string>();
  for (const question of input.questions) {
    artifactKeys.add(`${question.unitId}::${question.objectiveId}`);
  }
  for (const lab of input.labTasks) {
    artifactKeys.add(`${lab.unitId}::${lab.objectiveId}`);
  }
  for (const [key, kinds] of coverageOf) {
    if (!kinds.has('assess')) continue;
    if (artifactKeys.has(key)) continue;
    const [unitId, objectiveId] = key.split('::');
    gaps.push({
      ref: unitId,
      kind: 'coverage_without_artifact',
      text:
        `「${itemById.get(unitId)?.title ?? unitId}」把目标` +
        `「${objectiveById.get(objectiveId)?.title ?? objectiveId}」登记为考核点，` +
        '但那里没有任何题目或实操：这一行覆盖是一个空承诺',
    });
  }

  // 3. 考试证据要由考试的实操交付。
  const labByObjective = new Map<string, AssessmentGapInput['labTasks'][number][]>();
  for (const lab of input.labTasks) {
    const rows = labByObjective.get(lab.objectiveId) ?? [];
    rows.push(lab);
    labByObjective.set(lab.objectiveId, rows);
  }
  for (const evidence of input.evidence) {
    if (evidence.assessmentMode !== 'exam') continue;
    const labs = labByObjective.get(evidence.objectiveId) ?? [];
    if (labs.length === 0) continue;
    if (labs.some((lab) => lab.assessmentMode === 'exam')) continue;
    gaps.push({
      ref: labs[0].id,
      kind: 'exam_evidence_practice_lab',
      text:
        `目标「${objectiveById.get(evidence.objectiveId)?.title ?? evidence.objectiveId}」的证据是考试，` +
        `但交付它的实操「${labs[0].taskGoal}」是练习模式（有提示、可重做、不限时）：` +
        '把这条实操改成考试模式，或把证据改成练习',
    });
  }

  // 4. 实操的验证规则。store 收一条都不给的实操场次吗？不收——但工作台可以把已有
  //    规则的实操改到 0 条（PATCH 是另一个口），而审核的 `lab_no_verify_rule` 会报。
  //    这里报同一件事，因为阶段门禁读的是这一份。
  for (const lab of input.labTasks) {
    if (lab.verifyRules.length > 0) continue;
    gaps.push({
      ref: lab.id,
      kind: 'lab_without_verify_rule',
      text: `实操任务「${lab.taskGoal}」没有验证规则：无法判分`,
    });
  }

  return gaps;
}

/**
 * 是否采纳模型声明的"用户已确认"，四条底线同前六步，第四条是这一步特有的：
 *
 * 1. 模型说了 `confirm`。
 * 2. 不是第一句话（至少两轮用户消息）。
 * 3. 这一轮真的动过题目或实操。
 * 4. **没有任何缺口**，而且这门课至少有一道题或一个实操。一份"零交付物"的签收等于
 *    承诺了一份没有考核的设计——而下一步（审核与导出）会把它当成已经定稿的输入。
 */
export function shouldConfirmAssessment(input: {
  confirmRequested: boolean;
  userTurns: number;
  gaps: readonly { text: string }[];
  changedAnything: boolean;
  artifactCount: number;
  itemCount: number;
}): boolean {
  if (!input.confirmRequested) return false;
  if (input.userTurns < 2) return false;
  if (!input.changedAnything) return false;
  if (input.gaps.length > 0) return false;
  if (input.artifactCount === 0) return false;
  return input.itemCount > 0;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/** 验证规则在提示词与面板里的读法：**判的是什么**，而不是存的哪个字段。 */
export function describeVerifyRule(rule: LabVerifyRule): string {
  // Read through `labVerifyTargetOf`, which reads **only** the field the kind owns.
  // Falling back through the other six would print a `value` that a `file_read`
  // rule will never look at — showing a condition the grader does not check.
  return `${labVerifyKindLabel(rule.kind)}：${labVerifyTargetOf(rule) || '（空）'}`;
}

/**
 * 这一步的现状，供提示词与面板共用。
 *
 * 每个条目给出：角色、学时、承担的目标与承担方式，以及**已经挂上去的题目和实操的 id**。
 * 打印 id 是必须的：模型要改一道题、删一道题，都只能靠 id 指名；不打印，它就会再写
 * 一道一模一样的（于是同一道题在课程里出现两次）。
 */
export function formatAssessmentPlan(board: AssessmentBoard): string {
  if (board.items.length === 0) return '(还没有条目：题目与实操挂在条目上，先在大纲阶段排出条目)';
  const blocks: string[] = [];
  for (const item of board.items) {
    const lines: string[] = [
      `ref=${item.id}  【${ROLE_LABELS[item.role]}】${item.title}${
        item.hours === null ? '' : `（${item.hours} 学时）`
      }`,
    ];
    lines.push(
      item.objectives.length === 0
        ? '    承担的目标：无（缺口：先在大纲里给它挂目标，题目才有地方挂）'
        : `    承担的目标：${item.objectives
            .map(
              (row) =>
                `${row.id}(${row.title})[${row.kinds
                  .map((kind) => COVERAGE_KIND_LABELS[kind])
                  .join('/')}]`,
            )
            .join('、')}`,
    );
    const questions = board.questions.filter((row) => row.unitId === item.id);
    lines.push(
      questions.length === 0
        ? '    已有题目：无'
        : `    已有题目：\n${questions
            .map(
              (row) =>
                `      ${row.id}｜${QUESTION_TYPE_LABELS[row.questionType]}｜${row.stem}｜` +
                `答案 ${row.answer.join('/')}｜目标 ${row.objectiveId}`,
            )
            .join('\n')}`,
    );
    const labs = board.labTasks.filter((row) => row.unitId === item.id);
    lines.push(
      labs.length === 0
        ? '    已有实操：无'
        : `    已有实操：\n${labs
            .map(
              (row) =>
                `      ${row.id}｜${ASSESSMENT_MODE_LABELS[row.assessmentMode]}｜${row.taskGoal}｜` +
                `镜像 ${row.dockerImage}｜验证 ${row.verifyRules.map(describeVerifyRule).join('；') || '（无）'}`,
            )
            .join('\n')}`,
    );
    blocks.push(lines.join('\n'));
  }

  const objectiveLines = board.objectives.map((objective) => {
    const evidence = objective.evidence
      .map(
        (row) =>
          `${row.id}(${row.evidenceType}${row.assessmentMode === 'exam' ? '/考试' : '/练习'}：${row.successCondition})`,
      )
      .join('、');
    return `- ${objective.id}(${objective.title})：${evidence || '（没有证据——先回第二步补）'}`;
  });

  return [
    blocks.join('\n\n'),
    '',
    '## 目标与它们的证据（evidenceRef 用这里的 id；题目默认绑定唯一的对口证据）',
    objectiveLines.length === 0 ? '(还没有目标)' : objectiveLines.join('\n'),
  ].join('\n');
}
