/**
 * `/api/curriculum/design/tasks/[id]/knowledge`: the routes' own contract.
 *
 * The rule tests cover what the model may say; this file covers **what actually
 * lands in the tables**, because step 3's central failure is silent. A turn that
 * re-links one node and sends the graph through a whole-set replace looks
 * perfectly correct in a response body — and quietly deletes every other node's
 * links, which then only surfaces as an unteachable outcome at the outline phase.
 * So the assertions here are on the stored links, not on the payload.
 *
 * It also pins the sign-off behaviour that no unit test can see: a real change
 * withdraws it, a restatement does not, and the phase gate refuses `graph → outline`
 * until the author confirms.
 *
 * The model and the LLM call are mocked; the step, the store and the schema are
 * real, on PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:knowledge-route';
const OTHER = 'owner:knowledge-route-other';
const DATABASE_URL = 'postgres://knowledge-route';

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

import { POST as knowledgeTurn } from '@/app/api/curriculum/design/tasks/[id]/knowledge/turn/route';
import {
  DELETE as knowledgeDelete,
  GET as knowledgeGet,
  POST as knowledgeConfirm,
} from '@/app/api/curriculum/design/tasks/[id]/knowledge/route';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumTask,
  getCurriculumDesignSnapshot,
  setCurriculumNodeObjectives,
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

function turnRequest(taskId: string, body: unknown, headers: Record<string, string> = {}) {
  return knowledgeTurn(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/knowledge/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

/**
 * One state-route call. The three verbs share a path and differ only by method,
 * so they go through one helper rather than three near-identical blocks.
 */
async function callState(
  taskId: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: string,
): Promise<Response> {
  const url = `http://localhost/api/curriculum/design/tasks/${taskId}/knowledge`;
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = body;
  }
  const request = new NextRequest(url, init);
  const params = Promise.resolve({ id: taskId });
  if (method === 'GET') return knowledgeGet(request, { params });
  if (method === 'POST') return knowledgeConfirm(request, { params });
  return knowledgeDelete(request, { params });
}

describe('the step-3 knowledge routes', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let taskId: string;
  let objSql: string;
  let objWriteup: string;

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

    // A task that has cleared step 1, and is now sitting **in** `outcomes`: that is
    // the phase step 3 is written from, and reaching it in order matters — an
    // objective needs the `outcomes` phase, so the brief is confirmed and advanced
    // before the objectives are written, and the outcome list is confirmed after.
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '大二信息安全专业学生',
      problemStatement: '6 方向 × 3 案例',
      durationHours: 48,
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    const objective = await createCurriculumObjective(pool, OWNER, task.id, {
      title: '独立完成 SQL 注入并读取 flag',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中手工构造注入并读出 flag',
      minCriteria: ['读出 flag'],
    });
    const writeup = await createCurriculumObjective(pool, OWNER, task.id, {
      title: '完整写出 Writeup',
      objectiveType: 'skill',
      expectedBehavior: '写出可复现的解题记录',
      minCriteria: ['含复现步骤'],
    });
    objSql = objective.id;
    objWriteup = writeup.id;
    for (const one of [objective, writeup]) {
      await createCurriculumEvidence(pool, OWNER, task.id, {
        objectiveId: one.id,
        evidenceType: 'lab',
        verificationMethod: '实操验证',
        successCondition: '达标',
      });
    }
    // Confirmed, then advanced **into** `graph` — the phase step 3 is written
    // from. It stops there on purpose: leaving `graph` for `outline` is the gate
    // under test, so the setup must not cross it.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    taskId = task.id;
  });

  /** Seed a connected pair, so "unmentioned links survive" is observable. */
  async function seedNodes() {
    const first = await createCurriculumLearningNode(pool, OWNER, taskId, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    const second = await createCurriculumLearningNode(pool, OWNER, taskId, {
      name: '布尔盲注',
      nodeType: 'skill',
    });
    await setCurriculumNodeObjectives(pool, OWNER, taskId, [
      { nodeId: first.id, objectiveId: objSql, supportLevel: 'primary' },
      { nodeId: second.id, objectiveId: objSql, supportLevel: 'primary' },
    ]);
    return { first, second };
  }

  /**
   * A graph connected at **both** ends: every node supports a goal, and every goal
   * has a node. Four tests need exactly this shape, and seeding it by hand each
   * time is how a test ends up asserting on a graph it did not mean to build.
   */
  async function seedConnectedGraph() {
    const { first, second } = await seedNodes();
    await setCurriculumNodeObjectives(pool, OWNER, taskId, [
      { nodeId: first.id, objectiveId: objSql, supportLevel: 'primary' },
      { nodeId: second.id, objectiveId: objSql, supportLevel: 'primary' },
      { nodeId: second.id, objectiveId: objWriteup, supportLevel: 'primary' },
    ]);
    return { first, second };
  }

  const storedPairs = async () => {
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    return snapshot.nodeObjectives.map((link) => `${link.nodeId}→${link.objectiveId}`).sort();
  };

  describe('one conversation turn', () => {
    it('answers a cross-site request before spending the model budget', async () => {
      const response = await turnRequest(
        taskId,
        { instruction: '拆几个' },
        {
          'Sec-Fetch-Site': 'cross-site',
        },
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('answers 400 when no model is configured, rather than a 500', async () => {
      mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
      const response = await turnRequest(taskId, { instruction: '拆几个' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'MISSING_MODEL' } });
    });

    it('404s a task belonging to someone else', async () => {
      mocks.resolveOwnerId.mockReturnValue(OTHER);
      const response = await turnRequest(taskId, { instruction: '拆几个' });
      expect(response.status).toBe(404);
    });

    it('502s an unusable answer and leaves the graph exactly as it was', async () => {
      const { second } = await seedNodes();
      const before = await storedPairs();
      mocks.callLLM.mockResolvedValue({ text: '这不是 JSON' });
      const response = await turnRequest(taskId, { instruction: '拆几个' });
      expect(response.status).toBe(502);
      expect(await storedPairs()).toEqual(before);
      expect((await getCurriculumDesignSnapshot(pool, OWNER, taskId)).nodes).toHaveLength(2);
      expect(second.id).toBeTruthy();
    });

    it('keeps the links of every node the turn did not name', async () => {
      const { first, second } = await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '给参数化那条补上写 Writeup 的支撑。',
          links: [{ ref: first.id, objectiveRef: objWriteup }],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '参数化也支撑写 writeup' });
      expect(response.status).toBe(200);
      // The regression this file exists for: node_b was not mentioned, and its
      // link is still there.
      expect(await storedPairs()).toEqual(
        [`${first.id}→${objWriteup}`, `${second.id}→${objSql}`].sort(),
      );
    });

    it('writes a new node and the links it declared', async () => {
      await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '补一个取证基础。',
          added: [
            {
              name: '文件头结构',
              nodeType: 'knowledge',
              objectiveRefs: [{ objectiveRef: objWriteup, supportLevel: 'secondary' }],
            },
          ],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '补一个文件头' });
      expect(response.status).toBe(200);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      const node = snapshot.nodes.find((row) => row.name === '文件头结构');
      expect(node).toBeTruthy();
      const link = snapshot.nodeObjectives.find((row) => row.nodeId === node?.id);
      expect(link).toMatchObject({ objectiveId: objWriteup, supportLevel: 'secondary' });
    });

    it('does not write a link to an outcome that does not exist', async () => {
      const { first } = await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '挂错了。',
          links: [{ ref: first.id, objectiveRef: 'obj_typo' }],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '挂一下' });
      expect(response.status).toBe(200);
      // Named-node replacement emptied it (its only link was replaced by an
      // unusable one) — so the point of the assertion is that nothing was written
      // against a goal that does not exist.
      expect(await storedPairs()).not.toContain(`${first.id}→obj_typo`);
    });

    it('discards chapters the model volunteered, with an audit line', async () => {
      await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({ message: '顺手排了一下章。', added: [], chapters: [{ name: '第二章' }] }),
      );
      const response = await turnRequest(taskId, { instruction: '排一下' });
      expect(response.status).toBe(200);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      // No unit was created, and the task stayed in the graph phase.
      expect(snapshot.units).toHaveLength(0);
      expect(snapshot.task.designPhase).toBe('graph');
    });
  });
  describe('the sign-off', () => {
    it('refuses to confirm a graph that is connected at only one end', async () => {
      // seedNodes links both nodes to the SQL goal only, so the Writeup goal has
      // nothing behind it — connected at one end, not the other.
      await seedNodes();
      const response = await callState(taskId, 'POST');
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        error: { message: expect.stringContaining('Writeup') },
      });
    });

    it('confirms a connected graph and records the button as the user', async () => {
      await seedConnectedGraph();
      const response = await callState(taskId, 'POST');
      expect(response.status).toBe(200);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      const confirmation = snapshot.confirmations.find((row) => row.step === 'graph');
      expect(confirmation).toMatchObject({ confirmedBy: 'user' });
    });

    it('withdraws the confirmation when a node really changes, and not when it does not', async () => {
      const { first } = await seedConnectedGraph();
      await callState(taskId, 'POST');
      const signOff = async () =>
        (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).confirmations.find(
          (row) => row.step === 'graph',
        );
      expect(await signOff()).toBeTruthy();

      // A patch that changes nothing must not revoke the sign-off: the model
      // routinely resends a node to change one field, and a badge that flickers on
      // every message teaches the author to ignore it.
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '没什么要改的。',
          updated: [{ ref: first.id, name: 'SQL 查询与参数化' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '再看看' });
      expect(await signOff()).toBeTruthy();

      mocks.callLLM.mockResolvedValue(
        answer({
          message: '改个名。',
          updated: [{ ref: first.id, name: '参数化查询' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '参数化那条改名' });
      expect(await signOff()).toBeUndefined();
    });

    it('404s a withdrawal when there was nothing to withdraw', async () => {
      const response = await callState(taskId, 'DELETE');
      expect(response.status).toBe(404);
    });
  });

  describe('the gate into the outline', () => {
    it('refuses graph → outline until the graph is confirmed', async () => {
      await seedConnectedGraph();
      // The graph itself is fine; what is missing is the author's agreement.
      await expect(advanceCurriculumTaskPhase(pool, OWNER, taskId)).rejects.toThrow(/还没有确认/);
    });

    it('refuses to enter the outline for an objective with nothing behind it', async () => {
      await seedNodes();
      // Both nodes support the SQL goal, so "every node has a goal" holds — that
      // half was already checked. The Writeup goal has no node, which was not.
      await expect(advanceCurriculumTaskPhase(pool, OWNER, taskId)).rejects.toThrow(
        /没有任何知识\/技能点支撑/,
      );
      // And confirming by hand does not buy a way past it either.
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'graph', 'user');
      await expect(advanceCurriculumTaskPhase(pool, OWNER, taskId)).rejects.toThrow(
        /没有任何知识\/技能点支撑/,
      );
    });

    it('lets a connected, confirmed graph into the outline', async () => {
      await seedConnectedGraph();
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'graph', 'user');
      const advanced = await advanceCurriculumTaskPhase(pool, OWNER, taskId);
      expect(advanced.designPhase).toBe('outline');
    });
  });
});
