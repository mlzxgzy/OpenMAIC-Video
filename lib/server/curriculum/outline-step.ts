/**
 * 第 4 步「本目大纲」的 AI 步骤：一次对话轮次 → 一次大纲写入。
 *
 * 形状照抄 {@link file://./knowledge-step.ts}（同一条 prompt 管线、同一种 JSON 修理、
 * 同一份"确定性逻辑与模型分离"），但确定的那个部分换了一个问题。第三步的难点是
 * "别把模型没提到的连线删掉"，这一步的难点是**两种写法的语义正好相反**：
 *
 * - **单元是独立的行**：`createCurriculumUnit` / `updateCurriculumUnit` /
 *   `deleteCurriculumUnit` 一次动一行，没提到的行不受影响。所以模型只需要报出它动
 *   过的那几条，{@link resolveOutlineTurn} 把它们解析成"要建什么、要改什么、要删
 *   什么"。
 * - **覆盖是整份替换的**：`setCurriculumUnitCoverage` 会删掉全任务的覆盖再按传入的
 *   重建。所以模型只报改动的那几条是不够的——照搬会把没提到的条目的覆盖一起清空，
 *   而响应体看起来完全正常，直到 `outline → teaching` 门禁说"有目标没有被讲授"。
 *   {@link resolveOutlineTurn} 因此算的是**这一轮之后的完整覆盖集合**，与第三步的
 *   `mergeNodeLinks` 同一副骨架。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { formatDirectionLine } from '@/lib/server/curriculum/outcomes-step';
import {
  OutlineAnswerError,
  collectCoverage,
  formatOutlinePlan,
  mergeOutlinePatch,
  mergeUnitCoverage,
  parseOutlineAnswer,
  planUnitWrites,
  type OutlineAnswer,
  type OutlineGap,
  type OutlineObjectiveRef,
  type OutlineUnitRef,
  type PlannedUnitCreate,
  type PlannedUnitUpdate,
} from '@/lib/curriculum/design-outline';
import { formatKnowledgeList } from '@/lib/curriculum/design-knowledge';
import type {
  CurriculumCoverageDepth,
  CurriculumCoverageKind,
  CurriculumDependencyEdgeType,
  CurriculumNodeType,
} from '@/lib/curriculum/design-types';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface CourseOutlineTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Everything the route already read, in the form the rules take it. */
export interface OutlineBoard {
  units: readonly OutlineUnitRef[];
  coverageByUnit: ReadonlyMap<
    string,
    readonly {
      objectiveId: string;
      coverageKind: CurriculumCoverageKind;
      depth: CurriculumCoverageDepth;
    }[]
  >;
  objectives: readonly OutlineObjectiveRef[];
  /** The confirmed graph, so the outline is arranged on top of what was signed. */
  nodes: readonly { id: string; name: string; nodeType: CurriculumNodeType }[];
  linksByNode: ReadonlyMap<string, readonly { objectiveId: string }[]>;
  /** The ordering claims the author signed (both endpoint kinds). */
  edges: readonly {
    sourceId: string;
    sourceKind: string;
    targetId: string;
    targetKind: string;
    edgeType: CurriculumDependencyEdgeType;
  }[];
  /** The teaching sequence derived from the node edges — never stored. */
  teachingOrder: readonly { id: string; name: string }[];
  /** The hours the brief declared, for the advisory check. */
  declaredHours: number | null;
}

export interface CourseOutlineInput {
  /** The confirmed direction and outcome list, as context lines. */
  direction: string;
  board: OutlineBoard;
  history: readonly CourseOutlineTurn[];
  instruction: string;
  /** What the stored outline is still missing, in the card's own words. */
  gaps: readonly OutlineGap[];
  model: StepLanguageModel;
}

/** What the route has to write, already resolved against real ids. */
export interface CourseOutlineResult {
  message: string;
  creates: PlannedUnitCreate[];
  updates: PlannedUnitUpdate[];
  removed: Set<string>;
  /**
   * The **whole** coverage ledger after this turn for units that already exist:
   * the items the turn named, replaced, plus every item it did not name, carried
   * over. Merged here rather than in the route because "which items were not
   * named" is a rule decision — getting it wrong in the route is how a turn
   * silently strips an item of everything it taught.
   */
  coverage: {
    unitId: string;
    objectiveId: string;
    coverageKind: CurriculumCoverageKind;
    depth: CurriculumCoverageDepth;
    note: string | null;
  }[];
  /** Whether this turn changes the coverage ledger at all. */
  changedCoverage: boolean;
  /** Whether this turn changes anything at all (units or coverage). */
  changedAnything: boolean;
  /** What the model claimed. The route re-decides against the written state. */
  modelRequestedConfirm: boolean;
  userTurns: number;
  unmatchedRefs: string[];
  rejectedRefs: string[];
}

export function formatOutlineHistory(history: readonly CourseOutlineTurn[]): string {
  if (history.length === 0) return '(这是这一步的第一句话)';
  return history
    .map((turn) => `${turn.role === 'user' ? '作者' : '助手'}: ${turn.content}`)
    .join('\n\n');
}

/** The gaps the model is asked to close, in the same words the card shows. */
export function gapsText(gaps: readonly OutlineGap[]): string {
  if (gaps.length === 0) return '(大纲没有缺口：可以请作者确认)';
  return gaps.map((gap) => `- ${gap.text}`).join('\n');
}

/**
 * The confirmed graph and its ordering claims, as the outline step sees them.
 *
 * Reuses {@link formatKnowledgeList} rather than re-rendering nodes: the graph is
 * the same object step 3 signed, and a second renderer is how the two screens
 * start describing it differently.
 */
export function formatOutlineGraph(board: OutlineBoard): string {
  const graph = formatKnowledgeList({
    nodes: board.nodes,
    objectives: board.objectives,
    linksByNode: board.linksByNode,
  });
  const nameOf = (id: string): string =>
    board.nodes.find((node) => node.id === id)?.name ??
    board.objectives.find((objective) => objective.id === id)?.title ??
    id;
  const edges = board.edges
    .filter((edge) => edge.sourceKind === edge.targetKind)
    .map((edge) => `${nameOf(edge.sourceId)} → ${nameOf(edge.targetId)}（${edge.edgeType}）`);
  const order = board.teachingOrder.map((node, index) => `${index + 1}. ${node.name}`);
  return [
    graph,
    '',
    '已确认的先后关系（箭头左边是必须先学的）',
    ...(edges.length > 0 ? edges : ['(没有声明先后关系)']),
    '',
    '据此推导出的讲授顺序（大纲的顺序必须与它一致）',
    ...(order.length > 0 ? order : ['(没有知识/技能点)']),
  ].join('\n');
}

/**
 * The deterministic half, given the model's answer and the outline it answered
 * about. Kept separate from {@link draftCourseOutline} so it can be tested
 * against a hundred answers without a model.
 */
export function resolveOutlineTurn(input: {
  answer: OutlineAnswer;
  board: OutlineBoard;
  history: readonly CourseOutlineTurn[];
}): CourseOutlineResult {
  const { patches, removed, unmatchedRefs } = mergeOutlinePatch(input.board.units, input.answer);
  const userTurns = input.history.filter((turn) => turn.role === 'user').length + 1;

  const {
    creates,
    updates,
    unmatchedRefs: placementRefs,
  } = planUnitWrites({
    current: input.board.units,
    removed,
    drafts: input.answer.added,
    patches,
  });
  unmatchedRefs.push(...placementRefs);

  const knownObjectiveIds = new Set(input.board.objectives.map((entry) => entry.id));
  const { replace, unmatchedRefs: coverageRefs } = mergeUnitCoverage({
    coverageByUnit: input.board.coverageByUnit,
    knownUnitIds: new Set(input.board.units.map((entry) => entry.id)),
    knownObjectiveIds,
    unitTypeOf: (unitId) =>
      input.board.units.find((entry) => entry.id === unitId)?.unitType ?? null,
    removed,
    proposed: input.answer.coverage,
  });
  unmatchedRefs.push(...coverageRefs);

  const coverage = collectCoverage(input.board.coverageByUnit, replace, removed);

  return {
    message: input.answer.message,
    creates,
    updates,
    removed,
    coverage,
    changedCoverage: replace.size > 0,
    changedAnything:
      creates.length > 0 || updates.length > 0 || removed.size > 0 || replace.size > 0,
    modelRequestedConfirm: input.answer.confirmRequested,
    userTurns,
    unmatchedRefs,
    rejectedRefs: input.answer.rejectedRefs,
  };
}

/**
 * The board the rules take, read off the records the route already has.
 *
 * `coverageByUnit` is keyed by unit because that is the grain the merge works at:
 * the store replaces the ledger as a whole, so the turn has to be able to say
 * "these items keep what they had".
 */
export function outlineBoardOf(input: {
  units: readonly OutlineUnitRef[];
  coverage: readonly {
    unitId: string;
    objectiveId: string;
    coverageKind: CurriculumCoverageKind;
    depth: CurriculumCoverageDepth;
  }[];
  objectives: readonly OutlineObjectiveRef[];
  nodes: readonly { id: string; name: string; nodeType: CurriculumNodeType }[];
  links: readonly { nodeId: string; objectiveId: string }[];
  edges: OutlineBoard['edges'];
  teachingOrder: readonly { id: string; name: string }[];
  declaredHours: number | null;
}): OutlineBoard {
  const coverageByUnit = new Map<
    string,
    { objectiveId: string; coverageKind: CurriculumCoverageKind; depth: CurriculumCoverageDepth }[]
  >();
  for (const row of input.coverage) {
    const list = coverageByUnit.get(row.unitId) ?? [];
    list.push({
      objectiveId: row.objectiveId,
      coverageKind: row.coverageKind,
      depth: row.depth,
    });
    coverageByUnit.set(row.unitId, list);
  }
  const linksByNode = new Map<string, { objectiveId: string }[]>();
  for (const link of input.links) {
    const list = linksByNode.get(link.nodeId) ?? [];
    list.push({ objectiveId: link.objectiveId });
    linksByNode.set(link.nodeId, list);
  }
  return {
    units: sortUnits(input.units),
    coverageByUnit,
    objectives: input.objectives,
    nodes: input.nodes,
    linksByNode,
    edges: input.edges,
    teachingOrder: input.teachingOrder,
    declaredHours: input.declaredHours,
  };
}

/** Depth-first, parents before children, each level by `orderIndex`. */
function sortUnits(units: readonly OutlineUnitRef[]): OutlineUnitRef[] {
  const childrenOf = (parentId: string | null): OutlineUnitRef[] =>
    units
      .filter((unit) => (unit.parentId ?? null) === parentId)
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex);
  const out: OutlineUnitRef[] = [];
  const walk = (parentId: string | null): void => {
    for (const unit of childrenOf(parentId)) {
      out.push(unit);
      walk(unit.id);
    }
  };
  walk(null);
  // A unit whose parent is missing from the list would otherwise vanish from the
  // prompt entirely, and the model would re-propose it as new.
  for (const unit of units) if (!out.includes(unit)) out.push(unit);
  return out;
}

/** The coverage rows a draft declared, for a unit whose id does not exist yet. */
export function draftCoverageOf(
  draft: {
    coverage: readonly {
      objectiveRef: string;
      coverageKind: CurriculumCoverageKind;
      depth: CurriculumCoverageDepth;
    }[];
  },
  knownObjectiveIds: ReadonlySet<string>,
): { objectiveId: string; coverageKind: CurriculumCoverageKind; depth: CurriculumCoverageDepth }[] {
  return draft.coverage
    .filter((row) => knownObjectiveIds.has(row.objectiveRef))
    .map((row) => ({
      objectiveId: row.objectiveRef,
      coverageKind: row.coverageKind,
      depth: row.depth,
    }));
}

/**
 * Run one outline turn. Throws {@link OutlineAnswerError} when the answer is not
 * usable as an outline change; the caller maps that to a 502 and the outline is
 * left exactly as it was.
 */
export async function draftCourseOutline(
  input: CourseOutlineInput,
  ctx: StepContext,
): Promise<CourseOutlineResult> {
  const prompts = buildPrompt(PROMPT_IDS.COURSE_OUTLINE, {
    direction: input.direction,
    graph: formatOutlineGraph(input.board),
    plan: formatOutlinePlan({
      units: input.board.units,
      coverage: [...input.board.coverageByUnit].flatMap(([unitId, rows]) =>
        rows.map((row) => ({
          unitId,
          objectiveId: row.objectiveId,
          coverageKind: row.coverageKind,
          depth: row.depth,
        })),
      ),
      objectives: input.board.objectives,
    }),
    gaps: gapsText(input.gaps),
    history: formatOutlineHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`找不到课程大纲提示词模板：${PROMPT_IDS.COURSE_OUTLINE}`);
  }

  ctx.log.info(
    `Course outline turn ${input.history.length + 1}: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-outline',
    {
      retries: 1,
      validate: (text: string) => {
        try {
          parseOutlineAnswer(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return resolveOutlineTurn({
    answer: parseOutlineAnswer(result.text),
    board: input.board,
    history: input.history,
  });
}

export { OutlineAnswerError, formatDirectionLine };
