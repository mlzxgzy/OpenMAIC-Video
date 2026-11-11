import { configuredDefaultVoice } from '@/lib/audio/provider-default-voice';
/**
 * Which voice a run narrates with, decided as the browser decides it for the
 * `tts` slot (`lib/audio/tts-selection.ts`, `generateAndStoreTTS`): the slot
 * names the provider and model; the learner's voice applies when it was picked
 * for that provider and its model can speak it; a generated teacher's bound
 * voice wins over both while its provider is the slot's.
 */
import {
  DEFAULT_TTS_VOICES,
  TTS_PROVIDERS,
  isQwenCloneVoice,
  resolveTTSModelForVoice,
  voiceServesModel,
  voiceAllowedByConfiguredCatalogue,
} from '@/lib/audio/constants';
import type { BuiltInTTSProviderId, TTSProviderId, ConfiguredTTSVoice } from '@/lib/audio/types';
import { isTTSProviderEnabled } from '@/lib/audio/provider-enablement';
import { voiceBindingKey } from '@/lib/audio/unavailable-voice-bindings';
import {
  deterministicNarratorVoice,
  getEnabledProvidersWithVoices,
  narratorBindingDiffers,
  narratorVoiceAfterMissingClone,
  resolveNarratorVoiceBinding,
  resolveNarratorVoiceForGeneration,
  type ResolvedVoice,
} from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { MediaConnection } from '@/lib/server/model-config/media';
import {
  qwenInstructPromptSection,
  qwenInstructionsForModel,
  supportsQwenInstructionControl,
} from '@/lib/audio/qwen-instruct-control';

import type { GenerationRunInput } from './types';

/** The `tts` slot as a run narrates through it. */
export interface RunNarrationTarget {
  connection: MediaConnection;
  providerId: TTSProviderId;
  /** The slot's model, else the provider's default. */
  modelId?: string;
}

/** The per-provider map the voice helpers read: the slot's provider, available through the server. */
function providersConfig(target: RunNarrationTarget): Record<
  string,
  {
    apiKey: string;
    baseUrl: string;
    enabled: boolean;
    isServerConfigured: boolean;
    modelId?: string;
    voices?: ConfiguredTTSVoice[];
    providerOptions?: Record<string, string | number | boolean>;
  }
> {
  return {
    [target.providerId]: {
      apiKey: '',
      baseUrl: '',
      enabled: true,
      isServerConfigured: true,
      ...(target.connection.voices ? { voices: target.connection.voices } : {}),
      ...(target.modelId ? { modelId: target.modelId } : {}),
      ...(target.connection.options ? { providerOptions: { ...target.connection.options } } : {}),
    },
  };
}

/** A provider's default voice, or the first catalogue voice its model can speak. */
function defaultVoiceFor(
  providerId: string,
  modelId?: string,
  options?: Record<string, unknown>,
  configuredVoices?: readonly { id: string }[],
): string {
  const configured = configuredDefaultVoice(options, configuredVoices);
  if (configured) return configured;
  const preferred = DEFAULT_TTS_VOICES[providerId as BuiltInTTSProviderId] || 'default';
  if (voiceServesModel(providerId, preferred, modelId)) return preferred;
  const voices = TTS_PROVIDERS[providerId as BuiltInTTSProviderId]?.voices ?? [];
  return voices.find((voice) => voiceServesModel(providerId, voice.id, modelId))?.id ?? preferred;
}

/** The learner's voice for the slot's provider, else the provider's default. */
export function slotVoice(
  target: RunNarrationTarget,
  preference: GenerationRunInput['voice'],
): { voice: string; speed: number } {
  const usable =
    preference?.providerId === target.providerId &&
    !!preference.voiceId &&
    voiceAllowedByConfiguredCatalogue(
      target.providerId,
      preference.voiceId,
      target.connection.voices,
    ) &&
    voiceServesModel(
      target.providerId,
      preference.voiceId,
      target.modelId,
      target.connection.voices,
    );
  return {
    voice: usable
      ? preference!.voiceId
      : defaultVoiceFor(
          target.providerId,
          target.modelId,
          target.connection.options,
          target.connection.voices,
        ),
    speed: preference?.speed ?? 1,
  };
}

/** Catalog gender for a preset voice. Registered clones are not in the catalog. */
function catalogVoiceGender(
  providerId: string,
  voiceId: string,
): 'male' | 'female' | 'neutral' | undefined {
  if (!Object.hasOwn(TTS_PROVIDERS, providerId)) return undefined;
  return TTS_PROVIDERS[providerId as keyof typeof TTS_PROVIDERS].voices.find(
    (voice) => voice.id === voiceId,
  )?.gender;
}

/** The voices the agent-profiles step may bind agents to, as the browser advertises them. */
export function advertisedVoices(target: RunNarrationTarget) {
  return getEnabledProvidersWithVoices(providersConfig(target)).flatMap((provider) =>
    provider.voices.map((voice) => {
      const cloneModelGroup =
        provider.providerId === 'qwen-tts' && isQwenCloneVoice(voice.id, target.connection.voices)
          ? provider.modelGroups.find((group) =>
              group.voices.some((groupVoice) => groupVoice.id === voice.id),
            )
          : undefined;
      const modelId = cloneModelGroup
        ? resolveTTSModelForVoice(provider.providerId, voice.id, cloneModelGroup.modelId)
        : undefined;
      const gender = provider.configuredVoiceList
        ? voice.gender
        : (voice.gender ?? catalogVoiceGender(provider.providerId, voice.id));
      return {
        providerId: provider.providerId,
        ...(modelId ? { modelId } : {}),
        voiceId: voice.id,
        voiceName: voice.name,
        voiceLanguage: voice.language,
        ...(gender ? { gender } : {}),
      };
    }),
  );
}

/** The narrator voice the teacher is pinned to at agent generation. */
export function narratorVoiceForGeneration(
  target: RunNarrationTarget,
  preference: GenerationRunInput['voice'],
): ResolvedVoice | undefined {
  const { voice } = slotVoice(target, preference);
  return resolveNarratorVoiceForGeneration(
    target.providerId,
    voice,
    providersConfig(target)[target.providerId],
  );
}

/**
 * The voice one narration clip starts with, as the browser decides it
 * (`generateAndStoreTTS`): the teacher's bound voice unless it was found
 * unusable, else the slot voice; a pinned narrator (bound == slot voice) whose
 * provider is not the slot's falls to the deterministic enabled-provider
 * pick. Null when the voice's provider is not one the slot enables (the line
 * stays unvoiced, as in the browser).
 */
export function clipVoice(input: {
  target: RunNarrationTarget;
  preference: GenerationRunInput['voice'];
  bound: AgentConfig['voiceConfig'] | undefined;
  /** The bindings this run found unusable (a deleted clone, say). */
  unavailable: ReadonlySet<string>;
  /** An explicit voice a retry uses instead. */
  override?: ResolvedVoice;
}): { voice: ResolvedVoice; globalVoice: ResolvedVoice } | null {
  const { target, bound } = input;
  const configs = providersConfig(target);
  const globalVoice: ResolvedVoice = {
    providerId: target.providerId,
    ...(target.connection.modelId ? { modelId: target.connection.modelId } : {}),
    voiceId: slotVoice(target, input.preference).voice,
  };
  let voice =
    input.override ??
    resolveNarratorVoiceBinding(
      bound && input.unavailable.has(voiceBindingKey(bound)) ? undefined : bound,
      globalVoice,
      configs,
    );
  if (
    bound &&
    !narratorBindingDiffers(bound, globalVoice) &&
    !isTTSProviderEnabled(voice.providerId, configs[voice.providerId])
  ) {
    voice = deterministicNarratorVoice(configs) ?? voice;
  }
  if (!isTTSProviderEnabled(voice.providerId, configs[voice.providerId])) return null;
  return { voice, globalVoice };
}

/** The voice to retry a clip with after its voice clone was not found, or null. */
export function clipVoiceAfterMissingClone(input: {
  target: RunNarrationTarget;
  bound: AgentConfig['voiceConfig'] | undefined;
  globalVoice: ResolvedVoice;
  failed: ResolvedVoice;
  usedFallbackVoice: boolean;
}): ResolvedVoice | null {
  return narratorVoiceAfterMissingClone({
    bound: input.bound,
    globalVoice: input.globalVoice,
    failed: input.failed,
    providerConfigs: providersConfig(input.target),
    usedFallbackVoice: input.usedFallbackVoice,
  });
}

/** The provider config a voice's options are resolved against (its model follows the voice). */
export function clipProviderConfig(target: RunNarrationTarget, voice: ResolvedVoice) {
  const config = providersConfig(target)[voice.providerId];
  return {
    ...config,
    modelId: resolveTTSModelForVoice(
      voice.providerId,
      voice.voiceId,
      voice.modelId ?? config?.modelId,
      config?.voices,
    ),
  };
}

/**
 * What a run's instruction-control switch means for the voice it actually
 * narrates with. Both the provider and the model decide: a non-Qwen slot never
 * takes it, and it is gated on the model that accepts the parameter, so a user
 * who switched it on with a model that cannot honour it gets the previous
 * behaviour rather than a provider error.
 */
export function runQwenInstructControl(
  target: RunNarrationTarget | null,
  requested: GenerationRunInput['qwenInstructControl'],
): boolean {
  if (!target || target.providerId !== 'qwen-tts') return false;
  return requested === true && supportsQwenInstructionControl(target.modelId);
}

/**
 * The instruction a run's narration requests carry, or undefined for no
 * instruction. The run's own text is preferred over the built-in default, so a
 * course that customises it does so for the whole run rather than for the
 * browser's previews only.
 */
export function runQwenInstructions(
  target: RunNarrationTarget | null,
  requested: GenerationRunInput['qwenInstructControl'],
  text: GenerationRunInput['qwenInstructText'],
): string | undefined {
  if (!runQwenInstructControl(target, requested)) return undefined;
  return qwenInstructionsForModel(text, target?.modelId) ?? undefined;
}

/**
 * The narration-prompt guidance for a run's instruction control, or an empty
 * string — which is what keeps the action prompts byte-identical for every
 * provider and model without the feature.
 */
export function runNarrationPromptSection(
  target: RunNarrationTarget | null,
  requested: GenerationRunInput['qwenInstructControl'],
): string {
  return qwenInstructPromptSection(runQwenInstructControl(target, requested));
}

/**
 * The narration text this run's input asks for, resolved against the slot that
 * will narrate it. The neutral entry point the generation engine calls: which
 * input fields carry an instruction and which provider honours it stay here,
 * with the rest of the provider knowledge.
 */
export function runRequestedNarrationInstructions(
  target: RunNarrationTarget | null,
  input: Pick<GenerationRunInput, 'qwenInstructControl' | 'qwenInstructText'>,
): string | undefined {
  return runQwenInstructions(target, input.qwenInstructControl, input.qwenInstructText);
}

/** {@link runNarrationPromptSection} for a run's own input. */
export function runRequestedNarrationPromptSection(
  target: RunNarrationTarget | null,
  input: Pick<GenerationRunInput, 'qwenInstructControl'>,
): string {
  return runNarrationPromptSection(target, input.qwenInstructControl);
}

/**
 * Attach the resolved narration instructions to a voice's provider options.
 * A no-op without instructions or without options; the parameter name belongs
 * to the provider that defines it, so it is set here rather than in the engine.
 */
export function attachProviderInstructions(
  providerOptions: unknown,
  instructions: string | undefined,
): void {
  if (!instructions) return;
  const options = providerOptions as Record<string, unknown> | undefined;
  if (!options) return;
  options.qwenInstructions = instructions;
}
