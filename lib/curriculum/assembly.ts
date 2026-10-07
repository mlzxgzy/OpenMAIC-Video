import type {
  CourseKnowledgeCoverageLevel,
  CurriculumSnapshot,
  KnowledgePointDifficulty,
  KnowledgePointRecord,
  KnowledgePointRelationRecord,
  KnowledgePointType,
} from './types';

export interface CourseAssemblyKnowledgePointInput {
  knowledgePointId: string;
  coverageLevel?: CourseKnowledgeCoverageLevel;
  note?: string | null;
}

export interface CourseAssemblyInput {
  seriesId?: string | null;
  title: string;
  code?: string | null;
  chapter?: string | null;
  section?: string | null;
  type?: string | null;
  hours?: number | null;
  knowledgePoints: CourseAssemblyKnowledgePointInput[];
}

export interface CourseAssemblyKnowledgePoint {
  knowledgePointId: string;
  name: string;
  code: string | null;
  summary: string | null;
  type: KnowledgePointType;
  difficulty: KnowledgePointDifficulty | null;
  coverageLevel: CourseKnowledgeCoverageLevel;
  note: string | null;
  order: number;
  parentId: string | null;
  childIds: string[];
  prerequisiteIds: string[];
  followUpIds: string[];
  relatedIds: string[];
  missingPrerequisiteIds: string[];
}

export interface CourseAssemblySlide {
  order: number;
  title: string;
  points: string[];
  narration: string;
  knowledgePointIds: string[];
}

export type CourseAssemblyWarningCode =
  | 'EMPTY_SELECTION'
  | 'DUPLICATE_KNOWLEDGE_POINT'
  | 'KNOWLEDGE_POINT_NOT_FOUND'
  | 'KNOWLEDGE_POINT_SERIES_MISMATCH'
  | 'MISSING_PREREQUISITE'
  | 'ORDER_CYCLE';

export interface CourseAssemblyWarning {
  code: CourseAssemblyWarningCode;
  message: string;
  knowledgePointIds: string[];
}

export interface CourseAssemblyPackage {
  schemaVersion: 1;
  code: string;
  chapter: string;
  section: string;
  title: string;
  type: string;
  hours: number;
  objectives: string[];
  generation: {
    sceneTypes: ['slide'];
    interactive: false;
    taskEngine: false;
    outlineReview: 'auto';
    requirement: string;
  };
  slideOutline: Array<{
    order: number;
    title: string;
    points: string[];
    narration: string;
  }>;
}

export interface CourseAssemblyPlan {
  seriesId: string | null;
  seriesName: string | null;
  title: string;
  code: string;
  chapter: string;
  section: string;
  type: string;
  hours: number;
  objectives: string[];
  knowledgePoints: CourseAssemblyKnowledgePoint[];
  slides: CourseAssemblySlide[];
  warnings: CourseAssemblyWarning[];
  coursePackage: CourseAssemblyPackage;
  packageFileName: string;
  suggestedPackagePath: string;
  suggestedRunCommand: string;
}

const COVERAGE_RANK: Record<CourseKnowledgeCoverageLevel, number> = {
  introduced: 1,
  practiced: 2,
  mastered: 3,
};

const TYPE_LABEL: Record<KnowledgePointType, string> = {
  knowledge: '知识',
  skill: '技能',
  competency: '能力素养',
};

const DIFFICULTY_LABEL: Record<KnowledgePointDifficulty, string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
  advanced: '高级',
};

function text(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function compareKnowledgePoints(a: KnowledgePointRecord, b: KnowledgePointRecord): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function makeFileSafeCode(code: string, fallback: string): string {
  const source = code.trim() || fallback;
  return source.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
}

function splitSummaryPoints(summary: string | null): string[] {
  if (!summary) return [];
  const segments = summary
    .split(/[\n；;]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length > 1) return segments.slice(0, 6);
  const single = segments[0] ?? summary.trim();
  return single ? [single] : [];
}

function fallbackPoints(point: KnowledgePointRecord): string[] {
  const points = [`类型：${TYPE_LABEL[point.type]}`];
  if (point.difficulty) points.push(`难度：${DIFFICULTY_LABEL[point.difficulty]}`);
  points.push('讲解要点与例题待补充');
  return points;
}

function buildKnowledgePointNarration(point: KnowledgePointRecord): string {
  const summary = text(point.summary);
  if (summary) {
    return `本节我们学习${point.name}。${summary}`;
  }
  return `本节我们学习${point.name}。请围绕${TYPE_LABEL[point.type]}目标展开讲解，并给出一个面向零基础学员的例子。`;
}

function buildOrderingDependencies(
  selectedIds: string[],
  pointById: Map<string, KnowledgePointRecord>,
  relations: KnowledgePointRelationRecord[],
): Map<string, Set<string>> {
  const selected = new Set(selectedIds);
  const dependencies = new Map<string, Set<string>>();
  for (const id of selectedIds) dependencies.set(id, new Set());

  const addEdge = (sourceId: string, targetId: string) => {
    if (!selected.has(sourceId) || !selected.has(targetId)) return;
    dependencies.get(targetId)?.add(sourceId);
  };

  for (const point of selectedIds.map((id) => pointById.get(id)).filter(Boolean)) {
    if (!point) continue;
    if (point.parentId && selected.has(point.parentId)) addEdge(point.parentId, point.id);
  }

  for (const relation of relations) {
    if (relation.relationType === 'related') continue;
    // `prerequisite`, `follow-up` and `contains` are all read as
    // source-before-target ordering constraints in this MVP.
    addEdge(relation.sourceKnowledgePointId, relation.targetKnowledgePointId);
  }

  return dependencies;
}

function topologicalOrder(
  selectedIds: string[],
  dependencies: Map<string, Set<string>>,
  pointById: Map<string, KnowledgePointRecord>,
): { order: string[]; hasCycle: boolean } {
  const inDegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const id of selectedIds) {
    inDegree.set(id, dependencies.get(id)?.size ?? 0);
    dependents.set(id, []);
  }
  for (const [targetId, sources] of dependencies) {
    for (const sourceId of sources) {
      dependents.get(sourceId)?.push(targetId);
    }
  }

  const compare = (a: string, b: string) => {
    const pointA = pointById.get(a);
    const pointB = pointById.get(b);
    if (pointA && pointB) return compareKnowledgePoints(pointA, pointB);
    return a < b ? -1 : a > b ? 1 : 0;
  };

  const ready = selectedIds.filter((id) => (inDegree.get(id) ?? 0) === 0).sort(compare);
  const order: string[] = [];

  while (ready.length > 0) {
    const current = ready.shift();
    if (!current) break;
    order.push(current);
    for (const dependent of dependents.get(current) ?? []) {
      const nextDegree = (inDegree.get(dependent) ?? 1) - 1;
      inDegree.set(dependent, nextDegree);
      if (nextDegree === 0) {
        ready.push(dependent);
        ready.sort(compare);
      }
    }
  }

  if (order.length === selectedIds.length) return { order, hasCycle: false };

  const remaining = selectedIds.filter((id) => !order.includes(id)).sort(compare);
  return { order: [...order, ...remaining], hasCycle: true };
}

function estimateHours(points: CourseAssemblyKnowledgePoint[]): number {
  if (points.length === 0) return 1;
  const weighted = points.reduce((sum, point) => sum + COVERAGE_RANK[point.coverageLevel], 0);
  // Four introduced points roughly map to one 45-minute lesson; practiced and
  // mastered points cost more. The author can always override this value.
  return Math.max(1, Math.ceil(weighted / 4));
}

function objectiveForGroup(group: CourseAssemblyKnowledgePoint[]): string {
  const top = group[0];
  if (!top) return '';
  const highestCoverage = group.reduce(
    (current, point) =>
      COVERAGE_RANK[point.coverageLevel] > COVERAGE_RANK[current] ? point.coverageLevel : current,
    top.coverageLevel,
  );
  if (group.length > 1) {
    const names = group
      .slice(0, 4)
      .map((point) => point.name)
      .join('、');
    return `能建立“${top.name}”的整体认知，并理解${names}的关键内容`;
  }
  if (highestCoverage === 'mastered') return `能独立运用“${top.name}”解决综合问题`;
  if (highestCoverage === 'practiced') return `能运用“${top.name}”完成基础练习`;
  return `能理解“${top.name}”的核心概念`;
}

function buildPlanPackage(input: {
  title: string;
  code: string;
  chapter: string;
  section: string;
  type: string;
  hours: number;
  objectives: string[];
  slides: CourseAssemblySlide[];
  orderedPoints: CourseAssemblyKnowledgePoint[];
}): CourseAssemblyPackage {
  const sceneTitles = input.slides.map((slide) => slide.title);
  const requirementLines = [
    `请生成一门名为《${input.title}》的 OpenMAIC 课程。`,
    `课程定位：${[input.chapter, input.section].filter(Boolean).join(' ') || input.title}，${input.type}，${input.hours}学时。`,
    `学习目标：${input.objectives.map((objective, index) => `${index + 1}. ${objective}`).join('；')}`,
    '只使用 slide 场景，不要生成 code、interactive、pbl 等场景。',
    `内容必须覆盖以下${sceneTitles.length}页：${sceneTitles.join('、')}。`,
    '讲解要适合语音合成，语言简洁、口语化，面向零基础学员。',
  ];
  if (input.orderedPoints.length > 0) {
    requirementLines.push(
      `知识点要求：${input.orderedPoints
        .map((point) => (point.summary ? `${point.name}（${point.summary}）` : point.name))
        .join('；')}。`,
    );
  }

  return {
    schemaVersion: 1,
    code: input.code,
    chapter: input.chapter,
    section: input.section,
    title: input.title,
    type: input.type,
    hours: input.hours,
    objectives: input.objectives,
    generation: {
      sceneTypes: ['slide'],
      interactive: false,
      taskEngine: false,
      outlineReview: 'auto',
      requirement: requirementLines.join('\n'),
    },
    slideOutline: input.slides.map((slide) => ({
      order: slide.order,
      title: slide.title,
      points: slide.points,
      narration: slide.narration,
    })),
  };
}

/**
 * Build a deterministic course-assembly plan from an owner's curriculum
 * snapshot. The same pure function feeds the UI preview, the downloaded
 * course package and tests, so ordering and warnings cannot drift between
 * screens.
 */
export function buildCourseAssembly(
  snapshot: CurriculumSnapshot,
  input: CourseAssemblyInput,
): CourseAssemblyPlan {
  const warnings: CourseAssemblyWarning[] = [];
  const pointById = new Map(snapshot.knowledgePoints.map((point) => [point.id, point]));
  const selectedIds: string[] = [];
  const seen = new Set<string>();
  const seriesId = text(input.seriesId) ?? null;
  const series = seriesId
    ? (snapshot.series.find((candidate) => candidate.id === seriesId) ?? null)
    : null;
  const seriesFilter = seriesId;

  for (const item of input.knowledgePoints) {
    if (seen.has(item.knowledgePointId)) {
      warnings.push({
        code: 'DUPLICATE_KNOWLEDGE_POINT',
        message: `知识点 ${item.knowledgePointId} 被重复选择，只保留第一次。`,
        knowledgePointIds: [item.knowledgePointId],
      });
      continue;
    }
    seen.add(item.knowledgePointId);
    const point = pointById.get(item.knowledgePointId);
    if (!point) {
      warnings.push({
        code: 'KNOWLEDGE_POINT_NOT_FOUND',
        message: `知识点 ${item.knowledgePointId} 不存在或不属于当前 owner。`,
        knowledgePointIds: [item.knowledgePointId],
      });
      continue;
    }
    if (seriesFilter && point.seriesId !== seriesFilter) {
      warnings.push({
        code: 'KNOWLEDGE_POINT_SERIES_MISMATCH',
        message: `知识点 ${point.name} 不属于当前课程系列，已跳过。`,
        knowledgePointIds: [point.id],
      });
      continue;
    }
    selectedIds.push(point.id);
  }

  if (selectedIds.length === 0) {
    warnings.push({
      code: 'EMPTY_SELECTION',
      message: '没有可用的知识点被选中。',
      knowledgePointIds: [],
    });
  }

  const selected = new Set(selectedIds);
  const byId = new Map(selectedIds.map((id) => [id, pointById.get(id)!]));
  const dependencies = buildOrderingDependencies(
    selectedIds,
    byId,
    snapshot.knowledgePointRelations,
  );
  const { order: orderedIds, hasCycle } = topologicalOrder(selectedIds, dependencies, byId);
  if (hasCycle) {
    warnings.push({
      code: 'ORDER_CYCLE',
      message: '选中的知识点关系中存在环，已按稳定顺序追加剩余知识点。',
      knowledgePointIds: orderedIds,
    });
  }

  const prerequisiteByTarget = new Map<string, string[]>();
  const followUpBySource = new Map<string, string[]>();
  const relatedBySource = new Map<string, string[]>();
  for (const relation of snapshot.knowledgePointRelations) {
    if (relation.relationType === 'prerequisite') {
      const list = prerequisiteByTarget.get(relation.targetKnowledgePointId) ?? [];
      list.push(relation.sourceKnowledgePointId);
      prerequisiteByTarget.set(relation.targetKnowledgePointId, list);
    } else if (relation.relationType === 'follow-up') {
      const list = followUpBySource.get(relation.sourceKnowledgePointId) ?? [];
      list.push(relation.targetKnowledgePointId);
      followUpBySource.set(relation.sourceKnowledgePointId, list);
    } else if (relation.relationType === 'related') {
      const list = relatedBySource.get(relation.sourceKnowledgePointId) ?? [];
      list.push(relation.targetKnowledgePointId);
      relatedBySource.set(relation.sourceKnowledgePointId, list);
    }
  }

  const orderedPoints: CourseAssemblyKnowledgePoint[] = orderedIds.map((id, index) => {
    const point = byId.get(id)!;
    const inputPoint = input.knowledgePoints.find((item) => item.knowledgePointId === id);
    const prerequisiteIds = prerequisiteByTarget.get(id) ?? [];
    const missingPrerequisiteIds = prerequisiteIds.filter(
      (sourceId) => !selected.has(sourceId) && pointById.has(sourceId),
    );
    if (missingPrerequisiteIds.length > 0) {
      warnings.push({
        code: 'MISSING_PREREQUISITE',
        message: `${point.name} 缺少先修知识点：${missingPrerequisiteIds
          .map((sourceId) => pointById.get(sourceId)?.name ?? sourceId)
          .join('、')}。`,
        knowledgePointIds: [id, ...missingPrerequisiteIds],
      });
    }
    return {
      knowledgePointId: id,
      name: point.name,
      code: point.code,
      summary: point.summary,
      type: point.type,
      difficulty: point.difficulty,
      coverageLevel: inputPoint?.coverageLevel ?? 'introduced',
      note: inputPoint?.note ?? null,
      order: index + 1,
      parentId: point.parentId,
      childIds: selectedIds
        .filter((candidateId) => pointById.get(candidateId)?.parentId === id)
        .sort((a, b) => compareKnowledgePoints(byId.get(a)!, byId.get(b)!)),
      prerequisiteIds,
      followUpIds: followUpBySource.get(id) ?? [],
      relatedIds: relatedBySource.get(id) ?? [],
      missingPrerequisiteIds,
    };
  });

  const pointByName = new Map(orderedPoints.map((point) => [point.knowledgePointId, point]));
  const contentSlides: CourseAssemblySlide[] = orderedPoints.map((point) => {
    const children = point.childIds
      .map((childId) => pointByName.get(childId))
      .filter(Boolean) as CourseAssemblyKnowledgePoint[];
    const points = children.length
      ? children.map((child) => child.name).slice(0, 6)
      : splitSummaryPoints(point.summary);
    const fallback = points.length
      ? points
      : fallbackPoints(byId.get(point.knowledgePointId)!).slice(0, 6);
    return {
      order: 0,
      title: point.name,
      points: fallback,
      narration: buildKnowledgePointNarration(byId.get(point.knowledgePointId)!),
      knowledgePointIds: [point.knowledgePointId],
    };
  });

  const selectedChildrenByParent = new Map<string, string[]>();
  for (const point of orderedPoints) {
    if (!point.parentId || !selected.has(point.parentId)) continue;
    const children = selectedChildrenByParent.get(point.parentId) ?? [];
    children.push(point.knowledgePointId);
    selectedChildrenByParent.set(point.parentId, children);
  }
  const topLevelIds = orderedPoints
    .filter((point) => !point.parentId || !selected.has(point.parentId))
    .map((point) => point.knowledgePointId);
  const groupByTop = (topId: string) => {
    const result = [topId];
    const visit = (id: string) => {
      for (const childId of selectedChildrenByParent.get(id) ?? []) {
        result.push(childId);
        visit(childId);
      }
    };
    visit(topId);
    return result;
  };
  const objectives = topLevelIds
    .map((topId) =>
      objectiveForGroup(
        groupByTop(topId)
          .map((id) => pointByName.get(id))
          .filter((point): point is CourseAssemblyKnowledgePoint => Boolean(point)),
      ),
    )
    .filter(Boolean)
    .slice(0, 8);

  const scenes: CourseAssemblySlide[] = [
    {
      order: 1,
      title: `封面：${input.title}`,
      points: [input.title, text(input.code) ?? '课程组装草稿', '按知识点顺序组织'],
      narration: `欢迎学习${input.title}。本课程将按知识点依赖顺序展开。`,
      knowledgePointIds: [],
    },
    {
      order: 2,
      title: '本节目标',
      points: objectives,
      narration: objectives.length
        ? `学完本课程，你应该能够：${objectives.join('；')}。`
        : '请根据知识点库补充本课程目标。',
      knowledgePointIds: [],
    },
    ...contentSlides,
    {
      order: 0,
      title: '本节小结',
      points: orderedPoints.map((point) => point.name).slice(0, 8),
      narration: '本课程的内容到这里就讲完了，我们再来回顾一下今天覆盖的知识点。',
      knowledgePointIds: [],
    },
    {
      order: 0,
      title: '随堂测验',
      points: ['用 3 道题检查核心概念', '重点检查先修链上的基础知识点'],
      narration: '最后用几道随堂测验检查一下掌握情况，重点复习先修链上的基础知识点。',
      knowledgePointIds: [],
    },
  ].map((slide, index) => ({ ...slide, order: index + 1 }));

  const hours = input.hours ?? estimateHours(orderedPoints);
  const code = text(input.code) ?? '';
  const title = text(input.title) ?? '未命名课程';
  const chapter = text(input.chapter) ?? '';
  const section = text(input.section) ?? '';
  const type = text(input.type) ?? 'theory';
  const coursePackage = buildPlanPackage({
    title,
    code,
    chapter,
    section,
    type,
    hours,
    objectives,
    slides: scenes,
    orderedPoints,
  });
  const fallbackCode = 'assembled-course';
  const packageCode = makeFileSafeCode(code, fallbackCode);
  const packageFileName = `${packageCode}.json`;
  const suggestedPackagePath = `course-packages/assembled/${packageFileName}`;
  const folderName = series?.name ?? title;
  const suggestedRunCommand = [
    'node scripts/start-lesson-generation.mjs',
    `--package ${suggestedPackagePath}`,
    '--base-url http://localhost:3000',
    '--anonymous-id <anonymous_id>',
    `--folder "${folderName}"`,
  ].join(' ');

  return {
    seriesId,
    seriesName: series?.name ?? null,
    title,
    code,
    chapter,
    section,
    type,
    hours,
    objectives,
    knowledgePoints: orderedPoints,
    slides: scenes,
    warnings: warnings.filter((warning, index, all) => {
      const key = `${warning.code}:${warning.knowledgePointIds.join(',')}`;
      return (
        all.findIndex((item) => `${item.code}:${item.knowledgePointIds.join(',')}` === key) ===
        index
      );
    }),
    coursePackage,
    packageFileName,
    suggestedPackagePath,
    suggestedRunCommand,
  };
}
