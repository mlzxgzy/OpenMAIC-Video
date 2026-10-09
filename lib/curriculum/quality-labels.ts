/**
 * Chinese labels for the quality layers.
 *
 * The layer identifiers (`outcomes_verifiable`, `teach_covers`, …) are the API
 * surface: they are what `quality.layers` is keyed by and what
 * `firstBrokenLayer` returns, so they must not be translated. But they are also
 * the only thing the *user* is shown when an export is refused, and a refusal
 * that says `breaks at "outcomes_verifiable"` is unreadable to the teacher who
 * has to fix it. This module is the one place that maps the identifier to
 * something a person can read, shared by the review panel and the export gate so
 * the two cannot drift apart and disagree about what a layer is called.
 *
 * `satisfies` is load-bearing: adding a layer to {@link CURRICULUM_QUALITY_LAYERS}
 * without adding a label here is a type error, not a silently missing label.
 */
import type { CurriculumQualityLayer } from './audit';

export const CURRICULUM_QUALITY_LAYER_LABELS = {
  outcomes_clear: '目标清晰',
  outcomes_verifiable: '目标可验证',
  support_complete: '知识技能完整',
  dependency_valid: '依赖关系正确',
  curriculum_covers: '大纲覆盖',
  teach_covers: '教学覆盖',
  practice_covers: '练习覆盖',
  assess_covers: '考试覆盖',
  traceable: '可追溯',
} satisfies Record<CurriculumQualityLayer, string>;

/** The label for a layer, falling back to the identifier if one is ever missing. */
export function curriculumQualityLayerLabel(layer: CurriculumQualityLayer): string {
  return CURRICULUM_QUALITY_LAYER_LABELS[layer] ?? layer;
}
