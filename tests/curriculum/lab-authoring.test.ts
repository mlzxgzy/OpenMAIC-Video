/**
 * What a lab task must get right, pinned in both directions.
 *
 * Two claims are under test, and each one is checked at two levels because a
 * pure function agreeing with itself proves nothing about the system:
 *
 * 1. **A verify rule is stored where its kind is read from.** The pure mapping is
 *    asserted kind by kind, and then a real `createCurriculumLabTask` call is
 *    read back from PGlite — so the test covers the JSONB round trip, not just
 *    the object literal. A rule whose condition lands in a field the kind never
 *    reads is stored happily and never matches, which is the failure this is
 *    here to keep out.
 *
 * 2. **An exam is refused with a sentence that says what to change.** The store
 *    check and the database constraint are both exercised, and the constraint is
 *    checked *directly*, bypassing the store. Without that second half, deleting
 *    the constraint would leave this suite green: the store would still refuse,
 *    and nothing would notice that the durable rule had been removed. The store
 *    check is a better message in front of a real rule, not a replacement for it.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  EXAM_FORCED_VALUES,
  LAB_VERIFY_KINDS,
  examStrictGaps,
  examStrictRefusal,
  labVerifyFieldFor,
  labVerifyRuleFrom,
  labVerifyTargetOf,
} from '@/lib/curriculum/lab-authoring';
import type { LabVerifyRule } from '@/lib/curriculum/design-types';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  CurriculumDesignValidationError,
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumLabTask,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  setCurriculumNodeObjectives,
  updateCurriculumLabTask,
} from '@/lib/server/curriculum/design-store';

const OWNER = 'owner:lab-authoring';
const DATABASE_URL = 'postgres://lab-authoring';

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

/** A target for each kind, chosen to be unmistakably that kind's condition. */
const TARGET_BY_KIND: Record<(typeof LAB_VERIFY_KINDS)[number], string> = {
  flag: 'flag{probe}',
  file_read: '/flag',
  file_write: '/tmp/probe.out',
  env_state: 'PROBE_MODE',
  http_request: 'http://localhost:8080/health',
  process_exec: '/usr/bin/id -u',
  custom: 'exit_code == 0',
};

/**
 * The field each kind's condition belongs in — written here as data, not read
 * back from the function under test.
 *
 * This table is the specification. The first version of this suite asked
 * `labVerifyFieldFor` what the mapping was and then asserted the writer agreed
 * with it, which only proved the module was self-consistent: changing
 * `file_read` to store its path in `value` kept every test green, because both
 * sides of the assertion moved together. Pinning the expected field separately
 * is what makes a silent re-mapping fail.
 *
 * There is no grading runner in this repository yet, so nothing here can
 * *independently* confirm the semantics; what these tests do is make the
 * mapping a decision someone has to change on purpose.
 */
const EXPECTED_FIELD: Record<(typeof LAB_VERIFY_KINDS)[number], keyof LabVerifyRule> = {
  flag: 'value',
  file_read: 'path',
  file_write: 'path',
  env_state: 'key',
  http_request: 'value',
  process_exec: 'argv',
  custom: 'expression',
};

describe('lab verify rules land in the field their kind is read from', () => {
  it('maps every declared kind to the field this suite pins', () => {
    for (const kind of LAB_VERIFY_KINDS) {
      expect(labVerifyFieldFor(kind), `no field mapped for ${kind}`).toBe(EXPECTED_FIELD[kind]);
    }
    expect(Object.keys(EXPECTED_FIELD).sort()).toEqual([...LAB_VERIFY_KINDS].sort());
  });

  it.each(LAB_VERIFY_KINDS)('%s writes its target into its own field', (kind) => {
    const target = TARGET_BY_KIND[kind];
    const rule = labVerifyRuleFrom(kind, target);
    expect(rule).not.toBeNull();
    // The field comes from this suite's table, never from the mapping under test.
    const field = EXPECTED_FIELD[kind];
    if (field === 'argv') expect(rule?.argv).toEqual(target.split(' '));
    else expect(rule?.[field]).toBe(target);
    // ...and in none of the others, which is what makes the mapping meaningful.
    const others: (keyof LabVerifyRule)[] = [
      'value',
      'path',
      'key',
      'method',
      'argv',
      'expression',
    ];
    for (const other of others) {
      if (other === field) continue;
      expect(rule?.[other], `${kind} also wrote ${String(other)}`).toBeUndefined();
    }
    expect(labVerifyTargetOf(rule as LabVerifyRule)).toBe(target);
  });

  it('refuses a blank target instead of storing a rule that asserts nothing', () => {
    // A rule with no condition still satisfies "has at least one rule", so the
    // store would accept it and review would report a gradable lab that grades
    // nothing. `null` makes the workbench refuse locally with a findable reason.
    expect(labVerifyRuleFrom('file_read', '   ')).toBeNull();
    expect(labVerifyRuleFrom('flag', '')).toBeNull();
  });

  it('keeps a note as commentary, never as the condition', () => {
    const rule = labVerifyRuleFrom('file_read', '/flag', '取证阶段读取');
    expect(rule?.note).toBe('取证阶段读取');
    expect(labVerifyTargetOf(rule as LabVerifyRule)).toBe('/flag');
  });

  it('reads back nothing when a condition was stored in the wrong field', () => {
    // The shape a hand-written body produces: a `file_read` whose path went into
    // `value`. The display must show it as empty rather than echo a value the
    // grader will never read.
    const misrouted = { kind: 'file_read', value: '/flag' } as LabVerifyRule;
    expect(labVerifyTargetOf(misrouted)).toBe('');
  });
});

describe('an exam is independent, hint-free and on a clock', () => {
  const PRACTICE_DEFAULTS = {
    assessmentMode: 'practice' as const,
    hintPolicy: 'unlimited' as const,
    allowRetry: true,
    timeLimitSec: null,
  };

  it('does not constrain practice, whatever it submits', () => {
    // The rule is the exam rule. Over-applying it would refuse the hints and
    // retries that practice exists to allow.
    expect(examStrictGaps(PRACTICE_DEFAULTS)).toEqual([]);
    expect(examStrictRefusal(PRACTICE_DEFAULTS)).toBeNull();
  });

  it('names all three gaps at once for an exam that kept practice defaults', () => {
    const gaps = examStrictGaps({ ...PRACTICE_DEFAULTS, assessmentMode: 'exam' });
    expect(gaps).toHaveLength(3);
    expect(gaps.join(' ')).toContain('hintPolicy');
    expect(gaps.join(' ')).toContain('allowRetry');
    expect(gaps.join(' ')).toContain('timeLimitSec');
  });

  it.each([
    ['hints allowed', { hintPolicy: 'limited' as const }, 'hintPolicy'],
    ['retry allowed', { allowRetry: true }, 'allowRetry'],
    ['no clock', { timeLimitSec: null }, 'timeLimitSec'],
  ])('detects %s on its own', (_label, override, expected) => {
    const gaps = examStrictGaps({
      assessmentMode: 'exam',
      hintPolicy: 'forbidden',
      allowRetry: false,
      timeLimitSec: 1800,
      ...override,
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain(expected);
  });

  it('accepts the values the workbench forces when exam is chosen', () => {
    expect(
      examStrictRefusal({
        assessmentMode: 'exam',
        hintPolicy: EXAM_FORCED_VALUES.hintPolicy,
        allowRetry: EXAM_FORCED_VALUES.allowRetry,
        timeLimitSec: 1800,
      }),
    ).toBeNull();
  });
});

describe('the store and the database both refuse a warm exam', () => {
  let db: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    await db.close();
  });

  /**
   * A task walked to `assessment` through the real boundaries, with one item and
   * one outcome a lab task can point at. The walk is what the phase machine
   * demands; nothing here is a shortcut past a gate.
   */
  async function taskAtAssessment(): Promise<{
    taskId: string;
    unitId: string;
    objectiveId: string;
  }> {
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 实操',
      audience: '安全运维岗新人',
      problemStatement: '学员无法独立完成基础 Web CTF',
      durationHours: 4,
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → outcomes

    const objective = await createCurriculumObjective(pool, OWNER, task.id, {
      title: '能够利用 SQL 注入读取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中构造 payload 读取 flag',
      minCriteria: ['识别注入点'],
    });
    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 /flag',
    });
    // Step 2 closes the same way: complete is not agreed until the user signs off.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → graph

    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 注入原理',
      nodeType: 'knowledge',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: objective.id },
    ]);
    // Step 3 sign-off, same as steps 1 and 2: a complete graph is not an agreed one.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → outline

    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.1 动手检测',
      unitRole: 'practice',
      teachingDesign: { nodes: [node.id], core: ['SQL 注入原理'] },
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      coverageKind: 'teach',
    });
    // Step 5's sign-off gates `outline → teaching`, so a fixture that walks to
    // the assessment phase has to sign the outline on the way.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outline', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → teaching
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → assessment

    return { taskId: task.id, unitId: unit.id, objectiveId: objective.id };
  }

  const base = (ids: { unitId: string; objectiveId: string }) => ({
    unitId: ids.unitId,
    objectiveId: ids.objectiveId,
    taskGoal: '用 sqlmap 检出注入并读取 /flag',
    dockerImage: 'sqlmap:latest',
    verifyRules: [{ kind: 'file_read', path: '/flag' } satisfies LabVerifyRule],
  });

  /**
   * The error a call was refused with.
   *
   * Fails loudly when the call *succeeds*, so a missing refusal cannot be
   * mistaken for a passing assertion — `.catch()` returning the value would
   * type the result as a union and let an accepted write through.
   */
  async function refusalOf<T>(work: Promise<T>): Promise<Error> {
    const outcome = await work.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error: error as Error }),
    );
    if (outcome.ok) throw new Error('expected a refusal, but the call succeeded');
    return outcome.error;
  }

  it('writes the rule into the field the kind is read from, through the store', async () => {
    const ids = await taskAtAssessment();
    // `file_read` is the case that matters: its condition is a `path`, and the
    // tempting mistake is to put it in `value`, which stores cleanly.
    const lab = await createCurriculumLabTask(pool, OWNER, ids.taskId, {
      ...base(ids),
      verifyRules: [labVerifyRuleFrom('file_read', '/flag') as LabVerifyRule],
    });
    // Read back from the row, so this covers the JSONB round trip rather than
    // the object the test just built.
    const stored = await pool.query<{ verify_rules: LabVerifyRule[] }>(
      'SELECT verify_rules FROM curriculum_lab_task WHERE id = $1',
      [lab.id],
    );
    expect(stored.rows[0]?.verify_rules[0]).toMatchObject({ kind: 'file_read' });
    expect(stored.rows[0]?.verify_rules[0]?.path).toBe('/flag');
    expect(stored.rows[0]?.verify_rules[0]?.value).toBeUndefined();
    expect(labVerifyTargetOf(stored.rows[0]?.verify_rules[0] as LabVerifyRule)).toBe('/flag');
  });

  it('refuses an exam that kept the practice defaults, naming what to change', async () => {
    const ids = await taskAtAssessment();
    const refusal = await refusalOf(
      createCurriculumLabTask(pool, OWNER, ids.taskId, {
        ...base(ids),
        assessmentMode: 'exam',
      }),
    );

    expect(refusal).toBeInstanceOf(CurriculumDesignValidationError);
    // The point of the store check: the message names the three fields, where
    // the constraint's own message named only `curriculum_lab_exam_strict`.
    expect(refusal.message).toContain('hintPolicy');
    expect(refusal.message).toContain('allowRetry');
    expect(refusal.message).toContain('timeLimitSec');
    expect(refusal.message).not.toContain('curriculum_lab_exam_strict');
  });

  it('accepts an exam that is cold, hint-free and on a clock', async () => {
    const ids = await taskAtAssessment();
    const lab = await createCurriculumLabTask(pool, OWNER, ids.taskId, {
      ...base(ids),
      assessmentMode: 'exam',
      hintPolicy: 'forbidden',
      allowRetry: false,
      timeLimitSec: 1800,
    });
    expect(lab.assessmentMode).toBe('exam');
    expect(lab.allowRetry).toBe(false);
    expect(lab.timeLimitSec).toBe(1800);
  });

  it('lets practice keep hints and retries', async () => {
    const ids = await taskAtAssessment();
    const lab = await createCurriculumLabTask(pool, OWNER, ids.taskId, {
      ...base(ids),
      assessmentMode: 'practice',
      hintPolicy: 'unlimited',
      allowRetry: true,
    });
    expect(lab.hintPolicy).toBe('unlimited');
    expect(lab.allowRetry).toBe(true);
  });

  it('refuses a one-field update that would warm an existing exam', async () => {
    // A row constraint applies to updates too, and a patch is judged against the
    // row it produces. Checking only the patch's own fields would let this
    // through to a raw constraint violation.
    const ids = await taskAtAssessment();
    const lab = await createCurriculumLabTask(pool, OWNER, ids.taskId, {
      ...base(ids),
      assessmentMode: 'exam',
      hintPolicy: 'forbidden',
      allowRetry: false,
      timeLimitSec: 1800,
    });
    const refusal = await refusalOf(
      updateCurriculumLabTask(pool, OWNER, lab.id, { hintPolicy: 'limited' }),
    );

    expect(refusal).toBeInstanceOf(CurriculumDesignValidationError);
    expect(refusal.message).toContain('hintPolicy');
  });

  it('refuses promoting a practice lab to exam without the cold settings', async () => {
    const ids = await taskAtAssessment();
    const lab = await createCurriculumLabTask(pool, OWNER, ids.taskId, base(ids));
    await expect(
      updateCurriculumLabTask(pool, OWNER, lab.id, { assessmentMode: 'exam' }),
    ).rejects.toBeInstanceOf(CurriculumDesignValidationError);
  });

  it('the database constraint still refuses a warm exam written around the store', async () => {
    // Bypassing the store on purpose. The store's sentence is a better message
    // in front of the rule, not the rule itself — if the constraint were dropped,
    // every other test here would stay green.
    const ids = await taskAtAssessment();
    const violation = await db
      .query(
        `INSERT INTO curriculum_lab_task
           (id, owner_id, task_id, unit_id, objective_id, assessment_mode, task_goal,
            docker_image, verify_rules, hint_policy, allow_retry)
         VALUES ('lab-direct', $1, $2, $3, $4, 'exam', 'warm exam', 'img:latest',
                 '[{"kind":"flag","value":"x"}]'::jsonb, 'unlimited', true)`,
        [OWNER, ids.taskId, ids.unitId, ids.objectiveId],
      )
      .catch((error: unknown) => error as { constraint?: string });

    expect((violation as { constraint?: string }).constraint).toBe('curriculum_lab_exam_strict');
  });
});
