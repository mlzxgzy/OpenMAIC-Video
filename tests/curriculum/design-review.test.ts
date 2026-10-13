/**
 * How a review decision is addressed, and what it does.
 *
 * The bug this file exists for: findings are derived on every review, and a
 * decision was stored against a row that the next review deleted and re-created.
 * So the decision had nothing to attach to — it duplicated instead of sticking —
 * and nothing read it, so the export gate refused a course whose author had
 * already accepted the gap. Both halves are asserted here: the address is stable
 * across re-derivations, and an accepted defect stops being a blocker.
 */
import { describe, expect, it } from 'vitest';

import type { CurriculumAuditFinding } from '@/lib/curriculum/audit';
import type {
  CurriculumAuditFindingRecord,
  CurriculumDesignSnapshot,
} from '@/lib/curriculum/design-types';
import {
  acceptedFindings,
  designPreconditions,
  findingDecisions,
  findingFingerprint,
  partitionFindings,
} from '@/lib/curriculum/design-review';

const NOW = '2026-01-01T00:00:00.000Z';

function makeFinding(overrides: Partial<CurriculumAuditFinding> = {}): CurriculumAuditFinding {
  return {
    rule: 'objective_untaught',
    severity: 'error',
    message: '学习目标「SQL 注入」没有被任何条目讲授',
    refKind: 'objective',
    refId: 'objective-1',
    refIds: [],
    layer: 'teach_covers',
    ...overrides,
  };
}

function makeRecord(
  overrides: Partial<CurriculumAuditFindingRecord> = {},
): CurriculumAuditFindingRecord {
  return {
    id: 'finding-1',
    taskId: 'task-1',
    fingerprint: findingFingerprint(makeFinding()),
    ruleCode: 'objective_untaught',
    severity: 'error',
    message: '学习目标「SQL 注入」没有被任何条目讲授',
    refKind: 'objective',
    refId: 'objective-1',
    refIds: [],
    status: 'open',
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

describe('findingFingerprint', () => {
  it('is the same for the same defect re-derived', () => {
    expect(findingFingerprint(makeFinding())).toBe(findingFingerprint(makeFinding()));
  });

  it('does not move when the prose is reworded', () => {
    // The message is the one part of a finding that is expected to change: rules
    // get reworded, and a decision that evaporates because a sentence improved
    // would send the author back to a defect they already considered.
    const reworded = makeFinding({ message: '目标「SQL 注入」缺少讲授（没有任何条目教它）' });
    expect(findingFingerprint(reworded)).toBe(findingFingerprint(makeFinding()));
  });

  it('ignores the order of the rows a finding is about', () => {
    const one = makeFinding({
      rule: 'unit_dependency_out_of_order',
      refKind: 'unitDependency',
      refId: 'edge-1',
      refIds: ['unit-a', 'unit-b'],
    });
    const other = makeFinding({
      rule: 'unit_dependency_out_of_order',
      refKind: 'unitDependency',
      refId: 'edge-1',
      refIds: ['unit-b', 'unit-a', 'unit-a'],
    });
    expect(findingFingerprint(other)).toBe(findingFingerprint(one));
  });

  it('separates different rules, different rows and different kinds', () => {
    const base = findingFingerprint(makeFinding());
    expect(findingFingerprint(makeFinding({ rule: 'objective_uncovered' }))).not.toBe(base);
    expect(findingFingerprint(makeFinding({ refId: 'objective-2' }))).not.toBe(base);
    expect(findingFingerprint(makeFinding({ refKind: 'unit' }))).not.toBe(base);
    expect(findingFingerprint(makeFinding({ refIds: ['node-1'] }))).not.toBe(base);
  });

  it('addresses a task-level finding by its rule alone', () => {
    const brief = makeFinding({
      rule: 'brief_incomplete',
      refKind: 'task',
      refId: 'task-1',
      refIds: [],
      severity: 'error',
      layer: 'outcomes_clear',
    });
    expect(findingFingerprint(brief)).toBe('brief_incomplete|task|task-1|');
  });
});

describe('findingDecisions', () => {
  it('reads an acceptance out of the stored rows', () => {
    const decisions = findingDecisions([makeRecord({ status: 'waived' })]);
    expect(decisions.waived.get(findingFingerprint(makeFinding()))?.id).toBe('finding-1');
  });

  it('treats "resolved" as no decision at all', () => {
    // A review is derived: "I fixed it" is worth nothing until the audit agrees,
    // and reading it as an acceptance would ship a course on a claim the audit
    // disagrees with.
    const decisions = findingDecisions([makeRecord({ status: 'resolved' })]);
    expect(decisions.waived.size).toBe(0);
  });

  it('lets the decision win over a duplicate report of the same defect', () => {
    // The migration deduplicated these and the unique index prevents new ones,
    // but a legacy row that slipped through must not silently un-decide.
    const decisions = findingDecisions([
      makeRecord({ id: 'finding-open', status: 'open' }),
      makeRecord({ id: 'finding-waived', status: 'waived' }),
    ]);
    expect(decisions.waived.get(findingFingerprint(makeFinding()))?.id).toBe('finding-waived');
  });
});

describe('partitionFindings', () => {
  it('keeps an undecided error as a blocker', () => {
    const partitioned = partitionFindings([makeFinding()], findingDecisions([]));
    expect(partitioned.blocking).toHaveLength(1);
    expect(partitioned.accepted).toHaveLength(0);
    expect(partitioned.live).toHaveLength(1);
  });

  it('takes an accepted error out of what blocks and out of what is shown', () => {
    const partitioned = partitionFindings(
      [makeFinding()],
      findingDecisions([makeRecord({ status: 'waived' })]),
    );
    expect(partitioned.blocking).toHaveLength(0);
    expect(partitioned.accepted).toHaveLength(1);
    // `live` is what the step cards list: a decided defect reported again is how
    // a checklist trains its reader to skim.
    expect(partitioned.live).toHaveLength(0);
  });

  it('never lets a warning block, decided or not', () => {
    const warning = makeFinding({ severity: 'warning', rule: 'node_orphan' });
    const partitioned = partitionFindings([warning], findingDecisions([]));
    expect(partitioned.blocking).toHaveLength(0);
    expect(partitioned.advisory).toHaveLength(1);
    expect(partitioned.live).toHaveLength(1);
  });

  it('keeps the audit order in `live`', () => {
    const first = makeFinding({ rule: 'brief_incomplete', layer: 'outcomes_clear' });
    const second = makeFinding({ rule: 'node_orphan', severity: 'warning' });
    const partitioned = partitionFindings([first, second], findingDecisions([]));
    expect(partitioned.live.map((finding) => finding.rule)).toEqual([
      'brief_incomplete',
      'node_orphan',
    ]);
  });

  it('pairs an accepted finding with the decision that accepted it', () => {
    const record = makeRecord({ status: 'waived' });
    const paired = acceptedFindings([makeFinding()], findingDecisions([record]));
    expect(paired).toHaveLength(1);
    expect(paired[0].decision.id).toBe(record.id);
    expect(paired[0].finding.rule).toBe('objective_untaught');
  });
});

describe('designPreconditions', () => {
  const snapshotWith = (statuses: string[]) =>
    ({
      objectives: statuses.map((status, index) => ({ id: `objective-${index}`, status })),
    }) as unknown as CurriculumDesignSnapshot;

  it('refuses a course with no outcomes at all', () => {
    // This used to be the coverage summary's job, which made it a second veto
    // beside the coverage rules — one fact computed twice, free to disagree.
    const conditions = designPreconditions(snapshotWith([]));
    expect(conditions).toHaveLength(1);
    expect(conditions[0]).toContain('学习目标');
  });

  it('counts a draft outcome as one the course is being built around', () => {
    // A course is designed draft-first. Excluding drafts here would refuse every
    // course in progress, and the audit filters on the same predicate.
    expect(designPreconditions(snapshotWith(['draft']))).toEqual([]);
  });

  it('refuses a course whose outcomes are all archived', () => {
    expect(designPreconditions(snapshotWith(['archived', 'archived']))).toHaveLength(1);
  });
});
