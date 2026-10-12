/**
 * `/api/curriculum/design/tasks/[id]/teaching`: 第六步两组路由自己的契约。
 *
 * 规则层的测试管模型可以说什么；这个文件管**库里真的落了什么**，因为这一步的核心失败
 * 也是沉默的：脚本和分镜是两份文档，各自看起来都完整，矛盾只在生成出来的课件里出现。
 * 所以下面的断言读的是 `curriculum_unit` 上的 `teaching_design` / `deck_design` 两列。
 *
 * 另外钉住三件单测看不到的事：确认是**在同一个事务里对着写完之后的设计**判的；真正的
 * 改动才撤回签收，重述不撤回；`teaching → assessment` 在确认之前推不动。
 *
 * 模型与 LLM 调用是 mock 的；步骤、store、schema 都是真的，跑在 PGlite 上。
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:teaching-route';
const DATABASE_URL = 'postgres://teaching-route';

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

import { POST as teachingTurn } from '@/app/api/curriculum/design/tasks/[id]/teaching/turn/route';
import {
  DELETE as teachingDelete,
  GET as teachingGet,
  POST as teachingConfirm,
} from '@/app/api/curriculum/design/tasks/[id]/teaching/route';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  getCurriculumDesignSnapshot,
  getCurriculumDesignStepConfirmation,
  setCurriculumNodeObjectives,
  updateCurriculumUnit,
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

const nodeNames: Record<string, string> = {};

function turnRequest(taskId: string, body: unknown, headers: Record<string, string> = {}) {
  return teachingTurn(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/teaching/turn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

async function callState(
  taskId: string,
  method: 'GET' | 'POST' | 'DELETE',
  body?: string,
): Promise<Response> {
  const url = `http://localhost/api/curriculum/design/tasks/${taskId}/teaching`;
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = body;
  }
  const request = new NextRequest(url, init);
  const params = Promise.resolve({ id: taskId });
  if (method === 'GET') return teachingGet(request, { params });
  if (method === 'POST') return teachingConfirm(request, { params });
  return teachingDelete(request, { params });
}

describe('the step-6 teaching routes', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let taskId: string;
  let lectureId: string;
  let practiceId: string;
  let nodeId: string;

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

    // A task walked in order to the phase step 6 is written from. The walk matters:
    // a unit needs `outline`, a node needs `graph`, an objective needs `outcomes`.
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
    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '达标',
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);

    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    nodeId = node.id;
    nodeNames[node.id] = node.name;
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: objective.id, supportLevel: 'primary' },
    ]);
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);

    const chapter = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'chapter',
      title: '第二章 Web 安全',
      orderIndex: 0,
    });
    const lecture = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '目一 SQL 注入原理',
      unitRole: 'lecture',
      parentId: chapter.id,
      orderIndex: 0,
      hours: 1,
    });
    const practice = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '目二 注入实操',
      unitRole: 'practice',
      parentId: chapter.id,
      orderIndex: 1,
      hours: 1,
    });
    lectureId = lecture.id;
    practiceId = practice.id;
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: lecture.id,
      objectiveId: objective.id,
      coverageKind: 'teach',
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: practice.id,
      objectiveId: objective.id,
      coverageKind: 'practice',
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outline', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → teaching
    taskId = task.id;
  });

  /** The stored script/storyboard of one item, as the tables hold them. */
  const storedDesign = async (unitId: string) => {
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    const unit = snapshot.units.find((row) => row.id === unitId)!;
    return { teachingDesign: unit.teachingDesign, deckDesign: unit.deckDesign };
  };

  /** A complete lecture plan, as the model would answer it. */
  const lecturePlan = (over: Record<string, unknown> = {}) => ({
    ref: lectureId,
    core: [nodeId],
    sequence: [nodeId],
    pages: [
      {
        order: 1,
        title: '参数拼接就是注入点',
        goal: '学员能指出注入点',
        coreInfo: '参数被拼进 SQL 的地方就是注入点',
        mode: 'explain',
        teaches: [nodeId],
      },
    ],
    ...over,
  });

  describe('one conversation turn', () => {
    it('answers a cross-site request before spending the model budget', async () => {
      const response = await turnRequest(
        taskId,
        { instruction: '写授课脚本' },
        { 'Sec-Fetch-Site': 'cross-site' },
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('answers 400 when no model is configured, rather than a 500', async () => {
      mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
      const response = await turnRequest(taskId, { instruction: '写授课脚本' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'MISSING_MODEL' } });
    });

    it('refuses before the model call when the task has not reached the teaching phase', async () => {
      const fresh = await createCurriculumTask(pool, OWNER, {
        title: '还没到这一步',
        audience: '学生',
        problemStatement: '问题',
        durationHours: 4,
      });
      const response = await turnRequest(fresh.id, { instruction: '写授课脚本' });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'CURRICULUM_DESIGN_PHASE_LOCKED' },
      });
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('writes the script and the storyboard the model named', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({ message: '写好了', plans: [lecturePlan()], confirm: false }),
      );
      const response = await turnRequest(taskId, { instruction: '写 1.1 的脚本和分镜' });
      expect(response.status).toBe(200);

      const stored = await storedDesign(lectureId);
      expect(stored.teachingDesign.core).toEqual([nodeId]);
      // Derived, not taken from the answer.
      expect(stored.teachingDesign.nodes).toEqual([nodeId]);
      expect(stored.deckDesign.pages).toHaveLength(1);
      expect(stored.deckDesign.pages?.[0]).toMatchObject({
        goal: '学员能指出注入点',
        teaches: [nodeId],
      });
    });

    it('leaves an item the turn did not name exactly as it was', async () => {
      // A stored script on the drill, written before the turn runs.
      await updateCurriculumUnit(pool, OWNER, practiceId, {
        teachingDesign: { core: [nodeId], nodes: [nodeId], objectives: [] },
      });
      mocks.callLLM.mockResolvedValue(
        answer({ message: '只改 1.1', plans: [lecturePlan()], confirm: false }),
      );
      await turnRequest(taskId, { instruction: '只改 1.1 的分镜' });

      // The practice item's own script survived untouched: the rules layer patches
      // per item, so a turn about the lecture cannot erase the drill.
      const practice = await storedDesign(practiceId);
      expect(practice.teachingDesign.core).toEqual([nodeId]);
      expect(practice.deckDesign.pages).toBeUndefined();
    });

    it('records no confirmation while a gap is open, and says which', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({ message: '确认吧', plans: [lecturePlan()], confirm: true }),
      );
      const response = await turnRequest(taskId, { instruction: '就这样，确认' });
      const body = (await response.json()) as { confirmedThisTurn: boolean; warnings: string[] };

      expect(body.confirmedThisTurn).toBe(false);
      // The drill still has no teaching design, so the step cannot close — and the
      // author reads why, not just a missing checkmark.
      expect(body.warnings.join('')).toContain('目二 注入实操');
      await expect(
        getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'teaching'),
      ).resolves.toBeNull();
    });

    it('records the confirmation in the same transaction as the write when nothing is missing', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '确认吧',
          plans: [lecturePlan(), { ref: practiceId, core: [nodeId] }],
          confirm: true,
        }),
      );
      // Two user turns: the step refuses to record a sign-off on the first
      // message, which is the rule that stops "确认" from being agreed to before
      // the author has read anything.
      const response = await turnRequest(taskId, {
        instruction: '就这样，确认',
        history: [{ role: 'user', content: '写 1.1 的脚本和分镜' }],
      });
      const body = (await response.json()) as { confirmedThisTurn: boolean };
      expect(body.confirmedThisTurn).toBe(true);
      const confirmation = await getCurriculumDesignStepConfirmation(
        pool,
        OWNER,
        taskId,
        'teaching',
      );
      expect(confirmation?.step).toBe('teaching');
      expect(confirmation?.confirmedBy).toBe('assistant');
    });

    it('does not confirm on the first message even when the design is complete', async () => {
      await updateCurriculumUnit(pool, OWNER, lectureId, {
        teachingDesign: { core: [nodeId], nodes: [nodeId], objectives: [] },
        deckDesign: {
          estPages: 1,
          pages: [
            {
              order: 1,
              title: '参数拼接就是注入点',
              goal: '学员能指出注入点',
              coreInfo: '参数被拼进 SQL 的地方就是注入点',
              mode: 'explain',
              teaches: [nodeId],
            },
          ],
        },
      });
      await updateCurriculumUnit(pool, OWNER, practiceId, {
        teachingDesign: { core: [nodeId], nodes: [nodeId], objectives: [] },
      });
      mocks.callLLM.mockResolvedValue(
        answer({ message: '好', plans: [{ ref: practiceId, core: [nodeId] }], confirm: true }),
      );
      const response = await turnRequest(taskId, { instruction: '确认' });
      const body = (await response.json()) as { confirmedThisTurn: boolean };
      expect(body.confirmedThisTurn).toBe(false);
    });

    it('refuses an answer that is not usable and leaves the design alone', async () => {
      mocks.callLLM.mockResolvedValue({ text: '当然可以' });
      const response = await turnRequest(taskId, { instruction: '写脚本' });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'CURRICULUM_DESIGN_FAILED' },
      });
      expect(await storedDesign(lectureId)).toEqual({ teachingDesign: {}, deckDesign: {} });
    });
  });

  describe('the sign-off and the phase gate', () => {
    /** A design that passes the step's own gate. */
    const complete = async () => {
      await updateCurriculumUnit(pool, OWNER, lectureId, {
        teachingDesign: { core: [nodeId], sequence: [nodeId], nodes: [nodeId], objectives: [] },
        deckDesign: {
          estPages: 1,
          pages: [
            {
              order: 1,
              title: '参数拼接就是注入点',
              goal: '学员能指出注入点',
              coreInfo: '参数被拼进 SQL 的地方就是注入点',
              mode: 'explain',
              teaches: [nodeId],
            },
          ],
        },
      });
      await updateCurriculumUnit(pool, OWNER, practiceId, {
        teachingDesign: { core: [nodeId], nodes: [nodeId], objectives: [] },
      });
    };

    it('refuses the card’s confirm while an item has no design, naming what to write', async () => {
      const response = await callState(taskId, 'POST');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('目一 SQL 注入原理');
    });

    it('refuses to advance to assessment until the design is both complete and confirmed', async () => {
      await complete();
      await expect(advanceCurriculumTaskPhase(pool, OWNER, taskId)).rejects.toThrow();

      const posted = await callState(taskId, 'POST');
      expect(posted.status).toBe(200);
      await advanceCurriculumTaskPhase(pool, OWNER, taskId);

      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      expect(snapshot.task.designPhase).toBe('assessment');
    });

    it('withdraws the sign-off when a real change lands, and not on a restatement', async () => {
      await complete();
      await callState(taskId, 'POST');

      // A restatement: same documents, so the sign-off still covers what is stored.
      await updateCurriculumUnit(pool, OWNER, practiceId, {
        teachingDesign: { core: [nodeId], nodes: [nodeId], objectives: [] },
      });
      await expect(
        getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'teaching'),
      ).resolves.not.toBeNull();

      // A real change: the script now teaches a different depth, so the signature
      // no longer covers the document on disk.
      await updateCurriculumUnit(pool, OWNER, lectureId, {
        teachingDesign: { core: [], brief: [nodeId], nodes: [nodeId], objectives: [] },
      });
      await expect(
        getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'teaching'),
      ).resolves.toBeNull();
    });

    it('lets the card withdraw the sign-off itself, and 404s when there is none', async () => {
      expect((await callState(taskId, 'DELETE')).status).toBe(404);
      await complete();
      await callState(taskId, 'POST');
      expect((await callState(taskId, 'DELETE')).status).toBe(200);
      await expect(
        getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'teaching'),
      ).resolves.toBeNull();
    });
  });

  describe('the state payload', () => {
    it('reports the gaps, the audit findings and whether the step can advance', async () => {
      const response = await callState(taskId, 'GET');
      const body = (await response.json()) as {
        gaps: { kind: string }[];
        auditFindings: { rule: string }[];
        readyToAdvance: boolean;
        plan: string;
        nextPhase: string;
      };
      // Both items are undesigned, so both report `no_design` — the deck check is
      // only reached once an item has a script at all.
      expect(body.gaps.map((gap) => gap.kind).sort()).toEqual(['no_design', 'no_design']);
      // The audit says the same thing from the other side, and it is read rather
      // than re-derived, so the two lists cannot drift apart.
      expect(body.auditFindings.map((finding) => finding.rule)).toContain('unit_lesson_undesigned');
      expect(body.readyToAdvance).toBe(false);
      expect(body.nextPhase).toBe('assessment');
      expect(body.plan).toContain('目一 SQL 注入原理');
    });
  });
});
