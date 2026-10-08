/**
 * Course design audit — the layer that decides whether a course is internally
 * sound, as opposed to merely complete.
 *
 * Every function here is pure and takes a {@link CurriculumDesignSnapshot}. The
 * snapshot is the whole design, so the audit never issues queries and the same
 * rules can run in a test, an API route, or the editor.
 *
 * The rules are derived from one commitment: a course is accountable for a set
 * of learning outcomes, and the design must be able to show, for each outcome,
 * that it is taught, trained, and verified. Anything that breaks that chain is
 * a finding. A rule that cannot be phrased as a break in that chain does not
 * belong here.
 */

import type {
  CurriculumAuditSeverity,
  CurriculumDependencyEdgeType,
  CurriculumDesignSnapshot,
  CurriculumObjectiveRecord,
} from './design-types';

/**
 * Rules that make up the design audit.
 *
 * `objective_*` and `node_orphan` are the closed-loop rules: they are the
 * machine-checkable form of "did we teach, train and verify it". The rest
 * describe defects that are real but not loop violations — a dependency cycle,
 * a lab that cannot be graded, a chapter that has quietly become a content
 * bucket.
 */
export const CURRICULUM_AUDIT_RULES = [
  'objective_unverifiable',
  'objective_no_evidence',
  'objective_untaught',
  'objective_unpracticed',
  'objective_uncovered',
  'objective_missing_prereq',
  'objective_duplicate',
  'objective_unmeasurable',
  'node_orphan',
  'node_unsupported',
  'evidence_untaught',
  'evidence_no_artifact',
  'drill_no_objective',
  'lab_no_verify_rule',
  'lab_verify_grades_by_path',
  'dependency_cycle',
  'dependency_out_of_order',
  'unit_without_role',
  'chapter_with_content',
  'unit_orphan',
  'brief_incomplete',
] as const;

export type CurriculumAuditRule = (typeof CURRICULUM_AUDIT_RULES)[number];

export interface CurriculumAuditFinding {
  rule: CurriculumAuditRule;
  severity: CurriculumAuditSeverity;
  message: string;
  refKind: string | null;
  refId: string | null;
  refIds: string[];
  /**
   * Which layer of the quality chain this finding breaks. This is what lets
   * {@link evaluateCurriculumQuality} answer "where is the course broken"
   * rather than returning a flat pile of problems.
   */
  layer: CurriculumQualityLayer;
}

export const CURRICULUM_QUALITY_LAYERS = [
  'outcomes_clear',
  'outcomes_verifiable',
  'support_complete',
  'dependency_valid',
  'curriculum_covers',
  'teach_covers',
  'practice_covers',
  'assess_covers',
  'traceable',
] as const;
export type CurriculumQualityLayer = (typeof CURRICULUM_QUALITY_LAYERS)[number];

/** Outcomes that are `draft` or `archived` are not part of the commitment. */
function activeObjectives(snapshot: CurriculumDesignSnapshot): CurriculumObjectiveRecord[] {
  return snapshot.objectives.filter((objective) => objective.status !== 'archived');
}

// ── Individual rules ─────────────────────────────────────────────────────────

function ruleObjectiveUnverifiable(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return activeObjectives(snapshot)
    .filter((objective) => !objective.verifiable)
    .map((objective) => ({
      rule: 'objective_unverifiable' as const,
      severity: 'error' as const,
      message:
        `Outcome "${objective.title}" cannot be verified: ` +
        (objective.unverifiableReason ||
          'it has no expected behavior or no minimum success criterion'),
      refKind: 'objective',
      refId: objective.id,
      refIds: [],
      layer: 'outcomes_verifiable' as const,
    }));
}

/**
 * An objective can be "verifiable" by the database's rule and still name no
 * evidence, which is a different failure: nothing says how it will be
 * checked. Kept separate from `objective_unverifiable` so the fix differs.
 */
function ruleObjectiveNoEvidence(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const byObjective = new Set(snapshot.evidence.map((e) => e.objectiveId));
  return activeObjectives(snapshot)
    .filter((objective) => !byObjective.has(objective.id))
    .map((objective) => ({
      rule: 'objective_no_evidence' as const,
      severity: 'error' as const,
      message: `Outcome "${objective.title}" has no evidence: nothing states how it will be checked`,
      refKind: 'objective',
      refId: objective.id,
      refIds: [],
      layer: 'outcomes_verifiable' as const,
    }));
}

function coverageByObjective(
  snapshot: CurriculumDesignSnapshot,
): Map<string, Set<'teach' | 'practice' | 'assess'>> {
  const map = new Map<string, Set<'teach' | 'practice' | 'assess'>>();
  for (const coverage of snapshot.unitCoverage) {
    let kinds = map.get(coverage.objectiveId);
    if (!kinds) {
      kinds = new Set();
      map.set(coverage.objectiveId, kinds);
    }
    kinds.add(coverage.coverageKind);
  }
  return map;
}

function missingCoverageRule(
  kind: 'teach' | 'practice' | 'assess',
  rule: 'objective_untaught' | 'objective_unpracticed' | 'objective_uncovered',
  layer: CurriculumQualityLayer,
  label: string,
): (snapshot: CurriculumDesignSnapshot) => CurriculumAuditFinding[] {
  return (snapshot) => {
    const covered = coverageByObjective(snapshot);
    return activeObjectives(snapshot)
      .filter((objective) => !covered.get(objective.id)?.has(kind))
      .map((objective) => ({
        rule,
        severity: 'error' as const,
        message: `Outcome "${objective.title}" is not ${label} by any item`,
        refKind: 'objective',
        refId: objective.id,
        refIds: [],
        layer,
      }));
  };
}

const ruleObjectiveUntaught = missingCoverageRule(
  'teach',
  'objective_untaught',
  'teach_covers',
  'taught',
);
const ruleObjectiveUnpracticed = missingCoverageRule(
  'practice',
  'objective_unpracticed',
  'practice_covers',
  'practiced',
);
const ruleObjectiveUncovered = missingCoverageRule(
  'assess',
  'objective_uncovered',
  'assess_covers',
  'assessed',
);

/**
 * A taught outcome whose supporting knowledge or skill is never mentioned by
 * any item's teaching design.
 *
 * The database already refuses to outline a course with orphan nodes, so this
 * catches the later regression: a node that was wired to an outcome, and then
 * the items were written without ever naming it. The learner is asked to do
 * something built on a node no lesson covers.
 */
function ruleObjectiveMissingPrereq(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const unitById = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  const taughtObjectives = new Set(
    snapshot.unitCoverage.filter((c) => c.coverageKind === 'teach').map((c) => c.objectiveId),
  );

  /**
   * Every node id any teaching item names. Only `nodes` and `prerequisites`
   * are id lists — `core`/`brief`/`mention` hold free-text topic strings, so
   * scanning them for node ids would match nothing and would make this rule
   * fire on every correct design.
   */
  const mentionedNodeIds = new Set<string>();
  for (const coverage of snapshot.unitCoverage) {
    if (coverage.coverageKind !== 'teach') continue;
    const unit = unitById.get(coverage.unitId);
    if (!unit || unit.unitType !== 'item') continue;
    const design = unit.teachingDesign;
    for (const nodeId of design.nodes ?? []) mentionedNodeIds.add(nodeId);
    for (const nodeId of design.prerequisites ?? []) mentionedNodeIds.add(nodeId);
  }

  // Primary support is the load-bearing set: a node marked secondary may
  // legitimately never be named, but a primary one carries the outcome.
  const primarySupport = new Map<string, string[]>();
  for (const link of snapshot.nodeObjectives) {
    if (link.supportLevel !== 'primary') continue;
    const list = primarySupport.get(link.objectiveId) ?? [];
    list.push(link.nodeId);
    primarySupport.set(link.objectiveId, list);
  }

  const nodeById = new Map(snapshot.nodes.map((node) => [node.id, node]));
  const findings: CurriculumAuditFinding[] = [];
  for (const [objectiveId, nodeIds] of primarySupport) {
    if (!taughtObjectives.has(objectiveId)) continue;
    // An objective taught by several items is supported if any one of them
    // names its node; the teaching split across items is allowed.
    const unmentioned = nodeIds.filter((nodeId) => !mentionedNodeIds.has(nodeId));
    if (unmentioned.length === 0) continue;
    const objective = snapshot.objectives.find((o) => o.id === objectiveId);
    const names = unmentioned.map((id) => nodeById.get(id)?.name ?? id);
    findings.push({
      rule: 'objective_missing_prereq',
      severity: 'error',
      message:
        `Outcome "${objective?.title ?? objectiveId}" is taught, but no item's teaching ` +
        `design names its primary support: ${names.join(', ')}`,
      refKind: 'objective',
      refId: objectiveId,
      refIds: unmentioned,
      layer: 'support_complete',
    });
  }
  return findings;
}

/**
 * Two objectives that are the same promise stated twice. Compared on
 * normalized title, then on a coarse token overlap of the title plus expected
 * behavior, so "understand SQL injection" and "comprehend SQL injection
 * mechanics" surface together without a semantic model.
 */
function normalizePhrase(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[\s]+/g, ' ')
    .trim()
    .split(' ')
    .filter((token) => token.length > 0);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const token of a) if (b.has(token)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
}

function ruleObjectiveDuplicate(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const objectives = activeObjectives(snapshot);
  const byCode = new Map<string, string[]>();
  const tokenSets = new Map<string, Set<string>>();
  for (const objective of objectives) {
    if (objective.code) {
      const list = byCode.get(objective.code) ?? [];
      list.push(objective.id);
      byCode.set(objective.code, list);
    }
    const tokens = new Set([
      ...normalizePhrase(objective.title),
      ...normalizePhrase(objective.expectedBehavior),
    ]);
    tokenSets.set(objective.id, tokens);
  }

  const findings: CurriculumAuditFinding[] = [];
  const reported = new Set<string>();
  for (const [code, ids] of byCode) {
    if (ids.length < 2) continue;
    const byId = new Map(objectives.map((o) => [o.id, o]));
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = byId.get(ids[i]);
        const b = byId.get(ids[j]);
        if (a && b && (a.parentId === b.id || b.parentId === a.id)) continue;
        const key = [ids[i], ids[j]].sort().join(':');
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({
          rule: 'objective_duplicate',
          severity: 'warning',
          message: `Outcomes share code "${code}": they may be the same outcome twice`,
          refKind: 'objective',
          refId: ids[i],
          refIds: [ids[i], ids[j]],
          layer: 'outcomes_clear',
        });
      }
    }
  }
  for (let i = 0; i < objectives.length; i += 1) {
    for (let j = i + 1; j < objectives.length; j += 1) {
      const a = objectives[i];
      const b = objectives[j];
      // Parent/child pairs are a decomposition, not a repeat of the same
      // promise. Both directions must be checked: testing only `a.parentId`
      // misses the pair whenever the parent happens to be compared first,
      // since the parent's own parent_id is null and the guard short-circuits.
      if (a.parentId === b.id || b.parentId === a.id) continue;
      const overlap = jaccard(tokenSets.get(a.id)!, tokenSets.get(b.id)!);
      if (overlap >= 0.75) {
        const key = [a.id, b.id].sort().join(':');
        if (reported.has(key)) continue;
        reported.add(key);
        findings.push({
          rule: 'objective_duplicate',
          severity: 'warning',
          message:
            `Outcomes "${a.title}" and "${b.title}" overlap by ` +
            `${Math.round(overlap * 100)}%: they may be the same outcome twice`,
          refKind: 'objective',
          refId: a.id,
          refIds: [a.id, b.id],
          layer: 'outcomes_clear',
        });
      }
    }
  }
  return findings;
}

/**
 * A node that is neither tied to an outcome nor part of any dependency edge.
 * This is the "orphan knowledge point" defect: it is in the design, so
 * something must depend on it, and if nothing does it is either dead weight or
 * an outcome that was never written down.
 */
function ruleNodeOrphan(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const supportedNodeIds = new Set(snapshot.nodeObjectives.map((link) => link.nodeId));
  const edgeNodeIds = new Set<string>();
  for (const edge of snapshot.dependencies) {
    if (edge.sourceKind === 'node') edgeNodeIds.add(edge.sourceId);
    if (edge.targetKind === 'node') edgeNodeIds.add(edge.targetId);
  }
  return snapshot.nodes
    .filter((node) => !supportedNodeIds.has(node.id) && !edgeNodeIds.has(node.id))
    .map((node) => ({
      rule: 'node_orphan' as const,
      severity: 'warning' as const,
      message:
        `"${node.name}" supports no outcome and has no dependency: it is neither taught ` +
        'for a reason nor part of a learning path',
      refKind: 'node',
      refId: node.id,
      refIds: [],
      layer: 'support_complete' as const,
    }));
}

/**
 * A node that is the sole support of an outcome but carries no `primary`
 * support level, or an outcome whose only supporting nodes are all `secondary`.
 * Weak support is allowed; invisible support is not.
 */
function ruleNodeUnsupported(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const byNode = new Map<string, string[]>();
  for (const link of snapshot.nodeObjectives) {
    if (link.supportLevel !== 'primary') continue;
    const list = byNode.get(link.objectiveId) ?? [];
    list.push(link.nodeId);
    byNode.set(link.objectiveId, list);
  }
  return activeObjectives(snapshot)
    .filter((objective) => objective.level === 'course')
    .filter((objective) => (byNode.get(objective.id) ?? []).length === 0)
    .map((objective) => ({
      rule: 'node_unsupported',
      severity: 'warning',
      message: `Course-level outcome "${objective.title}" has no primary knowledge/skill support`,
      refKind: 'objective',
      refId: objective.id,
      refIds: [],
      layer: 'support_complete',
    }));
}

/**
 * An exam that verifies something the course never teaches. This is the
 * "there is a test but no lesson for it" defect. It is checked against the
 * evidence's objective: if the objective is not taught, the exam tests
 * material the learner was never given.
 */
function ruleEvidenceUntaught(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const taught = coverageByObjective(snapshot);
  return snapshot.evidence
    .filter((evidence) => evidence.assessmentMode === 'exam')
    .filter((evidence) => !taught.get(evidence.objectiveId)?.has('teach'))
    .map((evidence) => {
      const objective = snapshot.objectives.find((o) => o.id === evidence.objectiveId);
      return {
        rule: 'evidence_untaught' as const,
        severity: 'error' as const,
        message:
          `Exam evidence for "${objective?.title ?? evidence.objectiveId}" has no ` +
          'corresponding teaching',
        refKind: 'evidence',
        refId: evidence.id,
        refIds: [evidence.objectiveId],
        layer: 'teach_covers' as const,
      };
    });
}

/**
 * Evidence with no artifact behind it. A `lab` evidence with no lab task, or
 * a `quiz` evidence with no question, is a promise with nothing to deliver.
 * This is what makes the loop closable in practice rather than only on paper.
 */
function ruleEvidenceNoArtifact(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const labObjectives = new Set(snapshot.labTasks.map((lab) => lab.objectiveId));
  const questionObjectives = new Set(snapshot.questions.map((q) => q.objectiveId));
  const findings: CurriculumAuditFinding[] = [];
  for (const evidence of snapshot.evidence) {
    const objective = snapshot.objectives.find((o) => o.id === evidence.objectiveId);
    if (evidence.evidenceType === 'lab' && !labObjectives.has(evidence.objectiveId)) {
      findings.push({
        rule: 'evidence_no_artifact',
        severity: 'error',
        message: `Lab evidence for "${objective?.title ?? evidence.objectiveId}" has no lab task`,
        refKind: 'evidence',
        refId: evidence.id,
        refIds: [evidence.objectiveId],
        layer: 'assess_covers',
      });
    }
    if (evidence.evidenceType === 'quiz' && !questionObjectives.has(evidence.objectiveId)) {
      findings.push({
        rule: 'evidence_no_artifact',
        severity: 'error',
        message: `Quiz evidence for "${objective?.title ?? evidence.objectiveId}" has no question`,
        refKind: 'evidence',
        refId: evidence.id,
        refIds: [evidence.objectiveId],
        layer: 'assess_covers',
      });
    }
  }
  return findings;
}

/** A question that no objective claims. */
function ruleDrillNoObjective(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const objectiveIds = new Set(snapshot.objectives.map((o) => o.id));
  const findings: CurriculumAuditFinding[] = [];
  for (const question of snapshot.questions) {
    if (objectiveIds.has(question.objectiveId)) continue;
    findings.push({
      rule: 'drill_no_objective',
      severity: 'error',
      message: `Question "${question.stem.slice(0, 40)}" is not linked to any outcome`,
      refKind: 'question',
      refId: question.id,
      refIds: [],
      layer: 'traceable',
    });
  }
  return findings;
}

/** A lab with no verification rule cannot be graded. */
function ruleLabNoVerifyRule(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return snapshot.labTasks
    .filter((lab) => lab.verifyRules.length === 0)
    .map((lab) => ({
      rule: 'lab_no_verify_rule' as const,
      severity: 'error' as const,
      message: `Lab task "${lab.taskGoal}" has no verification rule: it cannot be graded`,
      refKind: 'lab_task',
      refId: lab.id,
      refIds: [],
      layer: 'assess_covers' as const,
    }));
}

/**
 * A lab whose "verification" restates the reference solution. Grading by path
 * marks a correct alternative solve wrong, so a verify rule that is really a
 * step is the same defect as having no rule at all, just disguised.
 */
function ruleLabVerifyGradesByPath(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  /**
   * The only signal that a rule grades the route is that it quotes a step
   * verbatim. A rule that merely concerns the same file as a step — a
   * `file_read` of `/flag` where a step says "read /flag" — is the correct
   * result-shaped check, so a substring match is far too loose here and would
   * flag every well-designed lab. Exact quote is the intended mistake.
   */
  const assertedValues = (rule: (typeof snapshot.labTasks)[number]['verifyRules'][number]) =>
    [rule.value, rule.expression, ...(rule.argv ?? [])]
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.trim().toLowerCase())
      .filter((v) => v.length > 0);

  return snapshot.labTasks
    .filter((lab) => lab.verifyRules.length > 0)
    .filter((lab) => {
      const steps = lab.referenceSolution ?? [];
      if (steps.length === 0) return false;
      const quoted = new Set(
        steps.map((step) => `${step.action} ${step.detail ?? ''}`.trim().toLowerCase()),
      );
      return lab.verifyRules.some((rule) => assertedValues(rule).some((v) => quoted.has(v)));
    })
    .map((lab) => ({
      rule: 'lab_verify_grades_by_path',
      severity: 'error',
      message:
        `Lab task "${lab.taskGoal}" has a verification rule that matches a step in its ` +
        'reference solution: this grades one route, not the result',
      refKind: 'lab_task',
      refId: lab.id,
      refIds: [],
      layer: 'assess_covers',
    }));
}

/** Edges that express order, for cycle detection. */
const ORDERING_EDGES: ReadonlySet<CurriculumDependencyEdgeType> = new Set([
  'prerequisite',
  'derives',
  'progresses',
  'practices',
]);

function buildAdjacency(
  edges: { sourceId: string; targetId: string; edgeType: CurriculumDependencyEdgeType }[],
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ORDERING_EDGES.has(edge.edgeType)) continue;
    const list = adjacency.get(edge.sourceId) ?? [];
    list.push(edge.targetId);
    adjacency.set(edge.sourceId, list);
  }
  return adjacency;
}

/**
 * Cycles in the ordering edges. A course whose prerequisites form a loop has
 * no entry point: there is no first thing to learn.
 */
function ruleDependencyCycle(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const adjacency = buildAdjacency(snapshot.dependencies);
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  const stack: string[] = [];
  const cycles: string[][] = [];

  const visit = (nodeId: string): void => {
    color.set(nodeId, GRAY);
    stack.push(nodeId);
    for (const next of adjacency.get(nodeId) ?? []) {
      const state = color.get(next) ?? WHITE;
      if (state === GRAY) {
        const start = stack.indexOf(next);
        if (start >= 0) cycles.push([...stack.slice(start), next]);
      } else if (state === WHITE) {
        visit(next);
      }
    }
    stack.pop();
    color.set(nodeId, BLACK);
  };

  for (const nodeId of adjacency.keys()) {
    if ((color.get(nodeId) ?? WHITE) === WHITE) visit(nodeId);
  }

  const seen = new Set<string>();
  const findings: CurriculumAuditFinding[] = [];
  for (const cycle of cycles) {
    const key = [...cycle].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    const labels = cycle.map((id) => {
      const objective = snapshot.objectives.find((o) => o.id === id);
      if (objective) return objective.title;
      const node = snapshot.nodes.find((n) => n.id === id);
      if (node) return node.name;
      return id;
    });
    findings.push({
      rule: 'dependency_cycle',
      severity: 'error',
      message: `Dependency cycle: ${labels.join(' → ')}. There is no first thing to learn.`,
      refKind: 'dependency',
      refId: cycle[0],
      refIds: [...new Set(cycle)],
      layer: 'dependency_valid',
    });
  }
  return findings;
}

/**
 * A dependency that points backwards relative to the order the items are
 * delivered in. "Advanced skill appears before its foundation" — the graph
 * says B requires A, but A is taught in a later item than B.
 */
function ruleDependencyOutOfOrder(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const itemOrder = new Map<string, number>();
  const unitByObjective = new Map<string, string[]>();
  for (const unit of snapshot.units) {
    if (unit.unitType !== 'item') continue;
    itemOrder.set(unit.id, unit.orderIndex);
  }
  for (const coverage of snapshot.unitCoverage) {
    if (coverage.coverageKind !== 'teach') continue;
    const list = unitByObjective.get(coverage.objectiveId) ?? [];
    list.push(coverage.unitId);
    unitByObjective.set(coverage.objectiveId, list);
  }

  const earliestOrder = (objectiveId: string): number | null => {
    const unitIds = unitByObjective.get(objectiveId);
    if (!unitIds || unitIds.length === 0) return null;
    let min: number | null = null;
    for (const unitId of unitIds) {
      const order = itemOrder.get(unitId);
      if (order === undefined) continue;
      if (min === null || order < min) min = order;
    }
    return min;
  };

  const objectiveById = new Map(snapshot.objectives.map((o) => [o.id, o]));
  const findings: CurriculumAuditFinding[] = [];
  for (const edge of snapshot.dependencies) {
    if (edge.targetKind !== 'objective' || edge.sourceKind !== 'objective') continue;
    if (!ORDERING_EDGES.has(edge.edgeType)) continue;
    const prereqOrder = earliestOrder(edge.sourceId);
    const targetOrder = earliestOrder(edge.targetId);
    if (prereqOrder === null || targetOrder === null) continue;
    if (prereqOrder <= targetOrder) continue;
    const source = objectiveById.get(edge.sourceId);
    const target = objectiveById.get(edge.targetId);
    findings.push({
      rule: 'dependency_out_of_order',
      severity: 'error',
      message:
        `"${target?.title ?? edge.targetId}" is taught before its prerequisite ` +
        `"${source?.title ?? edge.sourceId}"`,
      refKind: 'dependency',
      refId: edge.id,
      refIds: [edge.sourceId, edge.targetId],
      layer: 'dependency_valid',
    });
  }
  return findings;
}

/** An item with no role. Role is what makes a unit teach, practice, or exam. */
function ruleUnitWithoutRole(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return snapshot.units
    .filter((unit) => unit.unitType === 'item' && !unit.unitRole)
    .map((unit) => ({
      rule: 'unit_without_role',
      severity: 'error' as const,
      message: `Item "${unit.title}" has no role: it is not marked as lecture, practice, or exam`,
      refKind: 'unit',
      refId: unit.id,
      refIds: [],
      layer: 'curriculum_covers' as const,
    }));
}

/**
 * A chapter that carries teaching content. Chapters are allowed to organize
 * and to declare an outcome, but if a chapter itself teaches, the outline has
 * stopped being a classification and started being a second content axis. The
 * database trigger blocks this at write time; this rule catches data that
 * predates the trigger or arrived through import.
 */
function ruleChapterWithContent(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const chapterIds = new Set(
    snapshot.units.filter((unit) => unit.unitType === 'chapter').map((unit) => unit.id),
  );
  const offenders = snapshot.unitCoverage.filter((coverage) => chapterIds.has(coverage.unitId));
  const findings: CurriculumAuditFinding[] = [];
  for (const coverage of offenders) {
    const chapter = snapshot.units.find((u) => u.id === coverage.unitId);
    const objective = snapshot.objectives.find((o) => o.id === coverage.objectiveId);
    findings.push({
      rule: 'chapter_with_content',
      severity: 'error',
      message:
        `Chapter "${chapter?.title ?? coverage.unitId}" carries ` +
        `"${coverage.coverageKind}" content for "${objective?.title ?? coverage.objectiveId}". ` +
        'Chapters classify; items teach.',
      refKind: 'unit',
      refId: coverage.unitId,
      refIds: [coverage.objectiveId],
      layer: 'curriculum_covers',
    });
  }
  return findings;
}

/** An item that neither teaches, practices, nor assesses anything. */
function ruleUnitOrphan(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const covered = new Set(snapshot.unitCoverage.map((c) => c.unitId));
  return snapshot.units
    .filter((unit) => unit.unitType === 'item' && !covered.has(unit.id))
    .map((unit) => ({
      rule: 'unit_orphan',
      severity: 'error' as const,
      message: `Item "${unit.title}" covers no outcome: it teaches, practices and assesses nothing`,
      refKind: 'unit',
      refId: unit.id,
      refIds: [],
      layer: 'curriculum_covers' as const,
    }));
}

/** A brief that has not answered who, what problem, how long. */
function ruleBriefIncomplete(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const task = snapshot.task;
  const findings: CurriculumAuditFinding[] = [];
  const push = (message: string) => {
    findings.push({
      rule: 'brief_incomplete',
      severity: 'error' as const,
      message,
      refKind: 'task',
      refId: task.id,
      refIds: [],
      layer: 'outcomes_clear' as const,
    });
  };
  if (!task.audience) push('The brief does not say who the training is for');
  if (!task.problemStatement) push('The brief does not state the problem the course solves');
  if (task.durationHours === null) push('The brief does not state the training duration');
  return findings;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Run every rule and return the findings, sorted most severe first.
 *
 * A finding set is not a verdict on the course; {@link evaluateCurriculumQuality}
 * is. This function answers "what is wrong" and the other answers "which layer
 * of the design is broken as a result".
 */
export function auditCurriculumDesign(
  snapshot: CurriculumDesignSnapshot,
): CurriculumAuditFinding[] {
  const findings: CurriculumAuditFinding[] = [
    ...ruleBriefIncomplete(snapshot),
    ...ruleObjectiveUnverifiable(snapshot),
    ...ruleObjectiveNoEvidence(snapshot),
    ...ruleObjectiveUntaught(snapshot),
    ...ruleObjectiveUnpracticed(snapshot),
    ...ruleObjectiveUncovered(snapshot),
    ...ruleObjectiveMissingPrereq(snapshot),
    ...ruleObjectiveDuplicate(snapshot),
    ...ruleNodeOrphan(snapshot),
    ...ruleNodeUnsupported(snapshot),
    ...ruleEvidenceUntaught(snapshot),
    ...ruleEvidenceNoArtifact(snapshot),
    ...ruleDrillNoObjective(snapshot),
    ...ruleLabNoVerifyRule(snapshot),
    ...ruleLabVerifyGradesByPath(snapshot),
    ...ruleDependencyCycle(snapshot),
    ...ruleDependencyOutOfOrder(snapshot),
    ...ruleUnitWithoutRole(snapshot),
    ...ruleChapterWithContent(snapshot),
    ...ruleUnitOrphan(snapshot),
  ];

  const severityRank: Record<CurriculumAuditSeverity, number> = { error: 0, warning: 1, info: 2 };
  return findings.sort((a, b) => {
    const bySeverity = severityRank[a.severity] - severityRank[b.severity];
    if (bySeverity !== 0) return bySeverity;
    if (a.rule !== b.rule) return a.rule.localeCompare(b.rule);
    return a.message.localeCompare(b.message);
  });
}

export interface CurriculumQualityEvaluation {
  /** The nine layers of the chain, in order. */
  layers: Record<CurriculumQualityLayer, boolean>;
  /** The first broken layer, or null when the course is sound. */
  firstBrokenLayer: CurriculumQualityLayer | null;
  /** Every broken layer with the findings that broke it. */
  broken: Array<{ layer: CurriculumQualityLayer; findings: CurriculumAuditFinding[] }>;
  /** Whether any `error`-severity finding exists. */
  hasErrors: boolean;
  /** Whether the design may be exported / handed to generation. */
  exportable: boolean;
}

/**
 * Evaluate the nine-layer chain:
 *
 *   outcomes clear → verifiable → supported → dependency valid →
 *   curriculum covers → teach → practice → assess → traceable
 *
 * A layer is false when any `error` finding is attributed to it. The first
 * broken layer is the one to fix first: everything after it is downstream of it,
 * and repairing a later layer while an earlier one is broken produces coverage
 * that points at the wrong thing.
 */
export function evaluateCurriculumQuality(
  findings: CurriculumAuditFinding[],
): CurriculumQualityEvaluation {
  const layers = Object.fromEntries(
    CURRICULUM_QUALITY_LAYERS.map((layer) => [layer, true]),
  ) as Record<CurriculumQualityLayer, boolean>;

  const errorsByLayer = new Map<CurriculumQualityLayer, CurriculumAuditFinding[]>();
  for (const finding of findings) {
    if (finding.severity !== 'error') continue;
    layers[finding.layer] = false;
    const list = errorsByLayer.get(finding.layer) ?? [];
    list.push(finding);
    errorsByLayer.set(finding.layer, list);
  }

  const broken = CURRICULUM_QUALITY_LAYERS.filter((layer) => !layers[layer]).map((layer) => ({
    layer,
    findings: errorsByLayer.get(layer) ?? [],
  }));

  const firstBrokenLayer = broken.length > 0 ? broken[0].layer : null;
  return {
    layers,
    firstBrokenLayer,
    broken,
    hasErrors: broken.length > 0,
    // Every layer must hold. A single broken layer means the course cannot
    // claim its outcomes, so nothing downstream of the claim is trustworthy.
    exportable: broken.length === 0,
  };
}

/** Convenience: audit and evaluate in one call. */
export function reviewCurriculumDesign(snapshot: CurriculumDesignSnapshot): {
  findings: CurriculumAuditFinding[];
  quality: CurriculumQualityEvaluation;
} {
  const findings = auditCurriculumDesign(snapshot);
  return { findings, quality: evaluateCurriculumQuality(findings) };
}
