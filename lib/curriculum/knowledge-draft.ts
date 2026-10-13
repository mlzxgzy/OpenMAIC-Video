/**
 * 第三步「知识技能图」的 AI 草稿：行、状态、可否采纳的规则。
 *
 * 存在的理由只有一句：**草稿不落库**。现有 turn 路由是"模型说完就直接写"，作者看到的
 * 永远是结果，看不到"它打算改什么"。于是「AI 帮我改」变成了一件不敢按的按钮——按下去
 * 之前不知道会动哪几行，按下去之后想撤回只能靠"撤回确认"（那是签收，不是写）。
 *
 * 所以起草与写入拆成两半：
 *
 * - **起草**走 turn 路由的 `dryRun`：模型照常回答，`resolveKnowledgeTurn` 照常把 ref
 *   解析成真实 id、照常做环检测与整表合并，但一行都不写。回包里带的是一份 **草稿**。
 * - **采纳**走这一份草稿的**单行**，用已经存在的手工路由（`/nodes`、`/nodes/[id]`、
 *   `/node-objectives`、`/dependencies`）。没有新增写接口——采纳就是作者自己在左边
 *   做的那件事，AI 只是替他填好了格子。
 *
 * 纯函数，不碰数据库也不碰 React：本文件里所有判定都能用纯输入测出来。
 *
 * 三条刻意的决定：
 *
 * 1. **连线不是独立的行，它跟着节点走。** `setCurriculumNodeObjectives` 是整表替换，
 *    所以"只采纳这一条连线"根本不存在这种粒度——采纳一个节点就是采纳它的连线集合。
 *    把连线摊成独立行会让界面承诺一个做不出来的操作。只有**给已有节点补连线**才单列成
 *    一行，因为那确实是作者能单独点头的一步。
 * 2. **指向草稿节点的边在节点采纳之前不可采纳**，且这件事必须显示出来。边的两端都是
 *    真实 id 才写得进去（`createCurriculumDependency` 会校验端点归属），所以一条边
 *    最少依赖两个已采纳节点。规则写在 {@link lineAvailability} 里，界面照它画。
 * 3. **"改一改"不是第三种状态。** 它等于"采纳成我改过的样子"，所以只多一个输入框，
 *    不多一个状态——三态（待处理/已采纳/已丢弃）已经够表达作者的全部意志，多出的状态
 *    只会在下一次重构时被"顺手统一"掉。
 */

import type {
  KnowledgeNodeDraft,
  KnowledgeNodePatch,
  ResolvedDependency,
} from './design-knowledge';
import type {
  CurriculumDependencyEdgeType,
  CurriculumDifficulty,
  CurriculumNodeType,
  CurriculumSupportLevel,
} from './design-types';

/** 一行草稿。`kind` 决定它被采纳时打哪个路由。 */
export type KnowledgeDraftLine =
  | {
      kind: 'node';
      /** 这一轮新建的节点在 `turn.added` 里的下标——边的端点靠它寻址。 */
      draftIndex: number;
      name: string;
      nodeType: CurriculumNodeType;
      summary: string | null;
      difficulty: CurriculumDifficulty | null;
      /** 采纳时一并写下的支撑关系（目标 id 已在服务端解析过，只留下真实存在的）。 */
      objectiveRefs: { objectiveId: string; supportLevel: CurriculumSupportLevel }[];
      /** 人话：模型想把这个知识点挂到哪几个目标上。 */
      objectiveTitles: string[];
    }
  | {
      kind: 'patch';
      nodeId: string;
      nodeName: string;
      /** 改动前后的可读对照，空的一侧表示"原来没有"。 */
      changes: { field: string; before: string | null; after: string | null }[];
      patch: Omit<KnowledgeNodePatch, 'ref'>;
    }
  | {
      kind: 'link';
      nodeId: string;
      nodeName: string;
      objectiveId: string;
      objectiveTitle: string;
      supportLevel: CurriculumSupportLevel;
    }
  | {
      kind: 'edge';
      /** `node:<id>` 或 `draft:<index>`——与 `ResolvedDependency` 同一套寻址。 */
      sourceKey: string;
      sourceLabel: string;
      targetKey: string;
      targetLabel: string;
      edgeType: CurriculumDependencyEdgeType;
      note: string | null;
      /** 已被这一轮删掉的边不再作为行出现，这里只用来决定"可采纳"。 */
      removedEndpointKeys: string[];
    }
  | {
      kind: 'drop';
      /** 没能照做的部分：跳过的 ref、被否掉的字段、闭环被拒的边。 */
      text: string;
    };

/** 一行草稿的状态。作者的意志只有三种，没有第四种。 */
export type KnowledgeDraftLineStatus = 'pending' | 'adopted' | 'dropped';

/** 采纳前还能不能按。 */
export type KnowledgeDraftAvailability = 'ready' | 'waiting' | 'done';

export interface KnowledgeDraft {
  lines: KnowledgeDraftLine[];
  /** 模型这一轮自己给的话。 */
  message: string;
  /** 这一轮没能照做的事，人话。 */
  warnings: string[];
  /** 草稿来源那句话，方便作者知道这是"按哪句话起草的"。 */
  instruction: string;
}

export interface KnowledgeDraftState {
  draft: KnowledgeDraft | null;
  statuses: Record<string, KnowledgeDraftLineStatus>;
  /** 草稿节点被采纳后拿到的真实 id，下标即 `draftIndex`。 */
  adoptedNodeIds: string[];
  /** 作者在"改一改"里改过的内容，key 是行的 id。 */
  edits: Record<string, string>;
}

/** 行的稳定 id。它必须跨渲染不变，否则采纳记录会串行。 */
export function knowledgeLineId(line: KnowledgeDraftLine, index: number): string {
  switch (line.kind) {
    case 'node':
      return `node:draft-${line.draftIndex}`;
    case 'patch':
      return `patch:${line.nodeId}`;
    case 'link':
      return `link:${line.nodeId}:${line.objectiveId}`;
    case 'edge':
      return `edge:${line.sourceKey}->${line.targetKey}`;
    case 'drop':
      return `drop:${index}`;
  }
}

export const initialKnowledgeDraftState: KnowledgeDraftState = {
  draft: null,
  statuses: {},
  adoptedNodeIds: [],
  edits: {},
};

/**
 * 采纳一行 `node` 时，真正要 POST 的字段。
 *
 * 「改一改」在这里生效，且**只改名称**：摘要、难度、类型都是模型给的判断，作者在
 * 一个单行输入框里改不动三处语义，假装能改只会让人改错。名字是唯一必须由人拍板的
 * ——它是这门课里后面所有步骤寻址这个知识点的句柄。
 *
 * **空的摘要与难度整个键都不发**，而不是发 `null`。这是 e2e 逮到的：`POST /nodes` 的
 * `readNode` 用 `oneOf` 读难度，"给了 null"等于"这个值不是合法取值"而 400，"没给"才是
 * 不设置。于是 `difficulty: null` 会让每一条没写难度的草稿都以一个与建议本身毫无关系的
 * 理由被拒，而用户看到的只有一句"采纳失败"。草稿里保留 null 是对的（它如实说"模型没
 * 写"），发出去时省掉才是对的。
 */
export function nodeDraftForAdoption(
  line: Extract<KnowledgeDraftLine, { kind: 'node' }>,
  edit?: string,
): {
  name: string;
  nodeType: CurriculumNodeType;
  summary?: string;
  difficulty?: CurriculumDifficulty;
} {
  const name = (edit ?? '').trim();
  return {
    name: name === '' ? line.name : name,
    nodeType: line.nodeType,
    ...(line.summary !== null ? { summary: line.summary } : {}),
    ...(line.difficulty !== null ? { difficulty: line.difficulty } : {}),
  };
}

/**
 * 一行现在能不能按，以及为什么不能。
 *
 * 唯一"不能按"的情形是**边**：它要两个端点都是库里真实存在的节点，而指向草稿节点的边
 * 要等那个节点先被采纳。其余行总是可以按——采纳失败会由路由自己报错，界面不该抢在
 * 前面猜。
 */
export function lineAvailability(
  line: KnowledgeDraftLine,
  state: Pick<KnowledgeDraftState, 'statuses' | 'adoptedNodeIds'>,
  lineId: string,
): { availability: KnowledgeDraftAvailability; reason: string } {
  const status = state.statuses[lineId];
  if (status === 'dropped') return { availability: 'done', reason: '已丢弃，不再采纳' };
  if (status === 'adopted') return { availability: 'done', reason: '已采纳' };
  if (line.kind === 'drop') return { availability: 'done', reason: '这是说明，不需要采纳' };
  if (line.kind !== 'edge') return { availability: 'ready', reason: '' };

  const resolved = (key: string) => {
    if (key.startsWith('node:')) return true;
    if (!key.startsWith('draft:')) return false;
    const index = Number(key.slice('draft:'.length));
    return state.adoptedNodeIds[index] !== undefined;
  };
  const missing: string[] = [];
  if (!resolved(line.sourceKey)) missing.push(line.sourceLabel);
  if (!resolved(line.targetKey)) missing.push(line.targetLabel);
  if (missing.length === 0) return { availability: 'ready', reason: '' };
  return {
    availability: 'waiting',
    reason: `先采纳「${missing.join('」「')}」，这条先后关系才有两端`,
  };
}

/**
 * 采纳一条边时用的真实 id。
 *
 * 返回 null 表示端点还没落地——这与 {@link lineAvailability} 是同一套判定，所以界面
 * 灰掉的行在这里一定返回 null，不会出现"按钮能按但算不出 id"的第三种情况。
 */
export function edgeEndpointsOf(
  line: Extract<KnowledgeDraftLine, { kind: 'edge' }>,
  state: { adoptedNodeIds: readonly string[] },
): { sourceId: string; targetId: string } | null {
  const one = (key: string) =>
    key.startsWith('node:')
      ? key.slice('node:'.length)
      : key.startsWith('draft:')
        ? state.adoptedNodeIds[Number(key.slice('draft:'.length))]
        : undefined;
  const sourceId = one(line.sourceKey);
  const targetId = one(line.targetKey);
  if (!sourceId || !targetId) return null;
  return { sourceId, targetId };
}

/** 一行的人话摘要。右栏用它在采纳前说清"这一行会改什么"。 */
export function describeKnowledgeLine(line: KnowledgeDraftLine): string {
  switch (line.kind) {
    case 'node':
      return line.objectiveTitles.length === 0
        ? `新建知识点「${line.name}」，但没挂任何目标`
        : `新建知识点「${line.name}」，支撑 ${line.objectiveTitles.join('、')}`;
    case 'patch':
      return `改写「${line.nodeName}」：${line.changes
        .map((change) => `${change.field} ${change.before ?? '空'} → ${change.after ?? '空'}`)
        .join('；')}`;
    case 'link':
      return `把「${line.nodeName}」也挂到目标「${line.objectiveTitle}」上`;
    case 'edge':
      return `${line.sourceLabel} → ${line.targetLabel}`;
    case 'drop':
      return line.text;
  }
}

/** 采纳一行还需要别人先做别的什么——给界面画依赖线用，没有就返回空。 */
export function knowledgeLineBlockedBy(
  line: KnowledgeDraftLine,
  lines: readonly KnowledgeDraftLine[],
  lineIdOf: (line: KnowledgeDraftLine, index: number) => string,
): string[] {
  if (line.kind !== 'edge') return [];
  const keys = [line.sourceKey, line.targetKey].filter((key) => key.startsWith('draft:'));
  return lines
    .map((other, index) => ({ other, id: lineIdOf(other, index) }))
    .filter(({ other }) => other.kind === 'node' && keys.includes(`draft:${other.draftIndex}`))
    .map(({ id }) => id);
}

/** 从 turn 结果里取草稿。`turn` 是 `resolveKnowledgeTurn` 的返回值（服务端形状）。 */
export interface KnowledgeTurnLike {
  message: string;
  warnings: string[];
  added: KnowledgeNodeDraft[];
  patches: Map<string, Omit<KnowledgeNodePatch, 'ref'>>;
  removed: Set<string>;
  links: {
    nodeId: string;
    objectiveId: string;
    supportLevel: CurriculumSupportLevel;
  }[];
  dependencies: ResolvedDependency[];
  removedDependencies: string[];
  unmatchedRefs: string[];
  rejectedRefs: string[];
}

/** 服务端行 → 前端行。名字查得到就用名字，查不到就用 id 前缀——绝不显示裸 id 当名字。 */
export function knowledgeDraftOf(input: {
  turn: KnowledgeTurnLike;
  instruction: string;
  nodeNameById: ReadonlyMap<string, string>;
  objectiveTitleById: ReadonlyMap<string, string>;
  /**
   * 动手前的连线集合，用来认出"这一轮其实什么都没改的连线"。
   *
   * 必填而不是可选：可选意味着调用方可以忘了传，然后界面把"重新挂一遍已有连线"当成
   * 一屏建议显示出来——这是最容易被当成"AI 建议很多"而实际全是噪音的一种呈现。
   */
  currentLinks: readonly {
    nodeId: string;
    objectiveId: string;
    supportLevel: CurriculumSupportLevel;
  }[];
}): KnowledgeDraft {
  const { turn, nodeNameById, objectiveTitleById } = input;
  const short = (id: string) => id.slice(0, 8);
  const lines: KnowledgeDraftLine[] = [];

  for (const [nodeId, patch] of turn.patches) {
    const changes: { field: string; before: string | null; after: string | null }[] = [];
    if (patch.name !== undefined) {
      changes.push({
        field: '名称',
        before: nodeNameById.get(nodeId) ?? null,
        after: patch.name,
      });
    }
    if (patch.summary !== undefined) {
      changes.push({ field: '摘要', before: null, after: patch.summary });
    }
    if (patch.difficulty !== undefined) {
      changes.push({ field: '难度', before: null, after: patch.difficulty });
    }
    if (patch.nodeType !== undefined) {
      changes.push({ field: '类型', before: null, after: patch.nodeType });
    }
    lines.push({
      kind: 'patch',
      nodeId,
      nodeName: nodeNameById.get(nodeId) ?? short(nodeId),
      changes,
      patch: {
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.difficulty !== undefined ? { difficulty: patch.difficulty } : {}),
        ...(patch.nodeType !== undefined ? { nodeType: patch.nodeType } : {}),
      },
    });
  }

  // `turn.links` 是**这一轮之后的整份集合**：没被提到的节点也被带了出来。把它们全画成
  // 行，作者会看到一屏"AI 建议把已有连线重新挂一遍"，而模型其实什么都没改。所以只把
  // 与动手前**有差**的那些画成行——支撑等级被改掉也算差。
  const beforeLevels = new Map(
    input.currentLinks.map((link) => [`${link.nodeId}/${link.objectiveId}`, link.supportLevel]),
  );
  for (const link of turn.links) {
    if (beforeLevels.get(`${link.nodeId}/${link.objectiveId}`) === link.supportLevel) continue;
    // 新节点的连线跟着那个节点走（`setCurriculumNodeObjectives` 是整表替换，没有"只写
    // 一条"这种粒度），所以走到这里的 nodeId 都是库里真实存在的 id。
    lines.push({
      kind: 'link',
      nodeId: link.nodeId,
      nodeName: nodeNameById.get(link.nodeId) ?? short(link.nodeId),
      objectiveId: link.objectiveId,
      objectiveTitle: objectiveTitleById.get(link.objectiveId) ?? short(link.objectiveId),
      supportLevel: link.supportLevel,
    });
  }

  turn.added.forEach((draft, draftIndex) => {
    const refs = draft.objectiveRefs.filter(
      (link): link is typeof link & { objectiveRef: string } => link.objectiveRef !== null,
    );
    lines.push({
      kind: 'node',
      draftIndex,
      name: draft.name,
      nodeType: draft.nodeType,
      summary: draft.summary,
      difficulty: draft.difficulty,
      objectiveRefs: refs.map((link) => ({
        objectiveId: link.objectiveRef,
        // 与 `mergeNodeLinks` / `setCurriculumNodeObjectives` 同一个缺省值：写成别的
        // 会让"没写等级"的连线在草稿里显示成一种、在库里落成另一种。
        supportLevel: link.supportLevel ?? 'primary',
      })),
      objectiveTitles: refs.map(
        (link) => objectiveTitleById.get(link.objectiveRef) ?? short(link.objectiveRef),
      ),
    });
  });

  const removedKeys = new Set<string>();
  for (const edge of turn.dependencies) {
    const key = (endpoint: ResolvedDependency['source']) =>
      endpoint.kind === 'node' ? `node:${endpoint.id}` : `draft:${endpoint.index}`;
    const sourceKey = key(edge.source);
    const targetKey = key(edge.target);
    const label = (endpoint: ResolvedDependency['source']) =>
      endpoint.kind === 'node'
        ? (nodeNameById.get(endpoint.id) ?? short(endpoint.id))
        : `新知识点「${turn.added[endpoint.index]?.name ?? short(`draft${endpoint.index}`)}」`;
    lines.push({
      kind: 'edge',
      sourceKey,
      sourceLabel: label(edge.source),
      targetKey,
      targetLabel: label(edge.target),
      edgeType: edge.edgeType,
      note: edge.note,
      removedEndpointKeys: [...removedKeys],
    });
  }

  const notes = [
    ...(turn.removed.size > 0 ? [`删除 ${turn.removed.size} 个已有知识点`] : []),
    ...turn.removedDependencies.map((id) => `撤回一条先后关系（${short(id)}）`),
    ...turn.unmatchedRefs.map((ref) => `没找到「${ref}」，这一条没写进去`),
    ...turn.rejectedRefs.map((ref) => `没照做：${ref}`),
  ].map((text) => ({ kind: 'drop' as const, text }));
  lines.push(...notes);

  return { lines, message: turn.message, warnings: turn.warnings, instruction: input.instruction };
}

/** 采纳一个草稿节点时，它要带上的连线必须**合进当前整份集合**，而不是替换。 */
export function mergedLinkSet(input: {
  current: { nodeId: string; objectiveId: string; supportLevel: CurriculumSupportLevel }[];
  line: Extract<KnowledgeDraftLine, { kind: 'node' }>;
  newNodeId: string;
}): { nodeId: string; objectiveId: string; supportLevel: CurriculumSupportLevel }[] {
  const kept = input.current.filter((link) => link.nodeId !== input.newNodeId);
  return [
    ...kept,
    ...input.line.objectiveRefs.map((link) => ({
      nodeId: input.newNodeId,
      objectiveId: link.objectiveId,
      supportLevel: link.supportLevel,
    })),
  ];
}
