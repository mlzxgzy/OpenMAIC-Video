/**
 * 第三步「知识点与技能点拆解」的 AI 步骤：一次对话轮次 → 一次图写入。
 *
 * 形状照抄 {@link file://./outcomes-step.ts}（同一条 prompt 管线、同一种 JSON 修理、
 * 同一份确定性逻辑与模型分离），多两件事，因为它的对象是**图**而不是卡片或清单：
 *
 * 1. **连线要解析两端。** 模型只能用 `ref` 指名节点、用目标 id 指名目标，两个指向
 *    都对得上才写。{@link resolveKnowledgeTurn} 是全部确定性逻辑，可不带模型测试。
 * 2. **确认要多一层判定。** 除了前两步的底线（不是第一句话、这一轮真的动过图、
 *    没有缺口），这里"没有缺口"本身是更强的：图必须**两头都连上**。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { formatDirectionLine } from '@/lib/server/curriculum/outcomes-step';
import {
  KnowledgeAnswerError,
  formatKnowledgeList,
  knowledgeGaps,
  knowledgeGapsOfRecords,
  mergeKnowledgePatch,
  mergeNodeLinks,
  parseKnowledgeAnswer,
  shouldConfirmKnowledge,
  type KnowledgeAnswer,
  type KnowledgeGap,
  type KnowledgeNodeDraft,
  type KnowledgeNodePatch,
  type KnowledgeNodeRef,
  type KnowledgeRef,
} from '@/lib/curriculum/design-knowledge';
import type {
  CurriculumLearningNodeRecord,
  CurriculumNodeObjectiveRecord,
  CurriculumObjectiveRecord,
  CurriculumSupportLevel,
} from '@/lib/curriculum/design-types';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface CourseKnowledgeTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface KnowledgeLinkRef {
  objectiveId: string;
  supportLevel: CurriculumSupportLevel;
}

/** Everything the route already read, in the form the rules take it. */
export interface KnowledgeBoard {
  nodes: readonly KnowledgeNodeRef[];
  objectives: readonly KnowledgeRef[];
  linksByNode: ReadonlyMap<string, readonly KnowledgeLinkRef[]>;
}

export interface CourseKnowledgeInput {
  /** The confirmed direction and outcome list, as context lines. */
  direction: string;
  board: KnowledgeBoard;
  history: readonly CourseKnowledgeTurn[];
  instruction: string;
  model: StepLanguageModel;
}

/** What the route has to write, already resolved against real ids. */
export interface CourseKnowledgeResult {
  message: string;
  added: KnowledgeNodeDraft[];
  /** Patches keyed by node id. */
  patches: Map<string, KnowledgeNodePatch>;
  removed: Set<string>;
  /**
   * The **whole** link set after this turn: the nodes the turn named, replaced,
   * plus every node it did not name, carried over unchanged. Merged here rather
   * than in the route because "which nodes were not named" is a rule decision —
   * getting it wrong in the route is how a turn silently empties the graph.
   */
  links: {
    nodeId: string;
    objectiveId: string;
    supportLevel: CurriculumSupportLevel;
    note: string | null;
  }[];
  confirmRequested: boolean;
  /**
   * Whether this turn changes the **link set** at all — including the case of
   * clearing one node's links, which `turn.links` alone cannot show (an emptied
   * node contributes no rows). The route uses it to decide whether to call the
   * link setter at all: calling it with the same set would be harmless (the store
   * compares) but pointless, and skipping it on a turn that really did change the
   * links would leave the author staring at an unchanged graph.
   */
  changedLinks: boolean;
  unmatchedRefs: string[];
  rejectedRefs: string[];
  gaps: KnowledgeGap[];
  userTurns: number;
}

export function formatKnowledgeHistory(history: readonly CourseKnowledgeTurn[]): string {
  if (history.length === 0) return '(这是这一步的第一句话)';
  return history
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
    .join('\n\n');
}

/** The gaps the model is asked to close, in the same words the card shows. */
export function gapsText(gaps: readonly KnowledgeGap[]): string {
  if (gaps.length === 0) return '(每个节点都有目标、每个目标都有节点，可以请用户确认)';
  return gaps.map((gap) => `- ${gap.text}`).join('\n');
}

/**
 * The deterministic half, given the model's answer and the graph it answered
 * about. Kept separate from {@link draftCourseKnowledge} so it can be tested
 * against a hundred answers without a model.
 */
export function resolveKnowledgeTurn(input: {
  answer: KnowledgeAnswer;
  board: KnowledgeBoard;
  history: readonly CourseKnowledgeTurn[];
}): CourseKnowledgeResult {
  const { patches, removed, unmatchedRefs } = mergeKnowledgePatch(input.board.nodes, input.answer);
  const userTurns = input.history.filter((turn) => turn.role === 'user').length + 1;

  const knownObjectiveIds = new Set(input.board.objectives.map((entry) => entry.id));
  const { replace, unmatchedRefs: linkRefs } = mergeNodeLinks({
    linksByNode: input.board.linksByNode,
    knownNodeIds: new Set(input.board.nodes.map((entry) => entry.id)),
    knownObjectiveIds,
    removed,
    proposed: input.answer.links,
  });
  unmatchedRefs.push(...linkRefs);

  // Drafts are counted as nodes immediately, and their own links as links: the
  // turn that creates the first node of a task cannot otherwise ever confirm the
  // graph it just built, because the stored rows do not exist until afterwards.
  const draftNodeCount = input.answer.added.length;

  const links = collectLinks(input.board.linksByNode, replace, removed);
  const changedAnything =
    input.answer.added.length > 0 || patches.size > 0 || removed.size > 0 || replace.size > 0;

  // Gaps after this turn. `knowledgeGaps` is the same function the card and the
  // gate use, so the three cannot disagree.
  const survivingNodes = input.board.nodes.filter((entry) => !removed.has(entry.id));
  const storedLinks = collectLinks(input.board.linksByNode, replace, removed);
  const supportedObjectiveIds = new Set(storedLinks.map((link) => link.objectiveId));

  // The nodes as this turn leaves them: the survivors, plus one entry per draft.
  // The draft entries exist so the "there are no nodes at all" check sees the graph
  // the turn is building rather than the empty one it started from — without them,
  // the turn that creates a task's first node is told it has built nothing, and can
  // never confirm the graph it just built. `draftIndex` is how a placeholder is tied
  // back to the answer; a stored node has none, so it cannot collide with one.
  const gapNodes: { ref: KnowledgeNodeRef; draftIndex: number | null }[] = [
    ...survivingNodes.map((node) => ({ ref: node, draftIndex: null })),
    ...input.answer.added.map((draft, draftIndex) => ({
      ref: { id: '', name: draft.name, nodeType: draft.nodeType },
      draftIndex,
    })),
  ];
  const supportedByDrafts = input.answer.added.map((draft) =>
    draftLinksOf(draft, knownObjectiveIds).map((link) => link.objectiveRef),
  );
  for (const usable of supportedByDrafts) {
    for (const objectiveId of usable) supportedObjectiveIds.add(objectiveId);
  }
  const linkedKeys = new Set(storedLinks.map((link) => link.nodeId));

  const gaps = [
    ...knowledgeGaps(
      gapNodes.map((entry) => entry.ref),
      // The test is "will anything link it", not "was it mentioned": a node whose
      // links were just **cleared** is a hole, and that is the entire point of
      // letting the model clear them. Each half is `.ref` because `knowledgeGaps`
      // reports a hole by its `name`, and the wrapper has none.
      gapNodes
        .filter(
          (entry) =>
            !linkedKeys.has(entry.ref.id) &&
            (entry.draftIndex === null || (supportedByDrafts[entry.draftIndex]?.length ?? 0) === 0),
        )
        .map((entry) => entry.ref),
      input.board.objectives.filter((objective) => !supportedObjectiveIds.has(objective.id)),
    ),
    ...unmatchedDraftLinks(input.answer.added, knownObjectiveIds),
  ];

  return {
    message: input.answer.message,
    added: input.answer.added,
    patches,
    removed,
    links,
    // A turn that adds a node with links changed the link set even though no
    // *existing* node's links were replaced; a turn that cleared one node's links
    // changed it while `links` has fewer rows than before, not more. Neither shows
    // up in `replace.size`, so the route is told separately.
    changedLinks: replace.size > 0 || input.answer.added.length > 0,
    confirmRequested: shouldConfirmKnowledge({
      confirmRequested: input.answer.confirmRequested,
      userTurns,
      nodeCount: survivingNodes.length + draftNodeCount,
      objectiveCount: input.board.objectives.length,
      gaps,
      changedAnything,
    }),
    unmatchedRefs,
    rejectedRefs: input.answer.rejectedRefs,
    gaps,
    userTurns,
  };
}

/** Every link after this turn: replaced nodes as given, the rest carried over. */
function collectLinks(
  linksByNode: KnowledgeBoard['linksByNode'],
  replace: ReturnType<typeof mergeNodeLinks>['replace'],
  removed: ReadonlySet<string>,
): {
  nodeId: string;
  objectiveId: string;
  supportLevel: CurriculumSupportLevel;
  note: string | null;
}[] {
  const out: {
    nodeId: string;
    objectiveId: string;
    supportLevel: CurriculumSupportLevel;
    note: string | null;
  }[] = [];
  const nodeIds = new Set([...linksByNode.keys(), ...replace.keys()]);
  for (const nodeId of nodeIds) {
    if (removed.has(nodeId)) continue;
    const next = replace.get(nodeId);
    if (next) {
      for (const link of next) out.push({ nodeId, ...link });
      continue;
    }
    for (const link of linksByNode.get(nodeId) ?? []) {
      out.push({
        nodeId,
        objectiveId: link.objectiveId,
        supportLevel: link.supportLevel,
        note: null,
      });
    }
  }
  return out;
}

/**
 * Links a draft declared that name an outcome that does not exist.
 *
 * Kept separate from the "draft has no usable link" gap because `knowledgeGaps`
 * now reports that one: a draft is a node in the gap list, and the node rule says
 * it has nothing behind it. What `knowledgeGaps` cannot say is *which* declaration
 * was wrong, and a silently dropped link is the failure mode that matters — so the
 * user is told the reference was wrong rather than just seeing a hole appear.
 */
function unmatchedDraftLinks(
  drafts: readonly KnowledgeNodeDraft[],
  knownObjectiveIds: ReadonlySet<string>,
): KnowledgeGap[] {
  const gaps: KnowledgeGap[] = [];
  for (const draft of drafts) {
    for (const link of draft.objectiveRefs) {
      if (link.objectiveRef !== null && !knownObjectiveIds.has(link.objectiveRef)) {
        gaps.push({
          text: `「${draft.name}」指向了一条对不上的目标（${link.objectiveRef}）：这一条连线没有写入`,
        });
      }
    }
  }
  return gaps;
}

/** The board the rules take, read off the records the route already has. */
export function knowledgeBoardOf(
  nodes: readonly CurriculumLearningNodeRecord[],
  objectives: readonly CurriculumObjectiveRecord[],
  links: readonly CurriculumNodeObjectiveRecord[],
): KnowledgeBoard {
  const linksByNode = new Map<string, KnowledgeLinkRef[]>();
  for (const link of links) {
    const list = linksByNode.get(link.nodeId);
    const row = { objectiveId: link.objectiveId, supportLevel: link.supportLevel };
    if (list) list.push(row);
    else linksByNode.set(link.nodeId, [row]);
  }
  return {
    nodes: nodes
      .slice()
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
      )
      .map((row) => ({ id: row.id, name: row.name, nodeType: row.nodeType })),
    objectives: objectives
      .slice()
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
      )
      .map((row) => ({ id: row.id, title: row.title })),
    linksByNode,
  };
}

/**
 * The links a new node declares, once the goal ids are known to exist.
 *
 * A draft's `objectiveRef` may be `null` (it supports nothing), which is a
 * meaningful link to *not* create rather than one to create with a null goal —
 * hence the explicit filter instead of a type assertion at the write site.
 */
export function draftLinksOf(
  draft: KnowledgeNodeDraft,
  knownObjectiveIds: ReadonlySet<string>,
): { objectiveRef: string; supportLevel?: CurriculumSupportLevel; note?: string | null }[] {
  return draft.objectiveRefs.filter(
    (
      link,
    ): link is {
      objectiveRef: string;
      supportLevel?: CurriculumSupportLevel;
      note?: string | null;
    } => link.objectiveRef !== null && knownObjectiveIds.has(link.objectiveRef),
  );
}

/**
 * Run one knowledge turn. Throws {@link KnowledgeAnswerError} when the answer is
 * not usable as a graph change; the caller maps that to a 502 and the graph is
 * left exactly as it was.
 */
export async function draftCourseKnowledge(
  input: CourseKnowledgeInput,
  ctx: StepContext,
): Promise<CourseKnowledgeResult> {
  const prompts = buildPrompt(PROMPT_IDS.COURSE_KNOWLEDGE, {
    direction: input.direction,
    graph: formatKnowledgeList(input.board),
    gaps: gapsText(
      knowledgeGapsOfRecords(
        input.board.nodes,
        [...input.board.linksByNode].flatMap(([nodeId, rows]) =>
          rows.map((row) => ({ nodeId, objectiveId: row.objectiveId })),
        ),
        input.board.objectives,
      ),
    ),
    history: formatKnowledgeHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`找不到知识技能图提示词模板：${PROMPT_IDS.COURSE_KNOWLEDGE}`);
  }

  ctx.log.info(
    `Course knowledge turn ${input.history.length + 1}: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-knowledge',
    {
      retries: 1,
      validate: (text: string) => {
        try {
          parseKnowledgeAnswer(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return resolveKnowledgeTurn({
    answer: parseKnowledgeAnswer(result.text),
    board: input.board,
    history: input.history,
  });
}

export { KnowledgeAnswerError, formatDirectionLine };
