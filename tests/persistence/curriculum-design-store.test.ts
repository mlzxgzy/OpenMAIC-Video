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
  createCurriculumDependency,
  createCurriculumEvidence,
  createCurriculumLabTask,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumQuestion,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  CurriculumDesignNotFoundError,
  CurriculumDesignValidationError,
  CurriculumPhaseError,
  getCurriculumDesignSnapshot,
  listCurriculumTasks,
  setCurriculumNodeObjectives,
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
    // → outcomes
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

  it('refuses to leave the brief phase while it is still incomplete', async () => {
    const bare = await createCurriculumTask(pool, OWNER, { title: '未澄清的课程' });
    await expect(advanceCurriculumTaskPhase(pool, OWNER, bare.id)).rejects.toBeInstanceOf(
      CurriculumDesignValidationError,
    );
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
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    await createCurriculumObjective(pool, OWNER, task.id, {
      title: '能够利用 SQL 注入读取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中定位注入点并构造 payload 读取 flag',
      minCriteria: ['识别注入点'],
      verifiable: true,
    });
    // The outcome is well-formed but nothing can yet show it was met.
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).rejects.toThrow(/evidence/);

    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: (await getCurriculumDesignSnapshot(pool, OWNER, task.id)).objectives[0].id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 /flag',
    });
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).resolves.toMatchObject({
      designPhase: 'graph',
    });
  });

  it('refuses to build the graph before any outcome exists at all', async () => {
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    await expect(advanceCurriculumTaskPhase(pool, OWNER, task.id)).rejects.toThrow(
      /no learning outcomes/,
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
});
