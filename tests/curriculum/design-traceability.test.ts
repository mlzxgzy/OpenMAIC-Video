import { describe, expect, it } from 'vitest';

import {
  buildTraceabilityMatrix,
  traceFromObjective,
  traceFromUnit,
  type CoverageKind,
} from '@/lib/curriculum/traceability';
import type {
  CurriculumDesignSnapshot,
  CurriculumLearningNodeRecord,
  CurriculumObjectiveRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

const NOW = '2026-01-01T00:00:00.000Z';

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(seq += 1)}`;

function makeObjective(id: string, title: string): CurriculumObjectiveRecord {
  return {
    id,
    taskId: 'task-1',
    parentId: null,
    code: null,
    title,
    description: null,
    objectiveType: 'skill',
    bloomLevel: null,
    level: 'component',
    expectedBehavior: `the learner can ${title.toLowerCase()}`,
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
  };
}

function makeNode(id: string, name: string): CurriculumLearningNodeRecord {
  return {
    id,
    taskId: 'task-1',
    parentId: null,
    code: null,
    name,
    nodeType: 'skill',
    summary: null,
    difficulty: null,
    sortOrder: 0,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeUnit(
  id: string,
  title: string,
  orderIndex: number,
  role: 'lecture' | 'practice' | 'exam',
): CurriculumUnitRecord {
  return {
    id,
    taskId: 'task-1',
    parentId: null,
    unitType: 'item',
    title,
    code: null,
    unitRole: role,
    hours: 1,
    orderIndex,
    teachingDesign: {},
    deckDesign: {},
    stageId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeCoverage(
  unitId: string,
  objectiveId: string,
  coverageKind: CoverageKind,
  depth: 'brief' | 'standard' | 'deep' = 'standard',
): CurriculumUnitCoverageRecord {
  return {
    id: nextId('cov'),
    taskId: 'task-1',
    unitId,
    objectiveId,
    coverageKind,
    depth,
    orderIndex: 0,
    note: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function makeSnapshot(): CurriculumDesignSnapshot {
  const http = makeObjective('obj-http', 'Read an HTTP request');
  const injection = makeObjective('obj-inj', 'Exploit SQL injection');
  const nodeA = makeNode('node-http', 'HTTP basics');
  const nodeB = makeNode('node-sql', 'SQL injection basics');
  const lecture = makeUnit('unit-1', 'HTTP and injection', 1, 'lecture');
  const practice = makeUnit('unit-2', 'Injection practice', 2, 'practice');
  const exam = makeUnit('unit-3', 'Injection exam', 3, 'exam');

  return {
    confirmations: [],
    seriesDirection: null,
    task: {
      id: 'task-1',
      seriesId: null,
      sectionId: null,
      code: null,
      kind: null,
      orderIndex: 0,
      title: 'CTF',
      audience: 'students',
      learnerLevel: 'beginner',
      trainingScenario: null,
      durationHours: 54,
      applicationScene: null,
      problemStatement: 'solve web challenges',
      status: 'active',
      designPhase: 'review',
      createdAt: NOW,
      updatedAt: NOW,
    },
    objectives: [http, injection],
    evidence: [
      {
        id: 'ev-practice',
        taskId: 'task-1',
        objectiveId: 'obj-inj',
        evidenceType: 'lab',
        verificationMethod: 'flag',
        successCondition: '/flag read',
        conditionExpression: null,
        auxiliaryCondition: null,
        assessmentMode: 'practice',
        thresholdPass: 60,
        thresholdProficient: 80,
        thresholdExcellent: 95,
        timeLimitSec: null,
        hintPolicy: 'unlimited',
        independent: false,
        processRecord: false,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'ev-exam',
        taskId: 'task-1',
        objectiveId: 'obj-inj',
        evidenceType: 'lab',
        verificationMethod: 'flag',
        successCondition: '/flag read',
        conditionExpression: null,
        auxiliaryCondition: null,
        assessmentMode: 'exam',
        thresholdPass: 60,
        thresholdProficient: 80,
        thresholdExcellent: 95,
        timeLimitSec: 1800,
        hintPolicy: 'forbidden',
        independent: true,
        processRecord: true,
        sortOrder: 1,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    nodes: [nodeA, nodeB],
    nodeObjectives: [
      {
        id: 'no-1',
        taskId: 'task-1',
        nodeId: 'node-sql',
        objectiveId: 'obj-inj',
        supportLevel: 'primary',
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'no-2',
        taskId: 'task-1',
        nodeId: 'node-http',
        objectiveId: 'obj-inj',
        supportLevel: 'secondary',
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
      {
        id: 'no-3',
        taskId: 'task-1',
        nodeId: 'node-http',
        objectiveId: 'obj-http',
        supportLevel: 'primary',
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    dependencies: [
      {
        id: 'dep-1',
        taskId: 'task-1',
        sourceId: 'obj-http',
        targetId: 'obj-inj',
        sourceKind: 'objective',
        targetKind: 'objective',
        edgeType: 'prerequisite',
        strength: 1,
        note: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    units: [lecture, practice, exam],
    unitCoverage: [
      makeCoverage('unit-1', 'obj-http', 'teach'),
      makeCoverage('unit-1', 'obj-inj', 'teach'),
      makeCoverage('unit-2', 'obj-inj', 'practice'),
      makeCoverage('unit-3', 'obj-inj', 'assess'),
    ],
    unitDependencies: [],
    questions: [
      {
        id: 'q-1',
        taskId: 'task-1',
        unitId: 'unit-2',
        objectiveId: 'obj-inj',
        evidenceId: null,
        questionType: 'single',
        stem: 'Which parameter is injectable?',
        options: [{ key: 'A', text: 'id' }],
        answer: ['A'],
        explanation: 'id is concatenated',
        distractors: [],
        difficulty: 'basic',
        bloomLevel: null,
        score: 5,
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    labTasks: [
      {
        id: 'lab-1',
        taskId: 'task-1',
        unitId: 'unit-3',
        objectiveId: 'obj-inj',
        evidenceId: 'ev-exam',
        assessmentMode: 'exam',
        taskGoal: 'Read the flag',
        brief: 'vulnerable service',
        expectedResult: null,
        dockerImage: 'ctf/sql',
        containerConfig: {},
        initState: {},
        resetPolicy: 'on-start',
        referenceSolution: null,
        verifyRules: [{ kind: 'file_read', path: '/flag' }],
        keyBehaviors: [],
        finalStateRule: null,
        scoreRules: [],
        scoringMode: 'result',
        timeLimitSec: null,
        hintPolicy: 'forbidden',
        allowRetry: false,
        hintLadder: [],
        sortOrder: 0,
        createdAt: NOW,
        updatedAt: NOW,
      },
    ],
    auditFindings: [],
  };
}

// ── Outcome → course ─────────────────────────────────────────────────────────

describe('traceFromObjective', () => {
  it('returns null for an unknown outcome', () => {
    expect(traceFromObjective(makeSnapshot(), 'obj-missing')).toBeNull();
  });

  it('lists the supporting nodes with primary before secondary', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-inj');
    expect(trace?.supportNodes.map((n) => n.nodeId)).toEqual(['node-sql', 'node-http']);
    expect(trace?.supportNodes[0].supportLevel).toBe('primary');
  });

  it('lists the prerequisite outcomes', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-inj');
    expect(trace?.prerequisiteObjectiveIds).toEqual(['obj-http']);
  });

  it('lists an outcome with no prerequisite as having none', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-http');
    expect(trace?.prerequisiteObjectiveIds).toEqual([]);
  });

  it('orders the units it reaches by their position in the outline', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-inj');
    expect(trace?.units.map((u) => u.unit.id)).toEqual(['unit-1', 'unit-2', 'unit-3']);
    expect(trace?.units.map((u) => u.kind)).toEqual(['teach', 'practice', 'assess']);
  });

  it('reports the three coverage booleans', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-inj');
    expect(trace?.coverage).toEqual({ teach: true, practice: true, assess: true });
  });

  it('reports a partially covered outcome honestly', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-http');
    expect(trace?.coverage).toEqual({ teach: true, practice: false, assess: false });
  });

  it('pairs each evidence with the artifacts behind it and the unit that runs it', () => {
    const trace = traceFromObjective(makeSnapshot(), 'obj-inj');
    const practiceEvidence = trace?.evidence.find((e) => e.evidenceId === 'ev-practice');
    const examEvidence = trace?.evidence.find((e) => e.evidenceId === 'ev-exam');
    // Practice has no lab task bound to it, but the question carries the drill.
    expect(practiceEvidence?.questionIds).toEqual(['q-1']);
    expect(practiceEvidence?.unitIds).toEqual(['unit-2']);
    // The exam has a lab task and runs in the exam item.
    expect(examEvidence?.labTaskIds).toEqual(['lab-1']);
    expect(examEvidence?.unitIds).toEqual(['unit-3']);
  });

  it('carries the verifiable flag through', () => {
    const snapshot = makeSnapshot();
    snapshot.objectives[1].verifiable = false;
    expect(traceFromObjective(snapshot, 'obj-inj')?.verifiable).toBe(false);
  });
});

// ── Course → outcome ─────────────────────────────────────────────────────────

describe('traceFromUnit', () => {
  it('returns null for an unknown item', () => {
    expect(traceFromUnit(makeSnapshot(), 'unit-missing')).toBeNull();
  });

  it('splits the outcomes an item touches by what it does with them', () => {
    const trace = traceFromUnit(makeSnapshot(), 'unit-1');
    expect(trace?.coverage).toEqual({
      teach: ['obj-http', 'obj-inj'],
      practice: [],
      assess: [],
    });
  });

  it('surfaces the prerequisite outcomes of everything the item covers', () => {
    // The lecture teaches obj-inj, whose prerequisite is obj-http; it also
    // teaches obj-http directly. Both are prerequisites of something here.
    const trace = traceFromUnit(makeSnapshot(), 'unit-1');
    expect(trace?.prerequisiteObjectiveIds).toContain('obj-http');
  });

  it('lists the questions and labs attached to the item', () => {
    expect(traceFromUnit(makeSnapshot(), 'unit-2')?.questionIds).toEqual(['q-1']);
    expect(traceFromUnit(makeSnapshot(), 'unit-3')?.labTaskIds).toEqual(['lab-1']);
    expect(traceFromUnit(makeSnapshot(), 'unit-1')?.questionIds).toEqual([]);
  });

  it('collects the nodes the teaching design names, de-duplicated', () => {
    const snapshot = makeSnapshot();
    snapshot.units[0].teachingDesign = {
      nodes: ['node-http'],
      prerequisites: ['node-http', 'node-sql'],
      core: ['node-xss'],
    };
    const trace = traceFromUnit(snapshot, 'unit-1');
    // The depth buckets are id lists too. `nodes` is the union the rules layer
    // derives from them, but the workbench editor writes a single bucket on its
    // own — so reading only `nodes` would miss "this item teaches X in full"
    // typed by hand, which is exactly the claim this trace exists to carry.
    expect(trace?.teachingNodeIds).toEqual(['node-http', 'node-xss', 'node-sql']);
  });
});

// ── Matrix ───────────────────────────────────────────────────────────────────

describe('buildTraceabilityMatrix', () => {
  it('uses items as columns, not chapters', () => {
    const snapshot = makeSnapshot();
    snapshot.units.push({
      ...makeUnit('unit-0', 'Chapter Web', 0, 'lecture'),
      unitType: 'chapter',
      unitRole: null,
    });
    expect(buildTraceabilityMatrix(snapshot).unitIds).toEqual(['unit-1', 'unit-2', 'unit-3']);
  });

  it('orders columns by their position in the outline', () => {
    const snapshot = makeSnapshot();
    const [a, , c] = snapshot.units;
    a.orderIndex = 5;
    c.orderIndex = 1;
    const { unitIds, rows } = buildTraceabilityMatrix(snapshot);
    expect(unitIds[0]).toBe('unit-3');
    expect(rows.find((r) => r.objectiveId === 'obj-inj')?.assess).toEqual(['unit-3']);
  });

  it('marks an outcome complete only when teach, practice and assess are all present', () => {
    const { rows } = buildTraceabilityMatrix(makeSnapshot());
    expect(rows.find((r) => r.objectiveId === 'obj-inj')?.complete).toBe(true);
    expect(rows.find((r) => r.objectiveId === 'obj-http')?.complete).toBe(false);
  });

  it('excludes archived outcomes from the matrix', () => {
    const snapshot = makeSnapshot();
    snapshot.objectives[0].status = 'archived';
    const { rows } = buildTraceabilityMatrix(snapshot);
    expect(rows.map((r) => r.objectiveId)).toEqual(['obj-inj']);
  });

  it('reports a row with no coverage rather than omitting the outcome', () => {
    const snapshot = makeSnapshot();
    const orphan = makeObjective('obj-orphan', 'Do something never covered');
    snapshot.objectives = [...snapshot.objectives, orphan];
    const { rows } = buildTraceabilityMatrix(snapshot);
    const row = rows.find((r) => r.objectiveId === 'obj-orphan');
    expect(row).toBeDefined();
    expect(row?.complete).toBe(false);
    expect(row?.teach).toEqual([]);
  });
});
