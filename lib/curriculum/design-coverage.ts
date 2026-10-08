/**
 * Design coverage — the outcome-first answer to "is this course covered?".
 *
 * This replaces the old `coverage.ts`, which ranked knowledge points by a
 * single `coverage_level` of introduced / practiced / mastered. That model
 * could not answer the question that matters: for a given learning outcome,
 * is it taught, trained, and verified? It only ever said whether some course
 * had mentioned a point.
 *
 * The old module is left in place because the legacy knowledge-relations
 * screen still calls it; S4 removes that screen and this becomes the only one.
 *
 * Every row here is one outcome, because a course is accountable for outcomes,
 * not for its topic list.
 */

import { CURRICULUM_QUALITY_LAYERS, type CurriculumQualityLayer } from './audit';
import { buildTraceabilityMatrix, type TraceabilityRow } from './traceability';
import type { CurriculumDesignSnapshot, CurriculumObjectiveRecord } from './design-types';

export type { TraceabilityRow };

export interface ObjectiveCoverage {
  objectiveId: string;
  code: string | null;
  title: string;
  objectiveType: CurriculumObjectiveRecord['objectiveType'];
  difficulty: CurriculumObjectiveRecord['difficulty'];
  /** Item ids that teach / practise / assess it, in outline order. */
  teach: string[];
  practice: string[];
  assess: string[];
  /** The three booleans the audit treats as the closed loop. */
  teaches: boolean;
  practices: boolean;
  assesses: boolean;
  /** teach && practice && assess. */
  complete: boolean;
  /** How many items touch this outcome at all. */
  itemCount: number;
}

export interface DesignCoverageReport {
  objectives: ObjectiveCoverage[];
  /** Items in outline order, which are the matrix columns. */
  unitIds: string[];
  /** Counts per coverage kind, for the summary strip. */
  counts: {
    total: number;
    taught: number;
    practiced: number;
    assessed: number;
    complete: number;
  };
  /** The outcomes that break the loop, most incomplete first. */
  gaps: ObjectiveCoverage[];
}

function itemOrderIndex(snapshot: CurriculumDesignSnapshot): Map<string, number> {
  return new Map(snapshot.units.map((unit) => [unit.id, unit.orderIndex]));
}

function byOutlineOrder(unitIds: string[], order: Map<string, number>): string[] {
  return [...unitIds].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}

/**
 * Build the outcome × item coverage report.
 *
 * A `complete` objective is one that is taught, practised and assessed. The
 * count of complete outcomes, over the count of total outcomes, is the single
 * number that says whether the course closes its loop — and it is the number
 * the quality gate refuses to export without.
 */
export function buildDesignCoverage(snapshot: CurriculumDesignSnapshot): DesignCoverageReport {
  const order = itemOrderIndex(snapshot);
  const { unitIds, rows } = buildTraceabilityMatrix(snapshot);
  const objectiveById = new Map(snapshot.objectives.map((o) => [o.id, o]));

  const objectives: ObjectiveCoverage[] = rows.map((row) => {
    const objective = objectiveById.get(row.objectiveId);
    const teach = byOutlineOrder(row.teach, order);
    const practice = byOutlineOrder(row.practice, order);
    const assess = byOutlineOrder(row.assess, order);
    return {
      objectiveId: row.objectiveId,
      code: objective?.code ?? null,
      title: row.title,
      objectiveType: objective?.objectiveType ?? 'skill',
      difficulty: objective?.difficulty ?? 'basic',
      teach,
      practice,
      assess,
      teaches: teach.length > 0,
      practices: practice.length > 0,
      assesses: assess.length > 0,
      complete: row.complete,
      itemCount: new Set([...teach, ...practice, ...assess]).size,
    };
  });

  const counts = {
    total: objectives.length,
    taught: objectives.filter((o) => o.teaches).length,
    practiced: objectives.filter((o) => o.practices).length,
    assessed: objectives.filter((o) => o.assesses).length,
    complete: objectives.filter((o) => o.complete).length,
  };

  // Worst first: an outcome missing assessment is more urgent than one missing
  // a second practice item.
  const gapRank = (o: ObjectiveCoverage) =>
    (o.teaches ? 0 : 8) + (o.practices ? 0 : 4) + (o.assesses ? 0 : 2);
  const gaps = objectives
    .filter((o) => !o.complete)
    .sort((a, b) => gapRank(b) - gapRank(a) || a.title.localeCompare(b.title));

  return { objectives, unitIds, counts, gaps };
}

export interface CoverageVerdict {
  /** Whether the whole course closes its loop. */
  complete: boolean;
  /** 0–1, the share of outcomes that are taught, practised and assessed. */
  ratio: number;
  /** The layers that hold, in chain order. */
  layers: CurriculumQualityLayer[];
  /** Human-readable one-liner for the summary strip. */
  summary: string;
}

/**
 * Reduce the coverage report to the verdict the workspace shows and the export
 * gate reads. Kept separate from the audit: coverage is a measurement, the
 * audit is a judgement. A course can have full coverage and still fail the
 * audit on a cycle, a duplicate or a missing brief.
 */
export function summariseCoverage(report: DesignCoverageReport): CoverageVerdict {
  const { total, complete, taught, practiced, assessed } = report.counts;
  const ratio = total === 0 ? 0 : complete / total;
  const layers: CurriculumQualityLayer[] = [];
  if (total > 0 && taught === total) layers.push('teach_covers');
  if (total > 0 && practiced === total) layers.push('practice_covers');
  if (total > 0 && assessed === total) layers.push('assess_covers');
  const complete_ = total > 0 && complete === total;
  const summary =
    total === 0
      ? 'No learning outcomes yet'
      : `${complete}/${total} outcomes are taught, practised and assessed`;
  return { complete: complete_, ratio, layers, summary };
}

/** The chain the workspace renders as the quality strip, in order. */
export const CURRICULUM_COVERAGE_LAYER_ORDER: CurriculumQualityLayer[] = [
  ...CURRICULUM_QUALITY_LAYERS,
];
