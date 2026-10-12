/**
 * Traceability — answering "what does this prove?" in both directions.
 *
 * A course design is only auditable if every artifact can name the outcome it
 * serves, and every outcome can name the artifacts that serve it. The first
 * direction is what a reviewer asks ("why is this question here?"); the second
 * is what the learner record needs ("did this person learn it?"). Both are
 * answered here from one snapshot, with no queries, so the UI, the audit, and
 * a test all agree.
 *
 * The two views in the workspace are the two functions below:
 * {@link traceFromObjective} answers "from outcome to course" and
 * {@link traceFromUnit} answers "from course to outcome".
 */

import type {
  CurriculumDesignSnapshot,
  CurriculumObjectiveRecord,
  CurriculumUnitRecord,
} from './design-types';

export type CoverageKind = 'teach' | 'practice' | 'assess';

export interface TracedUnit {
  unit: CurriculumUnitRecord;
  kind: CoverageKind;
  depth: string;
}

export interface TracedEvidence {
  evidenceId: string;
  assessmentMode: 'practice' | 'exam';
  evidenceType: string;
  unitIds: string[];
  questionIds: string[];
  labTaskIds: string[];
}

export interface TracedNode {
  nodeId: string;
  name: string;
  supportLevel: 'primary' | 'secondary';
}

/** Everything one outcome leads to, in the order a reviewer walks it. */
export interface ObjectiveTrace {
  objective: CurriculumObjectiveRecord;
  /** The prerequisite objectives this one depends on, transitively direct only. */
  prerequisiteObjectiveIds: string[];
  /** Knowledge and skills that support it, primary first. */
  supportNodes: TracedNode[];
  /** Items that teach / practise / assess it. */
  units: TracedUnit[];
  /** The evidence that proves it, and the artifacts backing that evidence. */
  evidence: TracedEvidence[];
  /** Whether the outcome's own `verifiable` flag is set. */
  verifiable: boolean;
  /** The three coverage booleans, for the heat matrix. */
  coverage: Record<CoverageKind, boolean>;
}

const unitById = (snapshot: CurriculumDesignSnapshot) =>
  new Map(snapshot.units.map((unit) => [unit.id, unit]));

/**
 * Outcome → course. This is the view that answers "given what the learner must
 * be able to do, what has the course actually put in front of them, and how
 * will it be checked?"
 */
export function traceFromObjective(
  snapshot: CurriculumDesignSnapshot,
  objectiveId: string,
): ObjectiveTrace | null {
  const objective = snapshot.objectives.find((o) => o.id === objectiveId);
  if (!objective) return null;

  const prereqs = snapshot.dependencies
    .filter(
      (edge) =>
        edge.targetId === objectiveId &&
        edge.targetKind === 'objective' &&
        edge.edgeType === 'prerequisite',
    )
    .map((edge) => edge.sourceId);

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const supportNodes: TracedNode[] = [];
  for (const link of snapshot.nodeObjectives) {
    if (link.objectiveId !== objectiveId) continue;
    const node = nodeById.get(link.nodeId);
    if (!node) continue;
    supportNodes.push({ nodeId: node.id, name: node.name, supportLevel: link.supportLevel });
  }
  supportNodes.sort((a, b) => {
    if (a.supportLevel !== b.supportLevel) return a.supportLevel === 'primary' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const coverage = snapshot.unitCoverage.filter((c) => c.objectiveId === objectiveId);
  const unitsById = unitById(snapshot);
  const units: TracedUnit[] = coverage
    .map((c) => ({ coverage: c, unit: unitsById.get(c.unitId) }))
    .filter(
      (entry): entry is { coverage: (typeof coverage)[number]; unit: CurriculumUnitRecord } =>
        entry.unit !== undefined,
    )
    .map(({ coverage: c, unit }) => ({
      unit,
      kind: c.coverageKind,
      depth: c.depth,
    }))
    .sort((a, b) => a.unit.orderIndex - b.unit.orderIndex);

  const coverageMap: Record<CoverageKind, boolean> = {
    teach: coverage.some((c) => c.coverageKind === 'teach'),
    practice: coverage.some((c) => c.coverageKind === 'practice'),
    assess: coverage.some((c) => c.coverageKind === 'assess'),
  };

  const evidence: TracedEvidence[] = snapshot.evidence
    .filter((e) => e.objectiveId === objectiveId)
    .map((e) => {
      // An artifact may point at its evidence explicitly, or only at the
      // objective. Accepting the second is what lets a course be drafted with
      // questions before the evidence row is written; the audit reports the
      // remaining gap either way.
      const questionIds = snapshot.questions
        .filter(
          (q) => q.evidenceId === e.id || (q.evidenceId === null && q.objectiveId === objectiveId),
        )
        .map((q) => q.id);
      const labTaskIds = snapshot.labTasks
        .filter(
          (lab) =>
            lab.evidenceId === e.id || (lab.evidenceId === null && lab.objectiveId === objectiveId),
        )
        .map((lab) => lab.id);
      const unitIds = units
        .filter((entry) => entry.kind === coverageKindForAssessment(e.assessmentMode))
        .map((entry) => entry.unit.id);
      return {
        evidenceId: e.id,
        assessmentMode: e.assessmentMode,
        evidenceType: e.evidenceType,
        unitIds,
        questionIds,
        labTaskIds,
      };
    });

  return {
    objective,
    prerequisiteObjectiveIds: prereqs,
    supportNodes,
    units,
    evidence,
    verifiable: objective.verifiable,
    coverage: coverageMap,
  };
}

/** Practice evidence is expected under `practice` coverage, exam under `assess`. */
function coverageKindForAssessment(mode: 'practice' | 'exam'): CoverageKind {
  return mode === 'exam' ? 'assess' : 'practice';
}

export interface UnitTrace {
  unit: CurriculumUnitRecord;
  /** The outcomes this unit touches, split by what it does with them. */
  coverage: Record<CoverageKind, string[]>;
  /** For each covered objective, its prerequisite outcomes — the "why now". */
  prerequisiteObjectiveIds: string[];
  /** The knowledge and skills the item's teaching design names. */
  teachingNodeIds: string[];
  /** The questions and labs attached to this item. */
  questionIds: string[];
  labTaskIds: string[];
}

/**
 * Course → outcome. This is the view a teacher uses: "I am building this item,
 * which outcomes does it serve, and have I already taught what it depends on?"
 */
export function traceFromUnit(
  snapshot: CurriculumDesignSnapshot,
  unitId: string,
): UnitTrace | null {
  const unit = unitById(snapshot).get(unitId);
  if (!unit) return null;

  const coverage: Record<CoverageKind, string[]> = { teach: [], practice: [], assess: [] };
  for (const c of snapshot.unitCoverage) {
    if (c.unitId !== unitId) continue;
    coverage[c.coverageKind].push(c.objectiveId);
  }

  const prereqIds = new Set<string>();
  for (const edge of snapshot.dependencies) {
    if (edge.targetKind !== 'objective') continue;
    for (const objectiveId of [...coverage.teach, ...coverage.practice, ...coverage.assess]) {
      if (edge.targetId === objectiveId && edge.edgeType === 'prerequisite') {
        prereqIds.add(edge.sourceId);
      }
    }
  }

  // All of these are id lists, and they are read together rather than through
  // `nodes` alone: the workbench editor writes a single bucket, so an item
  // hand-edited to "teach in full" would otherwise not appear in the trace of
  // what this item teaches.
  const design = unit.teachingDesign;
  const teachingNodeIds = [
    ...new Set([
      ...(design.nodes ?? []),
      ...(design.core ?? []),
      ...(design.brief ?? []),
      ...(design.mention ?? []),
      ...(design.prerequisites ?? []),
    ]),
  ];

  return {
    unit,
    coverage,
    prerequisiteObjectiveIds: [...prereqIds],
    teachingNodeIds,
    questionIds: snapshot.questions.filter((q) => q.unitId === unitId).map((q) => q.id),
    labTaskIds: snapshot.labTasks.filter((lab) => lab.unitId === unitId).map((lab) => lab.id),
  };
}

/**
 * The heat matrix: outcome (row) × item (column) with a cell for each
 * coverage kind. This is the "target → course" grid the workspace shows, and
 * it is the shape a coverage report should take — one row per outcome, not one
 * row per knowledge point.
 */
export interface TraceabilityRow {
  objectiveId: string;
  title: string;
  teach: string[];
  practice: string[];
  assess: string[];
  /** True when teach, practice and assess are all present. */
  complete: boolean;
}

export function buildTraceabilityMatrix(snapshot: CurriculumDesignSnapshot): {
  unitIds: string[];
  rows: TraceabilityRow[];
} {
  const items = snapshot.units
    .filter((unit) => unit.unitType === 'item')
    .sort((a, b) => a.orderIndex - b.orderIndex);
  const unitIds = items.map((unit) => unit.id);

  const rows: TraceabilityRow[] = snapshot.objectives
    .filter((objective) => objective.status !== 'archived')
    .map((objective) => {
      const mine = snapshot.unitCoverage.filter((c) => c.objectiveId === objective.id);
      const pick = (kind: CoverageKind) =>
        mine.filter((c) => c.coverageKind === kind).map((c) => c.unitId);
      const teach = pick('teach');
      const practice = pick('practice');
      const assess = pick('assess');
      return {
        objectiveId: objective.id,
        title: objective.title,
        teach,
        practice,
        assess,
        complete: teach.length > 0 && practice.length > 0 && assess.length > 0,
      };
    });

  return { unitIds, rows };
}
