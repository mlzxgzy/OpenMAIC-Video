/**
 * 第六步「教学内容生产」的领域规则：**授课脚本 → 分镜**。
 *
 * 前五步定下的是"教什么、按什么顺序教"。这一步定下的是**怎么教**，并且把它落到
 * 页面上——因为"怎么教"如果不落到页面，它只是一段好听的散文：真正生成课件的模型
 * 读不到散文里的犹豫，它只读得到页结构。
 *
 * ## 两份产物，一份决定
 *
 * - **授课脚本**（`teaching_design`）：这一条要讲什么、讲到什么程度、按什么顺序讲、
 *   拿什么例子和演示。四档深度（讲透 / 带过 / 点名 / 不讲）是这个文档的重点：
 *   "这一条什么都讲"不是设计，是没设计。
 * - **分镜**（`deck_design`）：页级计划，每页一句目标、一句核心信息、一种呈现方式。
 *   它直接进生成提示词（见 `deck-design-contract.ts`），是教学设计到达生成器唯一的
 *   通道。
 *
 * 所以两者**写在同一个 plan 对象里**，而不是两个数组：分镜是脚本的逐页化身。
 * 分成两处写，模型就会改了脚本忘了改分镜，而这两者的矛盾在界面上看不出来——直到
 * 生成出一份和设计无关的课件。
 *
 * ## 三条定下来的判断
 *
 * 1. **存下来的节点引用一律是 id；名称只在入口和出口出现。**
 *    入口：模型写 id，写**名称也认**——名称在一个条目自己的节点集里是无歧义的，为格
 *    式差异丢掉一条真实的取舍（"这一条讲透 SQL 查询与参数化"）是本项目在别处一律拒绝
 *    的失败方式。出口：提示词里打印的是名称，因为生成器不认识 `node_xxx`。
 *    中间必须是同一种寻址，否则"脚本说要讲透 X"和"第 3 页在讲 X"这两句话根本没法互
 *    相比较——而那正是这一步唯一真正新增的检查（{@link scriptStoryboardConflicts}）。
 *    这条曾经写成"桶装 id、页面装名称"，结果页面写 id 时被当成名称存了进去，两边永远
 *    对不上；测试把两种写法都钉住了。
 *    `omit` 是唯一收自由文本的档：最值得写进"不讲"的，恰恰是本条目不涉及的、读者可能
 *    以为会讲的东西，用 id 反而写不出来。散文条目按散文处理，不参与比对。
 *
 * 2. **`nodes` 是三个档的并集，由规则层推导，不接模型给的版本。**
 *    `teaching_design.nodes` 是"这一条涉及哪些节点"，它与 core/brief/mention 是同一件
 *    事的两种说法。让模型同时维护两者，就是让它们漂移；审核读的又恰好是 `nodes`，
 *    漂移的后果是"讲透了却在审核里显示没提到"。
 *
 * 3. **分镜只属于讲课条目。** 练习和考试条目生成的是场景，不是幻灯片
 *    （`deckDesignForRole` 会忽略非讲课条目的分镜）。给它们写分镜是一次静默的空操作，
 *    所以这里直接拒收并记账，而不是存一份永远不会被读到的计划。
 */
import {
  CURRICULUM_UNIT_ROLES,
  type CurriculumCoverageKind,
  type CurriculumUnitCoverageRecord,
  type CurriculumDeckDesign,
  type CurriculumDeckPage,
  type CurriculumLearningNodeRecord,
  type CurriculumNodeObjectiveRecord,
  type CurriculumTeachingDesign,
  type CurriculumUnitRecord,
  type CurriculumUnitRole,
} from './design-types';
import { stepRef } from '@/lib/curriculum/ui-labels';

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 四档深度。顺序即优先级：冲突时深度大的赢。 */
export const TEACHING_DEPTH_BUCKETS = ['core', 'brief', 'mention', 'omit'] as const;
export type TeachingDepthBucket = (typeof TEACHING_DEPTH_BUCKETS)[number];

export const TEACHING_DEPTH_LABELS: Record<TeachingDepthBucket, string> = {
  core: '讲透',
  brief: '带过',
  mention: '点名',
  omit: '不讲',
};

/** 会写进 `nodes` 并需要是真实节点 id 的三档。`omit` 不在其中，见文件头第 1 条。 */
export const ASSIGNED_NODE_BUCKETS = ['core', 'brief', 'mention'] as const;
export type AssignedNodeBucket = (typeof ASSIGNED_NODE_BUCKETS)[number];

const BUCKET_OF_FIELD: Record<AssignedNodeBucket, keyof CurriculumTeachingDesign> = {
  core: 'core',
  brief: 'brief',
  mention: 'mention',
};

/** 分镜的呈现方式。与 `lib/types/generation.ts` 的 `DeckDesignPage['mode']` 同源。 */
export const DECK_PAGE_MODES = [
  'case',
  'explain',
  'demo',
  'compare',
  'summary',
  'diagram',
] as const;
export type DeckPageMode = (typeof DECK_PAGE_MODES)[number];

export const DECK_PAGE_MODE_LABELS: Record<DeckPageMode, string> = {
  case: '案例开场',
  explain: '解释',
  demo: '演示',
  compare: '对比',
  diagram: '图示',
  summary: '小结',
};

/**
 * 一段讲课的页数区间。越界只是**提示**，不是拒绝：学时由课程自己定，规则层不该把
 * 一个班的节奏写成硬约束。这个区间来自课程大纲里"每目 12～20 页、10～25 分钟"的约定。
 */
export const DECK_PAGE_TARGET = { min: 8, max: 24 } as const;

/** 这一页要交给生成器去讲的知识点，按**名称**记（见文件头第 1 条）。 */
export interface TeachingPageDraft {
  order: number;
  title: string;
  goal: string;
  coreInfo: string;
  mode: DeckPageMode;
  emphasis: string[];
  visual: string | null;
  code: string | null;
  /**
   * 这一页担着的知识点。收 id 或名称，**存下来的是 id**（见文件头第 1 条）；
   * 打印进提示词时再换回名称。
   */
  teaches: string[];
}

/**
 * 一条条目的教学设计意图。
 *
 * 字段缺席 = 保留原值，空数组 = 清空。所以这一层是**按字段打补丁**，不是整份替换：
 * 模型一轮只想改分镜，不该顺手把例子和演示擦掉。
 */
export interface TeachingPlanDraft {
  ref: string;
  core?: string[];
  brief?: string[];
  mention?: string[];
  omit?: string[];
  sequence?: string[];
  prerequisites?: string[];
  cases?: string[];
  demos?: string[];
  operations?: string[];
  drills?: string[];
  summary?: string[];
  /** 缺席 = 这一轮不动分镜。 */
  pages?: TeachingPageDraft[];
  /** 模型自报页数。写库时以 `pages.length` 为准，不一致只作为发现报告。 */
  estPages?: number;
}

export interface TeachingAnswer {
  message: string;
  plans: TeachingPlanDraft[];
  confirmRequested: boolean;
  rejectedRefs: string[];
}

/** 一条条目在规则层看到的全部事实。 */
export interface TeachingItemBoard {
  id: string;
  title: string;
  role: CurriculumUnitRole;
  hours: number | null;
  /** 条目覆盖的目标（三种覆盖的并集），用来推导 `teaching_design.objectives`。 */
  objectiveIds: string[];
  /** 本条能点的节点：它的覆盖目标背后的知识/技能节点。 */
  nodes: readonly { id: string; name: string }[];
  /** 全课程的节点名称，用来校验 `prerequisites` 这种"可以来自别的条目"的引用。 */
  allNodeNames?: ReadonlyMap<string, string>;
  teachingDesign: CurriculumTeachingDesign;
  deckDesign: CurriculumDeckDesign;
}

export interface TeachingBoard {
  items: readonly TeachingItemBoard[];
  objectives: readonly { id: string; title: string }[];
  /**
   * 章节：判分和渲染要能说出"这一条挂在哪个节下"。规则不需要它，但面板需要，
   * 而面板读的是同一份 payload。
   */
  chapters?: readonly { id: string; title: string; parentId: string | null }[];
}

/** 一条条目在提示词里的引用形式，就是模型能指名道姓用的 `ref`。 */
export interface TeachingItemRef {
  id: string;
  title: string;
  role: CurriculumUnitRole;
}

// ── 模型输出 ────────────────────────────────────────────────────────────────

export class TeachingAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeachingAnswerError';
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

/** 一行必须非空并保留原文（供 title/goal/coreInfo 这类"必须有值"的字段）。 */
function requiredText(value: unknown): string | undefined {
  const text = textOf(value);
  return text === null || text === undefined ? undefined : text;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

/** 非负整数，用来收 `order`。小数不是顺序，是模型算错了。 */
function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * 一行文本列表：缺省是 `undefined`（保留原值），空数组是 `[]`（清空），
 * 非数组或含非文本项则整项作废并记一条原因——半个列表是最坏的结果，因为模型和
 * 作者都看不出少了哪个。
 */
function textListOrNull(
  value: unknown,
  label: string,
  rejectedRefs: string[],
): string[] | undefined {
  if (value === undefined) return undefined;
  if (value === null) return [];
  if (!Array.isArray(value)) {
    rejectedRefs.push(`${label}不是列表`);
    return undefined;
  }
  const out: string[] = [];
  for (const entry of value) {
    const text = textOf(entry);
    if (text === null || text === undefined) {
      rejectedRefs.push(`${label}里有空的或非文本的一项，整项未采用`);
      return undefined;
    }
    out.push(text);
  }
  return out;
}

/** 清洗一页分镜。标题、目标、核心信息是页之所以是设计而不是标题的三件套。 */
export function sanitizeTeachingPage(
  raw: unknown,
  index: number,
  rejectedRefs: string[],
): TeachingPageDraft | null {
  if (!isRecord(raw)) {
    rejectedRefs.push(`第 ${index + 1} 页不是一个对象`);
    return null;
  }
  const title = requiredText(raw.title);
  if (!title) {
    rejectedRefs.push(`第 ${index + 1} 页缺少标题`);
    return null;
  }
  // A page whose goal is missing is a heading. Refusing it here is what keeps the
  // storyboard from degenerating into a table of contents — the same asymmetry
  // `readDeckDesign` applies on the workbench's own PATCH route.
  const goal = requiredText(raw.goal);
  if (!goal) {
    rejectedRefs.push(`第 ${index + 1} 页「${title}」缺少目标：一页要达成什么，是分镜唯一的用处`);
    return null;
  }
  const coreInfo = requiredText(raw.coreInfo);
  if (!coreInfo) {
    rejectedRefs.push(`第 ${index + 1} 页「${title}」缺少核心信息`);
    return null;
  }
  const mode = oneOf(raw.mode, DECK_PAGE_MODES);
  if (raw.mode !== undefined && raw.mode !== null && !mode) {
    // Presentation is recoverable and visible in the panel; a missing page is
    // not. So a bad `mode` defaults and is reported rather than dropping the page.
    rejectedRefs.push(`第 ${index + 1} 页「${title}」的呈现方式不在允许取值内，按「解释」处理`);
  }
  const visual = textOf(raw.visual);
  if (raw.visual !== undefined && visual === undefined) {
    rejectedRefs.push(`第 ${index + 1} 页「${title}」的图示不是文本`);
    return null;
  }
  const code = textOf(raw.code);
  if (raw.code !== undefined && code === undefined) {
    rejectedRefs.push(`第 ${index + 1} 页「${title}」的代码不是文本`);
    return null;
  }
  const emphasis =
    textListOrNull(raw.emphasis, `第 ${index + 1} 页的「必须落地」`, rejectedRefs) ?? [];
  const teaches =
    textListOrNull(raw.teaches, `第 ${index + 1} 页的「讲哪些知识点」`, rejectedRefs) ?? [];
  const order = positiveInt(raw.order) ?? index + 1;
  return {
    order,
    title,
    goal,
    coreInfo,
    mode: mode ?? 'explain',
    emphasis,
    visual: visual ?? null,
    code: code ?? null,
    teaches,
  };
}

/**
 * 清洗一条条目的教学设计。
 *
 * 只有一条拒绝条件：**没有 `ref`**。教学设计的所有字段都可以缺——缺的是"这个还没
 * 想好"，而它会被 {@link teachingGapsOfItems} 报成缺口，比拒绝写入更可见。
 */
export function sanitizeTeachingPlan(raw: unknown): {
  plan: TeachingPlanDraft | null;
  reason?: string;
} {
  if (!isRecord(raw)) return { plan: null, reason: '教学设计不是一个对象' };
  const ref = textOf(raw.ref);
  if (!ref) return { plan: null, reason: '教学设计缺少它所属条目的 ref' };

  const rejected: string[] = [];
  const label = (key: string) => `条目 ${ref} 的「${key}」`;
  const plan: TeachingPlanDraft = { ref };
  for (const bucket of TEACHING_DEPTH_BUCKETS) {
    const list = textListOrNull(raw[bucket], label(bucket), rejected);
    if (list !== undefined) plan[bucket] = list;
  }
  for (const field of [
    'sequence',
    'prerequisites',
    'cases',
    'demos',
    'operations',
    'drills',
    'summary',
  ] as const) {
    const list = textListOrNull(raw[field], label(field), rejected);
    if (list !== undefined) plan[field] = list;
  }

  if ('pages' in raw && raw.pages !== null) {
    if (!Array.isArray(raw.pages)) {
      rejected.push(label('pages') + '不是列表');
    } else {
      const pages: TeachingPageDraft[] = [];
      raw.pages.forEach((entry, index) => {
        const page = sanitizeTeachingPage(entry, index, rejected);
        if (page) pages.push(page);
      });
      plan.pages = pages;
    }
  } else if ('pages' in raw) {
    // `pages: null` — an explicit "this item has no storyboard". Same meaning as
    // an empty list, and the gap check reports it.
    plan.pages = [];
  }

  const estPages = positiveInt(raw.estPages);
  if (raw.estPages !== undefined && raw.estPages !== null && estPages === undefined) {
    rejected.push(label('estPages') + '不是正整数');
  } else if (estPages !== undefined) {
    plan.estPages = estPages;
  }

  return { plan, reason: rejected.length > 0 ? rejected.join('；') : undefined };
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * 这一步明确不接的字段。
 *
 * `nodes` 拒收是因为它由三个档推导（文件头第 2 条）；`objectives` 拒收是因为它来自
 * 大纲的覆盖关系。题目、实验、考试属于下一步，在这里写下它们等于跳过"条目已经
 * 确认"这道门禁。
 */
const OUT_OF_SCOPE_KEYS = [
  'nodes',
  'objectives',
  'questions',
  'quiz',
  'labTasks',
  'labs',
  'exam',
] as const;

/**
 * 模型回答的 JSON 形状：`{ message, plans, confirm }`。
 *
 * `plans` 里一条目一个对象：脚本和分镜同进同出（见文件头）。
 */
export function parseTeachingAnswer(text: string): TeachingAnswer {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new TeachingAnswerError('模型没有返回 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new TeachingAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) throw new TeachingAnswerError('模型返回的不是一个 JSON 对象');

  const rejectedRefs: string[] = [];
  for (const key of OUT_OF_SCOPE_KEYS) {
    if (key in parsed) {
      rejectedRefs.push(
        key === 'nodes' || key === 'objectives'
          ? `「${key}」由规则层从四个档推导，已忽略：请直接写 core / brief / mention`
          : `「${key}」不在这一步的范围内，已忽略：题目与实操是下一步的事`,
      );
    }
  }

  const plans: TeachingPlanDraft[] = [];
  const seen = new Set<string>();
  for (const entry of asArray(parsed.plans)) {
    const { plan, reason } = sanitizeTeachingPlan(entry);
    if (!plan) {
      if (reason) rejectedRefs.push(reason);
      continue;
    }
    if (seen.has(plan.ref)) {
      rejectedRefs.push(`条目 ${plan.ref} 在同一轮里出现了两次，只采用后一次`);
      const index = plans.findIndex((candidate) => candidate.ref === plan.ref);
      if (index >= 0) plans.splice(index, 1);
    }
    seen.add(plan.ref);
    if (reason) rejectedRefs.push(reason);
    plans.push(plan);
  }

  return {
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    plans,
    confirmRequested: parsed.confirm === true,
    rejectedRefs,
  };
}

// ── 写入意图 ────────────────────────────────────────────────────────────────

export interface TeachingItemPatch {
  unitId: string;
  teachingDesign: CurriculumTeachingDesign;
  deckDesign: CurriculumDeckDesign;
}

export interface ResolvedTeachingPlan {
  patch: TeachingItemPatch;
  rejectedRefs: string[];
  advisories: string[];
  /** 这一条真的改了东西吗——没改就不该撤回签收（同前四步）。 */
  changed: boolean;
}

/** 名称比较：去掉首尾空白后不区分大小写。中文名称不受影响，英文缩写受益。 */
function nameKey(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * 把一条意图落成两份文档。
 *
 * 顺序是刻意的：
 *
 * 1. **桶先定深度。** 一个节点同时出现在两档时，深度大的赢（讲透 > 带过 > 点名 > 不讲），
 *    浅的那条丢弃并记账。反过来"讲透和只点名同时成立"没有意义，而沉默地二选一
 *    会让作者以为两句话都存下了。
 * 2. **`nodes` 由三档并集推导。** 见文件头第 2 条。
 * 3. **分镜把脚本逐页对上。** 页面里的知识点名称解析成 id，用来检查"讲透的节点有没有
 *    落到某一页上"；解析不出来的名称从页面里去掉并记账——一个指向不存在知识点的页面
 *    声称是**错**的，而不是缺口（同连线指向不存在的目标）。
 */
export function applyTeachingPlan(input: {
  item: TeachingItemBoard;
  plan: TeachingPlanDraft;
}): ResolvedTeachingPlan {
  const { item, plan } = input;
  const rejectedRefs: string[] = [];
  const advisories: string[] = [];
  const current = item.teachingDesign ?? {};
  const assignedIds = new Set(item.nodes.map((node) => node.id));
  const nameById = new Map(item.nodes.map((node) => [node.id, node.name]));
  const knownNodeIds = new Set(item.allNodeNames?.keys() ?? []);
  for (const node of item.nodes) knownNodeIds.add(node.id);

  // 1. Buckets, deepest claim wins.
  //
  // An entry is resolved by id **or by exact name**. The prompt asks for ids, but
  // a name is an unambiguous reference inside one item's own node set, and a rule
  // that silently drops a name would lose a real teaching decision over a
  // formatting difference — the failure mode this project refuses elsewhere. What
  // is stored is always the id, so the audit and the trace read one addressing.
  const nodeIdOfEntry = (entry: string): string | null => {
    if (assignedIds.has(entry)) return entry;
    const byName = item.nodes.find((node) => nameKey(node.name) === nameKey(entry));
    return byName ? byName.id : null;
  };
  const claimed = new Map<string, AssignedNodeBucket>();
  const buckets: Partial<Record<AssignedNodeBucket, string[]>> = {};
  for (const bucket of ASSIGNED_NODE_BUCKETS) {
    if (plan[bucket] === undefined) continue;
    const kept: string[] = [];
    for (const rawEntry of plan[bucket] ?? []) {
      const entry = nodeIdOfEntry(rawEntry);
      if (entry === null) {
        const name = item.allNodeNames?.get(rawEntry) ?? rawEntry;
        rejectedRefs.push(
          `「${name}」没有被「${item.title}」讲授，不能写进它的${TEACHING_DEPTH_LABELS[bucket]}档` +
            '（教学设计只能在它负责的知识点里选）',
        );
        continue;
      }
      const previous = claimed.get(entry);
      if (previous) {
        const dropped =
          TEACHING_DEPTH_BUCKETS.indexOf(previous) <= TEACHING_DEPTH_BUCKETS.indexOf(bucket)
            ? bucket
            : previous;
        advisories.push(
          `「${nameById.get(entry) ?? entry}」同时被写成「${TEACHING_DEPTH_LABELS[previous as TeachingDepthBucket]}」` +
            `和「${TEACHING_DEPTH_LABELS[bucket]}」，按更深的「${TEACHING_DEPTH_LABELS[dropped]}」采用`,
        );
        continue;
      }
      claimed.set(entry, bucket);
      kept.push(entry);
    }
    buckets[bucket] = kept;
  }

  const nextDesign: CurriculumTeachingDesign = { ...current };
  for (const bucket of ASSIGNED_NODE_BUCKETS) {
    if (buckets[bucket] === undefined) continue;
    nextDesign[BUCKET_OF_FIELD[bucket]] = buckets[bucket];
  }
  if (plan.omit !== undefined) nextDesign.omit = [...plan.omit];

  // 2. `nodes` and `objectives` are derived, never taken from the model.
  const anyBucketWritten = ASSIGNED_NODE_BUCKETS.some((bucket) => buckets[bucket] !== undefined);
  if (anyBucketWritten) {
    nextDesign.nodes = ASSIGNED_NODE_BUCKETS.flatMap(
      (bucket) => nextDesign[BUCKET_OF_FIELD[bucket]] ?? [],
    );
    nextDesign.objectives = [...item.objectiveIds];
  }

  if (plan.sequence !== undefined) {
    const kept: string[] = [];
    for (const rawEntry of plan.sequence) {
      const entry = nodeIdOfEntry(rawEntry);
      if (entry === null) {
        rejectedRefs.push(
          `顺序里的「${nameById.get(rawEntry) ?? rawEntry}」不属于「${item.title}」，已从顺序里去掉`,
        );
        continue;
      }
      if (!kept.includes(entry)) kept.push(entry);
    }
    nextDesign.sequence = kept;
  }

  if (plan.prerequisites !== undefined) {
    const kept = plan.prerequisites.filter((entry) => knownNodeIds.has(entry));
    for (const entry of plan.prerequisites) {
      if (kept.includes(entry)) continue;
      rejectedRefs.push(`先修里的「${entry}」不是这门课的知识点，已去掉`);
    }
    nextDesign.prerequisites = kept;
  }

  for (const field of ['cases', 'demos', 'operations', 'drills', 'summary'] as const) {
    if (plan[field] !== undefined) nextDesign[field] = [...(plan[field] ?? [])];
  }

  // 3. The storyboard, per page.
  let nextDeck: CurriculumDeckDesign = { ...(item.deckDesign ?? {}) };
  if (plan.pages !== undefined) {
    if (item.role !== 'lecture') {
      // Silently storing it would be worse: `deckDesignForRole` ignores a
      // non-lecture deck, so the plan would never reach a run while the panel
      // showed a storyboard that looks authoritative.
      rejectedRefs.push(
        `「${item.title}」是${
          item.role === 'practice' ? '练习' : '考试'
        }条目，没有分镜：它生成的是场景，不是幻灯片`,
      );
    } else {
      // A plan's order IS its teaching order, so pages are stored in the order
      // given after a stable sort. Duplicate orders are renumbered rather than
      // rejected: two pages claiming page 3 is a slip, and dropping one of them
      // would silently change the length of the lesson.
      const ordered = plan.pages
        .map((page, index) => ({ page, index }))
        .sort((left, right) => left.page.order - right.page.order || left.index - right.index)
        .map((entry) => entry.page);
      const renamed = ordered.some((page, index) => page.order !== index + 1);
      if (renamed) {
        advisories.push(
          `「${item.title}」的页面序号有重复或跳号，已按你给的先后重排为 1–${ordered.length}`,
        );
      }
      const pages: CurriculumDeckPage[] = ordered.map((page, index) => {
        const teaches: string[] = [];
        for (const entry of page.teaches) {
          // Id first, then exact name — and the **id** is what gets stored either
          // way. One item's claim on a node has one addressing, or the storyboard
          // and the script buckets cannot be compared to each other: a page saying
          // "SQL 注入原理" and a bucket saying `node_abc` are the same claim.
          const resolved = nodeIdOfEntry(entry);
          if (resolved === null) {
            rejectedRefs.push(
              `第 ${index + 1} 页点名了不属于「${item.title}」的知识点「${entry}」，已从这一页去掉`,
            );
            continue;
          }
          if (!teaches.includes(resolved)) teaches.push(resolved);
        }
        return {
          order: index + 1,
          title: page.title,
          goal: page.goal,
          coreInfo: page.coreInfo,
          mode: page.mode,
          ...(page.emphasis.length > 0 ? { emphasis: page.emphasis } : {}),
          ...(page.visual ? { visual: page.visual } : {}),
          ...(page.code ? { code: page.code } : {}),
          ...(teaches.length > 0 ? { teaches } : {}),
        };
      });
      if (plan.estPages !== undefined && plan.estPages !== pages.length) {
        advisories.push(
          `「${item.title}」自报 ${plan.estPages} 页，实际给了 ${pages.length} 页，已按 ${pages.length} 页存`,
        );
      }
      // `estPages` is derived, so a plan cannot claim a length it does not have.
      nextDeck = { estPages: pages.length, pages };
    }
  }

  const changed =
    JSON.stringify(nextDesign) !== JSON.stringify(current) ||
    JSON.stringify(nextDeck) !== JSON.stringify(item.deckDesign ?? {});

  return {
    patch: { unitId: item.id, teachingDesign: nextDesign, deckDesign: nextDeck },
    rejectedRefs,
    advisories,
    changed,
  };
}

/**
 * 把一轮回答落成每个条目的最终意图。
 *
 * 未命中的 `ref` 一律丢弃并记账，不猜、不按位置套用——同前四步，理由相同：图上
 * 的静默改动最难发现。没有被提到的条目原样保留（`updateCurriculumUnit` 只写被点名的
 * 条目，所以这里不需要像连线那样把其余条目"带过来"）。
 */
export function resolveTeachingPlans(input: {
  board: TeachingBoard;
  answer: Pick<TeachingAnswer, 'plans'>;
}): {
  patches: Map<string, TeachingItemPatch>;
  unmatchedRefs: string[];
  rejectedRefs: string[];
  advisories: string[];
} {
  const byId = new Map(input.board.items.map((item) => [item.id, item]));
  const patches = new Map<string, TeachingItemPatch>();
  const unmatchedRefs: string[] = [];
  const rejectedRefs: string[] = [];
  const advisories: string[] = [];

  for (const plan of input.answer.plans) {
    const item = byId.get(plan.ref);
    if (!item) {
      unmatchedRefs.push(plan.ref);
      continue;
    }
    const resolved = applyTeachingPlan({ item, plan });
    rejectedRefs.push(...resolved.rejectedRefs);
    advisories.push(...resolved.advisories);
    if (resolved.changed) patches.set(item.id, resolved.patch);
  }

  return { patches, unmatchedRefs, rejectedRefs, advisories };
}

// ── 缺口 ────────────────────────────────────────────────────────────────────

/**
 * 缺口的种类。
 *
 * 存在的理由不只是给界面分色：审核只该把**某几类**缺口变成 error。把种类写进数据，
 * 审计规则就能挑出"这一条还没设计"和"分镜和脚本打架"，而不是靠匹配消息文本——
 * 匹配文案的规则会在有人改一句措辞时静默失效。
 */
export const TEACHING_GAP_KINDS = [
  /** 一条条目都没有。 */
  'no_items',
  /** 这一条还没有教学设计。 */
  'no_design',
  /** 四个深度档全空：没有"讲透/带过/点名"的内容。 */
  'no_bucket',
  /** 讲课条目没有分镜。 */
  'no_deck',
  /** 分镜没有任何一页点名知识点（或某几页）。 */
  'page_without_node',
  /** 顺序里缺了要求讲透的内容。 */
  'sequence_missing_core',
  /** 分镜与脚本直接矛盾。 */
  'script_storyboard_conflict',
] as const;
export type TeachingGapKind = (typeof TEACHING_GAP_KINDS)[number];

export interface TeachingGap {
  /** 条目 id；整体性缺口（一条都没有）没有。 */
  ref?: string;
  kind: TeachingGapKind;
  text: string;
}

/** 一条条目当前的两份文档，规则只需要这些。 */
export interface TeachingGapInput {
  id: string;
  title: string;
  role: CurriculumUnitRole;
  teachingDesign: CurriculumTeachingDesign;
  deckDesign: CurriculumDeckDesign;
  /** 条目的节点集：桶和分镜都只能在这里面点，也是名称→id 的解析范围。 */
  nodes: readonly { id: string; name: string }[];
  /** 全课程节点 id → 名称，用来校验可以来自别的条目的 `prerequisites`。 */
  allNodeNames?: ReadonlyMap<string, string>;
}

/**
 * 这条条目的分镜和脚本有没有打架。
 *
 * 这是这一步真正新增的检查，也是"教学内容生产"能被称为生产的原因：**脚本说"讲透"
 * 的节点，分镜里必须至少有一页担着；脚本说"不讲"的东西，分镜里不能出现。** 两者的
 * 矛盾在界面上看不出来——脚本一个表格、分镜一个列表，各自都完整——直到生成出一份
 * 与设计无关的课件。
 *
 * 名称解析不出来的 `omit` 条目按散文处理，不参与比对：散文里写"不讲 SQLMap 的安装"
 * 而页面上写着"SQLMap 常用参数"，机器判不出它们是不是同一件事，假装判得出比不判更糟。
 */
export function scriptStoryboardConflicts(input: TeachingGapInput): TeachingGap[] {
  const gaps: TeachingGap[] = [];
  if (input.role !== 'lecture') return gaps;
  const pages = input.deckDesign?.pages ?? [];
  if (pages.length === 0) return gaps;
  // No knowledge points assigned to this item, so no page could name one: the
  // mismatch machines cannot resolve here is a graph gap, reported by the rules
  // that own the graph, not by the storyboard's.
  if (input.nodes.length === 0) return gaps;

  const taught = new Set<string>();
  for (const page of pages) {
    for (const entry of page.teaches ?? []) {
      for (const node of input.nodes) {
        if (nameKey(node.name) === nameKey(entry) || node.id === entry) taught.add(node.id);
      }
    }
  }

  // The buckets are read by id **or** name: the step's own writer stores ids, but
  // the workbench's unit editor writes what the author typed, and a lecture whose
  // script says "讲透 SQL 查询与参数化" and whose page says "讲：SQL 查询与参数化"
  // is a consistent design. Reporting that as a conflict would be a false alarm on
  // the one screen where a false alarm costs the author's trust in the strip.
  const core = (input.teachingDesign.core ?? []).map(
    (entry) =>
      input.nodes.find((node) => node.id === entry)?.id ??
      input.nodes.find((node) => nameKey(node.name) === nameKey(entry))?.id ??
      entry,
  );
  const untold = core.filter((nodeId) => !taught.has(nodeId));
  if (untold.length > 0) {
    const names = untold.map((id) => input.nodes.find((node) => node.id === id)?.name ?? id);
    gaps.push({
      ref: input.id,
      kind: 'script_storyboard_conflict',
      text:
        `「${input.title}」的教学设计要求讲透 ${names.join('、')}，但分镜里没有一页担着它：` +
        '脚本说要讲透的东西必须落到某一页上',
    });
  }

  const omitted = new Set<string>();
  for (const entry of input.teachingDesign.omit ?? []) {
    const byId = input.nodes.find((node) => node.id === entry);
    if (byId) {
      omitted.add(entry);
      continue;
    }
    const byName = input.nodes.find((node) => nameKey(node.name) === nameKey(entry));
    if (byName) omitted.add(byName.id);
  }
  const contradicted = [...omitted].filter((nodeId) => taught.has(nodeId));
  if (contradicted.length > 0) {
    const names = contradicted.map((id) => input.nodes.find((node) => node.id === id)?.name ?? id);
    gaps.push({
      ref: input.id,
      kind: 'script_storyboard_conflict',
      text: `「${input.title}」的教学设计写明不讲 ${names.join('、')}，分镜里却有页面在讲：两者只能留一个`,
    });
  }

  return gaps;
}

/**
 * 这一条还差什么。
 *
 * 按角色分档，因为三种条目要交的东西不同：讲课条目要有分镜（幻灯片是它的产物），
 * 练习条目要说清楚练什么（它生成的是场景），考试条目的内容由下一步的题目承载。
 */
export function teachingGapsOfItems(items: readonly TeachingGapInput[]): TeachingGap[] {
  const gaps: TeachingGap[] = [];
  if (items.length === 0) {
    gaps.push({
      kind: 'no_items',
      text: `还没有任何条目：教学设计是逐条写的，先到${stepRef('outline')}排出条目`,
    });
    return gaps;
  }

  for (const item of items) {
    const design = item.teachingDesign ?? {};
    const buckets = ASSIGNED_NODE_BUCKETS.flatMap((bucket) => design[bucket] ?? []);
    const pages = item.deckDesign?.pages ?? [];
    const hasWork =
      buckets.length > 0 ||
      (design.cases ?? []).length > 0 ||
      (design.demos ?? []).length > 0 ||
      (design.operations ?? []).length > 0 ||
      (design.drills ?? []).length > 0 ||
      pages.length > 0;

    if (!hasWork) {
      gaps.push({
        ref: item.id,
        kind: 'no_design',
        text: `「${item.title}」还没有教学设计：这一条讲什么、讲到什么程度都还没定`,
      });
      continue;
    }

    if (buckets.length === 0) {
      gaps.push({
        ref: item.id,
        kind: 'no_bucket',
        text: `「${item.title}」的四个深度档都是空的：没有"讲透/带过/点名"的内容，等于这一条什么都不教`,
      });
    }

    if (item.role === 'lecture') {
      if (pages.length === 0) {
        gaps.push({
          ref: item.id,
          kind: 'no_deck',
          text: `「${item.title}」是讲课条目，但还没有分镜（页面计划）：生成器拿不到页结构就会自己编一套`,
        });
      } else {
        // Only when the item has knowledge points to name. An item that covers no
        // outcome has nothing a page could be responsible for — that is
        // `unit_orphan`'s finding, and demanding a page-level name here would
        // report the same gap twice in a place the author cannot act on.
        const unassigned =
          item.nodes.length === 0
            ? []
            : pages
                .filter((page) => page.mode !== 'summary' && (page.teaches ?? []).length === 0)
                .map((_, index) => index + 1);
        if (unassigned.length > 0 && pages.every((page) => (page.teaches ?? []).length === 0)) {
          gaps.push({
            ref: item.id,
            kind: 'page_without_node',
            text: `「${item.title}」的分镜没有任何一页点名知识点：分镜必须把脚本逐页对上，否则它只是一个标题列表`,
          });
        } else if (unassigned.length > 0) {
          gaps.push({
            ref: item.id,
            kind: 'page_without_node',
            text: `「${item.title}」的第 ${unassigned.join('、')} 页没有点名任何知识点（小结页除外）`,
          });
        }
        const conflicts = scriptStoryboardConflicts(item);
        gaps.push(...conflicts);
      }
    }

    // A practice item is **not** required to name `operations`/`drills` here. The
    // concrete drill — its environment, its steps, its grading — is authored in
    // the next step as a lab task, and demanding a prose copy of it in the
    // teaching script would make the same decision twice. What this step owes for
    // a practice item is the same as for any other: what it is about and how deep.

    const sequence = design.sequence ?? [];
    const missingFromSequence = (design.core ?? []).filter((nodeId) => !sequence.includes(nodeId));
    if (sequence.length > 0 && missingFromSequence.length > 0) {
      const names = missingFromSequence.map(
        (id) => item.nodes.find((node) => node.id === id)?.name ?? id,
      );
      gaps.push({
        ref: item.id,
        kind: 'sequence_missing_core',
        text: `「${item.title}」顺序里没有 ${names.join('、')}，而它们是要求讲透的：讲透的内容要有先后位置`,
      });
    }
  }

  return gaps;
}

/**
 * {@link teachingGapsOfItems} over records, for the surfaces that hold records: the
 * state payload the routes answer with, the phase gate, and the audit rule. One
 * implementation, so the three cannot disagree about what "还没有教学设计" means.
 */
export function teachingGapsOfRecords(
  units: readonly CurriculumUnitRecord[],
  coverage: readonly CurriculumUnitCoverageRecord[],
  nodes: readonly CurriculumLearningNodeRecord[],
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[],
): TeachingGap[] {
  const items = onlyItems(units).map((unit) => gapInputOf(unit, coverage, nodes, nodeObjectives));
  return teachingGapsOfItems(items);
}

/** 教学设计的面板事实：从记录拼出规则层要的形状。 */
export function teachingGapInputOf(
  unit: CurriculumUnitRecord,
  coverage: readonly CurriculumUnitCoverageRecord[],
  nodes: readonly CurriculumLearningNodeRecord[],
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[],
): TeachingGapInput {
  return gapInputOf(unit, coverage, nodes, nodeObjectives);
}

/**
 * The same item, in the richer shape the prompt renderer needs: it also carries
 * the hours and the outcome ids, because the model is told how long the lesson is
 * and which outcomes it serves.
 */
export function teachingItemBoardOf(
  unit: CurriculumUnitRecord,
  coverage: readonly CurriculumUnitCoverageRecord[],
  nodes: readonly CurriculumLearningNodeRecord[],
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[],
): TeachingItemBoard {
  const gapInput = gapInputOf(unit, coverage, nodes, nodeObjectives);
  return {
    ...gapInput,
    hours: unit.hours,
    objectiveIds: coverage.filter((row) => row.unitId === unit.id).map((row) => row.objectiveId),
  };
}

/** Every item of a task, in the shape the prompt renderer and the rules take. */
export function teachingItemsOfRecords(
  units: readonly CurriculumUnitRecord[],
  coverage: readonly CurriculumUnitCoverageRecord[],
  nodes: readonly CurriculumLearningNodeRecord[],
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[],
): TeachingItemBoard[] {
  return onlyItems(units).map((unit) => teachingItemBoardOf(unit, coverage, nodes, nodeObjectives));
}

/** 只有条目才承载教学设计：章节没有角色，也没有产物。 */
export function onlyItems(units: readonly CurriculumUnitRecord[]): CurriculumUnitRecord[] {
  return units.filter((unit) => unit.unitType === 'item');
}

function gapInputOf(
  unit: CurriculumUnitRecord,
  coverage: readonly CurriculumUnitCoverageRecord[],
  nodes: readonly CurriculumLearningNodeRecord[],
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[],
): TeachingGapInput {
  const objectiveIds = coverage
    .filter((row) => row.unitId === unit.id)
    .map((row) => row.objectiveId);
  return {
    id: unit.id,
    title: unit.title,
    role: unit.unitRole ?? 'lecture',
    teachingDesign: unit.teachingDesign ?? {},
    deckDesign: unit.deckDesign ?? {},
    nodes: nodesForObjectives(objectiveIds, nodeObjectives, nodes),
    allNodeNames: new Map(nodes.map((node) => [node.id, node.name])),
  };
}

/**
 * 一个条目能点的节点：它覆盖的目标背后的知识/技能节点。
 *
 * 这是"教学设计不能引入大纲没分配的节点"的可算形式——目标是中间人，而不是让条目
 * 直接挂节点，因为条目与目标的绑定（`unit_coverage`）才是大纲签过字的那份关系。
 * 一个目标可能由多个条目分别讲授，所以两个条目会拿到重叠的节点集，这是对的：
 * 同一个知识点在不同的课里深浅不同，正是"教学变体"的来源。
 */
export function nodesForObjectives(
  objectiveIds: readonly string[],
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[],
  nodes: readonly CurriculumLearningNodeRecord[],
): { id: string; name: string }[] {
  const wanted = new Set(objectiveIds);
  const nodeIds = new Set(
    nodeObjectives.filter((row) => wanted.has(row.objectiveId)).map((row) => row.nodeId),
  );
  return nodes
    .filter((node) => nodeIds.has(node.id))
    .map((node) => ({ id: node.id, name: node.name }));
}

/**
 * 一条条目的页面数量是不是偏离了讲课节奏。
 *
 * 只是提示：学时由课程自己定，规则层不该把节奏写成硬约束，而页数偏少的真正后果是
 * "一页塞进半节课"，那件事只有作者能判断。
 */
export function deckPageAdvisories(item: {
  title: string;
  role: CurriculumUnitRole;
  deckDesign: CurriculumDeckDesign;
}): { text: string }[] {
  if (item.role !== 'lecture') return [];
  const pages = item.deckDesign?.pages ?? [];
  if (pages.length === 0) return [];
  if (pages.length >= DECK_PAGE_TARGET.min && pages.length <= DECK_PAGE_TARGET.max) return [];
  return [
    {
      text: `「${item.title}」的分镜有 ${pages.length} 页；一段讲课通常 ${DECK_PAGE_TARGET.min}–${DECK_PAGE_TARGET.max} 页`,
    },
  ];
}

/**
 * 是否采纳模型声明的"用户已确认"，四条底线同前四步，第四条是这一步特有的：
 *
 * 1. 模型说了 `confirm`。
 * 2. 不是第一句话（至少两轮用户消息）。
 * 3. 这一轮真的动过教学设计。
 * 4. **没有任何缺口。** 一份带缺口的教学设计签下来，就等于承诺了一份还没写完的东西——
 *    而下一步（题目与实操）会把它当成已经定稿的输入。
 */
export function shouldConfirmTeaching(input: {
  confirmRequested: boolean;
  userTurns: number;
  itemCount: number;
  /** 只需要条数：调用方可能是审核发现（另一个形状），也可能就是缺口本身。 */
  gaps: readonly { text: string }[];
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
 * 这一步的现状，供提示词与面板共用。
 *
 * 每条条目给出：角色、学时、它覆盖的目标、它能点的节点（id + 名称），以及当前的脚本和
 * 分镜。**节点同时打印 id 和名称**：桶里要写 id、页面里要写名称，少打印一半，
 * 模型就会把名称写进桶里（然后被审核判成"没提到"）。
 */
export function formatTeachingPlan(board: TeachingBoard): string {
  if (board.items.length === 0) return `(还没有条目：先到${stepRef('outline')}排出章、节、目)`;
  const objectiveTitle = new Map(board.objectives.map((row) => [row.id, row.title]));
  return board.items
    .map((item) => {
      const lines: string[] = [
        `ref=${item.id}  【${ROLE_LABELS[item.role]}】${item.title}${
          item.hours === null ? '' : `（${item.hours} 学时）`
        }`,
      ];
      const objectives = item.objectiveIds
        .map((id) => `${id}(${objectiveTitle.get(id) ?? id})`)
        .join('、');
      lines.push(`    这条要达成的目标：${objectives || '无（缺口：先在大纲里给它挂目标）'}`);
      lines.push(
        `    可以点的知识点（写 id；桶和分镜都写 id，写名称也认）：${
          item.nodes.length === 0
            ? '无'
            : item.nodes.map((node) => `${node.id}=${node.name}`).join('、')
        }`,
      );
      const design = item.teachingDesign ?? {};
      const bucketText = ASSIGNED_NODE_BUCKETS.map((bucket) => {
        const ids = design[bucket] ?? [];
        if (ids.length === 0) return null;
        const names = ids.map((id) => item.nodes.find((node) => node.id === id)?.name ?? id);
        return `${TEACHING_DEPTH_LABELS[bucket]}：${names.join('、')}`;
      }).filter(Boolean);
      lines.push(`    授课脚本：${bucketText.length > 0 ? bucketText.join('；') : '（还没写）'}`);
      if ((design.omit ?? []).length > 0) {
        lines.push(`    明确不讲：${(design.omit ?? []).join('、')}`);
      }
      if ((design.sequence ?? []).length > 0) {
        lines.push(
          `    讲课顺序：${(design.sequence ?? [])
            .map((id) => item.nodes.find((node) => node.id === id)?.name ?? id)
            .join(' → ')}`,
        );
      }
      if ((design.prerequisites ?? []).length > 0) {
        lines.push(
          `    先修：${(design.prerequisites ?? [])
            .map((id) => item.allNodeNames?.get(id) ?? id)
            .join('、')}`,
        );
      }
      const pages = item.deckDesign?.pages ?? [];
      if (item.role === 'lecture') {
        if (pages.length === 0) {
          lines.push('    分镜：（还没有页面）');
        } else {
          lines.push(`    分镜（${pages.length} 页）：`);
          for (const page of pages) {
            lines.push(
              `      ${page.order}. ${page.title}｜目标：${page.goal}｜核心：${page.coreInfo}｜呈现：${
                DECK_PAGE_MODE_LABELS[page.mode] ?? page.mode
              }${
                (page.teaches ?? []).length > 0
                  ? `｜讲：${(page.teaches ?? [])
                      .map((id) => item.nodes.find((node) => node.id === id)?.name ?? id)
                      .join('、')}`
                  : ''
              }`,
            );
          }
        }
      } else {
        lines.push('    分镜：（练习/考试条目没有分镜）');
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

export const ROLE_LABELS: Record<CurriculumUnitRole, string> = {
  lecture: '讲课',
  practice: '练习',
  exam: '考试',
};

/** 覆盖类型的中文名，用于渲染"这个条目承担了哪些承诺"。 */
export const COVERAGE_KIND_LABELS: Record<CurriculumCoverageKind, string> = {
  teach: '讲授',
  practice: '练习',
  assess: '考核',
};

/** 角色白名单，导出给路由与工具做校验。 */
export { CURRICULUM_UNIT_ROLES };
