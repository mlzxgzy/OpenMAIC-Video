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
import { knowledgeGapsOfRecords, type KnowledgeGap } from '@/lib/curriculum/design-knowledge';
import {
  nextCurriculumDesignPhase,
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
  gaps: KnowledgeGap[];
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
): Promise<KnowledgePayload> {
  const boardGaps = knowledgeGapsOfRecords(
    nodes.map((row) => ({ id: row.id, name: row.name, nodeType: row.nodeType })),
    nodeObjectives,
    objectives.map((row) => ({ id: row.id, title: row.title })),
  );
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
    gaps: boardGaps,
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
  };
}
