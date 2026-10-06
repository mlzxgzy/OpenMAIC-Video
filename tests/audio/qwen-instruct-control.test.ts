/**
 * Qwen instruction control: the model gate, and the narration-prompt guidance
 * a run gains from it.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_QWEN_INSTRUCTIONS,
  QWEN_INSTRUCT_MAX_CHARS,
  qwenInstructPromptSection,
  qwenInstructionsFor,
  qwenInstructionsForModel,
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

describe('which instruction a request carries', () => {
  it('is the built-in default when the user wrote none', () => {
    expect(qwenInstructionsFor(undefined)).toBe(DEFAULT_QWEN_INSTRUCTIONS);
    expect(qwenInstructionsFor('')).toBe(DEFAULT_QWEN_INSTRUCTIONS);
    expect(qwenInstructionsFor(null)).toBe(DEFAULT_QWEN_INSTRUCTIONS);
  });

  it('is the default for whitespace alone, since sending it says nothing', () => {
    expect(qwenInstructionsFor('  \n\t ')).toBe(DEFAULT_QWEN_INSTRUCTIONS);
  });

  it("is the user's own text, trimmed, when they wrote one", () => {
    expect(qwenInstructionsFor('  语速放慢。\n')).toBe('语速放慢。');
  });

  it('caps an over-long instruction rather than letting the provider reject it', () => {
    const essay = '语速放慢。'.repeat(400);
    expect(essay.length).toBeGreaterThan(QWEN_INSTRUCT_MAX_CHARS);
    expect(qwenInstructionsFor(essay)).toHaveLength(QWEN_INSTRUCT_MAX_CHARS);
  });

  it('leaves the default comfortably inside the provider limit', () => {
    // The cap exists to refuse a pasted essay, not to be the binding constraint
    // on ordinary use: a Chinese instruction is roughly one token per character.
    expect(DEFAULT_QWEN_INSTRUCTIONS.length).toBeLessThan(QWEN_INSTRUCT_MAX_CHARS);
  });

  it('is nothing at all for a model that would reject the parameter', () => {
    // Whatever the text says, a non-Instruct model gets no instruction — the
    // help card must not promise a delivery the request will not carry.
    expect(qwenInstructionsForModel('语速放慢。', 'qwen3-tts-flash')).toBeNull();
    expect(qwenInstructionsForModel('语速放慢。', undefined)).toBeNull();
  });

  it('is the text for an Instruct model', () => {
    expect(qwenInstructionsForModel('语速放慢。', 'qwen3-tts-instruct-flash')).toBe('语速放慢。');
    expect(qwenInstructionsForModel(undefined, 'qwen3-tts-instruct-flash')).toBe(
      DEFAULT_QWEN_INSTRUCTIONS,
    );
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
