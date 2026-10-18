/**
 * 系列大纲 AI 生成的落库侧：读现状、按计划写库。
 *
 * 与纯函数层（`lib/curriculum/series-outline-ai.ts`）的分工：那边回答"写什么、
 * 删什么、跳过什么"，这边只负责把那份计划翻译成 store 调用。所有"能不能覆盖"
 * 的判断都不在这里——重复一份规则，两份迟早会不一致。
 *
 * 两个实现细节值得知道：
 *
 * 1. **更新鲜度不是 `design_phase` 一个字段。** 目在第一步（课程方向）之前
 *    就是 `design_phase = 'task'`，但那时它可能已经有目标、条目或审核发现——
 *    那些数据只会在第 2 步以后出现。覆盖只在"这一目没有任何下游数据"时才安全，
 *    所以这里逐表 NOT EXISTS，而不是只看阶段名。
 * 2. **写入顺序是先删后建。** 章/节编号由"现有最大 order_index + 1"推导，
 *    先删掉旧的才能让重建的编号从 `1` 开始；反过来会得到 `7`、`8` 这种接续编号，
 *    用户对着大纲核数时立刻会问"前六章呢"。
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  type SeriesOutlineAiAppliedSummary,
  type SeriesOutlineAiContext,
  type SeriesOutlineAiDesign,
  type SeriesOutlineAiSummary,
  SeriesOutlineAiConflictError,
} from '@/lib/curriculum/series-outline-ai';
import { seriesDesignComplete } from '@/lib/curriculum/series-design';

import { createCurriculumTask, deleteCurriculumTask, listCurriculumTasks } from './design-store';
import { getSeriesDesign } from './series-design';
import {
  createSeriesOutlineNode,
  deleteSeriesOutlineNode,
  getCurriculumSeries,
  listSeriesOutline,
} from './store';

/**
 * 读这个系列此刻的章、节、目，以及每一目是否"还没开始设计"。
 *
 * 返回 null 表示系列不存在（路由答 404）；owner 隔离由 store 的查询保证。
 */
export async function readSeriesOutlineAiContext(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<SeriesOutlineAiContext | null> {
  const series = await getCurriculumSeries(queryable, ownerId, seriesId);
  if (!series) return null;

  const nodes = await listSeriesOutline(queryable, ownerId, seriesId);
  const tasks = await listCurriculumTasks(queryable, ownerId, seriesId);
  const design = await readSeriesDesignForOutline(queryable, ownerId, seriesId);

  const freshness = await queryable.query<{ id: string; untouched: boolean }>(
    `SELECT t.id,
            (t.design_phase = 'task'
             AND NOT EXISTS (SELECT 1 FROM curriculum_objective o WHERE o.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_evidence e WHERE e.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_learning_node n WHERE n.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_unit u WHERE u.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_question q WHERE q.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_lab_task l WHERE l.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_audit_finding f WHERE f.task_id = t.id)
             AND NOT EXISTS (SELECT 1 FROM curriculum_design_confirmation c WHERE c.task_id = t.id)
            ) AS untouched
       FROM curriculum_task t
      WHERE t.owner_id = $1 AND t.series_id = $2`,
    [ownerId, seriesId],
  );
  const untouched = new Set(
    freshness.rows.filter((row) => row.untouched === true).map((row) => row.id),
  );

  const chapters = nodes
    .filter((node) => node.nodeType === 'chapter')
    .map((node) => ({
      id: node.id,
      code: node.code ?? String(node.orderIndex),
      title: node.title,
      note: node.note,
      sectionCount: nodes.filter(
        (candidate) => candidate.nodeType === 'section' && candidate.parentId === node.id,
      ).length,
    }));

  const itemCountBySection = new Map<string, number>();
  const untouchedCountBySection = new Map<string, number>();
  for (const task of tasks) {
    if (!task.sectionId) continue;
    itemCountBySection.set(task.sectionId, (itemCountBySection.get(task.sectionId) ?? 0) + 1);
    if (untouched.has(task.id)) {
      untouchedCountBySection.set(
        task.sectionId,
        (untouchedCountBySection.get(task.sectionId) ?? 0) + 1,
      );
    }
  }

  const sections = nodes
    .filter((node) => node.nodeType === 'section' && node.parentId !== null)
    .map((node) => ({
      id: node.id,
      code: node.code ?? String(node.orderIndex),
      title: node.title,
      note: node.note,
      chapterId: node.parentId as string,
      itemCount: itemCountBySection.get(node.id) ?? 0,
      untouchedItemCount: untouchedCountBySection.get(node.id) ?? 0,
    }));

  return {
    series: {
      id: series.id,
      name: series.name,
      description: series.description,
      audience: series.audience,
      defaultHours: series.defaultHours,
    },
    design,
    chapters,
    sections,
    items: tasks.map((task) => ({
      id: task.id,
      code: task.code,
      title: task.title,
      sectionId: task.sectionId,
      kind: task.kind,
      untouched: untouched.has(task.id),
    })),
  };
}

/**
 * 把系列设计翻译成提示词要的形状。
 *
 * 大纲的每一层都以它为据：章回答"这些课程目标由哪几块内容组织"，节与目回答
 * "这块内容兑现哪些目标、用到哪些知识点"。逐字抄进提示词而不是摘要，是因为
 * 摘要会丢掉"最低达标线"和"先修"——而那正是让模型不把章拆成知识点清单的约束。
 *
 * 读失败不抛出：设计读不到比整份大纲生成失败轻得多；返回 null 后提示词会明说
 * "只能按名称与说明生成"，用户至少能看到一份有标注的草稿。
 */
async function readSeriesDesignForOutline(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<SeriesOutlineAiDesign | null> {
  try {
    const snapshot = await getSeriesDesign(queryable, ownerId, seriesId);
    if (!snapshot) return null;
    const doc = snapshot.design;
    const nodeNames = new Map(doc.nodes.map((node) => [node.id, node.name]));
    const complete = seriesDesignComplete(doc);
    return {
      complete,
      // 未定完时只列会挡住"前三步完成"的缺口；定完后不再提示，避免把质量建议
      // （例如"所有节点都没有先修"）混成"还差一项才能继续"。
      gaps: complete ? [] : [...snapshot.gaps.direction, ...snapshot.gaps.objectives],
      direction: {
        learnerLevel: doc.direction.learnerLevel,
        trainingScenario: doc.direction.trainingScenario,
        applicationScene: doc.direction.applicationScene,
        problemStatement: doc.direction.problemStatement,
      },
      objectives: doc.objectives.map((objective) => ({
        title: objective.title,
        expectedBehavior: objective.expectedBehavior,
        minCriteria: objective.minCriteria,
        evidence: objective.evidence,
      })),
      nodes: doc.nodes.map((node) => ({
        name: node.name,
        summary: node.summary,
        difficulty: node.difficulty,
        prerequisites: node.prerequisites.map((id) => nodeNames.get(id) ?? id),
      })),
    };
  } catch (error) {
    console.error('[series-outline] 读取系列设计失败，按"没有设计"生成:', error);
    return null;
  }
}

/** 内容要点 → 这一目第 1 步的 brief 草稿，与导入路径同一句话。 */
function draftProblemStatement(note: string | null): string | null {
  return note ? `学完这一目，能说清并处理：${note}` : null;
}

/**
 * 把一份已经过规则层确认的计划写进库。
 *
 * 调用方必须在同一个事务里先 `readSeriesOutlineAiContext`、再 `plan…Apply`、
 * 最后调用这里：`summary` 里引用的节/章 id 来自那次读取，事务外再读一遍会让
 * 计划和库对不上。
 */
export async function applySeriesOutlineAiPlan(
  queryable: Queryable,
  ownerId: string,
  context: SeriesOutlineAiContext,
  summary: SeriesOutlineAiSummary,
): Promise<SeriesOutlineAiAppliedSummary> {
  for (const chapterId of summary.removeChapterIds) {
    await deleteSeriesOutlineNode(queryable, ownerId, context.series.id, chapterId);
  }
  for (const sectionId of summary.removeSectionIds) {
    await deleteSeriesOutlineNode(queryable, ownerId, context.series.id, sectionId);
  }
  for (const itemId of summary.removeItemIds) {
    await deleteCurriculumTask(queryable, ownerId, itemId);
  }

  // 章在本次事务里没有被动过（节/目层的生成），所以这个映射仍然有效。
  const chapterIdByCode = new Map(context.chapters.map((chapter) => [chapter.code, chapter.id]));
  for (const draft of summary.chapters) {
    await createSeriesOutlineNode(queryable, ownerId, context.series.id, {
      nodeType: 'chapter',
      title: draft.title,
      note: draft.note,
    });
  }
  for (const draft of summary.sections) {
    const parentId = chapterIdByCode.get(draft.chapterCode);
    if (!parentId) {
      throw new SeriesOutlineAiConflictError(
        `第 ${draft.chapterCode} 章已经不存在，无法把节挂上去；请重新生成。`,
      );
    }
    await createSeriesOutlineNode(queryable, ownerId, context.series.id, {
      nodeType: 'section',
      parentId,
      title: draft.title,
      note: draft.note,
    });
  }
  for (const draft of summary.items) {
    const sectionId = context.sections.find((section) => section.code === draft.sectionCode)?.id;
    if (!sectionId) {
      throw new SeriesOutlineAiConflictError(
        `第 ${draft.sectionCode} 节已经不存在，无法把目挂上去；请重新生成。`,
      );
    }
    await createCurriculumTask(queryable, ownerId, {
      seriesId: context.series.id,
      sectionId,
      title: draft.title,
      kind: draft.kind,
      durationHours: draft.hours ?? context.series.defaultHours ?? null,
      audience: context.series.audience,
      problemStatement: draftProblemStatement(draft.note),
    });
  }

  return {
    created: {
      chapters: summary.chapters.length,
      sections: summary.sections.length,
      items: summary.items.length,
    },
    removed: {
      chapters: summary.removeChapterIds.length,
      sections: summary.removeSectionIds.length,
      items: summary.removeItemIds.length,
    },
  };
}
