/**
 * 系列级设计：课程方向的「上三步」——方向、课程目标、知识体系。
 *
 * 为什么需要这一层：七步模型是按「一门课」设计的，而《CTF 综合实战》这样的
 * 系列里，「一门课」是目（一节课、一个视频）。于是同一个七步在 63 个目上各走
 * 一遍，得到的是 63 份互相对不上的课程方向、63 套互不相连的知识图——这正是
 * 用户看到的「每个目都要七步？？？」。真相是：**第 1–3 步的目标本来就是系列，
 * 不是目。**
 *
 * 分工：
 *
 * - 系列（一次）：方向（谁学、什么基础、什么场景）→ 课程目标与证据 → 知识体系。
 * - 目（每目）：继承方向；承接课程目标中的若干条；在系列知识体系里挑本目要讲
 *   的点；然后才是目自己的条目、讲稿、题目、审核。
 *
 * 这一层不建表：设计文档挂在 `curriculum_series` 的两列 JSONB 上。理由不是省事，
 * 是这三种东西的**形状由作者决定**（目标几条、节点怎么分组），而它们之间没有
 * 外键关系需要数据库守——唯一需要守的关系是「目标引用了存在的知识点」「先修不
 * 成环」，这两条在写入时由本模块校验，比库约束更能给出可读的报错。
 *
 * 本模块不读库、不调模型：路由把状态传进来，它回答「能不能写、写什么、还缺
 * 什么」。因此每一条规则都能在没有数据库和模型的测试里钉住。
 */

import { sanitizeDirectionFields } from './design-direction';
import {
  CURRICULUM_OBJECTIVE_TYPES,
  OUTCOME_TYPE_LABELS,
  type CurriculumObjectiveType,
} from './design-types';

export const SERIES_DESIGN_PHASES = ['direction', 'objectives', 'knowledge'] as const;
export type SeriesDesignPhase = (typeof SERIES_DESIGN_PHASES)[number];

/**
 * 课程目标与知识节点的上限。它们不是「建议」，是拒绝线：超了说明模型没有按
 * 数量约束作答，继续截断会让用户以为生成的比实际多。
 */
export const SERIES_DESIGN_LIMITS = {
  objectives: 40,
  nodes: 400,
  minCriteriaPerObjective: 8,
  prerequisitesPerNode: 16,
  titleChars: 120,
  behaviorChars: 300,
  criteriaChars: 200,
  summaryChars: 300,
  nodeNameChars: 80,
} as const;

/** 系列方向。授课对象/学时是系列行的既有列，其余是这次新增的列。 */
export interface SeriesDesignDirection {
  /** 谁学。**目的第 1 步继承它**：让六十三目各填一遍，得到的是四份互相矛盾的答案。 */
  audience: string | null;
  /** 开课前已经会什么。 */
  learnerLevel: string | null;
  /** 授课形式，例如「线下集中实训 + 线上自学」。 */
  trainingScenario: string | null;
  /** 学完在哪里用，例如「校内选拔赛 / 校队集训」。 */
  applicationScene: string | null;
  /** 整个系列要解决什么问题、明确不做什么。目的范围仍由目自己写。 */
  problemStatement: string | null;
  /** 系列总学时。目的学时由大纲给出，缺省时按 `default_hours` 回填。 */
  durationHours: number | null;
}

/**
 * 一条课程级学习目标。它是**课程**承诺的东西，不是某一节课的。
 *
 * `expectedBehavior` 与 `minCriteria` 刻意不设默认值：没有可观察行为的目标只是
 * 话题（"了解 SQL 注入"），第七步的审核会在目层拒收它，而那时用户已经在它上面
 * 建了十来个条目。所以这里在写入时就要求两样都写。
 */
export interface SeriesCourseObjective {
  id: string;
  /** 这条目标属于哪一类承诺（知识 / 技能 / 能力 / 任务）。旧系列没有这一列，读出来是 null。 */
  type: CurriculumObjectiveType | null;
  title: string;
  /** 学完能做出什么可观察的行为。 */
  expectedBehavior: string;
  /** 最低达标线，至少一条。 */
  minCriteria: string[];
  /** 怎么证明：考试 / 实操 / 作品…写成一句可执行的话。 */
  evidence: string;
  /** 支撑这条目标的系列知识点 id。 */
  nodeIds: string[];
}

export const SERIES_NODE_TYPES = ['knowledge', 'skill'] as const;
export type SeriesNodeType = (typeof SERIES_NODE_TYPES)[number];

export const SERIES_NODE_DIFFICULTIES = ['intro', 'basic', 'intermediate', 'advanced'] as const;
export type SeriesNodeDifficulty = (typeof SERIES_NODE_DIFFICULTIES)[number];

/** 系列知识体系里的一个知识 / 技能点。 */
export interface SeriesKnowledgeNode {
  id: string;
  name: string;
  type: SeriesNodeType;
  summary: string;
  difficulty: SeriesNodeDifficulty;
  /** 先修节点的 id；必须指向同一份文档里的节点。 */
  prerequisites: string[];
}

export const SERIES_NODE_TYPE_LABELS: Record<SeriesNodeType, string> = {
  knowledge: '知识',
  skill: '技能',
};

export const SERIES_NODE_DIFFICULTY_LABELS: Record<SeriesNodeDifficulty, string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
  advanced: '高级',
};

export function seriesNodeTypeLabel(type: SeriesNodeType): string {
  return SERIES_NODE_TYPE_LABELS[type];
}

export function seriesNodeDifficultyLabel(difficulty: SeriesNodeDifficulty): string {
  return SERIES_NODE_DIFFICULTY_LABELS[difficulty];
}

/**
 * 比较节点名用的键：去掉全部空白、忽略大小写。
 *
 * 中文节点名没有大小写，但术语会混英文（SQL / XSS）；模型也常把「HTTP 基础」写成
 * 「HTTP基础」。逐字相等会让重复项漏进清单，先修也会因此解析不到。
 */
export function nodeNameKey(name: string): string {
  return name.replace(/\s+/g, '').toLowerCase();
}

/** 模型写 `type` 可能用枚举，也可能用中文标签；两种都认。 */
function nodeTypeValue(value: unknown): SeriesNodeType | null {
  if (value === 'knowledge' || value === 'skill') return value;
  if (typeof value !== 'string') return null;
  const label = value.trim();
  if (label === '知识' || label === '知识点' || label === '概念') return 'knowledge';
  if (label === '技能' || label === '技能点' || label === '操作') return 'skill';
  return null;
}

/** 难度同理：认枚举与中文标签（入门 / 初级 / 基础 / 进阶 / 中级 / 高级…）。 */
function nodeDifficultyValue(value: unknown): SeriesNodeDifficulty | null {
  if (SERIES_NODE_DIFFICULTIES.includes(value as SeriesNodeDifficulty)) {
    return value as SeriesNodeDifficulty;
  }
  if (typeof value !== 'string') return null;
  const label = value.trim();
  const aliases: Record<string, SeriesNodeDifficulty> = {
    入门: 'intro',
    初级: 'intro',
    简单: 'intro',
    基础: 'basic',
    中等: 'intermediate',
    中级: 'intermediate',
    进阶: 'intermediate',
    高级: 'advanced',
    困难: 'advanced',
    难: 'advanced',
  };
  return aliases[label] ?? null;
}

export interface SeriesDesignDoc {
  direction: SeriesDesignDirection;
  objectives: SeriesCourseObjective[];
  nodes: SeriesKnowledgeNode[];
}

/** 带系列基本信息的设计快照，接口原样回给界面。 */
export interface SeriesDesignSnapshot {
  series: {
    id: string;
    name: string;
    description: string | null;
    audience: string | null;
    defaultHours: number | null;
    learnerLevel: string | null;
    trainingScenario: string | null;
    applicationScene: string | null;
    problemStatement: string | null;
    /** 系列行最后一次被写的时间（改名也会动它），不是设计时间。 */
    updatedAt: string;
    /** 设计最后一次经由保存接口写入的时间；从未保存过为 null。 */
    designUpdatedAt: string | null;
  };
  design: SeriesDesignDoc;
  /**
   * 这份设计的内容指纹。大纲与目上各存一份生成时的指纹，两者不等就说明
   * "这一层是旧版设计的产物"——界面据此提示，而不是靠比较保存时间。
   */
  designFingerprint: string;
  phase: SeriesDesignPhase;
  /** 每个阶段的缺口；空数组表示该阶段已满足。 */
  gaps: { direction: string[]; objectives: string[]; knowledge: string[] };
  /** 目标 id → 它的中文名，界面与目层引用用。 */
  objectiveTitles: Record<string, string>;
  nodeNames: Record<string, string>;
}

/**
 * 「设计变了，大纲与目哪里还没跟上」的一次读数。
 *
 * 由服务端按当前指纹与各行的指纹比对得出，界面不自己算：同一套规则在驾驶舱、
 * 系列设计页、大纲接口各算一份，迟早会出现"页头说过期、看板却没标"的分裂。
 */
export interface OutlineDesignDrift {
  /** 设计最后一次保存的时间；从未保存过为 null。 */
  designUpdatedAt: string | null;
  /** 当前设计指纹。 */
  fingerprint: string;
  /** 按旧版设计生成的章 / 节 / 目数量。 */
  stale: { chapters: number; sections: number; items: number };
  /** 章 / 节 / 目的总数，用来区分"全部过期"与"部分过期"。 */
  total: { chapters: number; sections: number; items: number };
}

/**
 * 系列设计在目里的「落点」覆盖：每条课程目标 / 知识点，是否已经被某个目的
 * 第 2 / 3 步承接。
 *
 * 方向很重要：**设计不需要先有大纲才能写，落点是设计写完、大纲建好之后的事后
 * 校验。** 之前把「要有落点」当成生成前提，结果新系列一进设计页点 AI 就被拒，
 * 而页面自己的顺序（方向 → 目标 → 知识点 → 大纲）又是设计先行——两处打架。
 */
export interface SeriesDesignCoverage {
  objectives: { total: number; unclaimed: number; titles: string[] };
  nodes: { total: number; unclaimed: number; names: string[] };
}

/**
 * 某一行是不是旧版设计的产物。
 *
 * 指纹为空表示这一行不是从设计派生的（手写、大纲导入），**不算过期**：对来源
 * 不明的内容喊过期只会变成噪声，而用户没法用"重新生成"消掉它。
 */
export function isDerivedFromStaleDesign(
  fingerprint: string | null | undefined,
  currentFingerprint: string,
): boolean {
  return fingerprint !== null && fingerprint !== undefined && fingerprint !== currentFingerprint;
}

/** 模型回答或请求体不是可用的设计文档：调用方映射成 400/502，一行都不写。 */
export class SeriesDesignInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesDesignInvalidError';
  }
}

function textOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function textOrEmpty(value: unknown): string {
  return textOrNull(value) ?? '';
}

function limitedText(value: unknown, label: string, max: number, required = false): string {
  const text = textOrNull(value);
  if (!text) {
    if (required) throw new SeriesDesignInvalidError(`${label}不能为空`);
    return '';
  }
  if (text.length > max) {
    throw new SeriesDesignInvalidError(`${label}超过 ${max} 字（现在 ${text.length} 字）`);
  }
  return text;
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
}

/** 生成稳定 id：模型与用户都不写 id，由这里发。 */
export function seriesObjectiveId(index: number): string {
  return `so_${index + 1}`;
}

export function seriesNodeId(index: number): string {
  return `sn_${index + 1}`;
}

/** 目标类型的中文名；`null` 是旧数据（分类出现之前写的目标），显示成「未分类」。 */
export function seriesObjectiveTypeLabel(type: CurriculumObjectiveType | null): string {
  return type === null ? '未分类' : OUTCOME_TYPE_LABELS[type];
}

const OBJECTIVE_TYPE_BY_LABEL = new Map<string, CurriculumObjectiveType>(
  CURRICULUM_OBJECTIVE_TYPES.map((type) => [OUTCOME_TYPE_LABELS[type], type]),
);

/**
 * 把「技能 / skill」两种写法都收成枚举。
 *
 * 中文提示词里模型偶尔会把类型写成中文标签，而结构化保存用的是枚举；两种都认，
 * 读库、文本编辑与候选解析共用这一份规则。
 */
export function objectiveTypeValue(value: unknown): CurriculumObjectiveType | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  const enumValue = CURRICULUM_OBJECTIVE_TYPES.find((type) => type === text);
  if (enumValue) return enumValue;
  return OBJECTIVE_TYPE_BY_LABEL.get(text) ?? null;
}

/**
 * 目标标题的比较键：去掉所有空白、忽略大小写。「能完成 Web 题」与「能完成Web题」
 * 是同一条目标；去重（候选 vs 已有、候选 vs 候选）用它，避免"看起来一模一样
 * 的两条"被采用两次。
 */
export function objectiveTitleKey(title: string): string {
  return title.replace(/[\s\u3000]+/g, '').toLowerCase();
}

/**
 * 按「知识 → 技能 → 能力 → 任务 → 未分类」分组，组内保持原顺序。
 *
 * 排序只发生在**显示**这一层：存进库里的顺序不动（目标的 id 按数组下标发，
 * 重排会让目里已经承接的行指向别的目标）。未分类排最后：它是旧数据，不该挤在
 * 新分类前面。
 */
export function groupSeriesObjectives<T extends { type: CurriculumObjectiveType | null }>(
  objectives: readonly T[],
): { type: CurriculumObjectiveType | null; items: T[] }[] {
  const groups = new Map<CurriculumObjectiveType | null, T[]>();
  for (const objective of objectives) {
    const bucket = groups.get(objective.type) ?? [];
    bucket.push(objective);
    groups.set(objective.type, bucket);
  }
  const order: (CurriculumObjectiveType | null)[] = [...CURRICULUM_OBJECTIVE_TYPES, null];
  return order
    .filter((type) => groups.has(type))
    .map((type) => ({ type, items: groups.get(type) as T[] }));
}

// ── AI 生成「候选课程目标」 ──────────────────────────────────────────────────

/**
 * 候选池里的一条目标。**没有 id**：它还不是这条系列的目标，采用时才写进库、
 * 由服务端按顺序发 id。类型在这里是必填的——用户就是按类型分组挑选的；没有
 * 类型的一条候选在清单里无处安放。
 */
export interface SeriesObjectiveCandidate {
  title: string;
  type: CurriculumObjectiveType;
  expectedBehavior: string;
  minCriteria: string[];
  evidence: string;
}

/**
 * 候选池的下限。低于这个数说明模型没有按"多给一些供挑选"作答，收下一小撮
 * 候选不如让用户重试一次——挑选的前提是有得挑。
 */
export const SERIES_OBJECTIVE_CANDIDATES_MIN = 6;
/** 候选池上限：超过它说明模型没按数量约束作答，继续追加只会让清单更难读。 */
export const SERIES_OBJECTIVE_CANDIDATES_MAX = 40;

/** 候选池不能当成可挑选的清单用。 */
export class SeriesObjectiveCandidatesInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesObjectiveCandidatesInvalidError';
  }
}

function clampText(value: string, max: number): string {
  return value.length > max ? value.slice(0, max) : value;
}

/** 达标线模型可能给字符串（"独立完成；写出 writeup"），也可能给数组；两种都认。 */
function looseStringList(value: unknown): string[] {
  const parts =
    typeof value === 'string' ? value.split(/[；;、\n]/) : Array.isArray(value) ? value : [];
  return parts
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
}

/**
 * 解析「AI 生成候选课程目标」的回答。
 *
 * 与 `parseSeriesDesignAnswer` 的差别：这里要的是**一大把可选清单**，不是一份
 * 要落库的完整设计。所以缺字段（没有可观察行为 / 达标线 / 证明方式）的候选被
 * 丢掉而不是整份拒绝——模型偶尔会把一两行写残，为此让用户重来不值得；但可用
 * 的少于下限时整份拒绝，因为"挑不出东西"和"生成失败"对用户是同一件事。
 *
 * 类型两种写法都认（枚举或中文标签）；标题去重，避免同一个意思出现两遍。
 */
export function parseSeriesObjectiveCandidatesAnswer(text: string): SeriesObjectiveCandidate[] {
  const json = extractJsonObject(text);
  const raw = Array.isArray(json.objectives)
    ? json.objectives
    : Array.isArray(json.candidates)
      ? json.candidates
      : [];
  const candidates: SeriesObjectiveCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const title = textOrNull(record.title);
    const type = objectiveTypeValue(record.type);
    const expectedBehavior = textOrNull(record.expectedBehavior);
    const evidence = textOrNull(record.evidence);
    const minCriteria = looseStringList(record.minCriteria);
    if (!title || !type || !expectedBehavior || !evidence || minCriteria.length === 0) continue;
    const key = objectiveTitleKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      title: clampText(title, SERIES_DESIGN_LIMITS.titleChars),
      type,
      expectedBehavior: clampText(expectedBehavior, SERIES_DESIGN_LIMITS.behaviorChars),
      minCriteria: minCriteria
        .slice(0, SERIES_DESIGN_LIMITS.minCriteriaPerObjective)
        .map((criterion) => clampText(criterion, SERIES_DESIGN_LIMITS.criteriaChars)),
      evidence: clampText(evidence, SERIES_DESIGN_LIMITS.behaviorChars),
    });
  }
  if (candidates.length < SERIES_OBJECTIVE_CANDIDATES_MIN) {
    throw new SeriesObjectiveCandidatesInvalidError(
      `模型只给出 ${candidates.length} 条可用的课程目标（至少 ${SERIES_OBJECTIVE_CANDIDATES_MIN} 条；类型、可观察行为、最低达标线、证明方式都要有）`,
    );
  }
  return candidates
    .sort(
      (left, right) =>
        CURRICULUM_OBJECTIVE_TYPES.indexOf(left.type) -
        CURRICULUM_OBJECTIVE_TYPES.indexOf(right.type),
    )
    .slice(0, SERIES_OBJECTIVE_CANDIDATES_MAX);
}

/** 去掉与已有目标重复的候选。比较用 `objectiveTitleKey`，不是逐字相等。 */
export function screenObjectiveCandidates(
  candidates: readonly SeriesObjectiveCandidate[],
  existing: readonly SeriesCourseObjective[],
): SeriesObjectiveCandidate[] {
  const existingKeys = new Set(existing.map((objective) => objectiveTitleKey(objective.title)));
  return candidates.filter((candidate) => !existingKeys.has(objectiveTitleKey(candidate.title)));
}

/**
 * 采用选中的候选：追加在已有目标之后，不动已有条目。
 *
 * 为什么是追加而不是替换：已有目标里可能有人手写的措辞与已承接的目，整体替换
 * 等于让用户在挑选时顺手丢东西。要删已有目标去「编辑文本」，那里删得明白。
 * 重复标题（候选之间或与已有之间）不追加第二次。
 */
export function appendObjectiveCandidates(
  existing: readonly SeriesCourseObjective[],
  selected: readonly SeriesObjectiveCandidate[],
): SeriesCourseObjective[] {
  const seen = new Set(existing.map((objective) => objectiveTitleKey(objective.title)));
  const appended: SeriesCourseObjective[] = [];
  for (const candidate of selected) {
    const key = objectiveTitleKey(candidate.title);
    if (seen.has(key)) continue;
    seen.add(key);
    appended.push({
      id: seriesObjectiveId(existing.length + appended.length),
      type: candidate.type,
      title: candidate.title,
      expectedBehavior: candidate.expectedBehavior,
      minCriteria: [...candidate.minCriteria],
      evidence: candidate.evidence,
      nodeIds: [],
    });
  }
  return [...existing, ...appended];
}

// ── AI 生成「候选知识 / 技能点」 ──────────────────────────────────────────────

/**
 * 候选池里的一个知识 / 技能点。**没有 id**：它还不是这份知识体系的一部分，采用时
 * 才写进文档、由服务端按顺序发 id。先修用**节点名**引用（已有节点，或清单里排在
 * 它前面的候选），因为候选还没有 id 可用。
 */
export interface SeriesKnowledgeCandidate {
  name: string;
  type: SeriesNodeType;
  summary: string;
  difficulty: SeriesNodeDifficulty;
  prerequisites: string[];
}

/**
 * 候选池的下限。低于这个数说明模型没有按"多给一些供挑选"作答：知识体系的候选
 * 本来就应该比最终采用的多（每个目标至少两三个支撑点），收下一小撮不如重试。
 */
export const SERIES_KNOWLEDGE_CANDIDATES_MIN = 8;
/** 候选池上限：超过它说明模型没按数量约束作答，继续追加只会让清单更难读。 */
export const SERIES_KNOWLEDGE_CANDIDATES_MAX = 120;

/** 候选池不能当成可挑选的清单用。 */
export class SeriesKnowledgeCandidatesInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesKnowledgeCandidatesInvalidError';
  }
}

/** 先修引用：模型可能给数组，也可能给「HTTP 基础、TCP/IP」这种字符串。 */
function looseRefList(value: unknown): string[] {
  const parts =
    typeof value === 'string' ? value.split(/[、,，;；\n]/) : Array.isArray(value) ? value : [];
  return parts
    .map((entry) => (typeof entry === 'string' ? entry.trim() : ''))
    .filter((entry) => entry !== '');
}

/**
 * 解析「AI 生成候选知识 / 技能点」的回答。
 *
 * 与 `parseSeriesDesignAnswer` 的差别：这里要的是一大把可选清单，不是一份要落库
 * 的文档。所以缺摘要的候选保留（摘要是说明，不是结构），但**没有名字或类型认不出
 * 的候选丢弃**——没有类型的一条候选在按类型分组的清单里无处安放。
 *
 * 类型与难度两种写法都认（枚举或中文标签）；名字按 `nodeNameKey` 去重，先修只留
 * 名字、去掉自引用。可用候选少于下限时整份拒绝：挑不出东西和生成失败对用户是
 * 同一件事。
 */
export function parseSeriesKnowledgeCandidatesAnswer(text: string): SeriesKnowledgeCandidate[] {
  const json = extractJsonObject(text);
  // 兼容 `{ nodes }`、`{ candidates }` 与 `{ knowledgeSystem: { nodes } }` 三种写法。
  const rawSystem =
    typeof json.knowledgeSystem === 'object' &&
    json.knowledgeSystem !== null &&
    !Array.isArray(json.knowledgeSystem)
      ? (json.knowledgeSystem as Record<string, unknown>)
      : json;
  const raw = Array.isArray(rawSystem.nodes)
    ? rawSystem.nodes
    : Array.isArray(json.candidates)
      ? json.candidates
      : [];

  const candidates: SeriesKnowledgeCandidate[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = textOrNull(record.name);
    if (!name) continue;
    const type = nodeTypeValue(record.type);
    if (!type) continue;
    const key = nodeNameKey(name);
    if (seen.has(key)) continue;
    seen.add(key);
    const prerequisites: string[] = [];
    for (const ref of looseRefList(record.prerequisites)) {
      const refKey = nodeNameKey(ref);
      if (!refKey || refKey === key) continue;
      if (prerequisites.some((existing) => nodeNameKey(existing) === refKey)) continue;
      prerequisites.push(clampText(ref, SERIES_DESIGN_LIMITS.nodeNameChars));
      if (prerequisites.length >= SERIES_DESIGN_LIMITS.prerequisitesPerNode) break;
    }
    candidates.push({
      name: clampText(name, SERIES_DESIGN_LIMITS.nodeNameChars),
      type,
      summary: clampText(textOrNull(record.summary) ?? '', SERIES_DESIGN_LIMITS.summaryChars),
      difficulty: nodeDifficultyValue(record.difficulty) ?? 'basic',
      prerequisites,
    });
  }
  if (candidates.length < SERIES_KNOWLEDGE_CANDIDATES_MIN) {
    throw new SeriesKnowledgeCandidatesInvalidError(
      `模型只给出 ${candidates.length} 个可用的知识 / 技能点（至少 ${SERIES_KNOWLEDGE_CANDIDATES_MIN} 个；每个都要有名字和类型）`,
    );
  }
  // 按类型分组显示：知识在前、技能在后；组内由浅入深；同难度保持模型给出的顺序。
  return candidates
    .map((candidate, index) => ({ candidate, index }))
    .sort(
      (left, right) =>
        SERIES_NODE_TYPES.indexOf(left.candidate.type) -
          SERIES_NODE_TYPES.indexOf(right.candidate.type) ||
        SERIES_NODE_DIFFICULTIES.indexOf(left.candidate.difficulty) -
          SERIES_NODE_DIFFICULTIES.indexOf(right.candidate.difficulty) ||
        left.index - right.index,
    )
    .map((entry) => entry.candidate)
    .slice(0, SERIES_KNOWLEDGE_CANDIDATES_MAX);
}

/** 去掉与已有知识 / 技能点重复的候选（比较折叠空白后的名字）。 */
export function screenNodeCandidates(
  candidates: readonly SeriesKnowledgeCandidate[],
  existing: readonly SeriesKnowledgeNode[],
): SeriesKnowledgeCandidate[] {
  const existingKeys = new Set(existing.map((node) => nodeNameKey(node.name)));
  return candidates.filter((candidate) => !existingKeys.has(nodeNameKey(candidate.name)));
}

export interface SeriesNodeGroup<T> {
  type: SeriesNodeType;
  items: T[];
}

/**
 * 按类型分组并按难度排序。存库顺序不动（节点 id 按数组下标发）；这里只用于显示
 * 与候选清单——知识在前、技能在后，组内由浅入深。
 */
export function groupSeriesNodes<
  T extends { type: SeriesNodeType; difficulty: SeriesNodeDifficulty },
>(nodes: readonly T[]): SeriesNodeGroup<T>[] {
  return SERIES_NODE_TYPES.map((type) => {
    const items = nodes.filter((node) => node.type === type);
    items.sort(
      (left, right) =>
        SERIES_NODE_DIFFICULTIES.indexOf(left.difficulty) -
        SERIES_NODE_DIFFICULTIES.indexOf(right.difficulty),
    );
    return { type, items };
  }).filter((group) => group.items.length > 0);
}

/**
 * 采用选中的候选：追加在已有知识 / 技能点之后，已有节点不动（节点 id 按数组下标
 * 发，重排会让目标里的 `nodeIds` 与目里的承接指向别的点）。
 *
 * 先修解析只认**已有的节点**或**排在前面的已选候选**：
 * - 指向未勾选的候选 → 丢掉（它不会进文档，留着就是坏引用，保存会被 400 拒）；
 * - 指向后面才出现的候选 → 也丢掉。这条规则同时保证了不会成环，省得用户辛苦挑完
 *   却撞上"先修关系成环"；
 * - 指向已有节点 → 原样保留（已有节点 id 一定比新节点小）。
 *
 * 名字重复（候选之间或与已有之间）不追加第二次。
 */
export function appendNodeCandidates(
  existing: readonly SeriesKnowledgeNode[],
  selected: readonly SeriesKnowledgeCandidate[],
): SeriesKnowledgeNode[] {
  const available = new Map(existing.map((node) => [nodeNameKey(node.name), node.id]));
  const added: SeriesKnowledgeNode[] = [];
  for (const candidate of selected) {
    const key = nodeNameKey(candidate.name);
    if (available.has(key)) continue;
    const id = seriesNodeId(existing.length + added.length);
    const prerequisites: string[] = [];
    for (const ref of candidate.prerequisites) {
      const target = available.get(nodeNameKey(ref));
      if (!target || target === id || prerequisites.includes(target)) continue;
      prerequisites.push(target);
      if (prerequisites.length >= SERIES_DESIGN_LIMITS.prerequisitesPerNode) break;
    }
    added.push({
      id,
      name: candidate.name,
      type: candidate.type,
      summary: candidate.summary,
      difficulty: candidate.difficulty,
      prerequisites,
    });
    // 只有已经加进文档的候选才能被后面的候选引用。
    available.set(key, id);
  }
  return [...existing, ...added];
}

/**
 * 勾选里有多少条先修引用落不了地（指向没勾选的候选，或排在后面的候选）。
 * 弹窗用它提醒用户：这些引用在采用时会被丢掉，而不是悄悄消失。
 */
export function countDroppedNodePrerequisites(
  existing: readonly SeriesKnowledgeNode[],
  selected: readonly SeriesKnowledgeCandidate[],
): number {
  const available = new Set(existing.map((node) => nodeNameKey(node.name)));
  let dropped = 0;
  for (const candidate of selected) {
    const key = nodeNameKey(candidate.name);
    if (available.has(key)) continue;
    for (const ref of candidate.prerequisites) {
      const refKey = nodeNameKey(ref);
      if (!refKey || refKey === key) continue;
      if (!available.has(refKey)) dropped += 1;
    }
    available.add(key);
  }
  return dropped;
}

/** 系列方向里可以由 AI 填写的槽位，顺序即界面顺序。 */
export const SERIES_DIRECTION_KEYS = [
  'audience',
  'learnerLevel',
  'trainingScenario',
  'applicationScene',
  'problemStatement',
  'durationHours',
] as const;

/** 模型的回答没法当成一份方向草稿用。 */
export class SeriesDirectionInvalidError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesDirectionInvalidError';
  }
}

/**
 * 解析「AI 填写方向」的回答。
 *
 * 方向是七步里的第一步，也是唯一一步**不需要先有目标与知识体系**的：用户建
 * 系列时往往只写了名称和一句说明，正是最需要模型帮一把的时候。所以这里不复用
 * `parseSeriesDesignAnswer`——那个函数要求目标和节点同时存在，而这一步只有
 * 六个槽位。
 *
 * 槽位的清洗复用 `sanitizeDirectionFields`（课时允许 `"54 学时"`、空串算未填、
 * 未知键丢弃），再收窄到系列的六个键：`title` 属于系列名称本身，不在这里。
 * 授课对象必须有着落，否则这份草稿什么也没帮上——界面会把它当作失败。
 */
export function parseSeriesDirectionAnswer(text: string): SeriesDesignDirection {
  const json = extractJsonObject(text);
  // 兼容 `{ "direction": {...} }` 与直接平铺两种写法：提示词要求前者，但模型
  // 偶尔会把对象摊平，为此让用户重来一次不值得。
  const raw = json.direction;
  const source =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as unknown) : json;
  const { fields } = sanitizeDirectionFields(source);
  const direction: SeriesDesignDirection = {
    audience: fields.audience ?? null,
    learnerLevel: fields.learnerLevel ?? null,
    trainingScenario: fields.trainingScenario ?? null,
    applicationScene: fields.applicationScene ?? null,
    problemStatement: fields.problemStatement ?? null,
    durationHours: fields.durationHours ?? null,
  };
  if (!direction.audience) {
    throw new SeriesDirectionInvalidError('模型没有给出授课对象（谁学）');
  }
  return direction;
}

/** 方向缺什么。授课对象是硬条件：目要继承它，缺了目连第 1 步都过不去。 */
export function seriesDirectionGaps(direction: SeriesDesignDirection): string[] {
  const gaps: string[] = [];
  if (!direction.audience) gaps.push('还没有授课对象（目会继承它，缺了目过不了第 1 步）');
  if (!direction.problemStatement) gaps.push('还没有课程范围（这门系列要解决什么、不做什么）');
  if (direction.durationHours === null) gaps.push('还没有系列总学时');
  return gaps;
}

/** 目标缺什么。这是系列层最容易被糊弄过去的地方，检查得最细。 */
export function seriesObjectiveGaps(objectives: readonly SeriesCourseObjective[]): string[] {
  if (objectives.length === 0) return ['还没有课程目标'];
  const gaps: string[] = [];
  const noBehavior = objectives.filter((objective) => !objective.expectedBehavior);
  if (noBehavior.length > 0) {
    gaps.push(
      `${noBehavior.length} 条课程目标没有可观察行为（例如「${noBehavior[0].title}」），它们只是话题`,
    );
  }
  const noCriteria = objectives.filter((objective) => objective.minCriteria.length === 0);
  if (noCriteria.length > 0) {
    gaps.push(`${noCriteria.length} 条课程目标没有最低达标标准`);
  }
  const noEvidence = objectives.filter((objective) => !objective.evidence);
  if (noEvidence.length > 0) {
    gaps.push(`${noEvidence.length} 条课程目标没写怎么证明`);
  }
  const noNodes = objectives.filter((objective) => objective.nodeIds.length === 0);
  if (noNodes.length > 0) {
    gaps.push(
      `${noNodes.length} 条课程目标没有支撑知识点（例如「${noNodes[0].title}」），目标会悬空`,
    );
  }
  return gaps;
}

/** 知识体系缺什么。 */
export function seriesKnowledgeGaps(
  objectives: readonly SeriesCourseObjective[],
  nodes: readonly SeriesKnowledgeNode[],
): string[] {
  const gaps: string[] = [];
  if (nodes.length === 0) {
    gaps.push('还没有知识 / 技能点');
    return gaps;
  }
  const unused = nodes.filter(
    (node) => !objectives.some((objective) => objective.nodeIds.includes(node.id)),
  );
  if (unused.length > 0) {
    gaps.push(
      `${unused.length} 个知识点不支撑任何课程目标（例如「${unused[0].name}」），先修关系会失去依据`,
    );
  }
  const noPrerequisites = nodes.filter(
    (node) => node.prerequisites.length === 0 && node.difficulty !== 'intro',
  );
  if (noPrerequisites.length === nodes.length) {
    gaps.push('所有知识点都没有先修关系，知识体系退化成一张清单');
  }
  return gaps;
}

/** 由文档内容推出它走到哪一步，不另存一个会和文档矛盾的相位字段。 */
export function seriesDesignPhase(doc: SeriesDesignDoc): SeriesDesignPhase {
  if (doc.objectives.length === 0) return 'direction';
  if (doc.nodes.length === 0) return 'objectives';
  if (doc.objectives.some((objective) => objective.nodeIds.length === 0)) return 'objectives';
  return 'knowledge';
}

/**
 * 前三步（方向 / 课程目标 / 知识体系）是不是**已经定下来**。
 *
 * 相位只看目标与节点，回答不了这个问题：方向可以为空、目标可以没有证据，而
 * 相位照旧停在 `knowledge`。大纲是这三步的推导结果，所以"能不能去搭大纲"
 * 必须用缺口判断，而不是相位。
 *
 * 只看 direction 与 objectives 两份缺口，不看 knowledge 的"所有知识点都没有
 * 先修"这类质量建议：那是提醒，不是阻止用户继续的硬条件（一门全是 intro 的
 * 入门课天然没有先修）。
 */
export function seriesDesignComplete(doc: SeriesDesignDoc): boolean {
  return (
    seriesDirectionGaps(doc.direction).length === 0 &&
    seriesObjectiveGaps(doc.objectives).length === 0
  );
}

/** 全部三个阶段的缺口。 */
export function seriesDesignGaps(doc: SeriesDesignDoc): {
  direction: string[];
  objectives: string[];
  knowledge: string[];
} {
  return {
    direction: seriesDirectionGaps(doc.direction),
    objectives: seriesObjectiveGaps(doc.objectives),
    knowledge: seriesKnowledgeGaps(doc.objectives, doc.nodes),
  };
}

/**
 * 设计文档的规范化文本，指纹就是它的哈希。
 *
 * 逐项写死字段与顺序，而不是 `JSON.stringify(doc)`：对象键序由写入方决定，同一
 * 份设计经两条路径（PATCH 与 AI 采用）写进来会得到两个指纹，于是整份大纲被误判
 * 成过期。集合字段（目标的 `nodeIds`、节点的 `prerequisites`）排序：调换先修
 * 关系的书写顺序不是设计变更。
 *
 * 本函数不哈希（客户端也能调），哈希在服务端做（`fingerprintSeriesDesign`）。
 */
export function canonicalSeriesDesign(doc: SeriesDesignDoc): string {
  const field = (value: string | null) => (value === null ? '' : value);
  const direction = doc.direction;
  const objectives = doc.objectives.map((objective) =>
    [
      objective.id,
      objective.title,
      objective.expectedBehavior,
      objective.minCriteria.join('\u0001'),
      objective.evidence,
      [...objective.nodeIds].sort().join('\u0001'),
      // 类型只在有值时参与：分类出现之前写的目标没有这一列，无条件加空字段会
      // 让所有既有系列的指纹变一次，把全部大纲误报成「旧版设计」。
      ...(objective.type === null ? [] : [objective.type]),
    ].join('\u0002'),
  );
  const nodes = doc.nodes.map((node) =>
    [
      node.id,
      node.name,
      node.type,
      node.summary,
      node.difficulty,
      [...node.prerequisites].sort().join('\u0001'),
    ].join('\u0002'),
  );
  return [
    'v1',
    field(direction.audience),
    field(direction.learnerLevel),
    field(direction.trainingScenario),
    field(direction.applicationScene),
    field(direction.problemStatement),
    direction.durationHours === null ? '' : String(direction.durationHours),
    objectives.join('\u0003'),
    nodes.join('\u0003'),
  ].join('\u0004');
}

/**
 * 把库里的 JSONB 读成文档。坏数据不抛：读接口挂掉比少一行更糟，而这里的每一行
 * 都会被 `dropInvalidNodes` 之类的方式筛掉——但**筛掉的东西必须能看见**，所以
 * 归一化函数把问题写进返回值，由调用方决定是否提示。
 */
export interface NormalizedSeriesDesign {
  design: SeriesDesignDoc;
  /** 被丢弃的条目，写给用户看。 */
  dropped: string[];
}

export function normalizeSeriesDesignDoc(input: {
  audience: unknown;
  defaultHours: unknown;
  learnerLevel: unknown;
  trainingScenario: unknown;
  applicationScene: unknown;
  problemStatement: unknown;
  courseObjectives: unknown;
  knowledgeSystem: unknown;
}): NormalizedSeriesDesign {
  const dropped: string[] = [];
  const direction: SeriesDesignDirection = {
    audience: textOrNull(input.audience),
    learnerLevel: textOrNull(input.learnerLevel),
    trainingScenario: textOrNull(input.trainingScenario),
    applicationScene: textOrNull(input.applicationScene),
    problemStatement: textOrNull(input.problemStatement),
    durationHours:
      typeof input.defaultHours === 'number' && Number.isFinite(input.defaultHours)
        ? input.defaultHours
        : null,
  };

  const rawSystems =
    typeof input.knowledgeSystem === 'object' && input.knowledgeSystem !== null
      ? (input.knowledgeSystem as Record<string, unknown>)
      : {};
  const nodeList = Array.isArray(rawSystems.nodes) ? rawSystems.nodes : [];
  const nodes: SeriesKnowledgeNode[] = [];
  /** 原数组下标 → 过滤后下标，先修关系第二轮解析要用它对齐。 */
  const keptIndexes = new Map<number, number>();
  nodeList.forEach((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const name = textOrNull(record.name);
    if (!name) {
      dropped.push(`第 ${index + 1} 个知识点没有名字`);
      return;
    }
    const type = SERIES_NODE_TYPES.includes(record.type as SeriesNodeType)
      ? (record.type as SeriesNodeType)
      : 'knowledge';
    const difficulty = SERIES_NODE_DIFFICULTIES.includes(record.difficulty as SeriesNodeDifficulty)
      ? (record.difficulty as SeriesNodeDifficulty)
      : 'basic';
    keptIndexes.set(index, nodes.length);
    nodes.push({
      id: seriesNodeId(nodes.length),
      name,
      type,
      summary: textOrEmpty(record.summary),
      difficulty,
      prerequisites: [],
    });
  });
  // 先修关系第二次解析：id 由本模块按顺序发，模型给的是名字/旧 id，两种都认。
  const names = new Map(nodes.map((node) => [node.name, node.id]));
  const ids = new Set(nodes.map((node) => node.id));
  nodeList.forEach((entry, index) => {
    const target = keptIndexes.get(index);
    if (target === undefined) return;
    const record = (entry ?? {}) as Record<string, unknown>;
    const raw = stringList(record.prerequisites);
    nodes[target].prerequisites = raw
      .map((ref) => (ids.has(ref) ? ref : (names.get(ref) ?? null)))
      .filter((ref): ref is string => ref !== null && ref !== nodes[target].id);
  });

  const objectiveList = Array.isArray(input.courseObjectives) ? input.courseObjectives : [];
  const objectives: SeriesCourseObjective[] = [];
  objectiveList.forEach((entry, index) => {
    const record = (entry ?? {}) as Record<string, unknown>;
    const title = textOrNull(record.title);
    if (!title) {
      dropped.push(`第 ${index + 1} 条课程目标没有标题`);
      return;
    }
    // 模型写 `nodeNames`，库与编辑器写 `nodeIds`；两种都认，名字在下面按节点名解析。
    const nodeRefs = [...stringList(record.nodeIds), ...stringList(record.nodeNames)];
    const nodeIds = nodeRefs
      .map((ref) => (ids.has(ref) ? ref : (names.get(ref) ?? null)))
      .filter((ref): ref is string => ref !== null);
    objectives.push({
      id: seriesObjectiveId(objectives.length),
      type: objectiveTypeValue(record.type),
      title,
      expectedBehavior: textOrEmpty(record.expectedBehavior),
      minCriteria: stringList(record.minCriteria),
      evidence: textOrEmpty(record.evidence),
      nodeIds: Array.from(new Set(nodeIds)),
    });
  });

  return { design: { direction, objectives, nodes }, dropped };
}

/**
 * 校验一次写入。`strict` 用于「模型草稿落库」与「界面保存」两条路径：
 * 前者允许模型漏字段（由用户补），后者要求每一条都完整，因为用户点的是保存。
 */
export function validateSeriesDesignPatch(
  body: unknown,
  current: SeriesDesignDoc,
): {
  direction?: Partial<SeriesDesignDirection>;
  objectives?: SeriesCourseObjective[];
  nodes?: SeriesKnowledgeNode[];
} {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new SeriesDesignInvalidError('请求体必须是一个 JSON 对象');
  }
  const record = body as Record<string, unknown>;
  const patch: {
    direction?: Partial<SeriesDesignDirection>;
    objectives?: SeriesCourseObjective[];
    nodes?: SeriesKnowledgeNode[];
  } = {};

  if ('direction' in record) {
    const raw = record.direction;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new SeriesDesignInvalidError('direction 必须是对象');
    }
    const input = raw as Record<string, unknown>;
    const direction: Partial<SeriesDesignDirection> = {};
    const keys: (keyof SeriesDesignDirection)[] = [
      'audience',
      'learnerLevel',
      'trainingScenario',
      'applicationScene',
      'problemStatement',
      'durationHours',
    ];
    for (const key of keys) {
      if (!(key in input)) continue;
      if (key === 'durationHours') {
        const value = input[key];
        if (value === null) direction.durationHours = null;
        else if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
          direction.durationHours = value;
        } else throw new SeriesDesignInvalidError('durationHours 必须是非负数或 null');
        continue;
      }
      const value = input[key];
      if (value === null) {
        direction[key] = null;
      } else if (typeof value === 'string') {
        direction[key] = value.trim() === '' ? null : value.trim();
      } else {
        throw new SeriesDesignInvalidError(`${key} 必须是字符串或 null`);
      }
    }
    patch.direction = direction;
  }

  if ('nodes' in record) {
    patch.nodes = parseNodes(record.nodes);
  }
  if ('objectives' in record) {
    patch.objectives = parseObjectives(record.objectives, patch.nodes ?? current.nodes);
  }
  return patch;
}

function parseNodes(raw: unknown): SeriesKnowledgeNode[] {
  if (!Array.isArray(raw)) throw new SeriesDesignInvalidError('nodes 必须是数组');
  if (raw.length > SERIES_DESIGN_LIMITS.nodes) {
    throw new SeriesDesignInvalidError(`知识点最多 ${SERIES_DESIGN_LIMITS.nodes} 个`);
  }
  const nodes: SeriesKnowledgeNode[] = [];
  for (const [index, entry] of raw.entries()) {
    if (typeof entry !== 'object' || entry === null) {
      throw new SeriesDesignInvalidError(`第 ${index + 1} 个知识点必须是对象`);
    }
    const record = entry as Record<string, unknown>;
    const name = limitedText(
      record.name,
      `第 ${index + 1} 个知识点的名字`,
      SERIES_DESIGN_LIMITS.nodeNameChars,
      true,
    );
    const type = record.type;
    if (type !== 'knowledge' && type !== 'skill') {
      throw new SeriesDesignInvalidError(`知识点「${name}」的 type 只能是 knowledge 或 skill`);
    }
    const difficulty = record.difficulty ?? 'basic';
    if (!SERIES_NODE_DIFFICULTIES.includes(difficulty as SeriesNodeDifficulty)) {
      throw new SeriesDesignInvalidError(
        `知识点「${name}」的难度只能是 intro / basic / intermediate / advanced`,
      );
    }
    nodes.push({
      id: `sn_${nodes.length + 1}`,
      name,
      type,
      summary: limitedText(
        record.summary,
        `知识点「${name}」的摘要`,
        SERIES_DESIGN_LIMITS.summaryChars,
      ),
      difficulty: difficulty as SeriesNodeDifficulty,
      prerequisites: [],
    });
  }
  // 先修用名字或序号引用都行：界面按名字编辑，旧数据按 id 存。
  const byName = new Map(nodes.map((node) => [node.name, node.id]));
  const byId = new Set(nodes.map((node) => node.id));
  for (const [index, entry] of raw.entries()) {
    const record = entry as Record<string, unknown>;
    const refs = stringList(record.prerequisites);
    if (refs.length > SERIES_DESIGN_LIMITS.prerequisitesPerNode) {
      throw new SeriesDesignInvalidError(
        `知识点「${nodes[index].name}」的先修最多 ${SERIES_DESIGN_LIMITS.prerequisitesPerNode} 个`,
      );
    }
    const resolved: string[] = [];
    for (const ref of refs) {
      const id = byId.has(ref) ? ref : (byName.get(ref) ?? null);
      if (!id) {
        throw new SeriesDesignInvalidError(
          `知识点「${nodes[index].name}」的先修「${ref}」不在知识体系里`,
        );
      }
      if (id === nodes[index].id) {
        throw new SeriesDesignInvalidError(`知识点「${nodes[index].name}」不能把自己列为先修`);
      }
      if (!resolved.includes(id)) resolved.push(id);
    }
    nodes[index].prerequisites = resolved;
  }
  assertNoPrerequisiteCycle(nodes);
  return nodes;
}

function assertNoPrerequisiteCycle(nodes: readonly SeriesKnowledgeNode[]): void {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string): void => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      throw new SeriesDesignInvalidError(`先修关系成环：${byId.get(id)?.name ?? id} 绕回了自己`);
    }
    state.set(id, 'visiting');
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) visit(prerequisite);
    state.set(id, 'done');
  };
  for (const node of nodes) visit(node.id);
}

function parseObjectives(
  raw: unknown,
  nodes: readonly SeriesKnowledgeNode[],
): SeriesCourseObjective[] {
  if (!Array.isArray(raw)) throw new SeriesDesignInvalidError('objectives 必须是数组');
  if (raw.length > SERIES_DESIGN_LIMITS.objectives) {
    throw new SeriesDesignInvalidError(`课程目标最多 ${SERIES_DESIGN_LIMITS.objectives} 条`);
  }
  const nodeByName = new Map(nodes.map((node) => [node.name, node.id]));
  const nodeIds = new Set(nodes.map((node) => node.id));
  return raw.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new SeriesDesignInvalidError(`第 ${index + 1} 条课程目标必须是对象`);
    }
    const record = entry as Record<string, unknown>;
    const title = limitedText(
      record.title,
      `第 ${index + 1} 条课程目标的标题`,
      SERIES_DESIGN_LIMITS.titleChars,
      true,
    );
    // 类型是可选标注：旧客户端与文本编辑不写它，不能因此拒收整条目标。但写了
    // 一个读不懂的类型就要报错——静默存成 null 会让用户以为选上了，实际没存。
    const rawType = record.type;
    const type = rawType === null || rawType === undefined ? null : objectiveTypeValue(rawType);
    if (rawType !== null && rawType !== undefined && type === null) {
      throw new SeriesDesignInvalidError(
        `课程目标「${title}」的类型只能是 knowledge / skill / competency / task（或知识 / 技能 / 能力 / 任务）`,
      );
    }
    const minCriteria = stringList(record.minCriteria);
    if (minCriteria.length === 0) {
      throw new SeriesDesignInvalidError(`课程目标「${title}」至少要有一条最低达标标准`);
    }
    if (minCriteria.length > SERIES_DESIGN_LIMITS.minCriteriaPerObjective) {
      throw new SeriesDesignInvalidError(
        `课程目标「${title}」的最低达标标准最多 ${SERIES_DESIGN_LIMITS.minCriteriaPerObjective} 条`,
      );
    }
    for (const criterion of minCriteria) {
      if (criterion.length > SERIES_DESIGN_LIMITS.criteriaChars) {
        throw new SeriesDesignInvalidError(
          `课程目标「${title}」的达标标准超过 ${SERIES_DESIGN_LIMITS.criteriaChars} 字`,
        );
      }
    }
    const refs = stringList(record.nodeIds);
    const resolvedNodes: string[] = [];
    for (const ref of refs) {
      const id = nodeIds.has(ref) ? ref : (nodeByName.get(ref) ?? null);
      if (!id) {
        throw new SeriesDesignInvalidError(`课程目标「${title}」引用的知识点「${ref}」不存在`);
      }
      if (!resolvedNodes.includes(id)) resolvedNodes.push(id);
    }
    return {
      id: seriesObjectiveId(index),
      type,
      title,
      expectedBehavior: limitedText(
        record.expectedBehavior,
        `课程目标「${title}」的可观察行为`,
        SERIES_DESIGN_LIMITS.behaviorChars,
        true,
      ),
      minCriteria,
      evidence: limitedText(
        record.evidence,
        `课程目标「${title}」的证明方式`,
        SERIES_DESIGN_LIMITS.behaviorChars,
        true,
      ),
      nodeIds: resolvedNodes,
    };
  });
}

/**
 * 合并一次 patch。先节点后目标：目标引用的是这一轮之后的节点集合，而不是上一轮
 * 的——否则「同时改节点和目标」永远是错的。
 */
export function mergeSeriesDesign(
  current: SeriesDesignDoc,
  patch: {
    direction?: Partial<SeriesDesignDirection>;
    objectives?: SeriesCourseObjective[];
    nodes?: SeriesKnowledgeNode[];
  },
): SeriesDesignDoc {
  const nodes = patch.nodes ?? current.nodes;
  const objectives =
    patch.objectives ??
    // 节点被整体替换时，旧目标的 nodeIds 可能指向已不存在的节点；能按名字留住的
    // 留在 `normalize` 里，这里只做「丢掉悬空引用」，不静默改目标本身。
    current.objectives.map((objective) => ({
      ...objective,
      nodeIds: objective.nodeIds.filter((id) => nodes.some((node) => node.id === id)),
    }));
  return {
    direction: { ...current.direction, ...patch.direction },
    objectives,
    nodes,
  };
}

/** 方向是否可以继承到目。 `null` 字段表示系列没写，目可以自己填。 */
export function inheritableDirection(
  direction: SeriesDesignDirection,
): Partial<SeriesDesignDirection> {
  const output: Partial<SeriesDesignDirection> = {};
  if (direction.audience) output.audience = direction.audience;
  if (direction.learnerLevel) output.learnerLevel = direction.learnerLevel;
  if (direction.trainingScenario) output.trainingScenario = direction.trainingScenario;
  if (direction.applicationScene) output.applicationScene = direction.applicationScene;
  if (direction.durationHours !== null) output.durationHours = direction.durationHours;
  return output;
}

/**
 * 解析模型的回答。模型给的是名字引用（`nodeNames` / `prerequisites` 用名字），
 * 这里统一交给归一化函数：它按名字发 id、丢掉读不懂的条目。一个可用的回答必须
 * 同时有目标和节点——只有目标没有节点的回答不能落库，否则会在目层变成悬空引用。
 */
export function parseSeriesDesignAnswer(text: string): SeriesDesignDoc {
  const json = extractJsonObject(text);
  const rawObjectives = Array.isArray(json.objectives) ? json.objectives : [];
  const rawNodes = Array.isArray(json.nodes) ? json.nodes : [];
  if (rawObjectives.length === 0 || rawNodes.length === 0) {
    throw new SeriesDesignInvalidError('模型没有同时给出课程目标与知识体系');
  }
  const { design } = normalizeSeriesDesignDoc({
    audience: null,
    defaultHours: null,
    learnerLevel: null,
    trainingScenario: null,
    applicationScene: null,
    problemStatement: null,
    courseObjectives: rawObjectives,
    knowledgeSystem: { nodes: rawNodes },
  });
  if (design.objectives.length === 0 || design.nodes.length === 0) {
    throw new SeriesDesignInvalidError('模型的目标或知识点全部无法解析（标题/名字为空）');
  }
  return design;
}

function extractJsonObject(text: string): Record<string, unknown> {
  const fenced = text.replace(/```(?:json)?/gi, '');
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new SeriesDesignInvalidError('模型的回答里没有 JSON 对象');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced.slice(start, end + 1));
  } catch (error) {
    throw new SeriesDesignInvalidError(
      `模型回答不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SeriesDesignInvalidError('模型回答不是一个 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

// ── 给提示词用的文本 ────────────────────────────────────────────────────────

export function formatSeriesDirection(direction: SeriesDesignDirection): string {
  const lines = [
    direction.audience ? `授课对象：${direction.audience}` : '授课对象：（未填写）',
    direction.learnerLevel ? `学员基础：${direction.learnerLevel}` : '学员基础：（未填写）',
    direction.trainingScenario ? `训练场景：${direction.trainingScenario}` : '训练场景：（未填写）',
    direction.applicationScene ? `应用场景：${direction.applicationScene}` : '应用场景：（未填写）',
    direction.durationHours !== null
      ? `系列总学时：${direction.durationHours}`
      : '系列总学时：（未填写）',
    direction.problemStatement ? `课程范围：${direction.problemStatement}` : '课程范围：（未填写）',
  ];
  return lines.join('\n');
}

export function formatSeriesDesignForPrompt(doc: SeriesDesignDoc): string {
  const objectiveBlocks =
    doc.objectives.length === 0
      ? '（还没有课程目标）'
      : doc.objectives
          .map((objective) => {
            const nodes = objective.nodeIds
              .map((id) => doc.nodes.find((node) => node.id === id)?.name)
              .filter((name): name is string => Boolean(name));
            return [
              `- ${objective.title}`,
              ...(objective.type === null
                ? []
                : [`  类型：${OUTCOME_TYPE_LABELS[objective.type]}`]),
              `  能做什么：${objective.expectedBehavior || '（未写）'}`,
              `  最低达标：${objective.minCriteria.join('；') || '（未写）'}`,
              `  怎么证明：${objective.evidence || '（未写）'}`,
              `  支撑知识点：${nodes.join('、') || '（未写）'}`,
            ].join('\n');
          })
          .join('\n');
  const nodeBlocks =
    doc.nodes.length === 0
      ? '（还没有知识点）'
      : doc.nodes
          .map((node) => {
            const prerequisites = node.prerequisites
              .map((id) => doc.nodes.find((entry) => entry.id === id)?.name)
              .filter((name): name is string => Boolean(name));
            return `- ${node.name}（${node.type === 'skill' ? '技能' : '知识'}，${node.difficulty}）：${
              node.summary || '（无摘要）'
            }${prerequisites.length > 0 ? `；先修：${prerequisites.join('、')}` : ''}`;
          })
          .join('\n');
  return `## 系列方向\n${formatSeriesDirection(doc.direction)}\n\n## 课程目标\n${objectiveBlocks}\n\n## 知识体系\n${nodeBlocks}`;
}

// ── 可编辑文本格式 ──────────────────────────────────────────────────────────
//
// 界面允许用户直接改这两份文档。用结构化表单做 40 条目标 × 400 个节点，输入
// 效率不如文本；用 JSON 则要求用户懂 JSON。所以用一个朴素的块格式，读得懂、
// 写得快，解析失败时能指到第几块。

export interface SeriesDesignTextParse<T> {
  value: T;
  errors: string[];
}

/** `## 标题` + 四行 `键：值`。 */
export function formatObjectivesText(
  objectives: readonly SeriesCourseObjective[],
  doc: SeriesDesignDoc,
): string {
  return objectives
    .map((objective) => {
      const nodes = objective.nodeIds
        .map((id) => doc.nodes.find((node) => node.id === id)?.name)
        .filter((name): name is string => Boolean(name))
        .join('、');
      return [
        `## ${objective.title}`,
        ...(objective.type === null ? [] : [`类型：${OUTCOME_TYPE_LABELS[objective.type]}`]),
        `能做什么：${objective.expectedBehavior}`,
        `最低达标：${objective.minCriteria.join('；')}`,
        `怎么证明：${objective.evidence}`,
        `支撑知识点：${nodes}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function parseObjectivesText(
  text: string,
  nodes: readonly SeriesKnowledgeNode[],
): SeriesDesignTextParse<SeriesCourseObjective[]> {
  const errors: string[] = [];
  const blocks = splitTextBlocks(text);
  const nodeByName = new Map(nodes.map((node) => [node.name, node.id]));
  const objectives: SeriesCourseObjective[] = [];
  blocks.forEach((block, index) => {
    if (!block.heading) {
      errors.push(`第 ${index + 1} 块没有「## 标题」`);
      return;
    }
    const fields = block.fields;
    // 类型行可选：旧的文本没有它，解析成未分类；写了读不懂的值就报错，不静默吞掉。
    const rawType = (fields.get('类型') ?? '').trim();
    const type = rawType === '' ? null : objectiveTypeValue(rawType);
    if (rawType !== '' && type === null) {
      errors.push(`「${block.heading}」的类型「${rawType}」不在 知识 / 技能 / 能力 / 任务 里`);
    }
    const nodeNames = (fields.get('支撑知识点') ?? '')
      .split(/[、,，]/)
      .map((name) => name.trim())
      .filter((name) => name !== '');
    const nodeIds: string[] = [];
    for (const name of nodeNames) {
      const id = nodeByName.get(name);
      if (!id) {
        errors.push(`「${block.heading}」引用的知识点「${name}」不在知识体系里`);
        continue;
      }
      nodeIds.push(id);
    }
    objectives.push({
      id: seriesObjectiveId(index),
      type,
      title: block.heading,
      expectedBehavior: (fields.get('能做什么') ?? '').trim(),
      minCriteria: (fields.get('最低达标') ?? '')
        .split(/[；;]/)
        .map((line) => line.trim())
        .filter((line) => line !== ''),
      evidence: (fields.get('怎么证明') ?? '').trim(),
      nodeIds,
    });
  });
  return { value: objectives, errors };
}

export function formatNodesText(nodes: readonly SeriesKnowledgeNode[]): string {
  return nodes
    .map((node) => {
      const prerequisites = node.prerequisites
        .map((id) => nodes.find((entry) => entry.id === id)?.name)
        .filter((name): name is string => Boolean(name))
        .join('、');
      return [
        `## ${node.name} | ${node.type} | ${node.difficulty}`,
        `摘要：${node.summary}`,
        `先修：${prerequisites}`,
      ].join('\n');
    })
    .join('\n\n');
}

export function parseNodesText(text: string): SeriesDesignTextParse<SeriesKnowledgeNode[]> {
  const errors: string[] = [];
  const nodes: SeriesKnowledgeNode[] = [];
  const pendingPrerequisites: { index: number; names: string[] }[] = [];
  for (const [index, block] of splitTextBlocks(text).entries()) {
    if (!block.heading) {
      errors.push(`第 ${index + 1} 块没有「## 名字 | 类型 | 难度」`);
      continue;
    }
    const [name, type, difficulty] = block.heading.split('|').map((part) => part.trim());
    if (!name) {
      errors.push(`第 ${index + 1} 块没有节点名`);
      continue;
    }
    const nodeType = type === 'skill' ? 'skill' : 'knowledge';
    const nodeDifficulty = SERIES_NODE_DIFFICULTIES.includes(difficulty as SeriesNodeDifficulty)
      ? (difficulty as SeriesNodeDifficulty)
      : 'basic';
    nodes.push({
      id: seriesNodeId(nodes.length),
      name,
      type: nodeType,
      difficulty: nodeDifficulty,
      summary: (block.fields.get('摘要') ?? '').trim(),
      prerequisites: [],
    });
    pendingPrerequisites.push({
      index: nodes.length - 1,
      names: (block.fields.get('先修') ?? '')
        .split(/[、,，]/)
        .map((entry) => entry.trim())
        .filter((entry) => entry !== ''),
    });
  }
  const byName = new Map(nodes.map((node) => [node.name, node.id]));
  for (const pending of pendingPrerequisites) {
    for (const prerequisite of pending.names) {
      const id = byName.get(prerequisite);
      if (!id) {
        errors.push(`「${nodes[pending.index].name}」的先修「${prerequisite}」不在列表里`);
        continue;
      }
      if (id !== nodes[pending.index].id && !nodes[pending.index].prerequisites.includes(id)) {
        nodes[pending.index].prerequisites.push(id);
      }
    }
  }
  return { value: nodes, errors };
}

function splitTextBlocks(text: string): { heading: string; fields: Map<string, string> }[] {
  const blocks: { heading: string; fields: Map<string, string> }[] = [];
  let current: { heading: string; fields: Map<string, string> } | null = null;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('## ')) {
      if (current) blocks.push(current);
      current = { heading: line.slice(3).trim(), fields: new Map() };
      continue;
    }
    if (!current || line === '') continue;
    const separator = line.indexOf('：') >= 0 ? line.indexOf('：') : line.indexOf(':');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key) current.fields.set(key, value);
  }
  if (current) blocks.push(current);
  return blocks;
}
