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

export interface CurriculumSnapshot {
  series: CurriculumSeriesRecord[];
  courses: CurriculumCourseRecord[];
  relations: CurriculumRelationRecord[];
}
