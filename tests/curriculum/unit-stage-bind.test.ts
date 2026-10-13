/**
 * The design-unit stage write-back (`bindCurriculumUnitStageByRun`), on PGlite.
 *
 * Design-unit generation starts its run directly — no `curriculum_generation_job`
 * row — so the only durable record of *which unit* a run produces is
 * `generation_runs.input->>'curriculumUnitId'`. Before this function existed
 * that id had no consumer at all: a finished unit lost its `stage_id` on the
 * first page refresh, the cockpit's "已出片" count never saw design units, and
 * 「继续上次」 re-pushed units that already had their video.
 *
 * The generation-run schema is created raw (the real bootstrap lives behind the
 * document store); everything else is the app's own `ensureCurriculumSchema`.
 * The store function under test is the point, so rows are seeded directly.
 */
import { PGlite } from '@electric-sql/pglite';
import { beforeEach, describe, expect, it } from 'vitest';
import type { Queryable } from '@openmaic/storage/document/pg';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { bindCurriculumUnitStageByRun } from '@/lib/server/curriculum/store';

const OWNER = 'owner:unit-stage';
const OTHER = 'owner:unit-stage-other';

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

interface Harness {
  pool: PGlitePool;
  seedRun: (runId: string, unitId: string, ownerId?: string) => Promise<void>;
  seedUnit: (unitId: string, taskId: string, ownerId?: string) => Promise<void>;
  seedTask: (taskId: string, ownerId?: string) => Promise<void>;
  stageOf: (unitId: string) => Promise<string | null>;
}

async function makeHarness(db: PGlite): Promise<Harness> {
  const pool = new PGlitePool(db);
  await ensureCurriculumSchema(pool);
  await pool.query(
    `CREATE TABLE IF NOT EXISTS generation_runs (
       id TEXT PRIMARY KEY,
       owner_id TEXT NOT NULL,
       input JSONB NOT NULL,
       state TEXT NOT NULL,
       step TEXT,
       outline JSONB,
       outline_revision INTEGER NOT NULL DEFAULT 0,
       agents JSONB,
       stage_id TEXT,
       scenes_total INTEGER NOT NULL DEFAULT 0,
       scenes_completed INTEGER NOT NULL DEFAULT 0,
       error JSONB,
       seq BIGINT NOT NULL DEFAULT 0,
       lease_worker_id TEXT,
       lease_heartbeat_at BIGINT,
       lease_generation INTEGER NOT NULL DEFAULT 0,
       takeovers INTEGER NOT NULL DEFAULT 0,
       created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  let taskSeq = 0;
  const seedTask = async (taskId: string, ownerId = OWNER) => {
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, title, status, design_phase)
       VALUES ($1, $2, 'CTF 综合实战', 'draft', 'task')`,
      [taskId, ownerId],
    );
    taskSeq += 1;
  };

  const seedUnit = async (unitId: string, taskId: string, ownerId = OWNER) => {
    await pool.query(
      `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
       VALUES ($1, $2, $3, 'item', '第一讲 SQL 注入', 'lecture')`,
      [unitId, ownerId, taskId],
    );
  };

  const seedRun = async (runId: string, unitId: string, ownerId = OWNER) => {
    await pool.query(
      `INSERT INTO generation_runs (id, owner_id, input, state)
       VALUES ($1, $2, $3::jsonb, 'generating')`,
      [runId, ownerId, JSON.stringify({ requirement: 'x', curriculumUnitId: unitId })],
    );
  };

  const stageOf = async (unitId: string) => {
    const result = await pool.query<{ stage_id: string | null }>(
      'SELECT stage_id FROM curriculum_unit WHERE owner_id = $1 AND id = $2',
      [OWNER, unitId],
    );
    return result.rows[0]?.stage_id ?? null;
  };

  return { pool, seedTask, seedUnit, seedRun, stageOf };
}

describe('bindCurriculumUnitStageByRun', () => {
  let db: PGlite;
  let h: Harness;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    h = await makeHarness(db);
  });

  it('binds the unit named by the run input', async () => {
    await h.seedTask('task-1');
    await h.seedUnit('unit-1', 'task-1');
    await h.seedRun('run-1', 'unit-1');

    await expect(bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-1', 'stage-a')).resolves.toBe(
      'bound',
    );
    await expect(h.stageOf('unit-1')).resolves.toBe('stage-a');
  });

  it('reports no-unit when the run input names nothing this owner owns', async () => {
    await h.seedTask('task-1');
    await h.seedUnit('unit-1', 'task-1');
    // The run exists but names another owner's unit (or none at all): the join
    // on both owner and unit id must hold, so this binds nothing.
    await h.seedRun('run-1', 'unit-1', OTHER);

    await expect(bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-1', 'stage-a')).resolves.toBe(
      'no-unit',
    );
    await expect(h.stageOf('unit-1')).resolves.toBeNull();
  });

  it('refuses a stage another unit already holds', async () => {
    await h.seedTask('task-1');
    await h.seedUnit('unit-1', 'task-1');
    await h.seedUnit('unit-2', 'task-1');
    await h.seedRun('run-1', 'unit-2');
    await h.pool.query('UPDATE curriculum_unit SET stage_id = $3 WHERE id = $1 AND owner_id = $2', [
      'unit-1',
      OWNER,
      'stage-a',
    ]);

    await expect(bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-1', 'stage-a')).resolves.toBe(
      'stage-taken',
    );
    await expect(h.stageOf('unit-2')).resolves.toBeNull();
  });

  it('refuses a stage a ledger course already holds', async () => {
    await h.seedTask('task-1');
    await h.seedUnit('unit-1', 'task-1');
    await h.seedRun('run-1', 'unit-1');
    await h.pool.query(
      `INSERT INTO curriculum_course (id, owner_id, title, status, stage_id)
       VALUES ('course-1', $1, '已占用', 'active', 'stage-a')`,
      [OWNER],
    );

    await expect(bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-1', 'stage-a')).resolves.toBe(
      'stage-taken',
    );
    await expect(h.stageOf('unit-1')).resolves.toBeNull();
  });

  it('rebinding the same stage is unchanged, regenerating replaces the stage', async () => {
    await h.seedTask('task-1');
    await h.seedUnit('unit-1', 'task-1');
    await h.seedRun('run-1', 'unit-1');
    await bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-1', 'stage-a');

    // A repeated event carries the same stage: not a change, not an error.
    await expect(bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-1', 'stage-a')).resolves.toBe(
      'unchanged',
    );
    await expect(h.stageOf('unit-1')).resolves.toBe('stage-a');

    // The user regenerates: a second run for the same unit produces a new
    // stage, and the unit follows it — the course ledger path overwrites
    // `stage_id` on a re-run too.
    await h.seedRun('run-2', 'unit-1');
    await expect(bindCurriculumUnitStageByRun(h.pool, OWNER, 'run-2', 'stage-b')).resolves.toBe(
      'bound',
    );
    await expect(h.stageOf('unit-1')).resolves.toBe('stage-b');
  });
});
