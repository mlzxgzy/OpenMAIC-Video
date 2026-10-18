/**
 * 课程方向（第一步）的领域规则。
 *
 * 「新建课程」的第一步是确定课程方向：受众、范围、基础、场景、时长。此前这七
 * 个字段只有两个入口——列表页那个一次性的静态表单，和 agent 工具——并且在
 * 创建之后就再也改不了（`design-task-list.tsx` 的注释说"创建后在任务本身上
 * 编辑"，而那个编辑界面并不存在）。这一步现在要能被 AI 对话填写、被用户随时
 * 修改、并且**只有用户确认过**才允许进入下一阶段。
 *
 * 把规则放在这里而不是散在 store / 路由 / 组件里，理由和 `design-editing.ts`
 * 一样：同一条规则被抄三份，漂移的那一份不会报错，只会让某个入口悄悄放行。
 * 具体地，这里的四件事必须只有一份定义：
 *
 * 1. **七个槽位**。模型提示词、校验、卡片渲染、门禁都要用同一份清单和同一套
 *    中文名，否则模型被要求填的字段和门禁检查的字段会不是同一批。
 * 2. **必填项**。`title` 是建任务的硬条件，`audience` / `problemStatement` /
 *    `durationHours` 是离开 `task` 阶段的硬条件（store 的
 *    `phaseCompletionGaps` 一直如此）。
 * 3. **模型回答的解析**。模型返回的 JSON 是不可信输入：键可能拼错，`duration`
 *    可能是 `"54 学时"`。这里只接受七个已知键，其余**被丢弃并记录**，而不是
 *    悄悄写进库里。
 * 4. **"确认"的判定**。用户选了宽松模式：在对话里说"确认"也算数。宽松不等于
 *    没有底线，{@link shouldConfirmDirection} 给出那条底线——首轮不可能确认，
 *    必填项没齐不可能确认。
 */

import type { CurriculumSeriesDirectionRecord } from './design-types';

/** 课程方向的七个槽位，顺序即卡片顺序。 */
export type CurriculumDirectionKey =
  | 'title'
  | 'audience'
  | 'learnerLevel'
  | 'trainingScenario'
  | 'durationHours'
  | 'applicationScene'
  | 'problemStatement';

/** 课程方向卡片里的一格。 */
export interface CurriculumDirectionFieldSpec {
  key: CurriculumDirectionKey;
  /** 界面上显示的中文名，同时也是模型提示词里的字段名来源。 */
  label: string;
  /** 一句话说明要写什么，直接进提示词与输入框占位符。 */
  hint: string;
  /** 离开 `task` 阶段前必须填好的格子。 */
  required: boolean;
  kind: 'text' | 'textarea' | 'number';
}

/**
 * 七格的定义。
 *
 * `title` 必填但**不在** `phaseCompletionGaps` 的检查里，因为 store 建任务时
 * 就拒绝空标题：一个没有标题的任务不存在，所以"标题缺失"是写不进去的状态，
 * 而不是一个待补的缺口。
 */
const directionFields = [
  {
    key: 'title',
    label: '课程方向',
    hint: '一句话的课程名，例如「CTF 综合实战」',
    required: true,
    kind: 'text',
  },
  {
    key: 'audience',
    label: '授课对象',
    hint: '谁学：专业、年级或岗位，越具体越好',
    required: true,
    kind: 'text',
  },
  {
    key: 'learnerLevel',
    label: '学员基础',
    hint: '开课前已经会什么，例如「会 Linux 基本命令、懂 HTTP 请求」',
    required: false,
    kind: 'text',
  },
  {
    key: 'applicationScene',
    label: '应用场景',
    hint: '学完在哪里用，例如「校内选拔赛 / 校队集训」',
    required: false,
    kind: 'text',
  },
  {
    key: 'problemStatement',
    label: '课程范围',
    hint: '这门课解决什么问题，以及明确不做什么',
    required: true,
    kind: 'textarea',
  },
  {
    key: 'durationHours',
    label: '培训时长',
    hint: '总学时，只写数字',
    required: true,
    kind: 'number',
  },
  {
    key: 'trainingScenario',
    label: '训练场景',
    hint: '授课形式，例如「线下集中实训 + 线上自学」',
    required: false,
    kind: 'text',
  },
] as const satisfies readonly CurriculumDirectionFieldSpec[];

/**
 * The slots, in card order, derived from the definitions above rather than
 * restated. One list, not two: a key list maintained beside the field list is how
 * the prompt ends up asking for a slot the gate does not check.
 */
export const CURRICULUM_DIRECTION_FIELDS: readonly CurriculumDirectionFieldSpec[] = directionFields;

export const CURRICULUM_DIRECTION_KEYS = directionFields.map((field) => field.key);

/**
 * Compile-time proof that every slot in the union is defined above. `as const
 * satisfies` keeps the keys literal, so adding a slot to
 * {@link CurriculumDirectionKey} without a definition fails the build here rather
 * than at runtime in whichever surface reads the definition first.
 */
type UndefinedDirectionSlot = Exclude<
  CurriculumDirectionKey,
  (typeof directionFields)[number]['key']
>;
const everySlotIsDefined: UndefinedDirectionSlot extends never ? true : never = true;
void everySlotIsDefined;

const FIELD_BY_KEY = new Map<string, CurriculumDirectionFieldSpec>(
  directionFields.map((field) => [field.key, field]),
);

export function directionFieldSpec(key: CurriculumDirectionKey): CurriculumDirectionFieldSpec {
  const spec = FIELD_BY_KEY.get(key);
  if (!spec) throw new Error(`未知的课程方向字段「${key}」`);
  return spec;
}

export function directionFieldLabel(key: CurriculumDirectionKey): string {
  return directionFieldSpec(key).label;
}

/** 卡片的值，与 `curriculum_task` 的七个列一一对应。 */
export interface CurriculumDirectionValues {
  title: string | null;
  audience: string | null;
  learnerLevel: string | null;
  trainingScenario: string | null;
  durationHours: number | null;
  applicationScene: string | null;
  problemStatement: string | null;
}

/** 七个槽位在 `curriculum_task` 上的读法，只有一处。 */
export function directionValuesOf(source: {
  title?: string | null;
  audience?: string | null;
  learnerLevel?: string | null;
  trainingScenario?: string | null;
  durationHours?: number | null;
  applicationScene?: string | null;
  problemStatement?: string | null;
}): CurriculumDirectionValues {
  return {
    title: source.title ?? null,
    audience: source.audience ?? null,
    learnerLevel: source.learnerLevel ?? null,
    trainingScenario: source.trainingScenario ?? null,
    durationHours: source.durationHours ?? null,
    applicationScene: source.applicationScene ?? null,
    problemStatement: source.problemStatement ?? null,
  };
}

/**
 * 目第 1 步的**有效值**：目自己写了的优先，留空的用系列方向回退。
 *
 * 界面与门禁必须用同一个函数算"还缺什么"，否则会出现"卡片说缺授课对象、点确认
 * 却能推进"的分裂。
 *
 * 除 `title` 之外**全部继承**，包括 `problemStatement`（课程范围）。这一条改过
 * 一次：原来说"课程范围是这一目要解决的问题，属于目"，结果是六十多个目各填一遍
 * 同一个范围——用户的原话是「咋又是课程方向」。目与目之间的差别在标题、编号与
 * 大纲位置，不在受众与范围；真有不同的目仍然可以覆盖（见卡片上的"覆盖"开关）。
 */
export function effectiveDirectionValues(
  values: CurriculumDirectionValues,
  seriesDirection: CurriculumSeriesDirectionRecord | null | undefined,
): CurriculumDirectionValues {
  if (!seriesDirection) return values;
  return {
    ...values,
    audience: values.audience ?? seriesDirection.audience,
    learnerLevel: values.learnerLevel ?? seriesDirection.learnerLevel,
    trainingScenario: values.trainingScenario ?? seriesDirection.trainingScenario,
    applicationScene: values.applicationScene ?? seriesDirection.applicationScene,
    durationHours: values.durationHours ?? seriesDirection.durationHours,
    problemStatement: values.problemStatement ?? seriesDirection.problemStatement,
  };
}

function blank(value: string | null): boolean {
  return value === null || value.trim() === '';
}

/**
 * The required slots that are still empty, named the way a person would say
 * them. This is the one list behind {@link directionGaps} (which prefixes each
 * with 缺) and the prompt's "still empty" block, so the model is asked for
 * exactly the slots the gate will check.
 */
export function directionGapLabels(values: CurriculumDirectionValues): string[] {
  const missing: string[] = [];
  if (blank(values.title)) missing.push('课程方向名称');
  if (blank(values.audience)) missing.push('授课对象');
  if (blank(values.problemStatement)) missing.push('课程范围（要解决的问题）');
  if (values.durationHours === null) missing.push('培训时长');
  return missing;
}

/**
 * 方向卡片还缺什么。空数组表示可以确认、可以离开 `task` 阶段。
 *
 * 每一条都点名一格并给出可执行的动作，理由与 store 的 `phaseCompletionGaps`
 * 相同：报告"方向没填完"没法照做，报告"缺授课对象"可以。
 */
export function directionGaps(values: CurriculumDirectionValues): string[] {
  return directionGapLabels(values).map((label) => `缺${label}`);
}

export function isDirectionComplete(values: CurriculumDirectionValues): boolean {
  return directionGaps(values).length === 0;
}

/**
 * Which of the seven slots actually changed between two reads.
 *
 * "Actually" is the whole point: the AI writes the card repeatedly, and most
 * writes restate five slots to change one. Treating every write as a change would
 * revoke a confirmation the user just gave, every time the model repeated itself.
 * Comparing values rather than counting writes is what keeps "确认" meaning
 * something specific.
 */
export function changedDirectionKeys(
  before: CurriculumDirectionValues,
  after: CurriculumDirectionValues,
): CurriculumDirectionKey[] {
  return CURRICULUM_DIRECTION_KEYS.filter((key) => before[key] !== after[key]);
}

/** {@link directionGaps} 的用户可见说法，供卡片与门禁共用。 */
export function describeDirectionGaps(values: CurriculumDirectionValues): string | null {
  const gaps = directionGaps(values);
  return gaps.length === 0 ? null : `课程方向还差：${gaps.join('；')}`;
}

// ── 模型回答 ────────────────────────────────────────────────────────────────

/** 模型的回答没法当成一次方向修改用；message 面向调用方。 */
export class DirectionAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DirectionAnswerError';
  }
}

/** 一次写入的补丁：只含有值的格子，没提到的格子保持原样。 */
export type CurriculumDirectionPatch = Partial<CurriculumDirectionValues>;

export interface DirectionAnswer {
  /** 模型给用户看的一句话，写进对话。 */
  message: string;
  /** 本次要写进 `curriculum_task` 的格子。 */
  fields: CurriculumDirectionPatch;
  /** 模型认为用户在上一句里确认了当前卡片。是否采纳见 {@link shouldConfirmDirection}。 */
  confirmRequested: boolean;
  /** 被丢弃的键，写日志用：模型拼错字段时不该静默。 */
  rejectedKeys: string[];
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 把模型给的字段洗成七个已知键。
 *
 * 三条规则，每条都对应一种真实的坏输入：
 * - **未知键丢弃并记录**。模型爱加 `notes`、`courseName` 这类自造键；写进库之前
 *   就拦住，比让 `updateCurriculumTask` 之后才发现要便宜。
 * - **时长接受 `48` 与 `"48 学时"`**。中文对话里模型经常把单位带上，把整条
 *   丢掉会让用户看到"AI 说改了但卡片没变"。
 * - **空字符串算 null**。模型用 `""` 表示"这格我不知道"，那就该留空，让门禁
 *   继续拦着，而不是存一个看起来填过的空格子。
 */
export function sanitizeDirectionFields(raw: unknown): {
  fields: CurriculumDirectionPatch;
  rejectedKeys: string[];
} {
  if (!isRecord(raw)) return { fields: {}, rejectedKeys: [] };
  const fields: CurriculumDirectionPatch = {};
  const rejectedKeys: string[] = [];

  for (const [key, value] of Object.entries(raw)) {
    if (!CURRICULUM_DIRECTION_KEYS.includes(key as CurriculumDirectionKey)) {
      rejectedKeys.push(key);
      continue;
    }
    const directionKey = key as CurriculumDirectionKey;
    if (directionKey === 'durationHours') {
      // An explicit `null` clears the slot, exactly as it does for the text ones;
      // anything else has to look like a number of hours or it is dropped, so
      // "待定" cannot become a stored value.
      if (value === null) {
        fields.durationHours = null;
        continue;
      }
      const hours = coerceHours(value);
      if (hours !== undefined) fields.durationHours = hours;
      continue;
    }
    if (value === null) {
      fields[directionKey] = null;
      continue;
    }
    if (typeof value !== 'string') {
      // A number or an array where a sentence belongs: not worth guessing at.
      rejectedKeys.push(key);
      continue;
    }
    const text = value.trim();
    fields[directionKey] = text === '' ? null : text;
  }

  return { fields, rejectedKeys };
}

/** `48` / `"48"` / `"48 学时"` / `"约 48 小时"` → 48；看不懂或为负 → undefined。 */
function coerceHours(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value !== 'string') return undefined;
  const match = /-?\d+(?:\.\d+)?/.exec(value);
  if (!match) return undefined;
  const parsed = Number.parseFloat(match[0]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

/**
 * 模型回答的 JSON 形状：`{ message, fields, confirm }`。
 *
 * 容忍 markdown 围栏和前后废话（模型两样都爱加），但**不**容忍没有 `fields`
 * 的对象：那样这次交互什么也不会发生，而用户会以为发生了。
 */
export function parseDirectionAnswer(text: string): DirectionAnswer {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new DirectionAnswerError('模型没有返回 JSON 对象');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new DirectionAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) {
    throw new DirectionAnswerError('模型返回的不是一个 JSON 对象');
  }
  const { fields, rejectedKeys } = sanitizeDirectionFields(parsed.fields);
  return {
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    fields,
    confirmRequested: parsed.confirm === true,
    rejectedKeys,
  };
}

/**
 * 是否采纳模型声明的"用户已确认"。
 *
 * 用户选了宽松模式，所以对话里的确认算数——但"宽松"要有底线，否则模型第一轮
 * 就可以自己把方向定死，用户看到的"确认"就退回成装饰。两条底线：
 *
 * 1. **用户的第一句话不能确认。** 那时用户还没见过卡片，没有可确认的对象。
 *    数的是**用户轮次**而不是总轮次：对话框开场那条助手寒暄不是模型对卡片的
 *    回答，把它算成一轮会让"第一句就能确认"重新成立。
 * 2. **必填项没齐不能确认。** 确认一个门禁仍然会拒绝的卡片没有意义，而它会让
 *    用户以为已经越过这一步。
 *
 * 两条都是确定性的检查，不依赖模型的自述，所以模型"过于自信"时也不会越过。
 */
export function shouldConfirmDirection(input: {
  confirmRequested: boolean;
  /** 本次写入**之后**的卡片。 */
  values: CurriculumDirectionValues;
  /** 到本轮为止的用户消息数，**含本轮**。 */
  userTurns: number;
}): boolean {
  if (!input.confirmRequested) return false;
  if (input.userTurns < 2) return false;
  return isDirectionComplete(input.values);
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 卡片的纯文本形式，一次用于两处：模型提示词里的"当前卡片"，以及 agent 工具
 * 的返回值。两处必须看到同一张卡片，否则模型会对着一个和库里不同的版本改。
 */
export function formatDirectionCard(
  values: CurriculumDirectionValues,
  confirmedBy?: string | null,
): string {
  const lines = CURRICULUM_DIRECTION_FIELDS.map((field) => {
    const value = values[field.key];
    // `durationHours` is the one numeric slot, so the two branches cannot share
    // an expression: `.trim()` assumes a string, and the type is `number | null`
    // for exactly that slot.
    const shown =
      typeof value === 'number'
        ? `${value} 学时`
        : value === null || value.trim() === ''
          ? '（未填）'
          : value;
    return `${field.required ? '*' : ' '} ${field.label}：${shown}`;
  });
  const state = confirmedBy
    ? `已确认（${confirmedBy === 'user' ? '用户点击确认' : '对话中确认'}）`
    : '未确认';
  return [`课程方向卡片（* 为必填，当前状态：${state}）`, ...lines].join('\n');
}
