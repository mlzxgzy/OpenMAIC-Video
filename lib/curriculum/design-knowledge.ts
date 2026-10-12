/**
 * 第三步「知识点与技能点拆解」的领域规则。
 *
 * 这一步的对象和前两步都不同：
 *
 * - 第一步是**七格固定的卡片**，第二步是一份**清单**，第三步是**一张图**：节点
 *   （知识点/技能点）加上"哪个节点支撑哪个目标"的连线。
 * - 清单的安全阀是 `ref` 指名，图的安全阀还是 `ref`，但多了一个方向：连线**指向
 *   目标**。所以模型不仅要指名要改哪个节点，还要指名每条连线指向哪个目标——两者
 *   都对不上就丢弃，绝不按位置猜。
 *
 * ## 三条与前两步不同的决定
 *
 * 1. **连线按节点合并，绝不整表替换。** store 的 `setCurriculumNodeObjectives` 是
 *    "删掉本任务全部连线再按传入的重建"，那是工作台"保存"用的语义。模型一轮只提
 *    到了它改的那几个节点，若照搬这个语义，**它没提到的节点的连线会被连带删掉**，
 *    而且用户看不出（图少了一条边不会变红，只会在进入大纲阶段时才炸）。所以
 *    {@link mergeNodeLinks} 按节点算意图：模型提到哪个节点，就只替换哪个节点的连线。
 *
 * 2. **节点缺连线接受，连线指向不存在的目标拒绝。** 孤儿节点是"图还没拆完"的可见
 *    状态——store 的 `phaseCompletionGaps('outline')` 本来就会报它，审核的
 *    `node_orphan` 也会报，拒绝写入反而把它藏起来了。而一条指向不存在目标的连线连
 *    存都存不进去（外键），模型写下它多半是把目标名写错了；丢弃并记账，用户至少
 *    看得到"这一条没接上"，而不是一个静默消失的引用。
 *
 * 3. **这一步不排章节，但排先后。** 用户明确要求"暂不强制安排章节"，所以
 *    {@link parseKnowledgeAnswer} **不接受任何章节/条目的字段**：模型即使擅自写了
 *    `chapters`、`units`，也会被整体忽略并在 `rejectedRefs` 里说明。少一个字段比
 *    多一个被静默忽略的字段安全。
 *
 * ## 第四步并进这一步：依赖与教学顺序
 *
 * 原计划的第四步「内容依赖分析与教学排序」没有自己的阶段，也不该有：它要写的就是
 * 这张图上的**有向边**，和节点、连线是同一张图、同一份签收。分成两张卡意味着改一条
 * 先后关系会把"知识点拆解"整张已签收的卡撤回——第三步刚花力气避免的正是这个。
 * 所以它在这里落成三件事：
 *
 * 1. **先后关系是边，不是排序位。** 模型提交 `dependencies`，每条是
 *    "source 必须在 target 之前"。**不写 `node.sortOrder`**：讲授顺序是这些边的一个
 *    函数，存下来就是第二份真相，改一条边就会漂移；大纲阶段真正排序的是
 *    `unit.orderIndex`。所以 {@link teachingOrder} 只是**推导出来给人看**。
 * 2. **边是独立行，所以只增删被指名的那些。** 与连线相反，这里没有"整表替换"的
 *    风险——添加是 upsert、删除按 dep id 指名。模型没提到的边一律不动。
 * 3. **会成环的边丢掉并说出来。** store 会拒绝成环（整轮回滚），所以规则层必须**先**
 *    按同一套边类型检查：成环、自指、指向不存在的节点，都记进缺口，让人看见。丢掉
 *    一条不存在的边在界面上没有任何痕迹——不像"节点没挂目标"会显示成待挂——所以
 *    这些必须由这一轮明确报出来。
 */
import {
  CURRICULUM_DEPENDENCY_EDGE_TYPES,
  CURRICULUM_DIRECTED_EDGE_TYPES,
  CURRICULUM_DIFFICULTIES,
  CURRICULUM_NODE_TYPES,
  CURRICULUM_ORDER_CLAIM_EDGE_TYPES,
  CURRICULUM_SUPPORT_LEVELS,
  type CurriculumDependencyEdgeType,
  type CurriculumDifficulty,
  type CurriculumNodeType,
  type CurriculumSupportLevel,
} from './design-types';

// ── 类型 ────────────────────────────────────────────────────────────────────

/** 节点类型的中文名：知识是"知道什么"，技能是"能做什么"。 */
export const NODE_TYPE_LABELS: Record<CurriculumNodeType, string> = {
  knowledge: '知识',
  skill: '技能',
};

/** 支撑强度的中文名。主要支撑会被教学设计点名，次要支撑可以只被引用。 */
export const SUPPORT_LEVEL_LABELS: Record<CurriculumSupportLevel, string> = {
  primary: '主要支撑',
  secondary: '次要支撑',
};

/** 难度中文名，缺省不显示。 */
export const DIFFICULTY_LABELS: Record<CurriculumDifficulty, string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
  advanced: '高级',
};

/** 这一步新增的一个节点，连同它自己声明要支撑的目标。 */
export interface KnowledgeNodeDraft {
  name: string;
  nodeType: CurriculumNodeType;
  summary: string | null;
  difficulty: CurriculumDifficulty | null;
  /** 模型用目标的 id 指名，解析后换成真实 id。 */
  objectiveRefs: KnowledgeLinkDraft[];
}

export interface KnowledgeLinkDraft {
  /** `null` means "this node supports nothing": the author took a link away. */
  objectiveRef: string | null;
  supportLevel?: CurriculumSupportLevel;
  note?: string | null;
}

export interface KnowledgeNodePatch {
  ref: string;
  name?: string;
  nodeType?: CurriculumNodeType;
  summary?: string | null;
  difficulty?: CurriculumDifficulty | null;
}

/**
 * One ordering claim: the source has to be learned before the target.
 *
 * Both ends are node refs, not objective ids. An outcome is a destination, not a
 * lesson — "目标 2 在目标 1 之后" is a statement about the plan, which is what
 * the outline stage orders with `orderIndex`. What this step orders is the
 * knowledge and skill the lessons are built from, and those are the nodes.
 */
export interface KnowledgeDependencyDraft {
  sourceRef: string;
  targetRef: string;
  edgeType: CurriculumDependencyEdgeType;
  note?: string | null;
}

/** An edge as it is already stored, in the form the merge reasons about. */
export interface KnowledgeDependencyRef {
  id: string;
  sourceId: string;
  targetId: string;
  edgeType: CurriculumDependencyEdgeType;
}

export interface KnowledgeAnswer {
  message: string;
  added: KnowledgeNodeDraft[];
  updated: KnowledgeNodePatch[];
  removed: string[];
  /** 要替换的连线，按节点指名。`objectiveRef: null` 表示清空这个节点的支撑。 */
  links: {
    ref: string;
    objectiveRef: string | null;
    supportLevel?: CurriculumSupportLevel;
    note?: string | null;
  }[];
  /** 要新增或改写的先后关系。只增删这里出现的边，其余边不动。 */
  dependencies: KnowledgeDependencyDraft[];
  /** 要删除的边，按依赖 id 指名（id printed in the graph listing）。 */
  removedDependencies: string[];
  confirmRequested: boolean;
  rejectedRefs: string[];
}

/** 节点在图里的引用形式，就是模型能指名道姓用的 `ref`。 */
export interface KnowledgeNodeRef {
  id: string;
  name: string;
  nodeType: CurriculumNodeType;
}

export interface KnowledgeRef {
  id: string;
  title: string;
}

// ── 模型输出 ────────────────────────────────────────────────────────────────

export class KnowledgeAnswerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KnowledgeAnswerError';
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

/**
 * 节点类型：缺省 `knowledge`。
 *
 * 缺省偏"知识"而不是"技能"，因为这是**更弱的承诺**：一个被标成知识点的节点最多被
 * 讲得不够深，而一个被标成技能的节点会在审核里被要求"被练过、被考过"，标错的代价
 * 在后面更大。
 */
function nodeTypeOf(value: unknown): CurriculumNodeType {
  return oneOf(value, CURRICULUM_NODE_TYPES) ?? 'knowledge';
}

/**
 * 清洗模型给的一条连线。
 *
 * `objectiveRef` 缺席是**有意义的**：它表示"这个节点不支撑任何目标"。没有它，一个
 * 已经挂了两条线、模型认为该全部撤掉的节点根本无法表达——而那正是"把一条挂错的
 * 支撑线摘掉"最自然的写法。
 *
 * 有引用时目标引用是必须的；强度和备注有值就必须合法（不合法则丢弃这条线，不猜）。
 */
function sanitizeLink(raw: unknown): { link: KnowledgeLinkDraft | null; reason?: string } {
  if (!isRecord(raw)) return { link: null, reason: '连线不是一个对象' };
  const objectiveRef = textOf(raw.objectiveRef);
  if (objectiveRef === undefined) {
    // Neither a goal nor an explicit clear: not a link at all.
    if (raw.objectiveRef === undefined) return { link: null, reason: '连线缺少目标引用' };
    return { link: null, reason: '连线缺少目标引用' };
  }
  const supportLevel = oneOf(raw.supportLevel, CURRICULUM_SUPPORT_LEVELS);
  const note = textOf(raw.note);
  if (raw.supportLevel !== undefined && raw.supportLevel !== null && supportLevel === undefined) {
    return { link: null, reason: `连线「${objectiveRef}」的支撑强度不是 primary/secondary` };
  }
  if (raw.note !== undefined && note === undefined) {
    return { link: null, reason: `连线「${objectiveRef}」的备注不是文本` };
  }
  if (objectiveRef === null) {
    // An explicit clear: no goal named, so the strength and note are meaningless.
    return { link: { objectiveRef: null } };
  }
  return {
    link: {
      objectiveRef,
      supportLevel,
      ...(note === undefined ? {} : { note }),
    },
  };
}

/**
 * 清洗模型给的一条先后关系。
 *
 * 两端都是必填的节点 ref，`edgeType` 也必填：缺省一个边类型等于替作者做了一个
 * 关于"这是什么关系"的决定，而 `prerequisite` 与 `practices` 在教学上不是一回事。
 * 自指在这一层就丢掉，不留给 store——store 会抛错并回滚整轮，一个笔误不该带走这一轮
 * 的其他改动。
 */
export function sanitizeDependency(raw: unknown): {
  dependency: KnowledgeDependencyDraft | null;
  reason?: string;
} {
  if (!isRecord(raw)) return { dependency: null, reason: '依赖不是一个对象' };
  const sourceRef = textOf(raw.sourceRef);
  const targetRef = textOf(raw.targetRef);
  if (!sourceRef) return { dependency: null, reason: '依赖缺少 sourceRef' };
  if (!targetRef) return { dependency: null, reason: '依赖缺少 targetRef' };
  const edgeType = oneOf(raw.edgeType, CURRICULUM_DEPENDENCY_EDGE_TYPES);
  if (!edgeType) {
    return {
      dependency: null,
      reason: `依赖 ${sourceRef}→${targetRef} 的 edgeType 不是允许的关系类型`,
    };
  }
  const note = textOf(raw.note);
  if (raw.note !== undefined && note === undefined) {
    return { dependency: null, reason: `依赖 ${sourceRef}→${targetRef} 的备注不是文本` };
  }
  if (sourceRef === targetRef) {
    return { dependency: null, reason: `依赖 ${sourceRef}→${targetRef} 指向自身` };
  }
  return {
    dependency: { sourceRef, targetRef, edgeType, ...(note === undefined ? {} : { note }) },
  };
}

/**
 * 清洗一个新节点。
 *
 * 拒绝条件只有一条：**没有名字**。摘要、难度、连线都可以缺——摘要是"一句话说明它
 * 是什么"，模型这一轮没想到可以由作者补；连线缺了会变成一条孤儿节点，正是上面第 2
 * 条说的可见状态。
 */
export function sanitizeNodeDraft(raw: unknown): {
  draft: KnowledgeNodeDraft | null;
  reason?: string;
  linkRejections?: string[];
} {
  if (!isRecord(raw)) return { draft: null, reason: '节点不是一个对象' };
  const name = textOf(raw.name);
  if (!name) return { draft: null, reason: '节点缺少名称' };
  if (
    raw.nodeType !== undefined &&
    raw.nodeType !== null &&
    !oneOf(raw.nodeType, CURRICULUM_NODE_TYPES)
  ) {
    return { draft: null, reason: `节点「${name}」的类型不是 knowledge/skill` };
  }
  const difficulty = oneOf(raw.difficulty, CURRICULUM_DIFFICULTIES);
  if (raw.difficulty !== undefined && raw.difficulty !== null && difficulty === undefined) {
    return { draft: null, reason: `节点「${name}」的难度不在允许取值内` };
  }
  const summary = textOf(raw.summary);
  if (raw.summary !== undefined && summary === undefined) {
    return { draft: null, reason: `节点「${name}」的摘要不是文本` };
  }
  // A bad link drops the link, not the node — the same asymmetry step 2 applies
  // to evidence: the node is real content the author asked for, and a node with
  // no link is the *visible* "graph not finished yet" state (store's orphan
  // check and `node_orphan` both report it). Rejecting the node would hide it.
  const objectiveRefs: KnowledgeLinkDraft[] = [];
  const linkRejections: string[] = [];
  for (const entry of Array.isArray(raw.objectiveRefs) ? raw.objectiveRefs : []) {
    const { link, reason } = sanitizeLink(entry);
    if (link) objectiveRefs.push(link);
    else linkRejections.push(`节点「${name}」的${reason ?? '连线无效'}`);
  }
  return {
    draft: {
      name,
      nodeType: nodeTypeOf(raw.nodeType),
      summary: summary ?? null,
      difficulty: difficulty ?? null,
      objectiveRefs,
    },
    linkRejections,
  };
}

/**
 * 清洗"要改的节点"。必须带 `ref`，理由同第二步：图上的静默改动最难发现。
 *
 * 一个什么都没改的 patch 会被丢弃，而不是记成一次改动——否则撤回签收的判断会把
 * 它算成"这一轮动过图"。
 */
export function sanitizeNodePatch(raw: unknown): {
  patch: KnowledgeNodePatch | null;
  reason?: string;
} {
  if (!isRecord(raw)) return { patch: null, reason: '要改的节点不是一个对象' };
  const ref = textOf(raw.ref);
  if (!ref) return { patch: null, reason: '要改的节点缺少 ref' };
  const patch: KnowledgeNodePatch = { ref };
  if ('name' in raw) {
    const name = textOf(raw.name);
    if (!name) return { patch: null, reason: `节点 ${ref} 的新名称为空` };
    patch.name = name;
  }
  if ('nodeType' in raw) {
    const nodeType = oneOf(raw.nodeType, CURRICULUM_NODE_TYPES);
    if (!nodeType) return { patch: null, reason: `节点 ${ref} 的类型不是 knowledge/skill` };
    patch.nodeType = nodeType;
  }
  if ('summary' in raw) {
    const summary = textOf(raw.summary);
    if (summary === undefined) return { patch: null, reason: `节点 ${ref} 的摘要不是文本` };
    patch.summary = summary;
  }
  if ('difficulty' in raw) {
    if (raw.difficulty === null) patch.difficulty = null;
    else {
      const difficulty = oneOf(raw.difficulty, CURRICULUM_DIFFICULTIES);
      if (!difficulty) return { patch: null, reason: `节点 ${ref} 的难度不在允许取值内` };
      patch.difficulty = difficulty;
    }
  }
  const fields = ['name', 'nodeType', 'summary', 'difficulty'] as const;
  if (!fields.some((field) => patch[field] !== undefined)) {
    return { patch: null, reason: `节点 ${ref} 的改动是空的` };
  }
  return { patch };
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/** 这一步明确不接的字段：章节与条目。写在这里而不是提示词里，是为了能被测试。 */
const OUT_OF_SCOPE_KEYS = ['chapters', 'units', 'chapter', 'unit', 'outline', 'lessons'] as const;

/**
 * 模型回答的 JSON 形状：
 * `{ message, added, updated, removed, links, confirm }`。
 */
export function parseKnowledgeAnswer(text: string): KnowledgeAnswer {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) throw new KnowledgeAnswerError('模型没有返回 JSON 对象');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new KnowledgeAnswerError('模型返回的 JSON 无法解析');
  }
  if (!isRecord(parsed)) throw new KnowledgeAnswerError('模型返回的不是一个 JSON 对象');

  const rejectedRefs: string[] = [];
  for (const key of OUT_OF_SCOPE_KEYS) {
    if (key in parsed) {
      rejectedRefs.push(
        `「${key}」不在这一步的范围内，已忽略：章与条目是后面的步骤；` +
          '先后关系请写成 dependencies',
      );
    }
  }

  const added: KnowledgeNodeDraft[] = [];
  for (const entry of asArray(parsed.added)) {
    const { draft, reason, linkRejections } = sanitizeNodeDraft(entry);
    if (draft) {
      added.push(draft);
      rejectedRefs.push(...(linkRejections ?? []));
    } else if (reason) rejectedRefs.push(reason);
  }

  const updated: KnowledgeNodePatch[] = [];
  for (const entry of asArray(parsed.updated)) {
    const { patch, reason } = sanitizeNodePatch(entry);
    if (patch) updated.push(patch);
    else if (reason) rejectedRefs.push(reason);
  }

  const removed: string[] = [];
  for (const entry of asArray(parsed.removed)) {
    const ref = typeof entry === 'string' ? textOf(entry) : null;
    if (ref) removed.push(ref);
    else rejectedRefs.push('删除条目缺少 ref');
  }

  const links: KnowledgeAnswer['links'] = [];
  for (const entry of asArray(parsed.links)) {
    if (!isRecord(entry)) {
      rejectedRefs.push('连线不是一个对象');
      continue;
    }
    const ref = textOf(entry.ref);
    if (!ref) {
      rejectedRefs.push('连线缺少它所属节点的 ref');
      continue;
    }
    const { link, reason } = sanitizeLink(entry);
    if (link) {
      links.push({
        ref,
        objectiveRef: link.objectiveRef,
        supportLevel: link.supportLevel,
        note: link.note,
      });
    } else {
      rejectedRefs.push(`节点 ${ref} 的${reason ?? '连线无效'}`);
    }
  }

  const dependencies: KnowledgeDependencyDraft[] = [];
  for (const entry of asArray(parsed.dependencies)) {
    const { dependency, reason } = sanitizeDependency(entry);
    if (dependency) dependencies.push(dependency);
    else if (reason) rejectedRefs.push(reason);
  }

  const removedDependencies: string[] = [];
  for (const entry of asArray(parsed.removedDependencies)) {
    const ref = typeof entry === 'string' ? textOf(entry) : null;
    if (ref) removedDependencies.push(ref);
    else rejectedRefs.push('要删除的依赖缺少 dep id');
  }

  return {
    message: typeof parsed.message === 'string' ? parsed.message.trim() : '',
    added,
    updated,
    removed,
    links,
    dependencies,
    removedDependencies,
    confirmRequested: parsed.confirm === true,
    rejectedRefs,
  };
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

// ── 写入 ────────────────────────────────────────────────────────────────────

/**
 * 把一轮对话应用到图上，返回**每个节点 id 的最终意图**。
 *
 * 规则与第二步同源，只是多了一个方向：
 *
 * 1. **删除优先。** 先删再改连线，否则"删掉的节点"又会被连线写回去。
 * 2. **同一条只认最后一次 patch。** 模型一次回答里给同一节点两版改法时，后者是它
 *    真正的想法。
 * 3. **未命中的 ref 一律丢弃并记账。** 不猜、不按位置套用。
 * 4. **连线按节点合并。** {@link mergeNodeLinks} 返回"这些节点要重写成什么样"，其余
 *    节点的连线原封不动——这是本步最重要的一条，见文件头第 1 条。
 */
export function mergeKnowledgePatch(
  current: readonly KnowledgeNodeRef[],
  answer: Pick<KnowledgeAnswer, 'updated' | 'removed'>,
): { patches: Map<string, KnowledgeNodePatch>; removed: Set<string>; unmatchedRefs: string[] } {
  const byId = new Map(current.map((entry) => [entry.id, entry]));
  const removed = new Set<string>();
  const unmatchedRefs: string[] = [];

  for (const ref of answer.removed) {
    if (byId.has(ref)) removed.add(ref);
    else unmatchedRefs.push(ref);
  }

  const patches = new Map<string, KnowledgeNodePatch>();
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

/**
 * 这一轮之后，哪些节点的连线要**整份替换**。
 *
 * 返回的 map 里，一条都没有出现的节点连线保持原样——这正是"整表替换会把用户读过
 * 的图悄悄删空"的解药。指向不存在目标的连线在这一步丢弃并记账（见
 * {@link resolveKnowledgeTurn}），所以进到这里的目标 id 都是真实存在的。
 */
export function mergeNodeLinks(input: {
  linksByNode: ReadonlyMap<
    string,
    readonly { objectiveId: string; supportLevel: CurriculumSupportLevel }[]
  >;
  knownNodeIds: ReadonlySet<string>;
  knownObjectiveIds: ReadonlySet<string>;
  /** 这一轮要删除的节点。 */
  removed: ReadonlySet<string>;
  /** 模型这一轮给的连线，按它给出的顺序。 */
  proposed: readonly KnowledgeAnswer['links'][number][];
}): {
  /** 节点 id → 替换后的连线（去重，顺序即模型给的顺序）。 */
  replace: Map<
    string,
    { objectiveId: string; supportLevel: CurriculumSupportLevel; note: string | null }[]
  >;
  unmatchedRefs: string[];
} {
  const replace = new Map<
    string,
    { objectiveId: string; supportLevel: CurriculumSupportLevel; note: string | null }[]
  >();
  const unmatchedRefs: string[] = [];

  for (const entry of input.proposed) {
    if (!input.knownNodeIds.has(entry.ref)) {
      unmatchedRefs.push(entry.ref);
      continue;
    }
    if (input.removed.has(entry.ref)) {
      // Deleting wins for links too: re-linking a row the same turn deletes
      // would either insert against a row about to disappear or fail the
      // foreign key.
      continue;
    }
    if (entry.objectiveRef === null) {
      // An explicit "this node supports nothing". It still replaces, because the
      // whole point is emptying a node that had links: a no-op here would leave
      // the author unable to take a wrong link back off.
      if (!replace.has(entry.ref)) replace.set(entry.ref, []);
      continue;
    }
    if (!input.knownObjectiveIds.has(entry.objectiveRef)) {
      unmatchedRefs.push(`${entry.ref}→${entry.objectiveRef}`);
      continue;
    }
    const list = replace.get(entry.ref) ?? [];
    // Same pair twice is one link: the store's natural key is (node, objective),
    // and two rows for it means the second insert is a constraint violation.
    if (list.some((row) => row.objectiveId === entry.objectiveRef)) continue;
    list.push({
      objectiveId: entry.objectiveRef,
      // Default to `primary`: a node that supports an outcome is normally the
      // reason that outcome is reachable, and a `secondary` default would make
      // the audit's "invisible support" rule fire on correct designs.
      supportLevel: entry.supportLevel ?? 'primary',
      note: entry.note ?? null,
    });
    replace.set(entry.ref, list);
  }

  return { replace, unmatchedRefs };
}

// ── 先后关系 ────────────────────────────────────────────────────────────────

/**
 * One end of an ordering claim.
 *
 * A node added in the same turn has no id yet — the model is writing the row and
 * the edge in one JSON object — so it is addressed by its **name** and resolved
 * to the draft it names. `draft` endpoints are turned into real node ids by the
 * route once the rows exist.
 */
export type DependencyEndpoint = { kind: 'node'; id: string } | { kind: 'draft'; index: number };

/** One edge to write, with both endpoints resolved. */
export interface ResolvedDependency {
  source: DependencyEndpoint;
  target: DependencyEndpoint;
  edgeType: CurriculumDependencyEdgeType;
  note: string | null;
}

/** The key both ends are compared by while the cycle check runs. */
function endpointKey(endpoint: DependencyEndpoint): string {
  return endpoint.kind === 'node' ? `node:${endpoint.id}` : `draft:${endpoint.index}`;
}

/**
 * 这一轮之后要新增/改写的先后关系，与要删除的边。
 *
 * 与 {@link mergeNodeLinks} 的形状不同，是因为存储的形状不同：连线是"一个节点的
 * 整份集合"（`setCurriculumNodeObjectives` 全表替换），而依赖是**独立行**（添加是
 * upsert、删除按 id）。所以这里没有"替换"，只有"这一轮被指名的边"——没提到的边不会
 * 因为没被提到而消失。
 *
 * 成环在这一层就挡掉，理由和自指一样：store 的成环检查会抛错并回滚**整轮**，一个
 * 写错的先修关系不该带走同一轮里几十个节点。挡下来的边写进 {@link droppedEdges}，
 * 由调用方变成可见的缺口——一条没写进去的边在界面上没有任何痕迹，不像"节点没挂目标"
 * 会显示成待挂状态，所以必须由这一轮说出来。
 */
export function mergeNodeDependencies(input: {
  knownNodeIds: ReadonlySet<string>;
  /** 这一轮新增的节点，按 `added` 的顺序。先后关系只能用名字引用它们。 */
  drafts: readonly { name: string }[];
  removed: ReadonlySet<string>;
  existing: readonly KnowledgeDependencyRef[];
  removedDependencyIds: readonly string[];
  proposed: readonly KnowledgeDependencyDraft[];
}): {
  create: ResolvedDependency[];
  remove: string[];
  /** 模型指名了但图里没有的 dep id。 */
  unmatchedRefs: string[];
  /** 丢掉一条边的原因，人话，直接进缺口列表。 */
  droppedEdges: string[];
} {
  const unmatchedRefs: string[] = [];
  const droppedEdges: string[] = [];

  // Drafts are addressed by name; an ambiguous name is refused rather than
  // guessed, because picking one of two identical names is how an edge lands on
  // the wrong node and nothing in the UI shows it.
  const draftIndexes = new Map<string, number[]>();
  input.drafts.forEach((draft, index) => {
    const key = normaliseName(draft.name);
    const list = draftIndexes.get(key) ?? [];
    list.push(index);
    draftIndexes.set(key, list);
  });

  const resolve = (ref: string): { endpoint: DependencyEndpoint } | { reason: string } => {
    if (input.knownNodeIds.has(ref)) {
      if (input.removed.has(ref)) return { reason: `节点 ${ref} 在这一轮被删除` };
      return { endpoint: { kind: 'node', id: ref } };
    }
    const candidates = draftIndexes.get(normaliseName(ref)) ?? [];
    if (candidates.length === 1) {
      const index = candidates[0];
      if (index === undefined) return { reason: `找不到节点 ${ref}` };
      return { endpoint: { kind: 'draft', index } };
    }
    if (candidates.length > 1) {
      return { reason: `「${ref}」对上这一轮新增的多个同名节点，分不清是哪一个` };
    }
    return { reason: `找不到节点 ${ref}` };
  };

  const byId = new Map(input.existing.map((edge) => [edge.id, edge]));
  const remove: string[] = [];
  // The natural keys being taken away. A turn that names an edge for removal and
  // also re-proposes it must net out to *removed*: the deletion is the explicit
  // statement, and the route deletes before it inserts, so honouring the
  // re-proposal would quietly cancel the deletion the author asked for.
  const removedKeys = new Set<string>();
  for (const id of input.removedDependencyIds) {
    const edge = byId.get(id);
    if (!edge) {
      unmatchedRefs.push(id);
      continue;
    }
    if (!remove.includes(id)) remove.push(id);
    removedKeys.add(`${edge.sourceId}:${edge.targetId}:${edge.edgeType}`);
  }
  const removing = new Set(remove);

  // The graph the proposals are checked against: every stored edge that survives
  // this turn's deletions. `composes` is not an order claim, so it cannot make a
  // cycle; the set is the same one the store keeps acyclic, because a pre-check
  // against a narrower list would let the store roll the turn back.
  const outgoing = new Map<string, Set<string>>();
  const addEdge = (source: string, target: string, edgeType: CurriculumDependencyEdgeType) => {
    if (!isDirectedEdgeType(edgeType)) return;
    const list = outgoing.get(source) ?? new Set<string>();
    list.add(target);
    outgoing.set(source, list);
  };
  for (const edge of input.existing) {
    if (removing.has(edge.id)) continue;
    addEdge(`node:${edge.sourceId}`, `node:${edge.targetId}`, edge.edgeType);
  }

  const create: ResolvedDependency[] = [];
  const seen = new Set<string>();
  for (const entry of input.proposed) {
    const { sourceRef, targetRef, edgeType } = entry;
    const source = resolve(sourceRef);
    if ('reason' in source) {
      unmatchedRefs.push(sourceRef);
      droppedEdges.push(`先后关系「${sourceRef} → ${targetRef}」没有写入：${source.reason}`);
      continue;
    }
    const target = resolve(targetRef);
    if ('reason' in target) {
      unmatchedRefs.push(targetRef);
      droppedEdges.push(`先后关系「${sourceRef} → ${targetRef}」没有写入：${target.reason}`);
      continue;
    }
    const sourceKey = endpointKey(source.endpoint);
    const targetKey = endpointKey(target.endpoint);
    // Same natural key twice is one edge: the store's unique index is
    // (source, target, type), so the second insert is a conflict, not a fact.
    const key = `${sourceKey}:${targetKey}:${edgeType}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (
      source.endpoint.kind === 'node' &&
      target.endpoint.kind === 'node' &&
      removedKeys.has(`${source.endpoint.id}:${target.endpoint.id}:${edgeType}`)
    ) {
      continue;
    }
    if (sourceKey === targetKey) {
      droppedEdges.push(`先后关系「${sourceRef} → ${targetRef}」指向自身，没有写入`);
      continue;
    }
    if (wouldCloseCycle(outgoing, sourceKey, targetKey)) {
      droppedEdges.push(
        `先后关系「${sourceRef} → ${targetRef}」会形成环（${edgeType}）：这一条没有写入，` +
          '先去掉环里的某一条，或者改掉方向',
      );
      continue;
    }
    create.push({
      source: source.endpoint,
      target: target.endpoint,
      edgeType,
      note: entry.note ?? null,
    });
    addEdge(sourceKey, targetKey, edgeType);
  }

  return { create, remove, unmatchedRefs, droppedEdges };
}

/** Is `from` already reachable from `to`? Then `from → to` closes a loop. */
function wouldCloseCycle(
  outgoing: ReadonlyMap<string, ReadonlySet<string>>,
  sourceId: string,
  targetId: string,
): boolean {
  const stack = [targetId];
  const seen = new Set<string>([targetId]);
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    if (current === sourceId) return true;
    for (const next of outgoing.get(current) ?? []) {
      if (seen.has(next)) continue;
      seen.add(next);
      stack.push(next);
    }
  }
  return false;
}

/**
 * 由先后关系推导出的讲授顺序。
 *
 * **这是推导，不是存储。** `node.sortOrder` 仍是节点在列表里的显示顺序，讲授顺序是
 * 这些边的一个函数：存下来就会在改一条边时漂移，而大纲阶段真正排的是
 * `unit.orderIndex`。所以这一步把它算出来给人看，不写回去。
 *
 * 只有 {@link CURRICULUM_ORDER_CLAIM_EDGE_TYPES} 里的边构成顺序：`supports` 说明两个
 * 节点互相依赖，不说明谁先讲。顺序本身稳定——同一层里保持节点现有的显示顺序，所以
 * 模型没提的节点不会莫名其妙换位置。
 */
export function teachingOrder(input: {
  nodes: readonly KnowledgeNodeRef[];
  dependencies: readonly KnowledgeDependencyRef[];
  /** 这两点之间用哪种关系算顺序。默认取"顺序声明"那一组。 */
  edgeTypes?: readonly CurriculumDependencyEdgeType[];
}): {
  /** 可以定序的节点，按讲授先后。 */
  order: KnowledgeNodeRef[];
  /** 剩下的节点：它们的先后关系成环，或者根本没参与任何关系。 */
  unresolved: KnowledgeNodeRef[];
} {
  const edgeTypes = input.edgeTypes ?? CURRICULUM_ORDER_CLAIM_EDGE_TYPES;
  const allowed = new Set<CurriculumDependencyEdgeType>(edgeTypes);
  const indexOf = new Map(input.nodes.map((node, index) => [node.id, index]));
  const indegree = new Map<string, number>(input.nodes.map((node) => [node.id, 0]));
  const outgoing = new Map<string, string[]>();

  for (const edge of input.dependencies) {
    if (!allowed.has(edge.edgeType)) continue;
    if (!indexOf.has(edge.sourceId) || !indexOf.has(edge.targetId)) continue;
    if (edge.sourceId === edge.targetId) continue;
    const list = outgoing.get(edge.sourceId) ?? [];
    list.push(edge.targetId);
    outgoing.set(edge.sourceId, list);
    indegree.set(edge.targetId, (indegree.get(edge.targetId) ?? 0) + 1);
  }

  const byIndex = (left: string, right: string) =>
    (indexOf.get(left) ?? 0) - (indexOf.get(right) ?? 0);
  const ready = input.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
    .sort(byIndex);
  const orderedIds: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (current === undefined) break;
    orderedIds.push(current);
    for (const next of outgoing.get(current) ?? []) {
      const left = (indegree.get(next) ?? 1) - 1;
      indegree.set(next, left);
      if (left === 0) {
        ready.push(next);
        ready.sort(byIndex);
      }
    }
  }

  const byId = new Map(input.nodes.map((node) => [node.id, node]));
  const order = orderedIds.flatMap((id) => {
    const node = byId.get(id);
    return node ? [node] : [];
  });
  const ordered = new Set(orderedIds);
  const unresolved = input.nodes.filter((node) => !ordered.has(node.id));
  return { order, unresolved };
}

/**
 * 这一步该显示给人看的发现：**不是缺口，不拦签收**。
 *
 * 两件事机器判得了：两个节点同名（同一件事被拆了两遍），以及哪些节点还没进任何
 * 先后关系。都只报不改——"合并两个节点"要的是语义判断，而**重复内容的语义判定留给
 * 覆盖分析那一步**：那时课程全文已经在了，模型判断"这两处真的重复"有依据，而在这里
 * 只有名字可比。
 */
export function knowledgeFindings(
  nodes: readonly KnowledgeNodeRef[],
  dependencies: readonly KnowledgeDependencyRef[],
): KnowledgeGap[] {
  const findings: KnowledgeGap[] = [];

  const byNormalisedName = new Map<string, KnowledgeNodeRef[]>();
  for (const node of nodes) {
    const key = normaliseName(node.name);
    const list = byNormalisedName.get(key) ?? [];
    list.push(node);
    byNormalisedName.set(key, list);
  }
  for (const list of byNormalisedName.values()) {
    if (list.length < 2) continue;
    findings.push({
      ref: list[0]?.id,
      text: `「${list.map((node) => node.name).join('」「')}」同名：确认是不是同一件事被拆了两遍`,
    });
  }

  const ordered = new Set<string>();
  for (const edge of dependencies) {
    if (!isOrderClaimEdgeType(edge.edgeType)) continue;
    ordered.add(edge.sourceId);
    ordered.add(edge.targetId);
  }
  if (ordered.size === 0) {
    if (nodes.length > 1) {
      findings.push({ text: '还没有任何先后关系：现在只能看出讲什么，看不出先讲什么' });
    }
    return findings;
  }
  const unsequenced = nodes.filter((node) => !ordered.has(node.id));
  if (unsequenced.length > 0) {
    findings.push({
      ref: unsequenced[0]?.id,
      text:
        `${unsequenced.map((node) => node.name).join('、')} 还没有参与任何先后关系：` +
        '它们的讲授位置未定',
    });
  }
  return findings;
}

/** 同名判定用：忽略大小写、空白与全角/半角差异，只看是不是同一个写法。 */
function normaliseName(name: string): string {
  return name.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

/**
 * Membership over the shared edge-type sets, typed for the whole union.
 *
 * The sets are `as const` tuples — that is what keeps the store and this layer
 * from drifting — which makes `.includes` demand the narrower literal union.
 * Widening here keeps the call sites readable and the tuple the single source of
 * truth.
 */
function isDirectedEdgeType(edgeType: CurriculumDependencyEdgeType): boolean {
  return (CURRICULUM_DIRECTED_EDGE_TYPES as readonly CurriculumDependencyEdgeType[]).includes(
    edgeType,
  );
}

function isOrderClaimEdgeType(edgeType: CurriculumDependencyEdgeType): boolean {
  return (CURRICULUM_ORDER_CLAIM_EDGE_TYPES as readonly CurriculumDependencyEdgeType[]).includes(
    edgeType,
  );
}

// ── 缺口 ────────────────────────────────────────────────────────────────────

export interface KnowledgeGap {
  /** 节点 id；整体性缺口（一张图都没有）没有。 */
  ref?: string;
  text: string;
}

/**
 * 这张图还差什么。
 *
 * 与 store 的 `phaseCompletionGaps('outline')` 是同一套判定的可执行说法：那个函数
 * 报"没有连线支撑任何目标的节点"，这里报出**每一个**这样的节点并说清楚要做什么。
 *
 * 第二个缺口是这一步特有的，也是 store 那边没有的：**每个学习目标都要有主要支撑的
 * 节点**。只有"节点都要有目标"这一半是不对称的——一张全是孤儿目标、没有知识点的图
 * 能通过 store 的检查，然后在大纲阶段变成"讲什么都不知道"。目标没有支撑节点，同样
 * 是"图还没拆完"，所以在这里就报出来。
 */
export function knowledgeGaps(
  nodes: readonly KnowledgeNodeRef[],
  unlinked: readonly { id: string; name: string }[] = [],
  unsupported: readonly { id: string; title: string }[] = [],
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];
  if (nodes.length === 0) {
    gaps.push({
      text: '还没有知识/技能点：从已确认的学习目标反推，每条目标要靠哪几块知识或技能才能做到',
    });
    return gaps;
  }
  for (const node of unlinked) {
    gaps.push({
      ref: node.id,
      text: `「${node.name}」没有支撑任何学习目标：它不会被讲授，也不会被考核`,
    });
  }
  for (const objective of unsupported) {
    gaps.push({
      ref: objective.id,
      text: `学习目标「${objective.title}」还没有任何知识/技能点支撑它：接下来不知道讲什么`,
    });
  }
  return gaps;
}

/**
 * {@link knowledgeGaps} over records, for the surfaces that hold records: the
 * state payload both routes answer with, and the workbench strip, which must not
 * disagree with them.
 */
export function knowledgeGapsOfRecords(
  nodes: readonly KnowledgeNodeRef[],
  links: readonly { nodeId: string; objectiveId: string }[],
  objectives: readonly KnowledgeRef[],
): KnowledgeGap[] {
  const linkedNodeIds = new Set(links.map((row) => row.nodeId));
  const supportedObjectiveIds = new Set(links.map((row) => row.objectiveId));
  return knowledgeGaps(
    nodes,
    nodes.filter((row) => !linkedNodeIds.has(row.id)),
    objectives.filter((row) => !supportedObjectiveIds.has(row.id)),
  );
}

/**
 * 是否采纳模型声明的"用户已确认"，前两条底线同前两步，第三条同第二步：
 * **这一轮必须真的动过图**。
 *
 * 另加一条这一步特有的：**没有任何缺口才能确认**。前两步是"清单条目都齐了才签收"，
 * 这里多了一层——图必须**两头都有连线**（节点有目标、目标有节点），否则第四步
 * 排章节时拿到的是一张单边的图。
 */
export function shouldConfirmKnowledge(input: {
  confirmRequested: boolean;
  userTurns: number;
  nodeCount: number;
  objectiveCount: number;
  gaps: readonly KnowledgeGap[];
  changedAnything: boolean;
}): boolean {
  if (!input.confirmRequested) return false;
  if (input.userTurns < 2) return false;
  if (!input.changedAnything) return false;
  if (input.gaps.length > 0) return false;
  return input.nodeCount > 0 && input.objectiveCount > 0;
}

// ── 渲染 ────────────────────────────────────────────────────────────────────

/**
 * 这张图的纯文本形式，供提示词与 agent 工具共用。
 *
 * 给模型的每条连线两端都用 id：目标 id 是模型唯一的指路方式（目标没有别的短柄），
 * 节点 id 是 `ref`。一条都不给模型的行是"这张图接下来会重算"，所以顺序跟着
 * `sortOrder`。
 *
 * 先后关系**逐条带 dep id 打印**，因为它们删不掉：模型只能按 id 指名要删的边，而它
 * 看不到 id 就只能提出一条没人能执行的删除。
 */
export function formatKnowledgeList(input: {
  nodes: readonly KnowledgeNodeRef[];
  objectives: readonly KnowledgeRef[];
  linksByNode: ReadonlyMap<string, readonly { objectiveId: string }[]>;
  dependencies?: readonly KnowledgeDependencyRef[];
  /** 已有的先后关系推导出的顺序，给模型一个可反驳的默认值。 */
  teachingOrderIds?: readonly string[];
}): string {
  const nameOf = new Map(input.nodes.map((node) => [node.id, node.name]));
  const lines = input.nodes.map((node) => {
    const links = input.linksByNode.get(node.id) ?? [];
    const linkText = links.length
      ? links
          .map((row) => {
            const objective = input.objectives.find((entry) => entry.id === row.objectiveId);
            return objective ? `${row.objectiveId}(${objective.title})` : row.objectiveId;
          })
          .join('、')
      : '无（这是缺口：给它挂上目标）';
    return [
      `ref=${node.id}  [${NODE_TYPE_LABELS[node.nodeType]}] ${node.name}`,
      `    支撑：${linkText}`,
    ].join('\n');
  });
  const objectiveLines = input.objectives.map(
    (objective) => `obj=${objective.id}  ${objective.title}`,
  );

  const dependencies = input.dependencies ?? [];
  const dependencyLines = dependencies.map((edge) => {
    const source = nameOf.get(edge.sourceId) ?? edge.sourceId;
    const target = nameOf.get(edge.targetId) ?? edge.targetId;
    return `dep=${edge.id}  ${edge.sourceId}(${source}) -[${edge.edgeType}]-> ${edge.targetId}(${target})`;
  });

  const ordered = input.teachingOrderIds ?? [];

  return [
    '当前知识/技能点（ref 是你唯一能引用的节点标识）',
    ...lines,
    '',
    '可支撑的学习目标（连线用 obj 引用）',
    ...(objectiveLines.length > 0 ? objectiveLines : ['(没有学习目标)']),
    '',
    '已声明的先后关系（要删除用 removedDependencies 指名 dep id）',
    ...(dependencyLines.length > 0 ? dependencyLines : ['(还没有任何先后关系)']),
    ...(ordered.length > 0
      ? [
          '',
          '由先后关系推导出的讲授顺序（这是推导，不是你写的字段；要改就改边）',
          ordered.map((id, index) => `${index + 1}. ${id}(${nameOf.get(id) ?? id})`).join(' → '),
        ]
      : []),
  ].join('\n');
}
