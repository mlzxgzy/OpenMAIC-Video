/**
 * 系列级设计文档的读 / 写。
 *
 * 文档存在 `curriculum_series` 的两列 JSONB（`course_objectives` /
 * `knowledge_system`）与五个方向列上。读的时候一律经过
 * `normalizeSeriesDesignDoc`：库里可能存着上一版写进去的形状，而读接口挂掉
 * 比少一行更糟。写的时候一律经过 `validateSeriesDesignPatch`：用户点的是保存，
 * 每一条都必须完整。
 *
 * 不抛设计层的错误类型（`CurriculumDesignNotFoundError` 等）是有意的：那个模块
 * 反过来要读系列方向做继承，互相 import 会成环。这里自带两个错误类型，路由把
 * 它们映射成 404 / 400。
 */
import { createHash } from 'node:crypto';

import type { Queryable } from '@openmaic/storage/document/pg';

import {
  canonicalSeriesDesign,
  mergeSeriesDesign,
  normalizeSeriesDesignDoc,
  seriesDesignGaps,
  seriesDesignPhase,
  validateSeriesDesignPatch,
  type OutlineDesignDrift,
  type SeriesDesignCoverage,
  type SeriesDesignDoc,
  type SeriesDesignSnapshot,
} from '@/lib/curriculum/series-design';

/** 系列不存在（或不属于当前 owner）。 */
export class SeriesDesignNotFoundError extends Error {
  constructor(message = '课程系列不存在') {
    super(message);
    this.name = 'SeriesDesignNotFoundError';
  }
}

/** 请求体不构成一次合法写入。消息已点名具体字段，路由原样回给用户。 */
export class SeriesDesignValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SeriesDesignValidationError';
  }
}

interface SeriesDesignRow extends Record<string, unknown> {
  id: string;
  name: string;
  description: string | null;
  audience: string | null;
  default_hours: number | string | null;
  learner_level: string | null;
  training_scenario: string | null;
  application_scene: string | null;
  problem_statement: string | null;
  course_objectives: unknown;
  knowledge_system: unknown;
  updated_at: Date | string;
  design_updated_at: Date | string | null;
}

const DESIGN_COLUMNS = `id, name, description, audience, default_hours, learner_level,
       training_scenario, application_scene, problem_statement, course_objectives,
       knowledge_system, updated_at, design_updated_at`;

function numeric(value: number | string | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

function toSnapshot(row: SeriesDesignRow): SeriesDesignSnapshot {
  const { design } = normalizeSeriesDesignDoc({
    audience: row.audience,
    defaultHours: numeric(row.default_hours),
    learnerLevel: row.learner_level,
    trainingScenario: row.training_scenario,
    applicationScene: row.application_scene,
    problemStatement: row.problem_statement,
    courseObjectives: row.course_objectives,
    knowledgeSystem: row.knowledge_system,
  });
  return {
    series: {
      id: row.id,
      name: row.name,
      description: row.description,
      audience: row.audience,
      defaultHours: numeric(row.default_hours),
      learnerLevel: row.learner_level,
      trainingScenario: row.training_scenario,
      applicationScene: row.application_scene,
      problemStatement: row.problem_statement,
      updatedAt: iso(row.updated_at),
      designUpdatedAt: row.design_updated_at === null ? null : iso(row.design_updated_at),
    },
    design,
    designFingerprint: fingerprintSeriesDesign(design),
    phase: seriesDesignPhase(design),
    gaps: seriesDesignGaps(design),
    objectiveTitles: Object.fromEntries(
      design.objectives.map((objective) => [objective.id, objective.title]),
    ),
    nodeNames: Object.fromEntries(design.nodes.map((node) => [node.id, node.name])),
  };
}

async function readRow(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<SeriesDesignRow | null> {
  const result = await queryable.query<SeriesDesignRow>(
    `SELECT ${DESIGN_COLUMNS} FROM curriculum_series WHERE owner_id = $1 AND id = $2`,
    [ownerId, seriesId],
  );
  return result.rows[0] ?? null;
}

export async function getSeriesDesign(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<SeriesDesignSnapshot | null> {
  const row = await readRow(queryable, ownerId, seriesId);
  return row ? toSnapshot(row) : null;
}

/**
 * 把一次 patch 合并进设计文档。`undefined` 表示"这一项不改"，空数组表示"清空"，
 * 两者不能混为一谈：清空课程目标是用户明确删掉它们，而不改是这次请求没提到它。
 */
export async function updateSeriesDesign(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  body: unknown,
): Promise<SeriesDesignSnapshot> {
  const row = await readRow(queryable, ownerId, seriesId);
  if (!row) throw new SeriesDesignNotFoundError();
  const current = toSnapshot(row).design;

  let patch;
  try {
    patch = validateSeriesDesignPatch(body, current);
  } catch (error) {
    if (error instanceof Error && error.name === 'SeriesDesignInvalidError') {
      throw new SeriesDesignValidationError(error.message);
    }
    throw error;
  }

  const next: SeriesDesignDoc = mergeSeriesDesign(current, patch);
  const direction = next.direction;

  const result = await queryable.query<SeriesDesignRow>(
    `UPDATE curriculum_series
        SET audience = $3,
            default_hours = $4,
            learner_level = $5,
            training_scenario = $6,
            application_scene = $7,
            problem_statement = $8,
            course_objectives = $9::jsonb,
            knowledge_system = $10::jsonb,
            design_updated_at = now(),
            updated_at = now()
      WHERE owner_id = $1 AND id = $2
      RETURNING ${DESIGN_COLUMNS}`,
    [
      ownerId,
      seriesId,
      direction.audience,
      direction.durationHours,
      direction.learnerLevel,
      direction.trainingScenario,
      direction.applicationScene,
      direction.problemStatement,
      JSON.stringify(next.objectives),
      JSON.stringify({ nodes: next.nodes }),
    ],
  );
  const updated = result.rows[0];
  if (!updated) throw new SeriesDesignNotFoundError();
  return toSnapshot(updated);
}

/**
 * 目创建 / 门禁要用的方向：只读五个可继承字段。与 `getSeriesDesign` 分开，
 * 是因为调用方（design-store）只需要这几列，读整份文档会把知识体系一起搬进
 * 一个只关心受众的代码路径。
 */
export async function readSeriesDirectionForInheritance(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
): Promise<{
  audience: string | null;
  learnerLevel: string | null;
  trainingScenario: string | null;
  applicationScene: string | null;
  problemStatement: string | null;
  defaultHours: number | null;
} | null> {
  const result = await queryable.query<{
    audience: string | null;
    learner_level: string | null;
    training_scenario: string | null;
    application_scene: string | null;
    problem_statement: string | null;
    default_hours: number | string | null;
  }>(
    `SELECT audience, learner_level, training_scenario, application_scene, problem_statement,
            default_hours
       FROM curriculum_series WHERE owner_id = $1 AND id = $2`,
    [ownerId, seriesId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    audience: row.audience,
    learnerLevel: row.learner_level,
    trainingScenario: row.training_scenario,
    applicationScene: row.application_scene,
    problemStatement: row.problem_statement,
    defaultHours: numeric(row.default_hours),
  };
}

/**
 * 设计文档的内容指纹：规范化文本的 SHA-256 前 128 位。
 *
 * 截断到 16 个十六进制字符是够用且不占地方：这里比较的是同一条编辑线上前后
 * 两版设计，不是对抗性输入；真撞了也只会漏一次提示，不会写坏数据。
 */
export function fingerprintSeriesDesign(design: SeriesDesignDoc): string {
  return createHash('sha256').update(canonicalSeriesDesign(design)).digest('hex').slice(0, 16);
}

/**
 * 「按旧版设计生成」的章 / 节 / 目各有多少。
 *
 * 一次两条聚合查询，而不是把整张表读回内存数：这个读接口挂在驾驶舱首屏，也挂在
 * 系列设计页保存之后，两处都不该为了一次提示把几十行 JSON 搬两遍。
 *
 * 传 `snapshot` 而不是只传指纹，是为了让返回里的 `designUpdatedAt` 与 `fingerprint`
 * 来自同一次读——分开读会让"设计刚保存、指纹却是旧的"这种窗口出现在提示里。
 */
export async function readOutlineDesignDrift(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  snapshot: Pick<SeriesDesignSnapshot, 'designFingerprint'> & {
    series: Pick<SeriesDesignSnapshot['series'], 'designUpdatedAt'>;
  },
): Promise<OutlineDesignDrift> {
  const fingerprint = snapshot.designFingerprint;
  const nodes = await queryable.query<{ node_type: string; stale: string; total: string }>(
    `SELECT node_type,
            count(*) FILTER (
              WHERE design_fingerprint IS NOT NULL AND design_fingerprint <> $3
            ) AS stale,
            count(*) AS total
       FROM curriculum_series_outline_node
      WHERE owner_id = $1 AND series_id = $2
      GROUP BY node_type`,
    [ownerId, seriesId, fingerprint],
  );
  const items = await queryable.query<{ stale: string; total: string }>(
    `SELECT count(*) FILTER (
              WHERE design_fingerprint IS NOT NULL AND design_fingerprint <> $3
            ) AS stale,
            count(*) AS total
       FROM curriculum_task
      WHERE owner_id = $1 AND series_id = $2`,
    [ownerId, seriesId, fingerprint],
  );

  const countOf = (
    rows: readonly { node_type: string; stale: string; total: string }[],
    type: string,
  ) => {
    const row = rows.find((candidate) => candidate.node_type === type);
    return { stale: Number(row?.stale ?? 0), total: Number(row?.total ?? 0) };
  };
  const chapters = countOf(nodes.rows, 'chapter');
  const sections = countOf(nodes.rows, 'section');
  const itemsRow = items.rows[0];

  return {
    designUpdatedAt: snapshot.series.designUpdatedAt,
    fingerprint,
    stale: {
      chapters: chapters.stale,
      sections: sections.stale,
      items: Number(itemsRow?.stale ?? 0),
    },
    total: {
      chapters: chapters.total,
      sections: sections.total,
      items: Number(itemsRow?.total ?? 0),
    },
  };
}

/**
 * 课程目标 / 知识点在目里的落点覆盖。
 *
 * 两类「已落点」的证据都来自目自己的第 2 / 3 步：`curriculum_objective
 * .series_objective_id` 与 `curriculum_learning_node.series_node_id`。不 JOIN
 * 设计文档的 JSONB，是因为落点这件事的定义就是「目里真的有一行承接过它」，
 * 而不是「模型觉得大纲里有」。别的系列的行不会被算进来（按 series_id 过滤），
 * 否则复制过设计的两个系列会互相"证明"对方已覆盖。
 *
 * 没有大纲时调用方不展示这份读数：全部未落点是必然的，显示出来只是噪声。
 */
export async function readSeriesDesignCoverage(
  queryable: Queryable,
  ownerId: string,
  seriesId: string,
  design: SeriesDesignDoc,
): Promise<SeriesDesignCoverage> {
  if (design.objectives.length === 0 && design.nodes.length === 0) {
    return {
      objectives: { total: 0, unclaimed: 0, titles: [] },
      nodes: { total: 0, unclaimed: 0, names: [] },
    };
  }

  const claimedObjectives = await queryable.query<{ id: string }>(
    `SELECT DISTINCT o.series_objective_id AS id
       FROM curriculum_objective o
       JOIN curriculum_task t ON t.id = o.task_id AND t.owner_id = o.owner_id
      WHERE o.owner_id = $1 AND t.series_id = $2 AND o.series_objective_id IS NOT NULL`,
    [ownerId, seriesId],
  );
  const claimedNodes = await queryable.query<{ id: string }>(
    `SELECT DISTINCT n.series_node_id AS id
       FROM curriculum_learning_node n
       JOIN curriculum_task t ON t.id = n.task_id AND t.owner_id = n.owner_id
      WHERE n.owner_id = $1 AND t.series_id = $2 AND n.series_node_id IS NOT NULL`,
    [ownerId, seriesId],
  );

  const claimedObjectiveIds = new Set(claimedObjectives.rows.map((row) => row.id));
  const claimedNodeIds = new Set(claimedNodes.rows.map((row) => row.id));
  const unclaimedObjectives = design.objectives.filter(
    (objective) => !claimedObjectiveIds.has(objective.id),
  );
  const unclaimedNodes = design.nodes.filter((node) => !claimedNodeIds.has(node.id));

  return {
    objectives: {
      total: design.objectives.length,
      unclaimed: unclaimedObjectives.length,
      titles: unclaimedObjectives.map((objective) => objective.title),
    },
    nodes: {
      total: design.nodes.length,
      unclaimed: unclaimedNodes.length,
      names: unclaimedNodes.map((node) => node.name),
    },
  };
}
