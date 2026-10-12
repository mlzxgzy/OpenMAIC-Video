/**
 * GET    /api/curriculum/design/tasks/[id]/knowledge — the graph's sign-off state.
 * POST   /api/curriculum/design/tasks/[id]/knowledge — 用户确认知识技能图.
 * DELETE /api/curriculum/design/tasks/[id]/knowledge — 撤回确认，重新打开这一步.
 *
 * The same three verbs as step 2's state route, and the same reasoning: the
 * confirmation is what the phase machine reads before `graph → outline`, this
 * route is the half a person drives, and the AI conversation writes the graph
 * (`.../knowledge/turn`) and may record its own confirmation as `assistant`.
 *
 * POST refuses an incomplete graph on purpose, and step 3's "incomplete" is
 * stronger than step 2's: a graph is complete only when it is connected at
 * **both** ends — every node supports an outcome *and* every outcome has a node.
 * Confirming a half-connected graph produces a state where the author believes
 * step 3 is done while the outline stage would have nothing to teach for the
 * unsupported outcomes.
 *
 * `DELETE` answers 404 when there was nothing to withdraw rather than pretending
 * it succeeded, so a double-click cannot look like a sign-off.
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import {
  designInvalid,
  runDesignRoute,
  type DesignContext,
} from '@/lib/server/curriculum/design-http';
import {
  confirmCurriculumDesignStep,
  getCurriculumDesignSnapshot,
  getCurriculumTask,
  withdrawCurriculumDesignStep,
} from '@/lib/server/curriculum/design-store';
import { knowledgeGapsOfRecords } from '@/lib/curriculum/design-knowledge';
import { knowledgeState } from '@/lib/server/curriculum/knowledge-state';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The note is free text from the dialog; the column is not a log. */
const MAX_NOTE_CHARS = 500;

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(
      await knowledgeState(
        ctx,
        task.id,
        snapshot.nodes,
        snapshot.nodeObjectives,
        snapshot.objectives,
        snapshot.dependencies,
      ),
      200,
      ctx.headers,
    );
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const gaps = knowledgeGapsOfRecords(
      snapshot.nodes.map((row) => ({ id: row.id, name: row.name, nodeType: row.nodeType })),
      snapshot.nodeObjectives,
      snapshot.objectives.map((row) => ({ id: row.id, title: row.title })),
    );
    if (gaps.length > 0) {
      return designInvalid(
        `知识技能图还不完整，先补齐：${gaps.map((gap) => gap.text).join('；')}`,
        ctx.headers,
      );
    }
    const note = await readNote(ctx);
    await ctx.write((tx) =>
      confirmCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'graph', 'user', note),
    );
    return ownerJson(
      await knowledgeState(
        ctx,
        task.id,
        snapshot.nodes,
        snapshot.nodeObjectives,
        snapshot.objectives,
        snapshot.dependencies,
      ),
      200,
      ctx.headers,
    );
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const removed = await ctx.write((tx) =>
      withdrawCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'graph'),
    );
    if (!removed) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: '知识技能图还没有确认，没有可撤回的确认',
          },
        },
        404,
        ctx.headers,
      );
    }
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(
      await knowledgeState(
        ctx,
        task.id,
        snapshot.nodes,
        snapshot.nodeObjectives,
        snapshot.objectives,
        snapshot.dependencies,
      ),
      200,
      ctx.headers,
    );
  });
}

function notFound(ctx: DesignContext) {
  return ownerJson(
    { error: { code: 'CURRICULUM_DESIGN_NOT_FOUND', message: '课程设计任务不存在' } },
    404,
    ctx.headers,
  );
}

/**
 * The optional `{ note }` on a confirm.
 *
 * The button sends no body at all, so an absent or unparseable body is not an
 * error here — it means "the user clicked". Being strict about it would turn the
 * simplest path (a click) into a 400 the caller has to work around.
 */
async function readNote(ctx: DesignContext) {
  try {
    const body = await ctx.body();
    if (body && typeof body === 'object' && !Array.isArray(body)) {
      const note = (body as { note?: unknown }).note;
      if (typeof note === 'string' && note.trim() !== '') {
        return note.trim().slice(0, MAX_NOTE_CHARS);
      }
    }
  } catch {
    // No body: the confirmation is still a confirmation.
  }
  return null;
}
