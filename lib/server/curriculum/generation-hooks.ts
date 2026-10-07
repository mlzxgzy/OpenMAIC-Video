/**
 * The curriculum side of `onRunEvent`: every committed generation-run
 * transition is mapped to the durable curriculum job that own the run, so the
 * produced course's `stage_id` lands on the curriculum course without the
 * browser having to poll or write back.
 *
 * This is a best-effort notification path (the generation hooks contract is
 * not a delivery queue). The course row is still readable and recoverable from
 * the run snapshot if a notification is dropped.
 */
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import type { GenerationRunHookEvent } from '@/lib/server/generation-run-hooks';

import { bindCurriculumGenerationRunStage, getCurriculumProvider } from './store';
import type { CurriculumGenerationRunUpdate } from './store';

/** Map one committed run event to the curriculum job patch it implies. */
export function curriculumGenerationUpdateForRunEvent(
  event: GenerationRunHookEvent,
): CurriculumGenerationRunUpdate | null {
  switch (event.type) {
    case 'started':
      return { status: 'running' };
    case 'outline-ready':
      return { status: 'awaiting_outline' };
    case 'scene-appended':
      return { status: 'running', stageId: event.stageId };
    case 'paused':
      return {
        status: 'paused',
        error: {
          code: event.errorCode ?? 'GENERATION_PAUSED',
          ...(event.step ? { step: event.step } : {}),
        },
      };
    case 'completed':
      return { status: 'completed', stageId: event.stageId };
    case 'ended':
      return { status: 'ended' };
    default:
      return null;
  }
}

export async function onCurriculumGenerationRunEvent(event: GenerationRunHookEvent): Promise<void> {
  const update = curriculumGenerationUpdateForRunEvent(event);
  if (!update) return;
  try {
    const { withTransaction } = await getCurriculumProvider();
    await withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, event.currentOwnerId);
      await bindCurriculumGenerationRunStage(tx, event.currentOwnerId, event.runId, update);
    });
  } catch (error) {
    // A dropped write-back is not worth failing the run; the run snapshot and
    // the curriculum job row remain available for a later reconciliation.
    console.error(
      `[Curriculum] Failed to apply generation run ${event.runId} event ${event.type}`,
      error,
    );
  }
}
