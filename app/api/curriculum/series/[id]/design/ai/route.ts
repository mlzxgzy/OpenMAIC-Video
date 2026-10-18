/**
 * POST /api/curriculum/series/[id]/design/ai — 用 AI 起草课程目标与知识体系。
 *
 * 只生成、不落库：草稿由用户看过、改过，再走 PATCH。理由与系列大纲生成一致——
 * 让用户先看到"会写进去什么"，比写完再道歉便宜；而两次点击不会生成两份不同的
 * 东西，因为保存的是用户看过的那一份。
 *
 * 输入除了系列名称与说明，还带上**大纲**：知识体系必须能落回章 / 节 / 目。不带
 * 大纲时模型会写一份通用 CTF 知识树，和用户真实排的 63 目对不上——这正是"生成
 * 出来就脱节"的老问题。
 */
import { NextResponse, type NextRequest } from 'next/server';
import type { Queryable } from '@openmaic/storage/document/pg';

import { createLogger } from '@/lib/logger';
import { isSameOriginJsonRequest } from '@/lib/persistence/owner-claim-http';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute, type DesignContext } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { getSeriesDesign } from '@/lib/server/curriculum/series-design';
import { draftSeriesDesign } from '@/lib/server/curriculum/series-design-step';
import { formatSeriesDirection, SeriesDesignInvalidError } from '@/lib/curriculum/series-design';
import {
  backgroundWorkspaceId,
  SlotDisabledError,
  SlotUnassignedError,
} from '@/lib/server/model-config/runtime';
import { resolveModel } from '@/lib/server/resolve-model';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

const log = createLogger('SeriesDesignAi');

/** 与系列大纲生成共用课程设计模型：这一步生成的是结构，不是素材。 */
const DESIGN_STAGE = 'scene-outlines-stream';

interface OutlineRow extends Record<string, unknown> {
  id: string;
  parent_id: string | null;
  node_type: string;
  code: string | null;
  title: string;
  note: string | null;
  order_index: number | string;
}

interface ItemRow extends Record<string, unknown> {
  code: string | null;
  title: string;
  kind: string | null;
  problem_statement: string | null;
}

const KIND_LABEL: Record<string, string> = {
  theory: '理论',
  practice: '实操',
  review: '综合',
};

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    if (!isSameOriginJsonRequest(req)) {
      return curriculumJsonError(
        403,
        'CURRICULUM_SERIES_DESIGN_INVALID',
        '系列设计生成必须是同源 JSON 请求',
        ctx.headers,
      );
    }

    const snapshot = await getSeriesDesign(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!snapshot) {
      return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', ctx.headers);
    }

    const outlineSummary = await readOutlineSummary(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (outlineSummary.trim() === '') {
      return curriculumJsonError(
        400,
        'CURRICULUM_SERIES_DESIGN_INVALID',
        '这个系列还没有大纲：先建章 / 节 / 目，知识体系才有落点',
        ctx.headers,
      );
    }

    const model = await resolveDesignModel(ctx);
    if ('response' in model) return model.response;

    try {
      const draft = await draftSeriesDesign(
        {
          seriesName: snapshot.series.name,
          seriesDescription: snapshot.series.description,
          directionText: formatSeriesDirection(snapshot.design.direction),
          outlineSummary,
          existing: snapshot.design,
          model: model.value,
        },
        { log, signal: req.signal },
      );
      return ownerJson({ draft, phase: snapshot.phase }, 200, ctx.headers);
    } catch (error) {
      if (req.signal.aborted) {
        return curriculumJsonError(
          499,
          'CURRICULUM_SERIES_DESIGN_FAILED',
          '生成被取消',
          ctx.headers,
        );
      }
      if (error instanceof SeriesDesignInvalidError) {
        log.warn(`Series design answer unusable: ${error.message}`);
        return curriculumJsonError(
          502,
          'CURRICULUM_SERIES_DESIGN_FAILED',
          error.message,
          ctx.headers,
        );
      }
      throw error;
    }
  });
}

/**
 * 大纲的文本形态。章、节、目三层的备注都要带上：章 / 节备注说明那一块覆盖什么，
 * 目备注是这一目的内容要点。知识体系必须落得回去，所以备注是判断"漏没漏"的依据。
 */
async function readOutlineSummary(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<string> {
  const nodes = await queryable.query<OutlineRow>(
    `SELECT id, parent_id, node_type, code, title, note, order_index
       FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2
      ORDER BY order_index, created_at`,
    [ownerId, seriesId],
  );
  const items = await queryable.query<ItemRow>(
    `SELECT code, title, kind, problem_statement
       FROM curriculum_task
      WHERE owner_id = $1 AND series_id = $2
      ORDER BY code, created_at`,
    [ownerId, seriesId],
  );
  if (nodes.rows.length === 0) return '';

  const sectionsOf = new Map<string, OutlineRow[]>();
  const chapters: OutlineRow[] = [];
  for (const node of nodes.rows) {
    if (node.node_type === 'chapter') {
      chapters.push(node);
    } else if (node.parent_id) {
      const list = sectionsOf.get(node.parent_id) ?? [];
      list.push(node);
      sectionsOf.set(node.parent_id, list);
    }
  }
  const lines: string[] = [];
  for (const chapter of chapters) {
    lines.push(`# ${chapter.code ?? ''} ${chapter.title}`.trim());
    if (chapter.note) lines.push(`  章交底：${chapter.note}`);
    for (const section of sectionsOf.get(chapter.id) ?? []) {
      lines.push(`  ## ${section.code ?? ''} ${section.title}`.trim());
      if (section.note) lines.push(`    节交底：${section.note}`);
      const sectionItems = items.rows.filter((item) =>
        item.code && section.code ? item.code.startsWith(`${section.code}-`) : false,
      );
      for (const item of sectionItems) {
        const kind = item.kind ? (KIND_LABEL[item.kind] ?? item.kind) : '未定';
        lines.push(
          `    - ${item.code ?? ''} ${item.title}（${kind}）${
            item.problem_statement ? `：${item.problem_statement}` : ''
          }`,
        );
      }
    }
  }
  return lines.join('\n');
}

async function resolveDesignModel(
  ctx: DesignContext,
): Promise<{ value: Awaited<ReturnType<typeof resolveModel>> } | { response: NextResponse }> {
  try {
    return {
      value: await resolveModel({
        stage: DESIGN_STAGE,
        workspaceId: await backgroundWorkspaceId(ctx.ownerId),
      }),
    };
  } catch (error) {
    if (error instanceof SlotUnassignedError || error instanceof SlotDisabledError) {
      return {
        response: curriculumJsonError(
          400,
          'MISSING_MODEL',
          '没有为课程设计配置语言模型',
          ctx.headers,
        ),
      };
    }
    throw error;
  }
}
