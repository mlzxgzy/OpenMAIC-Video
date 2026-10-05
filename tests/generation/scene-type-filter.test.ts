import { beforeEach, describe, expect, test, vi } from 'vitest';

import { createLogger } from '@/lib/logger';
import { ALL_SCENE_TYPES, type UserRequirements } from '@/lib/types/generation';
import { parseRunInput } from '@/lib/server/generation/run/input';

const streamLLMMock = vi.hoisted(() => vi.fn());
const resolveModelMock = vi.hoisted(() => vi.fn());

vi.mock('@/lib/ai/llm', () => ({
  streamLLM: streamLLMMock,
}));

/**
 * Generate the outlines as a run does, with the stubbed model, and return what
 * the step reported followed by its result (`done`) or its failure (`error`).
 */
async function outlineEvents(requirements: Record<string, unknown>) {
  const { generateOutlines } = await import('@/lib/server/generation/steps/outline');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions read event fields freely
  const events: any[] = [];
  try {
    const result = await generateOutlines(
      {
        requirements: requirements as unknown as UserRequirements,
        pdfText: '',
        pdfImages: [],
        imageMapping: {},
        researchContext: '',
        model: await resolveModelMock(),
      },
      {
        log: createLogger('Outline'),
        workspaceId: null,
        resolveVisionImages: async (images) => [...images],
        emit: (event) => events.push(event),
      },
    );
    events.push({ type: 'done', ...result });
  } catch (error) {
    events.push({ type: 'error', error: error instanceof Error ? error.message : String(error) });
  }
  return events;
}

/** Stream one canned outline response through the step. */
function respondWith(outlines: unknown[]) {
  const response = JSON.stringify({ languageDirective: '用中文授课。', outlines });
  streamLLMMock.mockReturnValue({
    fullStream: (async function* () {
      yield { type: 'text-delta', text: response };
      yield { type: 'finish', finishReason: 'stop' };
    })(),
  });
}

/** One outline of each type, so any subset can be selected. */
const MIXED_OUTLINES = [
  { id: 'a', type: 'slide', title: '导入页', description: 'd', keyPoints: ['k'], order: 1 },
  { id: 'b', type: 'quiz', title: '随堂测验', description: 'd', keyPoints: ['k'], order: 2 },
  {
    id: 'c',
    type: 'interactive',
    title: '互动演示',
    description: 'd',
    keyPoints: ['k'],
    order: 3,
    widgetType: 'simulation',
    widgetOutline: { concept: 'x' },
  },
  { id: 'd', type: 'pbl', title: '项目实践', description: 'd', keyPoints: ['k'], order: 4 },
];

/**
 * Streaming an outline re-imports the whole outline module (`vi.resetModules`
 * in `beforeEach`), so the first case pays several seconds of module-graph
 * cost. The default 5s timeout leaves no margin on a loaded machine, so the
 * streaming cases declare their own.
 */
const STREAM_TIMEOUT_MS = 30_000;

describe('scene-type filter', () => {
  beforeEach(() => {
    vi.resetModules();
    streamLLMMock.mockReset();
    resolveModelMock.mockReset();
    resolveModelMock.mockResolvedValue({
      model: { provider: 'glm.chat', modelId: 'glm-5.1' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'glm:glm-5.1',
      providerId: 'glm',
      modelId: 'glm-5.1',
      thinkingConfig: undefined,
    });
  });

  test('creates every scene type when none is selected (the default)', async () => {
    respondWith(MIXED_OUTLINES);

    const events = await outlineEvents({ requirement: '讲一个主题' });

    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    expect(done.outlines.map((outline: { type: string }) => outline.type)).toEqual([
      'slide',
      'quiz',
      'interactive',
      'pbl',
    ]);
  }, STREAM_TIMEOUT_MS);

  test('skips the unchecked types instead of only hiding them', async () => {
    respondWith(MIXED_OUTLINES);

    const events = await outlineEvents({
      requirement: '讲一个主题',
      sceneTypes: ['slide', 'interactive'],
    });

    const done = events.find((event) => event.type === 'done');
    expect(done).toBeDefined();
    // The dropped scenes are absent from the result the run continues on, so
    // no content/actions/narration step is ever planned for them.
    expect(done.outlines.map((outline: { type: string }) => outline.type)).toEqual([
      'slide',
      'interactive',
    ]);
    expect(done.outlines.map((outline: { id: string }) => outline.id)).toEqual(['a', 'c']);
    // They are also never reported to the browser.
    const streamed = events
      .filter((event) => event.type === 'outline')
      .map((event) => event.data.type);
    expect(streamed).toEqual(['slide', 'interactive']);
  }, STREAM_TIMEOUT_MS);

  test('keeps the surviving scenes numbered 1..n', async () => {
    respondWith(MIXED_OUTLINES);

    const events = await outlineEvents({
      requirement: '讲一个主题',
      sceneTypes: ['quiz', 'pbl'],
    });

    const done = events.find((event) => event.type === 'done');
    expect(done.outlines.map((outline: { order: number }) => outline.order)).toEqual([1, 2]);
  }, STREAM_TIMEOUT_MS);

  test('tells the model which types it may create', async () => {
    respondWith(MIXED_OUTLINES);

    await outlineEvents({ requirement: '讲一个主题', sceneTypes: ['slide', 'pbl'] });

    const params = streamLLMMock.mock.calls[0][0] as { system: string };
    // The base template lists all four types, so the restriction is asserted
    // as its own trailing block rather than as the absence of a type name.
    expect(params.system).toContain('Scene type restriction');
    expect(params.system).toContain('Create scenes of ONLY these types: "slide", "pbl"');
    expect(params.system).toContain('Do not create any "quiz", "interactive" scene');
  }, STREAM_TIMEOUT_MS);

  test('leaves the prompt untouched when every type is kept', async () => {
    respondWith(MIXED_OUTLINES);

    await outlineEvents({ requirement: '讲一个主题', sceneTypes: [...ALL_SCENE_TYPES] });

    const params = streamLLMMock.mock.calls[0][0] as { system: string };
    expect(params.system).not.toContain('Scene type restriction');
  }, STREAM_TIMEOUT_MS);

  test('accepts a valid selection on the wire', () => {
    const parsed = parseRunInput({
      requirement: '讲一个主题',
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto' },
      outlineReview: 'wait',
      sceneTypes: ['quiz', 'slide'],
    });

    expect(parsed.ok).toBe(true);
    // Normalized to the canonical order so equal selections compare equal.
    expect(parsed.ok && parsed.value.sceneTypes).toEqual(['slide', 'quiz']);
  });

  test('rejects an empty or unknown selection on the wire', () => {
    const base = {
      requirement: '讲一个主题',
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto' },
      outlineReview: 'wait',
    };

    expect(parseRunInput({ ...base, sceneTypes: [] }).ok).toBe(false);
    expect(parseRunInput({ ...base, sceneTypes: ['video'] }).ok).toBe(false);
    expect(parseRunInput({ ...base, sceneTypes: 'slide' }).ok).toBe(false);
  });

  test('treats an absent selection as every type', () => {
    const parsed = parseRunInput({
      requirement: '讲一个主题',
      interactive: false,
      taskEngine: false,
      agents: { mode: 'auto' },
      outlineReview: 'wait',
    });

    expect(parsed.ok && parsed.value.sceneTypes).toBeUndefined();
  });
});