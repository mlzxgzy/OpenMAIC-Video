/**
 * The outline revision step: the prompt it builds, the answer it accepts and
 * the normal form it returns. `callLLM` is mocked (as the outline step's test
 * mocks `streamLLM`), so every case is deterministic.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  OutlineRevisionError,
  parseOutlineRevisionResponse,
  repairOutlineScenes,
  reviseOutlines,
  type OutlineRevisionInput,
} from '@/lib/server/generation/steps/outline-revision';

import { fakeModel, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({ callLLM: vi.fn() }));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));

const model = fakeModel();

const input = (overrides: Partial<OutlineRevisionInput> = {}): OutlineRevisionInput => ({
  requirement: 'Teach photosynthesis to ten-year-olds',
  interactive: false,
  taskEngine: false,
  languageDirective: 'Teach in English.',
  outlines: [
    { id: 'o1', type: 'slide', title: 'Leaves', description: 'd', keyPoints: ['a'], order: 1 },
  ],
  instruction: 'Make the first scene a quiz',
  history: [],
  model,
  ...overrides,
});

/** Answer the next call with `text`; `finishReason` when a case needs one. */
function answers(...texts: string[]) {
  let call = 0;
  mocks.callLLM.mockImplementation(async () => ({
    text: texts[Math.min(call++, texts.length - 1)]!,
    finishReason: 'stop',
  }));
}

function ctx() {
  return { log: testLogger() };
}

describe('outline revision step', () => {
  beforeEach(() => {
    mocks.callLLM.mockReset();
  });

  it('returns the revised outline and the model message', async () => {
    answers(
      JSON.stringify({
        message: 'Turned the first scene into a quiz.',
        outlines: [
          { id: 'o1', type: 'quiz', title: 'Leaves', description: 'd', keyPoints: ['a'], order: 1 },
        ],
      }),
    );

    const result = await reviseOutlines(input(), ctx());

    expect(result.message).toBe('Turned the first scene into a quiz.');
    expect(result.outlines).toEqual([
      {
        id: 'o1',
        type: 'quiz',
        title: 'Leaves',
        description: 'd',
        keyPoints: ['a'],
        order: 1,
      },
    ]);
  });

  it('grounds the prompt in the requirement, the current outline and the instruction', async () => {
    answers(
      '{"message":"ok","outlines":[{"id":"o1","type":"slide","title":"T","description":"d","keyPoints":[],"order":1}]}',
    );

    await reviseOutlines(
      input({
        history: [
          { role: 'user', content: 'Make it shorter' },
          { role: 'assistant', content: 'Shortened it.' },
        ],
      }),
      ctx(),
    );

    const [params, source] = mocks.callLLM.mock.calls[0]!;
    expect(source).toBe('outline-revision');
    expect(params.system).toContain('JSON');
    expect(params.prompt).toContain('Teach photosynthesis to ten-year-olds');
    expect(params.prompt).toContain('Make the first scene a quiz');
    expect(params.prompt).toContain('"id": "o1"');
    expect(params.prompt).toContain('Learner: Make it shorter');
    expect(params.prompt).toContain('Assistant: Shortened it.');
    expect(params.prompt).toContain('slide, quiz, interactive, pbl');
    expect(params.prompt).not.toContain('{{');
  });

  it('accepts a fenced or prose-wrapped answer', async () => {
    answers(
      'Here you go:\n```json\n{"message":"done","outlines":[{"id":"o1","type":"slide","title":"T","description":"d","keyPoints":[],"order":1}]}\n```',
    );

    const result = await reviseOutlines(input(), ctx());
    expect(result.outlines[0]!.id).toBe('o1');
  });

  it('repairs the scenes a model invents: unique ids, positional order', async () => {
    answers(
      JSON.stringify({
        message: 'Added a wrap-up.',
        outlines: [
          { type: 'slide', title: 'New intro', description: 'd', keyPoints: [] },
          { id: 'o1', type: 'slide', title: 'Leaves', description: 'd', keyPoints: [], order: 9 },
          { id: 'o1', type: 'slide', title: 'Wrap up', description: 'd', keyPoints: [] },
        ],
      }),
    );

    const result = await reviseOutlines(input(), ctx());

    const repaired = repairOutlineScenes([
      { type: 'slide' },
      { id: 'a', order: 2 },
      { id: 'a', order: 2 },
    ]);
    expect(new Set(repaired.map((scene) => (scene as { id: string }).id)).size).toBe(3);
    expect(repaired.map((scene) => (scene as { order: number }).order)).toEqual([1, 2, 3]);

    expect(result.outlines.map((scene) => scene.order)).toEqual([1, 2, 3]);
    expect(new Set(result.outlines.map((scene) => scene.id)).size).toBe(3);
    // The scene the model kept its id for is untouched.
    expect(result.outlines[1]!.title).toBe('Leaves');
    expect(result.outlines[1]!.id).toBe('o1');
  });

  it('re-mints media element ids so no two scenes collide', async () => {
    answers(
      JSON.stringify({
        message: 'ok',
        outlines: [
          {
            id: 'o1',
            type: 'slide',
            title: 'A',
            description: 'd',
            keyPoints: [],
            order: 1,
            mediaGenerations: [{ type: 'image', prompt: 'a leaf', elementId: 'gen_img_1' }],
          },
          {
            id: 'o2',
            type: 'slide',
            title: 'B',
            description: 'd',
            keyPoints: [],
            order: 2,
            mediaGenerations: [{ type: 'image', prompt: 'a stem', elementId: 'gen_img_1' }],
          },
        ],
      }),
    );

    const result = await reviseOutlines(input(), ctx());
    const ids = result.outlines.flatMap((scene) =>
      (scene.mediaGenerations ?? []).map((media) => media.elementId),
    );
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(result.outlines[0]!.mediaGenerations![0]!.prompt).toBe('a leaf');
  });

  it('drops scene types the composer left out, and refuses an empty remainder', async () => {
    answers(
      JSON.stringify({
        message: 'ok',
        outlines: [
          { id: 'o1', type: 'slide', title: 'T', description: 'd', keyPoints: [], order: 1 },
          { id: 'o2', type: 'pbl', title: 'Project', description: 'd', keyPoints: [], order: 2 },
        ],
      }),
    );

    const kept = await reviseOutlines(input({ sceneTypes: ['slide'] }), ctx());
    expect(kept.outlines.map((scene) => scene.id)).toEqual(['o1']);

    await expect(reviseOutlines(input({ sceneTypes: ['quiz'] }), ctx())).rejects.toBeInstanceOf(
      OutlineRevisionError,
    );
  });

  it('refuses an answer that is not a usable outline', async () => {
    for (const text of [
      '',
      'I could not do that.',
      '{"outlines":[]}',
      '{"message":"ok","outlines":[{"id":"o1","title":"No type"}]}',
    ]) {
      answers(text);
      await expect(reviseOutlines(input(), ctx()), text).rejects.toBeInstanceOf(
        OutlineRevisionError,
      );
    }
  });

  it('arms one retry on an answer that cannot be parsed', async () => {
    answers('{"message":"ok","outlines":[]}');
    await reviseOutlines(input(), ctx()).catch(() => undefined);

    const retryOptions = mocks.callLLM.mock.calls[0]![2] as {
      retries: number;
      validate: (text: string) => boolean;
    };
    expect(retryOptions.retries).toBe(1);
    expect(retryOptions.validate('{"outlines":[{"id":"o1"}]}')).toBe(true);
    expect(retryOptions.validate('nope')).toBe(false);
  });

  it('parses an object without a message', () => {
    expect(parseOutlineRevisionResponse('{"outlines":[{"id":"o1"}]}')).toEqual({
      message: '',
      outlines: [{ id: 'o1' }],
    });
  });
});
