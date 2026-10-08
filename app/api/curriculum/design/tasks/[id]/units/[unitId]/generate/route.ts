/**
 * POST /api/curriculum/design/tasks/[id]/units/[unitId]/generate
 *
 * Produce one designed item: the gate, then a generation run that consumes the
 * design instead of a paragraph describing it.
 *
 * This is the route that makes the reverse-design model real. Everything before
 * it — objectives, evidence, the graph, the outline, the page plan — exists to
 * answer two questions at this point: may this be produced at all, and what
 * should the generator be told? Both answers are read from the design, which is
 * why the gate and the run input are derived here rather than passed in.
 *
 * Four properties are worth stating, because each is a way this could have been
 * built wrong:
 *
 * 1. **The gate runs first, and it re-runs.**
 *    `assertCurriculumDesignExportable` re-evaluates the design rather than
 *    trusting the last stored review, because an edit after a review reopens a
 *    gap. It runs before `startGenerationRun` so a design that cannot be
 *    produced never creates a run — starting first and checking afterwards would
 *    leave an orphaned, paid-for run behind on every refusal.
 *
 * 2. **The gate covers the whole task, not just this item.** A lecture can be
 *    complete while the item that assesses its outcome is empty, and producing
 *    that lecture would create content for a promise nothing checks. So the
 *    refusal names the first broken layer rather than this item's own gaps.
 *
 * 3. **The run is what the design says, in the item's own role.** `unitRole*`
 *    derives the scene types and the interactive/task-engine flags together,
 *    from `unit_role`. An exam item gets no interactive scene and no hints; a
 *    practice item gets the procedural surface and keeps hints. Hardcoding
 *    `['slide']` here would restore the exact defect this route replaces.
 *
 * 4. **The item's `stageId` is not written here.** The generation-run hook
 *    writes it when the run commits a scene (`generation-hooks.ts`), which is
 *    the only place that knows the produced stage. Writing the *run* id into
 *    `stage_id` here would put an identifier of the wrong kind into the column
 *    and make "does this item have a stage?" true before anything was produced.
 *
 * 5. **A refused start is not a 500.** One course is several items and each
 *    generate starts one run, so producing a whole course reaches the owner's
 *    active-run limit partway through — which is an ordinary, temporary state,
 *    not a fault. The refusals are mapped through `startRefusal`, the same
 *    mapping `POST /api/generation-runs` uses, so both ways of starting a run
 *    answer 429 with the same body instead of one of them reporting a broken
 *    server.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import {
  assertCurriculumDesignExportable,
  getCurriculumUnit,
  listCurriculumUnitOutcomeBehaviors,
} from '@/lib/server/curriculum/design-store';
import {
  deckDesignForRole,
  describeDesignedItem,
  unitRoleRunModes,
  unitRoleSceneTypes,
} from '@/lib/server/curriculum/unit-role-run';
import { startGenerationRun, startRefusal } from '@/lib/server/generation/run/start';
import { runSnapshot } from '@/lib/server/generation/run/store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; unitId: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const unitId = ctx.params.unitId;
    if (!unitId) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_INVALID',
            message: 'unitId is missing from the request path',
          },
        },
        400,
        ctx.headers,
      );
    }

    // The item is read before the gate so a stranger's id is a 404 rather than
    // a 409 about someone else's design, and so the run's requirement can be
    // built from the outcomes this item actually serves.
    const unit = await getCurriculumUnit(ctx.queryable, ctx.ownerId, unitId);
    if (!unit || unit.taskId !== ctx.taskId) {
      return ownerJson(
        { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: 'course item not found' } },
        404,
        ctx.headers,
      );
    }

    // A chapter carries no role and the store refuses to give it one, so this
    // is unreachable through the API. The refusal is kept because the type says
    // `CurriculumUnitRole | null` and a row written by a future migration would
    // reach here as exactly this null.
    if (!unit.unitRole) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_INVALID',
            message: `"${unit.title}" is a chapter; only an item carries a teaching role and can be produced`,
          },
        },
        400,
        ctx.headers,
      );
    }

    const review = await assertCurriculumDesignExportable(ctx.queryable, ctx.ownerId, ctx.taskId);

    const outcomes = await listCurriculumUnitOutcomeBehaviors(ctx.queryable, ctx.ownerId, unitId);
    const modes = unitRoleRunModes(unit.unitRole);

    // 202 is a start, not a completion: the caller follows the returned run, and
    // the item's `stageId` appears when the run commits its first scene.
    //
    // A start can be refused, and the refusals are mapped rather than left to
    // fall through to a 500. The one that bites in practice is the owner's
    // active-run limit: a course has several items, each generate starts one
    // run, so producing a whole course from one owner hits the limit on the
    // third item — and "At most 2 courses may be in progress at once" arriving
    // as `CURRICULUM_DESIGN_FAILED` reads as a broken server rather than a
    // caller that should wait. `startRefusal` is the same mapping
    // `POST /api/generation-runs` uses, so both ways of starting a run refuse
    // identically.
    let run;
    try {
      run = await startGenerationRun(ctx.ownerId, {
        requirement: describeDesignedItem({
          title: unit.title,
          role: unit.unitRole,
          outcomes,
          plannedPages: unit.deckDesign?.pages?.length ?? 0,
        }),
        materialIds: [],
        sceneTypes: unitRoleSceneTypes(unit.unitRole),
        interactive: modes.interactive,
        taskEngine: modes.taskEngine,
        deckDesign: deckDesignForRole(unit.unitRole, unit.deckDesign),
        curriculumTaskId: ctx.taskId,
        curriculumUnitId: unitId,
        agents: { mode: 'auto' },
        outlineReview: 'auto',
      });
    } catch (error) {
      const refusal = startRefusal(error);
      if (refusal) {
        const response = curriculumJsonError(
          refusal.status,
          refusal.code,
          refusal.message,
          ctx.headers,
        );
        for (const [key, value] of refusal.headers ?? []) response.headers.append(key, value);
        return response;
      }
      throw error;
    }

    return ownerJson(
      {
        run: runSnapshot(run),
        taskId: ctx.taskId,
        unitId,
        role: unit.unitRole,
        sceneTypes: unitRoleSceneTypes(unit.unitRole),
        ...modes,
        // Folded in so the caller learns the loop is closed from the same
        // response that started the run, instead of asking again.
        coverage: review.verdict,
      },
      202,
      ctx.headers,
    );
  });
}
