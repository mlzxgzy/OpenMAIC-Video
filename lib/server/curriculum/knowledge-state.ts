/**
 * The step-3 state payload, in the shape the card and the phase header read.
 *
 * Same job as `outcomes-state.ts`, and for the same reason: the turn route, the
 * GET and the POST of the state route all answer with this, so it is written once
 * rather than three times. Three copies drift, and the drift is silent — a dialog
 * that computes "ready" itself simply disagrees with the gate instead of failing.
 *
 * `phaseGaps` is the authoritative blocker list: it merges the graph's own gaps
 * with the missing confirmation, because a connected graph is necessary but not
 * sufficient. `gaps` names only what is missing from the graph itself, which is
 * what the card marks.
 */
import {
  knowledgeFindings,
  knowledgeGapsOfRecords,
  teachingOrder,
  type KnowledgeGap,
} from '@/lib/curriculum/design-knowledge';
import {
  nextCurriculumDesignPhase,
  type CurriculumDependencyRecord,
  type CurriculumDesignConfirmationRecord,
  type CurriculumLearningNodeRecord,
  type CurriculumNodeObjectiveRecord,
  type CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';
import type { DesignContext } from '@/lib/server/curriculum/design-http';
import {
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
  phaseCompletionGaps,
} from '@/lib/server/curriculum/design-store';

export interface KnowledgePayload {
  nodes: CurriculumLearningNodeRecord[];
  nodeObjectives: CurriculumNodeObjectiveRecord[];
  /** The confirmed outcome list: the graph's other end, so the card can show it. */
  objectives: CurriculumObjectiveRecord[];
  /** The ordering edges the author signs, so the card can show what precedes what. */
  dependencies: CurriculumDependencyRecord[];
  /**
   * The teaching sequence, **derived** from `dependencies` and never stored.
   *
   * It lives here rather than in a column because it is a function of the edges: a
   * stored copy drifts the first time an edge changes, and the outline stage is
   * where a sequence is actually committed (`unit.orderIndex`).
   */
  teachingOrder: string[];
  gaps: KnowledgeGap[];
  /** Advisory only — what the machine can see but must not decide for the author. */
  findings: KnowledgeGap[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: string | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
  /** Present only on a conversation turn: what the user reads in the chat. */
  message?: string;
  /** Present only on a conversation turn: whether this turn recorded the sign-off. */
  confirmedThisTurn?: boolean;
}

export async function knowledgeState(
  ctx: DesignContext,
  taskId: string,
  nodes: CurriculumLearningNodeRecord[],
  nodeObjectives: CurriculumNodeObjectiveRecord[],
  objectives: CurriculumObjectiveRecord[],
  dependencies: CurriculumDependencyRecord[] = [],
): Promise<KnowledgePayload> {
  const nodeRefs = nodes.map((row) => ({ id: row.id, name: row.name, nodeType: row.nodeType }));
  const objectiveRefs = objectives.map((row) => ({ id: row.id, title: row.title }));
  const boardGaps = knowledgeGapsOfRecords(nodeRefs, nodeObjectives, objectiveRefs);
  // Only node-to-node edges describe the order knowledge is taught in; an edge
  // with an outcome endpoint is a plan-level claim the outline stage reads.
  const edges = dependencies
    .filter((edge) => edge.sourceKind === 'node' && edge.targetKind === 'node')
    .map((edge) => ({
      id: edge.id,
      sourceId: edge.sourceId,
      targetId: edge.targetId,
      edgeType: edge.edgeType,
    }));
  const confirmation = await getCurriculumDesignStepConfirmation(
    ctx.queryable,
    ctx.ownerId,
    taskId,
    'graph',
  );
  const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, taskId);
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps =
    next !== null ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, taskId, next) : [];
  return {
    nodes,
    nodeObjectives,
    objectives,
    dependencies,
    teachingOrder: teachingOrder({ nodes: nodeRefs, dependencies: edges }).order.map(
      (node) => node.id,
    ),
    gaps: boardGaps,
    findings: knowledgeFindings(nodeRefs, edges),
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
  };
}
