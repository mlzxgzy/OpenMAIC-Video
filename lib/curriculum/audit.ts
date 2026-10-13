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

import { CURRICULUM_ORDER_CLAIM_EDGE_TYPES } from './design-types';
import { assessmentGaps, type AssessmentGap, type AssessmentGapKind } from './design-assessment';
import { outlineOrderConflicts } from './design-outline';
import { nodesForObjectives, teachingGapsOfItems, type TeachingGap } from './design-teaching';
import type {
  CurriculumAuditSeverity,
  CurriculumDependencyEdgeType,
  CurriculumDesignSnapshot,
  CurriculumObjectiveRecord,
  CurriculumUnitDependencyEdgeType,
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
  'unit_dependency_cycle',
  'unit_dependency_out_of_order',
  'unit_without_role',
  'chapter_with_content',
  'unit_orphan',
  'unit_lesson_undesigned',
  'deck_script_conflict',
  'question_off_item',
  'lab_off_item',
  'coverage_without_artifact',
  'exam_evidence_practice_lab',
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
        `学习目标「${objective.title}」无法验证：` +
        (objective.unverifiableReason || '没有写明预期行为，也没有最低成功标准'),
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
      message: `学习目标「${objective.title}」没有证据：没有任何地方说明它将被如何检验`,
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
        message: `学习目标「${objective.title}」没有被任何条目${label}`,
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
  '讲授',
);
const ruleObjectiveUnpracticed = missingCoverageRule(
  'practice',
  'objective_unpracticed',
  'practice_covers',
  '练习',
);
const ruleObjectiveUncovered = missingCoverageRule(
  'assess',
  'objective_uncovered',
  'assess_covers',
  '考核',
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
   * Every node id any teaching item names. All five buckets are id lists:
   * `nodes` is derived by the rules layer as the union of `core` / `brief` /
   * `mention`, and `prerequisites` names the nodes this lesson assumes. Reading
   * the buckets directly as well as `nodes` matters because the workbench's
   * editor writes a bucket on its own — a hand-edited item would otherwise carry
   * a "taught in full" claim the rule cannot see, and the rule would report a
   * node as unnamed on a design that names it.
   */
  const mentionedNodeIds = new Set<string>();
  for (const coverage of snapshot.unitCoverage) {
    if (coverage.coverageKind !== 'teach') continue;
    const unit = unitById.get(coverage.unitId);
    if (!unit || unit.unitType !== 'item') continue;
    const design = unit.teachingDesign;
    for (const field of ['nodes', 'core', 'brief', 'mention', 'prerequisites'] as const) {
      for (const nodeId of design[field] ?? []) mentionedNodeIds.add(nodeId);
    }
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
        `学习目标「${objective?.title ?? objectiveId}」已经被讲授，但没有任何条目的教学设计` +
        `提到它的主要支撑：${names.join('、')}`,
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
          message: `两个学习目标共用了编号「${code}」：可能是同一个目标写了两遍`,
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
            `学习目标「${a.title}」与「${b.title}」的重合度为 ` +
            `${Math.round(overlap * 100)}%：可能是同一个目标写了两遍`,
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
        `「${node.name}」不支撑任何学习目标，也没有任何依赖：它既没有理由被讲授，` +
        '也不属于任何学习路径',
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
      message: `课程级学习目标「${objective.title}」没有主要支撑的知识/技能节点`,
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
        message: `「${objective?.title ?? evidence.objectiveId}」的考试证据没有` + '对应的教学',
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
        message: `「${objective?.title ?? evidence.objectiveId}」的实操证据没有对应的实操任务`,
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
        message: `「${objective?.title ?? evidence.objectiveId}」的测验证据没有对应的题目`,
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
      message: `题目「${question.stem.slice(0, 40)}」没有关联任何学习目标`,
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
      message: `实操任务「${lab.taskGoal}」没有验证规则：无法判分`,
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
        `实操任务「${lab.taskGoal}」有一条验证规则与参考解答中的某个步骤完全相同：` +
        '这判的是某一种解法，而不是结果',
      refKind: 'lab_task',
      refId: lab.id,
      refIds: [],
      layer: 'assess_covers',
    }));
}

/**
 * The step-7 checks, surfaced as audit rules.
 *
 * The three findings here all say the same thing in different places: **a question
 * or a lab is only graded where it hangs.** Hanging it on a chapter, or on an item
 * that never made a promise about that outcome, produces an artifact that looks
 * complete in every list — stem, options, answer, verification rules — while the
 * closure matrix never sees it. The step's own card, the phase gate and this audit
 * all read {@link assessmentGaps}, so they cannot disagree about which artifacts
 * are adrift.
 *
 * `lab_without_verify_rule` is deliberately **not** mapped here: `lab_no_verify_rule`
 * already owns that finding, and two producers of one rule code would double every
 * ungradable lab. `no_items` is a gap the step reports, not a defect of a course
 * that has no items — `brief_incomplete` and the objective rules already say the
 * design is empty.
 */
const ASSESSMENT_GAP_RULES: Partial<Record<AssessmentGapKind, CurriculumAuditRule>> = {
  question_on_chapter: 'question_off_item',
  question_off_item: 'question_off_item',
  lab_off_item: 'lab_off_item',
  coverage_without_artifact: 'coverage_without_artifact',
  exam_evidence_practice_lab: 'exam_evidence_practice_lab',
};

function ruleAssessmentPlacement(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return assessmentGaps(snapshot).flatMap((gap: AssessmentGap) => {
    const rule = ASSESSMENT_GAP_RULES[gap.kind];
    if (!rule) return [];
    // The kind of thing the finding points at, so the panel can link to the right
    // record: a lab reported as a "question" would highlight the wrong row — or
    // nothing at all.
    const refKind =
      gap.kind === 'coverage_without_artifact'
        ? ('unit' as const)
        : gap.kind === 'lab_off_item' || gap.kind === 'exam_evidence_practice_lab'
          ? ('lab_task' as const)
          : ('question' as const);
    return [
      {
        rule,
        severity: 'error' as const,
        message: gap.text,
        refKind,
        refId: gap.ref ?? snapshot.task.id,
        refIds: [],
        layer: 'assess_covers' as const,
      },
    ];
  });
}

/**
 * Edges that express order, for cycle detection.
 *
 * The set itself lives in `design-types` because three layers read it now — this
 * audit, the step-3 rules that decide which edges may be written at all, and the
 * store's cycle walk. A local copy is how "supports is not an order claim" ends
 * up true in one place and false in another.
 */
const ORDERING_EDGES: ReadonlySet<CurriculumDependencyEdgeType> = new Set(
  CURRICULUM_ORDER_CLAIM_EDGE_TYPES,
);

function buildAdjacency<E extends string>(
  edges: { sourceId: string; targetId: string; edgeType: E }[],
  ordering: ReadonlySet<E>,
): Map<string, string[]> {
  const adjacency = new Map<string, string[]>();
  for (const edge of edges) {
    if (!ordering.has(edge.edgeType)) continue;
    const list = adjacency.get(edge.sourceId) ?? [];
    list.push(edge.targetId);
    adjacency.set(edge.sourceId, list);
  }
  return adjacency;
}

/**
 * Every cycle in a directed graph, as the list of nodes walked to reach it.
 * Shared by the outcome graph and the item-ordering graph: both ask the same
 * question of different node sets, and a course whose teaching order loops has
 * no first item for exactly the reason a looping prerequisite graph has no
 * first thing to learn.
 */
function findCycles(adjacency: Map<string, string[]>): string[][] {
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
  return cycles;
}

/**
 * Cycles in the ordering edges. A course whose prerequisites form a loop has
 * no entry point: there is no first thing to learn.
 */
function ruleDependencyCycle(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const adjacency = buildAdjacency(snapshot.dependencies, ORDERING_EDGES);
  const cycles = findCycles(adjacency);

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
      message: `依赖成环：${labels.join(' → ')}。没有可以最先学习的东西。`,
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
 *
 * Both endpoint kinds are read, and the node half was missing for a while:
 * step 3 records "which knowledge comes before which" as **node → node** edges,
 * and a rule that only walked `objective → objective` edges reported nothing
 * about them. That made the ordering claim the author signed decorative — the
 * design system's promise that "the sequence is derived from the edges" had no
 * reader at all. A node's delivery position is the earliest item teaching any
 * outcome that node supports, which is the only way a node reaches a learner.
 */
function ruleDependencyOutOfOrder(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const items = snapshot.units
    .filter((unit) => unit.unitType === 'item')
    .map((unit) => ({ id: unit.id, orderIndex: unit.orderIndex }));
  const teachesByItem = new Map<string, string[]>();
  for (const coverage of snapshot.unitCoverage) {
    if (coverage.coverageKind !== 'teach') continue;
    const list = teachesByItem.get(coverage.unitId) ?? [];
    list.push(coverage.objectiveId);
    teachesByItem.set(coverage.unitId, list);
  }
  const objectivesByNode = new Map<string, string[]>();
  for (const link of snapshot.nodeObjectives) {
    const list = objectivesByNode.get(link.nodeId) ?? [];
    list.push(link.objectiveId);
    objectivesByNode.set(link.nodeId, list);
  }

  const objectiveById = new Map(snapshot.objectives.map((o) => [o.id, o]));
  const nodeById = new Map(snapshot.nodes.map((n) => [n.id, n]));
  // One implementation, two readers: this audit and the step-5 outline rules ask
  // the identical question ("does the delivery order contradict the claim?") of
  // the identical data. `outlineOrderConflicts` is the definition.
  return outlineOrderConflicts({
    items,
    teachesByItem,
    objectivesByNode,
    edges: snapshot.dependencies,
    labelOf: (id) => objectiveById.get(id)?.title ?? nodeById.get(id)?.name ?? id,
  }).map((conflict) => ({
    rule: 'dependency_out_of_order' as const,
    severity: 'error' as const,
    message: conflict.message,
    refKind: 'dependency',
    refId: conflict.refId,
    refIds: [conflict.sourceId, conflict.targetId],
    layer: 'dependency_valid' as const,
  }));
}

/**
 * Edges in the *item* ordering graph. `prerequisite` is the one that constrains
 * delivery order; `follow-up` and `related` are annotations about the author's
 * intent and would fire constantly if read as ordering constraints.
 */
const UNIT_ORDERING_EDGES: ReadonlySet<CurriculumUnitDependencyEdgeType> = new Set([
  'prerequisite',
]);

/**
 * Two claims disagree about the sequence. The author declared "A is a
 * prerequisite of B" and also placed B before A in the outline.
 *
 * This is deliberately separate from `dependency_out_of_order`, which compares
 * the *objective* graph against delivery order. That rule can stay silent while
 * this one fires, and correctly so: the objective graph says what a learner must
 * know first, while this edge is an explicit claim about the order the course
 * itself presents. The two can be satisfied by different orders, and the author
 * is the only one who can say which sequence was meant.
 *
 * Only `prerequisite` edges are read as ordering claims — see
 * {@link UNIT_ORDERING_EDGES}. A `related` edge carries no order, so demanding
 * one from it would be the audit inventing a constraint the author never made.
 */
function ruleUnitDependencyOutOfOrder(
  snapshot: CurriculumDesignSnapshot,
): CurriculumAuditFinding[] {
  const orderByUnit = new Map<string, number>();
  for (const unit of snapshot.units) {
    // Only items have a delivery position. A chapter is a grouping label; it is
    // not taught at a moment, so an edge touching one states no order.
    if (unit.unitType !== 'item') continue;
    orderByUnit.set(unit.id, unit.orderIndex);
  }
  const unitById = new Map(snapshot.units.map((unit) => [unit.id, unit]));
  const findings: CurriculumAuditFinding[] = [];
  for (const edge of snapshot.unitDependencies) {
    if (!UNIT_ORDERING_EDGES.has(edge.edgeType)) continue;
    const sourceOrder = orderByUnit.get(edge.sourceUnitId);
    const targetOrder = orderByUnit.get(edge.targetUnitId);
    if (sourceOrder === undefined || targetOrder === undefined) continue;
    if (sourceOrder <= targetOrder) continue;
    const source = unitById.get(edge.sourceUnitId);
    const target = unitById.get(edge.targetUnitId);
    findings.push({
      rule: 'unit_dependency_out_of_order',
      severity: 'error',
      message:
        `条目「${target?.title ?? edge.targetUnitId}」被安排在第 ` +
        `${targetOrder + 1} 位，却排在它声明的先修` +
        `「${source?.title ?? edge.sourceUnitId}」（第 ${sourceOrder + 1} 位）之前`,
      refKind: 'unitDependency',
      refId: edge.id,
      refIds: [edge.sourceUnitId, edge.targetUnitId],
      layer: 'dependency_valid',
    });
  }
  return findings;
}

/**
 * The declared teaching order loops. A → B → A has no first item, so the course
 * cannot be entered; the learner is asked to start where they already are.
 */
function ruleUnitDependencyCycle(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  const adjacency = buildAdjacency(
    snapshot.unitDependencies.map((edge) => ({
      sourceId: edge.sourceUnitId,
      targetId: edge.targetUnitId,
      edgeType: edge.edgeType,
    })),
    UNIT_ORDERING_EDGES,
  );
  const unitById = new Map(snapshot.units.map((unit) => [unit.id, unit]));

  const seen = new Set<string>();
  const findings: CurriculumAuditFinding[] = [];
  for (const cycle of findCycles(adjacency)) {
    const key = [...cycle].sort().join(':');
    if (seen.has(key)) continue;
    seen.add(key);
    const labels = cycle.map((id) => unitById.get(id)?.title ?? id);
    findings.push({
      rule: 'unit_dependency_cycle',
      severity: 'error',
      message: `条目顺序成环：${labels.join(' → ')}。没有可以最先讲授的条目。`,
      refKind: 'unitDependency',
      refId: cycle[0],
      refIds: [...new Set(cycle)],
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
      message: `条目「${unit.title}」没有角色：需要标记为 lecture（讲授）、practice（练习）或 exam（考试）`,
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
        `章节「${chapter?.title ?? coverage.unitId}」为「${objective?.title ?? coverage.objectiveId}」` +
        `承载了「${coverage.coverageKind}」覆盖内容。章节只做归类，条目才负责教学。`,
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
      message: `条目「${unit.title}」不覆盖任何学习目标：既不讲授、不练习，也不考核`,
      refKind: 'unit',
      refId: unit.id,
      refIds: [],
      layer: 'curriculum_covers' as const,
    }));
}

/**
 * A lesson that has not been designed: a lecture item with no storyboard, an item
 * with no script at all, a practice item that never says what is practised.
 *
 * This rule is what makes step 6 load-bearing rather than advisory. A `lecture`
 * item is produced as slides, and the page plan is the only channel the teaching
 * design has to the generator: with no plan, the outline step invents its own page
 * structure from a paragraph — which is the defect the whole `deck_design`
 * contract exists to remove. Producing such an item is therefore an error rather
 * than a warning.
 *
 * The gaps come from `teachingGapsOfItems`, the same function the step's rules and
 * the phase gate call. Selecting by `kind` rather than by message text is
 * deliberate: a rule that pattern-matches a sentence stops working the day
 * somebody rewords it, and nothing fails loudly when it does.
 */
function ruleUnitLessonUndesigned(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return teachingFindings(snapshot, (gap) => gap.kind !== 'script_storyboard_conflict');
}

/**
 * A storyboard that contradicts its own script.
 *
 * A page teaching something the script marked out of scope, or a point the script
 * says must be taught in full that no page carries, means the design answers two
 * different lessons. It is invisible in the UI — the script and the storyboard are
 * two lists that each look complete — and it is the failure step 6 exists to
 * catch, so it is an error here as well as in the conversation.
 */
function ruleDeckScriptConflict(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return teachingFindings(snapshot, (gap) => gap.kind === 'script_storyboard_conflict');
}

/** The teaching gaps of a snapshot, turned into findings by a `kind` predicate. */
function teachingFindings(
  snapshot: CurriculumDesignSnapshot,
  want: (gap: TeachingGap) => boolean,
): CurriculumAuditFinding[] {
  const items = snapshot.units.filter((unit) => unit.unitType === 'item');
  const objectiveIdsByUnit = new Map<string, string[]>();
  for (const coverage of snapshot.unitCoverage) {
    const list = objectiveIdsByUnit.get(coverage.unitId) ?? [];
    list.push(coverage.objectiveId);
    objectiveIdsByUnit.set(coverage.unitId, list);
  }
  const gaps = teachingGapsOfItems(
    items.map((unit) => ({
      id: unit.id,
      title: unit.title,
      role: unit.unitRole ?? 'lecture',
      teachingDesign: unit.teachingDesign,
      deckDesign: unit.deckDesign,
      nodes: nodesForObjectives(
        objectiveIdsByUnit.get(unit.id) ?? [],
        snapshot.nodeObjectives,
        snapshot.nodes,
      ),
      allNodeNames: new Map(snapshot.nodes.map((node) => [node.id, node.name])),
    })),
  );
  return gaps.filter(want).map((gap) => ({
    rule:
      gap.kind === 'script_storyboard_conflict'
        ? ('deck_script_conflict' as const)
        : ('unit_lesson_undesigned' as const),
    severity: 'error' as const,
    message: gap.text,
    refKind: 'unit' as const,
    refId: gap.ref ?? snapshot.task.id,
    refIds: [],
    // The teaching layer, not `support_complete`: this is about *how* an item
    // teaches, which is the same layer as "is this outcome taught at all".
    layer: 'teach_covers' as const,
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
  if (!task.audience) push('课程简介没有说明培训对象是谁');
  if (!task.problemStatement) push('课程简介没有说明课程要解决的问题');
  if (task.durationHours === null) push('课程简介没有说明培训时长');
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
    ...ruleUnitDependencyCycle(snapshot),
    ...ruleUnitDependencyOutOfOrder(snapshot),
    ...ruleUnitWithoutRole(snapshot),
    ...ruleChapterWithContent(snapshot),
    ...ruleUnitOrphan(snapshot),
    ...ruleUnitLessonUndesigned(snapshot),
    ...ruleDeckScriptConflict(snapshot),
    ...ruleAssessmentPlacement(snapshot),
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
