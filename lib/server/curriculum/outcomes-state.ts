/**
 * The step-2 state payload, in the shape the card and the phase header read.
 *
 * Step 1's equivalent lives inside each of its two routes. Step 2 needs the same
 * payload from three call sites — the turn route, and the GET and POST of the state
 * route — so it is written once here rather than three times: three copies drift,
 * and the drift here would be silent, because a dialog that computes "ready" itself
 * simply disagrees with the gate instead of failing.
 *
 * `phaseGaps` is the authoritative blocker list: it merges the list's own gaps with
 * the missing confirmation, because a complete list is necessary but not sufficient.
 * `gaps` names only what is missing from the list itself, which is what the card
 * marks.
 */
import { outcomeGapsOfRecords, type OutcomeGap } from '@/lib/curriculum/design-outcomes';
import {
  nextCurriculumDesignPhase,
  type CurriculumDesignConfirmationRecord,
  type CurriculumEvidenceRecord,
  type CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';
import type { DesignContext } from '@/lib/server/curriculum/design-http';
import {
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
  phaseCompletionGaps,
} from '@/lib/server/curriculum/design-store';

export interface OutcomesPayload {
  objectives: CurriculumObjectiveRecord[];
  evidence: CurriculumEvidenceRecord[];
  gaps: OutcomeGap[];
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

export async function outcomesState(
  ctx: DesignContext,
  taskId: string,
  objectives: CurriculumObjectiveRecord[],
  evidence: CurriculumEvidenceRecord[],
): Promise<OutcomesPayload> {
  const boardGaps = outcomeGapsOfRecords(objectives, evidence);
  const confirmation = await getCurriculumDesignStepConfirmation(
    ctx.queryable,
    ctx.ownerId,
    taskId,
    'outcomes',
  );
  const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, taskId);
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps =
    next !== null ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, taskId, next) : [];
  return {
    objectives,
    evidence,
    gaps: boardGaps,
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
  };
}
