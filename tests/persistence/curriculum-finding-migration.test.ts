/**
 * The finding fingerprint migration, run over a table that predates it.
 *
 * This is the one piece of step 8 that cannot be exercised by using the
 * application: it only runs against databases that already hold rows written
 * before findings had an address. Getting it wrong is silent in the worst way —
 * a fingerprint computed differently from `findingFingerprint` means every
 * decision an author already made stops matching, and the defects they accepted
 * come back as new, blocking, and indistinguishable from ones they never saw.
 *
 * So the migration body is replayed here over a hand-built legacy table: rows
 * without a fingerprint, the same defect stored twice (once accepted, once open),
 * and one `ref_ids` array in a different order than the application would write.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findingFingerprint } from '@/lib/curriculum/design-review';
import { CURRICULUM_MIGRATIONS, ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { createCurriculumTask } from '@/lib/server/curriculum/design-store';

const OWNER = 'owner:finding-migration';

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

const MIGRATION_14 = CURRICULUM_MIGRATIONS.migrations.find(
  (migration) => migration.version === 14,
)!;

/**
 * This test replays the migration's SQL directly, against a table rewound to its
 * pre-migration shape. A migration may also ship as a function; if this one ever
 * stops being plain SQL, the replay has to become a call rather than silently
 * asserting nothing.
 */
const MIGRATION_14_SQL: string = (() => {
  if (typeof MIGRATION_14.up !== 'string') throw new Error('migration 14 is no longer SQL');
  return MIGRATION_14.up;
})();

describe('curriculum finding fingerprint migration (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let taskId: string;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '安全运维岗新人',
      problemStatement: '学员无法独立完成基础 Web CTF',
      durationHours: 54,
    });
    taskId = task.id;

    // Rewind the table to its pre-migration shape: no fingerprint, no unique
    // index, so legacy rows can be inserted exactly as the old code wrote them.
    await db.exec(`
      DROP INDEX IF EXISTS curriculum_audit_finding_owner_fingerprint_idx;
      ALTER TABLE curriculum_audit_finding ALTER COLUMN fingerprint DROP NOT NULL;
    `);
  });

  afterEach(async () => {
    await db.close();
  });

  async function insertLegacy(row: {
    id: string;
    ruleCode: string;
    refKind?: string | null;
    refId?: string | null;
    refIds?: string[];
    status?: 'open' | 'waived' | 'resolved';
    createdAt: string;
  }): Promise<void> {
    await db.query(
      `INSERT INTO curriculum_audit_finding
         (id, owner_id, task_id, rule_code, severity, message, ref_kind, ref_id, ref_ids, status, created_at, updated_at)
       VALUES ($1,$2,$3,$4,'error','legacy message',$5,$6,$7::jsonb,$8,$9,$9)`,
      [
        row.id,
        OWNER,
        taskId,
        row.ruleCode,
        row.refKind ?? null,
        row.refId ?? null,
        JSON.stringify(row.refIds ?? []),
        row.status ?? 'open',
        row.createdAt,
      ],
    );
  }

  it('gives every legacy row the address the application computes', async () => {
    await insertLegacy({
      id: 'finding-1',
      ruleCode: 'objective_uncovered',
      refKind: 'objective',
      refId: 'objective-1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await insertLegacy({
      id: 'finding-2',
      ruleCode: 'unit_dependency_out_of_order',
      refKind: 'unitDependency',
      refId: 'edge-1',
      // Written in the other order, with a repeat: the address sorts and dedupes.
      refIds: ['unit-b', 'unit-a', 'unit-a'],
      createdAt: '2026-01-02T00:00:00Z',
    });

    await db.exec(MIGRATION_14_SQL);

    const rows = await db.query<{ id: string; fingerprint: string }>(
      'SELECT id, fingerprint FROM curriculum_audit_finding ORDER BY id',
    );
    const byId = new Map(rows.rows.map((row) => [row.id, row.fingerprint]));
    expect(byId.get('finding-1')).toBe(
      findingFingerprint({
        rule: 'objective_uncovered',
        refKind: 'objective',
        refId: 'objective-1',
        refIds: [],
      }),
    );
    expect(byId.get('finding-2')).toBe(
      findingFingerprint({
        rule: 'unit_dependency_out_of_order',
        refKind: 'unitDependency',
        refId: 'edge-1',
        refIds: ['unit-a', 'unit-b'],
      }),
    );
  });

  it('keeps the accepted row and drops the duplicate report of the same defect', async () => {
    // Exactly what the old review left behind: the author accepted the defect, and
    // the next review re-reported it as a fresh, open row. A unique index cannot be
    // built over the pair, and dropping the decision would be the wrong one of the
    // two to lose.
    await insertLegacy({
      id: 'finding-accepted',
      ruleCode: 'objective_untaugh',
      refKind: 'objective',
      refId: 'objective-1',
      status: 'waived',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await insertLegacy({
      id: 'finding-duplicate',
      ruleCode: 'objective_untaugh',
      refKind: 'objective',
      refId: 'objective-1',
      status: 'open',
      createdAt: '2026-01-05T00:00:00Z',
    });

    await db.exec(MIGRATION_14_SQL);

    const rows = await db.query<{ id: string; status: string }>(
      'SELECT id, status FROM curriculum_audit_finding',
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ id: 'finding-accepted', status: 'waived' });
  });

  it('leaves one row per defect enforced by the database afterwards', async () => {
    await insertLegacy({
      id: 'finding-1',
      ruleCode: 'objective_uncovered',
      refKind: 'objective',
      refId: 'objective-1',
      createdAt: '2026-01-01T00:00:00Z',
    });
    await db.exec(MIGRATION_14_SQL);

    await expect(
      db.query(
        `INSERT INTO curriculum_audit_finding
           (id, owner_id, task_id, fingerprint, rule_code, severity, message, ref_kind, ref_id, ref_ids, status)
         VALUES ('finding-2',$1,$2,'objective_uncovered|objective|objective-1|','objective_uncovered','error','m','objective','objective-1','[]'::jsonb,'open')`,
        [OWNER, taskId],
      ),
    ).rejects.toThrow();
  });
});
