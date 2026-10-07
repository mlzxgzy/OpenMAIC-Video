/** Course status a curriculum course can be in. */
export const CURRICULUM_COURSE_STATUSES = ['draft', 'active', 'archived'] as const;
export type CurriculumCourseStatus = (typeof CURRICULUM_COURSE_STATUSES)[number];

/** Relation types the first course-ledger version understands. */
export const CURRICULUM_RELATION_TYPES = [
  'prerequisite',
  'follow-up',
  'related',
  'supports',
] as const;
export type CurriculumRelationType = (typeof CURRICULUM_RELATION_TYPES)[number];

/** The first knowledge-point taxonomy. */
export const KNOWLEDGE_POINT_TYPES = ['knowledge', 'skill', 'competency'] as const;
export type KnowledgePointType = (typeof KNOWLEDGE_POINT_TYPES)[number];

export const KNOWLEDGE_POINT_DIFFICULTIES = ['intro', 'basic', 'intermediate', 'advanced'] as const;
export type KnowledgePointDifficulty = (typeof KNOWLEDGE_POINT_DIFFICULTIES)[number];

export const COURSE_KNOWLEDGE_COVERAGE_LEVELS = ['introduced', 'practiced', 'mastered'] as const;
export type CourseKnowledgeCoverageLevel = (typeof COURSE_KNOWLEDGE_COVERAGE_LEVELS)[number];

/**
 * Knowledge-point relations are direction-aware. `contains` and `related`
 * exist because curriculum authors often need a lightweight relation even
 * when the strict parent-child tree is not the right shape; `prerequisite`
 * and `follow-up` are the learning-order edges used by the knowledge graph.
 */
export const KNOWLEDGE_POINT_RELATION_TYPES = [
  'prerequisite',
  'follow-up',
  'contains',
  'related',
] as const;
export type KnowledgePointRelationType = (typeof KNOWLEDGE_POINT_RELATION_TYPES)[number];

export interface CurriculumSeriesRecord {
  id: string;
  name: string;
  description: string | null;
  courseCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumCourseRecord {
  id: string;
  seriesId: string | null;
  stageId: string | null;
  title: string;
  code: string | null;
  description: string | null;
  chapter: string | null;
  section: string | null;
  lessonOrder: number;
  credits: number | null;
  hours: number | null;
  semester: string | null;
  status: CurriculumCourseStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumRelationRecord {
  id: string;
  sourceCourseId: string;
  targetCourseId: string;
  relationType: CurriculumRelationType;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgePointRecord {
  id: string;
  seriesId: string | null;
  parentId: string | null;
  name: string;
  code: string | null;
  type: KnowledgePointType;
  difficulty: KnowledgePointDifficulty | null;
  summary: string | null;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CourseKnowledgePointRecord {
  courseId: string;
  knowledgePointId: string;
  coverageLevel: CourseKnowledgeCoverageLevel;
  sortOrder: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgePointRelationRecord {
  id: string;
  sourceKnowledgePointId: string;
  targetKnowledgePointId: string;
  relationType: KnowledgePointRelationType;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export const CURRICULUM_GENERATION_JOB_STATUSES = [
  'queued',
  'running',
  'awaiting_outline',
  'paused',
  'completed',
  'failed',
  'ended',
] as const;
export type CurriculumGenerationJobStatus = (typeof CURRICULUM_GENERATION_JOB_STATUSES)[number];

/**
 * How the curriculum assembler's one-click run confirms its outline. `auto`
 * keeps the run one-click; `wait` and `countdown` behave like the classic
 * generation-run modes.
 */
export const CURRICULUM_GENERATION_OUTLINE_REVIEWS = ['wait', 'countdown', 'auto'] as const;
export type CurriculumGenerationOutlineReview =
  (typeof CURRICULUM_GENERATION_OUTLINE_REVIEWS)[number];

export interface CurriculumGenerationJobError {
  code: string;
  message?: string;
  step?: string | null;
}

export interface CurriculumGenerationJobRecord {
  id: string;
  courseId: string;
  runId: string | null;
  stageId: string | null;
  status: CurriculumGenerationJobStatus;
  outlineReview: CurriculumGenerationOutlineReview;
  error: CurriculumGenerationJobError | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A durable batch of assembled courses that drains through the generation-run limit. */
export const CURRICULUM_BATCH_STATUSES = [
  'queued',
  'running',
  'paused',
  'completed',
  'failed',
  'cancelled',
] as const;
export type CurriculumBatchStatus = (typeof CURRICULUM_BATCH_STATUSES)[number];

/** One course inside a batch. Mirrors the run states plus `starting` and `cancelled`. */
export const CURRICULUM_BATCH_ITEM_STATUSES = [
  'queued',
  'starting',
  'running',
  'awaiting_outline',
  'paused',
  'completed',
  'failed',
  'ended',
  'cancelled',
] as const;
export type CurriculumBatchItemStatus = (typeof CURRICULUM_BATCH_ITEM_STATUSES)[number];

export interface CurriculumBatchRecord {
  id: string;
  name: string;
  status: CurriculumBatchStatus;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumBatchItemRecord {
  id: string;
  batchId: string;
  position: number;
  courseId: string | null;
  title: string;
  status: CurriculumBatchItemStatus;
  attempts: number;
  maxAttempts: number;
  generationJobId: string | null;
  runId: string | null;
  stageId: string | null;
  error: CurriculumGenerationJobError | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Program-plan layer: a training program, its versions and graduation indicators. */
export const CURRICULUM_PROGRAM_STATUSES = ['draft', 'active', 'archived'] as const;
export type CurriculumProgramStatus = (typeof CURRICULUM_PROGRAM_STATUSES)[number];

export const CURRICULUM_PROGRAM_COURSE_CATEGORIES = [
  'required',
  'elective',
  'practice',
  'general',
] as const;
export type CurriculumProgramCourseCategory = (typeof CURRICULUM_PROGRAM_COURSE_CATEGORIES)[number];

export interface CurriculumProgramRecord {
  id: string;
  name: string;
  code: string | null;
  description: string | null;
  status: CurriculumProgramStatus;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumProgramVersionRecord {
  id: string;
  programId: string;
  name: string;
  version: string | null;
  gradeYear: string | null;
  description: string | null;
  status: CurriculumProgramStatus;
  targetCredits: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumGraduationIndicatorRecord {
  id: string;
  programVersionId: string;
  code: string;
  title: string;
  description: string | null;
  targetWeight: number;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumProgramCourseRecord {
  id: string;
  programVersionId: string;
  courseId: string | null;
  title: string;
  code: string | null;
  semester: string | null;
  category: CurriculumProgramCourseCategory;
  credits: number | null;
  hours: number | null;
  sortOrder: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CourseIndicatorSupportRecord {
  id: string;
  programVersionId: string;
  programCourseId: string;
  indicatorId: string;
  weight: number;
  note: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Owner-scoped MP4 export jobs produced from completed batch items. */
export const CURRICULUM_EXPORT_JOB_STATUSES = [
  'queued',
  'building',
  'submitting',
  'rendering',
  'succeeded',
  'failed',
  'cancelled',
] as const;
export type CurriculumExportJobStatus = (typeof CURRICULUM_EXPORT_JOB_STATUSES)[number];

export interface CurriculumExportJobError {
  code: string;
  message?: string;
}

export interface CurriculumExportJobRecord {
  id: string;
  courseId: string | null;
  batchItemId: string | null;
  stageId: string;
  title: string;
  status: CurriculumExportJobStatus;
  resolution: string;
  fps: number;
  quality: string;
  burnInSubtitles: boolean;
  progress: number;
  renderJobId: string | null;
  attempts: number;
  error: CurriculumExportJobError | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CurriculumSnapshot {
  series: CurriculumSeriesRecord[];
  courses: CurriculumCourseRecord[];
  relations: CurriculumRelationRecord[];
  knowledgePoints: KnowledgePointRecord[];
  courseKnowledgePoints: CourseKnowledgePointRecord[];
  knowledgePointRelations: KnowledgePointRelationRecord[];
  generationJobs: CurriculumGenerationJobRecord[];
  batches: CurriculumBatchRecord[];
  batchItems: CurriculumBatchItemRecord[];
  exportJobs: CurriculumExportJobRecord[];
  programs: CurriculumProgramRecord[];
  programVersions: CurriculumProgramVersionRecord[];
  graduationIndicators: CurriculumGraduationIndicatorRecord[];
  programCourses: CurriculumProgramCourseRecord[];
  courseIndicatorSupports: CourseIndicatorSupportRecord[];
}
