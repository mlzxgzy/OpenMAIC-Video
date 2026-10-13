/**
 * GET /api/curriculum/design/tasks/[id]/export-gate — may this course be produced?
 *
 * Read-only, and deliberately so: it answers the same question
 * `assertCurriculumDesignExportable` enforces before generation, without
 * recording a review or touching anything. `blockers` is empty exactly when
 * `exportable` is true, and lists the first broken layer rather than every
 * one, because fixing a later layer while an earlier one is still broken
 * produces coverage that points at the wrong thing.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  describeCurriculumExportBlockers,
  evaluateCurriculumDesign,
  getCurriculumDesignSnapshot,
} from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, ctx.taskId);
    const evaluation = evaluateCurriculumDesign(snapshot);
    const blockers = describeCurriculumExportBlockers(evaluation);
    return ownerJson(
      {
        exportable: evaluation.exportable,
        blockers,
        quality: evaluation.quality,
        verdict: evaluation.verdict,
        // What this export would ship with. Read from the same evaluation the
        // gate decides on, so "may I produce this" and "what am I accepting by
        // producing it" can never come from two different readings.
        accepted: evaluation.accepted.map((entry) => ({
          id: entry.decision.id,
          ruleCode: entry.finding.rule,
          severity: entry.finding.severity,
          message: entry.finding.message,
          refKind: entry.finding.refKind,
          refId: entry.finding.refId,
        })),
      },
      200,
      ctx.headers,
    );
  });
}
