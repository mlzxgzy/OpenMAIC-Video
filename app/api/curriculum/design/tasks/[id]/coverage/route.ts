/**
 * GET /api/curriculum/design/tasks/[id]/coverage — the outcome × item coverage
 * report, plus the one number that says whether the course closes its loop.
 *
 * Every row is one outcome, and each carries which items teach, practise and
 * assess it. `counts.complete` over `counts.total` is the ratio the export
 * gate reads; `gaps` is worst-first, so the top of the list is the outcome
 * whose absence is most damaging. This is the endpoint behind the heat matrix.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { getCurriculumDesignSnapshot } from '@/lib/server/curriculum/design-store';
import { buildDesignCoverage, summariseCoverage } from '@/lib/curriculum/design-coverage';
import { buildTraceabilityMatrix } from '@/lib/curriculum/traceability';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, ctx.taskId);
    const report = buildDesignCoverage(snapshot);
    const verdict = summariseCoverage(report);
    // The matrix is included so the heat grid can render columns in outline
    // order without a second request; it is the same computation the report
    // already ran, not a parallel source of truth.
    const matrix = buildTraceabilityMatrix(snapshot);
    const unitTitles = Object.fromEntries(
      snapshot.units.map((unit) => [
        unit.id,
        { title: unit.title, code: unit.code, role: unit.unitRole },
      ]),
    );
    return ownerJson({ report, verdict, matrix, unitTitles }, 200, ctx.headers);
  });
}
