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
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  mergeSeriesDesign,
  normalizeSeriesDesignDoc,
  seriesDesignGaps,
  seriesDesignPhase,
  validateSeriesDesignPatch,
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
}

const DESIGN_COLUMNS = `id, name, description, audience, default_hours, learner_level,
       training_scenario, application_scene, problem_statement, course_objectives,
       knowledge_system, updated_at`;

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
    },
    design,
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
