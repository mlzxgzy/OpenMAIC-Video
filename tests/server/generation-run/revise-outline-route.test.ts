/**
 * `POST /api/generation-runs/:id/revise-outline`: the route's own contract —
 * same-origin JSON only, owner-scoped, only for a run still waiting for its
 * outline, and a failed revision leaves the caller's outline alone. The step's
 * model is mocked; the step module itself is real.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { SlotUnassignedError } from '@/lib/server/model-config/runtime';
import type { StoredRun } from '@/lib/server/generation/run/store';

const mocks = vi.hoisted(() => ({
  readGenerationRun: vi.fn(),
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../../helpers/owner-resolution-mock')).ownerResolveModule(() => 'owner-1'),
);
vi.mock('@/lib/server/generation/run/store', () => ({
  isRunId: (value: string) => /^run-[A-Za-z0-9_-]{16}$/.test(value),
  readGenerationRun: mocks.readGenerationRun,
}));
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/model-config/runtime')>();
  return { ...actual, backgroundWorkspaceId: async (ownerId: string) => ownerId };
});

import { POST } from '@/app/api/generation-runs/[id]/revise-outline/route';

const RUN_ID = 'run-abcdefghijklmnop';

const outline = {
  id: 'o1',
  type: 'slide',
  title: 'Leaves',
  description: 'd',
  keyPoints: ['a'],
  order: 1,
};

const waitingRun = {
  state: 'awaiting_outline_confirmation',
  input: { requirement: 'Teach photosynthesis', interactive: false, taskEngine: false },
  outline: { outlines: [outline], languageDirective: 'Teach in English.', taskEngineMode: false },
} as unknown as StoredRun;

function call(
  body: unknown,
  options: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return POST(
    new NextRequest(`http://localhost/api/generation-runs/${RUN_ID}/revise-outline`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: RUN_ID }) },
  );
}

const revisionBody = { instruction: 'Make the first scene a quiz', outlines: [outline] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.readGenerationRun.mockResolvedValue(waitingRun);
  mocks.resolveModel.mockResolvedValue({
    model: { provider: 'test.chat', modelId: 'test-model' },
    modelInfo: { outputWindow: 4096, capabilities: {} },
    modelString: 'test:test-model',
    thinkingConfig: undefined,
    serverManaged: false,
  });
  mocks.callLLM.mockResolvedValue({
    text: JSON.stringify({
      message: 'Turned the first scene into a quiz.',
      outlines: [{ ...outline, type: 'quiz' }],
    }),
  });
});

describe('POST outline revision', () => {
  it('returns the revised outline and the model message', async () => {
    const response = await call(revisionBody);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      success: true,
      outlines: [{ ...outline, type: 'quiz' }],
      message: 'Turned the first scene into a quiz.',
    });
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
  });

  it('refuses a cross-site request before anything else', async () => {
    const response = await call(revisionBody, { headers: { 'Sec-Fetch-Site': 'cross-site' } });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INVALID_REQUEST' });
    expect(mocks.readGenerationRun).not.toHaveBeenCalled();
  });

  it('refuses a body without a usable outline or instruction', async () => {
    const response = await call({ instruction: 'x' });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'INVALID_REQUEST' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('answers an unknown run as the no-existence-oracle 404', async () => {
    mocks.readGenerationRun.mockResolvedValue(null);

    const response = await call(revisionBody);

    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toBe('Not found');
  });

  it('refuses a run that is no longer waiting for its outline', async () => {
    mocks.readGenerationRun.mockResolvedValue({
      ...waitingRun,
      state: 'generating',
    } as unknown as StoredRun);

    const response = await call(revisionBody);

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'RUN_STATE_CONFLICT' });
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('answers an unassigned outline model as a missing model', async () => {
    mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));

    const response = await call(revisionBody);

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'MISSING_MODEL' });
  });

  it('answers an unusable model reply as a failed generation, not a broken outline', async () => {
    mocks.callLLM.mockResolvedValue({ text: 'I cannot do that.' });

    const response = await call(revisionBody);

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toMatchObject({ errorCode: 'GENERATION_FAILED' });
  });
});
