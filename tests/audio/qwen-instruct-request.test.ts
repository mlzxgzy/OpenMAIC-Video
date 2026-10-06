import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateTTS } from '@/lib/audio/tts-providers';
import { DEFAULT_QWEN_INSTRUCTIONS } from '@/lib/audio/qwen-instruct-control';

// Qwen TTS issues its calls through undici's fetch (with a pinned dispatcher).
const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('undici', async (importOriginal) => {
  const actual = await importOriginal<typeof import('undici')>();
  return { ...actual, fetch: fetchMock };
});
vi.stubGlobal('fetch', fetchMock);

// Downloading the returned audio URL goes through the SSRF guard, which pins
// DNS; answer the lookup with a public address so the download can proceed.
const dnsMocks = vi.hoisted(() => ({ promisesLookup: vi.fn() }));
vi.mock('node:dns', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:dns')>();
  return {
    ...actual,
    promises: { ...actual.promises, lookup: dnsMocks.promisesLookup },
  };
});

const CONFIG = { apiKey: 'sk-test', baseUrl: 'https://dashscope.example.com/api/v1' };

/** A Qwen synthesis that succeeds: the provider returns an audio URL, then bytes. */
function mockSynthesis(): void {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        output: { audio: { url: 'https://dashscope.example.com/audio.wav' } },
      }),
    ),
  );
  fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1])));
}

/** The synthesis request's JSON body (the first call; the second fetches the audio). */
function synthesisBody(): { model: string; input: Record<string, unknown> } {
  return JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
}

async function synthesize(modelId: string, providerOptions?: Record<string, unknown>) {
  await generateTTS(
    {
      providerId: 'qwen-tts',
      modelId,
      voice: 'Cherry',
      speed: 1,
      apiKey: CONFIG.apiKey,
      baseUrl: CONFIG.baseUrl,
      ...(providerOptions ? { providerOptions } : {}),
    },
    'Hello class',
  );
  return synthesisBody();
}

describe('Qwen instruction control on the synthesis request', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    dnsMocks.promisesLookup.mockReset();
    dnsMocks.promisesLookup.mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);
  });

  it('sends instructions on an Instruct model when the switch is on', async () => {
    mockSynthesis();
    const body = await synthesize('qwen3-tts-instruct-flash', { qwenInstructionControl: true });
    expect(body.input.instructions).toBe(DEFAULT_QWEN_INSTRUCTIONS);
    expect(body.input.optimize_instructions).toBe(true);
    expect(body.model).toBe('qwen3-tts-instruct-flash');
  });

  it('omits the parameters when the switch is off', async () => {
    mockSynthesis();
    const body = await synthesize('qwen3-tts-instruct-flash', { qwenInstructionControl: false });
    expect(body.input).not.toHaveProperty('instructions');
    expect(body.input).not.toHaveProperty('optimize_instructions');
  });

  it('omits the parameters when the model cannot accept them', async () => {
    // DashScope rejects an unsupported parameter rather than ignoring it, so a
    // model outside the Instruct series must never see one.
    mockSynthesis();
    const body = await synthesize('qwen3-tts-flash', { qwenInstructionControl: true });
    expect(body.input).not.toHaveProperty('instructions');
    expect(body.model).toBe('qwen3-tts-flash');
  });

  it('leaves an ordinary request byte-identical to before', async () => {
    mockSynthesis();
    const body = await synthesize('qwen3-tts-flash');
    expect(body.input).toEqual({
      text: 'Hello class',
      voice: 'Cherry',
      language_type: 'Chinese',
    });
    expect(body.input).not.toHaveProperty('instructions');
  });
});
