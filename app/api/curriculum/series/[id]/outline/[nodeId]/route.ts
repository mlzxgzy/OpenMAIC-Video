/**
 * PATCH  /api/curriculum/series/[id]/outline/[nodeId] — 改章节的标题、说明、顺序
 * DELETE /api/curriculum/series/[id]/outline/[nodeId] — 删掉一章或一节
 *
 * 编号与父级不可改（见 `SeriesOutlineNodePatch`）：编号是目的前缀，改它会让
 * 已建目的编号对不上；换父级会让节的编号前缀说谎。要重组结构就删掉重建。
 *
 * 删节不会删目：`curriculum_task.section_id` 是 `ON DELETE SET NULL`，那些目
 * 退回"未归类"，而不是跟着分类一起消失。
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, requiredParam, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { parseOutlineNodePatch } from '@/lib/server/curriculum/design-validation';
import { deleteSeriesOutlineNode, updateSeriesOutlineNode } from '@/lib/server/curriculum/store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string; nodeId: string }> };

export async function PATCH(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseOutlineNodePatch(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const node = await ctx.write((tx) =>
      updateSeriesOutlineNode(
        tx,
        ctx.ownerId,
        ctx.taskId,
        requiredParam(ctx, 'nodeId'),
        parsed.value,
      ),
    );
    return ownerJson({ node }, 200, ctx.headers);
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    await ctx.write((tx) =>
      deleteSeriesOutlineNode(tx, ctx.ownerId, ctx.taskId, requiredParam(ctx, 'nodeId')),
    );
    return ownerJson({ deleted: true }, 200, ctx.headers);
  });
}
