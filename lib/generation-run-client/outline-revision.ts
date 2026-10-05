/**
 * The pure parts of the review page's "ask AI to edit the outline" chat: what
 * the next request carries, and what one revision changed. Keeping them here
 * (not in the dialog) makes them testable without a DOM.
 */
import type { OutlineRevisionTurn, SceneOutline } from '@/lib/types/generation';

/** The most conversation turns a revision request carries; older ones are dropped. */
export const MAX_REVISION_HISTORY_TURNS = 8;
/** The longest one turn may be in a request (the server refuses longer ones). */
export const MAX_REVISION_HISTORY_CHARS = 4_000;

/**
 * The conversation the next revision request carries: the recent turns, each
 * within the server's per-turn cap. The current instruction is passed
 * separately, so `turns` excludes it.
 */
export function historyForRequest(turns: readonly OutlineRevisionTurn[]): OutlineRevisionTurn[] {
  return turns.slice(-MAX_REVISION_HISTORY_TURNS).map((turn) => ({
    role: turn.role,
    content: turn.content.slice(0, MAX_REVISION_HISTORY_CHARS),
  }));
}

/** How one revision changed the outline, by scene identity. */
export interface OutlineChangeSummary {
  added: number;
  removed: number;
  /** Scenes present before and after whose content changed. */
  changed: number;
}

/**
 * What one revision did, for the chat's summary line. Scenes are matched by
 * `id`; a re-order alone counts as no change (the editor shows it directly).
 * Media element ids are excluded from the comparison: the server re-mints them
 * on every revision (nothing is generated before confirmation), so they would
 * otherwise mark every media-bearing scene as changed.
 */
export function summarizeOutlineChange(
  previous: readonly SceneOutline[],
  next: readonly SceneOutline[],
): OutlineChangeSummary {
  const before = new Map(previous.map((scene) => [scene.id, comparable(scene)]));
  const after = new Map(next.map((scene) => [scene.id, comparable(scene)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [id, value] of after) {
    const previousValue = before.get(id);
    if (previousValue === undefined) added += 1;
    else if (previousValue !== value) changed += 1;
  }
  for (const id of before.keys()) {
    if (!after.has(id)) removed += 1;
  }
  return { added, removed, changed };
}

/** The user-visible content of a scene, as one comparable string. */
function comparable(scene: SceneOutline): string {
  return JSON.stringify({
    type: scene.type,
    title: scene.title,
    description: scene.description,
    keyPoints: scene.keyPoints ?? [],
    teachingObjective: scene.teachingObjective,
    estimatedDuration: scene.estimatedDuration,
    quizConfig: scene.quizConfig,
    pblConfig: scene.pblConfig,
    interactiveConfig: scene.interactiveConfig,
    widgetType: scene.widgetType,
    widgetOutline: scene.widgetOutline,
    mediaGenerations: scene.mediaGenerations?.map(({ elementId: _elementId, ...rest }) => rest),
  });
}
