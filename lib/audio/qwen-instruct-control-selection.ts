/**
 * The Qwen instruction-control switch as the current TTS slot can honour it.
 *
 * The switch is a user preference with no knowledge of which model will speak;
 * this resolves it against the slot's provider and model so the settings panel,
 * the narration request and the generation prompts all agree about what will
 * actually happen.
 */
import {
  currentModelCapabilities,
  type ModelCapabilities,
} from '@/lib/model-settings/capabilities';
import { useSettingsStore } from '@/lib/store/settings';
import { slotTTSModel } from '@/lib/audio/tts-selection';
import { supportsQwenInstructionControl } from '@/lib/audio/qwen-instruct-control';

export interface QwenInstructPreference {
  /** The switch as the user left it, regardless of the model. */
  requested: boolean;
  /** Whether the slot's current provider and model will actually apply it. */
  effective: boolean;
  /** Whether the `tts` slot speaks through Qwen at all. */
  applies: boolean;
  /** The model that decides what applies; the slot's, or the provider's default. */
  modelId?: string;
}

/** The user's stored switch, without a slot. */
export function qwenInstructControlRequested(): boolean {
  return useSettingsStore.getState().qwenTtsInstructControl;
}

/**
 * Whether a synthesis request for `modelId` must carry the delivery
 * instruction: the user asked for it AND that model accepts the parameter.
 * A non-Qwen provider never does, whatever the switch says.
 */
export function qwenInstructionControlFor(
  modelId: string | undefined,
  providerId?: string,
): boolean {
  if (providerId && providerId !== 'qwen-tts') return false;
  return qwenInstructControlRequested() && supportsQwenInstructionControl(modelId);
}

/** The stored switch resolved against what the `tts` slot speaks with. */
export function resolveQwenInstructControl(
  capabilities: ModelCapabilities = currentModelCapabilities(),
): QwenInstructPreference {
  const requested = qwenInstructControlRequested();
  const target = capabilities.tts;
  if (target?.registryId !== 'qwen-tts') {
    return { requested, effective: false, applies: false };
  }
  // The slot's model, or the provider's default when it names none — the same
  // model the synthesis request will carry.
  const modelId = slotTTSModel(target);
  return {
    requested,
    effective: requested && supportsQwenInstructionControl(modelId),
    applies: true,
    ...(modelId ? { modelId } : {}),
  };
}
