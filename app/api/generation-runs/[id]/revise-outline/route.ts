/**
 *   POST /api/generation-runs/:id/revise-outline
 *     `{ instruction, outlines, history? }`: ask the outline stage's model to
 *     revise the outline the run waits on, on the learner's instruction. The
 *     answer is returned to the caller and changes nothing on the server — the
 *     browser applies it to its editor, and the revision reaches the run only
 *     when the outline is confirmed (`POST .../confirm-outline`).
 *
 *     Same-origin JSON only: the call spends the owner's model budget. 409
 *     `RUN_STATE_CONFLICT` once the run is no longer waiting for its outline;
 *     400 `MISSING_MODEL` when no outline model is configured; 502
 *     `GENERATION_FAILED` when the model's answer is not a usable outline (the
 *     caller keeps the outline it has).
 */
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { apiSuccess } from '@/lib/server/api-response';
import {
  ownerApiError,
  ownerNotFound,
  withOwnerResponseHeaders,
} from '@/lib/server/agent-runtime/route-response';
import {
  MAX_COMMAND_BODY_BYTES,
  parseReviseOutline,
  readJsonBody,
} from '@/lib/server/generation/run/input';
import { isRunId, readGenerationRun } from '@/lib/server/generation/run/store';
import {
  OutlineRevisionError,
  reviseOutlines,
} from '@/lib/server/generation/steps/outline-revision';
import { withRequestOwner } from '@/lib/server/identity/with-owner';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

const log = createLogger('OutlineRevision');

/** The one stage an outline revision generates with (the outline step's). */
const OUTLINE_STAGE = 'scene-outlines-stream';

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    if (!isSameOriginJsonRequest(req)) {
      return ownerApiError(
        'INVALID_REQUEST',
        403,
        'Outline revisions must be same-origin JSON requests',
        responseHeaders,
      );
    }
    if (!isRunId(id)) return ownerNotFound(responseHeaders);
    const body = await readJsonBody(req, MAX_COMMAND_BODY_BYTES);
    if (!body.ok) {
      return ownerApiError('INVALID_REQUEST', body.status, body.message, responseHeaders);
    }
    const parsed = parseReviseOutline(body.value);
    if (!parsed.ok) return ownerApiError('INVALID_REQUEST', 400, parsed.message, responseHeaders);

    const run = await readGenerationRun(id, ownerId);
    if (!run) return ownerNotFound(responseHeaders);
    // Only a run that is waiting for its outline can have one revised: once it
    // is confirmed (here or elsewhere) the browser's edit could not be used.
    if (run.state !== 'awaiting_outline_confirmation' || !run.outline) {
      return ownerApiError(
        'RUN_STATE_CONFLICT',
        409,
        `The run is ${run.state.replaceAll('_', ' ')}, not waiting for its outline to be confirmed`,
        responseHeaders,
      );
    }

    let model: Awaited<ReturnType<typeof resolveModel>>;
    try {
      // The outline step's own slot, resolved for this owner exactly as the run
      // resolves it, so the revision speaks with the model that wrote it.
      model = await resolveModel({
        stage: OUTLINE_STAGE,
        workspaceId: await backgroundWorkspaceId(ownerId),
      });
    } catch (error) {
      if (error instanceof SlotUnassignedError || error instanceof SlotDisabledError) {
        return ownerApiError(
          'MISSING_MODEL',
          400,
          'No language model is configured for outlines',
          responseHeaders,
        );
      }
      throw error;
    }

    try {
      const result = await reviseOutlines(
        {
          requirement: run.input.requirement,
          interactive: run.input.interactive,
          taskEngine: run.input.taskEngine,
          ...(run.input.sceneTypes ? { sceneTypes: run.input.sceneTypes } : {}),
          languageDirective: run.outline.languageDirective,
          outlines: parsed.value.outlines,
          instruction: parsed.value.instruction,
          history: parsed.value.history,
          model,
        },
        { log, signal: req.signal },
      );
      return withOwnerResponseHeaders(apiSuccess({ ...result }), responseHeaders);
    } catch (error) {
      // The learner closed the dialog: the answer has nobody to reach. Quiet,
      // not an error log — the browser already dropped the request.
      if (req.signal.aborted) {
        return ownerApiError(
          'GENERATION_FAILED',
          499,
          'The outline revision was cancelled',
          responseHeaders,
        );
      }
      if (error instanceof OutlineRevisionError) {
        log.warn(`Outline revision unusable: ${error.message}`);
        return ownerApiError('GENERATION_FAILED', 502, error.message, responseHeaders);
      }
      throw error;
    }
  });
}
