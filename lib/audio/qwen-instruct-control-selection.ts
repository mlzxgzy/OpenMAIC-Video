/**
 * The Qwen instruction-control switch as the current TTS slot can honour it.
 *
 * The switch is a user preference with no knowledge of which model will speak;
 * this resolves it against the slot's provider and model so the settings panel,
 * the narration request and the generation prompts all agree about what will
 * actually happen.
 *
 * What travels on a request is the *instruction text*, not a flag: the presence
 * of the text is what turns the feature on, so "enabled" and "what to say"
 * cannot drift apart the way a boolean beside a separate field would.
 */
import {
  currentModelCapabilities,
  type ModelCapabilities,
} from '@/lib/model-settings/capabilities';
import { useSettingsStore } from '@/lib/store/settings';
import { slotTTSModel } from '@/lib/audio/tts-selection';
import { qwenInstructionsForModel } from '@/lib/audio/qwen-instruct-control';

export interface QwenInstructPreference {
  /** The switch as the user left it, regardless of the model. */
  requested: boolean;
  /** Whether the slot's current provider and model will actually apply it. */
  effective: boolean;
  /** Whether the `tts` slot speaks through Qwen at all. */
  applies: boolean;
  /** The model that decides what applies; the slot's, or the provider's default. */
  modelId?: string;
  /** The instruction a request would carry, or undefined when none would. */
  instructions?: string;
}

/** The user's stored switch and text, without a slot. */
function storedPreference(): { requested: boolean; text: string } {
  const state = useSettingsStore.getState();
  return { requested: state.qwenTtsInstructControl, text: state.qwenTtsInstructText };
}

/**
 * The instruction a synthesis request for `modelId` must carry, or undefined:
 * the user asked for it, the provider is Qwen, and that model accepts the
 * parameter. A non-Qwen provider never does, whatever the switch says.
 */
export function qwenInstructionsForRequest(
  modelId: string | undefined,
  providerId?: string,
): string | undefined {
  if (providerId && providerId !== 'qwen-tts') return undefined;
  const { requested, text } = storedPreference();
  if (!requested) return undefined;
  return qwenInstructionsForModel(text, modelId) ?? undefined;
}

/** The stored switch resolved against what the `tts` slot speaks with. */
export function resolveQwenInstructControl(
  capabilities: ModelCapabilities = currentModelCapabilities(),
): QwenInstructPreference {
  const { requested, text } = storedPreference();
  const target = capabilities.tts;
  if (target?.registryId !== 'qwen-tts') {
    return { requested, effective: false, applies: false };
  }
  // The slot's model, or the provider's default when it names none — the same
  // model the synthesis request will carry.
  const modelId = slotTTSModel(target);
  const instructions = qwenInstructionsForModel(text, modelId);
  return {
    requested,
    effective: requested && instructions !== null,
    applies: true,
    ...(instructions ? { instructions } : {}),
    ...(modelId ? { modelId } : {}),
  };
}
