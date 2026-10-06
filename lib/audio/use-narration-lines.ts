'use client';

/**
 * The narration lines of a course, as one flat list — what the regeneration
 * panel iterates.
 *
 * Deliberately not the playback engine's action walk and not the notes tab's
 * scene grouping: this exists so "re-voice the course" has a list that is
 * ordered the way the user reads it (by scene order, then by position within
 * the scene) and is keyed by the `actionId` every write path targets by id
 * rather than by index. An index would be wrong here — regenerating must
 * survive the user reordering or deleting a line mid-run, which is exactly what
 * `setAudioIdById` is for.
 *
 * A line with no text is excluded: there is nothing to speak, and both
 * `regenerateSpeechAudio` and the Pro-mode "Voice all" skip it for that reason.
 * The panel shows them as not-voiced rather than hiding them, so the count a
 * user reads still matches the script they see in the notes tab.
 */

import { useMemo } from 'react';

import { useStageStore } from '@/lib/store/stage';
import type { Action } from '@/lib/types/action';

export interface NarrationLine {
  /** The speech action's own id — the key every narration write targets. */
  readonly actionId: string;
  readonly sceneId: string;
  /** 1-based position in the course, for "line 12 of 30" style labels. */
  readonly position: number;
  /** Position within its own scene, which is what the notes tab shows. */
  readonly scenePosition: number;
  /** The scene's title, so a course-wide list is still readable. */
  readonly sceneTitle: string;
  readonly text: string;
  /** The scene's `order`, which is what the derived narration key was built from. */
  readonly sceneOrder: number;
  /** The currently stamped narration asset, if this line has any. */
  readonly audioId?: string;
  /** The legacy URL of an unconverted pair: narration that exists but has no pool id. */
  readonly audioUrl?: string;
  /** Set when an edit dropped the audio and the line has not been re-voiced. */
  readonly audioInvalidated?: boolean;
}

/** Read the narration fields off a speech action without casting the whole union. */
function narrationFields(action: Action): {
  text: string;
  audioId?: string;
  audioUrl?: string;
  audioInvalidated?: boolean;
} {
  const speech = action as {
    text?: string;
    audioId?: string;
    audioUrl?: string;
    audioInvalidated?: boolean;
  };
  return {
    text: speech.text ?? '',
    ...(speech.audioId ? { audioId: speech.audioId } : {}),
    ...(speech.audioUrl ? { audioUrl: speech.audioUrl } : {}),
    ...(speech.audioInvalidated ? { audioInvalidated: true } : {}),
  };
}

/**
 * Every speech line of a course, in reading order. `sceneId` narrows it to one
 * page; omit it (or pass `null`) for the whole course.
 */
export function useNarrationLines(sceneId: string | null): NarrationLine[] {
  const scenes = useStageStore((s) => s.scenes);
  return useMemo(() => {
    const lines: NarrationLine[] = [];
    const ordered = [...scenes].sort((a, b) => a.order - b.order);
    for (const scene of ordered) {
      if (sceneId && scene.id !== sceneId) continue;
      let scenePosition = 0;
      for (const action of scene.actions ?? []) {
        if (action.type !== 'speech') continue;
        const { text, audioId, audioUrl, audioInvalidated } = narrationFields(action);
        lines.push({
          actionId: action.id,
          sceneId: scene.id,
          position: lines.length + 1,
          scenePosition: (scenePosition += 1),
          sceneTitle: scene.title,
          text,
          sceneOrder: scene.order,
          ...(audioId ? { audioId } : {}),
          ...(audioUrl ? { audioUrl } : {}),
          ...(audioInvalidated ? { audioInvalidated } : {}),
        });
      }
    }
    return lines;
  }, [scenes, sceneId]);
}
