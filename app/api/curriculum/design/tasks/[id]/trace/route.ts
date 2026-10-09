/**
 * GET /api/curriculum/design/tasks/[id]/trace?objectiveId=…  — outcome → course
 * GET /api/curriculum/design/tasks/[id]/trace?unitId=…       — course → outcome
 *
 * The two directions the whole design has to be readable in, from one endpoint
 * because they are the same payload read two ways.
 *
 * Forward: given what the learner must be able to do, what does the course put
 * in front of them, which items teach it, train it and check it, and what does
 * it rest on. Backward: given an item being authored, which outcomes it serves
 * and whether the things they depend on have already been taught. A design
 * where only one direction works cannot be reviewed.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { getCurriculumDesignSnapshot } from '@/lib/server/curriculum/design-store';
import { traceFromObjective, traceFromUnit } from '@/lib/curriculum/traceability';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const objectiveId = req.nextUrl.searchParams.get('objectiveId')?.trim();
    const unitId = req.nextUrl.searchParams.get('unitId')?.trim();
    if (!objectiveId && !unitId) {
      return designInvalid('请传入 objectiveId 或 unitId', ctx.headers);
    }

    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (objectiveId) {
      const trace = traceFromObjective(snapshot, objectiveId);
      if (!trace) {
        return ownerJson(
          {
            error: {
              code: 'CURRICULUM_DESIGN_NOT_FOUND',
              message: `学习目标不存在：${objectiveId}`,
            },
          },
          404,
          ctx.headers,
        );
      }
      return ownerJson({ direction: 'objective-to-course', trace }, 200, ctx.headers);
    }

    const trace = traceFromUnit(snapshot, unitId!);
    if (!trace) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: `课程条目不存在：${unitId}`,
          },
        },
        404,
        ctx.headers,
      );
    }
    return ownerJson({ direction: 'course-to-objective', trace }, 200, ctx.headers);
  });
}
