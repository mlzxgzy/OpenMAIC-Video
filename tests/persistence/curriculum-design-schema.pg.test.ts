/**
 * The reverse-design schema on real PostgreSQL, in a schema of its own.
 *
 * PGlite already runs these constraints, but the chapter-coverage rule is a
 * `plpgsql` trigger and the rest lean on JSONB CHECK evaluation, so the
 * engine that actually runs in production is the one that has to agree. This
 * suite re-checks the two behaviours most likely to differ: the trigger firing
 * on a real backend, and a malformed JSONB column being refused as a write
 * rather than raising out of the CHECK.
 */
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';

const contractUrl = process.env.PG_CONTRACT_URL;
const TEST_SCHEMA = 'openmaic_curriculum_design_test';
const OWNER = 'owner:pg-design';

describe.skipIf(!contractUrl)('reverse-design schema (PostgreSQL)', () => {
  let admin: Pool;
  let pool: Pool;

  beforeAll(async () => {
    admin = new Pool({ connectionString: contractUrl });
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.query(`CREATE SCHEMA ${TEST_SCHEMA}`);
    pool = new Pool({ connectionString: contractUrl, options: `-c search_path=${TEST_SCHEMA}` });
    await ensureCurriculumSchema(pool);
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, title)
                      VALUES ('t1', $1, 'CTF 综合实战')`,
      [OWNER],
    );
  });

  afterAll(async () => {
    await pool.end();
    await admin.query(`DROP SCHEMA IF EXISTS ${TEST_SCHEMA} CASCADE`);
    await admin.end();
  });

  async function seedUnit(id: string, unitType: 'chapter' | 'item'): Promise<void> {
    await pool.query(
      `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
       VALUES ($1, $2, 't1', $3, $4, $5)`,
      [
        id,
        OWNER,
        unitType,
        unitType === 'item' ? '1.1 原理' : '第一章 Web 安全',
        unitType === 'item' ? 'lecture' : null,
      ],
    );
  }

  async function seedVerifiableObjective(id: string): Promise<void> {
    await pool.query(
      `INSERT INTO curriculum_objective
         (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
       VALUES ($1, $2, 't1', '能够读取 flag', 'skill', '读取 flag',
               '["读取flag"]'::jsonb, true)`,
      [id, OWNER],
    );
  }

  it('records every migration version exactly once', async () => {
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM openmaic_schema_migrations WHERE store = 'curriculum'`,
    );
    expect(Number(rows[0].count)).toBe(12);
    await ensureCurriculumSchema(pool);
    const again = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM openmaic_schema_migrations WHERE store = 'curriculum'`,
    );
    expect(Number(again.rows[0].count)).toBe(12);
  });

  it('refuses an objective marked verifiable with no behavior or criteria', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_objective
           (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
         VALUES ('o-bad', $1, 't1', '了解 SQL 注入', 'knowledge', '', '["a"]'::jsonb, true)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('refuses a malformed criteria column as a write rather than raising', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_objective
           (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
         VALUES ('o-bad2', $1, 't1', 'x', 'knowledge', '行为', '"scalar"'::jsonb, false)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('fires the chapter trigger on a real backend', async () => {
    await seedVerifiableObjective('o1');
    await seedUnit('u-chapter', 'chapter');
    for (const kind of ['teach', 'practice', 'assess']) {
      await expect(
        pool.query(
          `INSERT INTO curriculum_unit_coverage
             (id, owner_id, task_id, unit_id, objective_id, coverage_kind)
           VALUES ($1, $1, 't1', 'u-chapter', 'o1', $2)`,
          [OWNER, `c-${kind}`],
        ),
      ).rejects.toThrow();
    }
  });

  it('accepts the same three coverage kinds on an item', async () => {
    await seedUnit('u-item', 'item');
    for (const kind of ['teach', 'practice', 'assess']) {
      await expect(
        pool.query(
          `INSERT INTO curriculum_unit_coverage
             (id, owner_id, task_id, unit_id, objective_id, coverage_kind)
           VALUES ($1, $2, 't1', 'u-item', 'o1', $3)`,
          [`ci-${kind}`, OWNER, kind],
        ),
      ).resolves.toBeTruthy();
    }
  });

  it('keeps exam policy in the database', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_lab_task
           (id, owner_id, task_id, unit_id, objective_id, assessment_mode, task_goal,
            docker_image, hint_policy, allow_retry)
         VALUES ('l-bad', $1, 't1', 'u-item', 'o1', 'exam', '获取 /flag',
                 'vuln/x', 'unlimited', true)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('keeps the legacy ledger tables alongside the new layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_course (id, owner_id, title, code)
         VALUES ('c1', $1, 'CTF综合实战-1-1-1', '1-1-1')`,
        [OWNER],
      ),
    ).resolves.toBeTruthy();
  });
});
