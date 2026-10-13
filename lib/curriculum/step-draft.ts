'use client';

/**
 * 草稿的**通用**引擎：一步草稿 = 一组可逐行签字的行。
 *
 * 存在的理由是"五步只有一副骨架"。七个阶段里，六个阶段的 AI 交互长得一样：模型照常
 * 回答、确定性规则照常把 ref 解析成真实 id，而作者看到的是**一份没有落库的草稿**，
 * 按哪一行才改哪一行。如果每一步各写一套 `XxxDraftLine` + `XxxCopilot`，那么
 * "采纳一行"的语义、灰掉一行的理由、"改一改"能改什么，会在第五步开始各写各的——
 * 而这些正是这套交互里最容易出错、也最不该出错的部分（它们全都关乎"作者以为库被改了，
 * 实际上没有"）。
 *
 * 所以引擎是通用的，**知识技能图那套专用实现也搬到这里**（见文件末"搬迁"）。
 *
 * 三条刻意的决定：
 *
 * 1. **行携带"它会 POST 到哪、body 是什么"，而不是携带"它是什么"。** 引擎因此不认识
 *    任何领域概念——目标、大纲、教案、题目、知识点对它是同一种东西。领域含义留在各自的
 *    转换函数里，而写入路径留在**服务端算出来的草稿**里。代价是服务端要能算出整表替换
 *    那类写入的 body；这正是 {@link StepDraftLine.replaceFromLive} 存在的原因（见下）。
 * 2. **整表替换的行不能把 body 冻在起草那一刻。** `PUT /node-objectives` 和
 *    `PUT /unit-coverage` 都是"先删后插"的整表替换：body 里带着别人没有提到的行才算数，
 *    少带一行就悄悄删掉它。所以这类行的 body 由 `replaceFromLive` 在**采纳那一刻**按
 *    当前库重算。冻在起草时会让"连按两行"里第二行抹掉第一行——这正是 B2 试点里
 *    `mergedLinkSet` 存在的原因，现在它变成引擎的一个能力而不是某个步骤的特例。
 * 3. **"依赖某一行先落地"用 {@link StepDraftNeed} 表达，可以有多条。** 一个知识点行
 *    依赖目标行落地（要回填 objectiveId），一条先后关系行**同时**依赖两端（sourceId、
 *    targetId），一个新章的行依赖它的父章落地。单数依赖表达不了后者。
 *
 * **作者能改的只有名字。** 摘要、难度、支撑等级都是模型的判断，一个单行输入框改不动
 * 三处语义，假装能改只会让人改错；名字是唯一必须由人拍板的——它是后面所有步骤寻址这
 * 一行的句柄。`name` 有值才显示"改一改"。
 */

import { dropNullEnums } from './draft-body';

/**
 * 发出去之前，最后一次过掉"这条 HTTP 路由读不了的 `null`"。
 *
 * 放在引擎而不是只放在六个转换函数里，理由与 {@link assertDraftRouteSafe} 逐字相同：这是
 * 那条信任的边界。转换函数漏掉一次的表现是"那条建议静默地采纳不了"，而错误信息里没有一个
 * 字与它有关；放在这里，六个步骤与将来第七个步骤**都不可能**发出这种 body。
 *
 * 转换函数那边也各自过了一遍（它们要就"想清空但接口做不到"说一句话，见
 * `draft-body.ts`），所以这里是**冗余的**。冗余在这里是故意的：面板上"采纳后会发什么"那个
 * 预览读的是转换函数给的 body，两处都过才能保证预览与真正发出去的那份一致；而转换函数忘了
 * 的话，这一层仍然兜得住。
 */
function withoutUnreadableNulls(body: Record<string, unknown>): Record<string, unknown> {
  return dropNullEnums(body).body;
}

/**
 * 一条写入：打哪个路由、带什么 body。引擎不认识语义，只负责把它发出去。
 */
export interface StepDraftWrite {
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** 必须是 `/api/curriculum/design/tasks/…` 下的路径——见 {@link assertDraftRouteSafe}。 */
  route: string;
  body?: Record<string, unknown>;
  /**
   * 紧跟着这一跳的写入，按顺序执行。
   *
   * 顺序**必须是**依赖顺序（先建后补），所以它是一个数组而不是一个可选字段：把"接着做"
   * 表达成一个字段，就会有第二次写入与第一次并行的那一天。
   */
  then?: readonly FollowUpWrite[];
  /**
   * 新建成功之后才发的写入，与 {@link then} 的区别只有一个：它的 body **不能**含 `#id`，
   * 因为它看到的是"新建之前"的库。
   *
   * 分成两个字段而不是一个数组，是因为它们的 body 各有各的算术：`then` 的 body 要填第一
   * 跳的 id，而这里这一项的 body 要把第一跳的结果**并进去**。放进同一个数组就必须让其中
   * 一种拿到它不需要的东西。
   */
  thenAfter?: readonly FollowUpWrite[];
}

/**
 * 跟在主写入之后的写入。刻意与 {@link StepDraftWrite} 分开两个类型，而不是共用一个：
 *
 * - **没有 `DELETE`**。先建后删没有意义，而如果这里允许它，那么"这一行删掉自己刚建的"
 *    这种形状就需要在采纳时判断一下先后——那是一种只有草稿算错才会出现的形状。
 * - **body 必填**。没有 body 的后续跳没有存在的理由：真要有，那也是主写入本身。
 */
export interface FollowUpWrite {
  method: 'POST' | 'PATCH' | 'PUT';
  route: string;
  body: Record<string, unknown>;
}

/** 刚建出来的那一行的 id，在后续跳的 body 里写成这个占位。 */
export const FRESH_ID = '#id';

/**
 * 把后续跳 body 里的 {@link FRESH_ID} 换成真实 id。
 *
 * 刻意是**整个 body 的递归替换**而不是只换顶层的 `objectiveId`：证据那一跳还会带上
 * 别的 id 形态（`sortOrder`、`evidenceId`…），而漏掉一个占位符的表现是"采纳前两行成功了、
 * 第三行报了一个与建议无关的错"——比整体失败更难查。
 */
export function substituteFreshId(
  body: Record<string, unknown>,
  id: string,
): Record<string, unknown> {
  const walk = (value: unknown): unknown => {
    if (value === FRESH_ID) return id;
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, walk(entry)]),
      );
    }
    return value;
  };
  return walk(body) as Record<string, unknown>;
}

/** 这一行的 body 里有哪个键，要填"另一行产出的真实 id"。 */
export interface StepDraftNeed {
  /** 依赖哪一行的产出。 */
  lineId: string;
  /** 自己 body 里的哪个键。 */
  key: string;
  /** 人话，用于"先采纳 X"。 */
  label: string;
}

export interface StepDraftCreate {
  route: string;
  body: Record<string, unknown>;
  /** 采纳后要从回包里取 id 的键，例如 `unit`、`objective`、`node`。 */
  idKey: string;
  needs?: readonly StepDraftNeed[];
  /**
   * 紧跟着"新建"之后的整表替换：`body` 是**要并进去的那几条**，而不是整份集合。
   *
   * 为什么必须是"并进去"而不是"整份"：整表替换路由（`PUT /node-objectives`、
   * `PUT /unit-coverage`）的 body 必须是**当前库的全集**，而当前库在起草那一刻还包含
   * 作者还没按的那些行。冻在起草时的那份会让先按的行被后按的行抹掉；只发"要加的那几条"
   * 更糟——那会把别的行悄悄删掉。
   *
   * **刻意是数据而不是函数。** 第一版这里是一个 `replaceFromLive(live)` 回调，它可以写出
   * 任意正确的合并逻辑——然后它过不了 JSON：服务端算出来的行要发到浏览器，函数在
   * `JSON.stringify` 里变成 `undefined`，于是每一行都退化成"没有后续跳"，而所有测试在
   * 服务端跑、**全绿**。只有 e2e（真的过一遍 HTTP）会看到它。
   *
   * 引擎给出的合并只有一种形状：**以 `key` 为键去重替换，其余原样带过**。两种真实用例
   * 都恰好是这个形状——连线按 `nodeId/objectiveId` 去重，覆盖按 `unitId/objectiveId`
   * 去重。而"同一个 `key` 要被换掉"这件事在这里只有一个含义：作者重新挂了一次同一个
   * 端点对，那应该以新的为准。
   */
  mergeInto?: {
    method: 'PUT';
    route: string;
    /** 要并进去的行。body 里可以用 {@link FRESH_ID} 指代刚建出来的那一行。 */
    rows: readonly Record<string, unknown>[];
    /** live 里哪一段是全集，以及每行的去重键。 */
    source: 'nodeObjectives' | 'unitCoverage';
    key: readonly string[];
    /**
     * body 里那一段的键：`PUT /node-objectives` 是 `links`，`PUT /unit-coverage` 是 `rows`。
     *
     * 由服务端给出而不是引擎去猜：猜错的后果是采纳时 400，而错误信息里没有一句与这条建议
     * 有关，作者只看见"采纳失败"。
     */
    bodyKey: string;
  };
  /**
   * 第一跳之后要接着做的写入，body 里可以用 {@link FRESH_ID} 指代刚建出来的那一行。
   *
   * **为什么需要它**：`POST /objectives` 不接受 evidence，"新建目标 + 带上它的证据"因此
   * 是两跳，而第二跳要填第一跳的 id。把这两跳摊成两行会承诺一个做不到的操作——证据行
   * 在目标行被采纳之前没有 objectiveId 可填，于是它只能是一个不可按的说明行；把它做成
   * 同一行的后续跳，才与作者点一次按钮的心智一致。
   */
  then?: readonly {
    method: 'POST' | 'PATCH' | 'PUT';
    route: string;
    body: Record<string, unknown>;
  }[];
}

export type StepDraftLine = {
  /** 跨渲染稳定的 id：采纳记录、依赖、"先采纳 X"全部按它寻址。 */
  id: string;
  /** 一句话说明"这一行会改什么"，作者在按下之前读的就是它。 */
  text: string;
  /** 补充说明：改动的逐项对照、取值来源等。 */
  detail?: string;
  /** 可改的名字；没有就不显示"改一改"。 */
  name?: string;
  /**
   * 名字在 body 里的键。**必填**，只要 `name` 存在。
   *
   * 不让引擎默认成 `name`，是因为不同领域叫法不同：知识点叫 `name`，学习目标叫 `title`，
   * 而"改一改"必须写到作者真正读到的那一栏上。猜错的后果很安静——引擎写了一个没人读的
   * `name`，界面上名字没变，而库多了一个字段。
   */
  nameKey?: string;
  /** 主写入：会新建一行，采纳后回传真实 id。 */
  create?: StepDraftCreate;
  /** 独立写入，不依赖任何别的行。 */
  write?: StepDraftWrite;
  /**
   * 整表替换的一行：`rows` 是要并进去的那几条，全集在采纳那一刻按 `source` 取。
   *
   * 与 {@link StepDraftCreate.mergeInto} 同一个理由必须是数据：一个"算 body 的函数"在
   * 服务端是对的、在浏览器里是 `undefined`，而那条路上的测试全都跑在服务端。
   */
  mergeInto?: {
    method: 'PUT';
    route: string;
    rows: readonly Record<string, unknown>[];
    source: 'nodeObjectives' | 'unitCoverage';
    key: readonly string[];
    bodyKey: string;
  };
  /** `write` / `replaceFromLive` 的前置条件。 */
  needs?: readonly StepDraftNeed[];
  /** 说明行：没有"采纳"这件事，界面不渲染按钮。 */
  note?: string;
};

/** 整表替换的行重算 body 时能看到的当前库。刻意只给两样：够算整表，不够算别的。 */
export interface StepDraftLive {
  nodeObjectives: readonly {
    nodeId: string;
    objectiveId: string;
    supportLevel: string;
  }[];
  unitCoverage: readonly {
    unitId: string;
    objectiveId: string;
    coverageKind: string;
    depth: string;
  }[];
}

export interface StepDraft {
  lines: StepDraftLine[];
  /** 模型这一轮自己给的话。 */
  message: string;
  /** 这一轮没能照做的事，人话。 */
  warnings: string[];
  /** 草稿来源那句话，方便作者知道这是"按哪句话起草的"。 */
  instruction: string;
}

/** 一行草稿的状态。作者的意志只有三种，没有第四种。 */
export type StepDraftLineStatus = 'pending' | 'adopted' | 'dropped';

/** 采纳前还能不能按。 */
export type StepDraftAvailability = 'ready' | 'waiting' | 'done';

export interface StepDraftState {
  draft: StepDraft | null;
  statuses: Record<string, StepDraftLineStatus>;
  /** 采纳 `create` 行后拿到的真实 id，键是行 id。 */
  producedIds: Record<string, string>;
  /** 作者"改一改"写过的名字，键是行 id。 */
  edits: Record<string, string>;
}

export const initialStepDraftState: StepDraftState = {
  draft: null,
  statuses: {},
  producedIds: {},
  edits: {},
};

/** 与 `draft?.lines ?? []` 同一个理由：一个稳定的空引用。 */
export const EMPTY_STEP_DRAFT_LINES: readonly StepDraftLine[] = [];

/**
 * 一行现在能不能按，以及为什么不能。
 *
 * **唯一"不能按"的情形是依赖没落地**：一条写入的 body 里要填别的行产出的 id，而那行还
 * 没被采纳，于是这个 id 不存在。其余行总是可以按——采纳失败会由路由自己报错，界面不该
 * 抢在前面猜。猜错的方向是两边都错：界面放行一个注定失败的写入，作者看到的只有一句
 * "采纳失败"。
 */
export function stepLineAvailability(
  line: StepDraftLine,
  state: Pick<StepDraftState, 'statuses' | 'producedIds'>,
): { availability: StepDraftAvailability; reason: string } {
  const status = state.statuses[line.id];
  if (status === 'dropped') return { availability: 'done', reason: '已丢弃，不再采纳' };
  if (status === 'adopted') return { availability: 'done', reason: '已采纳' };
  if (line.note !== undefined) return { availability: 'done', reason: '这是说明，不需要采纳' };
  const needs = line.create?.needs ?? line.needs ?? [];
  if (needs.length === 0) return { availability: 'ready', reason: '' };
  const missing = needs.filter((need) => state.producedIds[need.lineId] === undefined);
  if (missing.length === 0) return { availability: 'ready', reason: '' };
  return {
    availability: 'waiting',
    reason: `先采纳「${missing.map((need) => need.label).join('」「')}」，这一行才有要填的东西`,
  };
}

/** 这一行还依赖哪几行——给界面画依赖线用，没有就返回空。 */
export function stepLineBlockedBy(line: StepDraftLine, lines: readonly StepDraftLine[]): string[] {
  const needs = line.create?.needs ?? line.needs ?? [];
  if (needs.length === 0) return [];
  const known = new Set(lines.map((row) => row.id));
  return needs.filter((need) => known.has(need.lineId)).map((need) => need.lineId);
}

/**
 * 这一行采纳时要发的那个写入，以及它自己产出的 id 该怎么记账。
 *
 * 依赖的 id 在这里填，而不是在界面里拼——界面只管"按了没有"，一旦让界面知道 body 的
 * 结构，"改一改"改到哪一格就会变成界面的责任，而它并不知道哪个键是名字。
 */
export function resolveStepLineWrite(
  line: StepDraftLine,
  state: Pick<StepDraftState, 'producedIds' | 'edits'>,
  live: StepDraftLive,
): { write: StepDraftWrite; producedIdKey: string | null } {
  const edit = (state.edits[line.id] ?? '').trim();
  const name = edit === '' ? line.name : edit;
  /**
   * 只有作者**真的改了**名字才写进 body。
   *
   * 一次与原值相同的写入不只是没有意义：它是"这一行改了什么"的唯一记录，而界面上那句
   * 说明就是从它推出来的。所以不改就不发，而不是发了再让界面比较。
   */
  const renamed = (body: Record<string, unknown>): Record<string, unknown> => {
    if (line.name === undefined || line.nameKey === undefined) return body;
    if (name === line.name) return body;
    return { ...body, [line.nameKey]: name };
  };

  if (line.create) {
    const create = line.create;
    if (create.then && create.then.length > 0 && create.mergeInto) {
      // 两种后续跳并存等于既要求看到未来又要求看到当下：没有一种合并规则能同时对。
      throw new Error(`这一行不能既用固定的后续跳又并入当前库：${line.id}`);
    }
    if (create.then && create.then.length > 0 && !create.idKey) {
      // 有后续跳却没有 idKey：后续跳要填的就是第一跳的 id，所以这行注定在采纳时失败。
      // 在起草时刻拒绝，而不是让作者按一次然后看见一句"第 2 跳失败"。
      throw new Error(`这一行有后续写入却没有 idKey，无法填入第一跳的 id：${line.id}`);
    }
    const body: Record<string, unknown> = renamed({ ...create.body });
    for (const need of create.needs ?? []) {
      const produced = state.producedIds[need.lineId];
      if (produced === undefined) {
        throw new Error(`「${need.label}」还没采纳，这一行填不了它要的东西。`);
      }
      body[need.key] = produced;
    }
    // `then` 的 body **不在这里替换** {@link FRESH_ID}：那个 id 是第一跳的响应，而这一跳还
    // 没发出去。替换发生在采纳的执行器里（`applyStepLineWrites`），它在第一跳之后才拿到
    // 那个 id。在起草时刻替换等于用一个还不存在的值做决定。
    //
    // `mergeInto` 在这里就算成一份整表替换的 body——它看到的是采纳那一刻的库，而**新建
    // 这一行还没写进去**，所以 `rows` 里那一条的 `nodeId` 仍是 {@link FRESH_ID} 占位，
    // 由执行器在第一跳之后替换。
    const after: FollowUpWrite[] = create.mergeInto ? [mergedWrite(create.mergeInto, live)] : [];
    return {
      write: {
        method: 'POST',
        route: create.route,
        body: withoutUnreadableNulls(body),
        then: (create.then ?? []).map((follow) => ({
          ...follow,
          body: withoutUnreadableNulls(follow.body),
        })),
        thenAfter: after.map((follow) => ({
          ...follow,
          body: withoutUnreadableNulls(follow.body),
        })),
      },
      producedIdKey: create.idKey,
    };
  }

  if (line.mergeInto) {
    return { write: mergedWrite(line.mergeInto, live), producedIdKey: null };
  }

  if (line.write) {
    if (line.write.body === undefined) return { write: line.write, producedIdKey: null };
    return {
      write: {
        ...line.write,
        body: withoutUnreadableNulls(renamed({ ...line.write.body })),
      },
      producedIdKey: null,
    };
  }

  throw new Error('这一行没有需要采纳的写入。');
}

/**
 * 路由必须落在这一段路径下。
 *
 * 草稿的行是由**服务端算出来的**，而引擎会把它们原样发出去。这条检查是那条信任的边界：
 * 一旦某个转换函数算错路径，错误会表现为"点采纳时往一个意外的地方发了一个 POST"，
 * 而界面上看不出任何异常。放在引擎里而不是每个转换函数里，是因为四个转换函数都会忘。
 */
export function assertDraftRouteSafe(route: string): string {
  if (!route.startsWith('/api/curriculum/design/tasks/')) {
    throw new Error(`草稿的写入路径越界：${route}`);
  }
  return route;
}

/**
 * 一行的正文（用于草稿面板展示"采纳后会发什么"）。
 *
 * 刻意**只对静态写入给 body**：整表替换那类行的 body 是采纳那一刻才算出来的，在起草
 * 时刻展示它等于展示一个还没发生的事实，而它与真正发出去的那份几乎必然不同。
 */
export function stepLineBodyPreview(
  line: StepDraftLine,
): { method: string; route: string; body: Record<string, unknown> | undefined } | null {
  if (line.create) {
    return {
      method: 'POST',
      route: line.create.route,
      body: withoutUnreadableNulls(line.create.body),
    };
  }
  if (line.write) {
    return {
      method: line.write.method,
      route: line.write.route,
      body: line.write.body === undefined ? undefined : withoutUnreadableNulls(line.write.body),
    };
  }
  return null;
}

/**
 * 整表替换的 body：**当前库的全集**加上要并进去的那几条，同键的以新的为准。
 *
 * 只有"全集"是不够的——作者的意图是那几条，按了它们才是；而只有"那几条"更糟：少带一行
 * 就删掉一行，而那不会报错。两种真实用例都恰好是"按 key 去重替换"，所以合并规则只有这
 * 一种，不给它更多形状。
 */
function mergedWrite(
  merge: NonNullable<StepDraftLine['mergeInto']>,
  live: StepDraftLive,
): FollowUpWrite {
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of live[merge.source]) {
    byKey.set(keyOf(row as Record<string, unknown>, merge.key), { ...(row as object) } as Record<
      string,
      unknown
    >);
  }
  for (const row of merge.rows) {
    byKey.set(keyOf(row, merge.key), { ...row });
  }
  return {
    method: merge.method,
    route: merge.route,
    body: withoutUnreadableNulls({ [merge.bodyKey]: [...byKey.values()] }),
  };
}

function keyOf(row: Record<string, unknown>, key: readonly string[]): string {
  return key.map((field) => String(row[field])).join('/');
}
