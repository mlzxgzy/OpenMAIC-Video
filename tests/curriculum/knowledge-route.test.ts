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
import { POST as knowledgeDraft } from '@/app/api/curriculum/design/tasks/[id]/knowledge/draft/route';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DELETE as knowledgeDelete,
  GET as knowledgeGet,
  POST as knowledgeConfirm,
} from '@/app/api/curriculum/design/tasks/[id]/knowledge/route';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumDependency,
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

function draftRequest(taskId: string, body: unknown, headers: Record<string, string> = {}) {
  return knowledgeDraft(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/knowledge/draft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

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
  describe('drafting (writes nothing)', () => {
    it('走完一整轮之后库里的节点、连线、依赖、签收一个都没变', async () => {
      const { first } = await seedNodes();
      const before = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '补一个文件头，并把它排在参数化之后。',
          added: [
            {
              name: '文件头结构',
              nodeType: 'knowledge',
              objectiveRefs: [{ objectiveRef: objWriteup, supportLevel: 'secondary' }],
            },
          ],
          updated: [{ ref: first.id, summary: '参数化查询与占位符' }],
          links: [],
          dependencies: [
            { sourceRef: first.id, targetRef: '文件头结构', edgeType: 'prerequisite' },
          ],
          confirm: true,
        }),
      );
      const response = await draftRequest(taskId, {
        instruction: '补一个文件头',
        history: [],
      });
      expect(response.status).toBe(200);

      const after = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      // 这就是本文件对起草路由的全部承诺：一个节点都不建，一条连线都不改，
      // 一条依赖都不加，作者还什么都没按。
      expect(after.nodes.map((row) => row.name).sort()).toEqual(
        before.nodes.map((row) => row.name).sort(),
      );
      expect(await storedPairs()).toEqual(
        before.nodeObjectives.map((link) => `${link.nodeId}→${link.objectiveId}`).sort(),
      );
      expect(after.dependencies).toHaveLength(before.dependencies.length);
      // `confirm: true` 在这里是**故意不落**的：签收是作者的动作，AI 说"可以签了"不算。
      expect(after.confirmations).toHaveLength(before.confirmations.length);
    });

    it('回包带着草稿本身与动手前的图，作者能对上"现在是什么样"', async () => {
      const { first } = await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '补一个文件头。',
          added: [
            {
              name: '文件头结构',
              nodeType: 'knowledge',
              objectiveRefs: [{ objectiveRef: objWriteup, supportLevel: 'secondary' }],
            },
          ],
          updated: [{ ref: first.id, summary: '参数化查询与占位符' }],
          confirm: false,
        }),
      );
      const payload = (await (
        await draftRequest(taskId, { instruction: '补一个文件头', history: [] })
      ).json()) as {
        added: { name: string }[];
        patches: { nodeId: string; patch: Record<string, unknown> }[];
        currentLinks: { nodeId: string; objectiveId: string }[];
        nodeNameById: Record<string, string>;
        objectiveTitleById: Record<string, string>;
        instruction: string;
      };
      expect(payload.added[0]).toMatchObject({ name: '文件头结构' });
      // patches 必须是数组：Map 序列化出来是 `{}`，界面会看到"有改动"却不知道改了什么。
      expect(payload.patches).toEqual([
        { nodeId: first.id, patch: { ref: first.id, summary: '参数化查询与占位符' } },
      ]);
      expect(payload.currentLinks).toHaveLength(2);
      expect(payload.nodeNameById[first.id]).toBe('SQL 查询与参数化');
      expect(payload.objectiveTitleById[objWriteup]).toBe('完整写出 Writeup');
      expect(payload.instruction).toBe('补一个文件头');
    });

    it('一个闭环的边在草稿里被拒，并作为警告回到作者眼前', async () => {
      const { first, second } = await seedNodes();
      await createCurriculumDependency(pool, OWNER, taskId, {
        sourceId: second.id,
        targetId: first.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
      });
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '把它反过来。',
          dependencies: [{ sourceRef: first.id, targetRef: second.id, edgeType: 'prerequisite' }],
        }),
      );
      const payload = (await (
        await draftRequest(taskId, { instruction: '反过来', history: [] })
      ).json()) as { dependencies: unknown[]; warnings: string[] };
      // 会闭环的边必须在写库之前被拒——store 的检查会让整个事务回滚，把这一轮的其他
      // 改动一起带走，而被拒的边不会留下任何可见痕迹。
      expect(payload.dependencies).toHaveLength(0);
      expect(payload.warnings.join('\n')).not.toBe('');
    });

    it('回答 400 而不是 500：没有配置模型是作者能照着做的事', async () => {
      mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
      const response = await draftRequest(taskId, { instruction: '拆几个' });
      expect(response.status).toBe(400);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('跨站请求在花掉模型预算之前就被拒', async () => {
      const response = await draftRequest(
        taskId,
        { instruction: '拆几个' },
        {
          'Sec-Fetch-Site': 'cross-site',
        },
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('源码里根本没有写库调用——"不落库"不是靠 onClick 的顺序维持的', () => {
      // 这是上面那些断言的**前提**。给路由加一个 `dryRun` 标志也能让它们全绿，但漏看
      // 一个写点就是一次看不见的改动；读源码让"没有写"本身成为被测试的事实。
      const source = readFileSync(
        fileURLToPath(
          new URL(
            '../../app/api/curriculum/design/tasks/[id]/knowledge/draft/route.ts',
            import.meta.url,
          ),
        ),
        'utf8',
      );
      expect(source).not.toMatch(/ctx\.write\s*\(/);
      expect(source).not.toMatch(
        /createCurriculum|updateCurriculum|deleteCurriculum|setCurriculum|confirmCurriculum|advanceCurriculum/,
      );
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

  /**
   * Step 4 folded into step 3: the ordering edges are written by the same turn and
   * covered by the same sign-off. The assertions are on the stored rows, for the
   * same reason the link tests are: a turn whose response looks right and whose
   * edges did not land is exactly the failure this file exists to catch.
   */
  describe('ordering edges', () => {
    const storedEdges = async () =>
      (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).dependencies
        .map((row) => `${row.sourceId}-[${row.edgeType}]->${row.targetId}`)
        .sort();

    it('writes an edge between two nodes the turn is adding, by name', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '拆成两步，先原理后利用。',
          added: [
            {
              name: '联合查询原理',
              nodeType: 'knowledge',
              objectiveRefs: [{ objectiveRef: objSql, supportLevel: 'primary' }],
            },
            {
              name: '联合查询利用',
              nodeType: 'skill',
              objectiveRefs: [{ objectiveRef: objSql, supportLevel: 'primary' }],
            },
          ],
          dependencies: [
            {
              sourceRef: '联合查询原理',
              targetRef: '联合查询利用',
              edgeType: 'prerequisite',
            },
          ],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: 'SQL 注入拆细一点' });
      expect(response.status).toBe(200);

      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      const principle = snapshot.nodes.find((row) => row.name === '联合查询原理');
      const exploit = snapshot.nodes.find((row) => row.name === '联合查询利用');
      expect(snapshot.dependencies).toHaveLength(1);
      // The endpoint was a name in the answer and has to be a real id in the row.
      expect(snapshot.dependencies[0]).toMatchObject({
        sourceId: principle?.id,
        targetId: exploit?.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
      });
    });

    it('drops a cyclic edge but still writes the rest of the turn', async () => {
      const { first, second } = await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '再补一个节点，并且让第二条反过来说明。',
          added: [
            {
              name: '报错注入',
              nodeType: 'skill',
              objectiveRefs: [{ objectiveRef: objSql, supportLevel: 'primary' }],
            },
          ],
          dependencies: [
            { sourceRef: first.id, targetRef: second.id, edgeType: 'prerequisite' },
            { sourceRef: second.id, targetRef: first.id, edgeType: 'prerequisite' },
          ],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '顺序反过来' });
      expect(response.status).toBe(200);

      // The legal edge landed, the cyclic one did not, and the node from the same
      // turn survived: the store's own refusal would have rolled all of it back.
      expect(await storedEdges()).toEqual([`${first.id}-[prerequisite]->${second.id}`]);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      expect(snapshot.nodes.some((row) => row.name === '报错注入')).toBe(true);

      const payload = (await response.json()) as {
        warnings: string[];
        teachingOrder: string[];
      };
      // A refused edge has to be said out loud: there is no row for a missing
      // edge, so nothing else in the card would show it.
      expect(payload.warnings.join('')).toContain('会形成环');
      // And the sequence it derived is the one the surviving edge states.
      expect(payload.teachingOrder[0]).toBe(first.id);
    });

    it('takes an edge away when the model names its dep id', async () => {
      const { first, second } = await seedNodes();
      const edge = await createCurriculumDependency(pool, OWNER, taskId, {
        sourceId: first.id,
        targetId: second.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
      });
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '这两条其实没有先后，去掉。',
          removedDependencies: [edge.id],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '去掉那条先修' });
      expect(response.status).toBe(200);
      expect(await storedEdges()).toEqual([]);
    });

    it('withdraws the graph sign-off when an edge really changes, not when it is restated', async () => {
      const { first, second } = await seedNodes();
      const signOff = async () =>
        (
          await pool.query<{ id: string }>(
            `SELECT id FROM curriculum_design_confirmation
              WHERE owner_id = $1 AND task_id = $2 AND step = 'graph'`,
            [OWNER, taskId],
          )
        ).rows[0];

      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'graph', 'user');

      // Restating an edge that is already stored is not a change, so a turn that
      // only repeats it must leave the sign-off alone.
      await createCurriculumDependency(pool, OWNER, taskId, {
        sourceId: first.id,
        targetId: second.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
      });
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'graph', 'user');
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '顺序就是先参数化再盲注。',
          dependencies: [{ sourceRef: first.id, targetRef: second.id, edgeType: 'prerequisite' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '确认一下顺序' });
      expect(await signOff()).toBeDefined();

      // A genuinely new claim reopens the step: the graph the author signed is not
      // the graph they now have.
      await seedNodes();
      const nodes = (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).nodes;
      const third = nodes.find((row) => row.name === '布尔盲注');
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '先讲参数化，再讲盲注。',
          dependencies: [{ sourceRef: first.id, targetRef: third?.id, edgeType: 'prerequisite' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '加一条先后关系' });
      expect(await signOff()).toBeUndefined();
    });

    it('answers with the edges, the derived sequence and the advisory findings', async () => {
      await seedNodes();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '就这样。',
          dependencies: [],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '看看图' });
      const payload = (await response.json()) as {
        dependencies: unknown[];
        teachingOrder: string[];
        findings: { text: string }[];
      };
      expect(payload.dependencies).toEqual([]);
      expect(Array.isArray(payload.teachingOrder)).toBe(true);
      // Two nodes and no ordering edge: the machine can see that, and says so —
      // but it is a finding, not a gap, so the card does not block on it.
      expect(payload.findings.map((row) => row.text).join('')).toContain('还没有任何先后关系');
    });
  });
});
