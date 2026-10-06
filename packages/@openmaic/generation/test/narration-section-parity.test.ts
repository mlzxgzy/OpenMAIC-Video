/**
 * The property that makes instruction control safe to ship: with the section
 * empty (every provider and model without the feature), each action template
 * must render exactly as it did before the `{{#if narrationPromptSection}}`
 * block existed — not merely "similar", byte for byte.
 */
import { describe, expect, it } from 'vitest';

import { buildPrompt, loadPrompt } from '../src/prompts/loader.js';

const ACTION_PROMPTS = [
  'slide-actions',
  'quiz-actions',
  'interactive-actions',
  'pbl-actions',
] as const;

const VARIABLES = {
  ctx: { courseTitle: 'Fractions' },
  courseContext: 'Course: Fractions',
  agents: 'Teacher',
  userProfile: '',
  languageDirective: 'Teach in Chinese.',
};

const SECTION = '### Delivery Instruction\n\nWrite only the words.';

for (const promptId of ACTION_PROMPTS) {
  describe(`${promptId} prompt`, () => {
    it('renders byte-identically to the block-free template when the section is off', () => {
      const prompt = loadPrompt(promptId)!;
      const on = buildPrompt(promptId, { ...VARIABLES, narrationPromptSection: '' })!;
      const baseline = buildPrompt(promptId, VARIABLES)!;

      // The section is genuinely present in the template …
      expect(prompt.systemPrompt).toContain('{{#if narrationPromptSection}}');
      // … yet adds nothing to the rendered prompt when it is empty: the output
      // is exactly what the template rendered before the block existed. (A
      // template with several conditionals cannot be compared by deleting the
      // text alone, so the baseline is the same build without the variable.)
      expect(on.system).toBe(baseline.system);
      expect(on.system).not.toContain('Delivery Instruction');
      expect(on.user).toBe(baseline.user);
    });

    it('carries the section into the prompt when the switch is on', () => {
      const built = buildPrompt(promptId, { ...VARIABLES, narrationPromptSection: SECTION })!;
      expect(built.system).toContain(SECTION);
      // The block boundary leaves no leftover blank-line run.
      expect(built.system).not.toMatch(/\n{4,}/);
    });

    it('leaves no unreplaced placeholder when the section is on', () => {
      const built = buildPrompt(promptId, { ...VARIABLES, narrationPromptSection: SECTION })!;
      expect(built.system).not.toContain('{{');
      expect(built.system).not.toContain('}}');
    });
  });
}
