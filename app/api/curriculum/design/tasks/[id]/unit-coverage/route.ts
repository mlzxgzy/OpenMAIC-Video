/**
 * POST /api/curriculum/design/tasks/[id]/unit-coverage — record that one item
 * teaches, practises or assesses one outcome.
 * PUT /api/curriculum/design/tasks/[id]/unit-coverage — replace the whole set.
 *
 * `coverageKind` is the field that replaced the old single `coverage_level`
 * enum. Teach, practice and assess are independent: an outcome can be taught
 * and never assessed, and collapsing the three into one value is exactly what
 * made the previous model unable to answer "was this assessed?". Three rows
 * per outcome is the closed loop the export gate requires.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import {
  createCurriculumUnitCoverage,
  setCurriculumUnitCoverage,
} from '@/lib/server/curriculum/design-store';
import {
  parseUnitCoverageInput,
  parseUnitCoverageSet,
} from '@/lib/server/curriculum/design-validation';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseUnitCoverageInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const coverage = await ctx.write((tx) =>
      createCurriculumUnitCoverage(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ coverage }, 201, ctx.headers);
  });
}

export async function PUT(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseUnitCoverageSet(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const rows = await ctx.write((tx) =>
      setCurriculumUnitCoverage(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ rows }, 200, ctx.headers);
  });
}
