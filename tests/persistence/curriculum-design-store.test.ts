/**
 * The reverse-design store on PGlite: the phase machine, endpoint ownership and
 * the grading rules.
 *
 * The behaviours pinned here are the ones a later refactor would most easily
 * drop without any test going red, because they are refusals rather than
 * results: a course that skips to content before its outcomes exist, an edge
 * that points at another task's row, a lab graded by its reference path.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import type { CurriculumTaskRecord } from '@/lib/curriculum/design-types';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumDependency,
  createCurriculumEvidence,
  createCurriculumLabTask,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumQuestion,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  createCurriculumUnitDependency,
  deleteCurriculumDependency,
  deleteCurriculumLearningNode,
  deleteCurriculumUnitDependency,
  CurriculumDesignNotFoundError,
  CurriculumDesignValidationError,
  CurriculumPhaseError,
  assertCurriculumDesignExportable,
  getCurriculumDesignSnapshot,
  getCurriculumDesignStepConfirmation,
  listCurriculumTasks,
  reviewCurriculumTaskDesign,
  setCurriculumNodeObjectives,
  updateCurriculumTask,
  updateCurriculumUnit,
  withdrawCurriculumDesignStep,
} from '@/lib/server/curriculum/design-store';

const OWNER = 'owner:design-store';
const OTHER = 'owner:someone-else';

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

describe('reverse-design store (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let task: CurriculumTaskRecord;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '安全运维岗新人',
      problemStatement: '学员无法独立完成基础 Web CTF',
      durationHours: 54,
    });
  });

  afterEach(async () => {
    await db.close();
  });

  /**
   * Move the task to the phase a test needs, satisfying each gate in turn.
   * Reaching `graph` requires every outcome to have evidence — that gate is
   * the point of the machine, so the helper has to honour it rather than
   * bypass it.
   */
  async function advanceTo(
    phase: 'task' | 'outcomes' | 'graph' | 'outline' | 'teaching' | 'assessment',
  ): Promise<void> {
    if (phase === 'task') return;
    // → step 1 closes on the sign-off, then outcomes
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'outcomes') return;

    const objective = await createCurriculumObjective(pool, OWNER, task.id, {
      title: '能够利用 SQL 注入读取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中定位注入点并构造 payload 读取 flag',
      minCriteria: ['识别注入点', '读取 flag'],
      verifiable: true,
    });
    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 /flag',
      conditionExpression: "readFile('/flag') === true",
    });
    // The outcome list's own sign-off, for the same reason step 1 has one: a
    // complete list is not an agreed one. Without this the helper cannot reach
    // `graph` at all, and the twenty tests that use it fail for a reason that has
    // nothing to do with what they check.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    // → graph
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'graph') return;

    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: objective.id },
    ]);
    // Step 3's sign-off, the third and last gate the helper has to honour: the
    // graph's own phase boundary. Each of these was added by the step that
    // introduced it, and the helper has to carry them or every test past it fails
    // for a reason unrelated to what it checks.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');
    // → outline
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'outline') return;

    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.1 SQL 注入原理',
      unitRole: 'lecture',
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      coverageKind: 'teach',
    });
    // → teaching
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'teaching') return;
    // → assessment (teaching coverage is already in place, which is its gate)
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
  }

  it('starts a task in the brief phase and lists it for its owner only', async () => {
    expect(task.designPhase).toBe('task');
    const mine = await listCurriculumTasks(pool, OWNER);
    expect(mine.map((row) => row.id)).toEqual([task.id]);
    expect(await listCurriculumTasks(pool, OTHER)).toEqual([]);
  });

  it('refuses to leave the brief phase with the same phase pair as a premature write', async () => {
    const bare = await createCurriculumTask(pool, OWNER, { title: '未澄清的课程' });
    // Leaving early and writing ahead of the phase are the same refusal, so a
    // client reads one shape: which phase it is in, and which one it wanted.
    const failure = await advanceCurriculumTaskPhase(pool, OWNER, bare.id).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CurriculumPhaseError);
    expect(failure).toMatchObject({ current: 'task', required: 'outcomes' });
    // The pair says where; the message has to say what is missing.
    expect((failure as Error).message).toContain('授课对象');
  });

  /**
   * Step 1: the brief being filled in is not the same as the user agreeing to it.
   *
   * The gate is the whole point of the AI-assisted flow — the model writes the
   * card, and the design may not build on it until the author has read it back —
   * so these four cases pin the condition, its revocation, and its ownership.
   */
  it('refuses to leave the brief on a complete brief that nobody confirmed', async () => {
    // The brief is complete in `beforeEach`. Confirmation is a second, separate
    // condition rather than a consequence of the fields.
    const failure = await advanceCurriculumTaskPhase(pool, OWNER, task.id).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CurriculumPhaseError);
    expect((failure as Error).message).toContain('课程方向还没有确认');
    expect(task.designPhase).toBe('task');
  });

  it('leaves the brief once the user confirms, and reports who confirmed', async () => {
    const confirmation = await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    expect(confirmation).toMatchObject({ taskId: task.id, step: 'task', confirmedBy: 'user' });
    const advanced = await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    expect(advanced.designPhase).toBe('outcomes');
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
    expect(snapshot.confirmations.map((entry) => entry.step)).toEqual(['task']);
  });

  it('re-opens the step on a real brief edit but not on a restatement', async () => {
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    // The AI restates most of the card on every turn; a no-op write must not
    // revoke the sign-off the user just gave.
    await updateCurriculumTask(pool, OWNER, task.id, { durationHours: 54 });
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'task')).not.toBeNull();

    await updateCurriculumTask(pool, OWNER, task.id, { durationHours: 48 });
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'task')).toBeNull();
    // And the gate closes again, on a brief that is still complete.
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).rejects.toThrow(
      /课程方向还没有确认/,
    );
  });

  it('withdraws a confirmation idempotently and fences it by owner', async () => {
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    expect(await withdrawCurriculumDesignStep(pool, OTHER, task.id, 'task')).toBe(false);
    expect(await withdrawCurriculumDesignStep(pool, OWNER, task.id, 'task')).toBe(true);
    expect(await withdrawCurriculumDesignStep(pool, OWNER, task.id, 'task')).toBe(false);
    await expect(
      confirmCurriculumDesignStep(pool, OTHER, task.id, 'task', 'user'),
    ).rejects.toBeInstanceOf(CurriculumDesignNotFoundError);
  });

  it('refuses to author an outcome before the task has left the brief phase', async () => {
    await expect(
      createCurriculumObjective(pool, OWNER, task.id, {
        title: '能够读取 flag',
        objectiveType: 'skill',
      }),
    ).rejects.toBeInstanceOf(CurriculumPhaseError);
  });

  it('refuses to build the graph before every outcome has evidence', async () => {
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    await createCurriculumObjective(pool, OWNER, task.id, {
      title: '能够利用 SQL 注入读取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中定位注入点并构造 payload 读取 flag',
      minCriteria: ['识别注入点'],
      verifiable: true,
    });
    // The outcome is well-formed but nothing can yet show it was met.
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).rejects.toThrow(/还没有证据/);

    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).objectives[0].id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 /flag',
    });
    // Two gates sit on this boundary and this test is about the evidence one, so
    // the sign-off is satisfied first — otherwise the assertion below would pass
    // or fail on the confirmation rather than on the evidence it names.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).resolves.toMatchObject({
      designPhase: 'graph',
    });
  });

  it('refuses to build the graph before any outcome exists at all', async () => {
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).rejects.toThrow(
      /还没有定义任何学习目标/,
    );
  });

  it('refuses to author a knowledge node before the graph phase', async () => {
    await advanceTo('outcomes');
    await expect(
      createCurriculumLearningNode(pool, OWNER, task.id, { name: 'x', nodeType: 'knowledge' }),
    ).rejects.toBeInstanceOf(CurriculumPhaseError);
  });

  it('refuses to author an outline unit before the outline phase', async () => {
    await advanceTo('graph');
    await expect(
      createCurriculumUnit(pool, OWNER, task.id, {
        unitType: 'item',
        title: '1.1 SQL 注入原理',
        unitRole: 'lecture',
      }),
    ).rejects.toBeInstanceOf(CurriculumPhaseError);
  });

  it('refuses a dependency endpoint that belongs to another task or does not exist', async () => {
    await advanceTo('graph');
    const otherTask = await createCurriculumTask(pool, OWNER, {
      title: '另一门课',
      audience: '同一人',
      problemStatement: '另一件事',
      durationHours: 1,
    });
    await confirmCurriculumDesignStep(pool, OWNER, otherTask.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, otherTask.id);
    const foreign = await createCurriculumObjective(pool, OWNER, otherTask.id, {
      title: '别处的目标',
      objectiveType: 'skill',
    });

    await expect(
      createCurriculumDependency(pool, OWNER, task.id, {
        sourceId: 'node-does-not-exist',
        targetId: 'obj-does-not-exist',
        sourceKind: 'node',
        targetKind: 'objective',
        edgeType: 'prerequisite',
      }),
    ).rejects.toBeInstanceOf(CurriculumDesignNotFoundError);

    const ownObjective = await createCurriculumObjective(pool, OWNER, task.id, {
      title: '本课目标',
      objectiveType: 'skill',
    });
    await expect(
      createCurriculumDependency(pool, OWNER, task.id, {
        sourceId: foreign.id,
        targetId: ownObjective.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'prerequisite',
      }),
    ).rejects.toBeInstanceOf(CurriculumDesignValidationError);
  });

  it('keeps directed learning order acyclic while allowing a related cycle', async () => {
    await advanceTo('graph');
    const base = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 基础',
      nodeType: 'knowledge',
    });
    const injection = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 注入',
      nodeType: 'knowledge',
    });

    const forward = await createCurriculumDependency(pool, OWNER, task.id, {
      sourceId: base.id,
      targetId: injection.id,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'prerequisite',
    });
    expect(forward.edgeType).toBe('prerequisite');

    await expect(
      createCurriculumDependency(pool, OWNER, task.id, {
        sourceId: injection.id,
        targetId: base.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
      }),
    ).rejects.toBeInstanceOf(CurriculumDesignValidationError);

    // "These two topics are related" is not an order claim, so a cycle there
    // is a legal graph, not a design error.
    await expect(
      createCurriculumDependency(pool, OWNER, task.id, {
        sourceId: injection.id,
        targetId: base.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'composes',
      }),
    ).resolves.toBeTruthy();

    // A different endpoint kind is a different walk. `injection.id` names a
    // node, so reusing it as an objective id is a missing endpoint, not a
    // cycle — which is exactly what the store reports.
    await expect(
      createCurriculumDependency(pool, OWNER, task.id, {
        sourceId: injection.id,
        targetId: base.id,
        sourceKind: 'objective',
        targetKind: 'node',
        edgeType: 'prerequisite',
      }),
    ).rejects.toBeInstanceOf(CurriculumDesignNotFoundError);
  });

  it('treats only order claims as directed when checking for a cycle', async () => {
    await advanceTo('graph');
    const base = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'HTTP 基础',
      nodeType: 'knowledge',
    });
    const headers = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'HTTP 头',
      nodeType: 'knowledge',
    });
    await createCurriculumDependency(pool, OWNER, task.id, {
      sourceId: base.id,
      targetId: headers.id,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'composes',
    });
    // A `composes` pair is mutual support, not an order, so the reverse edge is
    // allowed and no order-cycle exists to block the prerequisite that follows.
    await expect(
      createCurriculumDependency(pool, OWNER, task.id, {
        sourceId: headers.id,
        targetId: base.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
      }),
    ).resolves.toBeTruthy();
  });

  it('refuses to attach coverage to a chapter through the store', async () => {
    await advanceTo('outline');
    const chapter = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'chapter',
      title: '第一章 Web 安全',
    });
    const objective = (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).objectives[0];
    await expect(
      createCurriculumUnitCoverage(pool, OWNER, task.id, {
        unitId: chapter.id,
        objectiveId: objective.id,
        coverageKind: 'teach',
      }),
    ).rejects.toThrow();
  });

  it('withdraws a recorded teaching order instead of only being able to add one', async () => {
    await advanceTo('outline');
    const first = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.1 SQL 注入原理',
      unitRole: 'lecture',
    });
    const second = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.2 联合查询',
      unitRole: 'lecture',
    });
    const recorded = await createCurriculumUnitDependency(pool, OWNER, task.id, {
      sourceUnitId: first.id,
      targetUnitId: second.id,
      edgeType: 'prerequisite',
    });
    // The write path is an upsert on the edge, not an append, which is the
    // whole reason a wrong claim could not be withdrawn by re-recording it.
    await createCurriculumUnitDependency(pool, OWNER, task.id, {
      sourceUnitId: first.id,
      targetUnitId: second.id,
      edgeType: 'prerequisite',
      strength: 0.5,
    });
    const before = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
    expect(before.unitDependencies).toHaveLength(1);
    expect(before.unitDependencies[0]).toMatchObject({ id: recorded.id, strength: 0.5 });

    // Another owner's id is not addressable, so the owner fence holds on delete.
    await expect(deleteCurriculumUnitDependency(pool, OTHER, recorded.id)).rejects.toBeInstanceOf(
      CurriculumDesignNotFoundError,
    );
    await deleteCurriculumUnitDependency(pool, OWNER, recorded.id);
    expect((await getCurriculumDesignSnapshot(pool, OWNER, task.id)).unitDependencies).toEqual([]);
    // Deleting it twice is a refusal rather than a silent success, so a caller
    // cannot read "already gone" as "I just removed it".
    await expect(deleteCurriculumUnitDependency(pool, OWNER, recorded.id)).rejects.toBeInstanceOf(
      CurriculumDesignNotFoundError,
    );
  });

  it('treats a learning-order edge as part of the graph the author signs', async () => {
    await advanceTo('graph');
    const base = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 基础',
      nodeType: 'knowledge',
    });
    const injection = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 注入',
      nodeType: 'knowledge',
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');

    const edge = await createCurriculumDependency(pool, OWNER, task.id, {
      sourceId: base.id,
      targetId: injection.id,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'prerequisite',
    });
    // An edge added after the sign-off changes the graph the author read, so the
    // sign-off has to go — otherwise the phase machine advances on content that
    // changed underneath it.
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'graph')).toBeNull();

    // Re-recording the exact same edge is not a change, so it must not reopen a
    // step the author just signed.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');
    await createCurriculumDependency(pool, OWNER, task.id, {
      sourceId: base.id,
      targetId: injection.id,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'prerequisite',
    });
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'graph')).not.toBeNull();

    // Taking the edge away is a change too.
    await deleteCurriculumDependency(pool, OWNER, edge.id);
    expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'graph')).toBeNull();
    await expect(deleteCurriculumDependency(pool, OWNER, edge.id)).rejects.toBeInstanceOf(
      CurriculumDesignNotFoundError,
    );
  });

  it('takes an edge with the endpoint that is deleted, because nothing cascades', async () => {
    await advanceTo('graph');
    const base = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'HTTP 基础',
      nodeType: 'knowledge',
    });
    const headers = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'HTTP 头',
      nodeType: 'knowledge',
    });
    await createCurriculumDependency(pool, OWNER, task.id, {
      sourceId: base.id,
      targetId: headers.id,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'prerequisite',
    });

    await deleteCurriculumLearningNode(pool, OWNER, headers.id);
    // The endpoints are (kind, id) pairs rather than foreign keys, so a dangling
    // edge would survive as a claim about a node that no longer exists.
    expect((await getCurriculumDesignSnapshot(pool, OWNER, task.id)).dependencies).toEqual([]);
  });

  it('refuses a question whose answer names a missing option', async () => {
    await advanceTo('assessment');
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.2 SQL 注入练习',
      unitRole: 'practice',
    });
    await expect(
      createCurriculumQuestion(pool, OWNER, task.id, {
        unitId: unit.id,
        objectiveId: snapshot.objectives[0].id,
        questionType: 'single',
        stem: '下列哪个参数最可能存在注入点？',
        options: [
          { key: 'A', text: 'id' },
          { key: 'B', text: 'page' },
        ],
        answer: ['C'],
      }),
    ).rejects.toBeInstanceOf(CurriculumDesignValidationError);
  });

  it('refuses a lab with no verification rule, and keeps the reference solution out of grading', async () => {
    await advanceTo('assessment');
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.3 SQL 注入实战',
      unitRole: 'exam',
    });
    const base = {
      unitId: unit.id,
      objectiveId: snapshot.objectives[0].id,
      taskGoal: '获取 /flag',
      dockerImage: 'vuln/sql-injection:latest',
    };

    await expect(
      createCurriculumLabTask(pool, OWNER, task.id, { ...base, verifyRules: [] }),
    ).rejects.toBeInstanceOf(CurriculumDesignValidationError);

    const lab = await createCurriculumLabTask(pool, OWNER, task.id, {
      ...base,
      referenceSolution: [
        { step: 1, action: '发现注入点' },
        { step: 2, action: '构造 payload' },
        { step: 3, action: '读取 flag' },
      ],
      verifyRules: [{ kind: 'flag', value: 'flag{ok}' }],
    });

    // The two live in separate columns with separate types: the reference is
    // a suggested route, the rule is the only thing that can decide a result.
    expect(lab.referenceSolution).toHaveLength(3);
    expect(lab.verifyRules).toEqual([{ kind: 'flag', value: 'flag{ok}' }]);
  });

  it('refuses an exam lab that is not timed, hint-free and un-retryable', async () => {
    await advanceTo('assessment');
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.3 SQL 注入考试',
      unitRole: 'exam',
    });
    await expect(
      createCurriculumLabTask(pool, OWNER, task.id, {
        unitId: unit.id,
        objectiveId: snapshot.objectives[0].id,
        assessmentMode: 'exam',
        taskGoal: '获取 /flag',
        dockerImage: 'vuln/sql-injection:latest',
        hintPolicy: 'unlimited',
        allowRetry: true,
        verifyRules: [{ kind: 'flag', value: 'flag{ok}' }],
      }),
    ).rejects.toThrow();
  });

  it('returns a snapshot that answers the loop in both directions', async () => {
    await advanceTo('outline');
    const objective = (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).objectives[0];
    const lecture = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.1 SQL 注入原理',
      unitRole: 'lecture',
      teachingDesign: { core: ['注入成因'], brief: ['报错注入'] },
      deckDesign: {
        estPages: 3,
        pages: [
          {
            order: 1,
            title: '登录接口长什么样',
            goal: '建立问题场景',
            coreInfo: '展示登录接口与请求示例',
            mode: 'case',
          },
        ],
      },
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: lecture.id,
      objectiveId: objective.id,
      coverageKind: 'teach',
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: lecture.id,
      objectiveId: objective.id,
      coverageKind: 'practice',
    });

    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);

    // From the outcome: what teaches it and what trains it.
    const coverageForOutcome = snapshot.unitCoverage.filter(
      (row) => row.objectiveId === objective.id,
    );
    expect(coverageForOutcome.map((row) => row.coverageKind).sort()).toEqual(['practice', 'teach']);
    // It is not assessed yet, and the snapshot makes that visible rather than
    // implying coverage through a single level column.
    expect(coverageForOutcome.some((row) => row.coverageKind === 'assess')).toBe(false);

    // From the item: the teaching plan and the page plan survive the round trip.
    const unit = snapshot.units.find((row) => row.id === lecture.id)!;
    expect(unit.teachingDesign.core).toEqual(['注入成因']);
    expect(unit.deckDesign.pages?.[0]?.goal).toBe('建立问题场景');
    expect(unit.unitRole).toBe('lecture');
  });

  it('refuses a node that supports no outcome before the outline phase opens', async () => {
    await advanceTo('graph');
    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: '孤儿节点',
      nodeType: 'knowledge',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: 'nope' },
    ]).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CurriculumDesignNotFoundError);
    });
  });

  it('scopes every read to the owner that wrote it', async () => {
    await advanceTo('outline');
    await expect(getCurriculumDesignSnapshot(pool, OTHER, task.id)).rejects.toBeInstanceOf(
      CurriculumDesignNotFoundError,
    );
  });

  // ── Review and the export gate ─────────────────────────────────────────────

  /**
   * Build a course that closes its loop: one outcome, one node it names, one
   * item, and teach + practice + assess coverage with a gradable lab behind the
   * assess row. Every gate test then removes exactly one piece.
   */
  async function buildClosedCourse(): Promise<{ objectiveId: string; unitId: string }> {
    await advanceTo('assessment');
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
    const objective = snapshot.objectives[0];
    const node = snapshot.nodes[0];
    const unit = snapshot.units[0];

    await updateCurriculumUnit(pool, OWNER, unit.id, {
      teachingDesign: { nodes: [node.id] },
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      coverageKind: 'practice',
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      coverageKind: 'assess',
    });
    await createCurriculumLabTask(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      taskGoal: '读取 /flag',
      brief: '存在注入点的靶场服务',
      dockerImage: 'ctf/sql:latest',
      verifyRules: [{ kind: 'file_read', path: '/flag' }],
      referenceSolution: [{ step: 1, action: '构造 payload 并读取 /flag' }],
      scoringMode: 'result',
    });
    return { objectiveId: objective.id, unitId: unit.id };
  }

  it('passes the review for a course that closes its loop', async () => {
    await buildClosedCourse();
    const review = await reviewCurriculumTaskDesign(pool, OWNER, task.id);
    expect(review.quality.broken).toEqual([]);
    expect(review.verdict.complete).toBe(true);
    expect(review.verdict.summary).toContain('1/1');
    expect(review.exportable).toBe(true);
  });

  it('persists the findings so the workspace can show them without re-running', async () => {
    await buildClosedCourse();
    const review = await reviewCurriculumTaskDesign(pool, OWNER, task.id);
    const persisted = (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).auditFindings;
    expect(persisted.length).toBe(review.findings.length);
    expect(persisted.every((row) => row.status === 'open')).toBe(true);
  });

  it('replaces open findings on a second run instead of duplicating them', async () => {
    await buildClosedCourse();
    await reviewCurriculumTaskDesign(pool, OWNER, task.id);
    const second = await reviewCurriculumTaskDesign(pool, OWNER, task.id);
    const persisted = (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).auditFindings;
    expect(persisted.length).toBe(second.findings.length);
  });

  it('blocks export when the loop is not closed, naming the broken layer', async () => {
    const { objectiveId } = await buildClosedCourse();
    // Drop the assess coverage: the outcome is taught and trained but never
    // verified, which is precisely the defect the gate exists to catch.
    await pool.query('DELETE FROM curriculum_unit_coverage WHERE objective_id = $1', [objectiveId]);
    await expect(assertCurriculumDesignExportable(pool, OWNER, task.id)).rejects.toBeInstanceOf(
      CurriculumDesignValidationError,
    );
  });

  it('explains which layer to repair first when export is blocked', async () => {
    const { objectiveId } = await buildClosedCourse();
    // Remove only the assess row. The item still teaches and practises, so
    // `curriculum_covers` holds and `assess_covers` is the first real break —
    // which is exactly the layer the message must name.
    await pool.query(
      "DELETE FROM curriculum_unit_coverage WHERE objective_id = $1 AND coverage_kind = 'assess'",
      [objectiveId],
    );
    await assertCurriculumDesignExportable(pool, OWNER, task.id).catch((error: unknown) => {
      expect(error).toBeInstanceOf(CurriculumDesignValidationError);
      expect((error as Error).message).toMatch(/还不能生成/);
      expect((error as Error).message).toContain('考试覆盖');
    });
  });

  it('re-reads the design at gate time rather than trusting an earlier review', async () => {
    const { objectiveId } = await buildClosedCourse();
    // A review passes, then the design regresses.
    await reviewCurriculumTaskDesign(pool, OWNER, task.id);
    await pool.query('DELETE FROM curriculum_unit_coverage WHERE objective_id = $1', [objectiveId]);
    await expect(assertCurriculumDesignExportable(pool, OWNER, task.id)).rejects.toBeInstanceOf(
      CurriculumDesignValidationError,
    );
  });

  it('finds a lab that was authored with no verification rule', async () => {
    const { unitId, objectiveId } = await buildClosedCourse();
    await createCurriculumLabTask(pool, OWNER, task.id, {
      unitId,
      objectiveId,
      taskGoal: '未配验证规则的任务',
      brief: 'brief',
      dockerImage: 'ctf/x:latest',
      verifyRules: [],
    }).catch((error: unknown) => {
      // The schema refuses this outright, which is the stronger guarantee; if
      // the write is ever relaxed, the audit still catches it.
      expect(error).toBeInstanceOf(CurriculumDesignValidationError);
    });
    const review = await reviewCurriculumTaskDesign(pool, OWNER, task.id);
    const stored = (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).labTasks;
    if (stored.some((lab) => lab.verifyRules.length === 0)) {
      expect(review.findings.some((f) => f.ruleCode === 'lab_no_verify_rule')).toBe(true);
    }
  });
});
