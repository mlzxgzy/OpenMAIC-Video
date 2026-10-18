/**
 * 七步归属表：哪几步属于系列，哪几步属于目。
 *
 * 这张表本身是用户问题的答案（「每个目都有 7 步需要做？？？」），所以它值得被钉住，
 * 而不是只活在注释里。三个断言各自防一种漂移：
 *
 * 1. 前 3 步是系列、后 4 步是目——顺序恰好连续，不是"大概分成两组"。
 * 2. 系列层那三步必须是**继承 / 承接**，本目那四步必须是**自己的活**；出现
 *    「系列层 + own」这种组合，说明有人把某一层挪错了组而没人发现。
 * 3. 表覆盖全部阶段——`Record` 已经是编译期保证，这里再确认一遍运行期拿到的
 *    顺序与阶段机一致（阶段机若插入一步，界面上的分组会漏掉它）。
 */
import { describe, expect, it } from 'vitest';

import { CURRICULUM_DESIGN_PHASE_ORDER } from '@/lib/curriculum/design-editing';
import {
  ITEM_OWNED_PHASES,
  SERIES_OWNED_PHASES,
  STEP_OWNERSHIP,
  isSeriesOwned,
  stepOwner,
} from '@/lib/curriculum/step-ownership';

describe('七步归属', () => {
  it('前 3 步属于系列，后 4 步属于目，且顺序与阶段机一致', () => {
    expect(SERIES_OWNED_PHASES).toEqual(['task', 'outcomes', 'graph']);
    expect(ITEM_OWNED_PHASES).toEqual(['outline', 'teaching', 'assessment', 'review']);
    expect([...SERIES_OWNED_PHASES, ...ITEM_OWNED_PHASES]).toEqual([
      ...CURRICULUM_DESIGN_PHASE_ORDER,
    ]);
  });

  it('系列层的目角色只能是继承或承接，本目层只能是自己的活', () => {
    for (const phase of SERIES_OWNED_PHASES) {
      expect(['inherit', 'select']).toContain(STEP_OWNERSHIP[phase].itemDuty);
    }
    for (const phase of ITEM_OWNED_PHASES) {
      expect(STEP_OWNERSHIP[phase].itemDuty).toBe('own');
    }
  });

  it('第 1 步是继承，第 2/3 步是承接——三种目角色都真的用上了', () => {
    expect(STEP_OWNERSHIP.task.itemDuty).toBe('inherit');
    expect(STEP_OWNERSHIP.outcomes.itemDuty).toBe('select');
    expect(STEP_OWNERSHIP.graph.itemDuty).toBe('select');
  });

  it('每一步都有归属说明，且说明不是空话', () => {
    for (const phase of CURRICULUM_DESIGN_PHASE_ORDER) {
      expect(STEP_OWNERSHIP[phase].note.length).toBeGreaterThan(10);
      expect(stepOwner(phase)).toBe(isSeriesOwned(phase) ? 'series' : 'item');
    }
  });
});
