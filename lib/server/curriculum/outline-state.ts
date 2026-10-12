/**
 * The step-5 state payload, in the shape the card and the phase header read.
 *
 * Same job as `knowledge-state.ts`, and for the same reason: the turn route, the
 * GET and the POST of the state route all answer with this, so it is written once
 * rather than three times. Three copies drift, and the drift is silent — a dialog
 * that computes "ready" itself simply disagrees with the gate instead of failing.
 *
 * `phaseGaps` is the authoritative blocker list: it merges the outline's own gaps
 * with the missing confirmation, because a complete outline is necessary but not
 * sufficient. `gaps` names only what is missing from the outline itself, which is
 * what the card marks, and `auditFindings` carries the two unit-ordering rules
 * that the audit owns — read from there rather than re-derived here, so the export
 * gate and this card cannot disagree about a declared order.
 */
import { auditCurriculumDesign, type CurriculumAuditFinding } from '@/lib/curriculum/audit';
import {
  outlineFindings,
  outlineGaps,
  outlineOrderConflicts,
  type OutlineGap,
} from '@/lib/curriculum/design-outline';
import {
  nextCurriculumDesignPhase,
  type CurriculumDesignConfirmationRecord,
  type CurriculumDesignSnapshot,
  type CurriculumObjectiveRecord,
  type CurriculumUnitCoverageRecord,
  type CurriculumUnitDependencyRecord,
  type CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';
import type { DesignContext } from '@/lib/server/curriculum/design-http';
import {
  getCurriculumDesignStepConfirmation,
  getCurriculumTask,
  phaseCompletionGaps,
} from '@/lib/server/curriculum/design-store';

export interface OutlinePayload {
  units: CurriculumUnitRecord[];
  unitCoverage: CurriculumUnitCoverageRecord[];
  /** The confirmed objectives the outline has to teach. */
  objectives: CurriculumObjectiveRecord[];
  /** The declared item ordering claims, so the card can show what precedes what. */
  unitDependencies: CurriculumUnitDependencyRecord[];
  gaps: OutlineGap[];
  /** Advisory only — what the machine can see but must not decide for the author. */
  findings: OutlineGap[];
  /** The audit's own outline-layer findings, read rather than re-derived. */
  auditFindings: CurriculumAuditFinding[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: string | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
  /** Present only on a conversation turn: what the author reads in the chat. */
  message?: string;
  /** Present only on a conversation turn: whether this turn recorded the sign-off. */
  confirmedThisTurn?: boolean;
  /** Present only on a conversation turn: what could not be written, and why. */
  warnings?: string[];
}

/**
 * The two audit rules this step reads instead of re-implementing.
 *
 * The rest of the outline's rules are mirrored in `design-outline.ts` for a
 * conversation-facing reason (per-item, "do this next" wording). These two are
 * about the author's *unit* ordering claims and have no conversation-side
 * equivalent, so importing them keeps one definition rather than two that drift.
 */
const OUTLINE_AUDIT_RULES = new Set(['unit_dependency_out_of_order', 'unit_dependency_cycle']);

/** The audit findings that block confirming the outline. */
export function outlineAuditFindings(snapshot: CurriculumDesignSnapshot): CurriculumAuditFinding[] {
  return auditCurriculumDesign(snapshot).filter((finding) => OUTLINE_AUDIT_RULES.has(finding.rule));
}

/**
 * Every ordering claim checked against the delivery order, in the audit's own
 * words.
 *
 * Both endpoint kinds are walked by `outlineOrderConflicts`, and the node half is
 * why this exists at all: step 3 signed "which knowledge comes before which" as
 * node → node edges, and the outline is the first place a delivery order can
 * contradict them.
 */
export function outlineOrderConflictsOfSnapshot(
  snapshot: CurriculumDesignSnapshot,
): ReturnType<typeof outlineOrderConflicts> {
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
  const objectiveById = new Map(snapshot.objectives.map((row) => [row.id, row]));
  const nodeById = new Map(snapshot.nodes.map((row) => [row.id, row]));
  return outlineOrderConflicts({
    items: snapshot.units
      .filter((unit) => unit.unitType === 'item')
      .map((unit) => ({ id: unit.id, orderIndex: unit.orderIndex })),
    teachesByItem,
    objectivesByNode,
    edges: snapshot.dependencies,
    labelOf: (id) => objectiveById.get(id)?.title ?? nodeById.get(id)?.name ?? id,
  });
}

/**
 * What the stored outline is still missing, in the words the prompt and the card
 * both use.
 *
 * Archived objectives are filtered out here rather than inside the rules, because
 * "which objectives are still part of the commitment" is a fact about the stored
 * design, not about the shape of an outline — the store's gate and the audit's
 * `activeObjectives` both draw the same line, and a card that drew it differently
 * would report a gap the gate does not see.
 */
export function outlineGapsOfSnapshot(snapshot: CurriculumDesignSnapshot): OutlineGap[] {
  const units = snapshot.units.map((unit) => ({
    id: unit.id,
    title: unit.title,
    unitType: unit.unitType,
    unitRole: unit.unitRole,
    parentId: unit.parentId,
    orderIndex: unit.orderIndex,
    hours: unit.hours,
  }));
  return outlineGaps({
    units,
    coverage: snapshot.unitCoverage.map((row) => ({
      unitId: row.unitId,
      objectiveId: row.objectiveId,
      coverageKind: row.coverageKind,
      depth: row.depth,
    })),
    objectives: snapshot.objectives
      .filter((row) => row.status !== 'archived')
      .map((row) => ({ id: row.id, title: row.title })),
    orderConflicts: outlineOrderConflictsOfSnapshot(snapshot),
  });
}

/** The advisory list: hours that do not add up, and nothing else yet. */
export function outlineAdvisoriesOfSnapshot(snapshot: CurriculumDesignSnapshot): OutlineGap[] {
  const items = snapshot.units.filter((unit) => unit.unitType === 'item');
  return outlineFindings({
    items: items.map((unit) => ({ hours: unit.hours })),
    declaredHours: snapshot.task.durationHours,
  });
}

export async function outlineState(
  ctx: DesignContext,
  taskId: string,
  snapshot: CurriculumDesignSnapshot,
): Promise<OutlinePayload> {
  const gaps = outlineGapsOfSnapshot(snapshot);
  const auditFindings = outlineAuditFindings(snapshot);
  const confirmation = await getCurriculumDesignStepConfirmation(
    ctx.queryable,
    ctx.ownerId,
    taskId,
    'outline',
  );
  const task = await getCurriculumTask(ctx.queryable, ctx.ownerId, taskId);
  const next = task ? nextCurriculumDesignPhase(task.designPhase) : null;
  const phaseGaps =
    next !== null ? await phaseCompletionGaps(ctx.queryable, ctx.ownerId, taskId, next) : [];
  return {
    units: snapshot.units,
    unitCoverage: snapshot.unitCoverage,
    objectives: snapshot.objectives,
    unitDependencies: snapshot.unitDependencies,
    gaps,
    findings: outlineAdvisoriesOfSnapshot(snapshot),
    auditFindings,
    confirmation,
    confirmed: confirmation !== null,
    nextPhase: next,
    phaseGaps,
    readyToAdvance: next !== null && phaseGaps.length === 0,
  };
}
