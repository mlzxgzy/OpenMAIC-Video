/**
 * 第六步「题目与实操」的草稿：把 `CourseAssessmentResult` 算成草稿行。
 *
 * 这是**六种写入**的一个步骤，所以它的转换函数最"长"——但每一种都只是引擎已经会的事：
 * `create` 是一种、`PATCH` 是一种、`DELETE` 是一种。引擎没有为考核新增任何能力，这正是
 * 把骨架抽出来的回报：这一份转换与第二、四、五份的区别只是**行数**，不是**形状**。
 *
 * 三条刻意的决定：
 *
 * 1. **删除行排在最前面，且与改写同一道题/同一个实操时挡住改写。** 与第二、四步同一条
 *    "先删后改"规则，理由也相同：一轮里删掉又改回来，最终结果一样却是两次写入，而作者
 *    看到的是"我删了它又被改回来"。
 * 2. **题干可以改，条目名与目标不可改。** 题干是这一步自己的产物；条目与目标是大纲与
 *    目标那两步签过字的，改它们等于让一个已签收的步骤被顺手改掉——而且改完之后**签收不再
 *    覆盖它**，界面上却看不出来。
 * 3. **一道新题带的是它的全部字段，不拆成多行。** `POST /questions` 一次收下 stem、options、
 *    answer、explanation、score、sortOrder…，拆成多行就等于承诺"先建题再补选项"这种中间
 *    状态，而那种状态过不了 `readQuestion` 的校验。
 */

import { dropNullEnums, nullEnumDroppedWarning, uniqueMessages } from './draft-body';
import { assertDraftRouteSafe, type StepDraft, type StepDraftLine } from './step-draft';
import type { CourseAssessmentResult } from '@/lib/server/curriculum/assessment-step';
import type { AssessmentBoard } from '@/lib/curriculum/design-assessment';

const BASE = '/api/curriculum/design/tasks';

function taskRoute(taskId: string, ...segments: string[]): string {
  return assertDraftRouteSafe([BASE, taskId, ...segments].join('/'));
}

export interface AssessmentDraftInput {
  turn: CourseAssessmentResult;
  board: AssessmentBoard;
  taskId: string;
  instruction: string;
}

/** 题目与实操在界面上的名字：题干的前 30 个字，或实操的目标。 */
function questionLabel(stem: string | null | undefined, fallback: string): string {
  const text = (stem ?? '').trim();
  if (text === '') return fallback;
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

/** 改写里哪些键叫什么。只用于"清空这一项没做成"那句话。 */
const PATCH_LABELS: Record<string, string> = {
  unitId: '所属条目',
  objectiveId: '对应目标',
  evidenceId: '考核证据',
  questionType: '题型',
  stem: '题干',
  options: '选项',
  answer: '答案',
  explanation: '解析',
  distractors: '干扰项',
  difficulty: '难度',
  bloomLevel: 'Bloom 层级',
  score: '分值',
  sortOrder: '题号',
  assessmentMode: '考核方式',
  taskGoal: '任务目标',
  brief: '任务说明',
  expectedResult: '预期结果',
  dockerImage: '镜像',
  resetPolicy: '重置策略',
  referenceSolution: '参考解法',
  verifyRules: '判定规则',
  keyBehaviors: '关键行为',
  finalStateRule: '终态规则',
  scoreRules: '评分规则',
  scoringMode: '评分模式',
  timeLimitSec: '限时',
  hintPolicy: '提示策略',
  allowRetry: '允许重试',
  hintLadder: '提示阶梯',
};

/** 结果 → 草稿行。行序是"删除 → 新建 → 改写 → 说明"。 */
export function assessmentDraftOf(input: AssessmentDraftInput): StepDraft {
  const { turn, board, taskId } = input;
  const route = (...segments: string[]) => taskRoute(taskId, ...segments);
  const questionById = new Map(board.questions.map((row) => [row.id, row]));
  const labById = new Map(board.labTasks.map((row) => [row.id, row]));
  const itemTitle = new Map(board.items.map((item) => [item.id, item.title]));
  const lines: StepDraftLine[] = [];
  const warnings: string[] = [];

  for (const id of turn.writes.removeQuestionIds) {
    lines.push({
      id: `assessment:remove-question-${id}`,
      text: `删除题目「${questionLabel(questionById.get(id)?.stem, id.slice(0, 8))}」`,
      write: { method: 'DELETE', route: route('questions', id) },
    });
  }
  for (const id of turn.writes.removeLabTaskIds) {
    lines.push({
      id: `assessment:remove-lab-${id}`,
      text: `删除实操「${labById.get(id)?.taskGoal ?? id.slice(0, 8)}」`,
      write: { method: 'DELETE', route: route('lab-tasks', id) },
    });
  }

  for (const [index, question] of turn.writes.createQuestions.entries()) {
    lines.push({
      id: `assessment:question-${index}`,
      name: question.stem,
      nameKey: 'stem',
      text:
        `新建题目（${question.questionType}）` +
        `给「${itemTitle.get(question.unitId) ?? question.unitId.slice(0, 8)}」` +
        `，${question.score} 分`,
      detail: question.stem,
      create: {
        route: route('questions'),
        // `POST /questions` 用 `oneOf` 读 `bloomLevel`，而 `QuestionWrite.bloomLevel` 在模型
        // 没写时就是 `null`。发 `null` 会被拒（"只能是以下之一"），去掉它与发 `null` 完全
        // 等价——store 的 `optionalText` 对两者写同一个值。所以这是**每一道**模型没标 Bloom
        // 层级的题都会踩的一处，不是边角情况。
        body: dropNullEnums({ ...question }, PATCH_LABELS).body,
        idKey: 'question',
      },
    });
  }

  for (const [index, lab] of turn.writes.createLabTasks.entries()) {
    lines.push({
      id: `assessment:lab-${index}`,
      name: lab.taskGoal,
      nameKey: 'taskGoal',
      text:
        `新建实操给「${itemTitle.get(lab.unitId) ?? lab.unitId.slice(0, 8)}」` +
        `，镜像 ${lab.dockerImage}`,
      detail: lab.taskGoal,
      create: {
        route: route('lab-tasks'),
        body: dropNullEnums({ ...lab }, PATCH_LABELS).body,
        idKey: 'labTask',
      },
    });
  }

  for (const update of turn.writes.updateQuestions) {
    const current = questionById.get(update.id);
    const { body, dropped } = dropNullEnums({ ...update.patch }, PATCH_LABELS);
    warnings.push(...nullEnumDroppedWarning(dropped));
    lines.push({
      id: `assessment:patch-question-${update.id}`,
      name: update.patch.stem,
      nameKey: 'stem',
      text: `改写题目「${questionLabel(current?.stem, update.id.slice(0, 8))}」`,
      write: {
        method: 'PATCH',
        route: route('questions', update.id),
        body,
      },
    });
  }

  for (const update of turn.writes.updateLabTasks) {
    const current = labById.get(update.id);
    const { body, dropped } = dropNullEnums({ ...update.patch }, PATCH_LABELS);
    warnings.push(...nullEnumDroppedWarning(dropped));
    lines.push({
      id: `assessment:patch-lab-${update.id}`,
      name: update.patch.taskGoal,
      nameKey: 'taskGoal',
      text: `改写实操「${current?.taskGoal ?? update.id.slice(0, 8)}」`,
      write: {
        method: 'PATCH',
        route: route('lab-tasks', update.id),
        body,
      },
    });
  }

  for (const text of [
    ...turn.writes.rejectedRefs.map((ref) => `没照做：${ref}`),
    ...turn.writes.advisories.map((text) => `提醒：${text}`),
  ]) {
    lines.push({ id: `assessment:note-${lines.length}`, text, note: text });
  }

  return {
    lines,
    message: turn.message,
    warnings: uniqueMessages([...turn.gaps.map((gap) => gap.text), ...warnings]),
    instruction: input.instruction,
  };
}

/**
 * 删除与改写指向同一行时，改写那一行不可采纳。
 *
 * 与第二步的 `outcomesDraftConflicts` 同一个形状，规则也同一条（先删后改），但**分开放**
 * 而没有搬进引擎：删除与改写的冲突在每个步骤里表达方式不同（第二步的目标 id 是行 id 的
 * 一部分，考核这一步是两组独立的 id 列表），把它做成引擎能力就得让每个步骤都按引擎的
 * 形状描述自己的冲突——那是一个比重复 20 行更难读的东西。
 */
export function assessmentDraftConflicts(draft: StepDraft): Record<string, string> {
  const removedQuestions = new Set(
    draft.lines
      .filter((line) => line.id.startsWith('assessment:remove-question-'))
      .map((line) => line.id.slice('assessment:remove-question-'.length)),
  );
  const removedLabs = new Set(
    draft.lines
      .filter((line) => line.id.startsWith('assessment:remove-lab-'))
      .map((line) => line.id.slice('assessment:remove-lab-'.length)),
  );
  const out: Record<string, string> = {};
  for (const line of draft.lines) {
    const target = line.id.startsWith('assessment:patch-question-')
      ? { id: line.id.slice('assessment:patch-question-'.length), removed: removedQuestions }
      : line.id.startsWith('assessment:patch-lab-')
        ? { id: line.id.slice('assessment:patch-lab-'.length), removed: removedLabs }
        : null;
    if (target === null) continue;
    if (target.removed.has(target.id)) {
      out[line.id] = '这一条已经被这一轮删掉了，按它会把它改回来。';
    }
  }
  return out;
}
