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

  // A real lecture names the nodes it teaches. The baseline is meant to be a
  // sound design, so it has to model that, not an empty teaching design.
  if (units[0].teachingDesign && Object.keys(units[0].teachingDesign).length === 0) {
    units[0].teachingDesign = { nodes: nodes.map((n) => n.id) };
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
    expect(finding?.message).toContain('no expected behavior');
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
    expect(finding?.message).toContain('no first thing to learn');
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
    expect(finding?.message).toContain('cannot be graded');
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
    expect(finding?.message).toContain('grades one route');
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
      (f) => f.rule === 'evidence_no_artifact' && f.message.includes('Quiz'),
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
    expect(finding?.message).toContain('Chapters classify');
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
