/**
 * The instruction-control switch as the settings test TTS resolves it: whether a
 * test request carries the delivery instruction, and — the part that decides
 * it — which model the test is judged against.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ qwenTtsInstructControl: false }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => store,
  },
}));

import { qwenInstructionControlFor } from '@/lib/audio/qwen-instruct-control-selection';

describe('the test TTS instruction flag', () => {
  beforeEach(() => {
    store.qwenTtsInstructControl = true;
  });

  it('is set for a Qwen Instruct model, so the test speaks as the narration will', () => {
    expect(qwenInstructionControlFor('qwen3-tts-instruct-flash', 'qwen-tts')).toBe(true);
  });

  it('is not set for a model that would reject the parameter', () => {
    expect(qwenInstructionControlFor('qwen3-tts-flash', 'qwen-tts')).toBe(false);
  });

  it('is not set for a voice-clone model, which pins its own synthesis path', () => {
    expect(qwenInstructionControlFor('qwen3-tts-vc-2026-01-22', 'qwen-tts')).toBe(false);
  });

  it('is not set for another provider, whatever the switch says', () => {
    expect(qwenInstructionControlFor('qwen3-tts-instruct-flash', 'openai-tts')).toBe(false);
  });

  it('is not set when the switch is off', () => {
    store.qwenTtsInstructControl = false;
    expect(qwenInstructionControlFor('qwen3-tts-instruct-flash', 'qwen-tts')).toBe(false);
  });

  it('is not set for no model at all, rather than assumed to apply', () => {
    // A provider that names no model synthesizes with its default; if that
    // default were an Instruct one the panel's gate would have to say so, and
    // sending the parameter blind is what makes DashScope reject a request.
    expect(qwenInstructionControlFor(undefined, 'qwen-tts')).toBe(false);
  });
});
