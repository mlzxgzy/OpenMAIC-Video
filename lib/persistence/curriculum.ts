/**
 * The course-product tables behind the curriculum ledger. They are separate
 * from `document_stages` on purpose: a `stage` is generated content, while a
 * curriculum course is the stable entity a program plan points at. The link
 * is `curriculum_course.stage_id`.
 *
 * This store is provisioned lazily by the first curriculum API request, under
 * the same bootstrap lock every other app store uses.
 */
import type { Queryable } from '@openmaic/storage/document/pg';
import { applySchemaMigrations, type SchemaMigrationSet } from '@openmaic/storage/pg-migrations';

const CURRICULUM_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_series (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name)
);

CREATE INDEX IF NOT EXISTS curriculum_series_owner_idx
  ON curriculum_series (owner_id, created_at);

CREATE TABLE IF NOT EXISTS curriculum_course (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  series_id    TEXT REFERENCES curriculum_series(id) ON DELETE SET NULL,
  stage_id     TEXT,
  title        TEXT NOT NULL,
  code         TEXT,
  description  TEXT,
  chapter      TEXT,
  section      TEXT,
  lesson_order INTEGER NOT NULL DEFAULT 0,
  credits      DOUBLE PRECISION,
  hours        DOUBLE PRECISION,
  semester     TEXT,
  status       TEXT NOT NULL DEFAULT 'active',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_course_status_known CHECK (status IN ('draft','active','archived'))
);

CREATE INDEX IF NOT EXISTS curriculum_course_owner_series_idx
  ON curriculum_course (owner_id, series_id, lesson_order, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_course_owner_stage_idx
  ON curriculum_course (owner_id, stage_id)
  WHERE stage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS curriculum_course_relation (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  source_course_id  TEXT NOT NULL REFERENCES curriculum_course(id) ON DELETE CASCADE,
  target_course_id  TEXT NOT NULL REFERENCES curriculum_course(id) ON DELETE CASCADE,
  relation_type     TEXT NOT NULL,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_course_relation_distinct CHECK (source_course_id <> target_course_id),
  CONSTRAINT curriculum_course_relation_type_known CHECK
    (relation_type IN ('prerequisite','follow-up','related','supports'))
);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_relation_owner_edge_idx
  ON curriculum_course_relation (owner_id, source_course_id, target_course_id, relation_type);

CREATE INDEX IF NOT EXISTS curriculum_relation_owner_source_idx
  ON curriculum_course_relation (owner_id, source_course_id);

CREATE INDEX IF NOT EXISTS curriculum_relation_owner_target_idx
  ON curriculum_course_relation (owner_id, target_course_id);
`;

/**
 * Knowledge-point layer: points are owner-scoped and may belong to one
 * series, have an optional parent for a tree, and be bound to many courses.
 * The course link table carries a coverage level because the same point can
 * be introduced in one course and practiced/mastered in another.
 */
const CURRICULUM_KNOWLEDGE_POINTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_knowledge_point (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  series_id   TEXT REFERENCES curriculum_series(id) ON DELETE SET NULL,
  parent_id   TEXT REFERENCES curriculum_knowledge_point(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  code        TEXT,
  type        TEXT NOT NULL DEFAULT 'knowledge',
  difficulty  TEXT,
  summary     TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_kp_type_known CHECK
    (type IN ('knowledge','skill','competency')),
  CONSTRAINT curriculum_kp_difficulty_known CHECK
    (difficulty IS NULL OR difficulty IN ('intro','basic','intermediate','advanced'))
);

CREATE INDEX IF NOT EXISTS curriculum_kp_owner_series_idx
  ON curriculum_knowledge_point (owner_id, series_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS curriculum_kp_owner_parent_idx
  ON curriculum_knowledge_point (owner_id, parent_id, sort_order);

CREATE TABLE IF NOT EXISTS curriculum_course_knowledge_point (
  course_id          TEXT NOT NULL REFERENCES curriculum_course(id) ON DELETE CASCADE,
  knowledge_point_id TEXT NOT NULL REFERENCES curriculum_knowledge_point(id) ON DELETE CASCADE,
  owner_id           TEXT NOT NULL,
  coverage_level     TEXT NOT NULL DEFAULT 'introduced',
  sort_order         INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (course_id, knowledge_point_id),
  CONSTRAINT curriculum_course_kp_coverage_known CHECK
    (coverage_level IN ('introduced','practiced','mastered'))
);

CREATE INDEX IF NOT EXISTS curriculum_course_kp_owner_point_idx
  ON curriculum_course_knowledge_point (owner_id, knowledge_point_id);

CREATE INDEX IF NOT EXISTS curriculum_course_kp_owner_course_idx
  ON curriculum_course_knowledge_point (owner_id, course_id, sort_order);
`;

/**
 * Knowledge-point graph edges. The parent/child tree lives on
 * `curriculum_knowledge_point.parent_id`; this table carries the additional
 * direction-aware learning relations.
 */
const CURRICULUM_KNOWLEDGE_POINT_RELATIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_knowledge_point_relation (
  id                        TEXT PRIMARY KEY,
  owner_id                  TEXT NOT NULL,
  source_knowledge_point_id TEXT NOT NULL REFERENCES curriculum_knowledge_point(id) ON DELETE CASCADE,
  target_knowledge_point_id TEXT NOT NULL REFERENCES curriculum_knowledge_point(id) ON DELETE CASCADE,
  relation_type             TEXT NOT NULL,
  note                      TEXT,
  created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_kp_relation_distinct CHECK
    (source_knowledge_point_id <> target_knowledge_point_id),
  CONSTRAINT curriculum_kp_relation_type_known CHECK
    (relation_type IN ('prerequisite','follow-up','contains','related'))
);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_kp_relation_owner_edge_idx
  ON curriculum_knowledge_point_relation
    (owner_id, source_knowledge_point_id, target_knowledge_point_id, relation_type);

CREATE INDEX IF NOT EXISTS curriculum_kp_relation_owner_source_idx
  ON curriculum_knowledge_point_relation (owner_id, source_knowledge_point_id);

CREATE INDEX IF NOT EXISTS curriculum_kp_relation_owner_target_idx
  ON curriculum_knowledge_point_relation (owner_id, target_knowledge_point_id);
`;

/**
 * One-click assembly runs. A job binds a curriculum course to a server-side
 * generation run so the runner's committed events can write the produced
 * `stage_id` back into the course ledger. `run_id` is filled after the run is
 * created; the unique index keeps one run from belonging to two courses.
 */
const CURRICULUM_GENERATION_JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_generation_job (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  course_id      TEXT NOT NULL REFERENCES curriculum_course(id) ON DELETE CASCADE,
  run_id         TEXT,
  stage_id       TEXT,
  status         TEXT NOT NULL DEFAULT 'queued',
  outline_review TEXT NOT NULL DEFAULT 'auto',
  request        JSONB NOT NULL DEFAULT '{}'::jsonb,
  error          JSONB,
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_generation_job_status_known CHECK
    (status IN ('queued','running','awaiting_outline','paused','completed','failed','ended')),
  CONSTRAINT curriculum_generation_job_review_known CHECK
    (outline_review IN ('wait','countdown','auto'))
);

CREATE INDEX IF NOT EXISTS curriculum_generation_job_owner_status_idx
  ON curriculum_generation_job (owner_id, status, created_at);

CREATE INDEX IF NOT EXISTS curriculum_generation_job_course_idx
  ON curriculum_generation_job (owner_id, course_id, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_generation_job_owner_run_idx
  ON curriculum_generation_job (owner_id, run_id)
  WHERE run_id IS NOT NULL;
`;

export const CURRICULUM_MIGRATIONS: SchemaMigrationSet = {
  store: 'curriculum',
  migrations: [
    { version: 1, name: 'baseline', up: CURRICULUM_SCHEMA, transaction: false },
    {
      version: 2,
      name: 'knowledge_points',
      up: CURRICULUM_KNOWLEDGE_POINTS_SCHEMA,
      transaction: true,
    },
    {
      version: 3,
      name: 'knowledge_point_relations',
      up: CURRICULUM_KNOWLEDGE_POINT_RELATIONS_SCHEMA,
      transaction: true,
    },
    {
      version: 4,
      name: 'generation_jobs',
      up: CURRICULUM_GENERATION_JOBS_SCHEMA,
      transaction: true,
    },
  ],
};

export async function ensureCurriculumSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, CURRICULUM_MIGRATIONS);
}
