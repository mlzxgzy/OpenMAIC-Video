/**
 * 第一步「课程方向」的 AI 步骤：一次对话轮次 → 一次卡片写入。
 *
 * 这是设计流程里第一个真正的"AI 对话"步骤，形状照抄
 * `lib/server/generation/steps/outline-revision.ts`（同一套 `(input, ctx) =>
 * output`、同一条 prompt 管线、同一种 JSON 修理），但有两处不同，都是这一步
 * 特有的：
 *
 * 1. **它不改状态机。** 它只把用户这一句能确定的槽位算出来，写库由路由做。
 *    这样"模型说了什么"和"库里变成了什么"是两个可分别测试的事实，而不是一
 *    次调用里搅在一起。
 * 2. **确认由确定性规则裁决，不由模型自述。** 模型可以声明 `confirm: true`
 *    （宽松模式允许对话确认），但 {@link resolveDirectionTurn} 会用
 *    {@link shouldConfirmDirection} 复核：首轮不能确认、必填没齐不能确认。模型
 *    过度自信时，用户看到的"确认"仍然是被人检查过的。
 */
import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import {
  DirectionAnswerError,
  directionGapLabels,
  formatDirectionCard,
  parseDirectionAnswer,
  shouldConfirmDirection,
  type CurriculumDirectionPatch,
  type CurriculumDirectionValues,
} from '@/lib/curriculum/design-direction';

import type { StepContext, StepLanguageModel } from '@/lib/server/generation/steps/context';

/** One line of the dialog. Mirrors the outline-revision turn shape. */
export interface CourseDirectionTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CourseDirectionInput {
  /** The card as stored right now — the model's ground truth, not a summary. */
  values: CurriculumDirectionValues;
  /**
   * How the card was signed off, when it already was — `'user'` for the button,
   * `'assistant'` for a confirmation relayed in the conversation, `null` for not
   * yet. The model is told which, because "the user clicked confirm" and "the
   * user said confirm in chat" are different confidence for how it talks back.
   */
  confirmedBy: string | null;
  /** Turns before this one. Empty on the first message of a new course. */
  history: readonly CourseDirectionTurn[];
  /** The user's newest message. */
  instruction: string;
  /** The stage's model, resolved by the route for its own workspace. */
  model: StepLanguageModel;
}

export interface CourseDirectionResult {
  /** What the user reads in the chat. */
  message: string;
  /** Slots this turn writes; the route merges them onto the card. */
  fields: CurriculumDirectionPatch;
  /** The model's own claim; the register below says whether it is honoured. */
  confirmRequested: boolean;
  /** Model keys that named no real slot — logged, never written. */
  rejectedKeys: string[];
  /** User messages so far, including this turn, for the confirmation guard. */
  userTurns: number;
}

/** The conversation as prompt text. */
export function formatDirectionHistory(history: readonly CourseDirectionTurn[]): string {
  if (history.length === 0) return '(这是这门课的第一句话，卡片还是空的)';
  return history
    .map((turn) => `${turn.role === 'user' ? '用户' : '助手'}: ${turn.content}`)
    .join('\n\n');
}

/**
 * The deterministic half: given the model's answer and the card it answered
 * about, decide what may actually be written.
 *
 * Kept separate from {@link draftCourseDirection} so the guard can be tested
 * against a hundred answers without a model, and so a route can call it with an
 * answer that came from somewhere else (a retry, a fixture, a replay).
 */
export function resolveDirectionTurn(input: {
  answer: {
    message: string;
    fields: CurriculumDirectionPatch;
    confirmRequested: boolean;
    rejectedKeys: string[];
  };
  values: CurriculumDirectionValues;
  history: readonly CourseDirectionTurn[];
}): CourseDirectionResult {
  // Counted from the user's messages, not from every message: the dialog opens
  // with an assistant greeting that is not an answer about any card, and counting
  // it would let the very first user sentence confirm.
  const userTurns = input.history.filter((turn) => turn.role === 'user').length + 1;
  const next: CurriculumDirectionValues = { ...input.values, ...input.answer.fields };
  return {
    message: input.answer.message,
    fields: input.answer.fields,
    // The model asked; the rules decide. Both must agree for the write to carry
    // a confirmation.
    confirmRequested: shouldConfirmDirection({
      confirmRequested: input.answer.confirmRequested,
      values: next,
      userTurns,
    }),
    rejectedKeys: input.answer.rejectedKeys,
    userTurns,
  };
}

/**
 * Run one direction turn. Throws {@link DirectionAnswerError} when the answer
 * cannot be used as a card change; the caller maps that to a 502 and the card
 * stays exactly as it was.
 */
export async function draftCourseDirection(
  input: CourseDirectionInput,
  ctx: StepContext,
): Promise<CourseDirectionResult> {
  const prompts = buildPrompt(PROMPT_IDS.COURSE_DIRECTION, {
    card: formatDirectionCard(input.values, input.confirmedBy),
    gaps: gapText(input.values),
    history: formatDirectionHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`找不到课程方向提示词模板：${PROMPT_IDS.COURSE_DIRECTION}`);
  }

  ctx.log.info(
    `Course direction turn ${input.history.length + 1}: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'course-direction',
    {
      // A bad JSON shape is a transient model slip far more often than a bad
      // message, exactly as in outline revision.
      retries: 1,
      validate: (text: string) => {
        try {
          parseDirectionAnswer(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  return resolveDirectionTurn({
    answer: parseDirectionAnswer(result.text),
    values: input.values,
    history: input.history,
  });
}

/** `{ confirmedAt, confirmedBy }` in the form the card renderer wants. */
function gapText(values: CurriculumDirectionValues): string {
  const missing = directionGapLabels(values);
  return missing.length === 0 ? '(必填项已齐，可以请用户确认)' : missing.join('、');
}

export { DirectionAnswerError };
