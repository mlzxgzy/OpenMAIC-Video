/**
 * 第二步「学习目标」的草稿：把 `CourseOutcomesResult` 算成草稿行。
 *
 * 这个文件是起草骨架的第一个消费者，也是"引擎不认识领域概念"这句话的第一个证明：下面
 * 每一行都只由"打哪个路由、带什么 body、依赖谁"组成，目标、证据、可观察行为这些词一个
 * 都没有出现在结构里，它们只出现在 `body` 里面。
 *
 * 三个刻意的决定：
 *
 * 1. **新建目标 + 它的证据是同一行的两跳，不是两行。** `POST /objectives` 不接受
 *    `evidence`（`parseObjectiveInput` 会把它丢掉），所以"新建目标并带上它的考核证据"
 *    必然是 `POST /objectives` 再 `POST /evidence`，而第二跳要填第一跳的 id。摊成两行的
 *    后果是证据行在目标行被采纳之前没有 `objectiveId` 可填——它只能是一个按不了的说明行，
 *    于是"新建目标"和"给它证据"在界面上被拆成两件作者要分别决定的事，而它们其实是同一
 *    件事。详见 {@link StepDraftCreate.then}。
 * 2. **删除排在最前面，且删除与改写同一个目标时拒绝改写那行。** 与 `outcomes/turn` 路由
 *    同一条顺序规则（先删后改，否则删掉的条目被同一轮 patch 写回去）。这里不能只靠行序：
 *    每一行是作者**单独**按的，所以顺序不是保证而是运气——删与改必须由
 *    {@link outcomesDraftConflicts} 显式处理，界面照它灰掉那一行。
 * 3. **一条没有最低标准的目标照常可按。** `expectedBehavior` 缺失会让它落库为"不可验证"，
 *    而那正是界面显示出来、让作者补一句的**可见状态**；把它当成需要先修好的前置条件，
 *    等于让作者在一件已经可写的事上停下来。
 */

import { dropNullEnums, nullEnumDroppedWarning, uniqueMessages } from './draft-body';
import { assertDraftRouteSafe, FRESH_ID, type StepDraft, type StepDraftLine } from './step-draft';
import type { CourseOutcomesResult } from '@/lib/server/curriculum/outcomes-step';
import type { EvidenceBinding, EvidenceDraft } from './design-outcomes';

const BASE = '/api/curriculum/design/tasks';

/**
 * 这个步骤能碰的写入，全部由 `assertDraftRouteSafe` 收口。
 *
 * **任务 id 必须由这里拼进去**：`id` 不在这里、指望调用方传进来，是这类函数最容易漏掉的
 * 一个参数——而漏掉它的表现是"点采纳时 404"，与这条建议本身对不对毫无关系。
 */
function taskRoute(taskId: string, ...segments: string[]): string {
  return assertDraftRouteSafe([BASE, taskId, ...segments].join('/'));
}

export interface OutcomesDraftBoard {
  objectives: readonly { id: string; title: string }[];
}

interface EvidenceLike {
  evidenceType: string;
  verificationMethod: string;
  successCondition: string;
  assessmentMode?: string;
  hintPolicy?: string;
  independent?: boolean;
}

/**
 * 一条证据的 body，与 `outcomes/turn` 路由里那个 `evidenceInput` 逐字段相同。
 *
 * 抄它而不是共用，是因为那个函数没有导出——而共用它的收益（默认值与写入端永远一致）正是
 * 抄的理由。**缺省值是这里最容易出错的地方**：写 `practice/unlimited/true` 之外的组合，
 * 就会让"没写等级"的证据在草稿里显示成一种、在库里落成另一种，而界面上看不出差别。
 * 有一条测试把这个函数与那个路由的实现钉在一起。
 */
function evidenceBody(
  objectiveId: string,
  // `EvidenceLike` 是因为 {@link FRESH_ID} 不是一个真实 id，所以它没有 `ref` 字段可言。
  binding: EvidenceDraft | EvidenceBinding | EvidenceLike,
): Record<string, unknown> {
  return {
    objectiveId,
    evidenceType: binding.evidenceType,
    verificationMethod: binding.verificationMethod,
    successCondition: binding.successCondition,
    assessmentMode: binding.assessmentMode ?? 'practice',
    hintPolicy: binding.hintPolicy ?? 'unlimited',
    independent: binding.independent ?? true,
  };
}

const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  objectiveType: '类型',
  expectedBehavior: '可观察行为',
  minCriteria: '最低标准',
  description: '说明',
};

function short(id: string): string {
  return id.slice(0, 8);
}

/**
 * 删除与改写指向同一个目标时，改写那一行不可采纳。
 *
 * 规则写在这里而不是界面上，是因为界面不该知道"删除优先"这件事——那是写入顺序的规则，
 * 而界面会抄一份，然后两份不一致。返回的是**要灰掉的行 id**，理由由引擎的
 * `stepLineAvailability` 之外的一段给出：这里只回答"谁挡了谁"。
 */
export function outcomesDraftConflicts(draft: StepDraft): { lineId: string; blockedBy: string }[] {
  const removed = new Set(
    draft.lines.filter((line) => line.id.startsWith('outcome:removed-')).map((line) => line.id),
  );
  if (removed.size === 0) return [];
  const out: { lineId: string; blockedBy: string }[] = [];
  for (const line of draft.lines) {
    // 改写与补证据都会被这次删除连带删掉（外键级联），所以它们都不能在删除之前成立。
    const target = line.id.startsWith('outcome:patch-')
      ? line.id.slice('outcome:patch-'.length)
      : line.id.startsWith('outcome:evidence-')
        ? line.id.slice('outcome:evidence-'.length)
        : null;
    if (target === null) continue;
    if (removed.has(`outcome:removed-${target}`)) {
      out.push({ lineId: line.id, blockedBy: `outcome:removed-${target}` });
    }
  }
  return out;
}

/** 结果 → 草稿行。行序是"删除 → 新建 → 改写 → 补证据 → 说明"。 */
export function outcomesDraftOf(input: {
  turn: CourseOutcomesResult;
  before: OutcomesDraftBoard;
  /** 写入路由里的任务 id。草稿行要能被引擎原样发出去，所以路径在这里就是完整的。 */
  taskId: string;
  instruction: string;
}): StepDraft {
  const { turn, before } = input;
  const route = (...segments: string[]) => taskRoute(input.taskId, ...segments);
  const titleById = new Map(before.objectives.map((row) => [row.id, row.title]));
  const label = (id: string) => `「${titleById.get(id) ?? short(id)}」`;
  const lines: StepDraftLine[] = [];
  const warnings: string[] = [];

  for (const id of turn.removed) {
    lines.push({
      id: `outcome:removed-${id}`,
      text: `删除目标${label(id)}`,
      write: {
        method: 'DELETE',
        route: route('objectives', id),
      },
    });
  }

  turn.added.forEach((draft, index) => {
    const hasEvidence = draft.evidence.length > 0;
    lines.push({
      id: `outcome:added-${index}`,
      name: draft.title,
      nameKey: 'title',
      text: hasEvidence
        ? `新建目标${label(draft.title)}，并带上 ${draft.evidence.length} 条考核证据`
        : `新建目标${label(draft.title)}，还没有考核证据（它会显示成「不可验证」，等你补）`,
      detail: draft.expectedBehavior,
      create: {
        route: route('objectives'),
        // 与 `outcomes/turn` 路由同样的字段集。`sortOrder` 不发：手工新建的顺序由
        // `parseObjectiveInput` 的缺省决定，而草稿不该替作者决定新目标排在第几位。
        // `description: null` 是 `nullableText` 读的**有意义**的空，草稿照发；而
        // `objectiveType` 这类由 `oneOf` 读的键，显式 `null` 是"取值非法"——见
        // `draft-body.ts`。这里过一遍是为了让"新建"那条路也不可能踩到它。
        body: dropNullEnums({
          title: draft.title,
          objectiveType: draft.objectiveType,
          description: draft.description ?? null,
          expectedBehavior: draft.expectedBehavior,
          // 空标准是**故意的**：见文件头第 3 条。
          minCriteria: draft.minCriteria,
        }).body,
        idKey: 'objective',
        then: draft.evidence.map((one) => ({
          method: 'POST' as const,
          route: route('evidence'),
          body: evidenceBody(FRESH_ID, one as EvidenceLike),
        })),
      },
    });
  });

  for (const [objectiveId, patch] of turn.patches) {
    // `ref` 是给模型用的寻址标记，不是给路由的字段——留着它会让一次改写被拒，而理由与这条
    // 建议本身无关。`dropNullEnums` 挡的是同一类事的另一半：`PATCH /objectives/<id>` 用
    // `oneOf` 读 `objectiveType` / `bloomLevel` / `level` / `difficulty` / `status`，显式
    // `null` 会被报成"取值非法"而不是"清空"。
    const rawPatch = Object.fromEntries(Object.entries(patch).filter(([field]) => field !== 'ref'));
    const { body, dropped } = dropNullEnums(rawPatch, FIELD_LABELS);
    warnings.push(...nullEnumDroppedWarning(dropped));
    const fields = Object.keys(patch)
      .filter((field) => field !== 'ref')
      .map((field) => FIELD_LABELS[field] ?? field);
    lines.push({
      id: `outcome:patch-${objectiveId}`,
      name: patch.title,
      // 目标这一格的字段叫 `title`，不是 `name`——见 `StepDraftLine.nameKey`。
      nameKey: 'title',
      text:
        fields.length === 0
          ? `改写目标${label(objectiveId)}`
          : `改写目标${label(objectiveId)}的${fields.join('、')}`,
      write: {
        method: 'PATCH',
        route: route('objectives', objectiveId),
        body,
      },
    });
  }

  for (const { objectiveId, binding } of turn.evidence) {
    lines.push({
      id: `outcome:evidence-${objectiveId}`,
      text:
        `给目标${label(objectiveId)}补一条考核证据` +
        `（${binding.evidenceType}）：${binding.successCondition}`,
      write: {
        method: 'POST',
        route: route('evidence'),
        body: evidenceBody(objectiveId, binding),
      },
    });
  }

  for (const text of [
    ...turn.unmatchedRefs.map((ref) => `没找到「${ref}」，这一条没写进去`),
    ...turn.rejectedRefs.map((ref) => `没照做：${ref}`),
  ]) {
    lines.push({ id: `outcome:note-${lines.length}`, text, note: text });
  }

  return {
    lines,
    message: turn.message,
    warnings: uniqueMessages([...turn.gaps.map((gap) => gap.text), ...warnings]),
    instruction: input.instruction,
  };
}
