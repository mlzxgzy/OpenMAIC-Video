/**
 * `blocking-scope` 的边界。
 *
 * 这个模块的全部意义就是一条边界：**"还没做的事"不是"卡住"**。所以测试不测
 * 实现细节，只钉边界两侧各自的表现——早期阶段不把未来的报告算进来，末期阶段
 * 与导出闸门逐字相等。
 */
import { describe, expect, it } from 'vitest';

import { CURRICULUM_QUALITY_LAYERS, type CurriculumAuditFinding } from '@/lib/curriculum/audit';
import {
  countBlockingFindings,
  layerReachedAt,
  reachedLayersAreMonotonic,
} from '@/lib/curriculum/blocking-scope';
import { CURRICULUM_DESIGN_PHASES } from '@/lib/curriculum/design-types';

function finding(
  rule: CurriculumAuditFinding['rule'],
  severity: CurriculumAuditFinding['severity'],
  layer: CurriculumAuditFinding['layer'],
): CurriculumAuditFinding {
  return {
    rule,
    severity,
    message: `${rule}@${layer}`,
    refKind: null,
    refId: null,
    refIds: [],
    layer,
  };
}

describe('countBlockingFindings', () => {
  it('一个都没走到的阶段不算任何缺陷——那不是缺陷，是进度', () => {
    // 刚建的一目：审核会报"还没有任何条目""还没有题目"，但它们属于后面几步。
    const findings = [
      finding('unit_lesson_undesigned', 'error', 'teach_covers'),
      finding('unit_without_role', 'error', 'curriculum_covers'),
      finding('brief_incomplete', 'error', 'outcomes_clear'),
    ];
    expect(countBlockingFindings(findings, 'task')).toBe(0);
    expect(countBlockingFindings(findings, 'outcomes')).toBe(1); // 只 brief_incomplete
  });

  it('走到哪一层，就只数哪一层及之前的', () => {
    const findings = [
      finding('objective_unverifiable', 'error', 'outcomes_verifiable'),
      finding('objective_no_evidence', 'error', 'outcomes_verifiable'),
      finding('dependency_cycle', 'error', 'dependency_valid'),
      finding('unit_lesson_undesigned', 'error', 'teach_covers'),
    ];
    expect(countBlockingFindings(findings, 'graph')).toBe(3);
    expect(countBlockingFindings(findings, 'teaching')).toBe(4);
  });

  it('review 阶段与导出闸门口径一致：全部 error 都算数', () => {
    const findings = CURRICULUM_QUALITY_LAYERS.map((layer, i) =>
      finding('unit_without_role', i % 2 === 0 ? 'error' : 'warning', layer),
    );
    // review 之后每一层都到达，所以计数 = error 数，与 `evaluation.blocking`
    // 在设计走完时必然相等——这是驾驶舱不必另设一套口径的原因。
    expect(countBlockingFindings(findings, 'review')).toBe(
      findings.filter((f) => f.severity === 'error').length,
    );
  });

  it('warning 与 note 从不计入：红色计数只该说会拦生成的事', () => {
    const findings = [
      finding('objective_duplicate', 'warning', 'outcomes_clear'),
      finding('node_orphan', 'info', 'outcomes_clear'),
      finding('objective_unverifiable', 'error', 'outcomes_clear'),
    ];
    expect(countBlockingFindings(findings, 'assessment')).toBe(1);
  });

  it('空发现列表在每个阶段都是 0', () => {
    for (const phase of CURRICULUM_DESIGN_PHASES) {
      expect(countBlockingFindings([], phase)).toBe(0);
    }
  });
});

describe('层与阶段的对应', () => {
  it('可达层随阶段单调不减，且每个阶段没有重复层', () => {
    expect(reachedLayersAreMonotonic()).toBe(true);
  });

  it('每一层都能被某一阶段到达，否则那一层的真缺陷永远隐形', () => {
    for (const layer of CURRICULUM_QUALITY_LAYERS) {
      const reached = CURRICULUM_DESIGN_PHASES.some((phase) => layerReachedAt(layer, phase));
      expect(reached, `${layer} 没有对应阶段`).toBe(true);
    }
  });

  it('task 阶段什么都没走到：简介还没写就是还没写', () => {
    expect(CURRICULUM_DESIGN_PHASES.filter((p) => layerReachedAt('outcomes_clear', p))).toEqual([
      'outcomes',
      'graph',
      'outline',
      'teaching',
      'assessment',
      'review',
    ]);
  });

  it('review 之后全部层都到达', () => {
    for (const layer of CURRICULUM_QUALITY_LAYERS) {
      expect(layerReachedAt(layer, 'review')).toBe(true);
    }
  });
});
