/**
 * The outline edits a learner has made but not confirmed yet, kept in the
 * browser. A run's outline only changes when it is confirmed (server-side), so
 * an unconfirmed edit — an AI revision or a hand edit — lives nowhere else:
 * without a draft, leaving the review (the requirement page, the runs list,
 * a reload) and coming back shows the run's own outline again, as if the edit
 * had never been applied.
 *
 * A draft is tied to the outline revision it was made against. A run that
 * re-outlines (a retry) or is confirmed elsewhere moves to another revision,
 * and the stale draft is dropped instead of shadowing the run.
 *
 * What is stored is untrusted input: it outlives releases and anything on the
 * origin can write it, so a read validates its shape before the editor sees it.
 */
import type { SceneOutline } from '@/lib/types/generation';

/** The localStorage namespace of a run's unconfirmed outline edits. */
const DRAFT_KEY_PREFIX = 'generationRunOutlineDraft:';

const SCENE_TYPES = new Set(['slide', 'quiz', 'interactive', 'pbl']);

/** The learner's unconfirmed outline, as this browser holds it. */
export interface OutlineDraft {
  /** The revision of the run's outline the edit was made against. */
  revision: number;
  outlines: SceneOutline[];
}

export function outlineDraftKey(runId: string): string {
  return `${DRAFT_KEY_PREFIX}${runId}`;
}

/**
 * The storage to use: the caller's (tests), else `localStorage`. Absent under
 * SSR and in some privacy modes, where a draft simply cannot be kept.
 */
function storageOrNull(storage?: Storage): Storage | null {
  if (storage) return storage;
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** A scene as it was stored: the editor's fields, with `keyPoints` possibly absent. */
type StoredScene = Omit<SceneOutline, 'keyPoints'> & { keyPoints?: string[] };

/** A scene the editor can render, or anything that claims to be one. */
function isSceneOutline(value: unknown): value is StoredScene {
  if (typeof value !== 'object' || value === null) return false;
  const scene = value as Record<string, unknown>;
  return (
    typeof scene.id === 'string' &&
    scene.id.length > 0 &&
    typeof scene.type === 'string' &&
    SCENE_TYPES.has(scene.type) &&
    typeof scene.title === 'string' &&
    typeof scene.description === 'string' &&
    typeof scene.order === 'number' &&
    Number.isFinite(scene.order) &&
    (scene.keyPoints === undefined ||
      (Array.isArray(scene.keyPoints) &&
        scene.keyPoints.every((point) => typeof point === 'string')))
  );
}

/** The draft this browser keeps for a run, or null when there is none (or it is unusable). */
export function readOutlineDraft(runId: string, storage?: Storage): OutlineDraft | null {
  const store = storageOrNull(storage);
  if (!store) return null;
  let raw: string | null;
  try {
    raw = store.getItem(outlineDraftKey(runId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { revision, outlines } = parsed as { revision?: unknown; outlines?: unknown };
    if (typeof revision !== 'number' || !Number.isFinite(revision)) return null;
    if (!Array.isArray(outlines) || outlines.length === 0) return null;
    const scenes: SceneOutline[] = [];
    for (const candidate of outlines) {
      if (!isSceneOutline(candidate)) return null;
      scenes.push({
        ...candidate,
        keyPoints: Array.isArray(candidate.keyPoints) ? candidate.keyPoints : [],
      });
    }
    return { revision, outlines: scenes };
  } catch {
    return null;
  }
}

/** Keep the learner's unconfirmed outline for this run (best effort). */
export function writeOutlineDraft(runId: string, draft: OutlineDraft, storage?: Storage): void {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    store.setItem(outlineDraftKey(runId), JSON.stringify(draft));
  } catch {
    /* Storage full or unavailable: the edit stays on this page, as before. */
  }
}

/** Drop the run's draft (the confirmation reached the run, or it moved on). */
export function clearOutlineDraft(runId: string, storage?: Storage): void {
  const store = storageOrNull(storage);
  if (!store) return;
  try {
    store.removeItem(outlineDraftKey(runId));
  } catch {
    /* Storage unavailable: nothing to drop. */
  }
}

/**
 * The draft to put back in the editor for a run whose outline is at
 * `revision`. A draft made against another revision is stale (the run
 * re-outlined, or was confirmed elsewhere) and is dropped.
 */
export function restoreOutlineDraft(
  runId: string,
  revision: number,
  storage?: Storage,
): SceneOutline[] | null {
  const draft = readOutlineDraft(runId, storage);
  if (!draft) return null;
  if (draft.revision !== revision) {
    clearOutlineDraft(runId, storage);
    return null;
  }
  return draft.outlines;
}
