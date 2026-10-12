/**
 * 第五步「生成课程大纲」的领域规则。
 *
 * 这一步把**已经签收的**三样东西——学习目标、知识技能图、图上的先后关系——组织成
 * 章、节与条目。它是第一个"往已有承诺上落内容"的步骤，所以规则的重心和前几步都
 * 不同：
 *
 * 1. **单位是独立的行，覆盖是按条目合并的一整份。** store 里这两件事的语义是相反的：
 *    `createCurriculumUnit` / `updateCurriculumUnit` 是"一行写一行"，而
 *    `setCurriculumUnitCoverage` 是"删掉本任务全部覆盖再按传入的重建"。所以
 *    {@link mergeUnitCoverage} 按**条目**算意图：模型提到哪个条目，就只替换哪个条目
 *    的覆盖，其余条目原封不动。这一步的沉默失败比第三步更贵——覆盖是
 *    `outline → teaching` 门禁读的东西，少了一行"这个条目讲授这个目标"，门禁就会
 *    说"有目标没有被讲授"，而用户在大纲里看到的东西一点没变。
 *
 * 2. **凡是 store 会抛的，这里一律先丢掉。** 整轮对话在一个事务里写入，store 抛一次
 *    异常就回滚**全部**改动——包括模型写对的那几十条。所以章节带教学角色、条目没
 *    角色、父级不是章节、覆盖挂在章节上，这些都在规则层过滤并记账，让用户看到"这一
 *    条没写进去"，而不是让整轮白干。
 *
 * 3. **顺序在这里第一次变成真的。** 第三步把"谁先谁后"落成图上的有向边，
 *    `teachingOrder()` 只是把它推导出来给作者看；真正提交顺序的地方是
 *    `unit.orderIndex`，而那正是这一步写的字段。所以
 *    {@link outlineOrderConflicts} 会把"边说 A 在 B 前、大纲把 B 排在 A 前"算成缺口，
 *    而不是等审核在最后一步报出来。
 */
import {
  CURRICULUM_COVERAGE_DEPTHS,
  CURRICULUM_COVERAGE_KINDS,
  CURRICULUM_ORDER_CLAIM_EDGE_TYPES,
  CURRICULUM_UNIT_ROLES,
  CURRICULUM_UNIT_TYPES,
  type CurriculumCoverageDepth,
  type CurriculumCoverageKind,
  type CurriculumDependencyEdgeType,
  type CurriculumUnitRole,
  type CurriculumUnitType,
} from './design-types';

// ── 类型 ────────────────────────────────────────────────────────────────────

/**
 * 两种单元的中文名。
 *
 * 用户的课程结构是「章 → 节 → 目」，而库里只有两种 `unit_type`：`chapter` 与
 * `item`。所以**章和节都是 `chapter`**（靠 `parent_id` 分层），**目是 `item`**。
 * 这不是把三级压成两级：`parent_id` 本来就允许章节套章节，条目挂在最细的一层。
 * 区分它们的不是层级，而是职责——章节只归类，条目不归类、只教。
 */
export const UNIT_TYPE_LABELS: Record<CurriculumUnitType, string> = {
  chapter: '章节',
  item: '条目',
};

/** 条目角色的中文名。角色决定这条目生成什么，所以它是条目唯一的必填项。 */
export const UNIT_ROLE_LABELS: Record<CurriculumUnitRole, string> = {
  lecture: '讲授',
  practice: '练习',
  exam: '考试',
};

/** 覆盖类型的中文名：讲授、练习、考核是同一条目标的三种承诺。 */
export const COVERAGE_KIND_LABELS: Record<CurriculumCoverageKind, string> = {
  teach: '讲授',
  practice: '练习',
  assess: '考核',
};

/** 覆盖深度的中文名：决定讲到什么程度，也是"决定不讲什么"的另一种说法。 */
export const COVERAGE_DEPTH_LABELS: Record<CurriculumCoverageDepth, string> = {
  brief: '简要',
  standard: '标准',
  deep: '深入',
};

/** 一个要新建的单元，连同它自己声明要覆盖的目标。 */
export interface OutlineUnitDraft {
  /**
   * 这一轮里这条单元的名字，供同一轮的其他单元用 `parentRef` 指名。
   *
   * 与前几步的 `ref` 不同，这不是数据库 id（新行还没有 id），而是模型自己在这次回答
   * 里起的标签。章、节、目是**一次性一起给**的，不像知识点那样一条一条长出来，所以
   * 模型必须能在同一轮里指名"这个条目属于刚刚那个节"——否则一次回答里只能建一层。
   */
  ref: string | null;
  title: string;
  unitType: CurriculumUnitType;
  /** 条目必须有；章节必须没有。 */
  unitRole: CurriculumUnitRole | null;
  hours: number | null;
  /** 父级：已有单元的 id，或同一轮另一条 draft 的 `ref`。`null` 表示顶层。 */
  parentRef: string | null;
  /** 同层顺序，缺省按追加处理。 */
  order: number | null;
  coverage: OutlineCoverageDraft[];
}

export interface OutlineCoverageDraft {
  objectiveRef: string;
  coverageKind: CurriculumCoverageKind;
  depth: CurriculumCoverageDepth;
}

/** 要改的单元。`ref` 必须是已有单元的 id——draft 标签不能用来改。 */
export interface OutlineUnitPatch {
  ref: string;
  title?: string;
  unitRole?: CurriculumUnitRole;
  hours?: number | null;
  parentRef?: string | null;
  order?: number;
}

/**
 * 要替换的覆盖，按条目指名。
 *
 * `objectiveRef: null` 表示"这个条目到此还没有覆盖任何目标"，也就是把它清空——和第
 * 三步 `links` 里 `objectiveRef: null` 的写法同源：没有它，用户想摘掉一条挂错的覆盖
 * 就只能删掉整个条目重来。
 */
export interface OutlineCoverageBinding {
  ref: string;
  objectiveRef: string | null;
  coverageKind?: CurriculumCoverageKind;
  depth?: CurriculumCoverageDepth;
  note?: string | null;
}

export interface OutlineAnswer {
  message: string;
  added: OutlineUnitDraft[];
  updated: OutlineUnitPatch[];
  removed: string[];
  /** 要替换的覆盖，按条目指名。 */
  coverage: OutlineCoverageBinding[];
  confirmRequested: boolean;
  rejectedRefs: string[];
}

/** 一条单元在大纲里的引用形式，就是模型能指名道姓用的 `ref`。 */
export interface OutlineUnitRef {
  id: string;
  title: string;
  unitType: CurriculumUnitType;
  unitRole: CurriculumUnitRole | null;
  parentId: string | null;
  orderIndex: number;
  hours: number | null;
}

/** 覆盖在提示词里要显示的两端。 */
export interface OutlineCoverageRef {
  unitId: string;
  objectiveId: string;
  coverageKind: CurriculumCoverageKind;
  depth: CurriculumCoverageDepth;
}

export interface OutlineObjectiveRef {
  id: string;
  title: string;
}

// ── 模型输出 ────────────────────────────────────────────────────────────────

export class OutlineAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineAnswerError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 取一行文本；空串算 null（"清空这一格"），非字符串算 undefined（"这不是文本"）。 */
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

/** 非负数字，用来收 `hours`：`0` 合法（"这一项目标不需要单独学时"），负数不合法。 */
function nonNegativeNumber(value: unknown): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

/** 非负整数，用来收 `order`。小数不是顺序，是模型算错了。 */
function nonNegativeInt(value: unknown): number | null | undefined {
  const parsed = nonNegativeNumber(value);
  if (parsed === undefined || parsed === null) return parsed;
  return Number.isInteger(parsed) ? parsed : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 清洗模型给的一条覆盖。
 *
 * 章节不能承载覆盖，所以 `onChapter` 时整条丢掉并说明——审核的
 * `chapter_with_content` 会把它报成错误，而这里如果放过去，作者是在点下确认之后才
 * 从错误列表里知道，那时门禁已经开了。
 */
export function sanitizeCoverage(
  raw: unknown,
  options: { onChapter?: boolean; unitLabel?: string } = {},
): { coverage: OutlineCoverageDraft | null; reason?: string } {
  if (!isRecord(raw)) return { coverage: null, reason: '覆盖不是一个对象' };
  const objectiveRef = textOf(raw.objectiveRef);
  if (objectiveRef === undefined || objectiveRef === null) {
    return { coverage: null, reason: '覆盖缺少学习目标引用' };
  }
  if (options.onChapter) {
    // The database trigger refuses this row anyway, so a turn that sent one
    // would roll back everything else it got right. Losing the row and saying so
    // is the difference between "one row did not land" and "nothing landed".
    return {
      coverage: null,
      reason: `章节${options.unitLabel ? `「${options.unitLabel}」` : ''}不能承载教学覆盖：章节只做归类`,
    };
  }
  const coverageKind = oneOf(raw.coverageKind, CURRICULUM_COVERAGE_KINDS);
  if (!coverageKind) {
    return {
      coverage: null,
      reason: `覆盖「${objectiveRef}」的类型不是 teach/practice/assess`,
    };
  }
  const depth = oneOf(raw.depth, CURRICULUM_COVERAGE_DEPTHS);
  if (raw.depth !== undefined && raw.depth !== null && !depth) {
    return { coverage: null, reason: `覆盖「${objectiveRef}」的深度不是 brief/standard/deep` };
  }
  return { coverage: { objectiveRef, coverageKind, depth: depth ?? 'standard' } };
}

/**
 * 清洗一个要新建的单元。
 *
 * 拒绝条件就是 store 会抛的那几条：没有名称、条目没有角色、章节带了角色。这里不是
 * 重复 store 的判断，而是**故意提前**：一次对话写入几十个单元，一个坏单元让 store
 * 抛一次，整轮回滚，模型写对的部分一起没了。
 *
 * `unitType` 缺省取 `item` 而不是 `chapter`。取 `chapter` 看着更"弱"，但一个被误标成
 * 章节的条目会**静默地不教任何东西**（章节不承载覆盖，是合法状态），而一个被误标成
 * 条目的章节会立刻因为缺角色或缺覆盖被告出来。默认可错的代价要能看见。
 */
export function sanitizeUnitDraft(raw: unknown): {
  draft: OutlineUnitDraft | null;
  reason?: string;
  coverageRejections?: string[];
} {
  if (!isRecord(raw)) return { draft: null, reason: '单元不是一个对象' };
  const title = textOf(raw.title);
  if (!title) return { draft: null, reason: '单元缺少名称' };
  const unitType = oneOf(raw.unitType, CURRICULUM_UNIT_TYPES) ?? 'item';

  const roleGiven = raw.unitRole !== undefined && raw.unitRole !== null;
  const unitRole = oneOf(raw.unitRole, CURRICULUM_UNIT_ROLES);
  if (roleGiven && !unitRole) {
    return { draft: null, reason: `单元「${title}」的角色不是 lecture/practice/exam` };
  }
  if (unitType === 'chapter' && unitRole) {
    return { draft: null, reason: `单元「${title}」是章节却带了教学角色：章节只做归类` };
  }
  if (unitType === 'item' && !unitRole) {
    return { draft: null, reason: `单元「${title}」是条目却没有角色：需要 lecture/practice/exam` };
  }

  const hours = nonNegativeNumber(raw.hours);
  if (raw.hours !== undefined && hours === undefined) {
    return { draft: null, reason: `单元「${title}」的学时不是非负数` };
  }
  const order = nonNegativeInt(raw.order);
  if (raw.order !== undefined && raw.order !== null && order === undefined) {
    return { draft: null, reason: `单元「${title}」的顺序不是非负整数` };
  }
  const ref = textOf(raw.ref);
  if (raw.ref !== undefined && raw.ref !== null && ref === undefined) {
    return { draft: null, reason: `单元「${title}」的 ref 不是文本` };
  }
  const parentRef = textOf(raw.parentRef);
  if (raw.parentRef !== undefined && raw.parentRef !== null && parentRef === undefined) {
    return { draft: null, reason: `单元「${title}」的父级引用不是文本` };
  }

  // A bad coverage row drops the row, not the unit: the unit is real content the
  // author asked for, and a unit with no coverage is the *visible* "outline not
  // finished" state (`unit_orphan` and the gap list both report it). Rejecting
  // the unit would hide it.
  const coverage: OutlineCoverageDraft[] = [];
  const coverageRejections: string[] = [];
  for (const entry of asArray(raw.coverage)) {
    const { coverage: one, reason } = sanitizeCoverage(entry, {
      onChapter: unitType === 'chapter',
      unitLabel: title,
    });
    if (one) coverage.push(one);
    else coverageRejections.push(reason ?? `单元「${title}」的覆盖无效`);
  }

  return {
    draft: {
      ref: ref ?? null,
      title,
      unitType,
      unitRole: unitRole ?? null,
      hours: hours ?? null,
      parentRef: parentRef ?? null,
      order: order ?? null,
      coverage,
    },
    coverageRejections,
  };
}

/**
 * 清洗"要改的单元"。必须带 `ref`，理由同前两步：大纲上的静默改动最难发现。
 *
 * 一个什么都没改的 patch 会被丢弃而不是记成一次改动——否则撤回签收的判断会把它算成
 * "这一轮动过大纲"。
 */
export function sanitizeUnitPatch(raw: unknown): {
  patch: OutlineUnitPatch | null;
  reason?: string;
} {
  if (!isRecord(raw)) return { patch: null, reason: '要改的单元不是一个对象' };
  const ref = textOf(raw.ref);
  if (!ref) return { patch: null, reason: '要改的单元缺少 ref' };
  const patch: OutlineUnitPatch = { ref };
  if ('title' in raw) {
    const title = textOf(raw.title);
    if (!title) return { patch: null, reason: `单元 ${ref} 的新名称为空` };
    patch.title = title;
  }
  if ('unitRole' in raw) {
    const unitRole = oneOf(raw.unitRole, CURRICULUM_UNIT_ROLES);
    if (!unitRole) return { patch: null, reason: `单元 ${ref} 的角色不是 lecture/practice/exam` };
    patch.unitRole = unitRole;
  }
  if ('hours' in raw) {
    const hours = nonNegativeNumber(raw.hours);
    if (hours === undefined) return { patch: null, reason: `单元 ${ref} 的学时不是非负数` };
    patch.hours = hours;
  }
  if ('parentRef' in raw) {
    const parentRef = textOf(raw.parentRef);
    if (parentRef === undefined) return { patch: null, reason: `单元 ${ref} 的父级引用不是文本` };
    patch.parentRef = parentRef;
  }
  if ('order' in raw) {
    const order = nonNegativeInt(raw.order);
    if (order === undefined || order === null) {
      return { patch: null, reason: `单元 ${ref} 的顺序不是非负整数` };
    }
    patch.order = order;
  }
  const fields = ['title', 'unitRole', 'hours', 'parentRef', 'order'] as const;
  if (!fields.some((field) => patch[field] !== undefined)) {
    return { patch: null, reason: `单元 ${ref} 的改动是空的` };
  }
  return { patch };
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * 这一步明确不接的字段：页面规划、教学设计、题目。
 *
 * 写在这里而不是提示词里，是为了能被测试。`outline → teaching` 是一道真的门禁：
 * 教学设计属于下一个阶段，题目属于再下一个。让模型在这里顺手写一份页面规划，等于
 * 让它在没有逐条教学设计的情况下先把页面定死。
 */
const OUT_OF_SCOPE_KEYS = [
  'pages',
  'deckDesign',
  'teachingDesign',
  'slides',
  'questions',
  'quiz',
] as const;

/**
 * 模型回答的 JSON 形状：
 * `{ message, added, updated, removed, coverage, confirm }`。
 */
export function parseOutlineAnswer(text: string): OutlineAnswer {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new OutlineAnswerError('模型没有返回 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new OutlineAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) throw new OutlineAnswerError('模型返回的不是一个 JSON 对象');

  const rejectedRefs: string[] = [];
  for (const key of OUT_OF_SCOPE_KEYS) {
    if (key in parsed) {
      rejectedRefs.push(`「${key}」不在这一步的范围内，已忽略：教学设计与题目是后面步骤的事`);
    }
  }

  const added: OutlineUnitDraft[] = [];
  const draftRefs = new Set<string>();
  for (const entry of asArray(parsed.added)) {
    const { draft, reason, coverageRejections } = sanitizeUnitDraft(entry);
    if (!draft) {
      if (reason) rejectedRefs.push(reason);
      continue;
    }
    if (draft.ref !== null) {
      if (draftRefs.has(draft.ref)) {
        rejectedRefs.push(`新增单元「${draft.title}」的 ref「${draft.ref}」在同一轮里重复`);
      }
      draftRefs.add(draft.ref);
    }
    added.push(draft);
    rejectedRefs.push(...(coverageRejections ?? []));
  }

  const updated: OutlineUnitPatch[] = [];
  for (const entry of asArray(parsed.updated)) {
    const { patch, reason } = sanitizeUnitPatch(entry);
    if (patch) updated.push(patch);
    else if (reason) rejectedRefs.push(reason);
  }

  const removed: string[] = [];
  for (const entry of asArray(parsed.removed)) {
    const ref = typeof entry === 'string' ? textOf(entry) : null;
    if (ref) removed.push(ref);
    else rejectedRefs.push('删除条目缺少 ref');
  }

  const coverage: OutlineCoverageBinding[] = [];
  for (const entry of asArray(parsed.coverage)) {
    if (!isRecord(entry)) {
      rejectedRefs.push('覆盖不是一个对象');
      continue;
    }
    const ref = textOf(entry.ref);
    if (!ref) {
      rejectedRefs.push('覆盖缺少它所属条目的 ref');
      continue;
    }
    const objectiveRef = textOf(entry.objectiveRef);
    if (objectiveRef === undefined) {
      rejectedRefs.push(`条目 ${ref} 的覆盖缺少学习目标引用`);
      continue;
    }
    if (objectiveRef === null) {
      // An explicit clear: kind and depth are meaningless without a goal.
      coverage.push({ ref, objectiveRef: null });
      continue;
    }
    const coverageKind = oneOf(entry.coverageKind, CURRICULUM_COVERAGE_KINDS);
    if (!coverageKind) {
      rejectedRefs.push(`条目 ${ref} 对「${objectiveRef}」的覆盖不是 teach/practice/assess`);
      continue;
    }
    const depth = oneOf(entry.depth, CURRICULUM_COVERAGE_DEPTHS);
    if (entry.depth !== undefined && entry.depth !== null && !depth) {
      rejectedRefs.push(`条目 ${ref} 对「${objectiveRef}」的深度不是 brief/standard/deep`);
      continue;
    }
    const note = textOf(entry.note);
    if (entry.note !== undefined && note === undefined) {
      rejectedRefs.push(`条目 ${ref} 对「${objectiveRef}」的备注不是文本`);
      continue;
    }
    coverage.push({
      ref,
      objectiveRef,
      coverageKind,
      depth: depth ?? 'standard',
      ...(note === undefined ? {} : { note }),
    });
  }

  return {
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    added,
    updated,
    removed,
    coverage,
    confirmRequested: parsed.confirm === true,
    rejectedRefs,
  };
}

// ── 写入意图 ────────────────────────────────────────────────────────────────

/**
 * 把一轮对话应用到已有大纲上，返回**每个 id 的最终意图**。
 *
 * 规则与前两步同源：删除优先、同一条只认最后一次 patch、未命中的 `ref` 一律丢弃并
 * 记账。这里多一条：**draft 的 `ref` 不能用来改已有单元**——那是模型自己起的一次性
 * 标签，跨轮没有意义；把它当 id 用就是在改一个"恰好同名的单元"。
 */
export function mergeOutlinePatch(
  current: readonly OutlineUnitRef[],
  answer: Pick<OutlineAnswer, 'updated' | 'removed'>,
): { patches: Map<string, OutlineUnitPatch>; removed: Set<string>; unmatchedRefs: string[] } {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const removed = new Set<string>();
  const unmatchedRefs: string[] = [];

  for (const ref of answer.removed) {
    if (byId.has(ref)) removed.add(ref);
    else unmatchedRefs.push(ref);
  }

  const patches = new Map<string, OutlineUnitPatch>();
  for (const patch of answer.updated) {
    if (!byId.has(patch.ref)) {
      unmatchedRefs.push(patch.ref);
      continue;
    }
    if (removed.has(patch.ref)) continue;
    patches.set(patch.ref, patch);
  }

  return { patches, removed, unmatchedRefs };
}

export interface PlannedUnitCreate {
  draft: OutlineUnitDraft;
  /** 父级已经存在时是它的 id；父级是本轮的另一条 draft 时是 `null`。 */
  parentId: string | null;
  /** 父级是本轮另一条 draft 时，它的 `ref`——写库时要换成本轮拿到的新 id。 */
  parentDraftRef: string | null;
  orderIndex: number;
}

export interface PlannedUnitUpdate {
  unitId: string;
  patch: OutlineUnitPatch;
  /** `undefined` 表示这条 patch 没动父级。 */
  parentId: string | null | undefined;
  /** 父级指向本轮新建的单元时，那条 draft 的 `ref`。 */
  parentDraftRef: string | null;
  orderIndex: number | undefined;
}

/**
 * 把新增与修改解析成可以直接写库的意图。
 *
 * 三件事必须在这里定下来，写库时再算就晚了：
 *
 * 1. **父级引用可能是同一轮的另一个 draft。** 章、节、目一次给全，所以
 *    `parentRef` 可以指向 `added` 里某条的 `ref`。指向**后面**的 draft 也被允许：
 *    模型按"目在前、节在后"的顺序列出来是很自然的，规则层不该因此丢掉整个子树。
 * 2. **父级必须是章节。** 条目不能挂在条目下，章节也不能挂在条目下——`parent_id`
 *    在库里没有这条约束，所以它是规则层的责任；放过去的话，大纲从外面看是棵树，从
 *    审核的角度却是一堆互相矛盾的分组。
 * 3. **顺序缺省是追加。** 同一父级下已有的最大 `orderIndex` 加一，再加上同一轮里
 *    已经排进去的兄弟数。缺省不去猜"应该插在哪"，因为猜错的表现是用户读到的顺序
 *    和他说过的不一样。
 */
export function planUnitWrites(input: {
  current: readonly OutlineUnitRef[];
  removed: ReadonlySet<string>;
  drafts: readonly OutlineUnitDraft[];
  patches: ReadonlyMap<string, OutlineUnitPatch>;
}): {
  creates: PlannedUnitCreate[];
  updates: PlannedUnitUpdate[];
  unmatchedRefs: string[];
} {
  const byId = new Map(input.current.map((entry) => [entry.id, entry]));
  const unmatchedRefs: string[] = [];

  const draftByRef = new Map<string, OutlineUnitDraft>();
  for (const draft of input.drafts) {
    if (draft.ref !== null && !draftByRef.has(draft.ref)) draftByRef.set(draft.ref, draft);
  }

  /**
   * 下一个可用的同层顺序号。
   *
   * 按"父级 key"分组：已有单元用 `u:<id>`，本轮新建的父级用 `d:<ref>`，顶层用
   * `root`。缺省是追加，所以起点是现有兄弟里最大的 `orderIndex` 加一——注意
   * `curriculum_unit` 没有"每层从 0 开始"的约束，同一父级下的顺序号只是一条相对
   * 次序，缺省的职责就是不要插到别人前面去。
   */
  const nextOrder = new Map<string, number>();
  const parentKey = (unitId: string | null, draftRef: string | null): string =>
    unitId !== null ? `u:${unitId}` : draftRef !== null ? `d:${draftRef}` : 'root';
  const orderFor = (
    unitId: string | null,
    draftRef: string | null,
    explicit: number | null,
  ): number => {
    const key = parentKey(unitId, draftRef);
    let next = nextOrder.get(key);
    if (next === undefined) {
      next = 0;
      // A draft parent has no stored children at all, so there is nothing to
      // append to; only an existing parent (or the top level) contributes.
      if (draftRef === null) {
        for (const unit of input.current) {
          if (input.removed.has(unit.id)) continue;
          if ((unit.parentId ?? null) !== unitId) continue;
          if (unit.orderIndex >= next) next = unit.orderIndex + 1;
        }
      }
    }
    const chosen = explicit ?? next;
    nextOrder.set(key, Math.max(next, chosen + 1));
    return chosen;
  };

  const resolved: {
    draft: OutlineUnitDraft;
    parentId: string | null;
    parentDraftRef: string | null;
    orderIndex: number;
  }[] = [];

  for (const draft of input.drafts) {
    let parentId: string | null = null;
    let parentDraftRef: string | null = null;
    if (draft.parentRef !== null) {
      const existing = byId.get(draft.parentRef);
      if (existing) {
        if (input.removed.has(existing.id)) {
          // Writing a child under a row this same turn deletes is a foreign key
          // violation, and a violation rolls back everything.
          unmatchedRefs.push(`${draft.title}→${draft.parentRef}（父级这一轮被删掉了）`);
          continue;
        }
        if (existing.unitType !== 'chapter') {
          unmatchedRefs.push(`${draft.title}→${draft.parentRef}（父级不是章节）`);
          continue;
        }
        parentId = existing.id;
      } else {
        const parentDraft = draftByRef.get(draft.parentRef);
        if (!parentDraft) {
          unmatchedRefs.push(`${draft.title}→${draft.parentRef}`);
          continue;
        }
        if (parentDraft.unitType !== 'chapter') {
          unmatchedRefs.push(`${draft.title}→${draft.parentRef}（父级不是章节）`);
          continue;
        }
        parentDraftRef = draft.parentRef;
      }
    }
    resolved.push({
      draft,
      parentId,
      parentDraftRef,
      orderIndex: orderFor(parentId, parentDraftRef, draft.order),
    });
  }

  /**
   * 父级在本轮 draft 之间的引用要先排出序：父级必须先写，子级才能挂上去。
   *
   * 允许**向前引用**（`added` 里目在节前面是自然的写法），所以这里做一次拓扑排序，
   * 而不是假设数组顺序就是父先子后。draft 之间互相指父级则是一个环——那两条都写不
   * 进去（谁会先存在？），所以丢掉并记账，理由和第三步丢环边一样：整轮在一个事务里，
   * 写不进去的东西不能让它带走写对的部分。注意丢掉的是**环上的那几条**，环外的照写。
   */
  const byDraftRef = new Map<string, (typeof resolved)[number]>();
  for (const entry of resolved) {
    if (entry.draft.ref !== null && !byDraftRef.has(entry.draft.ref)) {
      byDraftRef.set(entry.draft.ref, entry);
    }
  }

  const order: (typeof resolved)[number][] = [];
  const state = new Map<OutlineUnitDraft, 0 | 1 | 2>();
  const visit = (entry: (typeof resolved)[number]): boolean => {
    const current = state.get(entry.draft) ?? 0;
    if (current === 2) return true;
    if (current === 1) return false;
    state.set(entry.draft, 1);
    if (entry.parentDraftRef !== null) {
      const parent = byDraftRef.get(entry.parentDraftRef);
      if (parent && parent !== entry && !visit(parent)) {
        state.set(entry.draft, 2);
        unmatchedRefs.push(
          `${entry.draft.title}（父级引用成环：${entry.parentDraftRef} 又挂在它下面）`,
        );
        return false;
      }
    }
    state.set(entry.draft, 2);
    order.push(entry);
    return true;
  };
  for (const entry of resolved) visit(entry);

  const creates: PlannedUnitCreate[] = order.map((entry) => ({
    draft: entry.draft,
    parentId: entry.parentId,
    parentDraftRef: entry.parentDraftRef,
    orderIndex: entry.orderIndex,
  }));

  const updates: PlannedUnitUpdate[] = [];
  for (const [unitId, patch] of input.patches) {
    const current = byId.get(unitId);
    if (!current) continue;
    let parentId: string | null | undefined;
    let parentDraftRef: string | null = null;
    if (patch.parentRef !== undefined) {
      if (patch.parentRef === null) {
        parentId = null;
      } else {
        const parent = byId.get(patch.parentRef);
        if (parent) {
          if (!input.removed.has(parent.id) && parent.unitType === 'chapter') {
            parentId = parent.id;
          } else {
            unmatchedRefs.push(
              `${current.title}→${patch.parentRef}（父级不是章节或这一轮被删掉了）`,
            );
            continue;
          }
        } else {
          const parentDraft = draftByRef.get(patch.parentRef);
          if (!parentDraft) {
            unmatchedRefs.push(`${current.title}→${patch.parentRef}`);
            continue;
          }
          if (parentDraft.unitType !== 'chapter') {
            unmatchedRefs.push(`${current.title}→${patch.parentRef}（父级不是章节）`);
            continue;
          }
          // Moving an existing row under a section created in this same turn is
          // exactly what reorganising an outline looks like, so this is allowed
          // rather than pushed back to `added`.
          parentDraftRef = patch.parentRef;
        }
      }
    }
    if (current.unitType === 'chapter' && patch.unitRole !== undefined) {
      unmatchedRefs.push(`${current.title}（章节不能有教学角色）`);
      continue;
    }
    updates.push({ unitId, patch, parentId, parentDraftRef, orderIndex: patch.order });
  }

  return { creates, updates, unmatchedRefs };
}

/**
 * 这一轮之后，哪些条目的覆盖要**整份替换**。
 *
 * 返回的 map 里没有出现的条目，覆盖保持原样——这正是"整表替换会把用户读过的大纲
 * 悄悄拆掉"的解药。指向不存在目标的覆盖、挂在章节上的覆盖、角色对不上的覆盖都在
 * 这里丢弃并记账。
 */
export function mergeUnitCoverage(input: {
  coverageByUnit: ReadonlyMap<
    string,
    readonly { objectiveId: string; coverageKind: CurriculumCoverageKind }[]
  >;
  knownUnitIds: ReadonlySet<string>;
  knownObjectiveIds: ReadonlySet<string>;
  /** 单元的最终类型：本轮新建的条目也要能挂覆盖。 */
  unitTypeOf: (unitId: string) => CurriculumUnitType | null;
  removed: ReadonlySet<string>;
  proposed: readonly OutlineCoverageBinding[];
}): {
  replace: Map<
    string,
    {
      objectiveId: string;
      coverageKind: CurriculumCoverageKind;
      depth: CurriculumCoverageDepth;
      note: string | null;
    }[]
  >;
  unmatchedRefs: string[];
} {
  const replace = new Map<
    string,
    {
      objectiveId: string;
      coverageKind: CurriculumCoverageKind;
      depth: CurriculumCoverageDepth;
      note: string | null;
    }[]
  >();
  const unmatchedRefs: string[] = [];

  for (const entry of input.proposed) {
    if (!input.knownUnitIds.has(entry.ref)) {
      unmatchedRefs.push(entry.ref);
      continue;
    }
    if (input.removed.has(entry.ref)) continue;
    if (entry.objectiveRef === null) {
      // An explicit "this item covers nothing yet". It still replaces, because
      // the point is emptying an item that had coverage.
      if (!replace.has(entry.ref)) replace.set(entry.ref, []);
      continue;
    }
    if (input.unitTypeOf(entry.ref) === 'chapter') {
      unmatchedRefs.push(`${entry.ref}（章节不能承载覆盖）`);
      continue;
    }
    if (!input.knownObjectiveIds.has(entry.objectiveRef)) {
      unmatchedRefs.push(`${entry.ref}→${entry.objectiveRef}`);
      continue;
    }
    const kind = entry.coverageKind ?? 'teach';
    const list = replace.get(entry.ref) ?? [];
    // The store's natural key is (unit, objective, kind): two rows for it is a
    // conflict, not two facts.
    if (list.some((row) => row.objectiveId === entry.objectiveRef && row.coverageKind === kind)) {
      continue;
    }
    list.push({
      objectiveId: entry.objectiveRef,
      coverageKind: kind,
      depth: entry.depth ?? 'standard',
      note: entry.note ?? null,
    });
    replace.set(entry.ref, list);
  }

  return { replace, unmatchedRefs };
}

/** 每条目最终的覆盖集合：本轮替换的按模型给的，其余原样带过来。 */
export function collectCoverage(
  coverageByUnit: ReadonlyMap<
    string,
    readonly {
      objectiveId: string;
      coverageKind: CurriculumCoverageKind;
      depth: CurriculumCoverageDepth;
    }[]
  >,
  replace: ReturnType<typeof mergeUnitCoverage>['replace'],
  removed: ReadonlySet<string>,
): {
  unitId: string;
  objectiveId: string;
  coverageKind: CurriculumCoverageKind;
  depth: CurriculumCoverageDepth;
  note: string | null;
}[] {
  const out: {
    unitId: string;
    objectiveId: string;
    coverageKind: CurriculumCoverageKind;
    depth: CurriculumCoverageDepth;
    note: string | null;
  }[] = [];
  const unitIds = new Set([...coverageByUnit.keys(), ...replace.keys()]);
  for (const unitId of unitIds) {
    if (removed.has(unitId)) continue;
    const next = replace.get(unitId);
    if (next) {
      for (const row of next) out.push({ unitId, ...row });
      continue;
    }
    for (const row of coverageByUnit.get(unitId) ?? []) {
      out.push({
        unitId,
        objectiveId: row.objectiveId,
        coverageKind: row.coverageKind,
        depth: row.depth,
        note: null,
      });
    }
  }
  return out;
}

// ── 顺序 ────────────────────────────────────────────────────────────────────

/**
 * 一条顺序冲突：图上说 A 必须先于 B，大纲却把 B 排在了前面。
 *
 * `refId` 是那条边的 id，因为审核把冲突报在边上，作者要能顺着它定位。
 */
export interface OutlineOrderConflict {
  refId: string;
  sourceId: string;
  targetId: string;
  message: string;
}

/**
 * 大纲的交付顺序与图上声明的先后关系是否一致。
 *
 * 这是第三步那份承诺的兑付点。第三步把"谁先谁后"写成节点间的有向边，并推导出一个讲
 * 授顺序给作者看——但那只是**给作者看的**：真正提交顺序的地方是 `unit.orderIndex`，
 * 而那正是这一步写的字段。所以这里要回答的问题是：**最早讲授 A 的条目，是否早于最早
 * 讲授 B 的条目**（A → B 是一条先后边）。
 *
 * 三种边都不进这个判定：`related` / `composes` 不是顺序主张，`supports` 说的是互相
 * 支撑。这与 {@link CURRICULUM_ORDER_CLAIM_EDGE_TYPES} 是同一组，审核的
 * `dependency_out_of_order` 也读它——两份判断必须读同一组边，否则一个说合法、一个说
 * 违规，作者不知道该信谁。
 *
 * 目标级与节点级的边都在这里比：一条 `objective → objective` 的边直接比目标，一条
 * `node → node` 的边经由"节点支撑哪些目标"折到条目上。早期版本的审核只读前者，于是
 * 第三步写下的每一条先修关系都不被任何地方检查——承诺是真的，检查是空的。
 */
export function outlineOrderConflicts(input: {
  /** 只有条目有交付位置：章节是分类标签，不在某个时刻被讲授。 */
  items: readonly { id: string; orderIndex: number }[];
  /** 每个条目**讲授**哪些目标。只有 teach 是交付承诺，练习与考核发生在它之后。 */
  teachesByItem: ReadonlyMap<string, readonly string[]>;
  /** 每个节点支撑哪些目标，用来把节点级的先后关系折到条目上。 */
  objectivesByNode: ReadonlyMap<string, readonly string[]>;
  edges: readonly {
    id: string;
    sourceId: string;
    sourceKind: string;
    targetId: string;
    targetKind: string;
    edgeType: CurriculumDependencyEdgeType;
  }[];
  labelOf: (id: string) => string;
}): OutlineOrderConflict[] {
  const orderOfItem = new Map(input.items.map((item) => [item.id, item.orderIndex]));
  const itemsByObjective = new Map<string, string[]>();
  for (const [itemId, objectiveIds] of input.teachesByItem) {
    if (!orderOfItem.has(itemId)) continue;
    for (const objectiveId of objectiveIds) {
      const list = itemsByObjective.get(objectiveId) ?? [];
      list.push(itemId);
      itemsByObjective.set(objectiveId, list);
    }
  }

  const earliestOfObjective = (objectiveId: string): number | null => {
    const items = itemsByObjective.get(objectiveId);
    if (!items || items.length === 0) return null;
    let min: number | null = null;
    for (const itemId of items) {
      const order = orderOfItem.get(itemId);
      if (order === undefined) continue;
      if (min === null || order < min) min = order;
    }
    return min;
  };

  /** A node's position is the position of the earliest item teaching anything it supports. */
  const earliestOfNode = (nodeId: string): number | null => {
    const objectives = input.objectivesByNode.get(nodeId) ?? [];
    let min: number | null = null;
    for (const objectiveId of objectives) {
      const order = earliestOfObjective(objectiveId);
      if (order === null) continue;
      if (min === null || order < min) min = order;
    }
    return min;
  };

  const earliest = (kind: string, id: string): number | null => {
    if (kind === 'objective') return earliestOfObjective(id);
    if (kind === 'node') return earliestOfNode(id);
    return null;
  };

  const ordering = new Set<string>(CURRICULUM_ORDER_CLAIM_EDGE_TYPES);
  const conflicts: { refId: string; sourceId: string; targetId: string; message: string }[] = [];
  const seen = new Set<string>();
  for (const edge of input.edges) {
    if (!ordering.has(edge.edgeType)) continue;
    const sourceOrder = earliest(edge.sourceKind, edge.sourceId);
    const targetOrder = earliest(edge.targetKind, edge.targetId);
    if (sourceOrder === null || targetOrder === null) continue;
    if (sourceOrder <= targetOrder) continue;
    const key = `${edge.sourceId}:${edge.targetId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // The wording is the audit's, not this step's: the same conflict is reported
    // by the export gate, and two spellings of one problem is how an author
    // concludes they are two problems.
    const prefix = edge.sourceKind === 'node' ? '知识/技能点' : '';
    conflicts.push({
      refId: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      message:
        `${prefix}「${input.labelOf(edge.targetId)}」先于它的先修` +
        `「${input.labelOf(edge.sourceId)}」被讲授`,
    });
  }
  return conflicts;
}

// ── 缺口 ────────────────────────────────────────────────────────────────────

export interface OutlineGap {
  /** 单元或目标 id；整体性缺口（一份大纲都没有）没有。 */
  ref?: string;
  text: string;
}

/**
 * 这份大纲还差什么。
 *
 * 与 store 的 `phaseCompletionGaps('teaching')` 是同一套判定的可执行说法：那个函数
 * 报"有目标没有被任何条目讲授"，这里报出**是哪一个目标**、**差在哪个条目上**，以及
 * 门禁不查但审核会报的几条（章节承载覆盖、条目没有角色）。说"第 2 章第 3 个条目不覆盖
 * 任何目标"可以照做，说"大纲不完整"不行。
 *
 * 顺序冲突也算缺口：它是模型这一轮自己写下的顺序与上一轮签收的图之间的矛盾，让作者
 * 在确认之前看到，比等审核在最后一步报出来便宜得多。
 */
export function outlineGaps(input: {
  units: readonly OutlineUnitRef[];
  coverage: readonly OutlineCoverageRef[];
  objectives: readonly OutlineObjectiveRef[];
  orderConflicts?: readonly OutlineOrderConflict[];
}): OutlineGap[] {
  const gaps: OutlineGap[] = [];
  const items = input.units.filter((unit) => unit.unitType === 'item');
  if (input.units.length === 0) {
    gaps.push({ text: '还没有大纲：先把学习目标组织成章、节，再把教学内容落到条目上' });
    return gaps;
  }
  if (items.length === 0) {
    gaps.push({
      text: '大纲里只有章节没有条目：章节只做归类，学生要学的内容必须落在条目上',
    });
  }

  const coverageByUnit = new Map<string, OutlineCoverageRef[]>();
  for (const row of input.coverage) {
    const list = coverageByUnit.get(row.unitId) ?? [];
    list.push(row);
    coverageByUnit.set(row.unitId, list);
  }
  const chapterIds = new Set(
    input.units.filter((unit) => unit.unitType === 'chapter').map((unit) => unit.id),
  );

  for (const item of items) {
    if (!item.unitRole) {
      gaps.push({
        ref: item.id,
        text: `条目「${item.title}」没有角色：需要标成讲授、练习或考试`,
      });
    }
    if ((coverageByUnit.get(item.id) ?? []).length === 0) {
      gaps.push({
        ref: item.id,
        text: `条目「${item.title}」不覆盖任何学习目标：学生在这个条目里既学不到、也练不到、也考不到`,
      });
    }
  }

  for (const unit of input.units) {
    if (!chapterIds.has(unit.id)) continue;
    if ((coverageByUnit.get(unit.id) ?? []).length === 0) continue;
    gaps.push({
      ref: unit.id,
      text: `「${unit.title}」是章节却承载了教学覆盖：章节只做归类，覆盖要挂在条目上`,
    });
  }

  // Only an item teaches: the database refuses coverage on a chapter, so a row
  // there is legacy or imported data, and counting it would report an outcome as
  // taught when nothing teaches it.
  const itemIds = new Set(items.map((item) => item.id));
  const taught = new Set(
    input.coverage
      .filter((row) => row.coverageKind === 'teach' && itemIds.has(row.unitId))
      .map((row) => row.objectiveId),
  );
  for (const objective of input.objectives) {
    if (taught.has(objective.id)) continue;
    gaps.push({
      ref: objective.id,
      text: `学习目标「${objective.title}」还没有被任何条目讲授：它在课程里不会出现`,
    });
  }

  for (const conflict of input.orderConflicts ?? []) {
    gaps.push({ ref: conflict.targetId, text: conflict.message });
  }

  return gaps;
}

/** {@link outlineGaps} over records, for the state payload and the card strip. */
export function outlineGapsOfRecords(
  units: readonly OutlineUnitRef[],
  coverage: readonly OutlineCoverageRef[],
  objectives: readonly OutlineObjectiveRef[],
  orderConflicts: readonly OutlineOrderConflict[] = [],
): OutlineGap[] {
  return outlineGaps({ units, coverage, objectives, orderConflicts });
}

/**
 * 供作者读的提醒：不是错误，不该拦住签收，但机器看得见而作者可能没注意。
 *
 * 目前只有一条——**学时合计与课程简介不一致**。它不是缺口：课程可以有意多排练习，
 * 也可以把部分条目留成选修；但"简介说 54 学时、大纲排了 12 学时"是作者在点确认之前
 * 就想知道的事。审核没有这条规则，所以它只出现在这一步的卡片上。
 */
export function outlineFindings(input: {
  items: readonly { hours: number | null }[];
  declaredHours: number | null;
}): OutlineGap[] {
  if (input.declaredHours === null) return [];
  const total = input.items.reduce((sum, item) => sum + (item.hours ?? 0), 0);
  if (total === 0) return [];
  if (Math.abs(total - input.declaredHours) < 0.001) return [];
  return [
    {
      text:
        `大纲里条目的学时合计是 ${total} 学时，而课程简介写的是 ${input.declaredHours} 学时。` +
        `如果这不是有意的（比如留了选修条目），把两边对齐`,
    },
  ];
}

/**
 * 是否采纳模型声明的"用户已确认"，底线与前几步同源，另加一条这一步特有的：
 * **没有条目就不能签收**。
 *
 * 前几步的"完整"是"清单条目都齐了"；这里更硬——一份只有章节的大纲能过前面所有门禁
 * （章节不承载覆盖，所以没有任何目标"未被讲授"是因为它根本没有条目），然后在生成阶段
 * 变成一个什么都产不出来的空课程。所以条目数是这条底线的一部分。
 *
 * `gaps` 传入的是**缺口与审核发现合并之后**的清单：规则层的缺口加上审核里与大纲有关
 * 的那几条（顺序、角色、覆盖）。两者读的是同一份存储状态，判定在写入之后做。
 */
export function shouldConfirmOutline(input: {
  confirmRequested: boolean;
  userTurns: number;
  itemCount: number;
  gaps: readonly unknown[];
  changedAnything: boolean;
}): boolean {
  if (!input.confirmRequested) return false;
  if (input.userTurns < 2) return false;
  if (!input.changedAnything) return false;
  if (input.gaps.length > 0) return false;
  return input.itemCount > 0;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 大纲的纯文本形式，供提示词与卡片共用。
 *
 * 按章节分层打印，而不是平铺：模型要判断"这个条目属于哪个节"就必须看到层级，而
 * `parent_id` 在平面列表里只是一列看不出结构的 id。每条给 `ref`，因为改一条就得指名。
 */
export function formatOutlinePlan(input: {
  units: readonly OutlineUnitRef[];
  coverage: readonly OutlineCoverageRef[];
  objectives: readonly OutlineObjectiveRef[];
}): string {
  if (input.units.length === 0) return '(还没有大纲)';
  const coverageByUnit = new Map<string, OutlineCoverageRef[]>();
  for (const row of input.coverage) {
    const list = coverageByUnit.get(row.unitId) ?? [];
    list.push(row);
    coverageByUnit.set(row.unitId, list);
  }
  const titleOfObjective = (id: string): string =>
    input.objectives.find((row) => row.id === id)?.title ?? id;
  const childrenOf = (parentId: string | null): OutlineUnitRef[] =>
    input.units
      .filter((unit) => (unit.parentId ?? null) === parentId)
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex);

  const lines: string[] = [];
  const render = (unit: OutlineUnitRef, depth: number): void => {
    const pad = '  '.repeat(depth);
    const role =
      unit.unitType === 'item' ? `（${UNIT_ROLE_LABELS[unit.unitRole ?? 'lecture']}）` : '';
    const hours = unit.hours === null ? '' : ` ${unit.hours} 学时`;
    lines.push(`${pad}- ref=${unit.id} ${unit.title}${role}${hours}`);
    const rows = coverageByUnit.get(unit.id) ?? [];
    if (rows.length > 0) {
      lines.push(
        `${pad}    覆盖：` +
          rows
            .map(
              (row) =>
                `${COVERAGE_KIND_LABELS[row.coverageKind]} ${row.objectiveId}(${titleOfObjective(row.objectiveId)})`,
            )
            .join('、'),
      );
    } else if (unit.unitType === 'item') {
      lines.push(`${pad}    覆盖：无（这是缺口：它既不教也不练也不考）`);
    }
    for (const child of childrenOf(unit.id)) render(child, depth + 1);
  };
  for (const unit of childrenOf(null)) render(unit, 0);

  const objectiveLines = input.objectives.map(
    (objective) => `obj=${objective.id}  ${objective.title}`,
  );
  return [
    '当前大纲（ref 是你唯一能引用的单元标识；缩进表示层级）',
    ...lines,
    '',
    '必须被讲授的学习目标（覆盖用 obj 引用）',
    ...(objectiveLines.length > 0 ? objectiveLines : ['(没有学习目标)']),
  ].join('\n');
}
