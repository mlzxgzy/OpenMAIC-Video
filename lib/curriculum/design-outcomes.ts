/**
 * 第二步「学习目标与考核标准」的领域规则。
 *
 * 与第一步的本质区别：第一步是**七格固定的卡片**，第二步是一份**会增长、有序、
 * 可增删的清单**。所以规则的重心也不同——
 *
 * - 第一步的难题是"不要改到用户没要求改的格子"，第二步的难题是**不要用新一轮对话
 *   把上一轮的成果悄悄改掉**。清单没有"只写这一格"这个安全阀：模型每次重述五条
 *   目标，其中一条措辞微调，用户看不出，而 `verifiable` 可能因此从 true 翻成
 *   false。所以 {@link mergeOutcomePatch} 要求模型带 `ref` 指名要动哪一条，改不着的
 *   条目一律不动。
 * - 第二步真正的质量底线是**每个目标都要可验证且有证据**。store 的
 *   `phaseCompletionGaps('graph')` 已经检查"有目标、且每个目标都有证据"，本文件
 *   把同一句话的三个判定（缺目标 / 不可验证 / 无证据）给成**可执行的说法**：说
 *   "第 2 条目标没有可观察行为和最低标准" 可以照做，说"存在不可验证目标" 不行。
 *
 * 和第一步同样的取舍：规则只有一份定义，提示词、解析、卡片渲染、门禁全部从这里读。
 */
import {
  CURRICULUM_ASSESSMENT_MODES,
  CURRICULUM_EVIDENCE_TYPES,
  CURRICULUM_HINT_POLICIES,
  CURRICULUM_OBJECTIVE_TYPES,
  type CurriculumAssessmentMode,
  type CurriculumEvidenceRecord,
  type CurriculumEvidenceType,
  type CurriculumHintPolicy,
  type CurriculumObjectiveType,
} from './design-types';

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 目标类型的中文名，提示词与界面共用一份。 */
export const OUTCOME_TYPE_LABELS: Record<CurriculumObjectiveType, string> = {
  knowledge: '知识',
  skill: '技能',
  competency: '能力',
  task: '任务',
};

/** 证据类型的中文名。 */
export const EVIDENCE_TYPE_LABELS: Record<CurriculumEvidenceType, string> = {
  quiz: '理论题',
  lab: '实操靶场',
  performance: '表现',
  dialogue: '对话',
  artifact: '产出物',
};

/** 考核方式的中文名。 */
export const ASSESSMENT_MODE_LABELS: Record<CurriculumAssessmentMode, string> = {
  practice: '训练',
  exam: '考试',
};

/** 提示的中文名。 */
export const HINT_POLICY_LABELS: Record<CurriculumHintPolicy, string> = {
  unlimited: '允许无限提示',
  limited: '限制提示',
  forbidden: '禁止提示',
};

/** 第二步的一格清单：一条学习目标 + 挂在它下面的证据。 */
export interface OutcomeDraft {
  /** 目标标题。清单里每条都要有，所以它在写入前就是硬要求。 */
  title: string;
  objectiveType: CurriculumObjectiveType;
  /** 可观察行为：`title` 之外真正让目标可验证的那一句。 */
  expectedBehavior: string;
  minCriteria: string[];
  description?: string | null;
  evidence: EvidenceDraft[];
}

export interface EvidenceDraft {
  evidenceType: CurriculumEvidenceType;
  /** 怎么验，例如"提交 flag 并自动比对"。 */
  verificationMethod: string;
  /** 什么算通过，例如"独立完成注入并读出 flag"。 */
  successCondition: string;
  assessmentMode: CurriculumAssessmentMode;
  hintPolicy: CurriculumHintPolicy;
  independent: boolean;
}

/** 一次写入的结果。 */
export interface OutcomeAnswer {
  message: string;
  /** 要新建的目标；空数组表示这轮不新建。 */
  added: OutcomeDraft[];
  /** 要改的目标，`ref` 指名，缺 `title` 的条目会被丢弃。 */
  updated: OutcomePatch[];
  /** 要删的目标，`ref` 指名。 */
  removed: string[];
  /** 要挂到已有目标上的证据，`ref` 指名目标。 */
  evidence: EvidenceBinding[];
  confirmRequested: boolean;
  rejectedRefs: string[];
}

export interface OutcomePatch {
  ref: string;
  title?: string;
  objectiveType?: CurriculumObjectiveType;
  expectedBehavior?: string;
  minCriteria?: string[];
  description?: string | null;
}

export interface EvidenceBinding {
  ref: string;
  evidenceType: CurriculumEvidenceType;
  verificationMethod: string;
  successCondition: string;
  assessmentMode?: CurriculumAssessmentMode;
  hintPolicy?: CurriculumHintPolicy;
  independent?: boolean;
}

// ── 模型输出 ────────────────────────────────────────────────────────────────

export class OutcomeAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutcomeAnswerError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取一行文本；空串算 null，"模型表示这格我不知道"。 */
function textOf(value: unknown): string | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

/** 文本数组：接受字符串数组，也接受换行分隔的单串（中文对话里模型常这么写）。 */
export function criteriaListOf(value: unknown): string[] | undefined {
  if (value === null) return [];
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '')
      .map((entry) => entry.trim());
  }
  if (typeof value === 'string') {
    return value
      .split(/\r?\n|；|;/)
      .map((entry) => entry.trim())
      .filter((entry) => entry !== '');
  }
  return undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** 目标类型：缺省 `skill`——课程承诺的绝大多数是"能做什么"，不是"知道什么"。 */
function objectiveTypeOf(value: unknown): CurriculumObjectiveType {
  return oneOf(value, CURRICULUM_OBJECTIVE_TYPES) ?? 'skill';
}

/**
 * 清洗模型给的证据。
 *
 * 与第一步同一条原则：**目标标题和可观察行为必须齐**，因为 `verifiable` 完全由这两
 * 项决定（`deriveVerifiability`）。一条没有行为的证据进来，等于一条"检验该目标已经
 * 达成"的空壳记录，而它恰好能让 `phaseCompletionGaps('graph')` 的"每个目标都有证据"
 * 通过——**一条没用的证据会把门禁骗过去**。所以这里对缺项直接丢弃，不做默认值。
 */
export function sanitizeEvidence(raw: unknown): {
  evidence: EvidenceDraft | null;
  rejected: boolean;
} {
  if (!isRecord(raw)) return { evidence: null, rejected: true };
  const evidenceType = oneOf(raw.evidenceType, CURRICULUM_EVIDENCE_TYPES);
  const verificationMethod = textOf(raw.verificationMethod);
  const successCondition = textOf(raw.successCondition);
  if (!evidenceType || !verificationMethod || !successCondition) {
    return { evidence: null, rejected: true };
  }
  return {
    evidence: {
      evidenceType,
      verificationMethod,
      successCondition,
      assessmentMode: oneOf(raw.assessmentMode, CURRICULUM_ASSESSMENT_MODES) ?? 'practice',
      // 训练可提示、考场不给提示——这是两条默认线，也是用户改一句就能改的。
      hintPolicy:
        oneOf(raw.hintPolicy, CURRICULUM_HINT_POLICIES) ??
        (oneOf(raw.assessmentMode, CURRICULUM_ASSESSMENT_MODES) === 'exam'
          ? 'forbidden'
          : 'unlimited'),
      independent: typeof raw.independent === 'boolean' ? raw.independent : true,
    },
    rejected: false,
  };
}

/**
 * 清洗模型给的一条新目标。
 *
 * 拒绝条件只有一条：**标题或可观察行为缺失**。`minCriteria` 缺省是空的——它让目标
 * 落库为"不可验证"，而这正是 UI 要显示、让用户补一句的可见状态；反过来，一条空的
 * `evidence` 却能骗过门禁的"每个目标都有证据"检查（见 {@link sanitizeEvidence}）。
 */
export function sanitizeObjective(raw: unknown): { draft: OutcomeDraft | null; rejected: boolean } {
  if (!isRecord(raw)) return { draft: null, rejected: true };
  const title = textOf(raw.title);
  const expectedBehavior = textOf(raw.expectedBehavior);
  if (!title || !expectedBehavior) return { draft: null, rejected: true };
  const rawEvidence = Array.isArray(raw.evidence) ? raw.evidence : [];
  const evidence: EvidenceDraft[] = [];
  for (const entry of rawEvidence) {
    const { evidence: one } = sanitizeEvidence(entry);
    if (one) evidence.push(one);
  }
  return {
    draft: {
      title,
      objectiveType: objectiveTypeOf(raw.objectiveType),
      expectedBehavior,
      minCriteria: criteriaListOf(raw.minCriteria) ?? [],
      description: textOf(raw.description) ?? null,
      evidence,
    },
    rejected: false,
  };
}

/**
 * 清洗"要改的条目"。
 *
 * **必须有 `ref`**，且 `ref` 要能对上清单里某一条。理由见文件头：清单没有"只写这一
 * 格"的安全阀，所以模型只能**指名道姓地改**，指不着的改动没有归属，宁可丢弃并记
 * `rejectedRefs`，也不让一次"整体润色"改掉用户读过的东西。
 */
export function sanitizeOutcomePatch(raw: unknown): {
  patch: OutcomePatch | null;
  rejected: boolean;
} {
  if (!isRecord(raw)) return { patch: null, rejected: true };
  const ref = textOf(raw.ref);
  if (!ref) return { patch: null, rejected: true };
  const patch: OutcomePatch = { ref };
  if ('title' in raw) {
    const title = textOf(raw.title);
    if (title === undefined || title === null) return { patch: null, rejected: true };
    patch.title = title;
  }
  if ('objectiveType' in raw) {
    const type = oneOf(raw.objectiveType, CURRICULUM_OBJECTIVE_TYPES);
    if (!type) return { patch: null, rejected: true };
    patch.objectiveType = type;
  }
  if ('expectedBehavior' in raw) {
    const behavior = textOf(raw.expectedBehavior);
    if (behavior === undefined || behavior === null) return { patch: null, rejected: true };
    patch.expectedBehavior = behavior;
  }
  if ('minCriteria' in raw) {
    const criteria = criteriaListOf(raw.minCriteria);
    if (criteria === undefined) return { patch: null, rejected: true };
    patch.minCriteria = criteria;
  }
  if ('description' in raw) patch.description = textOf(raw.description) ?? null;
  // A patch that changes nothing is not a refusal, but it is not a write either:
  // `title` is required and a patch with no fields would send a null title.
  const fields = ['title', 'objectiveType', 'expectedBehavior', 'minCriteria'] as const;
  if (!fields.some((field) => patch[field] !== undefined)) {
    return { patch: null, rejected: true };
  }
  return { patch, rejected: false };
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/** 模型回答的 JSON 形状：`{ message, added, updated, removed, evidence, confirm }`。 */
export function parseOutcomeAnswer(text: string): OutcomeAnswer {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new OutcomeAnswerError('模型没有返回 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new OutcomeAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) throw new OutcomeAnswerError('模型返回的不是一个 JSON 对象');

  const added: OutcomeDraft[] = [];
  const updated: OutcomePatch[] = [];
  const evidence: EvidenceBinding[] = [];
  const rejectedRefs: string[] = [];
  const removed: string[] = [];

  for (const entry of asArray(parsed.added)) {
    const { draft, rejected } = sanitizeObjective(entry);
    if (draft) added.push(draft);
    if (rejected) rejectedRefs.push(`新增条目${describeRef(entry)}被丢弃`);
  }
  for (const entry of asArray(parsed.updated)) {
    const { patch } = sanitizeOutcomePatch(entry);
    if (patch) updated.push(patch);
    else rejectedRefs.push(`改不动的条目：${describeRef(entry)}`);
  }
  for (const entry of asArray(parsed.evidence)) {
    if (!isRecord(entry)) {
      rejectedRefs.push('证据条目不是一个对象');
      continue;
    }
    const ref = textOf(entry.ref);
    if (!ref) {
      rejectedRefs.push('证据条目缺少 ref');
      continue;
    }
    const { evidence: one } = sanitizeEvidence(entry);
    if (!one) {
      rejectedRefs.push(`${ref} 的证据缺少检验方式或成功条件`);
      continue;
    }
    evidence.push({
      ref,
      evidenceType: one.evidenceType,
      verificationMethod: one.verificationMethod,
      successCondition: one.successCondition,
      assessmentMode: one.assessmentMode,
      hintPolicy: one.hintPolicy,
      independent: one.independent,
    });
  }
  for (const entry of asArray(parsed.removed)) {
    const ref = textOf(entry);
    if (ref) removed.push(ref);
    else rejectedRefs.push('删除条目缺少 ref');
  }

  return {
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    added,
    updated,
    removed,
    evidence,
    confirmRequested: parsed.confirm === true,
    rejectedRefs,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The model's own name for the entry it got wrong, so the log says which one. */
function describeRef(raw: unknown): string | null {
  const record = isRecord(raw) ? raw : null;
  const ref = record ? textOf(record.ref) : textOf(raw);
  return ref ?? '未署名条目';
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 把一轮对话应用到清单上，返回**每个 id 的最终意图**。
 *
 * 返回的是意图而不是记录，因为写库要按依赖顺序（先 patch 已有目标，才能把证据挂
 * 上去），而"这个 patch 落到哪条上"这件事必须先算清楚：清单里 id 和顺序都不是稳定
 * 的，`ref` 可能指到已删的条目上，也可能同一条被 patch 两次。规则只有三条：
 *
 * 1. **`removed` 优先。** 先删再改，否则"删掉的那条"又会被 patch 写回去。
 * 2. **同一条只接受最后一次 patch。** 模型在一次回答里对同一条给出两版改法时，后者
 *    是它真正的想法。
 * 3. **未命中的 ref 一律忽略并记账。** 不猜、不按位置套用——按位置套用就是"AI 悄悄
 *    改了用户读过的东西"，而那正是这一步最需要避免的失败。
 */
export function mergeOutcomePatch(
  current: readonly OutcomeRef[],
  answer: Pick<OutcomeAnswer, 'updated' | 'removed'>,
): { patches: Map<string, OutcomePatch>; removed: Set<string>; unmatchedRefs: string[] } {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const removed = new Set<string>();
  const unmatchedRefs: string[] = [];

  for (const ref of answer.removed) {
    if (byId.has(ref)) removed.add(ref);
    else unmatchedRefs.push(ref);
  }

  const patches = new Map<string, OutcomePatch>();
  for (const patch of answer.updated) {
    if (!byId.has(patch.ref)) {
      unmatchedRefs.push(patch.ref);
      continue;
    }
    if (removed.has(patch.ref)) {
      // Deleting wins: re-writing a row the same turn deleted would resurrect it
      // with a patch nobody asked for after the delete.
      continue;
    }
    patches.set(patch.ref, patch);
  }

  return { patches, removed, unmatchedRefs };
}

/** 一条目标在清单里的引用形式，就是模型能指名道姓用的 `ref`。 */
export interface OutcomeRef {
  id: string;
  title: string;
}

/**
 * {@link outcomeGaps} over records, for the surfaces that hold records rather than
 * the two parallel lists the rules take: the state payload both routes answer with,
 * and the workbench strip, which must not disagree with them.
 */
export function outcomeGapsOfRecords(
  objectives: readonly { id: string; title: string; verifiable: boolean }[],
  evidence: readonly { objectiveId: string }[],
): OutcomeGap[] {
  const evidenceIds = new Set(evidence.map((row) => row.objectiveId));
  return outcomeGaps(
    objectives.map((row) => ({ id: row.id, title: row.title })),
    objectives.filter((row) => !row.verifiable).map((row) => ({ id: row.id, title: row.title })),
    objectives
      .filter((row) => !evidenceIds.has(row.id))
      .map((row) => ({ id: row.id, title: row.title })),
  );
}

// ── 缺口 ────────────────────────────────────────────────────────────────────

export interface OutcomeGap {
  /** 目标 id；整体性缺口（没有目标）没有。 */
  ref?: string;
  /** 一句话说明，照着就能做。 */
  text: string;
}

/**
 * 目标清单还差什么，三类各说一次。
 *
 * 与 store 的 `phaseCompletionGaps('graph')` 是同一套判定的可执行说法：
 * 「还没有学习目标」/「第 N 条目标还只是标题，补一句可观察行为和至少一条最低标准」/
 * 「第 N 条目标还没有考核方式」/「第 N 条目标不可验证：…」。模型看到这些就能继续补，
 * 而不是收到"目标不完整"然后停下来问人。
 */
export function outcomeGaps(
  objectives: readonly OutcomeRef[],
  unverifiable: readonly { id: string; title: string }[] = [],
  unevidenced: readonly { id: string; title: string }[] = [],
): OutcomeGap[] {
  const gaps: OutcomeGap[] = [];
  if (objectives.length === 0) {
    gaps.push({ text: '还没有学习目标：先写下学生学完后能独立完成什么' });
    return gaps;
  }
  for (const objective of unverifiable) {
    gaps.push({
      ref: objective.id,
      text: `目标「${objective.title}」还没有可观察行为和最低标准，现在无法考核`,
    });
  }
  for (const objective of unevidenced) {
    gaps.push({
      ref: objective.id,
      text: `目标「${objective.title}」还没有考核方式：补一条证据，说明怎么验、什么算通过`,
    });
  }
  return gaps;
}

/**
 * 是否采纳模型声明的"用户已确认"，与第一步同一条底线。
 *
 * 两条确定性检查：用户第一句话不能确认（还没有清单可确认；数的是**用户轮次**而非
 * 总轮次，开场寒暄不是回答）、清单仍有缺口不能确认。另外多一条第二步特有的：
 * **这一轮必须真的动过清单**。没有新增、没有修改、没有删除、没有加证据的"确认"，
 * 是模型对一句"看起来还行"的附和，不是签收——签收的对象是这一轮的成果。
 */
export function shouldConfirmOutcomes(input: {
  confirmRequested: boolean;
  userTurns: number;
  /** 目标数与证据数，写入**之后**。 */
  objectiveCount: number;
  evidenceCount: number;
  gaps: readonly OutcomeGap[];
  /** 这一轮是否真的改了清单。 */
  changedAnything: boolean;
}): boolean {
  if (!input.confirmRequested) return false;
  if (input.userTurns < 2) return false;
  if (!input.changedAnything) return false;
  if (input.gaps.length > 0) return false;
  return input.objectiveCount > 0 && input.evidenceCount > 0;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 清单的纯文本形式，供提示词与 agent 工具共用。
 *
 * 刻意只给模型**清单和状态**，不给 id 之外的东西：`ref` 就是 id，而模型改一条就需要
 * 指名，所以清单必须稳定——它每轮重算一次，顺序跟着 `sortOrder`。
 */
export function formatOutcomeList(input: {
  objectives: readonly OutcomeRef[];
  unverifiable: readonly { id: string; title: string }[];
  unevidenced: readonly { id: string; title: string }[];
  evidenceByObjective: ReadonlyMap<string, readonly CurriculumEvidenceRecord[]>;
}): string {
  const lines = input.objectives.map((objective) => {
    const evidence = input.evidenceByObjective.get(objective.id) ?? [];
    const unverifiable = input.unverifiable.some((row) => row.id === objective.id);
    const evidenceText = evidence.length
      ? evidence
          .map(
            (row) =>
              `${EVIDENCE_TYPE_LABELS[row.evidenceType]}(${ASSESSMENT_MODE_LABELS[row.assessmentMode]})`,
          )
          .join('、')
      : '无';
    return [
      `ref=${objective.id}  ${unverifiable ? '[缺可验证要素] ' : ''}${objective.title}`,
      `    证据：${evidenceText}`,
    ].join('\n');
  });
  return ['当前学习目标清单（ref 是你唯一能引用的标识）', ...lines].join('\n');
}
