/**
 * 第五步「教学内容」的草稿：把 `CourseTeachingResult` 算成草稿行。
 *
 * 这是七个阶段里**最简单**的一个转换，而它简单的原因值得写下来：
 *
 * 1. **只有 patch，没有新建、没有删除。** 教学设计是给已有条目写"讲什么、怎么讲"，
 *    而条目在大纲那一步就已经全部建好了。所以这一份草稿里每一行都是 `PATCH /units/<id>`，
 *    没有 `create`、没有 `replaceFromLive`、没有多跳——引擎那些能力在这里一个都用不上。
 *
 *    这不是巧合，是**阶段划分的直接结果**：一个阶段如果只能"改"，它的草稿就必然简单，
 *    而一个复杂的草稿（第三步有整表替换的连线、第四步有整表替换的覆盖）说明那个阶段
 *    还在做"建"这件事。所以"草稿有多复杂"是一个可以反过来读阶段定义的信号。
 *
 * 2. **一次 PATCH 写两个字段：`teachingDesign` 与 `deckDesign`。** 与 `teaching/turn`
 *    路由同一个做法（`updateCurriculumUnit` 那次调用就给这两样）。摊成两行会承诺"只改
 *    分镜不改脚本"这种操作，而 `updateCurriculumUnit` 是整字段替换，第二次写会把第一次
 *    清掉——那不是覆盖，是丢失。
 *
 * 3. **条目名不可改。** 改条目标题是改大纲，而大纲已经签过字了。这里给改写入口等于让
 *    一个已签收的步骤被顺手改掉，而且改完之后大纲那一步的签收不再覆盖它了。
 */

import { dropNullEnums, uniqueMessages } from './draft-body';
import { assertDraftRouteSafe, type StepDraft, type StepDraftLine } from './step-draft';
import type { CourseTeachingResult } from '@/lib/server/curriculum/teaching-step';
import type { TeachingBoard } from '@/lib/curriculum/design-teaching';

const BASE = '/api/curriculum/design/tasks';

function taskRoute(taskId: string, ...segments: string[]): string {
  return assertDraftRouteSafe([BASE, taskId, ...segments].join('/'));
}

export interface TeachingDraftInput {
  turn: CourseTeachingResult;
  board: TeachingBoard;
  taskId: string;
  instruction: string;
}

/** 结果 → 草稿行。 */
export function teachingDraftOf(input: TeachingDraftInput): StepDraft {
  const { turn, board, taskId } = input;
  const titleById = new Map(board.items.map((item) => [item.id, item.title]));
  const lines: StepDraftLine[] = [];

  for (const [unitId, patch] of turn.patches) {
    const title = titleById.get(unitId) ?? unitId.slice(0, 8);
    const pages = patch.deckDesign?.pages?.length ?? 0;
    lines.push({
      id: `teaching:patch-${unitId}`,
      text: `给「${title}」写授课脚本` + (pages > 0 ? `，并配 ${pages} 页分镜` : '，分镜还没写'),
      // 刻意不给 `name`／`nameKey`：条目标题是已签收的大纲，不在这一步里改。见文件头第 3 条。
      write: {
        method: 'PATCH',
        route: taskRoute(taskId, 'units', unitId),
        // 这两个都是 `record` 读的结构，不是枚举；过一遍 `dropNullEnums` 只是让"六个转换
        // 函数都走同一条出口"这件事成立——将来这一步多一个枚举字段时不会只有一个文件漏掉。
        body: dropNullEnums({
          teachingDesign: patch.teachingDesign,
          deckDesign: patch.deckDesign,
        }).body,
      },
    });
  }

  for (const text of [
    ...turn.unmatchedRefs.map((ref) => `没找到「${ref}」，这一条没写进去`),
    ...turn.rejectedRefs.map((ref) => `没照做：${ref}`),
    // 提示不是缺口，所以和前两类分开列——界面上它们是"看一眼"而不是"等你决定"。
    ...turn.advisories.map((text) => `提醒：${text}`),
  ]) {
    lines.push({ id: `teaching:note-${lines.length}`, text, note: text });
  }

  return {
    lines,
    message: turn.message,
    warnings: uniqueMessages(turn.gaps.map((gap) => gap.text)),
    instruction: input.instruction,
  };
}
