/**
 * 第四步「课程大纲」的草稿：把 `CourseOutlineResult` 算成草稿行。
 *
 * 与第二步不同的三件事，每件都因为大纲的形状而必须自己处理：
 *
 * 1. **父级可以是同一轮的另一条 draft。** 章、节、目一次给全，模型按"目在前、节在后"
 *    列出是很自然的。所以子条目的 `parentId` 填的**不是**一个 id，而是"依赖哪一行产出
 *    它"——这正是 {@link StepDraftCreate.needs} 存在的场景。指向后面那条 draft 的父级同样
 *    成立：它不是"还没落地所以不可按"，而是"等它落地"，而 {@link StepDraftLine} 不区分这两
 *    种情况，因为对作者来说都是"按了父级再来按它"。
 * 2. **覆盖关系是整表替换。** `PUT /unit-coverage` 先删后插（`parseUnitCoverageSet` 要求
 *    完整的 `rows`），少带一行就悄悄删掉它——那不会报错，它只会让后面某个目标变成"没东西
 *    可教"。所以这类行用 `replaceFromLive`：body 在**采纳那一刻**按当前库重算，连按两行不
 *    会互相抹掉。这是 `outline/turn` 路由里那段 `coverageRows` 的做法，只是那里的对照物是
 *    "这一轮开始前的库"，而这里必须是"采纳这一刻的库"。
 * 3. **新建条目顺带带上的覆盖，跟着这一行走，不单列。** 与第三步"连线跟着节点走"同一条
 *    规则：没有"只写这一条覆盖"这种粒度。
 *
 * 一个**刻意不给**的东西：章节行没有"改一改"。章节的标题是下面所有条目的寻址句柄，改名
 * 一章意味着下面那些行的"来源"描述同时过期——那是一次牵一发动的改动，不该由一个单行
 * 输入框假装能做。条目行的改名也只在 `unitRole`/`hours` 之外有意义时才有，所以那里也只给
 * `title`。
 */

import { dropNullEnums, nullEnumDroppedWarning, uniqueMessages } from './draft-body';
import { assertDraftRouteSafe, FRESH_ID, type StepDraft, type StepDraftLine } from './step-draft';
import type { CourseOutlineResult, OutlineBoard } from '@/lib/server/curriculum/outline-step';
import { draftCoverageOf } from '@/lib/server/curriculum/outline-step';
import type { OutlineUnitDraft } from '@/lib/curriculum/design-outline';

const BASE = '/api/curriculum/design/tasks';

function taskRoute(taskId: string, ...segments: string[]): string {
  return assertDraftRouteSafe([BASE, taskId, ...segments].join('/'));
}

export interface OutlineDraftInput {
  turn: CourseOutlineResult;
  board: OutlineBoard;
  taskId: string;
  instruction: string;
}

/** 一行 draft 自己的行 id：靠 `ref` 寻址，所以 ref 就是它的身份。 */
function addedLineId(ref: string | null, index: number): string {
  return `outline:added-${ref ?? index}`;
}

/** 结果 → 草稿行。行序是"删除 → 新建 → 改写 → 覆盖 → 说明"。 */
export function outlineDraftOf(input: OutlineDraftInput): StepDraft {
  const { turn, board, taskId } = input;
  const route = (...segments: string[]) => taskRoute(taskId, ...segments);
  const titleById = new Map(board.units.map((unit) => [unit.id, unit.title]));
  const knownObjectiveIds = new Set(board.objectives.map((objective) => objective.id));
  const draftTitleByRef = new Map(
    turn.creates.map((create) => [create.draft.ref, create.draft.title]),
  );
  const lines: StepDraftLine[] = [];
  const warnings: string[] = [];

  for (const unitId of turn.removed) {
    lines.push({
      id: `outline:removed-${unitId}`,
      text: `删除「${titleById.get(unitId) ?? unitId.slice(0, 8)}」`,
      write: { method: 'DELETE', route: route('units', unitId) },
    });
  }

  turn.creates.forEach((create, index) => {
    const draft: OutlineUnitDraft = create.draft;
    const lineId = addedLineId(draft.ref, index);
    const parentTitle =
      create.parentDraftRef !== null
        ? (draftTitleByRef.get(create.parentDraftRef) ?? null)
        : create.parentId === null
          ? null
          : (titleById.get(create.parentId) ?? null);
    const needs =
      create.parentDraftRef === null
        ? []
        : [
            {
              lineId: addedLineId(create.parentDraftRef, -1),
              key: 'parentId',
              label: `父级「${draftTitleByRef.get(create.parentDraftRef) ?? create.parentDraftRef}」`,
            },
          ];
    const body: Record<string, unknown> = {
      title: draft.title,
      unitType: draft.unitType,
      // 顺序号由 `parseUnitInput` 的缺省决定：草稿不替作者决定新条目排在第几位，而
      // `turn.creates[].orderIndex` 是规则层按"追加"算出来的，作者没有表达过这个意图。
    };
    if (draft.unitRole !== null) body.unitRole = draft.unitRole;
    if (draft.hours !== null) body.hours = draft.hours;

    const coverage = draftCoverageOf(draft, knownObjectiveIds);
    lines.push({
      id: lineId,
      name: draft.title,
      nameKey: 'title',
      text:
        draft.unitType === 'chapter'
          ? `新建章「${draft.title}」` +
            (coverage.length > 0 ? `，并带上 ${coverage.length} 条覆盖关系` : '')
          : `新建条目「${draft.title}」` +
            (parentTitle ? `，挂在「${parentTitle}」下面` : '，放在顶层') +
            (coverage.length > 0 ? `，并带上 ${coverage.length} 条覆盖关系` : ''),
      create: {
        route: route('units'),
        // `unitRole` 由 `oneOf` 读，显式 `null` 是"取值非法"——见 `draft-body.ts`。
        body: dropNullEnums(body, FIELD_LABELS).body,
        idKey: 'unit',
        ...(needs.length > 0 ? { needs } : {}),
        // 覆盖跟着新建的这一行走：`setCurriculumUnitCoverage` 是整表替换，没有"只写这一
        // 条"这种粒度，所以摊成独立行就是承诺一个做不出来的操作。
        then: coverage.map((row) => ({
          method: 'POST' as const,
          route: route('unit-coverage'),
          body: { ...row, unitId: FRESH_ID },
        })),
      },
    });
  });

  for (const update of turn.updates) {
    const patch: Record<string, unknown> = {};
    if (update.patch.title !== undefined) patch.title = update.patch.title;
    if (update.patch.unitRole !== undefined) patch.unitRole = update.patch.unitRole;
    if (update.patch.hours !== undefined) patch.hours = update.patch.hours;
    if (update.orderIndex !== undefined) patch.orderIndex = update.orderIndex;
    // 父级改动只在指向"库里已存在的单元"时才发：指向本轮新建 draft 的父级要等那一行
    // 被采纳，而那属于 `needs`，不属于这一行。
    if (update.parentDraftRef === null && update.parentId !== undefined) {
      patch.parentId = update.parentId;
    }
    const fields = Object.keys(patch).map((field) => FIELD_LABELS[field] ?? field);
    warnings.push(...nullEnumDroppedWarning(dropNullEnums(patch, FIELD_LABELS).dropped));
    const title = titleById.get(update.unitId) ?? update.unitId.slice(0, 8);
    lines.push({
      id: `outline:patch-${update.unitId}`,
      name: update.patch.title,
      nameKey: 'title',
      text:
        fields.length === 0
          ? `改写「${title}」`
          : `改写「${title}」的${fields.map((field) => FIELD_LABELS[field] ?? field).join('、')}`,
      write: {
        method: 'PATCH',
        route: route('units', update.unitId),
        body: dropNullEnums(patch, FIELD_LABELS).body,
      },
    });
  }

  if (turn.changedCoverage) {
    lines.push({
      id: 'outline:coverage',
      // 刻意**不给**静态 body：`turn.coverage` 是这一轮之后的整份集合，而按的时候库里已经
      // 有前面几行的成果。用静态 body 就会抹掉它们——这正是 `outline/turn` 路由必须手工
      // 拼 `coverageRows` 的原因，而这里要让那次拼凑在采纳那一刻重做一遍。
      mergeInto: {
        method: 'PUT',
        route: route('unit-coverage'),
        rows: turn.coverage,
        source: 'unitCoverage',
        key: ['unitId', 'objectiveId'],
        // `parseUnitCoverageSet` 读的是 `rows`。
        bodyKey: 'rows',
      },
      text:
        `改写哪些条目教/练/考哪些目标（共 ${turn.coverage.length} 条关系）。` +
        '这是整份替换，所以按的时候会带上当前全部关系，不会抹掉别的条目。',
    });
  }

  for (const text of [
    ...turn.unmatchedRefs.map((ref) => `没找到「${ref}」，这一条没写进去`),
    ...turn.rejectedRefs.map((ref) => `没照做：${ref}`),
  ]) {
    lines.push({ id: `outline:note-${lines.length}`, text, note: text });
  }

  return {
    lines,
    message: turn.message,
    warnings: uniqueMessages(warnings),
    instruction: input.instruction,
  };
}

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  unitRole: '角色',
  hours: '学时',
  orderIndex: '顺序',
  parentId: '父级',
};
