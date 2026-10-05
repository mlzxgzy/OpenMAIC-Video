/**
 * Outline revision: the step behind the review page's "ask AI to edit the
 * outline" chat. It takes the learner's current outline (their manual edits
 * included) and one instruction, and returns the whole revised outline plus a
 * one-line explanation.
 *
 * Like every step it is a plain `(input, ctx) => output`: the route resolves
 * the run, the owner's outline-stage model and the request body, and this
 * module owns the prompt, the call and the output's normal form. It writes
 * nothing: the browser applies the result to its editor, and the run only
 * learns about it when the outline is confirmed (`confirm-outline`).
 *
 * The model's answer is repaired before it is validated (`repairOutlineScenes`):
 * a model that invents scenes tends to omit their id and order, and the outline
 * normalizer the pipeline shares is strict about both.
 */
import { nanoid } from 'nanoid';

import { callLLM } from '@/lib/ai/llm';
import { buildPrompt, PROMPT_IDS } from '@/lib/prompts';
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
import { ALL_SCENE_TYPES, type SceneOutline, type SceneType } from '@/lib/types/generation';
import type { OutlineRevisionTurn } from '@/lib/types/generation';
import { uniquifyMediaElementIds } from '@openmaic/generation';

import type { StepContext, StepLanguageModel } from './context';

/** One turn of the edit conversation. */
export type { OutlineRevisionTurn } from '@/lib/types/generation';

export interface OutlineRevisionInput {
  /** The run's requirement: the outline's grounding, not shown to the learner. */
  requirement: string;
  interactive: boolean;
  taskEngine: boolean;
  /** The scene types the composer kept; undefined means every type. */
  sceneTypes?: SceneType[];
  /** The course's teaching-language directive, followed by the revised copy. */
  languageDirective: string;
  /** The outline as the learner sees it now (their edits included). */
  outlines: SceneOutline[];
  instruction: string;
  history: OutlineRevisionTurn[];
  /** The outline stage's model. */
  model: StepLanguageModel;
}

export interface OutlineRevisionResult {
  outlines: SceneOutline[];
  /** The model's short explanation, in the course's language; '' when it gave none. */
  message: string;
}

/** The model's answer could not be used as an outline; the message is caller-facing. */
export class OutlineRevisionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OutlineRevisionError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const JSON_FENCE = /```(?:json)?\s*([\s\S]*?)```/i;

/**
 * The `{ message, outlines }` object a revision answers with. Tolerates a
 * markdown fence and surrounding prose (models add both), refuses anything
 * without a non-empty `outlines` array.
 */
export function parseOutlineRevisionResponse(text: string): {
  message: string;
  outlines: unknown[];
} {
  const body = (JSON_FENCE.exec(text)?.[1] ?? text).trim();
  const start = body.indexOf('{');
  const end = body.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new OutlineRevisionError('The model did not return a JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    throw new OutlineRevisionError('The model returned invalid JSON');
  }
  if (!isRecord(parsed)) {
    throw new OutlineRevisionError('The model returned a JSON value that is not an object');
  }
  const outlines = parsed.outlines;
  if (!Array.isArray(outlines) || outlines.length === 0) {
    throw new OutlineRevisionError('The model returned no scenes');
  }
  const message = typeof parsed.message === 'string' ? parsed.message.trim() : '';
  return { message, outlines };
}

/**
 * Give every scene a usable, unique id and its positional `order` (1, 2, 3, …
 * in array order), the form the outline normalizer requires. A member that is
 * not an object is left as it is, so the normalizer reports it by index.
 */
export function repairOutlineScenes(raw: readonly unknown[]): unknown[] {
  const usedIds = new Set<string>();
  return raw
    .map((item) => {
      if (!isRecord(item)) return item;
      const rawId = typeof item.id === 'string' ? item.id.trim() : '';
      let id = rawId && !usedIds.has(rawId) ? rawId : nanoid(8);
      while (usedIds.has(id)) id = nanoid(8);
      usedIds.add(id);
      return { ...item, id };
    })
    .map((scene, index) => (isRecord(scene) ? { ...scene, order: index + 1 } : scene));
}

/** The conversation as prompt text; the current outline rides its own variable. */
function formatHistory(history: readonly OutlineRevisionTurn[]): string {
  if (history.length === 0) return '(no earlier turns)';
  return history
    .map((turn) => `${turn.role === 'user' ? 'Learner' : 'Assistant'}: ${turn.content}`)
    .join('\n\n');
}

/**
 * Revise one outline with one instruction. Throws {@link OutlineRevisionError}
 * when the model's answer cannot be used as an outline; the caller maps that to
 * a failed request and the learner's outline stays as it was.
 */
export async function reviseOutlines(
  input: OutlineRevisionInput,
  ctx: StepContext,
): Promise<OutlineRevisionResult> {
  const sceneTypes = input.sceneTypes ?? [...ALL_SCENE_TYPES];
  const prompts = buildPrompt(PROMPT_IDS.OUTLINE_REVISION, {
    requirement: input.requirement,
    languageDirective: input.languageDirective,
    interactiveMode: input.interactive ? 'on' : 'off',
    taskEngineMode: input.taskEngine ? 'on' : 'off',
    sceneTypes: sceneTypes.join(', '),
    outlines: input.outlines,
    history: formatHistory(input.history),
    instruction: input.instruction,
  });
  if (!prompts) {
    throw new Error(`Prompt template not found: ${PROMPT_IDS.OUTLINE_REVISION}`);
  }

  ctx.log.info(
    `Revising outline (${input.outlines.length} scenes) with instruction: "${input.instruction.slice(0, 80)}"`,
  );

  const result = await callLLM(
    {
      model: input.model.model,
      system: prompts.system,
      prompt: prompts.user,
      maxOutputTokens: input.model.modelInfo?.outputWindow,
      abortSignal: ctx.signal,
    },
    'outline-revision',
    {
      // One retry on an answer that is not a usable outline — a bad JSON shape
      // is a transient model slip far more often than a bad instruction.
      retries: 1,
      validate: (text: string) => {
        try {
          parseOutlineRevisionResponse(text);
          return true;
        } catch {
          return false;
        }
      },
    },
    input.model.thinkingConfig,
    { serverManaged: input.model.serverManaged },
  );

  const { message, outlines } = parseOutlineRevisionResponse(result.text);
  const repaired = repairOutlineScenes(outlines);
  // The composer's scene-type selection still binds: a revision must not
  // introduce a scene type the learner left out. Whatever slips through is
  // dropped here, exactly as the outline step drops it while streaming.
  const allowed = input.sceneTypes ? new Set<SceneType>(input.sceneTypes) : undefined;
  const kept = allowed
    ? repaired.filter(
        (scene) =>
          isRecord(scene) && typeof scene.type === 'string' && allowed.has(scene.type as SceneType),
      )
    : repaired;

  const normalized = normalizeSceneOutlines(kept);
  if (!normalized.ok) {
    throw new OutlineRevisionError(`The revised outline is unusable: ${normalized.message}`);
  }

  return {
    outlines: uniquifyMediaElementIds(normalized.value),
    message,
  };
}
