/**
 * `POST /api/curriculum/design/direction`: the route's own contract.
 *
 * What is under test is the part the step suite cannot reach — same-origin, owner
 * scope, the slot refusal, and, above all, **what actually lands in the row**.
 * Unlike outline revision this route writes the card itself, so the interesting
 * assertions are on the database: unknown model keys must not be stored, a
 * restated slot must not disturb the others, and a confirmation the model claims
 * must be checked against the rules rather than taken at its word.
 *
 * The model and the LLM call are mocked; the step, the store and the schema are
 * real, on PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurriculumTaskRecord } from '@/lib/curriculum/design-types';

const OWNER = 'owner:direction-route';
const OTHER = 'owner:direction-route-other';
const DATABASE_URL = 'postgres://direction-route';

const mocks = vi.hoisted(() => ({
  resolveOwnerId: vi.fn(),
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
  provider: {
    current: null as null | {
      pool: unknown;
      withTransaction: (body: (queryable: unknown) => Promise<unknown>) => Promise<unknown>;
    },
  },
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolveOwnerId),
);
// Only the provider wiring is substituted; every real store function stays.
vi.mock('@/lib/server/curriculum/design-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/curriculum/design-store')>();
  return { ...actual, getCurriculumDesignProvider: async () => mocks.provider.current };
});
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/model-config/runtime')>();
  return { ...actual, backgroundWorkspaceId: async (ownerId: string) => ownerId };
});

import { POST as directionTurn } from '@/app/api/curriculum/design/direction/route';
import {
  confirmCurriculumDesignStep,
  createCurriculumTask,
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
} from '@/lib/server/curriculum/design-store';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { SlotUnassignedError } from '@/lib/server/model-config/runtime';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

/** A model answer, as the prompt contract asks for it. */
const answer = (body: Record<string, unknown>) => ({ text: JSON.stringify(body) });

function call(
  body: unknown,
  options: { headers?: Record<string, string> } = {},
): Promise<Response> {
  return directionTurn(
    new NextRequest('http://localhost/api/curriculum/design/direction', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...options.headers },
      body: JSON.stringify(body),
    }),
  );
}

describe('POST course direction turn', () => {
  let db: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    vi.clearAllMocks();
    mocks.resolveOwnerId.mockReturnValue(OWNER);
    mocks.provider.current = { pool, withTransaction: (work) => work(pool) };
    mocks.resolveModel.mockResolvedValue({
      model: { provider: 'test.chat', modelId: 'test-model' },
      modelInfo: { outputWindow: 4096, capabilities: {} },
      modelString: 'test:test-model',
      thinkingConfig: undefined,
      serverManaged: false,
    });
  });

  it('answers a cross-site request before spending the model budget', async () => {
    const response = await call(
      { instruction: 'CTF 综合实战' },
      { headers: { 'Sec-Fetch-Site': 'cross-site' } },
    );
    expect(response.status).toBe(403);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('answers 400 when no model is configured, rather than a 500', async () => {
    mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
    const response = await call({ instruction: '随便' });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: { code: 'MISSING_MODEL' } });
  });

  it('refuses an empty instruction before calling the model', async () => {
    const response = await call({ instruction: '   ' });
    expect(response.status).toBe(400);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('creates the task on the turn that names the course, and stores only known slots', async () => {
    mocks.callLLM.mockResolvedValue(
      answer({
        message: '先按你说的填了受众和时长，范围还想确认一下。',
        fields: {
          title: 'CTF 综合实战',
          audience: '大二信息安全专业学生',
          durationHours: '48 学时',
          // Keys the model invented. They must not reach the row, or the next
          // person to read the card sees fields nobody defined.
          courseName: 'CTF',
          notes: '待定',
        },
        confirm: false,
      }),
    );

    const response = await call({ instruction: '给大二信安学生上一门 CTF 课，48 学时' });
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      task: CurriculumTaskRecord | null;
      values: Record<string, unknown>;
      gaps: string[];
      confirmed: boolean;
    };

    expect(body.task?.title).toBe('CTF 综合实战');
    expect(body.values.durationHours).toBe(48);
    expect(body.values.audience).toBe('大二信息安全专业学生');
    // The invented keys are dropped, not stored: the row is read back to prove it.
    const stored = await getCurriculumTask(pool, OWNER, body.task!.id);
    expect(stored).toMatchObject({
      title: 'CTF 综合实战',
      audience: '大二信息安全专业学生',
      durationHours: 48,
      problemStatement: null,
    });
    expect(body.gaps).toEqual(['缺课程范围（要解决的问题）']);
    expect(body.confirmed).toBe(false);
  });

  it('does not create a row for a turn that names no course', async () => {
    mocks.callLLM.mockResolvedValue(
      answer({
        message: '这门课叫什么方向？',
        fields: { audience: '大二学生' },
        confirm: false,
      }),
    );
    const response = await call({ instruction: '我想上一门安全课' });
    const body = (await response.json()) as { task: unknown; values: Record<string, unknown> };
    expect(response.status).toBe(200);
    // No title, no row — the dialog shows the partial card and asks for it.
    expect(body.task).toBeNull();
    expect(body.values.audience).toBe('大二学生');
  });

  it('ignores a confirmation the model claims on the first turn', async () => {
    mocks.callLLM.mockResolvedValue(
      answer({
        message: '已经按这个定下来了。',
        fields: {
          title: 'CTF 综合实战',
          audience: '大二学生',
          problemStatement: '能独立完成基础 Web CTF',
          durationHours: 48,
        },
        confirm: true,
      }),
    );

    const response = await call({ instruction: 'CTF 综合实战，大二，48 学时' });
    const body = (await response.json()) as { task: CurriculumTaskRecord; confirmed: boolean };
    // The user has not seen a card yet: there is nothing to have agreed to.
    expect(body.confirmed).toBe(false);
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, body.task.id, 'task')).toBeNull();
  });

  it('ignores the greeting in the history when counting the user’s turns', async () => {
    // The dialog opens with an assistant greeting. If that counted as a turn, the
    // user's very first sentence could carry a confirmation they never gave.
    mocks.callLLM.mockResolvedValue(
      answer({
        message: '按这个定了。',
        fields: {
          title: 'CTF 综合实战',
          audience: '大二学生',
          problemStatement: '能独立完成基础 Web CTF',
          durationHours: 48,
        },
        confirm: true,
      }),
    );
    const response = await call({
      instruction: 'CTF 综合实战，大二，48 学时',
      history: [{ role: 'assistant', content: '先说这门课给谁上。' }],
    });
    const body = (await response.json()) as { task: CurriculumTaskRecord; confirmed: boolean };
    expect(body.confirmed).toBe(false);
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, body.task.id, 'task')).toBeNull();
  });

  it('accepts a confirmation on a later turn, and records it as the assistant relaying it', async () => {
    mocks.callLLM.mockResolvedValueOnce(
      answer({
        message: '先按这个填，看看对不对。',
        fields: {
          title: 'CTF 综合实战',
          audience: '大二学生',
          problemStatement: '能独立完成基础 Web CTF',
          durationHours: 48,
        },
        confirm: false,
      }),
    );
    const first = (await (await call({ instruction: 'CTF 综合实战，大二，48 学时' })).json()) as {
      task: CurriculumTaskRecord;
    };

    mocks.callLLM.mockResolvedValueOnce(
      answer({ message: '好，方向就按这个。', fields: {}, confirm: true }),
    );
    // The dialog keeps the id the first turn returned and sends it back; this is
    // that second turn.
    const response = await call({
      taskId: first.task.id,
      instruction: '确认',
      history: [
        { role: 'user', content: 'CTF 综合实战，大二，48 学时' },
        { role: 'assistant', content: '先按这个填，看看对不对。' },
      ],
    });
    const body = (await response.json()) as {
      confirmed: boolean;
      confirmedThisTurn: boolean;
      confirmation: { confirmedBy: string; note: string | null } | null;
      readyToAdvance: boolean;
    };
    expect(body.confirmed).toBe(true);
    expect(body.confirmedThisTurn).toBe(true);
    expect(body.confirmation?.confirmedBy).toBe('assistant');
    expect(body.confirmation?.note).toBe('确认');
    // The gate the dialog reads is the store's, and it is now open.
    expect(body.readyToAdvance).toBe(true);
  });

  it('does not confirm a card whose required slots are still empty', async () => {
    mocks.callLLM.mockResolvedValue(
      answer({
        message: '范围还空着，先确认别的。',
        fields: { title: 'CTF 综合实战', audience: '大二学生', durationHours: 48 },
        confirm: true,
      }),
    );
    const response = await call({ instruction: '就这些，确认' });
    const body = (await response.json()) as { task: CurriculumTaskRecord; confirmed: boolean };
    expect(body.confirmed).toBe(false);
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, body.task.id, 'task')).toBeNull();
  });

  it('writes only the slots a turn mentions, leaving the rest of the card alone', async () => {
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '大二学生',
      problemStatement: '能独立完成基础 Web CTF',
      durationHours: 48,
      learnerLevel: '会 Linux 基本命令',
    });
    mocks.callLLM.mockResolvedValue(
      answer({ message: '时长改成 54。', fields: { durationHours: 54 }, confirm: false }),
    );

    await call({ taskId: task.id, instruction: '改成 54 学时' });
    const stored = await getCurriculumTask(pool, OWNER, task.id);
    expect(stored).toMatchObject({
      durationHours: 54,
      audience: '大二学生',
      learnerLevel: '会 Linux 基本命令',
      problemStatement: '能独立完成基础 Web CTF',
    });
  });

  it('re-opens a confirmed step when the turn changes the card', async () => {
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '大二学生',
      problemStatement: '能独立完成基础 Web CTF',
      durationHours: 48,
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');

    mocks.callLLM.mockResolvedValue(
      answer({
        message: '范围改了。',
        fields: { problemStatement: '只做 Web 与 Misc' },
        confirm: false,
      }),
    );
    const response = await call({ taskId: task.id, instruction: '范围改成只做 Web 与 Misc' });
    const body = (await response.json()) as { confirmed: boolean; readyToAdvance: boolean };
    // The confirmation belonged to the old text; the dialog must show the step
    // as open again rather than letting the design advance on a card nobody read.
    expect(body.confirmed).toBe(false);
    expect(body.readyToAdvance).toBe(false);
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'task')).toBeNull();
  });

  it('answers 404 for a task belonging to another owner', async () => {
    const foreign = await createCurriculumTask(pool, OTHER, {
      title: '别人的课',
      audience: '别人',
      problemStatement: '别人的问题',
      durationHours: 1,
    });
    const response = await call({ taskId: foreign.id, instruction: '改成 2 学时' });
    expect(response.status).toBe(404);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('leaves the card untouched when the model answers something unusable', async () => {
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '大二学生',
      problemStatement: '能独立完成基础 Web CTF',
      durationHours: 48,
    });
    mocks.callLLM.mockResolvedValue({ text: '当然可以！不过我这边没有 JSON。' });

    const response = await call({ taskId: task.id, instruction: '改成 54 学时' });
    expect(response.status).toBe(502);
    const stored = await getCurriculumTask(pool, OWNER, task.id);
    expect(stored?.durationHours).toBe(48);
  });
});
