/**
 * The instruction-control switch as the settings test TTS resolves it: what a
 * test request carries, and — the part that decides it — which model the test
 * is judged against.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ qwenTtsInstructControl: true, qwenTtsInstructText: '' }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: {
    getState: () => store,
  },
}));

import { DEFAULT_QWEN_INSTRUCTIONS } from '@/lib/audio/qwen-instruct-control';
import { qwenInstructionsForRequest } from '@/lib/audio/qwen-instruct-control-selection';

describe('the test TTS instruction', () => {
  beforeEach(() => {
    store.qwenTtsInstructControl = true;
    store.qwenTtsInstructText = '';
  });

  it('is the built-in default for a Qwen Instruct model, so the test speaks as narration will', () => {
    expect(qwenInstructionsForRequest('qwen3-tts-instruct-flash', 'qwen-tts')).toBe(
      DEFAULT_QWEN_INSTRUCTIONS,
    );
  });

  it('is what the user wrote, not the default, when they wrote one', () => {
    const custom = '语速放慢，像在给小学生讲一道很难的题。';
    store.qwenTtsInstructText = custom;
    expect(qwenInstructionsForRequest('qwen3-tts-instruct-flash', 'qwen-tts')).toBe(custom);
  });

  it('falls back to the default for whitespace alone, rather than sending it', () => {
    store.qwenTtsInstructText = '   \n  ';
    expect(qwenInstructionsForRequest('qwen3-tts-instruct-flash', 'qwen-tts')).toBe(
      DEFAULT_QWEN_INSTRUCTIONS,
    );
  });

  it('is absent for a model that would reject the parameter', () => {
    store.qwenTtsInstructText = '语速放慢。';
    expect(qwenInstructionsForRequest('qwen3-tts-flash', 'qwen-tts')).toBeUndefined();
  });

  it('is absent for a voice-clone model, which pins its own synthesis path', () => {
    expect(qwenInstructionsForRequest('qwen3-tts-vc-2026-01-22', 'qwen-tts')).toBeUndefined();
  });

  it('is absent for another provider, whatever the switch says', () => {
    expect(qwenInstructionsForRequest('qwen3-tts-instruct-flash', 'openai-tts')).toBeUndefined();
  });

  it('is absent when the switch is off', () => {
    store.qwenTtsInstructControl = false;
    expect(qwenInstructionsForRequest('qwen3-tts-instruct-flash', 'qwen-tts')).toBeUndefined();
  });

  it('is absent for no model at all, rather than assumed to apply', () => {
    // A provider that names no model synthesizes with its default; if that
    // default were an Instruct one the panel's gate would have to say so, and
    // sending the parameter blind is what makes DashScope reject a request.
    expect(qwenInstructionsForRequest(undefined, 'qwen-tts')).toBeUndefined();
  });
});
