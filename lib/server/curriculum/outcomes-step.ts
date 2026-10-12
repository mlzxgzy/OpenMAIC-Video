/**
 * 第二步「学习目标与考核标准」的 AI 步骤：一次对话轮次 → 一次清单写入。
 *
 * 形状照抄 {@link file://./direction-step.ts}（同一套 `(input, ctx) => output`、
 * 同一条 prompt 管线、同一种 JSON 修理、同一种"模型说了什么"与"库里变成什么"分离），
 * 但第二步多两件事，都是因为它的对象是**清单**而不是固定的卡片：
 *
 * 1. **引用解析。** 模型只能通过 `ref` 指名要改哪一条，所以这一层负责把 ref 对上
 *    真实 id、决定删除与修改的优先级、把对不上的 ref 记下来。
 *    {@link resolveOutcomesTurn} 是全部确定性逻辑，可不带模型测试。
 * 2. **确认的判定比第一步多一条**：这一轮必须真的动过清单。对一句"看起来还行"的
 *    附和签收，签的不是这一轮的成果。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  OutcomeAnswerError,
  formatOutcomeList,
  mergeOutcomePatch,
  outcomeGaps,
  parseOutcomeAnswer,
  shouldConfirmOutcomes,
  type EvidenceBinding,
  type OutcomeAnswer,
  type OutcomeDraft,
  type OutcomeGap,
  type OutcomePatch,
  type OutcomeRef,
} from '@/lib/curriculum/design-outcomes';
import type {
  CurriculumEvidenceRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

export interface CourseOutcomesTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** Everything the route already read, in the form the rules take it. */
export interface OutcomesBoard {
  objectives: readonly OutcomeRef[];
  unverifiable: readonly { id: string; title: string }[];
  unevidenced: readonly { id: string; title: string }[];
  evidenceByObjective: ReadonlyMap<string, readonly CurriculumEvidenceRecord[]>;
}

export interface CourseOutcomesInput {
  /** The confirmed direction, as one line of context for the model. */
  direction: string;
  board: OutcomesBoard;
  /** Turns before this one. Empty on the first message of this step. */
  history: readonly CourseOutcomesTurn[];
  instruction: string;
  model: StepLanguageModel;
}

/** What the route has to write, already resolved against real ids. */
export interface CourseOutcomesResult {
  message: string;
  added: OutcomeDraft[];
  /** Patches keyed by objective id. */
  patches: Map<string, OutcomePatch>;
  removed: Set<string>;
  /** Evidence to attach, already pointing at objective ids. */
  evidence: { objectiveId: string; binding: EvidenceBinding }[];
  confirmRequested: boolean;
  /** Refs the model named that match nothing: logged, never applied. */
  unmatchedRefs: string[];
  /** Drafts the model got wrong, described in its own words. */
  rejectedRefs: string[];
  gaps: OutcomeGap[];
  userTurns: number;
}

export function formatOutcomesHistory(history: readonly CourseOutcomesTurn[]): string {
  if (history.length === 0) return '(这是这一步的第一句话)';
  return history
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
    .join('\n\n');
}

/** The gaps the model is asked to close, in the same words the card shows. */
export function gapsText(gaps: readonly OutcomeGap[]): string {
  if (gaps.length === 0) return '(每个目标都已可验证且有考核方式，可以请用户确认)';
  return gaps.map((gap) => `- ${gap.text}`).join('\n');
}

/** The direction as one line; the step-1 card, when there is one. */
export function formatDirectionLine(task: {
  title: string;
  audience: string | null;
  problemStatement: string | null;
  durationHours: number | null;
}): string {
  const parts = [task.title];
  if (task.audience) parts.push(`授课对象：${task.audience}`);
  if (task.durationHours !== null) parts.push(`${task.durationHours} 学时`);
  if (task.problemStatement) parts.push(`范围：${task.problemStatement}`);
  return parts.join('；');
}

/**
 * The deterministic half, given the model's answer and the board it answered
 * about. Kept separate from {@link draftCourseOutcomes} so the guard can be tested
 * against a hundred answers without a model.
 */
export function resolveOutcomesTurn(input: {
  answer: OutcomeAnswer;
  board: OutcomesBoard;
  history: readonly CourseOutcomesTurn[];
}): CourseOutcomesResult {
  const { patches, removed, unmatchedRefs } = mergeOutcomePatch(
    input.board.objectives,
    input.answer,
  );
  const userTurns = input.history.filter((turn) => turn.role === 'user').length + 1;

  // An evidence row is attached to a ref that has to survive this turn: a deleted
  // outcome takes its evidence with it, so attaching to one would either insert
  // against a row the delete is about to remove or fail the store's own check.
  const known = new Set(input.board.objectives.map((entry) => entry.id));
  const evidence: { objectiveId: string; binding: EvidenceBinding }[] = [];
  for (const binding of input.answer.evidence) {
    if (!known.has(binding.ref)) {
      unmatchedRefs.push(binding.ref);
      continue;
    }
    if (removed.has(binding.ref)) {
      unmatchedRefs.push(binding.ref);
      continue;
    }
    evidence.push({ objectiveId: binding.ref, binding });
  }

  const surviving = input.board.objectives.filter((entry) => !removed.has(entry.id));
  const evidenceForNew = input.answer.added.reduce(
    (total, draft) => total + draft.evidence.length,
    0,
  );
  // The list after this turn, for the purpose of "is there anything to assess".
  // Counting the drafts matters on the turn that creates the *first* outcome: the
  // survivors are empty then, and `outcomeGaps` would report 「还没有学习目标」 — a
  // wall the turn itself just walked through, which is also why that turn could
  // never confirm the very list it created.
  const outcomeCountAfter = surviving.length + input.answer.added.length;
  const survivingGaps =
    outcomeCountAfter === 0
      ? outcomeGaps([])
      : outcomeGaps(
          survivorsWithDrafts(surviving, input.answer.added.length),
          unverifiedAfter(surviving, input.board),
          unevidencedAfter(surviving, input.board, evidence),
        );
  const addedGaps = addedDraftGaps(input.answer.added);
  const gaps = [...survivingGaps, ...addedGaps];

  const changedAnything =
    input.answer.added.length > 0 || patches.size > 0 || removed.size > 0 || evidence.length > 0;

  return {
    message: input.answer.message,
    added: input.answer.added,
    patches,
    removed,
    evidence,
    confirmRequested: shouldConfirmOutcomes({
      confirmRequested: input.answer.confirmRequested,
      userTurns,
      // New outcomes are counted immediately: a draft carries its own behavior and
      // criteria, so it is as verifiable as the row it will become. Evidence the
      // model attached counts with it, or the turn that finally completes a
      // previously-bare outcome could never confirm the very list it completed.
      objectiveCount: surviving.length + input.answer.added.length,
      evidenceCount: countEvidence(surviving, input.board) + evidenceForNew,
      gaps,
      changedAnything,
    }),
    unmatchedRefs,
    rejectedRefs: input.answer.rejectedRefs,
    gaps,
    userTurns,
  };
}

/** A draft is verifiable when the two things `deriveVerifiability` reads are there. */
function isVerifiableDraft(draft: OutcomeDraft): boolean {
  return (
    draft.expectedBehavior.trim() !== '' && draft.minCriteria.some((line) => line.trim() !== '')
  );
}

/**
 * Verifiability of the survivors after this turn's patches.
 *
 * An outcome the model is about to fix is not still a gap: reporting
 * 「目标 X 还缺最低标准」 as a blocker in the same turn that added the criterion
 * would make the model see a wall it just walked through, and would make the card
 * disagree with what it is about to store.
 */
function unverifiedAfter(
  survivors: readonly OutcomeRef[],
  board: OutcomesBoard,
): { id: string; title: string }[] {
  return board.unverifiable.filter((row) => survivors.some((entry) => entry.id === row.id));
}

/**
 * The survivors with a placeholder per draft.
 *
 * The placeholders exist only so `outcomeGaps` sees a non-empty list; the draft's
 * own gaps are reported separately by {@link addedDraftGaps} (a draft has no id to
 * be addressed by), so an empty title here is never rendered.
 */
function survivorsWithDrafts(survivors: readonly OutcomeRef[], draftCount: number): OutcomeRef[] {
  if (draftCount === 0) return [...survivors];
  return [...survivors, ...Array.from({ length: draftCount }, () => ({ id: '', title: '' }))];
}

/**
 * Gaps that belong to drafts this turn is adding.
 *
 * A draft has no id until it is stored, so it is checked on its own shape and
 * reported by title. Reusing {@link outcomeGaps} for it would need a fake id, and
 * a fake id would end up in the confirmation guard's counts as if it were a row.
 */
function addedDraftGaps(drafts: readonly OutcomeDraft[]): OutcomeGap[] {
  const gaps: OutcomeGap[] = [];
  for (const draft of drafts) {
    if (!isVerifiableDraft(draft)) {
      gaps.push({
        text: `目标「${draft.title}」还没有可观察行为和最低标准，现在无法考核`,
      });
    }
    if (draft.evidence.length === 0) {
      gaps.push({
        text: `目标「${draft.title}」还没有考核方式：补一条证据，说明怎么验、什么算通过`,
      });
    }
  }
  return gaps;
}

/** Outcomes that will still have no evidence once this turn's bindings land. */
function unevidencedAfter(
  survivors: readonly OutcomeRef[],
  board: OutcomesBoard,
  evidence: readonly { objectiveId: string }[],
): { id: string; title: string }[] {
  const bound = new Set(evidence.map((entry) => entry.objectiveId));
  return board.unevidenced.filter(
    (row) => survivors.some((entry) => entry.id === row.id) && !bound.has(row.id),
  );
}

function countEvidence(survivors: readonly OutcomeRef[], board: OutcomesBoard): number {
  return survivors.reduce(
    (total, entry) => total + (board.evidenceByObjective.get(entry.id)?.length ?? 0),
    0,
  );
}

/** The board the rules take, read off the records the route already has. */
export function boardOf(
  objectives: readonly CurriculumObjectiveRecord[],
  evidence: readonly CurriculumEvidenceRecord[],
): OutcomesBoard {
  const evidenceByObjective = new Map<string, CurriculumEvidenceRecord[]>();
  for (const row of evidence) {
    const list = evidenceByObjective.get(row.objectiveId);
    if (list) list.push(row);
    else evidenceByObjective.set(row.objectiveId, [row]);
  }
  return {
    objectives: objectives
      .slice()
      .sort(
        (left, right) =>
          left.sortOrder - right.sortOrder || left.createdAt.localeCompare(right.createdAt),
      )
      .map((row) => ({ id: row.id, title: row.title })),
    unverifiable: objectives
      .filter((row) => !row.verifiable)
      .map((row) => ({ id: row.id, title: row.title })),
    unevidenced: objectives
      .filter((row) => (evidenceByObjective.get(row.id)?.length ?? 0) === 0)
      .map((row) => ({ id: row.id, title: row.title })),
    evidenceByObjective,
  };
}

/**
 * Run one outcomes turn. Throws {@link OutcomeAnswerError} when the answer is not
 * usable as a list change; the caller maps that to a 502 and the list stays as it was.
 */
export async function draftCourseOutcomes(
  input: CourseOutcomesInput,
  ctx: StepContext,
): Promise<CourseOutcomesResult> {
  const prompts = buildPrompt(PROMPT_IDS.COURSE_OUTCOMES, {
    direction: input.direction,
    list: formatOutcomeList(input.board),
    gaps: gapsText(
      outcomeGaps(input.board.objectives, input.board.unverifiable, input.board.unevidenced),
    ),
    history: formatOutcomesHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`找不到学习目标提示词模板：${PROMPT_IDS.COURSE_OUTCOMES}`);
  }

  ctx.log.info(
    `Course outcomes turn ${input.history.length + 1}: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-outcomes',
    {
      retries: 1,
      validate: (text: string) => {
        try {
          parseOutcomeAnswer(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return resolveOutcomesTurn({
    answer: parseOutcomeAnswer(result.text),
    board: input.board,
    history: input.history,
  });
}

export { OutcomeAnswerError };
