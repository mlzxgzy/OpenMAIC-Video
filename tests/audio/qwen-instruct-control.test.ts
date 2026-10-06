/**
 * Qwen instruction control: the model gate, and the narration-prompt guidance
 * a run gains from it.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QWEN_INSTRUCTIONS,
  qwenInstructPromptSection,
  supportsQwenInstructionControl,
} from '@/lib/audio/qwen-instruct-control';

describe('Qwen instruction-control model gating', () => {
  it('accepts the delivery instruction only on the Instruct series', () => {
    expect(supportsQwenInstructionControl('qwen3-tts-instruct-flash')).toBe(true);
    expect(supportsQwenInstructionControl('qwen3-tts-instruct-flash-2026-01-26')).toBe(true);
    // The model learners normally use does not take the parameter.
    expect(supportsQwenInstructionControl('qwen3-tts-flash')).toBe(false);
    expect(supportsQwenInstructionControl('qwen-tts')).toBe(false);
    expect(supportsQwenInstructionControl('qwen3-tts-vc-2026-01-22')).toBe(false);
  });

  it('assumes an unknown model does not support it', () => {
    // Sending `instructions` to a model that rejects it fails the request, so an
    // operator-pinned id we do not know must not enable it.
    expect(supportsQwenInstructionControl('operator-internal-model')).toBe(false);
    expect(supportsQwenInstructionControl(undefined)).toBe(false);
  });

  it('ships a non-empty delivery instruction for the request', () => {
    expect(DEFAULT_QWEN_INSTRUCTIONS.length).toBeGreaterThan(0);
  });
});

describe('the narration prompt section', () => {
  it('is empty when the switch is off (the prompt stays byte-identical)', () => {
    expect(qwenInstructPromptSection(false)).toBe('');
  });

  it('tells the model to write words only, since the instruction carries the delivery', () => {
    const section = qwenInstructPromptSection(true);
    expect(section).toContain('Delivery Instruction');
    // The stage directions that would otherwise be read out as noise.
    expect(section).toContain('(smiling)');
    expect(section).toMatch(/stage directions/i);
  });
});
