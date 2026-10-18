/**
 * GET  /api/curriculum/series/[id]/outline — 系列的章/节目录（含系列默认 brief）
 * POST /api/curriculum/series/[id]/outline — 新建一章或一节
 *
 * 这一层存在的理由只有一个：章和节必须在任何"目"出现之前就能先存在。驾驶舱
 * 原来把目编号的前缀（`2-1-2` → 第二章）当分组用，那是**降级**，注释里也写着
 * ——它连"第 2 章叫什么"都答不出来，更不可能让用户先建出空章空节。
 *
 * 读取把 `series` 一起带回来，而不是让界面再发一次 `/api/curriculum`：系列页
 * 需要的是新的默认 brief（培训对象、默认学时），那是课程台账快照里没有的东西。
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { parseOutlineNodeInput } from '@/lib/server/curriculum/design-validation';
import {
  createSeriesOutlineNode,
  getCurriculumSeries,
  listSeriesOutline,
} from '@/lib/server/curriculum/store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const series = await getCurriculumSeries(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!series) {
      return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', ctx.headers);
    }
    const nodes = await listSeriesOutline(ctx.queryable, ctx.ownerId, ctx.taskId);
    return ownerJson({ series, nodes }, 200, ctx.headers);
  });
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseOutlineNodeInput(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);
    const node = await ctx.write((tx) =>
      createSeriesOutlineNode(tx, ctx.ownerId, ctx.taskId, parsed.value),
    );
    return ownerJson({ node }, 201, ctx.headers);
  });
}
