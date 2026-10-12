/**
 * `/api/curriculum/design/tasks/[id]/outcomes`: the routes' own contract.
 *
 * What is under test is the part the step suite cannot reach — same-origin, owner
 * scope, the refusals, and, above all, **what actually lands in the tables**. This
 * route writes the list itself, so the interesting assertions are on the database:
 * a change aimed at a ref that matches nothing must not reach any row, an evidence
 * row with nothing in it must not be stored, and a confirmation the model claims
 * must be checked against the rules rather than taken at its word.
 *
 * The model and the LLM call are mocked; the step, the store and the schema are
 * real, on PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:outcomes-route';
const OTHER = 'owner:outcomes-route-other';
const DATABASE_URL = 'postgres://outcomes-route';

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

import { POST as outcomesTurn } from '@/app/api/curriculum/design/tasks/[id]/outcomes/turn/route';
import {
  DELETE as outcomesDelete,
  GET as outcomesGet,
  POST as outcomesConfirm,
} from '@/app/api/curriculum/design/tasks/[id]/outcomes/route';
import {
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumObjective,
  createCurriculumTask,
  getCurriculumDesignSnapshot,
  listCurriculumOutcomes,
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

const answer = (body: Record<string, unknown>) => ({ text: JSON.stringify(body) });

/** One complete outcome with its lab, as the prompt contract asks for it. */
const outcome = (title = '能在 Web 靶场中独立完成 SQL 注入并读取 flag') => ({
  title,
  objectiveType: 'skill',
  expectedBehavior: '在 Docker 靶场中判断注入点，手工构造注入语句并读出指定数据',
  minCriteria: ['识别注入点', '成功读取 flag'],
  evidence: [
    {
      evidenceType: 'lab',
      verificationMethod: '提交 flag，系统自动比对',
      successCondition: '独立完成注入并读出本题 flag',
      assessmentMode: 'practice',
    },
  ],
});

function turnRequest(taskId: string, body: unknown, headers: Record<string, string> = {}) {
  return outcomesTurn(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/outcomes/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

function stateRequest(taskId: string, method: 'GET' | 'POST' | 'DELETE') {
  const url = `http://localhost/api/curriculum/design/tasks/${taskId}/outcomes`;
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (method === 'POST') {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = JSON.stringify({ note: '逐条读过' });
  }
  return { url, init };
}

describe('the step-2 outcomes routes', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let taskId: string;

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
    // A task that has cleared step 1: outcomes are writable from here on.
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '大二信息安全专业学生',
      problemStatement: '6 方向 × 3 案例',
      durationHours: 48,
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    const phase = await pool.query<{ design_phase: string }>(
      'SELECT design_phase FROM curriculum_task WHERE id = $1',
      [task.id],
    );
    if (phase.rows[0]?.design_phase === 'task') {
      const { advanceCurriculumTaskPhase } = await import('@/lib/server/curriculum/design-store');
      await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    }
    taskId = task.id;
  });

  /** One outcome with evidence, seeded directly: the model is not what is tested. */
  async function seedObjective() {
    const objective = await createCurriculumObjective(pool, OWNER, taskId, {
      title: outcome().title,
      objectiveType: 'skill',
      expectedBehavior: outcome().expectedBehavior,
      minCriteria: ['识别注入点'],
    });
    await createCurriculumEvidence(pool, OWNER, taskId, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 flag',
    });
    return objective;
  }

  describe('one conversation turn', () => {
    it('answers a cross-site request before spending the model budget', async () => {
      const response = await turnRequest(
        taskId,
        { instruction: '先来两条' },
        {
          'Sec-Fetch-Site': 'cross-site',
        },
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('answers 400 when no model is configured, rather than a 500', async () => {
      mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
      const response = await turnRequest(taskId, { instruction: '先来两条' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'MISSING_MODEL' } });
    });

    it('404s a task belonging to someone else', async () => {
      mocks.resolveOwnerId.mockReturnValue(OTHER);
      const response = await turnRequest(taskId, { instruction: '先来两条' });
      expect(response.status).toBe(404);
    });

    it('writes the first outcome and its evidence, and reports what is still missing', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '先落一条 Web 方向的，其余方向你说几条我就补几条。',
          added: [outcome()],
          confirm: false,
        }),
      );

      const response = await turnRequest(taskId, { instruction: '先来一条 Web 的' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        objectives: { title: string; verifiable: boolean }[];
        evidence: unknown[];
        gaps: { text: string }[];
        confirmed: boolean;
      };

      expect(body.objectives).toHaveLength(1);
      expect(body.objectives[0]?.verifiable).toBe(true);
      expect(body.evidence).toHaveLength(1);
      // Nothing is missing now, so the strip may be confirmed — but this turn did
      // not claim agreement, so it is not.
      expect(body.gaps).toHaveLength(0);
      expect(body.confirmed).toBe(false);
    });

    it('stores an outcome with no criteria as unverifiable rather than refusing it', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '先写下标题，标准等你确认范围后再补。',
          added: [{ ...outcome(), minCriteria: [] }],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '先记一条' });
      const body = (await response.json()) as {
        objectives: { verifiable: boolean }[];
        gaps: { text: string }[];
      };
      // The gap is the visible state the author is meant to fill in; rejecting the
      // write would hide it instead of surfacing it.
      expect(body.objectives[0]?.verifiable).toBe(false);
      expect(body.gaps.map((gap) => gap.text).join()).toContain('最低标准');
    });

    it('refuses a piece of evidence with nothing in it, so the gate is not fooled', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '给第一条挂了一条证据。',
          added: [
            {
              ...outcome(),
              evidence: [
                {
                  evidenceType: 'lab',
                  verificationMethod: '人工看一眼就行',
                  successCondition: '',
                },
              ],
            },
          ],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '挂一条证据' });
      const body = (await response.json()) as {
        evidence: unknown[];
        gaps: { text: string }[];
      };
      expect(body.evidence).toHaveLength(0);
      // And so the outcome still reads as unevidenced, which is the truth.
      expect(body.gaps.map((gap) => gap.text).join()).toContain('考核方式');
    });

    it('applies no change aimed at a ref that names nothing', async () => {
      const objective = await seedObjective();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '改一下第二条。',
          updated: [{ ref: 'obj_does_not_exist', title: '被偷偷改掉的标题' }],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, {
        instruction: '把第二条改一下',
        history: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      });
      expect(response.status).toBe(200);
      const listed = await listCurriculumOutcomes(pool, OWNER, taskId);
      expect(listed.objectives.map((row) => row.title)).toEqual([objective.title]);
    });

    it('does not confirm a list that is still missing evidence', async () => {
      await createCurriculumObjective(pool, OWNER, taskId, {
        title: outcome().title,
        objectiveType: 'skill',
        expectedBehavior: outcome().expectedBehavior,
        minCriteria: ['识别注入点'],
      });
      mocks.callLLM.mockResolvedValue(
        answer({ message: '好了', added: [], evidence: [], confirm: true }),
      );
      const response = await turnRequest(taskId, {
        instruction: '确认',
        history: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      });
      const body = (await response.json()) as { confirmed: boolean; confirmedThisTurn: boolean };
      expect(body.confirmedThisTurn).toBe(false);
      expect((await getCurriculumDesignSnapshot(pool, OWNER, taskId)).confirmations).toHaveLength(
        1,
      );
    });

    it('leaves the list untouched when the model answers with unusable JSON', async () => {
      const objective = await seedObjective();
      mocks.callLLM.mockResolvedValue({ text: '我需要更多背景信息。' });
      const response = await turnRequest(taskId, { instruction: '随便聊聊' });
      expect(response.status).toBe(502);
      const listed = await listCurriculumOutcomes(pool, OWNER, taskId);
      expect(listed.objectives).toHaveLength(1);
      expect(listed.objectives[0]?.title).toBe(objective.title);
    });
  });

  describe('the sign-off', () => {
    it('GET reports the list and the confirmation the phase machine reads', async () => {
      const objective = await seedObjective();
      const { url, init } = stateRequest(taskId, 'GET');
      const response = await outcomesGet(new NextRequest(url, init), {
        params: Promise.resolve({ id: taskId }),
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        objectives: { id: string }[];
        confirmed: boolean;
        gaps: unknown[];
      };
      expect(body.objectives[0]?.id).toBe(objective.id);
      expect(body.confirmed).toBe(false);
      expect(body.gaps).toHaveLength(0);
    });

    it('POST refuses an incomplete list, naming what to add', async () => {
      await createCurriculumObjective(pool, OWNER, taskId, {
        title: outcome().title,
        objectiveType: 'skill',
        expectedBehavior: outcome().expectedBehavior,
        minCriteria: ['识别注入点'],
      });
      const { url, init } = stateRequest(taskId, 'POST');
      const response = await outcomesConfirm(new NextRequest(url, init), {
        params: Promise.resolve({ id: taskId }),
      });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining('考核方式') },
      });
      expect((await getCurriculumDesignSnapshot(pool, OWNER, taskId)).confirmations).toHaveLength(
        1,
      );
    });

    it('POST confirms a complete list as the user, and DELETE withdraws it', async () => {
      await seedObjective();
      const post = stateRequest(taskId, 'POST');
      const confirmed = await outcomesConfirm(new NextRequest(post.url, post.init), {
        params: Promise.resolve({ id: taskId }),
      });
      expect(confirmed.status).toBe(200);
      await expect(confirmed.json()).resolves.toMatchObject({
        confirmed: true,
        confirmation: { confirmedBy: 'user', note: '逐条读过' },
      });

      const del = stateRequest(taskId, 'DELETE');
      const withdrawn = await outcomesDelete(new NextRequest(del.url, del.init), {
        params: Promise.resolve({ id: taskId }),
      });
      expect(withdrawn.status).toBe(200);
      await expect(withdrawn.json()).resolves.toMatchObject({ confirmed: false });
    });

    it('DELETE answers 404 when there was nothing to withdraw', async () => {
      await seedObjective();
      const del = stateRequest(taskId, 'DELETE');
      const response = await outcomesDelete(new NextRequest(del.url, del.init), {
        params: Promise.resolve({ id: taskId }),
      });
      expect(response.status).toBe(404);
    });

    it('404s every verb for a task belonging to someone else', async () => {
      await seedObjective();
      mocks.resolveOwnerId.mockReturnValue(OTHER);
      for (const [handler, method] of [
        [outcomesGet, 'GET'],
        [outcomesConfirm, 'POST'],
        [outcomesDelete, 'DELETE'],
      ] as const) {
        const { url, init } = stateRequest(taskId, method);
        const response = await handler(new NextRequest(url, init), {
          params: Promise.resolve({ id: taskId }),
        });
        expect(response.status).toBe(404);
      }
    });
  });
});
