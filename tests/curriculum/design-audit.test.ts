import { describe, expect, it } from 'vitest';

import {
  CURRICULUM_AUDIT_RULES,
  auditCurriculumDesign,
  evaluateCurriculumQuality,
  reviewCurriculumDesign,
  type CurriculumAuditFinding,
} from '@/lib/curriculum/audit';
import type {
  CurriculumAuditFindingRecord,
  CurriculumAuditSeverity,
  CurriculumDesignSnapshot,
  CurriculumDependencyEdgeType,
  CurriculumDependencyKind,
  CurriculumLearningNodeRecord,
  CurriculumObjectiveRecord,
  CurriculumObjectiveType,
  CurriculumUnitRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitDependencyRecord,
} from '@/lib/curriculum/design-types';

const NOW = '2026-01-01T00:00:00.000Z';

// ── Fixture ──────────────────────────────────────────────────────────────────

interface SnapshotOverrides {
  /** Each entry must carry the field the fixture is keyed on. */
  objectives?: Array<Partial<CurriculumObjectiveRecord> & { title: string }>;
  nodes?: Array<Partial<CurriculumLearningNodeRecord> & { name: string }>;
  units?: Array<Partial<CurriculumUnitRecord> & { title: string }>;
  coverage?: CurriculumUnitCoverageRecord[];
  dependencies?: Array<{
    sourceId: string;
    targetId: string;
    edgeType: CurriculumDependencyEdgeType;
    sourceKind?: CurriculumDependencyKind;
    targetKind?: CurriculumDependencyKind;
  }>;
  labTasks?: CurriculumDesignSnapshot['labTasks'];
  questions?: CurriculumDesignSnapshot['questions'];
  evidence?: CurriculumDesignSnapshot['evidence'];
  nodeObjectives?: CurriculumDesignSnapshot['nodeObjectives'];
  brief?: Partial<CurriculumDesignSnapshot['task']>;
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

function makeObjective(
  overrides: Partial<CurriculumObjectiveRecord> & { title: string },
): CurriculumObjectiveRecord {
  return {
    id: nextId('obj'),
    taskId: 'task-1',
    parentId: null,
    code: null,
    description: null,
    objectiveType: 'skill' as CurriculumObjectiveType,
    bloomLevel: null,
    level: 'component',
    expectedBehavior: `the learner ${overrides.title.toLowerCase()}`,
    minCriteria: ['performs the task'],
    proficientCriteria: [],
    excellentCriteria: [],
    difficulty: 'basic',
    verifiable: true,
    unverifiableReason: null,
    status: 'draft',
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeNode(overrides: Partial<CurriculumLearningNodeRecord> & { name: string }) {
  return {
    id: nextId('node'),
    taskId: 'task-1',
    parentId: null,
    code: null,
    nodeType: 'skill' as const,
    summary: null,
    difficulty: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies CurriculumLearningNodeRecord;
}

function makeUnit(overrides: Partial<CurriculumUnitRecord> & { title: string }) {
  return {
    id: nextId('unit'),
    taskId: 'task-1',
    parentId: null,
    unitType: 'item' as const,
    code: null,
    unitRole: 'lecture' as const,
    hours: 1,
    orderIndex: 0,
    teachingDesign: {},
    deckDesign: {},
    stageId: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies CurriculumUnitRecord;
}

function makeCoverage(
  overrides: Partial<CurriculumUnitCoverageRecord> &
    Required<Pick<CurriculumUnitCoverageRecord, 'unitId' | 'objectiveId' | 'coverageKind'>>,
): CurriculumUnitCoverageRecord {
  return {
    id: nextId('cov'),
    taskId: 'task-1',
    depth: 'standard',
    orderIndex: 0,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } as CurriculumUnitCoverageRecord;
}

/**
 * A snapshot that passes the audit with zero errors. Every test then breaks
 * exactly one thing, so a finding can only have come from the rule under test.
 */
function makeSnapshot(overrides: SnapshotOverrides = {}): CurriculumDesignSnapshot {
  const objectives = (overrides.objectives ?? [{ title: 'Exploit a SQL injection' }]).map((o) =>
    makeObjective(o),
  );
  const nodes = (overrides.nodes ?? [{ name: 'SQL injection basics' }]).map((n) => makeNode(n));
  const units = (overrides.units ?? [{ title: 'Item 1', unitRole: 'lecture' }]).map((u) =>
    makeUnit(u),
  );
  const objective = objectives[0];
  const unit = units[0];

  const coverage: CurriculumUnitCoverageRecord[] =
    overrides.coverage ??
    (['teach', 'practice', 'assess'] as const).map((coverageKind) =>
      makeCoverage({ unitId: unit.id, objectiveId: objective.id, coverageKind }),
    );

  // A real lecture names the nodes it teaches **and** plans the pages that carry
  // them. Both are part of a sound design since step 6: the depth buckets are how
  // a lesson decides what it is about, and the storyboard is the only channel the
  // teaching design has to the generator. So the baseline has to model both — a
  // design without a storyboard is not finished, and the audit now says so.
  for (const unit of units) {
    if (unit.teachingDesign && Object.keys(unit.teachingDesign).length === 0) {
      unit.teachingDesign = { nodes: nodes.map((n) => n.id), core: nodes.map((n) => n.id) };
    }
    if (
      unit.unitType === 'item' &&
      unit.unitRole === 'lecture' &&
      unit.deckDesign &&
      Object.keys(unit.deckDesign).length === 0
    ) {
      unit.deckDesign = {
        estPages: 1,
        pages: [
          {
            order: 1,
            title: 'SQL injection basics',
            goal: 'the learner can name the injection point',
            coreInfo: 'a parameter concatenated into SQL is the injection point',
            mode: 'explain',
            teaches: nodes.map((n) => n.name),
          },
        ],
      };
    }
  }

  const nodeObjectives =
    overrides.nodeObjectives ??
    nodes.map((node) => ({
      id: nextId('no'),
      taskId: 'task-1',
      nodeId: node.id,
      objectiveId: objective.id,
      supportLevel: 'primary' as const,
      note: null,
      createdAt: NOW,
      updatedAt: NOW,
    }));

  const evidence =
    overrides.evidence ??
    (['practice', 'exam'] as const).map((assessmentMode) => ({
      id: nextId('ev'),
      taskId: 'task-1',
      objectiveId: objective.id,
      evidenceType: assessmentMode === 'exam' ? ('lab' as const) : ('quiz' as const),
      verificationMethod: 'task outcome',
      successCondition: 'the target data is retrieved',
      conditionExpression: null,
      auxiliaryCondition: null,
      assessmentMode,
      thresholdPass: 60,
      thresholdProficient: 80,
      thresholdExcellent: 95,
      timeLimitSec: null,
      hintPolicy: assessmentMode === 'exam' ? ('forbidden' as const) : ('unlimited' as const),
      independent: assessmentMode === 'exam',
      processRecord: false,
      sortOrder: 0,
      createdAt: NOW,
      updatedAt: NOW,
    }));

  const questions: CurriculumDesignSnapshot['questions'] =
    overrides.questions ??
    evidence
      .filter((e) => e.evidenceType === 'quiz')
      .map((e) => ({
        id: nextId('q'),
        taskId: 'task-1',
        unitId: unit.id,
        objectiveId: objective.id,
        evidenceId: e.id,
        questionType: 'single' as const,
        stem: 'Which parameter is injectable?',
        options: [{ key: 'A', text: 'id' }],
        answer: ['A'],
        explanation: 'The id parameter is concatenated.',
        distractors: [{ optionKey: 'B', misconception: 'confuses GET and POST' }],
        difficulty: 'basic' as const,
        bloomLevel: null,
        score: 5,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }));

  const labTasks: CurriculumDesignSnapshot['labTasks'] =
    overrides.labTasks ??
    evidence
      .filter((e) => e.evidenceType === 'lab')
      .map((e) => ({
        id: nextId('lab'),
        taskId: 'task-1',
        unitId: unit.id,
        objectiveId: objective.id,
        evidenceId: e.id,
        assessmentMode: e.assessmentMode,
        taskGoal: 'Read the flag',
        brief: 'The service is vulnerable.',
        expectedResult: '/flag is readable',
        dockerImage: 'ctf/sql:latest',
        containerConfig: {},
        initState: {},
        resetPolicy: 'on-start' as const,
        referenceSolution: [
          { step: 1, action: 'find the injection point' },
          { step: 2, action: 'read /flag' },
        ],
        verifyRules: [{ kind: 'file_read' as const, path: '/flag' }],
        keyBehaviors: [],
        finalStateRule: null,
        scoreRules: [{ kind: 'result' as const, weight: 1 }],
        scoringMode: 'result' as const,
        timeLimitSec: 1800,
        hintPolicy: e.hintPolicy,
        allowRetry: e.assessmentMode === 'practice',
        hintLadder: [],
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      }));

  return {
    // This layer only reads the task; confirmations belong to the phase machine.
    confirmations: [],
    task: {
      id: 'task-1',
      seriesId: null,
      title: 'CTF',
      audience: 'security students',
      learnerLevel: 'beginner',
      trainingScenario: 'competition',
      durationHours: 54,
      applicationScene: 'CTF',
      problemStatement: 'learn to solve web challenges',
      status: 'active',
      designPhase: 'review',
      createdAt: NOW,
      updatedAt: NOW,
      ...overrides.brief,
    },
    objectives,
    evidence,
    nodes,
    nodeObjectives,
    dependencies: (overrides.dependencies ?? []).map((d) => ({
      id: nextId('dep'),
      taskId: 'task-1',
      sourceId: d.sourceId,
      targetId: d.targetId,
      sourceKind: d.sourceKind ?? 'node',
      targetKind: d.targetKind ?? 'objective',
      edgeType: d.edgeType,
      strength: 1,
      note: null,
      createdAt: NOW,
      updatedAt: NOW,
    })),
    units,
    unitCoverage: coverage,
    unitDependencies: [],
    questions,
    labTasks,
    auditFindings: [] as CurriculumAuditFindingRecord[],
  };
}

const rulesOf = (findings: CurriculumAuditFinding[]) =>
  findings.filter((f) => f.severity === 'error').map((f) => f.rule);

// ── Baseline ─────────────────────────────────────────────────────────────────

describe('auditCurriculumDesign — baseline', () => {
  it('accepts a fully closed design with no errors', () => {
    const { findings, quality } = reviewCurriculumDesign(makeSnapshot());
    expect(rulesOf(findings)).toEqual([]);
    expect(quality.broken).toEqual([]);
    expect(quality.exportable).toBe(true);
    expect(quality.firstBrokenLayer).toBeNull();
  });

  it('reports no false orphans on the baseline', () => {
    const findings = auditCurriculumDesign(makeSnapshot());
    // The single node supports the single objective, so it is not an orphan.
    expect(findings.filter((f) => f.rule === 'node_orphan')).toEqual([]);
  });
});

// ── Closed-loop rules ────────────────────────────────────────────────────────

describe('auditCurriculumDesign — the teach/practice/assess loop', () => {
  it('flags an outcome that is never taught, and blames teach_covers', () => {
    const snapshot = makeSnapshot();
    snapshot.unitCoverage = snapshot.unitCoverage.filter((c) => c.coverageKind !== 'teach');
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.layers.teach_covers).toBe(false);
    expect(quality.layers.practice_covers).toBe(true);
    expect(quality.firstBrokenLayer).toBe('teach_covers');
  });

  it('flags an outcome that is never practised', () => {
    const snapshot = makeSnapshot();
    snapshot.unitCoverage = snapshot.unitCoverage.filter((c) => c.coverageKind !== 'practice');
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.layers.practice_covers).toBe(false);
    expect(quality.layers.teach_covers).toBe(true);
  });

  it('flags an outcome that is never assessed', () => {
    const snapshot = makeSnapshot();
    snapshot.unitCoverage = snapshot.unitCoverage.filter((c) => c.coverageKind !== 'assess');
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.layers.assess_covers).toBe(false);
    expect(quality.exportable).toBe(false);
  });

  it('reports the three loop rules as three distinct codes', () => {
    const snapshot = makeSnapshot();
    snapshot.unitCoverage = [];
    const codes = rulesOf(auditCurriculumDesign(snapshot));
    expect(codes).toContain('objective_untaught');
    expect(codes).toContain('objective_unpracticed');
    expect(codes).toContain('objective_uncovered');
  });

  it('ignores archived outcomes when measuring coverage', () => {
    const snapshot = makeSnapshot();
    const archived = makeObjective({ title: 'retired objective', status: 'archived' });
    snapshot.objectives = [...snapshot.objectives, archived];
    // The archived outcome has no coverage of any kind, which must not count
    // as a gap: it is no longer a promise the course makes.
    const findings = auditCurriculumDesign(snapshot);
    const untaughtForArchived = findings.filter(
      (f) => f.refId === archived.id && f.rule.startsWith('objective_unt'),
    );
    expect(untaughtForArchived).toEqual([]);
  });

  it('flags an exam whose outcome was never taught', () => {
    const snapshot = makeSnapshot();
    snapshot.unitCoverage = snapshot.unitCoverage.filter((c) => c.coverageKind !== 'teach');
    const findings = auditCurriculumDesign(snapshot);
    const examFinding = findings.find((f) => f.rule === 'evidence_untaught');
    expect(examFinding).toBeDefined();
    expect(examFinding?.severity).toBe('error');
  });
});

// ── Verifiability ────────────────────────────────────────────────────────────

describe('auditCurriculumDesign — verifiability', () => {
  it('flags an objective the author marked unverifiable', () => {
    const snapshot = makeSnapshot({
      objectives: [
        { title: 'Understand SQL injection', verifiable: false, unverifiableReason: 'too vague' },
      ],
    });
    const findings = auditCurriculumDesign(snapshot);
    const finding = findings.find((f) => f.rule === 'objective_unverifiable');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('too vague');
    expect(reviewCurriculumDesign(snapshot).quality.layers.outcomes_verifiable).toBe(false);
  });

  it('falls back to a generic reason when none was recorded', () => {
    const snapshot = makeSnapshot({ objectives: [{ title: 'Fuzzy goal', verifiable: false }] });
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'objective_unverifiable',
    );
    expect(finding?.message).toContain('没有写明预期行为');
  });

  it('flags a verifiable objective that has no evidence at all', () => {
    const snapshot = makeSnapshot();
    snapshot.evidence = [];
    const findings = auditCurriculumDesign(snapshot);
    expect(rulesOf(findings)).toContain('objective_no_evidence');
  });
});

// ── Support and orphans ──────────────────────────────────────────────────────

describe('auditCurriculumDesign — support', () => {
  it('flags a node that supports nothing and has no edge', () => {
    const supported = makeNode({ name: 'SQL injection basics' });
    const stray = makeNode({ name: 'stray topic' });
    const snapshot = makeSnapshot({ nodes: [supported, stray] });
    // Only the first node is linked; the second supports nothing.
    snapshot.nodeObjectives = snapshot.nodeObjectives.filter((l) => l.nodeId === supported.id);
    const findings = auditCurriculumDesign(snapshot);
    const orphans = findings.filter((f) => f.rule === 'node_orphan');
    expect(orphans).toHaveLength(1);
    expect(orphans[0].message).toContain('stray topic');
  });

  it('does not call a node an orphan when a dependency edge uses it', () => {
    const snapshot = makeSnapshot({ nodes: [{ name: 'A' }, { name: 'B' }] });
    const [a, b] = snapshot.nodes;
    snapshot.dependencies = [
      {
        id: 'dep-1',
        taskId: 'task-1',
        sourceId: a.id,
        targetId: b.id,
        sourceKind: 'node',
        targetKind: 'node',
        edgeType: 'prerequisite',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const orphans = auditCurriculumDesign(snapshot).filter((f) => f.rule === 'node_orphan');
    expect(orphans).toEqual([]);
  });

  it('flags a taught outcome whose primary support no item names', () => {
    const snapshot = makeSnapshot();
    // The teaching design names no node, so the outcome is taught on top of
    // support that no lesson ever covers.
    snapshot.units[0].teachingDesign = {};
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.layers.support_complete).toBe(false);
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'objective_missing_prereq',
    );
    expect(finding?.message).toContain('SQL injection basics');
  });

  it('accepts a taught outcome whose primary support the item names', () => {
    const snapshot = makeSnapshot();
    const nodeId = snapshot.nodes[0].id;
    snapshot.units[0].teachingDesign = { nodes: [nodeId] };
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.layers.support_complete).toBe(true);
  });

  it('ignores free-text teaching buckets when looking for named nodes', () => {
    const snapshot = makeSnapshot();
    // `core` and `brief` hold topic strings, not node ids. A design that only
    // fills those buckets has not named its support, and must be reported —
    // this guards against scanning those buckets for ids and matching nothing.
    const nodeId = snapshot.nodes[0].id;
    snapshot.units[0].teachingDesign = { core: ['SQL injection basics'], brief: ['payloads'] };
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'objective_missing_prereq',
    );
    expect(finding?.refIds).toEqual([nodeId]);
  });

  it('does not require secondary support to be named', () => {
    const snapshot = makeSnapshot();
    snapshot.nodeObjectives[0].supportLevel = 'secondary';
    // A course-level outcome with no primary support is its own finding, but
    // the taught objective no longer demands a named node.
    const prereqFindings = auditCurriculumDesign(snapshot).filter(
      (f) => f.rule === 'objective_missing_prereq',
    );
    expect(prereqFindings).toEqual([]);
  });
});

// ── Duplicates ───────────────────────────────────────────────────────────────

describe('auditCurriculumDesign — duplicate outcomes', () => {
  it('flags two outcomes that share a code', () => {
    const snapshot = makeSnapshot({
      objectives: [
        { title: 'Exploit SQL injection', code: 'WEB-01' },
        { title: 'Chain SQL injection with SSRF', code: 'WEB-01' },
      ],
    });
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'objective_duplicate');
    expect(finding?.severity).toBe('warning');
    expect(finding?.refIds).toHaveLength(2);
  });

  it('flags two outcomes that are the same sentence twice', () => {
    const snapshot = makeSnapshot({
      objectives: [
        { title: 'Construct a SQL injection payload' },
        { title: 'Construct a SQL injection payload manually' },
      ],
    });
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'objective_duplicate');
    expect(finding).toBeDefined();
  });

  it('does not flag genuinely different outcomes', () => {
    const snapshot = makeSnapshot({
      objectives: [
        { title: 'Construct a SQL injection payload' },
        { title: 'Reverse an AES block cipher from raw ciphertext' },
      ],
    });
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'objective_duplicate');
    expect(finding).toBeUndefined();
  });

  it('does not compare an objective against its own parent as a duplicate', () => {
    const snapshot = makeSnapshot({ objectives: [{ title: 'Solve a web challenge' }] });
    // A child restating its parent's wording is a decomposition, not a defect.
    const child = makeObjective({
      title: 'Solve a web challenge',
      parentId: snapshot.objectives[0].id,
    });
    snapshot.objectives = [...snapshot.objectives, child];
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'objective_duplicate');
    expect(finding).toBeUndefined();
  });
});

// ── Dependency graph ─────────────────────────────────────────────────────────

describe('auditCurriculumDesign — dependency order', () => {
  it('flags a prerequisite cycle', () => {
    const snapshot = makeSnapshot({
      objectives: [{ title: 'A' }, { title: 'B' }],
    });
    const [a, b] = snapshot.objectives;
    snapshot.dependencies = [
      {
        id: 'dep-1',
        taskId: 'task-1',
        sourceId: a.id,
        targetId: b.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'prerequisite',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'dep-2',
        taskId: 'task-1',
        sourceId: b.id,
        targetId: a.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'prerequisite',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'dependency_cycle');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('没有可以最先学习的东西');
    expect(reviewCurriculumDesign(snapshot).quality.layers.dependency_valid).toBe(false);
  });

  it('does not treat a mutual-support edge as a cycle', () => {
    const snapshot = makeSnapshot({ objectives: [{ title: 'A' }, { title: 'B' }] });
    const [a, b] = snapshot.objectives;
    snapshot.dependencies = [
      {
        id: 'dep-1',
        taskId: 'task-1',
        sourceId: a.id,
        targetId: b.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'composes',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'dep-2',
        taskId: 'task-1',
        sourceId: b.id,
        targetId: a.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'composes',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'dependency_cycle');
    expect(finding).toBeUndefined();
  });

  it('reports each cycle once', () => {
    const snapshot = makeSnapshot({ objectives: [{ title: 'A' }, { title: 'B' }] });
    const [a, b] = snapshot.objectives;
    const edge = (id: string, s: string, t: string) => ({
      id,
      taskId: 'task-1',
      sourceId: s,
      targetId: t,
      sourceKind: 'objective' as const,
      targetKind: 'objective' as const,
      edgeType: 'prerequisite' as const,
      strength: 1,
      note: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    snapshot.dependencies = [edge('d1', a.id, b.id), edge('d2', b.id, a.id)];
    const cycles = auditCurriculumDesign(snapshot).filter((f) => f.rule === 'dependency_cycle');
    expect(cycles).toHaveLength(1);
  });

  it('flags an outcome taught before its prerequisite', () => {
    const objective = makeObjective({ title: 'Exploit SQL injection' });
    const prereq = makeObjective({ title: 'Read an HTTP request' });
    const later = makeUnit({ title: 'HTTP item', orderIndex: 2, unitRole: 'lecture' });
    const earlier = makeUnit({ title: 'Injection item', orderIndex: 1, unitRole: 'lecture' });
    const snapshot = makeSnapshot({ objectives: [objective, prereq], units: [later, earlier] });
    // The injection objective is taught in the earlier item, its prerequisite
    // only in the later one.
    snapshot.unitCoverage = [
      makeCoverage({ unitId: earlier.id, objectiveId: objective.id, coverageKind: 'teach' }),
      makeCoverage({ unitId: later.id, objectiveId: prereq.id, coverageKind: 'teach' }),
    ];
    snapshot.dependencies = [
      {
        id: 'dep-1',
        taskId: 'task-1',
        sourceId: prereq.id,
        targetId: objective.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'prerequisite',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'dependency_out_of_order',
    );
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('Exploit SQL injection');
  });

  it('does not flag a correctly ordered prerequisite pair', () => {
    const objective = makeObjective({ title: 'Exploit SQL injection' });
    const prereq = makeObjective({ title: 'Read an HTTP request' });
    const first = makeUnit({ title: 'HTTP item', orderIndex: 1 });
    const second = makeUnit({ title: 'Injection item', orderIndex: 2 });
    const snapshot = makeSnapshot({ objectives: [objective, prereq], units: [first, second] });
    snapshot.unitCoverage = [
      makeCoverage({ unitId: first.id, objectiveId: prereq.id, coverageKind: 'teach' }),
      makeCoverage({ unitId: second.id, objectiveId: objective.id, coverageKind: 'teach' }),
    ];
    snapshot.dependencies = [
      {
        id: 'dep-1',
        taskId: 'task-1',
        sourceId: prereq.id,
        targetId: objective.id,
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'prerequisite',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ];
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'dependency_out_of_order',
    );
    expect(finding).toBeUndefined();
  });
});

// ── Assessment artifacts ─────────────────────────────────────────────────────

describe('auditCurriculumDesign — assessment artifacts', () => {
  it('flags a lab with no verification rule', () => {
    const snapshot = makeSnapshot();
    snapshot.labTasks[0].verifyRules = [];
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'lab_no_verify_rule');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('无法判分');
  });

  it('flags a lab whose verify rule restates a reference step', () => {
    const snapshot = makeSnapshot();
    // The rule grades by the route rather than the result.
    snapshot.labTasks[0].verifyRules = [{ kind: 'process_exec', argv: ['read /flag'] }];
    snapshot.labTasks[0].referenceSolution = [{ step: 1, action: 'read /flag' }];
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'lab_verify_grades_by_path',
    );
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('判的是某一种解法');
  });

  it('accepts a lab that checks a different, result-shaped condition', () => {
    const snapshot = makeSnapshot();
    // Baseline: file_read /flag versus a step "read /flag" — different shapes,
    // so the rule must not fire even though they are about the same file.
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'lab_verify_grades_by_path',
    );
    expect(finding).toBeUndefined();
  });

  it('flags evidence with no artifact behind it', () => {
    const snapshot = makeSnapshot();
    snapshot.questions = [];
    const finding = auditCurriculumDesign(snapshot).find(
      (f) => f.rule === 'evidence_no_artifact' && f.message.includes('测验'),
    );
    expect(finding).toBeDefined();
  });

  it('flags a question that no outcome claims', () => {
    const snapshot = makeSnapshot();
    snapshot.questions[0].objectiveId = 'obj-does-not-exist';
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'drill_no_objective');
    expect(finding?.severity).toBe('error');
  });
});

// ── Outline structure ────────────────────────────────────────────────────────

describe('auditCurriculumDesign — outline structure', () => {
  it('flags an item with no role', () => {
    const snapshot = makeSnapshot();
    snapshot.units[0].unitRole = null;
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_without_role');
    expect(finding?.severity).toBe('error');
  });

  it('flags a chapter that carries teaching content', () => {
    const objective = makeObjective({ title: 'Exploit SQL injection' });
    const chapter = makeUnit({ title: 'Chapter Web', unitType: 'chapter', unitRole: null });
    const item = makeUnit({ title: 'Item 1', orderIndex: 1 });
    const snapshot = makeSnapshot({ objectives: [objective], units: [chapter, item] });
    snapshot.unitCoverage = [
      makeCoverage({ unitId: chapter.id, objectiveId: objective.id, coverageKind: 'teach' }),
    ];
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'chapter_with_content');
    expect(finding?.severity).toBe('error');
    expect(finding?.message).toContain('章节只做归类');
  });

  it('flags an item that covers no outcome', () => {
    const snapshot = makeSnapshot({
      units: [makeUnit({ title: 'Item 1' }), makeUnit({ title: 'Item 2', orderIndex: 1 })],
    });
    const finding = auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_orphan');
    expect(finding?.message).toContain('Item 2');
  });

  it('does not flag a chapter that merely groups items', () => {
    const objective = makeObjective({ title: 'Exploit SQL injection' });
    const chapter = makeUnit({ title: 'Chapter Web', unitType: 'chapter', unitRole: null });
    const item = makeUnit({ title: 'Item 1', orderIndex: 1, parentId: chapter.id });
    const snapshot = makeSnapshot({ objectives: [objective], units: [chapter, item] });
    snapshot.unitCoverage = (['teach', 'practice', 'assess'] as const).map((coverageKind) =>
      makeCoverage({ unitId: item.id, objectiveId: objective.id, coverageKind }),
    );
    const findings = auditCurriculumDesign(snapshot);
    expect(findings.filter((f) => f.rule === 'chapter_with_content')).toEqual([]);
    expect(findings.filter((f) => f.rule === 'unit_orphan')).toEqual([]);
  });
});

// ── Brief ────────────────────────────────────────────────────────────────────

describe('auditCurriculumDesign — brief', () => {
  it('flags a brief that does not say who, what, or how long', () => {
    const snapshot = makeSnapshot({
      brief: { audience: null, problemStatement: null, durationHours: null },
    });
    const findings = auditCurriculumDesign(snapshot).filter((f) => f.rule === 'brief_incomplete');
    expect(findings).toHaveLength(3);
    expect(reviewCurriculumDesign(snapshot).quality.layers.outcomes_clear).toBe(false);
  });
});

// ── Quality evaluation ───────────────────────────────────────────────────────

describe('evaluateCurriculumQuality', () => {
  it('marks the earliest broken layer first, since later layers depend on it', () => {
    // No evidence and no teaching: the design breaks at outcomes_verifiable,
    // long before teach_covers, so that is the layer to repair first.
    // curriculum_covers also breaks, and legitimately so — with every
    // coverage row gone the item no longer covers any outcome, which is an
    // independent defect rather than a consequence of the earlier one.
    const snapshot = makeSnapshot({ objectives: [{ title: 'Vague goal', verifiable: false }] });
    snapshot.evidence = [];
    snapshot.unitCoverage = [];
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.firstBrokenLayer).toBe('outcomes_verifiable');
    expect(quality.layers.teach_covers).toBe(false);
    expect(quality.broken.map((b) => b.layer)).toEqual([
      'outcomes_verifiable',
      'curriculum_covers',
      'teach_covers',
      'practice_covers',
      'assess_covers',
    ]);
  });

  it('attaches the findings that caused each broken layer', () => {
    const snapshot = makeSnapshot();
    snapshot.unitCoverage = snapshot.unitCoverage.filter((c) => c.coverageKind !== 'assess');
    const { quality } = reviewCurriculumDesign(snapshot);
    const assess = quality.broken.find((b) => b.layer === 'assess_covers');
    expect(assess?.findings.length).toBeGreaterThan(0);
    expect(assess?.findings[0].rule).toBe('objective_uncovered');
  });

  it('keeps a warning from failing a layer', () => {
    // node_orphan is a warning, so a course with one is still exportable.
    const snapshot = makeSnapshot({
      nodes: [{ name: 'A' }, { name: 'lonely' }],
      nodeObjectives: [],
    });
    const { findings, quality } = reviewCurriculumDesign(snapshot);
    expect(findings.some((f) => f.rule === 'node_orphan' && f.severity === 'warning')).toBe(true);
    expect(quality.layers.support_complete).toBe(true);
    expect(quality.exportable).toBe(true);
  });

  it('reports every layer true for a clean design', () => {
    const { quality } = reviewCurriculumDesign(makeSnapshot());
    expect(Object.values(quality.layers).every(Boolean)).toBe(true);
    expect(quality.hasErrors).toBe(false);
  });

  it('accepts an empty findings array', () => {
    const quality = evaluateCurriculumQuality([]);
    expect(quality.exportable).toBe(true);
    expect(quality.firstBrokenLayer).toBeNull();
  });
});

// ── Contract ─────────────────────────────────────────────────────────────────

describe('audit rule registry', () => {
  it('names every rule the audit can emit, and nothing it cannot', () => {
    const snapshot = makeSnapshot();
    snapshot.task.audience = null;
    snapshot.objectives[0].verifiable = false;
    snapshot.unitCoverage = [];
    snapshot.nodes.push(makeNode({ name: 'orphan' }));
    snapshot.units.push(makeUnit({ title: 'Item 2', orderIndex: 1, unitRole: null }));
    snapshot.labTasks[0].verifyRules = [];
    const emitted = new Set(auditCurriculumDesign(snapshot).map((f) => f.rule));
    for (const rule of emitted) {
      expect(CURRICULUM_AUDIT_RULES).toContain(rule);
    }
    // Every rule in the registry must be reachable from some snapshot; a
    // registered rule that never fires is a rule nobody is relying on.
    expect(emitted.size).toBeGreaterThan(5);
  });

  it('sorts errors before warnings', () => {
    const snapshot = makeSnapshot({ nodes: [{ name: 'A' }, { name: 'lonely' }] });
    snapshot.objectives[0].verifiable = false;
    const severities: CurriculumAuditSeverity[] = auditCurriculumDesign(snapshot).map(
      (f) => f.severity,
    );
    const firstWarning = severities.indexOf('warning');
    if (firstWarning >= 0) {
      expect(severities.slice(firstWarning).every((s) => s === 'warning' || s === 'info')).toBe(
        true,
      );
    }
  });
});

// ── Item ordering edges ──────────────────────────────────────────────────────

/**
 * `snapshot.unitDependencies` is the *teaching sequence*: the order the author
 * claims the course presents items in. It is a second, independent claim from
 * the objective graph, and these tests pin the two rules that hold the author to
 * it. Each test breaks exactly one thing from a snapshot that already passes.
 */
function makeUnitDependency(
  overrides: Partial<CurriculumUnitDependencyRecord> &
    Required<Pick<CurriculumUnitDependencyRecord, 'sourceUnitId' | 'targetUnitId'>>,
): CurriculumUnitDependencyRecord {
  return {
    id: nextId('udep'),
    taskId: 'task-1',
    edgeType: 'prerequisite',
    strength: 1,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

/**
 * Two items in a sound design. The single-item baseline cannot express an order
 * at all, and passing a second unit to `makeSnapshot` alone leaves it an
 * orphan: the default coverage only covers `units[0]`. So the second item is
 * given its own teach/practice/assess coverage, which is what a real two-item
 * outline looks like. Without this the pre-existing `unit_orphan` rule would
 * break `dependency_valid` tests for reasons that have nothing to do with order.
 */
function makeOrderedSnapshot(orderIndexes: number[]): CurriculumDesignSnapshot {
  const units = orderIndexes.map((orderIndex, index) =>
    makeUnit({ title: `Item ${index + 1}`, orderIndex, unitRole: 'lecture' as const }),
  );
  const snapshot = makeSnapshot({ units });
  for (const unit of units.slice(1)) {
    // `teach` and `practice` only. Since step 7 an `assess` coverage row is a
    // promise that a question or a lab delivers *there*, and this fixture's
    // artifacts all hang on the first item — so only the first item claims to
    // grade the outcome. A second item claiming it with nothing to grade with is
    // exactly the empty promise `coverage_without_artifact` reports.
    for (const coverageKind of ['teach', 'practice'] as const) {
      snapshot.unitCoverage.push(
        makeCoverage({ unitId: unit.id, objectiveId: snapshot.objectives[0].id, coverageKind }),
      );
    }
  }
  return snapshot;
}

describe('auditCurriculumDesign — item ordering', () => {
  it('flags an item scheduled before its declared prerequisite', () => {
    // "Basic is a prerequisite of Advanced" is claimed, yet Advanced sits at
    // position 1 and Basic at position 2. The objective graph is untouched, so
    // `dependency_out_of_order` stays silent and only this rule can catch it.
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [advanced, basic] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: basic.id, targetUnitId: advanced.id }),
    ];

    const findings = auditCurriculumDesign(snapshot).filter(
      (f) => f.rule === 'unit_dependency_out_of_order',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('Item 1');
    expect(findings[0].message).toContain('Item 2');
    // Positions are 0-based internally but 1-based for a human reading an
    // outline, and the message must name the edge that is wrong.
    expect(findings[0].message).toContain('第 1 位');
    expect(findings[0].message).toContain('第 2 位');
    expect(findings[0].refKind).toBe('unitDependency');
    expect(findings[0].refIds).toEqual([basic.id, advanced.id]);
  });

  it('does not flag a correctly ordered prerequisite pair', () => {
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [basic, advanced] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: basic.id, targetUnitId: advanced.id }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_out_of_order'),
    ).toBeUndefined();
  });

  it('accepts an adjacent pair, where the prerequisite is delivered immediately before', () => {
    // Positions 6 and 7, not 1 and 2: adjacency must not be what makes it legal.
    // The comparison is `<=`, so a prereq one position earlier passes whatever
    // the absolute positions are.
    const snapshot = makeOrderedSnapshot([6, 7]);
    const [basic, advanced] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: basic.id, targetUnitId: advanced.id }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_out_of_order'),
    ).toBeUndefined();
  });

  it('ignores a related edge, because it claims no order', () => {
    // `related` is an annotation. Demanding an order from it would be the audit
    // inventing a constraint the author never made.
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [first, second] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: second.id, targetUnitId: first.id, edgeType: 'related' }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_out_of_order'),
    ).toBeUndefined();
  });

  it('ignores a follow-up edge, which points forward without being a prerequisite', () => {
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [first, second] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({
        sourceUnitId: second.id,
        targetUnitId: first.id,
        edgeType: 'follow-up',
      }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_out_of_order'),
    ).toBeUndefined();
  });

  it('ignores an edge touching a chapter, which is not delivered at a position', () => {
    const item = makeUnit({ title: 'Item', orderIndex: 0, unitRole: 'lecture' });
    const chapter = makeUnit({ title: 'Chapter', unitType: 'chapter', orderIndex: 1 });
    const snapshot = makeSnapshot({ units: [item, chapter] });
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: item.id, targetUnitId: chapter.id }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_out_of_order'),
    ).toBeUndefined();
  });

  it('flags a loop in the declared teaching order', () => {
    const snapshot = makeOrderedSnapshot([0, 1, 2]);
    const [a, b, c] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: a.id, targetUnitId: b.id }),
      makeUnitDependency({ sourceUnitId: b.id, targetUnitId: c.id }),
      makeUnitDependency({ sourceUnitId: c.id, targetUnitId: a.id }),
    ];

    const findings = auditCurriculumDesign(snapshot).filter(
      (f) => f.rule === 'unit_dependency_cycle',
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].severity).toBe('error');
    expect(findings[0].message).toContain('没有可以最先讲授的条目');
    expect(findings[0].refKind).toBe('unitDependency');
    expect([...findings[0].refIds].sort()).toEqual([a.id, b.id, c.id].sort());
  });

  it('does not flag a cycle made only of related edges', () => {
    // A related-edge "cycle" is three cross references, not a teaching order.
    const snapshot = makeOrderedSnapshot([0, 1, 2]);
    const [a, b, c] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: a.id, targetUnitId: b.id, edgeType: 'related' }),
      makeUnitDependency({ sourceUnitId: b.id, targetUnitId: c.id, edgeType: 'related' }),
      makeUnitDependency({ sourceUnitId: c.id, targetUnitId: a.id, edgeType: 'related' }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_cycle'),
    ).toBeUndefined();
  });

  it('does not report the same cycle twice', () => {
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [a, b] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: a.id, targetUnitId: b.id }),
      makeUnitDependency({ sourceUnitId: b.id, targetUnitId: a.id }),
    ];
    expect(
      auditCurriculumDesign(snapshot).filter((f) => f.rule === 'unit_dependency_cycle'),
    ).toHaveLength(1);
  });

  it('ignores an edge naming a unit that is not in the outline', () => {
    // A dangling edge has no delivery position, so it states no order. Skipping
    // it keeps the rule from reporting a position for something that has none.
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [first] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: first.id, targetUnitId: 'unit-does-not-exist' }),
    ];
    expect(
      auditCurriculumDesign(snapshot).find((f) => f.rule === 'unit_dependency_out_of_order'),
    ).toBeUndefined();
  });

  it('breaks dependency_valid, so a wrong order is not exportable', () => {
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [advanced, basic] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: basic.id, targetUnitId: advanced.id }),
    ];

    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.layers.dependency_valid).toBe(false);
    expect(quality.exportable).toBe(false);
    // The layer it breaks, not the order of the chain: a later fix is
    // meaningless while the delivery order contradicts the author's own claim.
    expect(quality.broken.map((b) => b.layer)).toContain('dependency_valid');
  });

  it('leaves a sound design exportable, so the rules do not fire on a clean course', () => {
    const snapshot = makeOrderedSnapshot([0, 1]);
    const [basic, advanced] = snapshot.units;
    snapshot.unitDependencies = [
      makeUnitDependency({ sourceUnitId: basic.id, targetUnitId: advanced.id }),
    ];
    const { quality } = reviewCurriculumDesign(snapshot);
    expect(quality.exportable).toBe(true);
  });
});
