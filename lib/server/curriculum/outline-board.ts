/**
 * 大纲这一步的**读板**：从快照算出 `outlineBoardOf` 要的那份板。
 *
 * 它本来住在 `outline/turn` 路由文件里。加了起草路由之后同一段要读两遍，于是搬出来，
 * **两边都改成调用它**——因为这正是这套代码反复警告的形状：抄一份的第一个后果是两份
 * "这条讲在前那条讲在后"在某一次改动后不再一致，而那不会报错，只会让模型偶尔给出与
 * 界面显示不同的讲授顺序。
 *
 * `declaredHours` 取自任务而不是草稿：学时长在这一步是**作者声明**的数字，模型起草一轮
 * 不该改它——那属于大纲确认时作者自己填的一栏。
 */

import { teachingOrder } from '@/lib/curriculum/design-knowledge';
import { outlineBoardOf, type OutlineBoard } from '@/lib/server/curriculum/outline-step';
import type { CurriculumDesignSnapshot } from '@/lib/curriculum/design-types';

/** `getCurriculumDesignSnapshot` 的返回值——只取这一份板要读的字段。 */
export type OutlineBoardSource = Pick<
  CurriculumDesignSnapshot,
  'units' | 'unitCoverage' | 'objectives' | 'nodes' | 'nodeObjectives' | 'dependencies'
> & { declaredHours: number | null };

export function outlineBoardFromSnapshot(input: OutlineBoardSource): OutlineBoard {
  return outlineBoardOf({
    units: input.units.map((unit) => ({
      id: unit.id,
      title: unit.title,
      unitType: unit.unitType,
      unitRole: unit.unitRole,
      parentId: unit.parentId,
      orderIndex: unit.orderIndex,
      hours: unit.hours,
    })),
    coverage: input.unitCoverage,
    // 归档的目标不进板：它们已经不这门课要承诺的东西了，而让模型看见它们会重新教一遍。
    objectives: input.objectives
      .filter((row) => row.status !== 'archived')
      .map((row) => ({ id: row.id, title: row.title })),
    nodes: input.nodes.map((node) => ({
      id: node.id,
      name: node.name,
      nodeType: node.nodeType,
    })),
    links: input.nodeObjectives,
    edges: input.dependencies,
    teachingOrder: teachingOrder({
      nodes: input.nodes.map((node) => ({
        id: node.id,
        name: node.name,
        nodeType: node.nodeType,
      })),
      dependencies: input.dependencies
        .filter((edge) => edge.sourceKind === 'node' && edge.targetKind === 'node')
        .map((edge) => ({
          id: edge.id,
          sourceId: edge.sourceId,
          targetId: edge.targetId,
          edgeType: edge.edgeType,
        })),
    }).order,
    declaredHours: input.declaredHours,
  });
}
