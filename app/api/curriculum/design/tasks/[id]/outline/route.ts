/**
 * GET    /api/curriculum/design/tasks/[id]/outline — the outline's sign-off state.
 * POST   /api/curriculum/design/tasks/[id]/outline — 作者确认课程大纲.
 * DELETE /api/curriculum/design/tasks/[id]/outline — 撤回确认，重新打开这一步.
 *
 * The same three verbs as steps 2 and 3's state routes, and the same reasoning:
 * the confirmation is what the phase machine reads before `outline → teaching`,
 * this route is the half a person drives, and the AI conversation writes the
 * outline (`.../outline/turn`) and may record its own confirmation as
 * `assistant`.
 *
 * POST refuses an incomplete outline on purpose. Step 5's "incomplete" is the
 * gate to the next phase read from the front: every outcome has to be taught by
 * an item, every item has to cover something, chapters may not carry coverage,
 * and the delivery order may not contradict the ordering claims the author signed
 * in step 3. Confirming with any of those open produces a state where the author
 * believes the outline is settled while the teaching phase builds lessons on top
 * of an outcome nobody teaches, or in an order the graph says is wrong.
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
import {
  outlineAuditFindings,
  outlineGapsOfSnapshot,
  outlineState,
} from '@/lib/server/curriculum/outline-state';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** The note is free text from the dialog; the column is not a log. */
const MAX_NOTE_CHARS = 500;

/**
 * Everything that blocks signing the outline, in the words the card shows.
 *
 * The rules' own gaps plus the audit's unit-ordering findings: two sources, one
 * list, because the author reads one list.
 */
function outlineBlockers(snapshot: Awaited<ReturnType<typeof getCurriculumDesignSnapshot>>) {
  return [
    ...outlineGapsOfSnapshot(snapshot).map((gap) => gap.text),
    ...outlineAuditFindings(snapshot).map((finding) => finding.message),
  ];
}

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(await outlineState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    const blockers = outlineBlockers(snapshot);
    if (blockers.length > 0) {
      return designInvalid(`课程大纲还不完整，先补齐：${blockers.join('；')}`, ctx.headers);
    }
    const note = await readNote(ctx);
    await ctx.write((tx) =>
      confirmCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'outline', 'user', note),
    );
    return ownerJson(await outlineState(ctx, task.id, snapshot), 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!task) return notFound(ctx);
    const removed = await ctx.write((tx) =>
      withdrawCurriculumDesignStep(tx, ctx.ownerId, ctx.taskId, 'outline'),
    );
    if (!removed) {
      return ownerJson(
        {
          error: {
            code: 'CURRICULUM_DESIGN_NOT_FOUND',
            message: '课程大纲还没有确认，没有可撤回的确认',
          },
        },
        404,
        ctx.headers,
      );
    }
    const snapshot = await getCurriculumDesignSnapshot(ctx.queryable, ctx.ownerId, task.id);
    return ownerJson(await outlineState(ctx, task.id, snapshot), 200, ctx.headers);
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
