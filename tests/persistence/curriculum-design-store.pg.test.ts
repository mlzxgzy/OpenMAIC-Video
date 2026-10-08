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
  createCurriculumUnitDependency,
  deleteCurriculumUnitDependency,
  getCurriculumDesignSnapshot,
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
    // The brief is complete, so the boundary into `outcomes` is satisfied.
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
    expect((failure as Error).message).toContain('no learning outcomes');

    const after = await pool.query<{ design_phase: string }>(
      'SELECT design_phase FROM curriculum_task WHERE id = $1',
      [TASK],
    );
    expect(after.rows[0]?.design_phase).toBe('outcomes');
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
});
