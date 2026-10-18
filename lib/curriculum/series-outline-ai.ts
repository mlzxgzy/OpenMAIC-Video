/**
 * 系列大纲的 AI 生成：**一级一次**，写库前的全部判定都在这个纯函数模块里。
 *
 * 为什么标题强调"一级一次"：章、节、目是三种不同的决定。一次让模型把三层都
 * 吐出来，模型会为了凑满三层而编造结构（"每章固定三节、每节固定三目"），而
 * 用户没法只否掉其中一层。拆成三次以后，每一步的输入是**已经存在的那一层**，
 * 用户可以先看章、再生成节、最后生成目，任何一步不满意都只重来那一步。
 *
 * 三条规则决定了"点了 AI 之后已有的内容怎么办"：
 *
 * 1. **默认只补空位（fill）。** 章：追加新章，不重名；节：只给还没有节的章生成；
 *    目：只给还没有目的节生成。AI 不是一个会顺手改掉你手写内容的按钮。
 * 2. **覆盖（replace）只在代价说得清时允许。** 章/节重建会让目失去归属，所以
 *    系列里一旦有目，章/节就不能重建；目这一层只重建**还没开始设计**的目——
 *    `design_phase = 'task'` 且没有任何下游数据，重建它们不会丢掉人的工作。
 * 3. **模型用编号引用已有结构**（章 `2`、节 `2-1`），不用 id：编号是用户在大纲
 *    里核对的同一串字符，id 是写进 prompt 也读不懂的东西。编号找不到、或者目标
 *    已不在生成范围（预览之后有人动过大纲）时，提交阶段直接拒绝，绝不部分落库。
 *
 * 4. **备注是层级之间唯一的上下文通道。** 章备注写"这一章覆盖什么、边界在哪、
 *    建议拆几节"，它原样进入生成节的提示词；节备注写"这一节怎么拆目"，原样进入
 *    生成目的提示词（见 `handoffLine`）。备注只生成不传递时，下一层只能看标题猜，
 *    三层各自通顺、合起来却对不上——这是"生成节脱节、生成目完全脱节"的根因。
 *
 * 本模块不读库、不调模型、不看 owner：路由把读到的状态传进来，这里回答"写什么、
 * 删什么、跳过什么"，因此每一条规则都能在没有数据库和模型的测试里钉住。
 */
import type { CurriculumTaskKind } from './design-types';
import { parseOutlineKind } from './outline-kind';

export const SERIES_OUTLINE_AI_LEVELS = ['chapter', 'section', 'item'] as const;
export type SeriesOutlineAiLevel = (typeof SERIES_OUTLINE_AI_LEVELS)[number];

export const SERIES_OUTLINE_AI_MODES = ['fill', 'replace'] as const;
export type SeriesOutlineAiMode = (typeof SERIES_OUTLINE_AI_MODES)[number];

/** 生成一层时用的中文名，界面与提示词共用，免得两处说法不一致。 */
export const SERIES_OUTLINE_AI_LEVEL_NOUN: Record<SeriesOutlineAiLevel, string> = {
  chapter: '章',
  section: '节',
  item: '目',
};

/**
 * 一次回答的上限。它们不是"建议"，是拒绝线：超了说明模型没有按提示词的数量
 * 约束作答，继续截断会让用户以为生成的比实际多。
 */
export const SERIES_OUTLINE_AI_LIMITS = {
  chapters: 24,
  sectionsPerChapter: 12,
  sections: 120,
  itemsPerSection: 8,
  items: 360,
  titleChars: 120,
  noteChars: 600,
  hoursMax: 40,
} as const;

/** 落库之后回给界面的数字；与 `summary.writes/removes` 应当逐项相等。 */
export interface SeriesOutlineAiAppliedSummary {
  created: { chapters: number; sections: number; items: number };
  removed: { chapters: number; sections: number; items: number };
}

/** 模型回答不是可用的计划：调用方映射成 502，一行都不写。 */
export class SeriesOutlineAiAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesOutlineAiAnswerError';
  }
}

/**
 * 预览之后大纲变了、或者这次提交本身就是不允许的覆盖：调用方映射成 409。
 *
 * 与 `blockedReason` 的区别在于这是**提交阶段**的拒绝：预览阶段所有"不能做"
 * 都放在返回值里给用户看，提交阶段再撞上就是大纲在两次请求之间被改过。
 */
export class SeriesOutlineAiConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesOutlineAiConflictError';
  }
}

// ── 读到的现状 ──────────────────────────────────────────────────────────────

export interface SeriesOutlineAiSeries {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  defaultHours: number | null;
}

export interface SeriesOutlineAiChapter {
  id: string;
  code: string;
  title: string;
  note: string | null;
  sectionCount: number;
}

export interface SeriesOutlineAiSection {
  id: string;
  code: string;
  title: string;
  chapterId: string;
  /** 节的「交底」：生成目时原样进入提示词。没有备注时生成目只能看标题。 */
  note: string | null;
  itemCount: number;
  /** 其中"还没开始设计"的目数；等于 itemCount 时整节都可以被覆盖。 */
  untouchedItemCount: number;
}

export interface SeriesOutlineAiItem {
  id: string;
  code: string | null;
  title: string;
  sectionId: string | null;
  kind: CurriculumTaskKind | null;
  /** `design_phase === 'task'` 且没有任何下游数据。 */
  untouched: boolean;
}

/**
 * 系列级设计（前三步：方向 / 课程目标 / 知识体系）里必须进入大纲提示词的部分。
 *
 * 大纲是系列设计的**推导结果**：章是课程目标与知识体系的组织方式，节和目是它
 * 的落地。这一层长期没进过提示词，模型只能按系列名称猜——"生成节脱节、生成目
 * 完全脱节"的根因之一就在这里。
 *
 * 只带模型读得懂的字段：不带 id、不带 `nodeIds` 这类内部引用，先修用名字写。
 */
export interface SeriesOutlineAiDesign {
  /** 前三步是否已定下来。未定完时提示词必须明说"只能按名称与说明生成"。 */
  complete: boolean;
  /** 还缺什么（中文句子，直接进提示词与界面）。 */
  gaps: string[];
  direction: {
    learnerLevel: string | null;
    trainingScenario: string | null;
    applicationScene: string | null;
    problemStatement: string | null;
  };
  objectives: {
    title: string;
    expectedBehavior: string;
    minCriteria: string[];
    evidence: string;
  }[];
  nodes: {
    name: string;
    summary: string;
    difficulty: string;
    /** 先修节点的**名字**；id 写进提示词读不懂。 */
    prerequisites: string[];
  }[];
}

export interface SeriesOutlineAiContext {
  series: SeriesOutlineAiSeries;
  /** 系列设计；null 表示读不到（读接口异常）。系列存在时它一定有值，可能为空文档。 */
  design: SeriesOutlineAiDesign | null;
  /**
   * 生成这一层时系列设计的内容指纹。写完的章 / 节 / 目把它带在身上，
   * 之后设计再改，界面就能指出"哪些还是旧版设计的产物"。
   */
  designFingerprint: string | null;
  chapters: SeriesOutlineAiChapter[];
  sections: SeriesOutlineAiSection[];
  items: SeriesOutlineAiItem[];
}

// ── 生成依据 ────────────────────────────────────────────────────────────────

/**
 * 预览响应里回给界面的「这次依据什么生成」。
 *
 * 界面不自己算："系列设计算不算定完"由服务端同一份缺口规则回答，两边各算一份
 * 迟早会出现"卡片说缺 2 项、生成结果却按已定稿写"。
 */
export interface SeriesOutlineAiDesignSummary {
  complete: boolean;
  gaps: string[];
  objectiveCount: number;
  nodeCount: number;
}

export function seriesOutlineAiDesignSummary(
  design: SeriesOutlineAiDesign | null,
): SeriesOutlineAiDesignSummary {
  return {
    complete: design?.complete ?? false,
    gaps: design?.gaps ?? ['还没有系列设计（方向 / 课程目标 / 知识体系）'],
    objectiveCount: design?.objectives.length ?? 0,
    nodeCount: design?.nodes.length ?? 0,
  };
}

// ── 模型给出的计划 ──────────────────────────────────────────────────────────

export interface SeriesOutlineAiChapterDraft {
  title: string;
  note: string | null;
}

export interface SeriesOutlineAiSectionDraft {
  title: string;
  note: string | null;
}

export interface SeriesOutlineAiItemDraft {
  title: string;
  kind: CurriculumTaskKind | null;
  hours: number | null;
  note: string | null;
}

export type SeriesOutlineAiPlan =
  | { level: 'chapter'; chapters: SeriesOutlineAiChapterDraft[] }
  | {
      level: 'section';
      chapters: { chapterCode: string; sections: SeriesOutlineAiSectionDraft[] }[];
    }
  | {
      level: 'item';
      sections: { sectionCode: string; items: SeriesOutlineAiItemDraft[] }[];
    };

// ── 解析模型回答 ────────────────────────────────────────────────────────────

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function jsonObject(raw: string | unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== 'string') {
    throw new SeriesOutlineAiAnswerError('模型返回的不是一个 JSON 对象');
  }
  const body = (JSON_FENCE.exec(raw)?.[1] ?? raw).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new SeriesOutlineAiAnswerError('模型没有返回 JSON 对象');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new SeriesOutlineAiAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) throw new SeriesOutlineAiAnswerError('模型返回的不是一个 JSON 对象');
  return parsed;
}

function arrayOf(source: Record<string, unknown>, key: string): unknown[] {
  const value = source[key];
  if (!Array.isArray(value)) {
    throw new SeriesOutlineAiAnswerError(`模型没有返回 ${key} 数组`);
  }
  return value;
}

function draftTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SeriesOutlineAiAnswerError('模型返回的标题不是字符串');
  }
  const title = value.trim().replace(/\s+/g, ' ');
  if (title === '') throw new SeriesOutlineAiAnswerError('模型返回了空标题');
  return title.slice(0, SERIES_OUTLINE_AI_LIMITS.titleChars);
}

function draftNote(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const note = value.trim().replace(/\s+/g, ' ');
  return note === '' ? null : note.slice(0, SERIES_OUTLINE_AI_LIMITS.noteChars);
}

/** `2` / `"2"` / `"第 2 章"` 都认成 `2`；编号是模型与系统之间唯一稳定的引用。 */
function draftRef(value: unknown): string {
  if (typeof value === 'number' && Number.isInteger(value)) return String(value);
  if (typeof value !== 'string') {
    throw new SeriesOutlineAiAnswerError('模型返回的层级引用不是字符串');
  }
  const ref = value.trim();
  if (ref === '') throw new SeriesOutlineAiAnswerError('模型返回了空的层级引用');
  return ref;
}

function draftHours(value: unknown): number | null {
  const parsed =
    typeof value === 'number'
      ? value
      : typeof value === 'string'
        ? Number.parseFloat(/-?\d+(?:\.\d+)?/.exec(value)?.[0] ?? '')
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.min(parsed, SERIES_OUTLINE_AI_LIMITS.hoursMax);
}

/** 同一个标题（忽略空白与大小写）在同一个父级下只留一次。 */
function titleKey(title: string): string {
  return title.replace(/\s+/g, '').toLocaleLowerCase('zh-CN');
}

function parseChapters(source: Record<string, unknown>): SeriesOutlineAiChapterDraft[] {
  const chapters: SeriesOutlineAiChapterDraft[] = [];
  const seen = new Set<string>();
  for (const entry of arrayOf(source, 'chapters')) {
    const title = draftTitle(isRecord(entry) ? entry.title : entry);
    const note = isRecord(entry) ? draftNote(entry.note) : null;
    const key = titleKey(title);
    if (seen.has(key)) continue;
    seen.add(key);
    chapters.push({ title, note });
  }
  if (chapters.length === 0) {
    throw new SeriesOutlineAiAnswerError('模型没有给出任何章');
  }
  if (chapters.length > SERIES_OUTLINE_AI_LIMITS.chapters) {
    throw new SeriesOutlineAiAnswerError(
      `模型给了 ${chapters.length} 章，超过上限 ${SERIES_OUTLINE_AI_LIMITS.chapters}`,
    );
  }
  return chapters;
}

function parseSections(
  source: Record<string, unknown>,
): Extract<SeriesOutlineAiPlan, { level: 'section' }>['chapters'] {
  const groups: Extract<SeriesOutlineAiPlan, { level: 'section' }>['chapters'] = [];
  let total = 0;
  for (const entry of arrayOf(source, 'chapters')) {
    if (!isRecord(entry)) throw new SeriesOutlineAiAnswerError('模型返回的章条目不是对象');
    const chapterCode = draftRef(entry.chapter ?? entry.chapterCode);
    const sections: SeriesOutlineAiSectionDraft[] = [];
    const seen = new Set<string>();
    for (const sectionEntry of arrayOf(entry, 'sections')) {
      const title = draftTitle(isRecord(sectionEntry) ? sectionEntry.title : sectionEntry);
      const key = titleKey(title);
      if (seen.has(key)) continue;
      seen.add(key);
      sections.push({ title, note: isRecord(sectionEntry) ? draftNote(sectionEntry.note) : null });
    }
    if (sections.length > SERIES_OUTLINE_AI_LIMITS.sectionsPerChapter) {
      throw new SeriesOutlineAiAnswerError(
        `第 ${chapterCode} 章给了 ${sections.length} 节，超过每章上限 ${SERIES_OUTLINE_AI_LIMITS.sectionsPerChapter}`,
      );
    }
    total += sections.length;
    if (sections.length > 0) groups.push({ chapterCode, sections });
  }
  if (groups.length === 0) {
    throw new SeriesOutlineAiAnswerError('模型没有给出任何节');
  }
  if (total > SERIES_OUTLINE_AI_LIMITS.sections) {
    throw new SeriesOutlineAiAnswerError(
      `模型给了 ${total} 节，超过上限 ${SERIES_OUTLINE_AI_LIMITS.sections}`,
    );
  }
  return groups;
}

function parseItems(
  source: Record<string, unknown>,
): Extract<SeriesOutlineAiPlan, { level: 'item' }>['sections'] {
  const groups: Extract<SeriesOutlineAiPlan, { level: 'item' }>['sections'] = [];
  let total = 0;
  for (const entry of arrayOf(source, 'sections')) {
    if (!isRecord(entry)) throw new SeriesOutlineAiAnswerError('模型返回的节条目不是对象');
    const sectionCode = draftRef(entry.section ?? entry.sectionCode);
    const items: SeriesOutlineAiItemDraft[] = [];
    const seen = new Set<string>();
    for (const itemEntry of arrayOf(entry, 'items')) {
      if (!isRecord(itemEntry)) {
        throw new SeriesOutlineAiAnswerError('模型返回的目条目不是对象');
      }
      const title = draftTitle(itemEntry.title);
      const key = titleKey(title);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({
        title,
        kind: parseOutlineKind(itemEntry.kind),
        hours: draftHours(itemEntry.hours),
        note: draftNote(itemEntry.note),
      });
    }
    if (items.length > SERIES_OUTLINE_AI_LIMITS.itemsPerSection) {
      throw new SeriesOutlineAiAnswerError(
        `第 ${sectionCode} 节给了 ${items.length} 目，超过每节上限 ${SERIES_OUTLINE_AI_LIMITS.itemsPerSection}`,
      );
    }
    total += items.length;
    if (items.length > 0) groups.push({ sectionCode, items });
  }
  if (groups.length === 0) {
    throw new SeriesOutlineAiAnswerError('模型没有给出任何目');
  }
  if (total > SERIES_OUTLINE_AI_LIMITS.items) {
    throw new SeriesOutlineAiAnswerError(
      `模型给了 ${total} 目，超过上限 ${SERIES_OUTLINE_AI_LIMITS.items}`,
    );
  }
  return groups;
}

/**
 * 把模型的回答解析成计划。
 *
 * `raw` 既接受文本（带 markdown 围栏、前后废话都容忍），也接受已经解析好的
 * 对象——提交请求里带回来的就是后者，这样预览与提交走**同一个**校验器，
 * 不会出现"预览能过、提交时规则不同"的两套标准。
 */
export function parseSeriesOutlineAiPlan(
  level: SeriesOutlineAiLevel,
  raw: string | unknown,
): SeriesOutlineAiPlan {
  const source = jsonObject(raw);
  if (level === 'chapter') return { level, chapters: parseChapters(source) };
  if (level === 'section') return { level, chapters: parseSections(source) };
  return { level, sections: parseItems(source) };
}

// ── 落库计划 ────────────────────────────────────────────────────────────────

export interface SeriesOutlineAiSkip {
  title: string;
  reason: string;
}

export interface SeriesOutlineAiSummary {
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  /** 按顺序要新建的章。 */
  chapters: SeriesOutlineAiChapterDraft[];
  /** 要新建的节，`chapterCode` 指向已有的章。 */
  sections: { chapterCode: string; title: string; note: string | null }[];
  /** 要新建的目，`sectionCode` 指向已有的节。 */
  items: {
    sectionCode: string;
    title: string;
    kind: CurriculumTaskKind | null;
    hours: number | null;
    note: string | null;
  }[];
  removeChapterIds: string[];
  removeSectionIds: string[];
  removeItemIds: string[];
  /** 已有内容里被保留的部分，界面原样展示，不让人以为被删了。 */
  skipped: SeriesOutlineAiSkip[];
  warnings: string[];
  /** 当前状态下"覆盖重建"是否可选；`replaceBlockedReason` 是禁用的理由。 */
  replaceAllowed: boolean;
  replaceBlockedReason: string | null;
  writes: { chapters: number; sections: number; items: number };
  removes: { chapters: number; sections: number; items: number };
  /** 这次计划能不能落库；不能时 `blockedReason` 是给人看的理由。 */
  canCommit: boolean;
  blockedReason: string | null;
}

/** 落库之后回给界面的数字；与 `summary.writes/removes` 应当逐项相等。 */
export interface SeriesOutlineAiAppliedSummary {
  created: { chapters: number; sections: number; items: number };
  removed: { chapters: number; sections: number; items: number };
}

function baseSummary(
  level: SeriesOutlineAiLevel,
  mode: SeriesOutlineAiMode,
  replaceAllowed: boolean,
  replaceBlockedReason: string | null,
): SeriesOutlineAiSummary {
  return {
    level,
    mode,
    chapters: [],
    sections: [],
    items: [],
    removeChapterIds: [],
    removeSectionIds: [],
    removeItemIds: [],
    skipped: [],
    warnings: [],
    replaceAllowed,
    replaceBlockedReason,
    writes: { chapters: 0, sections: 0, items: 0 },
    removes: { chapters: 0, sections: 0, items: 0 },
    canCommit: false,
    blockedReason: null,
  };
}

function finish(summary: SeriesOutlineAiSummary, blockedReason: string | null) {
  summary.writes = {
    chapters: summary.chapters.length,
    sections: summary.sections.length,
    items: summary.items.length,
  };
  summary.removes = {
    chapters: summary.removeChapterIds.length,
    sections: summary.removeSectionIds.length,
    items: summary.removeItemIds.length,
  };
  summary.blockedReason = blockedReason;
  summary.canCommit =
    blockedReason === null &&
    summary.writes.chapters + summary.writes.sections + summary.writes.items > 0;
  return summary;
}

/**
 * 覆盖这一层要付的代价。
 *
 * 章和节只是分类，但它们被删时下面的目不会跟着删——`section_id` 是
 * `ON DELETE SET NULL`。所以"系列里已经有目"时重建章/节，结果是那些目全部
 * 掉进「未归类」：数据还在，归属没了，而界面上没有批量挂回去的入口。因此
 * 章/节的重建在这种状态下直接不允许。
 *
 * 目这一层相反：只覆盖"还没开始设计"的目（没有任何下游数据），删除它们不会
 * 丢人的工作，所以永远允许；真正会让某一节不被选为目标的是它已经有目在设计中。
 */
function replaceState(
  level: SeriesOutlineAiLevel,
  context: SeriesOutlineAiContext,
): { allowed: boolean; reason: string | null } {
  if (level === 'item') {
    if (context.sections.length === 0) {
      return { allowed: false, reason: '这个系列还没有节。先让 AI 生成节，再生成目。' };
    }
    return { allowed: true, reason: null };
  }
  if (context.items.length > 0) {
    const noun = level === 'chapter' ? '章' : '节';
    return {
      allowed: false,
      reason: `这个系列已经有 ${context.items.length} 个目。重建${noun}会让它们全部掉进「未归类」，所以只能补充新的${noun}。`,
    };
  }
  return { allowed: true, reason: null };
}

export interface SeriesOutlineAiPreflight {
  replace: { allowed: boolean; reason: string | null };
  /** 非空表示这次不用调模型：现状不允许生成。 */
  blockedReason: string | null;
  targetChapterCodes: string[];
  targetSectionCodes: string[];
}

/**
 * 调模型之前的预检：现状是不是根本没得生成。
 *
 * 它先于模型调用，是因为一次生成要花用户的钱与时间；"每一章都已经有节"
 * 这种问题一秒钟就能从现状读出来，不该拿一次模型调用来发现。它也是
 * `plan…Apply` 计算目标的唯一来源——两处各算一遍，迟早一处认为"有空章"、
 * 另一处认为"没有"，而用户会在两次点击之间看到完全不同的结论。
 */
export function seriesOutlineAiPreflight(input: {
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  context: SeriesOutlineAiContext;
}): SeriesOutlineAiPreflight {
  const { level, mode, context } = input;
  const replace = replaceState(level, context);
  const empty: SeriesOutlineAiPreflight = {
    replace,
    blockedReason: null,
    targetChapterCodes: [],
    targetSectionCodes: [],
  };
  if (level === 'chapter') {
    if (mode === 'replace' && !replace.allowed) {
      return { ...empty, blockedReason: replace.reason };
    }
    return empty;
  }

  if (level === 'section') {
    if (context.chapters.length === 0) {
      return { ...empty, blockedReason: '这个系列还没有章。先让 AI 生成章，再生成节。' };
    }
    if (mode === 'replace' && !replace.allowed) {
      return { ...empty, blockedReason: replace.reason };
    }
    const targets =
      mode === 'fill'
        ? context.chapters.filter((chapter) => chapter.sectionCount === 0)
        : context.chapters;
    if (targets.length === 0) {
      return { ...empty, blockedReason: '每一章都已经有节了。要重排节，请选「覆盖重建」。' };
    }
    return { ...empty, targetChapterCodes: targets.map((chapter) => chapter.code) };
  }

  if (context.sections.length === 0) {
    return { ...empty, blockedReason: '这个系列还没有节。先让 AI 生成节，再生成目。' };
  }
  if (mode === 'replace' && !replace.allowed) {
    return { ...empty, blockedReason: replace.reason };
  }
  const targets =
    mode === 'fill'
      ? context.sections.filter((section) => section.itemCount === 0)
      : context.sections.filter((section) => section.untouchedItemCount === section.itemCount);
  if (targets.length === 0) {
    return {
      ...empty,
      blockedReason:
        mode === 'fill'
          ? '每一节都已经有目了。要重排目，请选「覆盖重建」。'
          : '没有可以覆盖的目：已有的目都已经开始设计了。',
    };
  }
  return { ...empty, targetSectionCodes: targets.map((section) => section.code) };
}

/** 预检拒绝时的空计划：界面据此显示原因，且不出现"写入"按钮。 */
export function seriesOutlineAiBlockedSummary(
  level: SeriesOutlineAiLevel,
  mode: SeriesOutlineAiMode,
  preflight: SeriesOutlineAiPreflight,
): SeriesOutlineAiSummary {
  const summary = baseSummary(level, mode, preflight.replace.allowed, preflight.replace.reason);
  return finish(summary, preflight.blockedReason ?? '这次生成没有可写入的内容。');
}

function chapterTitleMap(context: SeriesOutlineAiContext): Map<string, SeriesOutlineAiChapter> {
  return new Map(context.chapters.map((chapter) => [chapter.code, chapter]));
}

function sectionTitleMap(context: SeriesOutlineAiContext): Map<string, SeriesOutlineAiSection> {
  return new Map(context.sections.map((section) => [section.code, section]));
}

function planChapters(input: {
  mode: SeriesOutlineAiMode;
  plan: SeriesOutlineAiPlan;
  context: SeriesOutlineAiContext;
}): SeriesOutlineAiSummary {
  const { mode, plan, context } = input;
  const preflight = seriesOutlineAiPreflight({ level: 'chapter', mode, context });
  const summary = baseSummary('chapter', mode, preflight.replace.allowed, preflight.replace.reason);
  if (plan.level !== 'chapter') throw new SeriesOutlineAiAnswerError('计划与层级不一致');

  const existing = new Map(context.chapters.map((chapter) => [titleKey(chapter.title), chapter]));
  const chapters: SeriesOutlineAiChapterDraft[] = [];
  for (const draft of plan.chapters) {
    if (mode === 'fill') {
      const duplicate = existing.get(titleKey(draft.title));
      if (duplicate) {
        summary.skipped.push({
          title: draft.title,
          reason: `和第 ${duplicate.code} 章重名，保留已有章`,
        });
        continue;
      }
    }
    chapters.push(draft);
  }

  if (mode === 'replace') {
    if (!preflight.replace.allowed) return finish(summary, preflight.replace.reason);
    summary.removeChapterIds = context.chapters.map((chapter) => chapter.id);
  }
  const kept = mode === 'replace' ? 0 : context.chapters.length;
  if (kept + chapters.length > SERIES_OUTLINE_AI_LIMITS.chapters) {
    return finish(
      summary,
      `这个系列会超过 ${SERIES_OUTLINE_AI_LIMITS.chapters} 章，请先删掉一些章，或者减少生成数量。`,
    );
  }
  summary.chapters = chapters;
  if (chapters.length === 0) {
    return finish(summary, '模型给出的章和已有的章全都重名，没有可以新增的章。');
  }
  return finish(summary, null);
}

function planSections(input: {
  mode: SeriesOutlineAiMode;
  plan: SeriesOutlineAiPlan;
  context: SeriesOutlineAiContext;
  strict?: boolean;
}): SeriesOutlineAiSummary {
  const { mode, plan, context, strict = false } = input;
  const preflight = seriesOutlineAiPreflight({ level: 'section', mode, context });
  const summary = baseSummary('section', mode, preflight.replace.allowed, preflight.replace.reason);
  if (plan.level !== 'section') throw new SeriesOutlineAiAnswerError('计划与层级不一致');
  if (preflight.blockedReason) return finish(summary, preflight.blockedReason);

  const byCode = chapterTitleMap(context);
  const targetCodes = new Set(preflight.targetChapterCodes);
  for (const group of plan.chapters) {
    const chapter = byCode.get(group.chapterCode);
    if (!chapter) {
      if (strict) {
        throw new SeriesOutlineAiConflictError(
          `模型提到的第 ${group.chapterCode} 章已经不存在，大纲在你预览之后变过，请重新生成。`,
        );
      }
      summary.warnings.push(`模型提到的第 ${group.chapterCode} 章不存在，已忽略。`);
      continue;
    }
    if (!targetCodes.has(chapter.code)) {
      const reason = mode === 'fill' ? '这一章已经有节' : '这一章不在生成范围';
      if (strict) {
        throw new SeriesOutlineAiConflictError(
          `第 ${chapter.code} 章 ${chapter.title} ${reason}，大纲在你预览之后变过，请重新生成。`,
        );
      }
      summary.skipped.push({ title: `第 ${chapter.code} 章 ${chapter.title}`, reason });
      continue;
    }
    for (const draft of group.sections) {
      summary.sections.push({ chapterCode: chapter.code, ...draft });
    }
  }

  if (mode === 'replace') {
    summary.removeSectionIds = context.sections.map((section) => section.id);
  }
  const keptSections = mode === 'replace' ? 0 : context.sections.length;
  if (keptSections + summary.sections.length > SERIES_OUTLINE_AI_LIMITS.sections) {
    return finish(
      summary,
      `这个系列会超过 ${SERIES_OUTLINE_AI_LIMITS.sections} 节，请先删掉一些节，或者减少生成数量。`,
    );
  }
  if (summary.sections.length === 0) {
    return finish(summary, '模型没有给出可用的节。');
  }
  return finish(summary, null);
}

function planItems(input: {
  mode: SeriesOutlineAiMode;
  plan: SeriesOutlineAiPlan;
  context: SeriesOutlineAiContext;
  strict?: boolean;
}): SeriesOutlineAiSummary {
  const { mode, plan, context, strict = false } = input;
  const preflight = seriesOutlineAiPreflight({ level: 'item', mode, context });
  const summary = baseSummary('item', mode, preflight.replace.allowed, preflight.replace.reason);
  if (plan.level !== 'item') throw new SeriesOutlineAiAnswerError('计划与层级不一致');
  if (preflight.blockedReason) return finish(summary, preflight.blockedReason);

  const byCode = sectionTitleMap(context);
  const targetCodes = new Set(preflight.targetSectionCodes);
  for (const group of plan.sections) {
    const section = byCode.get(group.sectionCode);
    if (!section) {
      if (strict) {
        throw new SeriesOutlineAiConflictError(
          `模型提到的第 ${group.sectionCode} 节已经不存在，大纲在你预览之后变过，请重新生成。`,
        );
      }
      summary.warnings.push(`模型提到的第 ${group.sectionCode} 节不存在，已忽略。`);
      continue;
    }
    if (!targetCodes.has(section.code)) {
      const reason = mode === 'fill' ? '这一节已经有目' : '这一节已经有目开始设计';
      if (strict) {
        throw new SeriesOutlineAiConflictError(
          `第 ${section.code} 节 ${section.title} ${reason}，大纲在你预览之后变过，请重新生成。`,
        );
      }
      summary.skipped.push({ title: `第 ${section.code} 节 ${section.title}`, reason });
      continue;
    }
    for (const draft of group.items) {
      summary.items.push({ sectionCode: section.code, ...draft });
    }
    if (mode === 'replace') {
      summary.removeItemIds.push(
        ...context.items.filter((item) => item.sectionId === section.id).map((item) => item.id),
      );
    }
  }

  if (summary.items.length === 0) {
    return finish(summary, '模型没有给出可用的目。');
  }
  return finish(summary, null);
}

/**
 * 把"当前已有的章节目"和"模型给的计划"合成为一份可执行的写入计划。
 *
 * `strict` 是提交阶段用的：预览之后有人动过大纲（加了节、开始设计某一目），
 * 这里会抛 {@link SeriesOutlineAiConflictError}，而不是悄悄跳过那部分——
 * 悄悄跳过会让用户看到"成功写入 40 目"而实际上只写了 37 目。
 */
export function planSeriesOutlineAiApply(input: {
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  plan: SeriesOutlineAiPlan;
  context: SeriesOutlineAiContext;
  strict?: boolean;
}): SeriesOutlineAiSummary {
  if (input.level === 'chapter') {
    return planChapters({ mode: input.mode, plan: input.plan, context: input.context });
  }
  if (input.level === 'section') {
    return planSections({
      mode: input.mode,
      plan: input.plan,
      context: input.context,
      strict: input.strict,
    });
  }
  return planItems({
    mode: input.mode,
    plan: input.plan,
    context: input.context,
    strict: input.strict,
  });
}

// ── 提示词上下文 ────────────────────────────────────────────────────────────

function seriesInfoText(series: SeriesOutlineAiSeries): string {
  return [
    `系列名称：${series.name}`,
    `系列说明：${series.description?.trim() ? series.description.trim() : '（还没有填写）'}`,
    `培训对象：${series.audience?.trim() || '（还没有填写）'}`,
    `默认学时：${series.defaultHours === null ? '（还没有填写）' : `${series.defaultHours} 学时/目`}`,
  ].join('\n');
}

const DESIGN_DIFFICULTY_LABEL: Record<string, string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
  advanced: '高级',
};

/**
 * 系列设计进提示词的样子：方向、课程目标（可观察行为 / 达标线 / 证明方式）、
 * 知识体系（难度 / 先修）。
 *
 * 未定完时不装作有依据：提示词里先说清"还缺什么、这次只能按名称与说明生成"，
 * 让模型把这一限制写进 note。否则用户会以为章是课程级决定，其实只是标题的
 * 同义改写——这是"三层各自通顺、合起来对不上"的另一种来源。
 */
function seriesDesignText(design: SeriesOutlineAiDesign | null): string {
  if (!design) {
    return [
      '（系列设计没有读到。本次只能依据系列名称与说明生成：章可以按名称猜，但节和目',
      '会与课程目标脱节。若这是正式大纲，应先到「系列设计」定下方向、课程目标与知识体系。）',
    ].join('\n');
  }
  const lines: string[] = [];
  if (!design.complete) {
    const gaps = design.gaps.slice(0, 4).join('；');
    lines.push(
      `⚠ 系列设计还没定完（${gaps || '缺口未列出'}）。本次只能依据系列名称与说明生成；`,
      '请把这一限制写进每一条 note（例如"按系列说明假设为…"），不要让读者以为它是课程级决定。',
    );
  } else {
    lines.push(
      '系列设计已定稿。方向、课程目标、知识体系如下，**它们是这次大纲的依据**；',
      '与「系列说明」冲突时以这里为准，不要引入这里没有承诺的能力或内容面。',
    );
  }

  const direction = design.direction;
  lines.push(
    '',
    '方向：',
    `- 学员基础：${direction.learnerLevel?.trim() || '（未填）'}`,
    `- 授课形式：${direction.trainingScenario?.trim() || '（未填）'}`,
    `- 应用场景：${direction.applicationScene?.trim() || '（未填）'}`,
    `- 课程范围：${direction.problemStatement?.trim() || '（未填）'}`,
  );

  if (design.objectives.length > 0) {
    lines.push('', `课程目标（共 ${design.objectives.length} 条）：`);
    design.objectives.forEach((objective, index) => {
      lines.push(`${index + 1}. ${objective.title}`);
      lines.push(`   - 学完能做到：${objective.expectedBehavior}`);
      lines.push(`   - 最低达标线：${objective.minCriteria.join('；')}`);
      lines.push(`   - 怎么证明：${objective.evidence}`);
    });
  }

  if (design.nodes.length > 0) {
    lines.push('', `知识体系（共 ${design.nodes.length} 个点）：`);
    for (const node of design.nodes) {
      const labels = [DESIGN_DIFFICULTY_LABEL[node.difficulty] ?? node.difficulty];
      if (node.prerequisites.length > 0) {
        labels.push(`先修：${node.prerequisites.join('、')}`);
      }
      const summary = node.summary.trim() === '' ? '' : `—— ${node.summary.trim()}`;
      lines.push(`- ${node.name}（${labels.join('；')}）${summary}`);
    }
  }

  return lines.join('\n');
}

/**
 * 「交底」是备注在生成链路里的名字：章备注交给生成节、节备注交给生成目。
 *
 * 它必须**原样**出现在提示词里，不能截断也不能改写：备注写了"三道考点各异的
 * 例题"，节却只见到标题——这正是上一版三层各写一套、互相脱节的原因。没有备注
 * 时给一句明确的占位，而不是留空：留空会让模型误以为"没有约束"或"自由发挥"。
 */
function handoffLine(label: string, note: string | null, indent: string): string[] {
  if (note === null || note.trim() === '') {
    return [`${indent}${label}：（还没有备注，按标题与系列说明判断）`];
  }
  return [`${indent}${label}：${note.trim()}`];
}

function outlineTreeText(context: SeriesOutlineAiContext): string {
  if (context.chapters.length === 0) return '（这个系列还没有章，也没有节和目）';
  const itemsBySection = new Map<string, SeriesOutlineAiItem[]>();
  for (const item of context.items) {
    if (!item.sectionId) continue;
    const list = itemsBySection.get(item.sectionId) ?? [];
    list.push(item);
    itemsBySection.set(item.sectionId, list);
  }
  const sectionsByChapter = new Map<string, SeriesOutlineAiSection[]>();
  for (const section of context.sections) {
    const list = sectionsByChapter.get(section.chapterId) ?? [];
    list.push(section);
    sectionsByChapter.set(section.chapterId, list);
  }
  const kindLabel: Record<CurriculumTaskKind, string> = {
    theory: '理论',
    practice: '实操',
    review: '综合',
  };
  const lines: string[] = [];
  for (const chapter of context.chapters) {
    const sections = sectionsByChapter.get(chapter.id) ?? [];
    lines.push(
      `第 ${chapter.code} 章 ${chapter.title}（${sections.length === 0 ? '还没有节' : `${sections.length} 节`}）`,
    );
    lines.push(...handoffLine('章交底', chapter.note, '  '));
    for (const section of sections) {
      const items = itemsBySection.get(section.id) ?? [];
      lines.push(
        `  ${section.code} ${section.title}（${items.length === 0 ? '还没有目' : `${items.length} 目`}）`,
      );
      lines.push(...handoffLine('节交底', section.note, '    '));
      for (const item of items) {
        const kind = item.kind ? `·${kindLabel[item.kind]}` : '';
        lines.push(`      ${item.code ?? '未编号'} ${item.title}${kind}`);
      }
    }
  }
  const unassigned = context.items.filter((item) => !item.sectionId).length;
  if (unassigned > 0) lines.push(`未归类目：${unassigned} 个（不在任何一节下面）`);
  return lines.join('\n');
}

function targetsText(input: {
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  context: SeriesOutlineAiContext;
}): string {
  const { level, mode, context } = input;
  const lines: string[] = [];
  if (level === 'chapter') {
    if (mode === 'replace') {
      lines.push(`将重建全部章（现有的 ${context.chapters.length} 章会被替换）。现有章：`);
      if (context.chapters.length === 0) lines.push('（空系列，从零生成）');
      for (const chapter of context.chapters) {
        lines.push(`- 第 ${chapter.code} 章 ${chapter.title}`);
        lines.push(...handoffLine('现有章备注', chapter.note, '  '));
      }
    } else {
      lines.push('已有章（不要重复它们，返回新的章）：');
      if (context.chapters.length === 0) lines.push('（空系列，从零生成全部章）');
      for (const chapter of context.chapters) {
        lines.push(`- 第 ${chapter.code} 章 ${chapter.title}`);
        lines.push(...handoffLine('现有章备注', chapter.note, '  '));
      }
    }
    return lines.join('\n');
  }
  if (level === 'section') {
    const targets =
      mode === 'fill'
        ? context.chapters.filter((chapter) => chapter.sectionCount === 0)
        : context.chapters;
    const skipped =
      mode === 'fill' ? context.chapters.filter((chapter) => chapter.sectionCount > 0) : [];
    lines.push(mode === 'fill' ? '需要你生成节的章：' : '这些章的节会被你返回的节整体替换：');
    for (const chapter of targets) {
      lines.push(`- 第 ${chapter.code} 章 ${chapter.title}`);
      lines.push(...handoffLine('章交底', chapter.note, '  '));
    }
    if (skipped.length > 0) {
      lines.push('以下章已经有节，不要动：');
      for (const chapter of skipped) lines.push(`- 第 ${chapter.code} 章 ${chapter.title}`);
    }
    return lines.join('\n');
  }
  const targets =
    mode === 'fill'
      ? context.sections.filter((section) => section.itemCount === 0)
      : context.sections.filter((section) => section.untouchedItemCount === section.itemCount);
  const untouched =
    mode === 'fill'
      ? []
      : context.sections.filter((section) => section.untouchedItemCount !== section.itemCount);
  const chapterById = new Map(context.chapters.map((chapter) => [chapter.id, chapter]));
  lines.push(mode === 'fill' ? '需要你生成目的节：' : '这些节里的目会被你返回的目整体替换：');
  for (const section of targets) {
    const chapter = chapterById.get(section.chapterId);
    lines.push(
      `- ${section.code} ${section.title}${chapter ? `（第 ${chapter.code} 章 ${chapter.title}）` : ''}`,
    );
    lines.push(...handoffLine('节交底', section.note, '  '));
    if (chapter) lines.push(...handoffLine('章交底', chapter.note, '  '));
  }
  if (untouched.length > 0) {
    lines.push('以下节已经有目开始设计，不要动：');
    for (const section of untouched) lines.push(`- ${section.code} ${section.title}`);
  }
  return lines.join('\n');
}

function modeNoteText(level: SeriesOutlineAiLevel, mode: SeriesOutlineAiMode): string {
  if (mode === 'replace') {
    return `覆盖重建：你返回的内容会替换掉这一层现有的${SERIES_OUTLINE_AI_LEVEL_NOUN[level]}；没提到的部分不会自动保留，请给出完整的一份。`;
  }
  if (level === 'chapter') {
    return '只补新章：已有章保持不动，只返回你新增的章，不要重复已有章。';
  }
  if (level === 'section') {
    return '只补空章：只给上面列出的章生成节，已有节的章不要返回。';
  }
  return '只补空节：只给上面列出的节生成目，已经有目的节不要返回。';
}

/** 模板变量：三份提示词的 user 消息共用同一个形状。 */
export function formatSeriesOutlineAiContext(input: {
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  context: SeriesOutlineAiContext;
}): {
  seriesInfo: string;
  seriesDesign: string;
  outlineTree: string;
  targets: string;
  modeNote: string;
} {
  return {
    seriesInfo: seriesInfoText(input.context.series),
    seriesDesign: seriesDesignText(input.context.design),
    outlineTree: outlineTreeText(input.context),
    targets: targetsText(input),
    modeNote: modeNoteText(input.level, input.mode),
  };
}
