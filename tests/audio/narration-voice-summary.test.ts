/**
 * `narrationVoiceSummary` is what the re-voicing panel shows, and it is only
 * trustworthy if it reports the SAME voice and pace the synthesis would use.
 *
 * The invariant is deliberately structural rather than a snapshot: the summary
 * re-uses `generateAndStoreTTS`'s resolvers, so the tests below pin the two
 * ways that can go wrong independently of a full refactor —
 *
 *   1. it reports a different voice than the synthesis path would resolve
 *      (teacher binding precedence, and the pinned-narrator fallback), and
 *   2. reading it CHANGES what a later synthesis resolves.
 *
 * (2) is the subtle one. `generateAndStoreTTS` marks an unusable voice binding
 * as dead — a module-level mutation that steers every later clip to a fallback.
 * A display-only read that did the same would re-voice a course in a different
 * timbre just because the user opened the panel to look.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { setModelSettingsViewForTests } from '../helpers/model-settings-view';

const mocks = vi.hoisted(() => ({
  settingsState: vi.fn(),
  listAgents: vi.fn(),
  isTTSProviderEnabled: vi.fn(),
}));

vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: { getState: mocks.settingsState },
}));

vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ listAgents: mocks.listAgents }) },
}));

// The enablement predicate decides whether a bound voice is usable at all, and
// it is what the tests below steer to exercise the fallback branches.
vi.mock('@/lib/audio/provider-enablement', () => ({
  isTTSProviderEnabled: mocks.isTTSProviderEnabled,
  BROWSER_NATIVE_TTS_PROVIDER_ID: 'browser-native-tts',
}));

import { narrationVoiceSummary } from '@/lib/audio/narration-voice-summary';
import {
  clearUnavailableVoiceBindingsForTests,
  isVoiceBindingUnavailable,
} from '@/lib/audio/unavailable-voice-bindings';

const teacher = (voiceConfig?: { providerId: string; voiceId: string }) => ({
  id: 'teacher-1',
  role: 'teacher',
  name: 'Teacher',
  persona: '',
  avatar: '',
  color: '',
  priority: 0,
  ...(voiceConfig ? { voiceConfig } : {}),
});

describe('narrationVoiceSummary', () => {
  beforeEach(() => {
    clearUnavailableVoiceBindingsForTests();
    mocks.listAgents.mockReset().mockReturnValue([]);
    // The slot's provider is enabled unless a test says otherwise.
    mocks.isTTSProviderEnabled.mockReset().mockReturnValue(true);
    mocks.settingsState.mockReset().mockReturnValue({
      ttsVoice: 'Cherry',
      ttsVoiceProviderId: 'qwen-tts',
      ttsSpeed: 1.1,
    });
    // The workspace's tts slot resolves to a server provider.
    setModelSettingsViewForTests({ tts: { registryId: 'qwen-tts' } });
  });

  it('reports the global voice and the global speed when no teacher is bound', async () => {
    const summary = await narrationVoiceSummary();
    expect(summary).toMatchObject({
      voiceId: 'Cherry',
      providerId: 'qwen-tts',
      speed: 1.1,
      fromTeacherBinding: false,
    });
  });

  it('prefers the teacher’s bound voice over the global preference', async () => {
    // This is the precedence `generateAndStoreTTS` uses, so the panel shows the
    // course's actual teacher rather than whatever the settings happen to say.
    mocks.listAgents.mockReturnValue([teacher({ providerId: 'qwen-tts', voiceId: 'Ethan' })]);
    const summary = await narrationVoiceSummary();
    expect(summary).toMatchObject({ voiceId: 'Ethan', fromTeacherBinding: true, speed: 1.1 });
  });

  it('falls back to the global voice when the binding’s provider is unusable', async () => {
    // A binding to a provider the `tts` slot does not name cannot be spoken by
    // this workspace, so `resolveNarratorVoiceBinding` drops it and the global
    // voice for the slot's own provider wins.
    mocks.listAgents.mockReturnValue([teacher({ providerId: 'openai-tts', voiceId: 'alloy' })]);
    mocks.isTTSProviderEnabled.mockImplementation(
      (providerId: string) => providerId !== 'openai-tts',
    );

    const summary = await narrationVoiceSummary();
    expect(summary).toMatchObject({ voiceId: 'Cherry', providerId: 'qwen-tts' });
  });

  it('does not mark a voice binding unavailable — a read must not change what a later clip resolves', async () => {
    const binding = { providerId: 'qwen-tts', voiceId: 'Ethan' };
    mocks.listAgents.mockReturnValue([teacher(binding)]);
    // A pinned narrator (bound == global) whose provider became disabled is the
    // one branch where `generateAndStoreTTS` mutates shared fallback state.
    mocks.settingsState.mockReturnValue({
      ttsVoice: 'Ethan',
      ttsVoiceProviderId: 'qwen-tts',
      ttsSpeed: 1,
    });
    mocks.isTTSProviderEnabled.mockReturnValue(false);

    await narrationVoiceSummary();

    // The synthesis path would have marked this dead; the summary must not.
    expect(isVoiceBindingUnavailable(binding)).toBe(false);
  });

  it('reports nothing when the workspace has no managed tts provider', async () => {
    setModelSettingsViewForTests({ tts: null });
    await expect(narrationVoiceSummary()).resolves.toBeNull();
  });

  it('reports nothing for browser-native speech, which has no per-line asset', async () => {
    // Browser speech is synthesized by the playback engine from the text at
    // play time, so there is no "current voice" for a regeneration to reuse.
    setModelSettingsViewForTests({ tts: { registryId: 'browser-native-tts' } });
    await expect(narrationVoiceSummary()).resolves.toBeNull();
  });
});
