/**
 * The bodies of `POST /api/generation-runs` and its commands, read under a
 * byte cap and checked into their typed shapes. A failure's message is
 * caller-facing.
 */
import { capBodyStream } from '@/lib/server/capped-stream';
import { normalizeSceneOutlines } from '@/lib/server/generation/outline-schema';
import { MAX_CLASSROOM_MATERIALS } from '@/lib/server/classroom-materials';
import { isMaterialId } from '@/lib/server/materials/material-id';
import { QWEN_INSTRUCT_MAX_CHARS } from '@/lib/audio/qwen-instruct-control';
import {
  ALL_SCENE_TYPES,
  type DeckDesign,
  type DeckDesignPage,
  type SceneType,
  type SceneOutline,
} from '@/lib/types/generation';
import type { OutlineRevisionTurn } from '@/lib/types/generation';

import type { GenerationRunInput } from './types';

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** The largest start body. */
export const MAX_START_BODY_BYTES = 64 * 1024;
/** The largest command body (an edited outline rides `confirm-outline`). */
export const MAX_COMMAND_BODY_BYTES = 1024 * 1024;

const MAX_REQUIREMENT_CHARS = 20_000;
const MAX_PROFILE_FIELD_CHARS = 2_000;
const MAX_PRESET_AGENTS = 20;
const AGENT_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
const PROVIDER_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,64}$/;
const MAX_VOICE_ID_CHARS = 256;
/** Command ids are the caller's idempotency keys. */
const COMMAND_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
/** The longest instruction an AI outline revision may carry. */
export const MAX_REVISE_INSTRUCTION_CHARS = 2_000;
/** The most conversation turns a revision may send (older ones are dropped). */
export const MAX_REVISE_HISTORY_TURNS = 8;
/** The longest one turn of the revision conversation may be. */
export const MAX_REVISE_HISTORY_CHARS = 4_000;

export { MAX_OUTLINE_JSON_BYTES, MAX_OUTLINE_SCENES } from '@/lib/server/generation/outline-schema';

/** The request's JSON body, or a refusal (413 for a body over `maxBytes`, 400 for malformed JSON). */
export async function readJsonBody(
  req: Request,
  maxBytes: number,
): Promise<{ ok: true; value: unknown } | { ok: false; status: 400 | 413; message: string }> {
  const tooLarge = {
    ok: false as const,
    status: 413 as const,
    message: `The body may be at most ${maxBytes} bytes`,
  };
  const declared = Number(req.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > maxBytes) return tooLarge;
  if (!req.body) return { ok: false, status: 400, message: 'Invalid JSON body' };
  const capped = capBodyStream(req.body, maxBytes);
  let text: string;
  try {
    text = await new Response(capped.stream).text();
  } catch (error) {
    if (capped.exceeded()) return tooLarge;
    throw error;
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, status: 400, message: 'Invalid JSON body' };
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalBoolean(value: unknown, name: string): Parsed<boolean> {
  if (value === undefined) return { ok: true, value: false };
  if (typeof value !== 'boolean') return { ok: false, message: `${name} must be a boolean` };
  return { ok: true, value };
}

function optionalText(value: unknown, name: string, max: number): Parsed<string | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  if (typeof value !== 'string' || value.length > max) {
    return { ok: false, message: `${name} must be a string of at most ${max} characters` };
  }
  return { ok: true, value: value.trim() || undefined };
}

function agentIdList(value: unknown, name: string, minimum: number): Parsed<string[]> {
  if (
    !Array.isArray(value) ||
    value.length < minimum ||
    value.length > MAX_PRESET_AGENTS ||
    value.some((id) => typeof id !== 'string' || !AGENT_ID_PATTERN.test(id))
  ) {
    return {
      ok: false,
      message: `${name} must name ${minimum} to ${MAX_PRESET_AGENTS} agents by id (letters, digits and ._:-, at most 128 characters)`,
    };
  }
  return { ok: true, value: [...new Set(value as string[])] };
}

/** The scene types a run may create; absent means all of them. */
function sceneTypeList(value: unknown, name: string): Parsed<SceneType[] | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const invalid: Parsed<SceneType[]> = {
    ok: false,
    message: `${name} must be an array of scene types (${ALL_SCENE_TYPES.join(', ')})`,
  };
  if (!Array.isArray(value)) return invalid;
  // An empty selection would produce an outline with no scene to generate.
  if (value.length === 0) return invalid;
  const seen = new Set<SceneType>();
  for (const entry of value) {
    if (typeof entry !== 'string' || !ALL_SCENE_TYPES.includes(entry as SceneType)) {
      return invalid;
    }
    seen.add(entry as SceneType);
  }
  // Keep the canonical order so equal selections compare equal.
  return { ok: true, value: ALL_SCENE_TYPES.filter((type) => seen.has(type)) };
}

// ── The course-design page plan ──────────────────────────────────────────────

/**
 * How many pages a start body may carry, and how much text one may hold.
 *
 * A lecture plan runs to a few dozen pages, and each page's goal, core message
 * and optional code snippet are the content that actually matters. The caps are
 * set where a legitimately designed lecture still fits inside the 64 KB start
 * body while a runaway or an injection cannot: a run whose plan is refused is
 * recoverable, one whose prompt is silently truncated is not — the outline would
 * generate from half a plan and report success.
 */
export const MAX_DECK_PAGES = 60;
const MAX_DECK_PAGE_CHARS = 4_000;

const DECK_PAGE_MODES = ['case', 'explain', 'demo', 'compare', 'summary', 'diagram'] as const;

/**
 * A page plan, read under those caps.
 *
 * The three fields that make a page a design rather than a heading — `goal`,
 * `coreInfo` and `mode` — are required here, not defaulted. The same contract
 * marks a stored page missing one as ⚠ MISSING when rendering, but a plan that
 * reaches this point is arriving from an HTTP caller rather than from course
 * design, and a page with no goal is a defect to report rather than to pass on
 * to a generator that would invent content for it.
 */
function deckDesignOf(value: unknown): Parsed<DeckDesign | undefined> {
  if (value === undefined) return { ok: true, value: undefined };
  const invalid: Parsed<DeckDesign> = {
    ok: false,
    message: `deckDesign must be an object with a pages array of at most ${MAX_DECK_PAGES} pages`,
  };
  const body = record(value);
  if (!body) return invalid;
  if (!Array.isArray(body.pages) || body.pages.length === 0) return invalid;
  if (body.pages.length > MAX_DECK_PAGES) return invalid;

  const pages: DeckDesignPage[] = [];
  for (const [index, entry] of body.pages.entries()) {
    const page = record(entry);
    if (!page) return invalid;
    // Each field is named in its own refusal. One generic message for the whole
    // plan sends the caller hunting through a forty-page design to find the one
    // page that is a heading — and that page is the one they must fix.
    const title = pageText(page.title);
    if (title === undefined) return missingField(`deckDesign.pages[${index}].title`);
    const goal = pageText(page.goal);
    if (goal === undefined) return missingField(`deckDesign.pages[${index}].goal`);
    const coreInfo = pageText(page.coreInfo);
    if (coreInfo === undefined) return missingField(`deckDesign.pages[${index}].coreInfo`);
    const mode = page.mode;
    if (typeof mode !== 'string' || !(DECK_PAGE_MODES as readonly string[]).includes(mode)) {
      return {
        ok: false,
        message: `deckDesign.pages[${index}].mode must be one of: ${DECK_PAGE_MODES.join(', ')}`,
      };
    }
    // `order` is optional because its absence is unambiguous: a plan is a
    // sequence, so the array position is the order. Course design sets it
    // explicitly, and a plan stored out of order still reads correctly.
    const order = page.order;
    if (order !== undefined && (!Number.isInteger(order) || (order as number) < 1)) {
      return { ok: false, message: `deckDesign.pages[${index}].order must be a positive integer` };
    }
    pages.push({
      order: (order as number | undefined) ?? index + 1,
      title,
      goal,
      coreInfo,
      mode: mode as DeckDesignPage['mode'],
      ...(stringListOf(page.emphasis) ? { emphasis: stringListOf(page.emphasis)! } : {}),
      ...(typeof page.visual === 'string' && page.visual.trim()
        ? { visual: page.visual.trim() }
        : {}),
      ...(typeof page.code === 'string' && page.code.trim() ? { code: page.code } : {}),
    });
  }

  const estPages = body.estPages;
  if (estPages !== undefined && (!Number.isInteger(estPages) || (estPages as number) < 1)) {
    return { ok: false, message: 'deckDesign.estPages must be a positive integer' };
  }
  return {
    ok: true,
    value: {
      pages,
      ...(estPages !== undefined ? { estPages: estPages as number } : {}),
    },
  };
}

/** A trimmed, non-empty, length-capped page string, or undefined when unusable. */
function pageText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_DECK_PAGE_CHARS) return undefined;
  return trimmed;
}

/**
 * The refusal for one missing page field.
 *
 * It says what a page must carry and why, because the alternative — accepting a
 * heading and letting the renderer mark it — produces a deck that looks
 * finished and traces back to no teaching decision.
 */
function missingField(name: string): Parsed<DeckDesign> {
  return {
    ok: false,
    message:
      `${name} is required and must be a non-empty string of at most ${MAX_DECK_PAGE_CHARS} characters; ` +
      'a page is its goal, so a title alone is a heading rather than a designed page',
  };
}

function stringListOf(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .slice(0, 20);
  return out.length > 0 ? out : undefined;
}

export function parseRunInput(raw: unknown): Parsed<GenerationRunInput> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };

  const requirement = body.requirement;
  if (typeof requirement !== 'string' || !requirement.trim()) {
    return { ok: false, message: 'Missing required field: requirement' };
  }
  if (requirement.length > MAX_REQUIREMENT_CHARS) {
    return {
      ok: false,
      message: `requirement must be at most ${MAX_REQUIREMENT_CHARS} characters`,
    };
  }

  let materialIds: string[] = [];
  if (body.materialIds !== undefined) {
    const invalid = `materialIds must be an array of at most ${MAX_CLASSROOM_MATERIALS} material ids`;
    if (
      !Array.isArray(body.materialIds) ||
      body.materialIds.length > MAX_CLASSROOM_MATERIALS * 2 ||
      body.materialIds.some((id) => typeof id !== 'string' || !isMaterialId(id.trim()))
    ) {
      return { ok: false, message: invalid };
    }
    materialIds = [...new Set((body.materialIds as string[]).map((id) => id.trim()))];
    if (materialIds.length > MAX_CLASSROOM_MATERIALS) return { ok: false, message: invalid };
  }

  const interactive = optionalBoolean(body.interactive, 'interactive');
  if (!interactive.ok) return interactive;
  const taskEngine = optionalBoolean(body.taskEngine, 'taskEngine');
  if (!taskEngine.ok) return taskEngine;
  const sceneTypes = sceneTypeList(body.sceneTypes, 'sceneTypes');
  if (!sceneTypes.ok) return sceneTypes;

  let agents: GenerationRunInput['agents'] = { mode: 'auto' };
  if (body.agents !== undefined) {
    const value = record(body.agents);
    if (value?.mode === 'auto') {
      if (value.presetAgentIds !== undefined) {
        const ids = agentIdList(value.presetAgentIds, 'agents.presetAgentIds', 0);
        if (!ids.ok) return ids;
        agents = { mode: 'auto', presetAgentIds: ids.value };
      }
    } else if (value?.mode === 'preset') {
      const ids = agentIdList(value.agentIds, 'agents.agentIds', 0);
      if (!ids.ok) return ids;
      agents = { mode: 'preset', agentIds: ids.value };
    } else {
      return {
        ok: false,
        message:
          'agents must be { "mode": "auto", "presetAgentIds"?: [...] } or { "mode": "preset", "agentIds": [...] }',
      };
    }
  }

  let learnerProfile: GenerationRunInput['learnerProfile'];
  if (body.learnerProfile !== undefined) {
    const value = record(body.learnerProfile);
    if (!value) return { ok: false, message: 'learnerProfile must be an object' };
    const nickname = optionalText(
      value.nickname,
      'learnerProfile.nickname',
      MAX_PROFILE_FIELD_CHARS,
    );
    if (!nickname.ok) return nickname;
    const bio = optionalText(value.bio, 'learnerProfile.bio', MAX_PROFILE_FIELD_CHARS);
    if (!bio.ok) return bio;
    if (nickname.value || bio.value) {
      learnerProfile = {
        ...(nickname.value ? { nickname: nickname.value } : {}),
        ...(bio.value ? { bio: bio.value } : {}),
      };
    }
  }

  const releaseMaterials = optionalBoolean(body.releaseMaterials, 'releaseMaterials');
  if (!releaseMaterials.ok) return releaseMaterials;

  const outlineReview = body.outlineReview ?? 'wait';
  if (outlineReview !== 'wait' && outlineReview !== 'countdown' && outlineReview !== 'auto') {
    return { ok: false, message: 'outlineReview must be "wait", "countdown" or "auto"' };
  }

  let voice: GenerationRunInput['voice'];
  if (body.voice !== undefined) {
    const value = record(body.voice);
    const speed = value?.speed;
    if (
      !value ||
      typeof value.providerId !== 'string' ||
      !PROVIDER_ID_PATTERN.test(value.providerId) ||
      typeof value.voiceId !== 'string' ||
      !value.voiceId.trim() ||
      value.voiceId.length > MAX_VOICE_ID_CHARS ||
      (speed !== undefined && (typeof speed !== 'number' || !(speed > 0) || speed > 4))
    ) {
      return {
        ok: false,
        message: `voice must be { providerId, voiceId (at most ${MAX_VOICE_ID_CHARS} characters), speed? } with a speed above 0 and at most 4`,
      };
    }
    voice = {
      providerId: value.providerId,
      voiceId: value.voiceId.trim(),
      ...(speed !== undefined ? { speed: speed as number } : {}),
    };
  }

  let qwenInstructControl: GenerationRunInput['qwenInstructControl'];
  if (body.qwenInstructControl !== undefined) {
    const parsed = optionalBoolean(body.qwenInstructControl, 'qwenInstructControl');
    if (!parsed.ok) return parsed;
    qwenInstructControl = parsed.value;
  }

  // The instruction text travels with the run rather than being read from
  // settings, which the server cannot see. Bounded by the same cap the browser
  // applies, so a start body cannot carry a prompt-sized payload into every
  // narration request of the run.
  const qwenInstructText = optionalText(
    body.qwenInstructText,
    'qwenInstructText',
    QWEN_INSTRUCT_MAX_CHARS,
  );
  if (!qwenInstructText.ok) return qwenInstructText;

  const deckDesign = deckDesignOf(body.deckDesign);
  if (!deckDesign.ok) return deckDesign;

  // The design ids ride the run for traceability. They are opaque, so only
  // shape is checked here; whether they name a design this owner can generate
  // is the caller's gate, not this parser's.
  const curriculumTaskId = optionalText(body.curriculumTaskId, 'curriculumTaskId', 128);
  if (!curriculumTaskId.ok) return curriculumTaskId;
  const curriculumUnitId = optionalText(body.curriculumUnitId, 'curriculumUnitId', 128);
  if (!curriculumUnitId.ok) return curriculumUnitId;

  return {
    ok: true,
    value: {
      requirement,
      materialIds,
      interactive: interactive.value,
      taskEngine: taskEngine.value,
      ...(sceneTypes.value ? { sceneTypes: sceneTypes.value } : {}),
      ...(deckDesign.value ? { deckDesign: deckDesign.value } : {}),
      ...(curriculumTaskId.value ? { curriculumTaskId: curriculumTaskId.value } : {}),
      ...(curriculumUnitId.value ? { curriculumUnitId: curriculumUnitId.value } : {}),
      agents,
      ...(learnerProfile ? { learnerProfile } : {}),
      outlineReview,
      ...(voice ? { voice } : {}),
      ...(qwenInstructControl !== undefined ? { qwenInstructControl } : {}),
      ...(qwenInstructText.value !== undefined ? { qwenInstructText: qwenInstructText.value } : {}),
      ...(releaseMaterials.value && materialIds.length > 0 ? { releaseMaterials: true } : {}),
    },
  };
}

export function parseCommandId(value: unknown): Parsed<string> {
  if (typeof value !== 'string' || !COMMAND_ID_PATTERN.test(value)) {
    return {
      ok: false,
      message: 'commandId must be 1 to 128 characters of letters, digits and ._:-',
    };
  }
  return { ok: true, value };
}

export interface ConfirmOutlineCommand {
  commandId: string;
  outlineRevision: number;
  outlines?: SceneOutline[];
}

/** An edited outline, in the outline normalizer's normal form (the one the outline step's output takes). */
export function parseOutlines(value: unknown): Parsed<SceneOutline[]> {
  return normalizeSceneOutlines(value);
}

export function parseConfirmOutline(raw: unknown): Parsed<ConfirmOutlineCommand> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };
  const commandId = parseCommandId(body.commandId);
  if (!commandId.ok) return commandId;
  const revision = body.outlineRevision;
  if (typeof revision !== 'number' || !Number.isInteger(revision) || revision < 1) {
    return { ok: false, message: 'outlineRevision must be a positive integer' };
  }
  if (body.outlines === undefined) {
    return { ok: true, value: { commandId: commandId.value, outlineRevision: revision } };
  }
  // Orders follow the list, as the browser's outline editor numbers them
  // after every edit (position 1, 2, 3, ...).
  const outlines = parseOutlines(
    Array.isArray(body.outlines)
      ? body.outlines.map((outline, index) => {
          const item = record(outline);
          return item ? { ...item, order: index + 1 } : outline;
        })
      : body.outlines,
  );
  if (!outlines.ok) return outlines;
  return {
    ok: true,
    value: { commandId: commandId.value, outlineRevision: revision, outlines: outlines.value },
  };
}

export function parseHoldOutline(raw: unknown): Parsed<{ commandId: string }> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };
  const commandId = parseCommandId(body.commandId);
  if (!commandId.ok) return commandId;
  return { ok: true, value: { commandId: commandId.value } };
}

export interface RetryCommand {
  commandId: string;
  /** Retry this failed media element only. */
  media?: { elementId: string };
}

const MAX_ELEMENT_ID_CHARS = 128;

export function parseRetry(raw: unknown): Parsed<RetryCommand> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };
  const commandId = parseCommandId(body.commandId);
  if (!commandId.ok) return commandId;
  if (body.media === undefined) return { ok: true, value: { commandId: commandId.value } };
  const elementId = record(body.media)?.elementId;
  if (typeof elementId !== 'string' || !elementId || elementId.length > MAX_ELEMENT_ID_CHARS) {
    return {
      ok: false,
      message: `media must be { elementId } with an element id of 1 to ${MAX_ELEMENT_ID_CHARS} characters`,
    };
  }
  return { ok: true, value: { commandId: commandId.value, media: { elementId } } };
}

export interface ReviseOutlineBody {
  instruction: string;
  outlines: SceneOutline[];
  history: OutlineRevisionTurn[];
}

/**
 * The body of an outline revision: the learner's instruction, the outline as
 * their editor shows it now (the source of truth for the next turn, their
 * manual edits included), and the recent conversation. Nothing here is stored:
 * the route only reads it, and the browser applies the answer.
 */
export function parseReviseOutline(raw: unknown): Parsed<ReviseOutlineBody> {
  const body = record(raw);
  if (!body) return { ok: false, message: 'The body must be a JSON object' };

  const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
  if (!instruction) return { ok: false, message: 'Missing required field: instruction' };
  if (instruction.length > MAX_REVISE_INSTRUCTION_CHARS) {
    return {
      ok: false,
      message: `instruction must be at most ${MAX_REVISE_INSTRUCTION_CHARS} characters`,
    };
  }

  // Orders follow the list, as the editor numbers them after every edit.
  const outlines = parseOutlines(
    Array.isArray(body.outlines)
      ? body.outlines.map((outline, index) => {
          const item = record(outline);
          return item ? { ...item, order: index + 1 } : outline;
        })
      : body.outlines,
  );
  if (!outlines.ok) return outlines;

  const history: OutlineRevisionTurn[] = [];
  if (body.history !== undefined) {
    if (!Array.isArray(body.history) || body.history.length > MAX_REVISE_HISTORY_TURNS) {
      return {
        ok: false,
        message: `history must be an array of at most ${MAX_REVISE_HISTORY_TURNS} turns`,
      };
    }
    for (const turn of body.history) {
      const item = record(turn);
      const role = item?.role;
      const content = typeof item?.content === 'string' ? item.content : '';
      if ((role !== 'user' && role !== 'assistant') || !content.trim()) {
        return {
          ok: false,
          message: 'history turns must be { role: "user" | "assistant", content }',
        };
      }
      if (content.length > MAX_REVISE_HISTORY_CHARS) {
        return {
          ok: false,
          message: `history turns must be at most ${MAX_REVISE_HISTORY_CHARS} characters`,
        };
      }
      history.push({ role, content });
    }
  }

  return { ok: true, value: { instruction, outlines: outlines.value, history } };
}
