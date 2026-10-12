/**
 * `/api/curriculum/design/tasks/[id]/outline`: the step-5 routes' own contract.
 *
 * The rule tests cover what the model may say; this file covers **what actually
 * lands in the tables**, because step 5's central failure is silent. The store
 * replaces a task's whole coverage ledger, so a turn that re-covers one item and
 * sends that ledger looks perfectly correct in a response body — and quietly
 * strips every other item of everything it taught, which only surfaces at the
 * `outline → teaching` gate as "an outcome nobody teaches".
 *
 * It also pins the sign-off behaviour no unit test can see: a real change
 * withdraws it, a restatement does not, an incomplete outline cannot be
 * confirmed by the model or by the card, and the phase gate refuses
 * `outline → teaching` until the author confirms.
 *
 * The model and the LLM call are mocked; the step, the store and the schema are
 * real, on PGlite.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:outline-route';
const DATABASE_URL = 'postgres://outline-route';

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

import { POST as outlineTurn } from '@/app/api/curriculum/design/tasks/[id]/outline/turn/route';
import {
  DELETE as outlineDelete,
  GET as outlineGet,
  POST as outlineConfirm,
} from '@/app/api/curriculum/design/tasks/[id]/outline/route';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumDependency,
  createCurriculumEvidence,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  getCurriculumDesignSnapshot,
  getCurriculumDesignStepConfirmation,
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
  return outlineTurn(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/outline/turn`, {
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
  const url = `http://localhost/api/curriculum/design/tasks/${taskId}/outline`;
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = body;
  }
  const request = new NextRequest(url, init);
  const params = Promise.resolve({ id: taskId });
  if (method === 'GET') return outlineGet(request, { params });
  if (method === 'POST') return outlineConfirm(request, { params });
  return outlineDelete(request, { params });
}

describe('the step-5 outline routes', () => {
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

    // A task that has cleared steps 1–3 and is sitting **in** `outline`: the phase
    // step 5 is written from. Reaching it in order matters — an objective needs
    // `outcomes`, a node needs `graph`, a unit needs `outline` — so the setup
    // walks the machine rather than inserting rows behind it.
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
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);

    const basic = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    const writeupNode = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'Writeup 结构',
      nodeType: 'skill',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: basic.id, objectiveId: objSql, supportLevel: 'primary' },
      { nodeId: writeupNode.id, objectiveId: objWriteup, supportLevel: 'primary' },
    ]);
    // The ordering claim step 3 signs: the basics come before the writeup.
    await createCurriculumDependency(pool, OWNER, task.id, {
      sourceId: basic.id,
      targetId: writeupNode.id,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'prerequisite',
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    taskId = task.id;
  });

  /** One chapter, two items, each teaching one outcome. */
  async function seedOutline() {
    const chapter = await createCurriculumUnit(pool, OWNER, taskId, {
      unitType: 'chapter',
      title: '第二章 Web 安全',
      orderIndex: 0,
    });
    const lecture = await createCurriculumUnit(pool, OWNER, taskId, {
      unitType: 'item',
      title: '目一 SQL 注入原理',
      unitRole: 'lecture',
      parentId: chapter.id,
      orderIndex: 0,
      hours: 1,
    });
    const practice = await createCurriculumUnit(pool, OWNER, taskId, {
      unitType: 'item',
      title: '目二 Writeup 复盘',
      unitRole: 'practice',
      parentId: chapter.id,
      orderIndex: 1,
      hours: 1,
    });
    await createCurriculumUnitCoverage(pool, OWNER, taskId, {
      unitId: lecture.id,
      objectiveId: objSql,
      coverageKind: 'teach',
    });
    await createCurriculumUnitCoverage(pool, OWNER, taskId, {
      unitId: practice.id,
      objectiveId: objWriteup,
      coverageKind: 'teach',
    });
    return { chapter, lecture, practice };
  }

  const storedCoverage = async () => {
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    return snapshot.unitCoverage
      .map((row) => `${row.unitId}:${row.objectiveId}:${row.coverageKind}`)
      .sort();
  };

  const storedUnits = async () => {
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    return snapshot.units.map((unit) => ({
      title: unit.title,
      type: unit.unitType,
      role: unit.unitRole,
      parent: unit.parentId,
      order: unit.orderIndex,
      hours: unit.hours,
    }));
  };

  describe('one conversation turn', () => {
    it('answers a cross-site request before spending the model budget', async () => {
      const response = await turnRequest(
        taskId,
        { instruction: '排一份大纲' },
        { 'Sec-Fetch-Site': 'cross-site' },
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('answers 400 when no model is configured, rather than a 500', async () => {
      mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
      const response = await turnRequest(taskId, { instruction: '排一份大纲' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'MISSING_MODEL' } });
    });

    it('refuses before the model call when the task has not reached the outline phase', async () => {
      const fresh = await createCurriculumTask(pool, OWNER, {
        title: '还没到这一步',
        audience: '学生',
        problemStatement: '问题',
        durationHours: 4,
      });
      const response = await turnRequest(fresh.id, { instruction: '排一份大纲' });
      expect(response.status).toBe(409);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('writes 章、节、目 in one turn, nesting the drafts by their refs', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '排好了第二章。',
          added: [
            { ref: 'ch2', title: '第二章 Web 安全', unitType: 'chapter' },
            { ref: 's1', title: '第一节 注入', unitType: 'chapter', parentRef: 'ch2' },
            {
              ref: 'i1',
              title: 'SQL 注入原理',
              unitType: 'item',
              unitRole: 'lecture',
              hours: 1,
              parentRef: 's1',
              coverage: [{ objectiveRef: objSql, coverageKind: 'teach', depth: 'standard' }],
            },
            {
              ref: 'i2',
              title: '写 Writeup',
              unitType: 'item',
              unitRole: 'practice',
              hours: 1,
              parentRef: 's1',
              coverage: [{ objectiveRef: objWriteup, coverageKind: 'teach', depth: 'standard' }],
            },
          ],
        }),
      );

      const response = await turnRequest(taskId, { instruction: '按第二章的结构排一遍' });
      expect(response.status).toBe(200);

      const units = await storedUnits();
      const chapter = units.find((unit) => unit.title === '第二章 Web 安全');
      const item = units.find((unit) => unit.title === 'SQL 注入原理');
      expect(chapter?.type).toBe('chapter');
      expect(chapter?.parent).toBeNull();
      // The section hangs off the chapter, and the item hangs off the section —
      // asserted through the stored parent ids, not through the payload.
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      const byTitle = new Map(snapshot.units.map((unit) => [unit.title, unit]));
      expect(byTitle.get('第一节 注入')?.parentId).toBe(byTitle.get('第二章 Web 安全')?.id);
      expect(byTitle.get('SQL 注入原理')?.parentId).toBe(byTitle.get('第一节 注入')?.id);
      expect(item?.role).toBe('lecture');
      expect(item?.hours).toBe(1);
      // Order is appended per parent: the two items land after each other.
      expect(item?.order).toBe(0);
      expect(byTitle.get('写 Writeup')?.orderIndex).toBe(1);
      await expect(response.json()).resolves.toMatchObject({
        message: '排好了第二章。',
        confirmedThisTurn: false,
      });
    });

    it('keeps the coverage of every item the turn did not name', async () => {
      const { lecture } = await seedOutline();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '目一改教另一个目标。',
          coverage: [{ ref: lecture.id, objectiveRef: objWriteup, coverageKind: 'teach' }],
        }),
      );

      const response = await turnRequest(taskId, { instruction: '目一其实教的是写 Writeup' });
      expect(response.status).toBe(200);

      // The whole-set replace is the trap: sending only `lecture`'s row would have
      // emptied the practice item, and nothing in the response would have shown it.
      const coverage = await storedCoverage();
      expect(coverage.filter((row) => row.startsWith(lecture.id))).toEqual([
        `${lecture.id}:${objWriteup}:teach`,
      ]);
      expect(coverage.some((row) => row.endsWith(':practice')) || coverage.length === 2).toBe(true);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      expect(snapshot.unitCoverage).toHaveLength(2);
      expect(
        snapshot.unitCoverage.filter((row) => row.objectiveId === objSql).length +
          snapshot.unitCoverage.filter((row) => row.objectiveId === objWriteup).length,
      ).toBe(2);
    });

    it('clearing one item coverage leaves the others alone', async () => {
      const { practice } = await seedOutline();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '目二先不覆盖任何目标。',
          coverage: [{ ref: practice.id, objectiveRef: null }],
        }),
      );

      const response = await turnRequest(taskId, { instruction: '目二那条挂错了，摘掉' });
      expect(response.status).toBe(200);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      expect(snapshot.unitCoverage.map((row) => row.unitId)).not.toContain(practice.id);
      expect(snapshot.unitCoverage).toHaveLength(1);
    });

    it('records the model’s confirmation as `assistant` when the outline is complete', async () => {
      await seedOutline();
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '就按这个来。',
          updated: [
            {
              ref: (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).units[0]!.id,
              hours: 2,
            },
          ],
          confirm: true,
        }),
      );

      const response = await turnRequest(taskId, {
        instruction: '确认，就这样',
        history: [{ role: 'user', content: '排一份大纲' }],
      });
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toMatchObject({ confirmedThisTurn: true });
      const confirmation = await getCurriculumDesignStepConfirmation(
        pool,
        OWNER,
        taskId,
        'outline',
      );
      expect(confirmation?.confirmedBy).toBe('assistant');
    });

    it('refuses the model’s confirmation while an outcome has no item teaching it', async () => {
      const { lecture } = await seedOutline();
      // Drop the only item teaching the writeup outcome, in the same answer that
      // claims the author agreed.
      const practice = (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).units.find(
        (unit) => unit.title === '目二 Writeup 复盘',
      );
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '好了。',
          removed: [practice?.id],
          updated: [{ ref: lecture.id, hours: 2 }],
          confirm: true,
        }),
      );

      const response = await turnRequest(taskId, {
        instruction: '确认吧',
        history: [{ role: 'user', content: '排一份大纲' }],
      });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { confirmedThisTurn: boolean; warnings: string[] };
      expect(body.confirmedThisTurn).toBe(false);
      expect(body.warnings.join()).toContain('没有记录确认');
      expect(await getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'outline')).toBeNull();
    });

    it('refuses to confirm an order that contradicts the graph’s prerequisite edge', async () => {
      const chapter = await createCurriculumUnit(pool, OWNER, taskId, {
        unitType: 'chapter',
        title: '第二章',
        orderIndex: 0,
      });
      // Writeup first, the injection basics second: the graph says the opposite.
      const writeupItem = await createCurriculumUnit(pool, OWNER, taskId, {
        unitType: 'item',
        title: '先讲 Writeup',
        unitRole: 'lecture',
        parentId: chapter.id,
        orderIndex: 0,
      });
      const sqlItem = await createCurriculumUnit(pool, OWNER, taskId, {
        unitType: 'item',
        title: '后讲注入',
        unitRole: 'lecture',
        parentId: chapter.id,
        orderIndex: 1,
      });
      await createCurriculumUnitCoverage(pool, OWNER, taskId, {
        unitId: writeupItem.id,
        objectiveId: objWriteup,
        coverageKind: 'teach',
      });
      await createCurriculumUnitCoverage(pool, OWNER, taskId, {
        unitId: sqlItem.id,
        objectiveId: objSql,
        coverageKind: 'teach',
      });
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '顺序就是这样。',
          updated: [{ ref: chapter.id, hours: 4 }],
          confirm: true,
        }),
      );

      const response = await turnRequest(taskId, {
        instruction: '确认这套顺序',
        history: [{ role: 'user', content: '排一份大纲' }],
      });
      const body = (await response.json()) as { confirmedThisTurn: boolean; warnings: string[] };
      expect(body.confirmedThisTurn).toBe(false);
      expect(body.warnings.join()).toContain('先于它的先修');
      expect(await getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'outline')).toBeNull();
    });

    it('drops what the store would refuse without losing the rest of the turn', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '一章一目。',
          added: [
            { ref: 'ch', title: '坏章节', unitType: 'chapter', unitRole: 'lecture' },
            {
              ref: 'i',
              title: '挂在坏章节下的条目',
              unitType: 'item',
              unitRole: 'lecture',
              parentRef: 'ch',
              coverage: [{ objectiveRef: objSql, coverageKind: 'teach', depth: 'standard' }],
            },
            {
              ref: 'solo',
              title: '独立条目',
              unitType: 'item',
              unitRole: 'lecture',
              coverage: [{ objectiveRef: objWriteup, coverageKind: 'teach', depth: 'standard' }],
            },
          ],
        }),
      );

      const response = await turnRequest(taskId, { instruction: '排一章一目' });
      expect(response.status).toBe(200);
      const body = (await response.json()) as { warnings: string[] };
      expect(body.warnings.join()).toContain('章节却带了教学角色');
      // Half the answer was unusable — a chapter with a role, and an item whose
      // parent therefore never existed — but the turn is one transaction, so what
      // the model got right has to survive. A chapter that carried a role would
      // otherwise have thrown in the store and rolled all of it back.
      const units = await storedUnits();
      expect(units.map((unit) => unit.title)).toEqual(['独立条目']);
      expect(units[0]?.type).toBe('item');
      expect(await storedCoverage()).toEqual([
        `${(await getCurriculumDesignSnapshot(pool, OWNER, taskId)).units[0]!.id}:${objWriteup}:teach`,
      ]);
    });
  });

  describe('what a write does to the sign-off', () => {
    it('withdraws an existing confirmation when the outline really changed', async () => {
      const { lecture } = await seedOutline();
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'outline', 'user');
      mocks.callLLM.mockResolvedValue(
        answer({ message: '改个名。', updated: [{ ref: lecture.id, title: '目一（改名）' }] }),
      );

      await turnRequest(taskId, { instruction: '把目一改名' });
      expect(await getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'outline')).toBeNull();
    });

    it('keeps the confirmation when a turn repeats what is already stored', async () => {
      const { lecture } = await seedOutline();
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'outline', 'user');
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '没改什么。',
          updated: [{ ref: lecture.id, title: '目一 SQL 注入原理', hours: 1 }],
        }),
      );

      await turnRequest(taskId, { instruction: '再说一遍' });
      // A no-op restatement must not clear the badge: otherwise it flickers on
      // every message and the author learns to ignore it.
      expect(
        await getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'outline'),
      ).not.toBeNull();
    });
  });

  describe('the sign-off route', () => {
    it('refuses to confirm an incomplete outline', async () => {
      await createCurriculumUnit(pool, OWNER, taskId, {
        unitType: 'chapter',
        title: '只有一章',
        orderIndex: 0,
      });
      const response = await callState(taskId, 'POST', JSON.stringify({ note: '确认' }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('只有章节没有条目');
    });

    it('confirms as `user`, then withdraws, then 404s a second withdrawal', async () => {
      await seedOutline();
      const confirmed = await callState(taskId, 'POST', JSON.stringify({ note: '我确认' }));
      expect(confirmed.status).toBe(200);
      const confirmation = await getCurriculumDesignStepConfirmation(
        pool,
        OWNER,
        taskId,
        'outline',
      );
      expect(confirmation?.confirmedBy).toBe('user');
      expect(confirmation?.note).toBe('我确认');

      const withdrawn = await callState(taskId, 'DELETE');
      expect(withdrawn.status).toBe(200);
      expect(await getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'outline')).toBeNull();

      const again = await callState(taskId, 'DELETE');
      expect(again.status).toBe(404);
    });

    it('reports the gaps and the next phase on GET', async () => {
      await seedOutline();
      const response = await callState(taskId, 'GET');
      const body = (await response.json()) as {
        gaps: unknown[];
        confirmed: boolean;
        nextPhase: string | null;
        phaseGaps: string[];
      };
      // Both outcomes are taught by an item, so the ledger is complete; the
      // remaining blocker is only the missing confirmation.
      expect(body.gaps).toEqual([]);
      expect(body.confirmed).toBe(false);
      expect(body.nextPhase).toBe('teaching');
      expect(body.phaseGaps.join()).toContain('确认');
    });
  });
});
