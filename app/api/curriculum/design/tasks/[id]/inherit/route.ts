/**
 * POST /api/curriculum/design/tasks/[id]/inherit —— 把系列层的课程目标 / 知识节点
 * 承接进这一目。
 *
 * 第 2、3 步的目标不在目里：课程目标与知识体系属于整个系列，目只**承接**其中
 * 相关的几条。没有这个入口，用户在每个目里都得从零重写一遍目标——这正是
 * 「每个目都要七步」的来源。
 *
 * 请求体只有一个形状：
 *
 * ```json
 * { "kind": "objectives", "ids": ["sobj_1", "sobj_2"] }
 * ```
 *
 * `kind` 决定承接哪一层，而不是开两个路由：两层的校验、错误映射和返回信封完全
 * 相同，唯一的区别是调哪个函数；两条路由会各自漂移一点。
 *
 * 幂等由 store 保证（来源 id 相同即跳过），所以重复点击不会造出重复行——界面
 * 因此可以放心把"承接"做成一个可反复按的按钮。
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { designInvalid, runDesignRoute } from '@/lib/server/curriculum/design-http';
import { inheritSeriesNodes, inheritSeriesObjectives } from '@/lib/server/curriculum/design-store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/** 一次最多承接多少条。超过它说明不是"挑几条"，而是一次性灌一整个系列。 */
const MAX_IDS = 200;

type InheritKind = 'objectives' | 'nodes';

function parseInheritBody(
  raw: unknown,
): { ok: true; kind: InheritKind; ids: string[] } | { ok: false; message: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, message: '请求体必须是一个对象：{ kind, ids }。' };
  }
  const body = raw as Record<string, unknown>;
  const kind = body.kind;
  if (kind !== 'objectives' && kind !== 'nodes') {
    return { ok: false, message: 'kind 只能是 "objectives" 或 "nodes"。' };
  }
  if (!Array.isArray(body.ids) || body.ids.length === 0) {
    return { ok: false, message: 'ids 必须是非空数组：要承接的系列目标 / 知识点 id。' };
  }
  if (body.ids.length > MAX_IDS) {
    return { ok: false, message: `一次最多承接 ${MAX_IDS} 条。` };
  }
  const ids: string[] = [];
  for (const entry of body.ids) {
    if (typeof entry !== 'string' || entry.trim() === '') {
      return { ok: false, message: 'ids 里的每一项都必须是非空字符串。' };
    }
    ids.push(entry.trim());
  }
  return { ok: true, kind, ids: [...new Set(ids)] };
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseInheritBody(await ctx.body());
    if (!parsed.ok) return designInvalid(parsed.message, ctx.headers);

    const result =
      parsed.kind === 'objectives'
        ? await ctx.write((tx) => inheritSeriesObjectives(tx, ctx.ownerId, ctx.taskId, parsed.ids))
        : await ctx.write((tx) => inheritSeriesNodes(tx, ctx.ownerId, ctx.taskId, parsed.ids));

    return ownerJson({ kind: parsed.kind, ...result }, 201, ctx.headers);
  });
}
