'use client';

/**
 * The voice and pace narration is (or would be) spoken with, for DISPLAY only.
 *
 * Regenerating a line's audio goes through `regenerateSpeechAudio`
 * (`lib/audio/regenerate-speech-tts.ts`) → `generateAndStoreTTS`
 * (`lib/audio/narration-tts.ts`), which resolves provider / model / voice from
 * the `tts` slot plus the teacher's bound voice, and sends the global `ttsSpeed`.
 * That path is the contract: a regenerated clip cannot come out in a different
 * voice or pace, because it is literally the same call the course's original
 * narration used.
 *
 * This module answers the other half of the question — "what WOULD it sound
 * like?" — for a panel that has to show the user which voice and speed are in
 * effect before they spend money regenerating. It reuses the same resolvers
 * rather than restating them, and the only difference from
 * `generateAndStoreTTS`'s prologue is what it deliberately does NOT do:
 *
 *   - no `markVoiceBindingUnavailable` / `markVoiceBindingNoticeShown` / toast.
 *     `generateAndStoreTTS` marks a binding dead when its provider is disabled,
 *     which is a MUTATION of the fallback state for every later clip. Reading
 *     the voice must not make the next real request pick a different one, so
 *     this mirrors the decision and stops there.
 *   - no providerOptions resolution / voice registration (`resolveAgentVoiceOptions`).
 *     That work exists to make a voice clone exist; it costs a request and
 *     belongs to the call that will actually speak.
 *
 * Every branch below is a line-for-line restatement of `generateAndStoreTTS`
 * lines 98-155. If that function's prologue changes, this one must change with
 * it — a copy that drifts would advertise one voice and synthesize another,
 * which is precisely the bug this module exists to make impossible.
 */

import { loadModelCapabilities } from '@/lib/model-settings/capabilities';
import { ttsSelection } from '@/lib/audio/tts-selection';
import { pickNarratorAgent } from '@/lib/audio/agent-voice';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import {
  deterministicNarratorVoice,
  findVoiceDisplayName,
  narratorBindingDiffers,
  resolveNarratorVoiceBinding,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import { resolveTTSModelForVoice, TTS_PROVIDERS } from '@/lib/audio/constants';
import { isVoiceBindingUnavailable } from '@/lib/audio/unavailable-voice-bindings';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import type { TTSProviderId } from '@/lib/audio/types';

/** What a narration clip will be spoken with, as the user can read it. */
export interface NarrationVoiceSummary {
  /** The voice id actually sent to the provider. */
  readonly voiceId: string;
  /** Its display name, when the registry knows one (clone ids fall back to the id). */
  readonly voiceName: string;
  readonly providerId: TTSProviderId;
  /** The model the voice selects, when one is pinned. */
  readonly modelId?: string;
  /** The narration speed, straight from the user's `ttsSpeed` preference. */
  readonly speed: number;
  /**
   * True when the teacher's bound voice decided this, false when the global
   * voice preference did. Display only — the audio is identical either way.
   */
  readonly fromTeacherBinding: boolean;
}

/**
 * Resolve the voice and speed narration currently uses, or null when the
 * workspace's `tts` slot resolves to nothing (or to browser speech, which is
 * synthesized in the browser and has no managed pace to show).
 */
export async function narrationVoiceSummary(): Promise<NarrationVoiceSummary | null> {
  const selection = ttsSelection(await loadModelCapabilities());
  if (!selection) return null;
  // Browser speech has no server-side provider, no per-line asset and no
  // `ttsSpeed` in the request body — the playback engine applies the rate to a
  // `SpeechSynthesisUtterance` instead. There is nothing here worth claiming.
  if (selection.providerId === 'browser-native-tts') return null;

  const providersConfig = selection.providersConfig;
  const teacher = pickNarratorAgent(useAgentRegistry.getState().listAgents());
  const boundVoice = teacher?.voiceConfig;

  const globalVoice: ResolvedVoice = {
    providerId: selection.providerId,
    modelId: selection.modelId,
    voiceId: selection.voice,
  };
  const globalDiffers = narratorBindingDiffers(boundVoice, globalVoice);

  let resolvedVoice = resolveNarratorVoiceBinding(
    boundVoice && isVoiceBindingUnavailable(boundVoice) ? undefined : boundVoice,
    globalVoice,
    providersConfig,
  );

  // Pinned narrator (bound == global) whose provider became disabled. The
  // deterministic pick is computed here exactly as `generateAndStoreTTS`
  // computes it — minus the marking and the toast, which are the side effects
  // a read must not have.
  if (
    boundVoice &&
    !globalDiffers &&
    !isTTSProviderEnabled(resolvedVoice.providerId, providersConfig[resolvedVoice.providerId])
  ) {
    resolvedVoice = deterministicNarratorVoice(providersConfig) ?? resolvedVoice;
  }

  const providerConfig = providersConfig[resolvedVoice.providerId];
  const modelId = resolveTTSModelForVoice(
    resolvedVoice.providerId,
    resolvedVoice.voiceId,
    resolvedVoice.modelId ?? providerConfig?.modelId,
  );

  return {
    voiceId: resolvedVoice.voiceId,
    voiceName: narrationVoiceDisplayName(resolvedVoice.providerId, resolvedVoice.voiceId),
    providerId: resolvedVoice.providerId,
    ...(modelId ? { modelId } : {}),
    speed: selection.speed,
    fromTeacherBinding: !!boundVoice,
  };
}

/**
 * A voice's display name, or the id when nothing knows one.
 *
 * Only the `tts` slot's own provider can win here: `slotTTSProvidersConfig`
 * presents the map as exactly that one provider, so a custom provider's
 * `customVoices` (which `findVoiceDisplayName` would otherwise prefer) is not
 * reachable from this resolution. A clone id that the catalog does not list
 * therefore falls through to itself, which is the honest answer — it is what
 * the request will carry.
 */
function narrationVoiceDisplayName(providerId: string, voiceId: string): string {
  if (Object.hasOwn(TTS_PROVIDERS, providerId)) {
    return findVoiceDisplayName(providerId as TTSProviderId, voiceId);
  }
  return voiceId;
}
