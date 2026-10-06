/**
 * Qwen TTS instruction control.
 *
 * Qwen's speech models accept a natural-language `instructions` string on the
 * synthesis request: it shapes pitch, pace, emotion and delivery for the whole
 * line. DashScope accepts it only on the Qwen3-TTS-Instruct-Flash series and
 * **rejects** a request carrying an unsupported parameter, so the gate lives
 * here rather than at each call site.
 *
 * Qwen documents a second expressive feature — inline emotion and rich-language
 * tags in the spoken text — on the Qwen-Audio-TTS series. No model of that
 * series is in the Qwen registry catalogue, so there is no way for a user to
 * select one and the feature could never be reached; it is deliberately not
 * implemented rather than offered and inert.
 *
 * Model gating (https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide):
 * - `instructions` / `optimize_instructions`: Qwen3-TTS-Instruct-Flash series.
 *
 * A user may also have pinned an operator-only model id we do not know, so the
 * gate is a positive test for the family known to support the feature rather
 * than a negative test for those known not to.
 */

/** The models that accept the `instructions` request parameter. */
const INSTRUCT_MODEL_PATTERN = /-tts-instruct(?:-|$)/iu;

/**
 * Whether this Qwen model accepts an `instructions` string. A model the
 * registry does not know is assumed not to: sending an unsupported parameter
 * makes the provider reject the whole request.
 */
export function supportsQwenInstructionControl(modelId?: string): boolean {
  return !!modelId && INSTRUCT_MODEL_PATTERN.test(modelId);
}

/**
 * The default delivery instruction used when instruction control is on.
 *
 * The provider accepts an arbitrary prompt (1600 tokens, Chinese or English);
 * the course already knows what kind of voice it is teaching with, so the
 * standing default is a warm, clear lecturer — the baseline every line then
 * deviates from. Because the instruction carries the delivery, the generated
 * script must not also spell it out; see {@link qwenInstructPromptSection}.
 */
export const DEFAULT_QWEN_INSTRUCTIONS =
  '语气亲切自然，像一位经验丰富的老师在对学生讲课；吐字清晰，语速适中，重点处略有强调。';

/**
 * The narration-writing guidance for a run that instructs its synthesis, or an
 * empty string. Appending it to the action prompts is what stops the script
 * from writing tone and pace into the words themselves: with the instruction
 * in force, `(smiling)`-style cues and doubled emphasis are noise the model
 * will read out.
 */
export function qwenInstructPromptSection(enabled: boolean): string {
  if (!enabled) return '';
  return [
    '### Delivery Instruction',
    '',
    'The teacher\'s voice is synthesized with a natural-language delivery instruction',
    'applied to every line — it sets tone, pace and emphasis. That instruction is already',
    'configured for this course, so you do NOT need to write one.',
    '',
    'Write only the words a teacher would actually say. Never put stage directions into',
    'the speech text: no `(smiling)`, no `*laughs*`, no `（好奇地）` — the model is told how',
    'to say the line, and parentheses are read out as noise. Do not spell out tone, pace',
    'or style in the words either; trust the instruction to carry the delivery.',
  ].join('\n');
}
