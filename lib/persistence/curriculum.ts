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

/**
 * Durable batch generation queue. The batch row is the operator-facing unit
 * (pause/resume/cancel, progress); each item owns one assembled course and is
 * claimed sequentially under the generation-run per-owner limit. `request`
 * carries the server-built assembly plan and parsed run options, so a queued
 * item does not depend on later edits to the knowledge library.
 */
const CURRICULUM_BATCHES_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_batch (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'queued',
  started_at   TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_batch_status_known CHECK
    (status IN ('queued','running','paused','completed','failed','cancelled'))
);

CREATE INDEX IF NOT EXISTS curriculum_batch_owner_status_idx
  ON curriculum_batch (owner_id, status, created_at);

CREATE TABLE IF NOT EXISTS curriculum_batch_item (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  batch_id          TEXT NOT NULL REFERENCES curriculum_batch(id) ON DELETE CASCADE,
  position          INTEGER NOT NULL,
  course_id         TEXT REFERENCES curriculum_course(id) ON DELETE SET NULL,
  title             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'queued',
  attempts          INTEGER NOT NULL DEFAULT 0,
  max_attempts      INTEGER NOT NULL DEFAULT 1,
  request           JSONB NOT NULL DEFAULT '{}'::jsonb,
  generation_job_id TEXT REFERENCES curriculum_generation_job(id) ON DELETE SET NULL,
  run_id            TEXT,
  stage_id          TEXT,
  error             JSONB,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (batch_id, position),
  CONSTRAINT curriculum_batch_item_status_known CHECK
    (status IN ('queued','starting','running','awaiting_outline','paused',
                'completed','failed','ended','cancelled'))
);

CREATE INDEX IF NOT EXISTS curriculum_batch_item_owner_status_idx
  ON curriculum_batch_item (owner_id, status, created_at);

CREATE INDEX IF NOT EXISTS curriculum_batch_item_batch_idx
  ON curriculum_batch_item (batch_id, position);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_batch_item_owner_run_idx
  ON curriculum_batch_item (owner_id, run_id)
  WHERE run_id IS NOT NULL;
`;

/**
 * Durable MP4 export queue. The browser is the only place that can build the
 * Hyperframes ZIP (off-screen DOM snapshots + the local asset view), so the
 * server owns the ledger and admission; a page-side worker claims one queued
 * job, builds/uploads it through the existing render route, and reports the
 * render job id and progress back. The render service still owns the actual
 * queueing, concurrency limit and artifact lifecycle.
 */
const CURRICULUM_EXPORT_JOBS_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_export_job (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  course_id         TEXT REFERENCES curriculum_course(id) ON DELETE SET NULL,
  batch_item_id     TEXT REFERENCES curriculum_batch_item(id) ON DELETE SET NULL,
  stage_id          TEXT NOT NULL,
  title             TEXT NOT NULL DEFAULT '',
  status            TEXT NOT NULL DEFAULT 'queued',
  resolution        TEXT NOT NULL DEFAULT '1080p',
  fps               INTEGER NOT NULL DEFAULT 30,
  quality           TEXT NOT NULL DEFAULT 'standard',
  burn_in_subtitles BOOLEAN NOT NULL DEFAULT false,
  progress          DOUBLE PRECISION NOT NULL DEFAULT 0,
  render_job_id     TEXT,
  attempts          INTEGER NOT NULL DEFAULT 0,
  error             JSONB,
  started_at        TIMESTAMPTZ,
  completed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_export_job_status_known CHECK
    (status IN ('queued','building','submitting','rendering',
                'succeeded','failed','cancelled')),
  CONSTRAINT curriculum_export_job_resolution_known CHECK
    (resolution IN ('720p','1080p','4k')),
  CONSTRAINT curriculum_export_job_fps_known CHECK (fps IN (24,30,60)),
  CONSTRAINT curriculum_export_job_quality_known CHECK
    (quality IN ('draft','standard','high'))
);

CREATE INDEX IF NOT EXISTS curriculum_export_job_owner_status_idx
  ON curriculum_export_job (owner_id, status, created_at);

CREATE INDEX IF NOT EXISTS curriculum_export_job_batch_item_idx
  ON curriculum_export_job (owner_id, batch_item_id, created_at);

CREATE INDEX IF NOT EXISTS curriculum_export_job_stage_idx
  ON curriculum_export_job (owner_id, stage_id, created_at);
`;

/**
 * Program-plan layer: a training program (专业/方向), its published versions
 * (培养方案版本), graduation indicators (毕业要求/指标点), the planned course
 * list (课程-学期), and the course-indicator support matrix. The matrix points
 * at `curriculum_program_course`, not directly at `curriculum_course`, so a
 * planned slot can be scored before a generated classroom exists.
 */
const CURRICULUM_PROGRAM_PLAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_program (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  name        TEXT NOT NULL,
  code        TEXT,
  description TEXT,
  status      TEXT NOT NULL DEFAULT 'active',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (owner_id, name),
  CONSTRAINT curriculum_program_status_known CHECK
    (status IN ('draft','active','archived'))
);

CREATE INDEX IF NOT EXISTS curriculum_program_owner_status_idx
  ON curriculum_program (owner_id, status, created_at);

CREATE TABLE IF NOT EXISTS curriculum_program_version (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  program_id     TEXT NOT NULL REFERENCES curriculum_program(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  version        TEXT,
  grade_year     TEXT,
  description    TEXT,
  status         TEXT NOT NULL DEFAULT 'draft',
  target_credits DOUBLE PRECISION,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_id, name),
  CONSTRAINT curriculum_program_version_status_known CHECK
    (status IN ('draft','active','archived')),
  CONSTRAINT curriculum_program_version_credits_nonnegative CHECK
    (target_credits IS NULL OR target_credits >= 0)
);

CREATE INDEX IF NOT EXISTS curriculum_program_version_program_idx
  ON curriculum_program_version (owner_id, program_id, created_at);

CREATE TABLE IF NOT EXISTS curriculum_graduation_indicator (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  program_version_id TEXT NOT NULL REFERENCES curriculum_program_version(id) ON DELETE CASCADE,
  code               TEXT NOT NULL,
  title              TEXT NOT NULL,
  description        TEXT,
  target_weight      INTEGER NOT NULL DEFAULT 3,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_version_id, code),
  CONSTRAINT curriculum_graduation_indicator_weight_known CHECK
    (target_weight BETWEEN 1 AND 10)
);

CREATE INDEX IF NOT EXISTS curriculum_graduation_indicator_version_idx
  ON curriculum_graduation_indicator (owner_id, program_version_id, sort_order);

CREATE TABLE IF NOT EXISTS curriculum_program_course (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  program_version_id TEXT NOT NULL REFERENCES curriculum_program_version(id) ON DELETE CASCADE,
  course_id          TEXT REFERENCES curriculum_course(id) ON DELETE SET NULL,
  title              TEXT NOT NULL,
  code               TEXT,
  semester           TEXT,
  category           TEXT NOT NULL DEFAULT 'required',
  credits            DOUBLE PRECISION,
  hours              DOUBLE PRECISION,
  sort_order         INTEGER NOT NULL DEFAULT 0,
  note               TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_program_course_category_known CHECK
    (category IN ('required','elective','practice','general')),
  CONSTRAINT curriculum_program_course_credits_nonnegative CHECK
    (credits IS NULL OR credits >= 0),
  CONSTRAINT curriculum_program_course_hours_nonnegative CHECK
    (hours IS NULL OR hours >= 0)
);

CREATE INDEX IF NOT EXISTS curriculum_program_course_version_idx
  ON curriculum_program_course (owner_id, program_version_id, sort_order, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_program_course_version_course_idx
  ON curriculum_program_course (program_version_id, course_id)
  WHERE course_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS curriculum_course_indicator_support (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  program_version_id TEXT NOT NULL REFERENCES curriculum_program_version(id) ON DELETE CASCADE,
  program_course_id TEXT NOT NULL REFERENCES curriculum_program_course(id) ON DELETE CASCADE,
  indicator_id      TEXT NOT NULL REFERENCES curriculum_graduation_indicator(id) ON DELETE CASCADE,
  weight            INTEGER NOT NULL DEFAULT 1,
  note              TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (program_course_id, indicator_id),
  CONSTRAINT curriculum_course_indicator_support_weight_known CHECK
    (weight BETWEEN 0 AND 5)
);

CREATE INDEX IF NOT EXISTS curriculum_course_indicator_support_version_idx
  ON curriculum_course_indicator_support (owner_id, program_version_id, indicator_id);

CREATE INDEX IF NOT EXISTS curriculum_course_indicator_support_course_idx
  ON curriculum_course_indicator_support (owner_id, program_course_id);
`;

/**
 * Reverse-design layer, phase 1+2: the course task (what the unit asked for)
 * and the learning outcomes the course is accountable for.
 *
 * `curriculum_task.design_phase` is the authoritative state machine. Nothing
 * downstream is allowed to invent content before the phase that owns it, which
 * is what stops "build a chapter tree first, then fill it" from coming back.
 *
 * `curriculum_objective` is the first-class entity the old model lacked:
 * knowledge points could not express what a learner must be able to *do*, let
 * alone how that is judged. The `verifiable` CHECK is the enforcement point —
 * an objective with no expected behavior and no minimum criteria cannot be
 * marked verifiable, so "understand SQL injection" is rejected at the database
 * rather than at review time.
 */
const CURRICULUM_DESIGN_FOUNDATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_task (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  series_id         TEXT REFERENCES curriculum_series(id) ON DELETE SET NULL,
  title             TEXT NOT NULL,
  audience          TEXT,
  learner_level     TEXT,
  training_scenario TEXT,
  duration_hours    DOUBLE PRECISION,
  application_scene TEXT,
  problem_statement TEXT,
  status            TEXT NOT NULL DEFAULT 'draft',
  design_phase      TEXT NOT NULL DEFAULT 'task',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_task_status_known CHECK (status IN ('draft','active','archived')),
  CONSTRAINT curriculum_task_phase_known CHECK
    (design_phase IN ('task','outcomes','graph','outline','teaching','assessment','review')),
  CONSTRAINT curriculum_task_hours_nonnegative CHECK
    (duration_hours IS NULL OR duration_hours >= 0)
);

CREATE INDEX IF NOT EXISTS curriculum_task_owner_phase_idx
  ON curriculum_task (owner_id, series_id, created_at);

CREATE TABLE IF NOT EXISTS curriculum_objective (
  id                   TEXT PRIMARY KEY,
  owner_id             TEXT NOT NULL,
  task_id              TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  parent_id            TEXT REFERENCES curriculum_objective(id) ON DELETE SET NULL,
  code                 TEXT,
  title                TEXT NOT NULL,
  description          TEXT,
  objective_type       TEXT NOT NULL,
  bloom_level          TEXT,
  level                TEXT NOT NULL DEFAULT 'component',
  expected_behavior    TEXT NOT NULL DEFAULT '',
  min_criteria         JSONB NOT NULL DEFAULT '[]'::jsonb,
  proficient_criteria  JSONB NOT NULL DEFAULT '[]'::jsonb,
  excellent_criteria   JSONB NOT NULL DEFAULT '[]'::jsonb,
  difficulty           TEXT NOT NULL DEFAULT 'basic',
  verifiable           BOOLEAN NOT NULL DEFAULT false,
  unverifiable_reason  TEXT,
  status               TEXT NOT NULL DEFAULT 'draft',
  sort_order           INTEGER NOT NULL DEFAULT 0,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_objective_type_known CHECK
    (objective_type IN ('knowledge','skill','competency','task')),
  CONSTRAINT curriculum_objective_level_known CHECK (level IN ('course','component')),
  CONSTRAINT curriculum_objective_bloom_known CHECK
    (bloom_level IS NULL OR bloom_level IN
      ('remember','understand','apply','analyze','evaluate','create')),
  CONSTRAINT curriculum_objective_difficulty_known CHECK
    (difficulty IN ('intro','basic','intermediate','advanced')),
  CONSTRAINT curriculum_objective_status_known CHECK
    (status IN ('draft','approved','archived')),
  -- The core gate. An objective is only "verifiable" when it names an
  -- observable behavior and at least one minimum criterion, so a title like
  -- "了解 SQL 注入" can never be approved.
  -- The emptiness test is a type check plus an inequality rather than
  -- jsonb_array_length(): that function raises on a non-array instead of
  -- returning false, which would turn a malformed column into a 500 rather
  -- than a rejected write.
  CONSTRAINT curriculum_objective_verifiable_shape CHECK (
    verifiable = false
    OR (btrim(expected_behavior) <> ''
        AND jsonb_typeof(min_criteria) = 'array'
        AND min_criteria <> '[]'::jsonb)
  ),
  CONSTRAINT curriculum_objective_criteria_shape CHECK (
    jsonb_typeof(min_criteria) = 'array'
    AND jsonb_typeof(proficient_criteria) = 'array'
    AND jsonb_typeof(excellent_criteria) = 'array'
  )
);

CREATE INDEX IF NOT EXISTS curriculum_objective_owner_task_idx
  ON curriculum_objective (owner_id, task_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS curriculum_objective_owner_parent_idx
  ON curriculum_objective (owner_id, parent_id, sort_order);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_objective_task_code_idx
  ON curriculum_objective (task_id, code)
  WHERE code IS NOT NULL;

-- Phase 3: how a learner proves each outcome. An exam-mode evidence row is
-- held to the stricter contract in the CHECK below: no hints, independent
-- completion. Practice and exam share one shape on purpose; only the policy
-- differs, so a lab can be promoted from drill to assessment without a schema
-- change.
CREATE TABLE IF NOT EXISTS curriculum_evidence (
  id                     TEXT PRIMARY KEY,
  owner_id               TEXT NOT NULL,
  task_id                TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  objective_id           TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  evidence_type          TEXT NOT NULL,
  verification_method    TEXT NOT NULL,
  success_condition      TEXT NOT NULL,
  condition_expression   TEXT,
  auxiliary_condition    TEXT,
  assessment_mode        TEXT NOT NULL DEFAULT 'practice',
  threshold_pass         DOUBLE PRECISION NOT NULL DEFAULT 0.6,
  threshold_proficient   DOUBLE PRECISION NOT NULL DEFAULT 0.8,
  threshold_excellent    DOUBLE PRECISION NOT NULL DEFAULT 0.95,
  time_limit_sec         INTEGER,
  hint_policy            TEXT NOT NULL DEFAULT 'allowed',
  independent            BOOLEAN NOT NULL DEFAULT true,
  process_record         BOOLEAN NOT NULL DEFAULT true,
  sort_order             INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_evidence_type_known CHECK
    (evidence_type IN ('quiz','lab','performance','dialogue','artifact')),
  CONSTRAINT curriculum_evidence_mode_known  CHECK (assessment_mode IN ('practice','exam')),
  CONSTRAINT curriculum_evidence_hint_known  CHECK
    (hint_policy IN ('unlimited','limited','forbidden')),
  CONSTRAINT curriculum_evidence_method_known CHECK
    (btrim(verification_method) <> ''),
  CONSTRAINT curriculum_evidence_thresholds_ordered CHECK
    (threshold_pass <= threshold_proficient AND threshold_proficient <= threshold_excellent),
  -- An exam may not be taken with hints open.
  CONSTRAINT curriculum_evidence_exam_strict CHECK (
    assessment_mode <> 'exam' OR (hint_policy = 'forbidden' AND independent = true)
  )
);

CREATE INDEX IF NOT EXISTS curriculum_evidence_owner_objective_idx
  ON curriculum_evidence (owner_id, objective_id, sort_order);

CREATE INDEX IF NOT EXISTS curriculum_evidence_owner_task_idx
  ON curriculum_evidence (owner_id, task_id, assessment_mode);
`;

/**
 * Phase 3+4: the knowledge/skill nodes that support those outcomes, and the
 * mixed DAG that ties nodes and objectives together.
 *
 * `curriculum_learning_node` keeps only `knowledge` and `skill`. Competency
 * and task are objective types, not node types: a competency is what a learner
 * must be able to do, and forcing it into the node table is what made
 * "capability targets cannot be verified" unrepresentable in the old model.
 *
 * `curriculum_node_objective` replaces `curriculum_course_knowledge_point`.
 * The old link carried `coverage_level IN ('introduced','practiced',
 * 'mastered')`, which collapsed teach / practice / assess — three orthogonal
 * dimensions — into one enum on the wrong side of the relation. Support level
 * is all that belongs here; the three-way coverage lives in
 * `curriculum_unit_coverage`.
 *
 * `curriculum_dependency` is one table for both kinds of endpoint, so a
 * prerequisite can run knowledge -> skill -> objective without three relation
 * tables. The cost is that PostgreSQL cannot enforce the endpoints by foreign
 * key; the store validates them on write and `dependencyCycle` in the audit
 * covers the shape.
 */
const CURRICULUM_DESIGN_GRAPH_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_learning_node (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  parent_id  TEXT REFERENCES curriculum_learning_node(id) ON DELETE SET NULL,
  code       TEXT,
  name       TEXT NOT NULL,
  node_type  TEXT NOT NULL,
  summary    TEXT,
  difficulty TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_node_type_known CHECK (node_type IN ('knowledge','skill')),
  CONSTRAINT curriculum_node_difficulty_known CHECK
    (difficulty IS NULL OR difficulty IN ('intro','basic','intermediate','advanced'))
);

CREATE INDEX IF NOT EXISTS curriculum_node_owner_task_idx
  ON curriculum_learning_node (owner_id, task_id, sort_order, created_at);

CREATE INDEX IF NOT EXISTS curriculum_node_owner_parent_idx
  ON curriculum_learning_node (owner_id, parent_id, sort_order);

CREATE TABLE IF NOT EXISTS curriculum_node_objective (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  node_id       TEXT NOT NULL REFERENCES curriculum_learning_node(id) ON DELETE CASCADE,
  objective_id  TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  support_level TEXT NOT NULL DEFAULT 'primary',
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, objective_id),
  CONSTRAINT curriculum_node_objective_support_known CHECK
    (support_level IN ('primary','secondary'))
);

CREATE INDEX IF NOT EXISTS curriculum_node_objective_owner_objective_idx
  ON curriculum_node_objective (owner_id, objective_id);

CREATE INDEX IF NOT EXISTS curriculum_node_objective_owner_node_idx
  ON curriculum_node_objective (owner_id, node_id);

CREATE TABLE IF NOT EXISTS curriculum_dependency (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  source_kind TEXT NOT NULL,
  target_kind TEXT NOT NULL,
  edge_type   TEXT NOT NULL,
  strength    DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_dependency_kind_known CHECK
    (source_kind IN ('objective','node') AND target_kind IN ('objective','node')),
  CONSTRAINT curriculum_dependency_edge_known CHECK
    (edge_type IN ('prerequisite','derives','supports','practices','composes','progresses')),
  CONSTRAINT curriculum_dependency_distinct CHECK (source_id <> target_id),
  CONSTRAINT curriculum_dependency_strength_known CHECK (strength >= 0 AND strength <= 1)
);

CREATE INDEX IF NOT EXISTS curriculum_dependency_source_idx
  ON curriculum_dependency (owner_id, task_id, source_kind, source_id);

CREATE INDEX IF NOT EXISTS curriculum_dependency_target_idx
  ON curriculum_dependency (owner_id, task_id, target_kind, target_id);

-- A dependency edge is a learning-order claim, so a duplicate (source, target,
-- type) carries no new information. Uniqueness is what lets the store answer
-- "what does this objective require" with one indexed read.
CREATE UNIQUE INDEX IF NOT EXISTS curriculum_dependency_owner_edge_idx
  ON curriculum_dependency
    (owner_id, task_id, source_kind, source_id, target_kind, target_id, edge_type);
`;

/**
 * Phase 5: the chapter/item outline, and the teach / practice / assess ledger.
 *
 * A chapter is classification only. `curriculum_unit_coverage` therefore
 * refuses any row whose unit is a chapter, which is what keeps "chapters carry
 * bulk content" from creeping back in: the database has nowhere to record it.
 *
 * `curriculum_unit_coverage` is the whole closed loop. Teach, practice and
 * assess are three independent rows keyed together, so "which objectives are
 * examined but never taught" is one GROUP BY rather than an inference from a
 * single level column.
 */
const CURRICULUM_DESIGN_OUTLINE_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_unit (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  task_id         TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  parent_id       TEXT REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  unit_type       TEXT NOT NULL,
  title           TEXT NOT NULL,
  code            TEXT,
  unit_role       TEXT,
  hours           DOUBLE PRECISION,
  order_index     INTEGER NOT NULL DEFAULT 0,
  teaching_design JSONB NOT NULL DEFAULT '{}'::jsonb,
  deck_design     JSONB NOT NULL DEFAULT '{}'::jsonb,
  stage_id        TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_unit_type_known CHECK (unit_type IN ('chapter','item')),
  CONSTRAINT curriculum_unit_role_known CHECK
    (unit_role IS NULL OR unit_role IN ('lecture','practice','exam')),
  CONSTRAINT curriculum_unit_hours_nonnegative CHECK (hours IS NULL OR hours >= 0),
  -- A chapter classifies; it has no teaching role. An item is a teaching unit
  -- and must declare which of the three it is.
  CONSTRAINT curriculum_unit_role_shape CHECK (
    (unit_type = 'chapter' AND unit_role IS NULL)
    OR (unit_type = 'item' AND unit_role IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS curriculum_unit_owner_task_idx
  ON curriculum_unit (owner_id, task_id, order_index, created_at);

CREATE INDEX IF NOT EXISTS curriculum_unit_owner_parent_idx
  ON curriculum_unit (owner_id, parent_id, order_index);

CREATE INDEX IF NOT EXISTS curriculum_unit_owner_stage_idx
  ON curriculum_unit (owner_id, stage_id)
  WHERE stage_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS curriculum_unit_coverage (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  unit_id       TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  objective_id  TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  coverage_kind TEXT NOT NULL,
  depth         TEXT NOT NULL DEFAULT 'standard',
  order_index   INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, objective_id, coverage_kind),
  CONSTRAINT curriculum_unit_coverage_kind_known CHECK
    (coverage_kind IN ('teach','practice','assess')),
  CONSTRAINT curriculum_unit_coverage_depth_known CHECK
    (depth IN ('brief','standard','deep'))
);

CREATE INDEX IF NOT EXISTS curriculum_unit_coverage_owner_objective_idx
  ON curriculum_unit_coverage (owner_id, objective_id, coverage_kind);

CREATE INDEX IF NOT EXISTS curriculum_unit_coverage_owner_unit_idx
  ON curriculum_unit_coverage (owner_id, unit_id, order_index);

-- A CHECK cannot reach into curriculum_unit, so "a chapter carries no content"
-- is a trigger rather than an inline constraint. It is the one rule in this
-- layer that has to hold no matter which client writes the row, because a
-- chapter quietly accumulating taught objectives is exactly the drift this
-- model exists to prevent.
CREATE OR REPLACE FUNCTION curriculum_coverage_reject_chapter() RETURNS trigger AS $fn$
DECLARE
  target_type TEXT;
BEGIN
  SELECT unit_type INTO target_type FROM curriculum_unit WHERE id = NEW.unit_id;
  IF target_type = 'chapter' THEN
    RAISE EXCEPTION 'chapter % cannot carry % coverage; only an item teaches', NEW.unit_id, NEW.coverage_kind
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS curriculum_coverage_item_only ON curriculum_unit_coverage;

CREATE TRIGGER curriculum_coverage_item_only
  BEFORE INSERT OR UPDATE ON curriculum_unit_coverage
  FOR EACH ROW EXECUTE FUNCTION curriculum_coverage_reject_chapter();

CREATE TABLE IF NOT EXISTS curriculum_unit_dependency (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  task_id        TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  source_unit_id TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  target_unit_id TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  edge_type      TEXT NOT NULL DEFAULT 'prerequisite',
  strength       DOUBLE PRECISION NOT NULL DEFAULT 1.0,
  note           TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_unit_dependency_distinct CHECK (source_unit_id <> target_unit_id),
  CONSTRAINT curriculum_unit_dependency_edge_known CHECK
    (edge_type IN ('prerequisite','follow-up','related')),
  CONSTRAINT curriculum_unit_dependency_strength_known CHECK (strength >= 0 AND strength <= 1)
);

CREATE UNIQUE INDEX IF NOT EXISTS curriculum_unit_dependency_owner_edge_idx
  ON curriculum_unit_dependency (owner_id, task_id, source_unit_id, target_unit_id, edge_type);

CREATE INDEX IF NOT EXISTS curriculum_unit_dependency_owner_source_idx
  ON curriculum_unit_dependency (owner_id, source_unit_id);

CREATE INDEX IF NOT EXISTS curriculum_unit_dependency_owner_target_idx
  ON curriculum_unit_dependency (owner_id, target_unit_id);
`;

/**
 * Phases 6-8: the assessment artifacts themselves.
 *
 * `curriculum_question` carries a `distractors` column because "why did this
 * student choose wrong" is otherwise lost into a single explanation string. Each
 * wrong option names the misconception it is built on, so a wrong answer
 * identifies a specific gap instead of a single red mark.
 *
 * `curriculum_lab_task` keeps the reference solution and the verification rules
 * in separate columns and they are not interchangeable. A CTF-style task has
 * many valid routes, so grading a student's path against the model's would mark
 * correct work wrong. `verify_rules` is the only grading input;
 * `reference_solution` exists for hints and write-ups.
 */
const CURRICULUM_DESIGN_ASSESSMENT_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_question (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  unit_id       TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  objective_id  TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  evidence_id   TEXT REFERENCES curriculum_evidence(id) ON DELETE SET NULL,
  question_type TEXT NOT NULL,
  stem          TEXT NOT NULL,
  options       JSONB NOT NULL DEFAULT '[]'::jsonb,
  answer        JSONB NOT NULL DEFAULT '[]'::jsonb,
  explanation   TEXT,
  distractors   JSONB NOT NULL DEFAULT '[]'::jsonb,
  difficulty    TEXT NOT NULL DEFAULT 'basic',
  bloom_level   TEXT,
  score         DOUBLE PRECISION NOT NULL DEFAULT 1,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_question_type_known CHECK
    (question_type IN ('single','multiple','true_false')),
  CONSTRAINT curriculum_question_difficulty_known CHECK
    (difficulty IN ('intro','basic','intermediate','advanced')),
  CONSTRAINT curriculum_question_bloom_known CHECK
    (bloom_level IS NULL OR bloom_level IN
      ('remember','understand','apply','analyze','evaluate','create')),
  CONSTRAINT curriculum_question_stem_known CHECK (btrim(stem) <> ''),
  CONSTRAINT curriculum_question_score_known CHECK (score > 0)
);

CREATE INDEX IF NOT EXISTS curriculum_question_owner_unit_idx
  ON curriculum_question (owner_id, unit_id, sort_order);

CREATE INDEX IF NOT EXISTS curriculum_question_owner_objective_idx
  ON curriculum_question (owner_id, objective_id);

CREATE TABLE IF NOT EXISTS curriculum_lab_task (
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  task_id             TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  unit_id             TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  objective_id        TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  evidence_id         TEXT REFERENCES curriculum_evidence(id) ON DELETE CASCADE,
  assessment_mode     TEXT NOT NULL DEFAULT 'practice',
  task_goal           TEXT NOT NULL,
  brief               TEXT NOT NULL DEFAULT '',
  expected_result     TEXT,
  docker_image        TEXT NOT NULL,
  container_config    JSONB NOT NULL DEFAULT '{}'::jsonb,
  init_state          JSONB NOT NULL DEFAULT '{}'::jsonb,
  reset_policy        TEXT NOT NULL DEFAULT 'on-demand',
  reference_solution  JSONB,
  verify_rules        JSONB NOT NULL DEFAULT '[]'::jsonb,
  key_behaviors       JSONB NOT NULL DEFAULT '[]'::jsonb,
  final_state_rule    TEXT,
  score_rules         JSONB NOT NULL DEFAULT '[]'::jsonb,
  scoring_mode        TEXT NOT NULL DEFAULT 'result',
  time_limit_sec      INTEGER,
  hint_policy         TEXT NOT NULL DEFAULT 'unlimited',
  allow_retry         BOOLEAN NOT NULL DEFAULT true,
  hint_ladder         JSONB NOT NULL DEFAULT '[]'::jsonb,
  sort_order          INTEGER NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_lab_mode_known CHECK (assessment_mode IN ('practice','exam')),
  CONSTRAINT curriculum_lab_scoring_known CHECK
    (scoring_mode IN ('result','process','key_step','time','mixed')),
  CONSTRAINT curriculum_lab_reset_known CHECK
    (reset_policy IN ('on-start','on-demand','never')),
  CONSTRAINT curriculum_lab_hint_known CHECK
    (hint_policy IN ('unlimited','limited','forbidden')),
  CONSTRAINT curriculum_lab_goal_known CHECK (btrim(task_goal) <> ''),
  CONSTRAINT curriculum_lab_image_known CHECK (btrim(docker_image) <> ''),
  -- A lab with no machine-checkable rule is ungradable, so it is refused at
  -- the database rather than at review. The rule set must be an array.
  CONSTRAINT curriculum_lab_verify_shape CHECK (jsonb_typeof(verify_rules) = 'array'),
  -- An exam is taken cold: no hints, no retry, on a clock.
  CONSTRAINT curriculum_lab_exam_strict CHECK (
    assessment_mode <> 'exam'
    OR (hint_policy = 'forbidden' AND allow_retry = false AND time_limit_sec IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS curriculum_lab_task_owner_unit_idx
  ON curriculum_lab_task (owner_id, unit_id, sort_order);

CREATE INDEX IF NOT EXISTS curriculum_lab_task_owner_objective_idx
  ON curriculum_lab_task (owner_id, objective_id, assessment_mode);
`;

/**
 * Phase 11: audit findings, persisted so a review survives the session that
 * produced it and can be resolved or waived per finding.
 */
const CURRICULUM_DESIGN_AUDIT_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_audit_finding (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  rule_code   TEXT NOT NULL,
  severity    TEXT NOT NULL DEFAULT 'warning',
  message     TEXT NOT NULL,
  ref_kind    TEXT,
  ref_id      TEXT,
  ref_ids     JSONB NOT NULL DEFAULT '[]'::jsonb,
  status      TEXT NOT NULL DEFAULT 'open',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_audit_finding_severity_known CHECK
    (severity IN ('error','warning','info')),
  CONSTRAINT curriculum_audit_finding_status_known CHECK
    (status IN ('open','resolved','waived'))
);

CREATE INDEX IF NOT EXISTS curriculum_audit_finding_owner_task_idx
  ON curriculum_audit_finding (owner_id, task_id, status, created_at);

CREATE INDEX IF NOT EXISTS curriculum_audit_finding_owner_rule_idx
  ON curriculum_audit_finding (owner_id, rule_code, status);
`;

/**
 * Phase 13: the user's sign-off on a design step.
 *
 * The phase machine could tell "the brief is filled in" from nothing, but not
 * "the user agreed to the brief" — and the AI-assisted flow makes those two
 * different facts rather than the same one: the model writes the card, the user
 * reads it, and only then may the design move on. One row per (task, step), so
 * the remaining six steps cost no further migration. `step` reuses the phase
 * vocabulary on purpose: the thing being confirmed is the phase being left.
 */
const CURRICULUM_DESIGN_CONFIRMATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS curriculum_design_confirmation (
  id           TEXT PRIMARY KEY,
  owner_id     TEXT NOT NULL,
  task_id      TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  step         TEXT NOT NULL,
  confirmed_by TEXT NOT NULL,
  note         TEXT,
  confirmed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_design_confirmation_step_known CHECK
    (step IN ('task','outcomes','graph','outline','teaching','assessment','review')),
  CONSTRAINT curriculum_design_confirmation_actor_known CHECK
    (confirmed_by IN ('user','assistant','system')),
  -- One confirmation per step. Re-confirming replaces it, which is what makes
  -- "withdraw" and "confirm again" the same row moving rather than accumulating
  -- history nobody reads.
  CONSTRAINT curriculum_design_confirmation_step_unique UNIQUE (owner_id, task_id, step)
);

CREATE INDEX IF NOT EXISTS curriculum_design_confirmation_owner_task_idx
  ON curriculum_design_confirmation (owner_id, task_id);
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
    {
      version: 5,
      name: 'batches',
      up: CURRICULUM_BATCHES_SCHEMA,
      transaction: true,
    },
    {
      version: 6,
      name: 'export_jobs',
      up: CURRICULUM_EXPORT_JOBS_SCHEMA,
      transaction: true,
    },
    {
      version: 7,
      name: 'program_plan',
      up: CURRICULUM_PROGRAM_PLAN_SCHEMA,
      transaction: true,
    },
    // Reverse-design layer. The ledger above is kept: a course row is still the
    // operator-facing product entity, and the program plan points at it. These
    // migrations add the outcome-first model beside it rather than rewriting it.
    {
      version: 8,
      name: 'design_foundation',
      up: CURRICULUM_DESIGN_FOUNDATION_SCHEMA,
      transaction: true,
    },
    {
      version: 9,
      name: 'design_graph',
      up: CURRICULUM_DESIGN_GRAPH_SCHEMA,
      transaction: true,
    },
    {
      version: 10,
      name: 'design_outline',
      up: CURRICULUM_DESIGN_OUTLINE_SCHEMA,
      transaction: true,
    },
    {
      version: 11,
      name: 'design_assessment',
      up: CURRICULUM_DESIGN_ASSESSMENT_SCHEMA,
      transaction: true,
    },
    {
      version: 12,
      name: 'design_audit',
      up: CURRICULUM_DESIGN_AUDIT_SCHEMA,
      transaction: true,
    },
    // The AI-assisted flow's missing half: the phase machine can see that a
    // step is filled in, and only this table lets it see that the user agreed.
    {
      version: 13,
      name: 'design_confirmation',
      up: CURRICULUM_DESIGN_CONFIRMATION_SCHEMA,
      transaction: true,
    },
  ],
};

export async function ensureCurriculumSchema(queryable: Queryable): Promise<void> {
  await applySchemaMigrations(queryable, CURRICULUM_MIGRATIONS);
}
