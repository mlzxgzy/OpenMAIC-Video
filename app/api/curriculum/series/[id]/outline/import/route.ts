/**
 * POST /api/curriculum/series/[id]/outline/import — 从一份大纲文本建出整片骨架
 *
 * 两种模式共用一套解析：
 * - `preview`：只解析、不写库。返回树与逐行问题，界面据此让作者改文本。
 * - `commit`：解析通过后，一个事务里建出全部章、节、目。
 *
 * 三条拒绝规则，都是为了让"导入"只能是**从零建骨架**这一件事：
 * 1. 文本有任何解析错误 → 400，并列出每一行。半份大纲比没有更危险：用户会
 *    以为剩下的目只是还没建，而它们其实被静默丢掉了。
 * 2. 这个系列已经有大纲节点 → 409。再导一次会得到两套 1-1-1，而编号是唯一的。
 * 3. 这个系列已经有目（老路径建的）→ 409。导入建的目按编号唯一，撞上就整批
 *    失败；这里提前说清楚，而不是让用户面对一个 23505。
 *
 * 目创建时继承系列默认 brief（培训对象、默认学时），内容要点写成
 * `problem_statement` 的草稿。作者仍然要逐目确认——第 1 步的门禁读的是"他同意
 * 过这句话"，不是"这句话存在"。
 */
import type { NextRequest } from 'next/server';

import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { runDesignRoute } from '@/lib/server/curriculum/design-http';
import { curriculumJsonError } from '@/lib/server/curriculum/http';
import { parseOutlineImportRequest } from '@/lib/server/curriculum/design-validation';
import { parseOutlineText, type OutlineImportItem } from '@/lib/curriculum/outline-import';
import { createCurriculumTask, listCurriculumTasks } from '@/lib/server/curriculum/design-store';
import {
  createSeriesOutlineNode,
  getCurriculumSeries,
  listSeriesOutline,
} from '@/lib/server/curriculum/store';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

/**
 * 内容要点 → `problem_statement` 草稿。
 *
 * 不假装它是学习成果：`problem_statement` 的契约是"学完能做什么"，而大纲里的
 * 要点多是主题清单。这里写一句作者一眼能改的草稿，而不是留空——五十四目各写
 * 一遍同样的话，才是用户抱怨"不知道怎么下笔"的原因。
 */
function draftProblemStatement(item: OutlineImportItem): string | null {
  if (!item.note) return null;
  return `学完这一目，能说清并处理：${item.note}`;
}

export async function POST(req: NextRequest, { params }: Params) {
  return runDesignRoute(req, params, async (ctx) => {
    const parsed = parseOutlineImportRequest(await ctx.body());
    if (!parsed.ok)
      return curriculumJsonError(400, 'CURRICULUM_DESIGN_INVALID', parsed.message, ctx.headers);

    const outline = parseOutlineText(parsed.value.text);
    if (parsed.value.mode === 'preview') {
      return ownerJson({ preview: outline }, 200, ctx.headers);
    }

    if (outline.issues.length > 0) {
      return curriculumJsonError(
        400,
        'CURRICULUM_OUTLINE_INVALID',
        `大纲有 ${outline.issues.length} 处问题：${outline.issues
          .slice(0, 5)
          .map((issue) => `第 ${issue.line} 行 ${issue.message}`)
          .join('；')}`,
        ctx.headers,
      );
    }

    const series = await getCurriculumSeries(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (!series) {
      return curriculumJsonError(404, 'CURRICULUM_SERIES_NOT_FOUND', '课程系列不存在', ctx.headers);
    }
    const existingNodes = await listSeriesOutline(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (existingNodes.length > 0) {
      return curriculumJsonError(
        409,
        'CURRICULUM_OUTLINE_CONFLICT',
        '这个系列已经有大纲了。导入只用于从零建骨架；要重来请先删掉现有的章和节。',
        ctx.headers,
      );
    }
    const existingTasks = await listCurriculumTasks(ctx.queryable, ctx.ownerId, ctx.taskId);
    if (existingTasks.length > 0) {
      return curriculumJsonError(
        409,
        'CURRICULUM_OUTLINE_CONFLICT',
        '这个系列已经有目了。导入建的目按编号唯一，会和现有目标号冲突。',
        ctx.headers,
      );
    }

    const imported = await ctx.write(async (tx) => {
      let sectionCount = 0;
      let itemCount = 0;
      for (const chapter of outline.chapters) {
        const chapterNode = await createSeriesOutlineNode(tx, ctx.ownerId, ctx.taskId, {
          nodeType: 'chapter',
          title: chapter.title,
          code: chapter.code,
          note: chapter.note,
        });
        for (const section of chapter.sections) {
          const sectionNode = await createSeriesOutlineNode(tx, ctx.ownerId, ctx.taskId, {
            nodeType: 'section',
            parentId: chapterNode.id,
            title: section.title,
            code: section.code,
            note: section.note,
          });
          sectionCount += 1;
          for (const [itemIndex, item] of section.items.entries()) {
            await createCurriculumTask(tx, ctx.ownerId, {
              seriesId: ctx.taskId,
              sectionId: sectionNode.id,
              title: item.title,
              code: item.code,
              kind: item.kind,
              orderIndex: itemIndex + 1,
              audience: series.audience,
              durationHours: item.hours ?? series.defaultHours ?? null,
              problemStatement: draftProblemStatement(item),
            });
            itemCount += 1;
          }
        }
      }
      return { chapters: outline.chapters.length, sections: sectionCount, items: itemCount };
    });

    return ownerJson({ imported }, 201, ctx.headers);
  });
}
