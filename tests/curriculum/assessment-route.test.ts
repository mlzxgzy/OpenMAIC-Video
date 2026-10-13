/**
 * `/api/curriculum/design/tasks/[id]/assessment`: 第七步两组路由自己的契约。
 *
 * 规则层的测试管模型可以说什么；这个文件管**库里真的落了什么**——因为这一步最危险的
 * 失败是"看起来全都对"：一道有题干、有选项、有答案、有目标的题目，挂在了一个从来不
 * 承担这个目标的条目上。它出现在每一个列表里，只有覆盖闭环里没有它。所以下面的断言
 * 读的是 `curriculum_question` 与 `curriculum_lab_task` 两表里的行，以及**没写进去**
 * 的那些：拒收必须留下痕迹，否则作者以为它已经出好了。
 *
 * 另外钉住三件单测看不到的事：`evidenceId` 是推导的（第二步签过的证据，这里不新增）；
 * 真正的改动才撤回签收，重述不撤回；`assessment → review` 在确认与审核层干净之前推不动。
 *
 * 模型与 LLM 调用是 mock 的；步骤、store、schema 都是真的，跑在 PGlite 上。
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:assessment-route';
const DATABASE_URL = 'postgres://assessment-route';

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

import { POST as assessmentTurn } from '@/app/api/curriculum/design/tasks/[id]/assessment/turn/route';
import {
  DELETE as assessmentDelete,
  GET as assessmentGet,
  POST as assessmentConfirm,
} from '@/app/api/curriculum/design/tasks/[id]/assessment/route';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumQuestion,
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

function turnRequest(taskId: string, body: unknown, headers: Record<string, string> = {}) {
  return assessmentTurn(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/assessment/turn`, {
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
  const url = `http://localhost/api/curriculum/design/tasks/${taskId}/assessment`;
  const init: ConstructorParameters<typeof NextRequest>[1] = { method };
  if (body !== undefined) {
    init.headers = { 'Content-Type': 'application/json' };
    init.body = body;
  }
  const request = new NextRequest(url, init);
  const params = Promise.resolve({ id: taskId });
  if (method === 'GET') return assessmentGet(request, { params });
  if (method === 'POST') return assessmentConfirm(request, { params });
  return assessmentDelete(request, { params });
}

describe('the step-7 assessment routes', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let taskId: string;
  let chapterId: string;
  let lectureId: string;
  let practiceId: string;
  let objectiveId: string;

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

    // A task walked in order to `assessment`. The walk matters: a unit needs
    // `outline`, a node needs `graph`, an objective needs `outcomes`, and step 7
    // itself needs a signed lesson design to author against.
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
    objectiveId = objective.id;
    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: objective.id,
      evidenceType: 'quiz',
      verificationMethod: '笔试',
      successCondition: '答对注入原理题',
    });
    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '读出 flag',
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);

    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
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
    chapterId = chapter.id;
    const lecture = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '目一 SQL 注入原理',
      unitRole: 'lecture',
      parentId: chapter.id,
      orderIndex: 0,
      hours: 1,
    });
    lectureId = lecture.id;
    const practice = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '目二 注入实操',
      unitRole: 'practice',
      parentId: chapter.id,
      orderIndex: 1,
      hours: 1,
    });
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
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: practice.id,
      objectiveId: objective.id,
      coverageKind: 'assess',
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outline', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → teaching

    // Step 6's document, signed — step 7 authors against it, and the phase gate
    // refuses to let the task in without it.
    await updateCurriculumUnit(pool, OWNER, lectureId, {
      teachingDesign: { core: [node.id], nodes: [node.id], objectives: [objective.id] },
      deckDesign: {
        estPages: 1,
        pages: [
          {
            order: 1,
            title: '参数拼接就是注入点',
            goal: '学员能指出注入点',
            coreInfo: '参数被拼进 SQL 的地方就是注入点',
            mode: 'explain',
            teaches: [node.id],
          },
        ],
      },
    });
    await updateCurriculumUnit(pool, OWNER, practiceId, {
      teachingDesign: { core: [node.id], nodes: [node.id], objectives: [objective.id] },
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'teaching', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → assessment
    taskId = task.id;
  });

  const storedQuestions = async () =>
    (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).questions;
  const storedLabs = async () => (await getCurriculumDesignSnapshot(pool, OWNER, taskId)).labTasks;

  /** A question for the practice item, as the model would write it. */
  const questionDraft = (over: Record<string, unknown> = {}) => ({
    itemRef: practiceId,
    objectiveRef: objectiveId,
    questionType: 'single',
    stem: '为什么 `id=1 OR 1=1` 能登录成功？',
    options: [
      { key: 'A', text: '参数被拼进 SQL，条件恒真' },
      { key: 'B', text: '密码被解密' },
    ],
    answer: ['A'],
    explanation: '拼接后的条件恒为真。',
    distractors: [{ optionKey: 'B', misconception: '把注入当成解密' }],
    difficulty: 'basic',
    score: 2,
    ...over,
  });

  /** A practice lab for the practice item. */
  const labDraft = (over: Record<string, unknown> = {}) => ({
    itemRef: practiceId,
    objectiveRef: objectiveId,
    assessmentMode: 'practice',
    taskGoal: '读取 /flag 并提交',
    brief: '登录接口的 username 参数存在注入。',
    dockerImage: 'openmaic/ctf-web-sqli:1.0',
    verifyRules: [{ kind: 'file_read', target: '/flag' }],
    expectedResult: '提交的 flag 与容器内 /flag 一致',
    ...over,
  });

  describe('one conversation turn', () => {
    it('answers a cross-site request before spending the model budget', async () => {
      const response = await turnRequest(
        taskId,
        { instruction: '出题' },
        { 'Sec-Fetch-Site': 'cross-site' },
      );
      expect(response.status).toBe(403);
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('answers 400 when no model is configured, rather than a 500', async () => {
      mocks.resolveModel.mockRejectedValue(new SlotUnassignedError('course.outline'));
      const response = await turnRequest(taskId, { instruction: '出题' });
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({ error: { code: 'MISSING_MODEL' } });
    });

    it('refuses before the model call when the task has not reached the assessment phase', async () => {
      const fresh = await createCurriculumTask(pool, OWNER, {
        title: '还没到这一步',
        audience: '学生',
        problemStatement: '问题',
        durationHours: 4,
      });
      const response = await turnRequest(fresh.id, { instruction: '出题' });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: 'CURRICULUM_DESIGN_PHASE_LOCKED' },
      });
      expect(mocks.callLLM).not.toHaveBeenCalled();
    });

    it('writes the question the model named, with the derived evidence and number', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({ message: '出了一道题', questions: [questionDraft()], confirm: false }),
      );
      const response = await turnRequest(taskId, { instruction: '给 1.2 出一道题' });
      expect(response.status).toBe(200);

      const questions = await storedQuestions();
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({
        unitId: practiceId,
        objectiveId,
        questionType: 'single',
        stem: '为什么 `id=1 OR 1=1` 能登录成功？',
        answer: ['A'],
        difficulty: 'basic',
        score: 2,
        sortOrder: 0,
      });
      // Derived, not taken from the answer: the outcome has exactly one quiz
      // evidence, so the question is bound to it.
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      const quizEvidence = snapshot.evidence.find((row) => row.evidenceType === 'quiz');
      expect(questions[0]?.evidenceId).toBe(quizEvidence?.id);
    });

    it('writes the lab with rules mapped by kind, not by a field the model picked', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '写好了',
          labTasks: [
            labDraft({
              verifyRules: [
                { kind: 'flag', target: 'flag{abc}' },
                { kind: 'env_state', target: 'SOLVED' },
              ],
            }),
          ],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '写 1.2 的实操' });
      expect(response.status).toBe(200);

      const labs = await storedLabs();
      expect(labs).toHaveLength(1);
      expect(labs[0]).toMatchObject({
        unitId: practiceId,
        objectiveId,
        assessmentMode: 'practice',
        dockerImage: 'openmaic/ctf-web-sqli:1.0',
      });
      // The mapped fields, read back: `flag` lives in `value`, `env_state` in `key`.
      expect(labs[0]?.verifyRules).toEqual([
        { kind: 'flag', value: 'flag{abc}' },
        { kind: 'env_state', key: 'SOLVED' },
      ]);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      const labEvidence = snapshot.evidence.find((row) => row.evidenceType === 'lab');
      expect(labs[0]?.evidenceId).toBe(labEvidence?.id);
    });

    it('refuses a question hung on a chapter, writes nothing, and says which chapter', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '出好了',
          questions: [questionDraft({ itemRef: chapterId })],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '给第二章出题' });
      const body = (await response.json()) as { warnings: string[] };
      expect(body.warnings.join('')).toContain('第二章 Web 安全');
      await expect(storedQuestions()).resolves.toEqual([]);
    });

    it('refuses a lab on an item that only lectures, and names the ones that practise', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '写好了',
          labTasks: [labDraft({ itemRef: lectureId })],
          confirm: false,
        }),
      );
      const response = await turnRequest(taskId, { instruction: '实操写在讲课条目里' });
      const body = (await response.json()) as { warnings: string[] };
      expect(body.warnings.join('')).toContain('练习');
      await expect(storedLabs()).resolves.toEqual([]);
    });

    it('updates one question in the fields it sends, and creates nothing', async () => {
      const existing = await createCurriculumQuestion(pool, OWNER, taskId, {
        unitId: practiceId,
        objectiveId,
        questionType: 'single',
        stem: '旧题干',
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
        answer: ['A'],
      });
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '改了题干',
          questions: [{ ref: existing.id, itemRef: null, objectiveRef: null, stem: '新题干' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '把题干改清楚' });

      const questions = await storedQuestions();
      expect(questions).toHaveLength(1);
      expect(questions[0]).toMatchObject({
        id: existing.id,
        stem: '新题干',
        // The fields it did not mention kept their values.
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
        answer: ['A'],
      });
    });

    it('removes by id and leaves the questions it did not mention alone', async () => {
      const keep = await createCurriculumQuestion(pool, OWNER, taskId, {
        unitId: practiceId,
        objectiveId,
        questionType: 'single',
        stem: '留着',
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
        answer: ['A'],
      });
      const drop = await createCurriculumQuestion(pool, OWNER, taskId, {
        unitId: practiceId,
        objectiveId,
        questionType: 'single',
        stem: '删掉',
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
        answer: ['A'],
      });
      mocks.callLLM.mockResolvedValue(
        answer({ message: '删了', removedQuestions: [drop.id], confirm: false }),
      );
      await turnRequest(taskId, { instruction: '把第二道删掉' });

      const questions = await storedQuestions();
      expect(questions.map((row) => row.id)).toEqual([keep.id]);
    });

    it('records the confirmation in the same transaction when nothing is missing', async () => {
      // Both evidence promises have to be delivered: a quiz evidence needs a
      // question, and a lab evidence needs a lab task.
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '都写好了',
          questions: [questionDraft()],
          labTasks: [labDraft()],
          confirm: true,
        }),
      );
      const response = await turnRequest(taskId, {
        instruction: '就这样，确认',
        history: [{ role: 'user', content: '给 1.2 出题和实操' }],
      });
      const body = (await response.json()) as { confirmedThisTurn: boolean; warnings: string[] };
      expect(body.warnings).toEqual([]);
      expect(body.confirmedThisTurn).toBe(true);

      const confirmation = await getCurriculumDesignStepConfirmation(
        pool,
        OWNER,
        taskId,
        'assessment',
      );
      expect(confirmation?.step).toBe('assessment');
      expect(confirmation?.confirmedBy).toBe('assistant');

      // And the boundary it unlocks actually opens: `assessment → review` reads the
      // assessment-layer audit plus this confirmation.
      await advanceCurriculumTaskPhase(pool, OWNER, taskId);
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
      expect(snapshot.task.designPhase).toBe('review');
    });

    it('does not confirm while an evidence promise is still empty', async () => {
      mocks.callLLM.mockResolvedValue(
        answer({
          message: '确认吧',
          questions: [questionDraft()],
          confirm: true,
        }),
      );
      const response = await turnRequest(taskId, {
        instruction: '就这样，确认',
        history: [{ role: 'user', content: '出题' }],
      });
      const body = (await response.json()) as { confirmedThisTurn: boolean; warnings: string[] };
      // The lab evidence has no lab task, and the promise on the item that grades
      // the outcome is only half delivered — the author reads why.
      expect(body.confirmedThisTurn).toBe(false);
      expect(body.warnings.join('')).toContain('实操');
      await expect(
        getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'assessment'),
      ).resolves.toBeNull();
    });
  });

  describe('the sign-off strip', () => {
    it('withdraws the confirmation when a question really changes', async () => {
      const existing = await createCurriculumQuestion(pool, OWNER, taskId, {
        unitId: practiceId,
        objectiveId,
        questionType: 'single',
        stem: '旧题干',
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
        answer: ['A'],
      });
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'assessment', 'user');

      mocks.callLLM.mockResolvedValue(
        answer({
          message: '改了',
          questions: [{ ref: existing.id, itemRef: null, objectiveRef: null, stem: '新题干' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '改题干' });

      // The confirmation signed *that* text; once the text is different, the gate
      // must close again.
      await expect(
        getCurriculumDesignStepConfirmation(pool, OWNER, taskId, 'assessment'),
      ).resolves.toBeNull();
    });

    it('keeps the confirmation when the turn only restates what is there', async () => {
      const existing = await createCurriculumQuestion(pool, OWNER, taskId, {
        unitId: practiceId,
        objectiveId,
        questionType: 'single',
        stem: '同一句题干',
        options: [
          { key: 'A', text: 'a' },
          { key: 'B', text: 'b' },
        ],
        answer: ['A'],
      });
      await confirmCurriculumDesignStep(pool, OWNER, taskId, 'assessment', 'user');

      mocks.callLLM.mockResolvedValue(
        answer({
          message: '没改',
          questions: [{ ref: existing.id, itemRef: null, objectiveRef: null, stem: '同一句题干' }],
          confirm: false,
        }),
      );
      await turnRequest(taskId, { instruction: '读一遍' });

      // A badge that clears on every message trains the author to ignore it.
      const confirmation = await getCurriculumDesignStepConfirmation(
        pool,
        OWNER,
        taskId,
        'assessment',
      );
      expect(confirmation?.step).toBe('assessment');
    });

    it('refuses to confirm over the state route while a gap is open', async () => {
      const response = await callState(taskId, 'POST');
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('空承诺');
    });

    it('answers 404 for a withdraw when there was nothing to withdraw', async () => {
      const response = await callState(taskId, 'DELETE');
      expect(response.status).toBe(404);
    });

    it('reports the gaps in the state payload the dialog reads', async () => {
      const response = await callState(taskId, 'GET');
      expect(response.status).toBe(200);
      const body = (await response.json()) as {
        gaps: { kind: string }[];
        auditFindings: { rule: string }[];
      };
      expect(body.gaps.map((gap) => gap.kind)).toContain('coverage_without_artifact');
      // The evidence promises come from the audit, which is the layer that owns
      // "a promise with nothing behind it".
      expect(body.auditFindings.map((finding) => finding.rule)).toContain('evidence_no_artifact');
    });
  });
});
