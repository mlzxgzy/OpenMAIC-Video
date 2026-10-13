/**
 * What a review decided, and how a decision is addressed.
 *
 * An audit finding is **derived**: `auditCurriculumDesign` recomputes it from the
 * design on every review, and a stored row is a cache of that computation. A
 * decision is not derived — "I accept this gap" is the author's, and it has to
 * outlive the review that re-derives the finding, because a review writes fresh
 * rows with fresh ids.
 *
 * That is what the fingerprint is for: an address built from the rule and the
 * rows it is about — never from the message (prose gets reworded, and a decision
 * must not evaporate because a sentence improved), and never from the row id (it
 * changes on every review). Two reviews of an unchanged design produce the same
 * fingerprints, so a decision lands on the defect rather than on a row.
 *
 * The second half of the file is the other side of the same coin: what cannot be
 * decided at all. "This course has no outcomes yet" is not a defect an author may
 * accept, it is a precondition — there is nothing to accept, and no waiver can
 * make it true.
 */
import type { CurriculumAuditFinding } from './audit';
import type { CurriculumAuditFindingRecord, CurriculumDesignSnapshot } from './design-types';

/** The part of a finding that identifies the defect rather than describing it. */
export interface FindingAddress {
  rule: string;
  refKind: string | null;
  refId: string | null;
  refIds: readonly string[];
}

/**
 * The address of a defect: rule + the rows it is about.
 *
 * `refIds` is sorted, because order is not part of an address — a rule that lists
 * the same rows in another order is reporting the same defect. The separator is
 * `|`, which no rule code or id contains. The migration that backfills stored
 * rows builds the same string in SQL; `design-review.test.ts` pins the two
 * together, because a fingerprint that is computed two ways is a decision that
 * silently stops matching.
 */
export function findingFingerprint(finding: FindingAddress): string {
  const refIds = [...new Set(finding.refIds)].sort();
  return [finding.rule, finding.refKind ?? '', finding.refId ?? '', refIds.join(',')].join('|');
}

export interface FindingDecisions {
  /**
   * Fingerprint → the decision to accept that defect. Read by the export gate:
   * an accepted defect does not block production, and is reported instead of
   * being silently dropped.
   */
  waived: ReadonlyMap<string, CurriculumAuditFindingRecord>;
}

/**
 * The decisions carried by a snapshot's stored findings.
 *
 * Only `waived` is a decision. `resolved` is not: a review is derived, so a
 * claim that something is fixed is worth nothing — when the defect really is
 * gone the next review retires the row, and until then the finding is still
 * there and still blocks. Reading `resolved` as an acceptance would let a course
 * ship on a claim the audit disagrees with.
 *
 * Duplicate fingerprints (they cannot be written any more, and the migration
 * deduplicated the legacy ones) resolve towards the decision: if any row for a
 * defect says "accepted", the defect is accepted.
 */
export function findingDecisions(
  records: readonly CurriculumAuditFindingRecord[],
): FindingDecisions {
  const waived = new Map<string, CurriculumAuditFindingRecord>();
  for (const record of records) {
    if (record.status !== 'waived') continue;
    if (!waived.has(record.fingerprint)) waived.set(record.fingerprint, record);
  }
  return { waived };
}

export interface PartitionedFindings {
  /** `error` findings with no decision against them: these block production. */
  blocking: CurriculumAuditFinding[];
  /** Findings the author decided to accept. They block nothing, and are reported. */
  accepted: CurriculumAuditFinding[];
  /** Warnings and notes with no decision against them. They never block. */
  advisory: CurriculumAuditFinding[];
  /** Everything with no decision against it, in the audit's own order. */
  live: CurriculumAuditFinding[];
}

/**
 * Split derived findings by what is blocking and what has been decided.
 *
 * The three groups are kept apart rather than collapsed to "open/closed" because
 * each is read differently: the gate refuses on `blocking`, the success path
 * names `accepted` (an export that carries accepted defects must say so), and the
 * cards list `advisory` without treating it as a defect. `live` is the single
 * list those cards show, so an accepted defect stops appearing there — it has
 * been decided, and a decided defect reported again is what makes authors stop
 * reading the list.
 */
export function partitionFindings(
  findings: readonly CurriculumAuditFinding[],
  decisions: FindingDecisions,
): PartitionedFindings {
  const blocking: CurriculumAuditFinding[] = [];
  const accepted: CurriculumAuditFinding[] = [];
  const advisory: CurriculumAuditFinding[] = [];
  const live: CurriculumAuditFinding[] = [];
  for (const finding of findings) {
    if (decisions.waived.has(findingFingerprint(finding))) {
      accepted.push(finding);
    } else if (finding.severity === 'error') {
      blocking.push(finding);
      live.push(finding);
    } else {
      advisory.push(finding);
      live.push(finding);
    }
  }
  return { blocking, accepted, advisory, live };
}

/** A defect the author decided to accept, paired with the decision row. */
export interface AcceptedFinding {
  finding: CurriculumAuditFinding;
  decision: CurriculumAuditFindingRecord;
}

/** The accepted findings with the decision that accepted them, for the payload. */
export function acceptedFindings(
  findings: readonly CurriculumAuditFinding[],
  decisions: FindingDecisions,
): AcceptedFinding[] {
  const result: AcceptedFinding[] = [];
  for (const finding of findings) {
    const decision = decisions.waived.get(findingFingerprint(finding));
    if (decision) result.push({ finding, decision });
  }
  return result;
}

/**
 * What must be true before a design may be produced at all.
 *
 * Deliberately *not* a finding: a finding is a defect in a design, and a defect
 * can be accepted. An empty course is not a defect, it is the absence of a
 * design, and the reason it lives here is that it used to live in the coverage
 * verdict — `summariseCoverage` refuses to call 0/0 complete. That made the
 * coverage summary a second, independent veto next to the coverage rules, which
 * is one fact computed twice: the day they disagree, the gate refuses a course
 * while the line explaining it says every outcome is covered.
 *
 * Only active outcomes count, matching the audit and the coverage matrix — a
 * course whose every outcome is archived has nothing to teach, and one whose
 * outcomes are still `draft` is being designed, which is a legitimate state to
 * keep working from.
 */
export function designPreconditions(snapshot: CurriculumDesignSnapshot): string[] {
  const conditions: string[] = [];
  const active = snapshot.objectives.filter((objective) => objective.status !== 'archived');
  if (active.length === 0) {
    conditions.push('这门课还没有学习目标：先写下第一个目标，再谈生成与导出');
  }
  return conditions;
}
