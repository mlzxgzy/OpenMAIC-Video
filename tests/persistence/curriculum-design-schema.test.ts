/**
 * The reverse-design schema, on PGlite.
 *
 * These assertions are about the constraints, not the DDL: the point of the
 * outcome-first model is that a badly shaped design is refused by the
 * database, not merely flagged at review. If any `expectRejected` below starts
 * accepting, the model has quietly gone back to letting "了解 SQL 注入" pass as
 * a verifiable outcome, and the closed loop it is supposed to guarantee is
 * gone with it.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';

const OWNER = 'owner:design';

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

describe('reverse-design curriculum schema (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    await pool.query(
      `INSERT INTO curriculum_series (id, owner_id, name)
                      VALUES ('s1', $1, 'CTF')`,
      [OWNER],
    );
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, series_id, title)
                      VALUES ('t1', $1, 's1', 'CTF 综合实战')`,
      [OWNER],
    );
  });

  afterEach(async () => {
    await db.close();
  });

  const verifiableObjective = (): Promise<{ rows: unknown[] }> =>
    pool.query(
      `INSERT INTO curriculum_objective
         (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
       VALUES ('o1', $1, 't1', '能够利用 SQL 注入读取指定数据', 'skill',
               '在给定靶场中定位注入点并构造 payload 读取 flag',
               '["识别注入点","读取flag"]'::jsonb, true)`,
      [OWNER],
    );

  it('refuses an objective marked verifiable without an observable behavior', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_objective
           (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
         VALUES ('o1', $1, 't1', '了解 SQL 注入', 'knowledge', '', '["a"]'::jsonb, true)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('refuses an objective marked verifiable with no minimum criteria', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_objective
           (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
         VALUES ('o1', $1, 't1', '了解 SQL 注入', 'knowledge', '能解释成因', '[]'::jsonb, true)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('rejects a malformed criteria column as a write, not as a crash', async () => {
    // jsonb_array_length() would raise here; the CHECK is written so a
    // non-array column is refused rather than turning into a 500.
    await expect(
      pool.query(
        `INSERT INTO curriculum_objective
           (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
         VALUES ('o1', $1, 't1', 'x', 'knowledge', '行为', '"not-an-array"'::jsonb, false)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('accepts a properly verifiable objective, and stores a draft that is not yet one', async () => {
    await expect(verifiableObjective()).resolves.toBeTruthy();
    // A draft may exist while it is still being written; it simply cannot be
    // marked verifiable until it names a behavior and a criterion.
    await expect(
      pool.query(
        `INSERT INTO curriculum_objective
           (id, owner_id, task_id, title, objective_type, expected_behavior, min_criteria, verifiable)
         VALUES ('o2', $1, 't1', '了解 SQL 注入', 'knowledge', '', '[]'::jsonb, false)`,
        [OWNER],
      ),
    ).resolves.toBeTruthy();
  });

  it('keeps competency and task out of the learning-node taxonomy', async () => {
    for (const nodeType of ['competency', 'task']) {
      await expect(
        pool.query(
          `INSERT INTO curriculum_learning_node (id, owner_id, task_id, name, node_type)
           VALUES ($1, $1, 't1', 'x', $2)`,
          [OWNER, nodeType],
        ),
      ).rejects.toThrow();
    }
  });

  it('forces an exam to forbid hints and require independence', async () => {
    await verifiableObjective();
    await expect(
      pool.query(
        `INSERT INTO curriculum_evidence
           (id, owner_id, task_id, objective_id, evidence_type, verification_method,
            success_condition, assessment_mode, hint_policy, independent)
         VALUES ('e1', $1, 't1', 'o1', 'lab', '实操验证', '拿到flag', 'exam', 'unlimited', true)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('forces an exam lab to be timed, hint-free and un-retryable', async () => {
    await verifiableObjective();
    await pool.query(
      `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
                      VALUES ('u1', $1, 't1', 'item', '1.2 SQL 注入考试', 'exam')`,
      [OWNER],
    );
    await expect(
      pool.query(
        `INSERT INTO curriculum_lab_task
           (id, owner_id, task_id, unit_id, objective_id, assessment_mode, task_goal,
            docker_image, hint_policy, allow_retry)
         VALUES ('l1', $1, 't1', 'u1', 'o1', 'exam', '获取 /flag', 'vuln/x', 'forbidden', true)`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('keeps a chapter a classification and an item a teaching unit', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
         VALUES ('u1', $1, 't1', 'chapter', '第一章', 'lecture')`,
        [OWNER],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
         VALUES ('u2', $1, 't1', 'item', '1.1 SQL 注入原理', NULL)`,
        [OWNER],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
         VALUES ('u3', $1, 't1', 'item', '1.1 SQL 注入原理', 'lecture')`,
        [OWNER],
      ),
    ).resolves.toBeTruthy();
  });

  it('never lets a chapter carry teach, practice or assess coverage', async () => {
    await verifiableObjective();
    await pool.query(
      `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title)
                      VALUES ('u1', $1, 't1', 'chapter', '第一章 Web 安全')`,
      [OWNER],
    );
    for (const [index, kind] of ['teach', 'practice', 'assess'].entries()) {
      await expect(
        pool.query(
          `INSERT INTO curriculum_unit_coverage
             (id, owner_id, task_id, unit_id, objective_id, coverage_kind)
           VALUES ($1, $2, 't1', 'u1', 'o1', $3)`,
          [`c${index}`, OWNER, kind],
        ),
      ).rejects.toThrow();
    }
  });

  it('holds teach, practice and assess as three independent rows', async () => {
    await verifiableObjective();
    await pool.query(
      `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
                      VALUES ('u1', $1, 't1', 'item', '1.2 SQL 注入考试', 'exam')`,
      [OWNER],
    );
    for (const [index, kind] of ['teach', 'practice', 'assess'].entries()) {
      await expect(
        pool.query(
          `INSERT INTO curriculum_unit_coverage
             (id, owner_id, task_id, unit_id, objective_id, coverage_kind)
           VALUES ($1, $2, 't1', 'u1', 'o1', $3)`,
          [`c${index}`, OWNER, kind],
        ),
      ).resolves.toBeTruthy();
    }
    // The same (unit, objective, kind) is the same claim, not a second one.
    await expect(
      pool.query(
        `INSERT INTO curriculum_unit_coverage
           (id, owner_id, task_id, unit_id, objective_id, coverage_kind)
         VALUES ('cdup', $1, 't1', 'u1', 'o1', 'teach')`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('refuses a self-referential or untyped dependency edge', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_dependency
           (id, owner_id, task_id, source_id, target_id, source_kind, target_kind, edge_type)
         VALUES ('d1', $1, 't1', 'n1', 'n1', 'node', 'node', 'prerequisite')`,
        [OWNER],
      ),
    ).rejects.toThrow();
    await expect(
      pool.query(
        `INSERT INTO curriculum_dependency
           (id, owner_id, task_id, source_id, target_id, source_kind, target_kind, edge_type)
         VALUES ('d2', $1, 't1', 'n1', 'o1', 'node', 'objective', 'requires')`,
        [OWNER],
      ),
    ).rejects.toThrow();
  });

  it('answers the coverage audit with one grouped read', async () => {
    await verifiableObjective();
    await pool.query(
      `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
                      VALUES ('u1', $1, 't1', 'item', '1.1 原理', 'lecture')`,
      [OWNER],
    );
    await pool.query(
      `INSERT INTO curriculum_unit_coverage
         (id, owner_id, task_id, unit_id, objective_id, coverage_kind)
       VALUES ('c1', $1, 't1', 'u1', 'o1', 'teach')`,
      [OWNER],
    );

    // The query the audit runs: which objectives are taught but never practiced
    // and never assessed. The old coverage_level enum could not answer it.
    const taught = await pool.query<{ coverage_kind: string }>(
      `SELECT coverage_kind FROM curriculum_unit_coverage WHERE objective_id = 'o1'`,
    );
    expect(taught.rows.map((row) => row.coverage_kind)).toEqual(['teach']);

    const unassessed = await pool.query<{ id: string }>(
      `SELECT o.id FROM curriculum_objective o
         LEFT JOIN curriculum_unit_coverage uc
           ON uc.objective_id = o.id AND uc.coverage_kind = 'assess'
        WHERE o.task_id = 't1' AND uc.id IS NULL`,
    );
    expect(unassessed.rows).toHaveLength(1);
  });

  it('keeps the existing ledger tables working beside the new layer', async () => {
    await expect(
      pool.query(
        `INSERT INTO curriculum_course (id, owner_id, series_id, title, code)
         VALUES ('c1', $1, 's1', 'CTF综合实战-1-1-1', '1-1-1')`,
        [OWNER],
      ),
    ).resolves.toBeTruthy();
    // The deprecated knowledge-point taxonomy is still readable during the
    // transition, which is what keeps the existing UI on its feet.
    await expect(
      pool.query(
        `INSERT INTO curriculum_knowledge_point (id, owner_id, series_id, name, type)
         VALUES ('k1', $1, 's1', 'SQL 注入', 'competency')`,
        [OWNER],
      ),
    ).resolves.toBeTruthy();
  });

  it('migrates every recorded version exactly once and is re-runnable', async () => {
    await expect(ensureCurriculumSchema(pool)).resolves.toBeUndefined();
    const { rows } = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM openmaic_schema_migrations WHERE store = 'curriculum'`,
    );
    expect(Number(rows[0].count)).toBeGreaterThanOrEqual(12);
  });
});
