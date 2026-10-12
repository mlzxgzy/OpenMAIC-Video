/**
 * The two design-store behaviours that changed, on real PostgreSQL.
 *
 * PGlite runs the same store code, so this is not about SQL dialect. What it
 * adds is the engine that actually runs in production for two things a mock
 * cannot vouch for: a `DELETE ... RETURNING` through the real `pg` driver, and
 * the phase pair surviving the round trip on the connection the workspace uses.
 *
 * Rows are seeded with raw SQL — the store functions under test are the point,
 * and walking the whole phase machine again would only add noise.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  CurriculumDesignNotFoundError,
  CurriculumPhaseError,
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumObjective,
  createCurriculumUnitDependency,
  deleteCurriculumUnitDependency,
  getCurriculumDesignSnapshot,
  listCurriculumOutcomes,
  updateCurriculumObjective,
  withdrawCurriculumDesignStep,
} from '@/lib/server/curriculum/design-store';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_curriculum_store_test';
const OWNER = 'owner:pg-design-store';
const OTHER = 'owner:pg-design-store-other';
const TASK = 'task-pg-store';

/**
 * `pg.Pool#query` returns a wider `QueryResult` than `Queryable#query` promises,
 * and TypeScript will not narrow one to the other on its own. The repo's other
 * PostgreSQL suites cast the pool directly rather than wrapping it, which is
 * what this does too — a hand-rolled adapter would add a second shape for the
 * driver to drift from.
 */
const asQueryable = (pool: Pool): Queryable => pool as unknown as Queryable;

describe.skipIf(!contractUrl)('reverse-design store (PostgreSQL)', () => {
  let pool: Pool;
  let queryable: Queryable;

  beforeAll(async () => {
    const admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    await admin.end();

    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    queryable = asQueryable(pool);
    await ensureCurriculumSchema(pool);

    // A complete brief, so only the phase under test is what stops the advance.
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, title, audience, duration_hours, problem_statement)
       VALUES ($1, $2, 'CTF 综合实战', '安全运维岗新人', 4, '学员无法独立完成基础 Web CTF')`,
      [TASK, OWNER],
    );
    for (const [id, title] of [
      ['unit-a', '1.1 SQL 注入原理'],
      ['unit-b', '1.2 SQL 注入练习'],
    ]) {
      await pool.query(
        `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
         VALUES ($1, $2, $3, 'item', $4, 'lecture')`,
        [id, OWNER, TASK, title],
      );
    }
  });

  afterAll(async () => {
    await pool.end();
    const admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  it('refuses an incomplete boundary with the phase pair, and does not move the task', async () => {
    // The brief is complete — and that is no longer sufficient on its own. The
    // step-1 sign-off is a second, independent condition, and this is the case
    // that proves the production engine reads it rather than the fields alone.
    const unconfirmed = await advanceCurriculumTaskPhase(queryable, OWNER, TASK).catch(
      (error: unknown) => error,
    );
    expect(unconfirmed).toBeInstanceOf(CurriculumPhaseError);
    expect((unconfirmed as Error).message).toContain('课程方向还没有确认');

    await confirmCurriculumDesignStep(queryable, OWNER, TASK, 'task', 'user');
    await expect(advanceCurriculumTaskPhase(queryable, OWNER, TASK)).resolves.toMatchObject({
      designPhase: 'outcomes',
    });
    // The next boundary is not: no outcome exists for the graph to be built on.
    // Refusing it must look like a write that ran ahead of the phase rather than
    // like a malformed request, or a client handles one of the two and not both.
    const failure = await advanceCurriculumTaskPhase(queryable, OWNER, TASK).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(CurriculumPhaseError);
    expect(failure).toMatchObject({ current: 'outcomes', required: 'graph' });
    expect((failure as Error).message).toContain('还没有定义任何学习目标');

    const after = await pool.query<{ design_phase: string }>(
      'SELECT design_phase FROM curriculum_task WHERE id = $1',
      [TASK],
    );
    expect(after.rows[0]?.design_phase).toBe('outcomes');
  });

  it('replaces a repeated confirmation, and keeps the row owner-scoped', async () => {
    // Its own task, seeded raw like the rest of this file: sharing the first
    // test's row would make this case depend on test order.
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, title, audience, duration_hours, problem_statement)
       VALUES ('task-pg-confirm', $1, 'CTF 综合实战', '安全运维岗新人', 4, '学员无法独立完成基础 Web CTF')`,
      [OWNER],
    );
    const id = 'task-pg-confirm';

    const first = await confirmCurriculumDesignStep(
      queryable,
      OWNER,
      id,
      'task',
      'user',
      '手动确认',
    );
    const again = await confirmCurriculumDesignStep(queryable, OWNER, id, 'task', 'assistant');
    // One row per step: re-confirming replaces rather than accumulating, which is
    // what makes "confirm again" and "withdraw" the same row moving.
    expect(again.id).toBe(first.id);
    expect(again.confirmedBy).toBe('assistant');
    expect((await getCurriculumDesignSnapshot(queryable, OWNER, id)).confirmations).toHaveLength(1);

    // Another owner sees nothing and can delete nothing.
    await expect(withdrawCurriculumDesignStep(queryable, OTHER, id, 'task')).resolves.toBe(false);
    expect((await getCurriculumDesignSnapshot(queryable, OWNER, id)).confirmations).toHaveLength(1);

    await expect(withdrawCurriculumDesignStep(queryable, OWNER, id, 'task')).resolves.toBe(true);
    await expect(withdrawCurriculumDesignStep(queryable, OWNER, id, 'task')).resolves.toBe(false);
    expect((await getCurriculumDesignSnapshot(queryable, OWNER, id)).confirmations).toEqual([]);
  });

  it('withdraws a teaching order, upserts it, and fences it by owner', async () => {
    await pool.query('UPDATE curriculum_task SET design_phase = $2 WHERE id = $1', [
      TASK,
      'outline',
    ]);

    const recorded = await createCurriculumUnitDependency(queryable, OWNER, TASK, {
      sourceUnitId: 'unit-a',
      targetUnitId: 'unit-b',
      edgeType: 'prerequisite',
    });
    // Re-recording the same edge restates it; only an explicit delete removes it.
    await createCurriculumUnitDependency(queryable, OWNER, TASK, {
      sourceUnitId: 'unit-a',
      targetUnitId: 'unit-b',
      edgeType: 'prerequisite',
      strength: 0.4,
    });
    const kept = await getCurriculumDesignSnapshot(queryable, OWNER, TASK);
    expect(kept.unitDependencies).toHaveLength(1);
    expect(kept.unitDependencies[0]).toMatchObject({ id: recorded.id, strength: 0.4 });

    // Another owner's id is not addressable, so the fence is in the statement.
    await expect(
      deleteCurriculumUnitDependency(queryable, OTHER, recorded.id),
    ).rejects.toBeInstanceOf(CurriculumDesignNotFoundError);
    await expect(
      deleteCurriculumUnitDependency(queryable, OWNER, 'udep-does-not-exist'),
    ).rejects.toBeInstanceOf(CurriculumDesignNotFoundError);

    await deleteCurriculumUnitDependency(queryable, OWNER, recorded.id);
    expect((await getCurriculumDesignSnapshot(queryable, OWNER, TASK)).unitDependencies).toEqual(
      [],
    );
  });
  it('withdraws the outcome sign-off on a real change, and keeps it on a restatement', async () => {
    // Its own task, seeded raw like the rest of this file: the phase machine is a
    // single row, and stepping it here would couple these two cases.
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, title, audience, duration_hours, problem_statement, design_phase)
       VALUES ('task-pg-outcomes', $1, 'CTF 综合实战', '安全运维岗新人', 4, '学员无法独立完成基础 Web CTF', 'outcomes')`,
      [OWNER],
    );
    const taskId = 'task-pg-outcomes';
    const objective = await createCurriculumObjective(queryable, OWNER, taskId, {
      title: '能够利用 SQL 注入读取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中构造 payload 读取 flag',
      minCriteria: ['识别注入点'],
    });
    expect(objective.verifiable).toBe(true);
    await createCurriculumEvidence(queryable, OWNER, taskId, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 /flag',
    });

    // Complete list, unconfirmed: the same wall step 1 has, on the second step.
    const unconfirmed = await advanceCurriculumTaskPhase(queryable, OWNER, taskId).catch(
      (error: unknown) => error,
    );
    expect(unconfirmed).toBeInstanceOf(CurriculumPhaseError);
    expect((unconfirmed as Error).message).toContain('还没有确认');

    await confirmCurriculumDesignStep(queryable, OWNER, taskId, 'outcomes', 'user');
    expect(
      (await getCurriculumDesignSnapshot(queryable, OWNER, taskId)).confirmations,
    ).toHaveLength(1);

    // A restatement: the model resends the whole outcome to change one criterion.
    // The stored row comes back byte-identical, so the sign-off must survive —
    // otherwise the AI flow revokes the author's agreement every time the model
    // repeats itself, which is most turns.
    await updateCurriculumObjective(queryable, OWNER, objective.id, {
      title: objective.title,
      expectedBehavior: objective.expectedBehavior,
      minCriteria: [...objective.minCriteria],
    });
    expect(
      (await getCurriculumDesignSnapshot(queryable, OWNER, taskId)).confirmations,
    ).toHaveLength(1);

    // A real change re-opens the step: the confirmation signed the previous list.
    await updateCurriculumObjective(queryable, OWNER, objective.id, {
      minCriteria: ['识别注入点', '构造 payload', '读取 flag'],
    });
    expect((await getCurriculumDesignSnapshot(queryable, OWNER, taskId)).confirmations).toEqual([]);

    // Re-confirm, then add an outcome: creating one is always a real change to a
    // list the author has already read, so it re-opens the step too.
    await confirmCurriculumDesignStep(queryable, OWNER, taskId, 'outcomes', 'user');
    await createCurriculumObjective(queryable, OWNER, taskId, {
      title: '课程结束后新增的目标',
      objectiveType: 'skill',
      expectedBehavior: '新增的一条',
      minCriteria: ['x'],
    });
    expect((await getCurriculumDesignSnapshot(queryable, OWNER, taskId)).confirmations).toEqual([]);

    // The reader the step-2 routes share, on the production engine.
    const listed = await listCurriculumOutcomes(queryable, OWNER, taskId);
    expect(listed.objectives.map((row) => row.id)).toEqual([
      objective.id,
      expect.stringMatching(/^obj-/) as unknown as string,
    ]);
    expect(listed.evidence.map((row) => row.objectiveId)).toEqual([objective.id]);
  });
});
