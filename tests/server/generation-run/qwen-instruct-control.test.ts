/**
 * A run's Qwen instruction-control switch: what the start body accepts, how the
 * server resolves it against the model that will narrate, and what the script
 * prompts gain because of it.
 */
import { describe, expect, it } from 'vitest';

import { parseRunInput } from '@/lib/server/generation/run/input';
import {
  runNarrationPromptSection,
  runQwenInstructControl,
  runQwenInstructions,
  type RunNarrationTarget,
} from '@/lib/server/generation/run/narration-voice';
import {
  DEFAULT_QWEN_INSTRUCTIONS,
  QWEN_INSTRUCT_MAX_CHARS,
} from '@/lib/audio/qwen-instruct-control';

function target(providerId: string, modelId?: string): RunNarrationTarget {
  return {
    connection: { providerId, managed: true, origin: 'configuration' } as never,
    providerId: providerId as never,
    ...(modelId ? { modelId } : {}),
  };
}

describe('the start body', () => {
  it('defaults the switch to absent, so a run behaves exactly as before', () => {
    const parsed = parseRunInput({ requirement: 'Teach fractions' });
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.qwenInstructControl).toBeUndefined();
  });

  it('reads the switch', () => {
    const parsed = parseRunInput({ requirement: 'Teach fractions', qwenInstructControl: true });
    expect(parsed.ok && parsed.value.qwenInstructControl).toBe(true);
  });

  it('refuses a non-boolean switch', () => {
    expect(
      parseRunInput({ requirement: 'Teach fractions', qwenInstructControl: 'yes' }),
    ).toMatchObject({ ok: false });
  });

  it('carries the instruction text the user wrote', () => {
    const parsed = parseRunInput({
      requirement: 'Teach fractions',
      qwenInstructControl: true,
      qwenInstructText: '语速放慢。',
    });
    expect(parsed.ok && parsed.value.qwenInstructText).toBe('语速放慢。');
  });

  it('refuses an instruction longer than the provider accepts', () => {
    // The server cannot read the settings store, so the text arrives in the body
    // and has to be bounded here as well as in the browser.
    expect(
      parseRunInput({
        requirement: 'Teach fractions',
        qwenInstructText: 'x'.repeat(QWEN_INSTRUCT_MAX_CHARS + 1),
      }),
    ).toMatchObject({ ok: false });
  });

  it('refuses a non-string instruction', () => {
    expect(parseRunInput({ requirement: 'Teach fractions', qwenInstructText: 42 })).toMatchObject({
      ok: false,
    });
  });
});

describe('the instruction a run sends', () => {
  it('is the default when the run carries no text of its own', () => {
    expect(
      runQwenInstructions(target('qwen-tts', 'qwen3-tts-instruct-flash'), true, undefined),
    ).toBe(DEFAULT_QWEN_INSTRUCTIONS);
  });

  it("is the run's own text when it carries one", () => {
    expect(
      runQwenInstructions(target('qwen-tts', 'qwen3-tts-instruct-flash'), true, '语速放慢。'),
    ).toBe('语速放慢。');
  });

  it('is nothing when the switch is off, even with text attached', () => {
    expect(
      runQwenInstructions(target('qwen-tts', 'qwen3-tts-instruct-flash'), false, '语速放慢。'),
    ).toBeUndefined();
  });

  it('is nothing for a model that would reject the parameter', () => {
    expect(
      runQwenInstructions(target('qwen-tts', 'qwen3-tts-flash'), true, '语速放慢。'),
    ).toBeUndefined();
  });

  it('is nothing for another provider', () => {
    expect(
      runQwenInstructions(target('openai-tts', 'gpt-4o-mini-tts'), true, 'Speak slowly.'),
    ).toBeUndefined();
  });
});

describe('resolving a run against the model that narrates', () => {
  it('never enables it for a non-Qwen provider', () => {
    expect(runQwenInstructControl(target('openai-tts', 'gpt-4o-mini-tts'), true)).toBe(false);
    // Even for an unassigned slot (no target at all).
    expect(runQwenInstructControl(null, true)).toBe(false);
  });

  it('keeps it only on a model that accepts the parameter', () => {
    expect(runQwenInstructControl(target('qwen-tts', 'qwen3-tts-instruct-flash'), true)).toBe(true);
    expect(runQwenInstructControl(target('qwen-tts', 'qwen3-tts-flash'), true)).toBe(false);
  });

  it('treats an absent switch as off', () => {
    expect(runQwenInstructControl(target('qwen-tts', 'qwen3-tts-instruct-flash'), undefined)).toBe(
      false,
    );
  });
});

describe('the narration prompt section a run gains', () => {
  it('is empty for a provider without the feature', () => {
    expect(runNarrationPromptSection(target('openai-tts', 'gpt-4o-mini-tts'), true)).toBe('');
    expect(runNarrationPromptSection(null, true)).toBe('');
  });

  it('is empty when the model cannot take the instruction, keeping the prompts unchanged', () => {
    expect(runNarrationPromptSection(target('qwen-tts', 'qwen3-tts-flash'), true)).toBe('');
  });

  it('carries the delivery-instruction rules for an Instruct model', () => {
    const section = runNarrationPromptSection(target('qwen-tts', 'qwen3-tts-instruct-flash'), true);
    expect(section).toContain('Delivery Instruction');
  });
});
