/**
 * The workbench's authoring gates, pinned against the live store.
 *
 * `DESIGN_AUTHORING_GATES` in `lib/curriculum/design-editing.ts` is a hand
 * transcription: the store's `assertPhase` calls live inside function bodies and
 * cannot be imported. A transcription nobody checks is a comment, and a wrong one
 * is worse than nothing — the workbench would hide a create control the server
 * accepts, or offer one it refuses with a 409 after the click. Both were the
 * shape of the dead paths removed in the previous rounds.
 *
 * So this suite derives the table a second time, the other way round: it calls
 * the real store function at every phase of a real task and records whether the
 * call came back phase-locked. No mocks.
 *
 * The signal is the error *type*, not whether the call succeeded.
 * `assertPhase` is the first statement of every gated write, so a probe carrying
 * deliberately unresolvable ids still separates the two cases: phase-locked means
 * the gate stopped it, anything else — including `CurriculumDesignNotFoundError`
 * for the fake ids — means the gate let it through to the body. Asserting on
 * success instead would have needed a fully valid fixture per phase per kind, and
 * would have quietly measured the fixture rather than the gate.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  CURRICULUM_DESIGN_PHASE_ORDER,
  DESIGN_AUTHORING_GATES,
  authoringAvailability,
  openAuthoringKinds,
  type DesignAuthoring,
} from '@/lib/curriculum/design-editing';
import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
} from '@/lib/curriculum/design-types';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  CurriculumPhaseError,
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
  setCurriculumNodeObjectives,
  setCurriculumUnitCoverage,
} from '@/lib/server/curriculum/design-store';

const OWNER = 'owner:design-editing';
const DATABASE_URL = 'postgres://design-editing';

/** Ids that cannot exist. Every gate is checked before any id is read. */
const PROBE = 'probe-does-not-exist';

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

/** One probe per authoring kind: the store call the workbench actually makes. */
type Probe = (pool: Queryable, taskId: string) => Promise<unknown>;

/**
 * `coverage` is `setCurriculumUnitCoverage` (PUT) rather than
 * `createCurriculumUnitCoverage` (POST). The POST twin carries no phase gate at
 * all; the workbench uses the gated route for the transaction reason in
 * `COVERAGE_WRITE_NOTE`, and pinning the gated one here is what keeps that
 * decision honest.
 */
const PROBES: Record<DesignAuthoring, Probe> = {
  outcomes: (pool, taskId) =>
    createCurriculumObjective(pool, OWNER, taskId, {
      title: '探针目标',
      objectiveType: 'skill',
    }),
  evidence: (pool, taskId) =>
    createCurriculumEvidence(pool, OWNER, taskId, {
      objectiveId: PROBE,
      evidenceType: 'quiz',
      verificationMethod: '测验',
      successCondition: '答对',
    }),
  nodes: (pool, taskId) =>
    createCurriculumLearningNode(pool, OWNER, taskId, {
      name: '探针知识点',
      nodeType: 'knowledge',
    }),
  'node-objectives': (pool, taskId) =>
    setCurriculumNodeObjectives(pool, OWNER, taskId, [{ nodeId: PROBE, objectiveId: PROBE }]),
  dependencies: (pool, taskId) =>
    createCurriculumDependency(pool, OWNER, taskId, {
      sourceId: PROBE,
      targetId: PROBE,
      sourceKind: 'node',
      targetKind: 'node',
      edgeType: 'prerequisite',
    }),
  units: (pool, taskId) =>
    createCurriculumUnit(pool, OWNER, taskId, {
      unitType: 'item',
      title: '探针条目',
      unitRole: 'lecture',
    }),
  coverage: (pool, taskId) =>
    setCurriculumUnitCoverage(pool, OWNER, taskId, [
      { unitId: PROBE, objectiveId: PROBE, coverageKind: 'teach' },
    ]),
  'unit-dependencies': (pool, taskId) =>
    createCurriculumUnitDependency(pool, OWNER, taskId, {
      sourceUnitId: PROBE,
      targetUnitId: PROBE,
    }),
  questions: (pool, taskId) =>
    createCurriculumQuestion(pool, OWNER, taskId, {
      unitId: PROBE,
      objectiveId: PROBE,
      questionType: 'single',
      stem: '探针题干',
    }),
  'lab-tasks': (pool, taskId) =>
    createCurriculumLabTask(pool, OWNER, taskId, {
      unitId: PROBE,
      objectiveId: PROBE,
      taskGoal: '探针实操',
      dockerImage: 'probe:latest',
      verifyRules: [{ kind: 'flag', value: '/flag' }],
    }),
};

describe('design workbench authoring gates', () => {
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
   * A real task walked to `phase` through the real boundaries.
   *
   * Each phase gets its own task, and not for isolation: `assertPhase` is "at or
   * past", so one task walked to `review` would pass every gate and test nothing.
   * The walk mirrors what each boundary actually checks — `graph` needs an
   * evidenced outcome, `outline` needs a node supporting one, `teaching` needs
   * that outcome taught by an item.
   */
  async function taskAtPhase(phase: CurriculumDesignPhase): Promise<string> {
    const task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '安全运维岗新人',
      problemStatement: '学员无法独立完成基础 Web CTF',
      durationHours: 54,
    });
    if (phase === 'task') return task.id;

    // Step 1 closes on the user's sign-off, not on the fields being filled.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → outcomes
    if (phase === 'outcomes') return task.id;

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
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → graph
    if (phase === 'graph') return task.id;

    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: objective.id },
    ]);
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → outline
    if (phase === 'outline') return task.id;

    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.1 SQL 注入原理',
      unitRole: 'lecture',
    });
    // The POST coverage writer, reached directly, purely to seed the walk. It is
    // the ungated twin the workbench avoids; using it here is what keeps the
    // probe table pointed at the gated PUT.
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      coverageKind: 'teach',
    });
    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → teaching
    if (phase === 'teaching') return task.id;

    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → assessment
    if (phase === 'assessment') return task.id;

    await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → review
    return task.id;
  }

  /** Whether the store refused this call because of the design phase. */
  async function refusedByPhase(probe: Probe, taskId: string): Promise<boolean> {
    try {
      await probe(pool, taskId);
      return false;
    } catch (error) {
      return error instanceof CurriculumPhaseError;
    }
  }

  it('the transcribed table matches what the store actually refuses', async () => {
    const refused: Record<string, Set<string>> = {};
    for (const kind of Object.keys(PROBES) as DesignAuthoring[]) {
      refused[kind] = new Set<string>();
    }

    for (const phase of CURRICULUM_DESIGN_PHASES) {
      const taskId = await taskAtPhase(phase);
      for (const kind of Object.keys(PROBES) as DesignAuthoring[]) {
        if (await refusedByPhase(PROBES[kind], taskId)) refused[kind].add(phase);
      }
    }

    for (const kind of Object.keys(PROBES) as DesignAuthoring[]) {
      const requiredRank = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(
        DESIGN_AUTHORING_GATES[kind].requiredPhase,
      );
      for (const phase of CURRICULUM_DESIGN_PHASES) {
        const shouldRefuse = CURRICULUM_DESIGN_PHASE_ORDER.indexOf(phase) < requiredRank;
        const didRefuse = refused[kind].has(phase);
        expect(
          didRefuse,
          `${kind} at ${phase}: table says ${shouldRefuse ? 'refuse' : 'allow'}` +
            ` (required at ${DESIGN_AUTHORING_GATES[kind].requiredPhase}),` +
            ` store said ${didRefuse ? 'refuse' : 'allow'}`,
        ).toBe(shouldRefuse);
      }
    }
  });

  it('the gate is "at or past", so review can still be corrected', () => {
    // An equality check would freeze the workbench at review — the phase where a
    // course is most likely to be corrected.
    expect(authoringAvailability('review', 'outcomes').allowed).toBe(true);
    expect(authoringAvailability('review', 'units').allowed).toBe(true);
    expect(authoringAvailability('review', 'lab-tasks').allowed).toBe(true);
    expect(openAuthoringKinds('review')).toHaveLength(Object.keys(PROBES).length);
  });

  it('a closed kind names the phase to reach, not just where it is', () => {
    const closed = authoringAvailability('task', 'units');
    expect(closed.allowed).toBe(false);
    expect(closed.requiredPhase).toBe('outline');
    // "X 未到" is not actionable; "先完成 Y 阶段" is.
    expect(closed.reason).toContain('课程大纲');
    expect(closed.reason).toContain('大纲条目');
  });

  it('every kind opens at its own required phase, or a row is dead', () => {
    for (const [kind, gate] of Object.entries(DESIGN_AUTHORING_GATES)) {
      expect(openAuthoringKinds(gate.requiredPhase)).toContain(kind);
    }
  });

  it('the coverage POST twin is ungated, which is why the workbench uses PUT', async () => {
    // If someone "fixes" the workbench by switching coverage to POST, the store
    // would accept claims from the `task` phase and the matrix would fill in
    // before the design reached the outline. This pins that the twin really is
    // ungated, so the PUT choice is a decision with a stated reason rather than
    // a preference that could be reversed silently.
    //
    // The call does throw — on the unresolvable ids, which is what proves the
    // request reached the body. Only the *phase* is under test, so the
    // assertion is on the error type.
    const taskId = await taskAtPhase('task');
    let threw = false;
    try {
      await createCurriculumUnitCoverage(pool, OWNER, taskId, {
        unitId: PROBE,
        objectiveId: PROBE,
        coverageKind: 'teach',
      });
    } catch (error) {
      threw = true;
      expect(
        error,
        'POST coverage reached the body instead of being phase-locked',
      ).not.toBeInstanceOf(CurriculumPhaseError);
    }
    expect(threw, 'the fake ids should have been rejected by the body').toBe(true);
  });
});
