/**
 * The scene-type filter offers only what a mode can actually build, so this
 * pins the reason: the interactive-first and task-engine outline templates ask
 * for slides and widgets and never for a quiz or a PBL scene. Should a template
 * start emitting those, this fails and `availableSceneTypes` in `app/page.tsx`
 * can offer them again.
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

import { ALL_SCENE_TYPES } from '@/lib/types/generation';

const TEMPLATES = path.join(process.cwd(), 'lib', 'prompts', 'templates');

function template(promptId: string, file: 'system.md' | 'user.md'): string {
  return fs.readFileSync(path.join(TEMPLATES, promptId, file), 'utf-8');
}

/** The scene types a template names, in a JSON example or in its own rules. */
function typesNamedIn(prompt: string): Set<string> {
  const named = new Set<string>();
  const add = (value: string | undefined) => {
    if (value && ALL_SCENE_TYPES.includes(value as never)) named.add(value);
  };
  // The JSON examples carry the strongest signal: `"type": "quiz"`.
  for (const match of prompt.matchAll(/"type":\s*"([a-z]+)"/g)) add(match[1]);
  // The prose names a type in backticks: `pbl`. A bare `"quiz"` is NOT a
  // signal — `gameType: "action" | ... | "quiz"` is a widget's game, not a
  // scene, and the interactive template names one while asking for no quiz
  // scene at all.
  for (const match of prompt.matchAll(/`([a-z]+)`/g)) add(match[1]);
  return named;
}

describe.each([
  ['interactive-outlines', '深度交互'],
  ['task-engine-outlines', '职业任务引擎'],
])('%s template only builds the types the filter offers', (promptId) => {
  const types = typesNamedIn(template(promptId, 'system.md'));

  it('names slide and interactive', () => {
    expect(types.has('slide')).toBe(true);
    expect(types.has('interactive')).toBe(true);
  });

  it('never asks for a quiz or a PBL scene', () => {
    expect(types.has('quiz')).toBe(false);
    expect(types.has('pbl')).toBe(false);
  });
});

describe('the standard template', () => {
  it('does build all four types', () => {
    const types = typesNamedIn(
      fs.readFileSync(
        path.join(
          process.cwd(),
          'packages',
          '@openmaic',
          'generation',
          'templates',
          'requirements-to-outlines',
          'system.md',
        ),
        'utf-8',
      ),
    );
    expect([...types].sort()).toEqual([...ALL_SCENE_TYPES].sort());
  });
});
