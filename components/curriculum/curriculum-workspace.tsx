'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  GraduationCap,
  Library,
  ListChecks,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Video,
} from 'lucide-react';

import { Canvas } from '@/components/ai-elements/canvas';
import { KnowledgePointsPanel } from '@/components/curriculum/knowledge-points-panel';
import { BatchQueuePanel } from '@/components/curriculum/batch-queue-panel';
import { BatchExportPanel } from '@/components/curriculum/batch-export-panel';
import { CourseAssemblerPanel } from '@/components/curriculum/course-assembler-panel';
import { KnowledgeRelationsPanel } from '@/components/curriculum/knowledge-relations-panel';
import { ProgramDiffPanel } from '@/components/curriculum/program-diff-panel';
import { ProgramPlanPanel } from '@/components/curriculum/program-plan-panel';
import { Controls } from '@/components/ai-elements/controls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  CURRICULUM_COURSE_STATUSES,
  CURRICULUM_RELATION_TYPES,
  type CurriculumCourseRecord,
  type CurriculumRelationRecord,
  type CurriculumRelationType,
  type CurriculumSnapshot,
} from '@/lib/curriculum/types';

interface StageOption {
  id: string;
  name: string;
}

interface CourseFormState {
  title: string;
  code: string;
  seriesId: string;
  stageId: string;
  chapter: string;
  section: string;
  lessonOrder: string;
  hours: string;
  credits: string;
  semester: string;
  status: string;
  description: string;
}

const EMPTY_COURSE_FORM: CourseFormState = {
  title: '',
  code: '',
  seriesId: '',
  stageId: '',
  chapter: '',
  section: '',
  lessonOrder: '0',
  hours: '',
  credits: '',
  semester: '',
  status: 'active',
  description: '',
};

type WorkflowStepId =
  | 'curriculum-ledger'
  | 'curriculum-knowledge'
  | 'curriculum-program'
  | 'curriculum-assembly'
  | 'curriculum-batch'
  | 'curriculum-export';

const WORKFLOW_STEPS = [
  {
    id: 'curriculum-ledger',
    label: '课程台账',
    hint: '先建系列和课程',
    icon: BookOpen,
  },
  {
    id: 'curriculum-knowledge',
    label: '知识体系',
    hint: '维护知识点和先修关系',
    icon: Network,
  },
  {
    id: 'curriculum-program',
    label: '培养方案',
    hint: '课程-指标点支撑矩阵',
    icon: GraduationCap,
  },
  {
    id: 'curriculum-assembly',
    label: '课程组装',
    hint: '选知识点生成课程包',
    icon: Boxes,
  },
  {
    id: 'curriculum-batch',
    label: '批量生成',
    hint: '排队生成课堂',
    icon: ListChecks,
  },
  {
    id: 'curriculum-export',
    label: '视频导出',
    hint: '浏览器队列导出 MP4',
    icon: Video,
  },
] as const;

/** URL aliases keep refresh / share links short while the internal ids stay explicit. */
const WORKFLOW_TAB_PARAM: Record<WorkflowStepId, string> = {
  'curriculum-ledger': 'ledger',
  'curriculum-knowledge': 'knowledge',
  'curriculum-program': 'program',
  'curriculum-assembly': 'assembly',
  'curriculum-batch': 'batch',
  'curriculum-export': 'export',
};

const WORKFLOW_TAB_ALIASES: Record<string, WorkflowStepId> = {
  ...(Object.fromEntries(
    Object.entries(WORKFLOW_TAB_PARAM).map(([id, alias]) => [alias, id as WorkflowStepId]),
  ) as Record<string, WorkflowStepId>),
  'curriculum-ledger': 'curriculum-ledger',
  'curriculum-knowledge': 'curriculum-knowledge',
  'curriculum-program': 'curriculum-program',
  'curriculum-assembly': 'curriculum-assembly',
  'curriculum-batch': 'curriculum-batch',
  'curriculum-export': 'curriculum-export',
};

function parseWorkflowTab(value: string | null): WorkflowStepId {
  if (!value) return 'curriculum-ledger';
  return WORKFLOW_TAB_ALIASES[value] ?? 'curriculum-ledger';
}

function currentWorkflowTab(): WorkflowStepId {
  if (typeof window === 'undefined') return 'curriculum-ledger';
  return parseWorkflowTab(new URLSearchParams(window.location.search).get('tab'));
}

function currentSeriesId(): string {
  if (typeof window === 'undefined') return '';
  return new URLSearchParams(window.location.search).get('series') ?? '';
}

const RELATION_LABELS: Record<CurriculumRelationType, string> = {
  prerequisite: '先修',
  'follow-up': '后续',
  related: '相关',
  supports: '支撑',
};

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
    [key: string]: unknown;
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
}

export function CurriculumWorkspace() {
  const router = useRouter();
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<CurriculumSnapshot>({
    series: [],
    courses: [],
    relations: [],
    knowledgePoints: [],
    courseKnowledgePoints: [],
    knowledgePointRelations: [],
    generationJobs: [],
    batches: [],
    batchItems: [],
    exportJobs: [],
    programs: [],
    programVersions: [],
    graduationIndicators: [],
    programCourses: [],
    courseIndicatorSupports: [],
  });
  const [stages, setStages] = useState<StageOption[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>('');
  const [courseForm, setCourseForm] = useState<CourseFormState>(EMPTY_COURSE_FORM);
  const [seriesName, setSeriesName] = useState('');
  const [seriesDescription, setSeriesDescription] = useState('');
  const [relationSource, setRelationSource] = useState('');
  const [relationTarget, setRelationTarget] = useState('');
  const [relationType, setRelationType] = useState<CurriculumRelationType>('prerequisite');
  const [relationNote, setRelationNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<WorkflowStepId>('curriculum-ledger');

  const tabContentClass = (value: WorkflowStepId) =>
    `flex-col gap-6 outline-none ${activeTab === value ? 'flex' : 'hidden'}`;

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const [curriculum, stagePayload] = await Promise.all([
        requestJson<CurriculumSnapshot>('/api/curriculum'),
        requestJson<{ stages: Array<{ id: string; name: string }> }>('/api/stages'),
      ]);
      setSnapshot(curriculum);
      setStages((stagePayload.stages ?? []).map((stage) => ({ id: stage.id, name: stage.name })));
      setSelectedSeriesId((current) => {
        if (current) return current;
        const requested = currentSeriesId();
        if (requested && curriculum.series.some((series) => series.id === requested)) {
          return requested;
        }
        return curriculum.series[0]?.id ?? '';
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const syncFromUrl = () => {
      setActiveTab(currentWorkflowTab());
      setSelectedSeriesId(currentSeriesId());
    };
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  const handleSeriesChange = useCallback(
    (value: string) => {
      setSelectedSeriesId(value);
      const params = new URLSearchParams(window.location.search);
      if (value) params.set('series', value);
      else params.delete('series');
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const handleTabChange = useCallback(
    (value: string) => {
      const nextTab = parseWorkflowTab(value);
      setActiveTab(nextTab);
      const params = new URLSearchParams(window.location.search);
      if (nextTab === 'curriculum-ledger') params.delete('tab');
      else params.set('tab', WORKFLOW_TAB_PARAM[nextTab]);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const visibleCourses = useMemo(() => {
    if (!selectedSeriesId) return snapshot.courses;
    return snapshot.courses.filter((course) => course.seriesId === selectedSeriesId);
  }, [selectedSeriesId, snapshot.courses]);

  const courseById = useMemo(
    () => new Map(snapshot.courses.map((course) => [course.id, course])),
    [snapshot.courses],
  );

  const graphNodes = useMemo(
    () =>
      visibleCourses.map((course, index) => ({
        id: course.id,
        position: {
          x: (index % 3) * 280,
          y: Math.floor(index / 3) * 140,
        },
        data: { label: `${course.code ? `${course.code} ` : ''}${course.title}` },
        style: { width: 220, fontSize: 13 },
      })),
    [visibleCourses],
  );

  const graphEdges = useMemo(
    () =>
      snapshot.relations
        .filter(
          (relation) =>
            courseById.has(relation.sourceCourseId) && courseById.has(relation.targetCourseId),
        )
        .filter((relation) => {
          if (!selectedSeriesId) return true;
          return (
            courseById.get(relation.sourceCourseId)?.seriesId === selectedSeriesId &&
            courseById.get(relation.targetCourseId)?.seriesId === selectedSeriesId
          );
        })
        .map((relation) => ({
          id: relation.id,
          source: relation.sourceCourseId,
          target: relation.targetCourseId,
          label: RELATION_LABELS[relation.relationType],
          animated: relation.relationType === 'prerequisite',
        })),
    [courseById, selectedSeriesId, snapshot.relations],
  );

  const visibleCourseIds = useMemo(
    () => new Set(visibleCourses.map((course) => course.id)),
    [visibleCourses],
  );

  const scopedCourseKnowledgePoints = useMemo(
    () => snapshot.courseKnowledgePoints.filter((link) => visibleCourseIds.has(link.courseId)),
    [snapshot.courseKnowledgePoints, visibleCourseIds],
  );

  const scopedKnowledgePoints = useMemo(() => {
    if (!selectedSeriesId) return snapshot.knowledgePoints;
    return snapshot.knowledgePoints.filter((point) => point.seriesId === selectedSeriesId);
  }, [selectedSeriesId, snapshot.knowledgePoints]);

  const scopedGenerationJobs = useMemo(
    () => snapshot.generationJobs.filter((job) => visibleCourseIds.has(job.courseId)),
    [snapshot.generationJobs, visibleCourseIds],
  );

  const scopedBatchItems = useMemo(
    () =>
      snapshot.batchItems.filter(
        (item) => item.courseId !== null && visibleCourseIds.has(item.courseId),
      ),
    [snapshot.batchItems, visibleCourseIds],
  );

  const scopedBatches = useMemo(() => {
    const batchIds = new Set(scopedBatchItems.map((item) => item.batchId));
    return snapshot.batches.filter((batch) => batchIds.has(batch.id));
  }, [scopedBatchItems, snapshot.batches]);

  const scopedExportJobs = useMemo(
    () =>
      snapshot.exportJobs.filter(
        (job) => job.courseId !== null && visibleCourseIds.has(job.courseId),
      ),
    [snapshot.exportJobs, visibleCourseIds],
  );

  const workflow = useMemo(() => {
    const linkedKnowledgeCount = scopedCourseKnowledgePoints.length;
    const generatedStageCount = scopedGenerationJobs.filter((job) => job.stageId).length;
    const completedBatchCount = scopedBatchItems.filter(
      (item) => item.status === 'completed',
    ).length;
    const succeededExportCount = scopedExportJobs.filter(
      (job) => job.status === 'succeeded',
    ).length;
    const programReady = snapshot.programVersions.length > 0 && snapshot.programCourses.length > 0;

    const steps = [
      {
        ...WORKFLOW_STEPS[0],
        done: visibleCourses.length > 0,
        meta: `${visibleCourses.length} 门课程`,
      },
      {
        ...WORKFLOW_STEPS[1],
        done: linkedKnowledgeCount > 0,
        meta: `${scopedKnowledgePoints.length} 个知识点 · ${linkedKnowledgeCount} 条关联`,
      },
      {
        ...WORKFLOW_STEPS[2],
        done: programReady,
        meta: `${snapshot.programVersions.length} 个版本 · ${snapshot.programCourses.length} 门计划`,
      },
      {
        ...WORKFLOW_STEPS[3],
        done: generatedStageCount > 0,
        meta: `${generatedStageCount} 个课堂已生成`,
      },
      {
        ...WORKFLOW_STEPS[4],
        done: completedBatchCount > 0 || (scopedBatches.length === 0 && generatedStageCount > 0),
        meta:
          scopedBatches.length > 0
            ? `${scopedBatches.length} 个批次 · ${completedBatchCount} 项完成`
            : generatedStageCount > 0
              ? '未使用批量，已按单课生成'
              : '还没有批量任务',
      },
      {
        ...WORKFLOW_STEPS[5],
        done: succeededExportCount > 0,
        meta: `${succeededExportCount}/${scopedExportJobs.length} 个视频已导出`,
      },
    ];
    const completedSteps = steps.filter((step) => step.done).length;
    return {
      steps,
      completedSteps,
      percent: Math.round((completedSteps / steps.length) * 100),
    };
  }, [
    scopedBatchItems,
    scopedBatches,
    scopedCourseKnowledgePoints.length,
    scopedExportJobs,
    scopedGenerationJobs,
    scopedKnowledgePoints.length,
    snapshot.programCourses.length,
    snapshot.programVersions.length,
    visibleCourses.length,
  ]);

  const resetCourseForm = () => {
    setCourseForm({ ...EMPTY_COURSE_FORM, seriesId: selectedSeriesId });
  };

  useEffect(() => {
    if (!selectedSeriesId) return;
    setCourseForm((current) =>
      current.seriesId ? current : { ...current, seriesId: selectedSeriesId },
    );
  }, [selectedSeriesId]);

  const createSeries = async () => {
    if (!seriesName.trim()) return;
    setBusy('series');
    setError(null);
    try {
      await requestJson('/api/curriculum/series', {
        method: 'POST',
        body: JSON.stringify({
          name: seriesName.trim(),
          description: seriesDescription.trim() || null,
        }),
      });
      setSeriesName('');
      setSeriesDescription('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const submitCourse = async () => {
    if (!courseForm.title.trim()) return;
    const body = {
      title: courseForm.title.trim(),
      code: courseForm.code.trim() || null,
      seriesId: courseForm.seriesId || null,
      stageId: courseForm.stageId || null,
      chapter: courseForm.chapter.trim() || null,
      section: courseForm.section.trim() || null,
      lessonOrder: Number.parseInt(courseForm.lessonOrder, 10) || 0,
      hours: courseForm.hours.trim() === '' ? null : Number(courseForm.hours),
      credits: courseForm.credits.trim() === '' ? null : Number(courseForm.credits),
      semester: courseForm.semester.trim() || null,
      status: courseForm.status,
      description: courseForm.description.trim() || null,
    };
    setBusy('course');
    setError(null);
    try {
      const payload = await requestJson<{ course: CurriculumCourseRecord }>(
        '/api/curriculum/courses',
        {
          method: 'POST',
          body: JSON.stringify(body),
        },
      );
      resetCourseForm();
      router.push(`/curriculum/courses/${payload.course.id}`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteCourse = async (course: CurriculumCourseRecord) => {
    if (!window.confirm(`删除课程“${course.title}”？不会删除已生成的课堂。`)) return;
    setBusy(`delete-${course.id}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/courses/${course.id}`, { method: 'DELETE' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const createRelation = async () => {
    if (!relationSource || !relationTarget || relationSource === relationTarget) return;
    setBusy('relation');
    setError(null);
    try {
      await requestJson('/api/curriculum/relations', {
        method: 'POST',
        body: JSON.stringify({
          sourceCourseId: relationSource,
          targetCourseId: relationTarget,
          relationType,
          note: relationNote.trim() || null,
        }),
      });
      setRelationNote('');
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteRelation = async (relation: CurriculumRelationRecord) => {
    setBusy(`relation-${relation.id}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/relations/${relation.id}`, { method: 'DELETE' });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1600px] flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/')}
            title="返回首页"
            aria-label="返回首页"
            className="mt-0.5 shrink-0"
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <p className="text-muted-foreground text-sm">课程产品层 / Curriculum</p>
            <h1 className="text-2xl font-semibold">课程体系与培养方案</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              用一条流水线完成：建课程 → 维护知识点 → 配培养方案 → 组装 → 生成课堂 → 导出视频。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" asChild>
            <Link href="/curriculum/series">
              <Library />
              课程序列
            </Link>
          </Button>
          <Button variant="outline" onClick={() => router.push('/')}>
            <BookOpen />
            去单课生成
          </Button>
          <Button variant="outline" onClick={() => void load()} disabled={busy !== null}>
            {busy === 'load' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </header>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-6">
        <Card size="sm">
          <CardContent className="flex flex-col gap-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <div className="text-sm font-medium">课程体系建设进度</div>
                <div className="text-muted-foreground mt-0.5 text-xs">
                  按当前系列统计：课程 → 知识点 → 培养方案 → 生成 → 批量 → 导出。
                </div>
              </div>
              <div className="text-muted-foreground text-sm tabular-nums">
                {workflow.completedSteps}/{workflow.steps.length} 已完成 · {workflow.percent}%
              </div>
            </div>
            <Progress value={workflow.percent} className="h-2" />
            <TabsList className="grid! h-auto! min-h-0 w-full! grid-cols-1 justify-stretch! gap-2 overflow-visible bg-transparent! p-0! sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-6">
              {workflow.steps.map((step, index) => {
                const Icon = step.icon;
                return (
                  <TabsTrigger
                    key={step.id}
                    value={step.id}
                    title={step.hint}
                    className={`h-auto! min-h-20 min-w-0 flex-col items-start! justify-start! gap-1.5 rounded-xl border bg-muted/30 px-3 py-3 text-left whitespace-normal! data-active:border-primary data-active:bg-primary/5 data-active:shadow-none ${
                      step.done ? 'border-emerald-500/30' : ''
                    }`}
                  >
                    <span className="flex w-full min-w-0 items-center gap-1.5">
                      <span className="bg-background/80 text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums">
                        {index + 1}
                      </span>
                      <Icon className="size-3.5 shrink-0" />
                      <span className="min-w-0 truncate font-medium">{step.label}</span>
                      {step.done ? (
                        <CheckCircle2 className="ml-auto size-3.5 shrink-0 text-emerald-600" />
                      ) : null}
                    </span>
                    <span className="text-muted-foreground line-clamp-2 w-full min-w-0 text-xs leading-4">
                      {step.meta}
                    </span>
                  </TabsTrigger>
                );
              })}
            </TabsList>
          </CardContent>
        </Card>

        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        ) : null}

        <div className="grid gap-6 xl:grid-cols-[280px_minmax(0,1fr)]">
          <aside className="flex flex-col gap-4">
            <Card size="sm">
              <CardHeader>
                <CardTitle>课程系列</CardTitle>
                <CardDescription>一个专业方向或一个课程包系列。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <Input
                  placeholder="系列名称，例如 CTF综合实战"
                  value={seriesName}
                  onChange={(event) => setSeriesName(event.target.value)}
                />
                <Textarea
                  placeholder="描述（可选）"
                  value={seriesDescription}
                  onChange={(event) => setSeriesDescription(event.target.value)}
                  className="min-h-20"
                />
                <Button
                  onClick={() => void createSeries()}
                  disabled={busy !== null || !seriesName.trim()}
                >
                  <Plus />
                  新建/复用系列
                </Button>
              </CardContent>
            </Card>

            <Card size="sm">
              <CardHeader>
                <CardTitle>系列列表</CardTitle>
                <CardDescription>选择系列后，下面所有步骤都会按这个系列统计。</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                <button
                  type="button"
                  onClick={() => handleSeriesChange('')}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${
                    selectedSeriesId === '' ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  全部课程
                </button>
                {snapshot.series.map((series) => (
                  <button
                    key={series.id}
                    type="button"
                    onClick={() => handleSeriesChange(series.id)}
                    className={`rounded-md border px-3 py-2 text-left text-sm ${
                      selectedSeriesId === series.id
                        ? 'border-primary bg-primary/5'
                        : 'border-border'
                    }`}
                  >
                    <span className="block font-medium">{series.name}</span>
                    <span className="text-muted-foreground text-xs">
                      {series.courseCount} 门课程
                    </span>
                  </button>
                ))}
                <Button asChild variant="outline" size="sm" className="mt-1">
                  <Link href="/curriculum/series">
                    <Library />
                    管理课程序列
                  </Link>
                </Button>
              </CardContent>
            </Card>
          </aside>

          <main className="flex flex-col gap-6">
            {selectedSeriesId ? (
              <div className="border-border bg-muted/40 flex flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-sm">
                <span>
                  当前系列：
                  <strong>
                    {snapshot.series.find((series) => series.id === selectedSeriesId)?.name ??
                      selectedSeriesId}
                  </strong>
                </span>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => handleSeriesChange('')}
                  className="h-auto p-0"
                >
                  查看全部系列
                </Button>
              </div>
            ) : null}
            <TabsContent
              value="curriculum-ledger"
              id="curriculum-ledger"
              className={tabContentClass('curriculum-ledger')}
              forceMount
            >
              <Card>
                <CardHeader>
                  <CardTitle>新建课程产品</CardTitle>
                  <CardDescription>
                    创建后会直接打开课程产品页，把「基本信息 → 知识点 → 组装生成 →
                    导出视频」一路做完。
                  </CardDescription>
                </CardHeader>
                <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
                  <Input
                    placeholder="课程标题 *"
                    value={courseForm.title}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, title: event.target.value })
                    }
                  />
                  <Input
                    placeholder="课程编号，例如 CTF-1-1-1"
                    value={courseForm.code}
                    onChange={(event) => setCourseForm({ ...courseForm, code: event.target.value })}
                  />
                  <select
                    className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                    value={courseForm.seriesId}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, seriesId: event.target.value })
                    }
                  >
                    <option value="">未归属系列</option>
                    {snapshot.series.map((series) => (
                      <option key={series.id} value={series.id}>
                        {series.name}
                      </option>
                    ))}
                  </select>
                  <select
                    className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                    value={courseForm.stageId}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, stageId: event.target.value })
                    }
                  >
                    <option value="">不关联课堂</option>
                    {stages.map((stage) => (
                      <option key={stage.id} value={stage.id}>
                        {stage.name} ({stage.id})
                      </option>
                    ))}
                  </select>
                  <Input
                    placeholder="章，例如 第一章 CTF基础"
                    value={courseForm.chapter}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, chapter: event.target.value })
                    }
                  />
                  <Input
                    placeholder="节，例如 第一节 CTF入门"
                    value={courseForm.section}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, section: event.target.value })
                    }
                  />
                  <Input
                    type="number"
                    placeholder="目顺序"
                    value={courseForm.lessonOrder}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, lessonOrder: event.target.value })
                    }
                  />
                  <Input
                    type="number"
                    placeholder="学时"
                    value={courseForm.hours}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, hours: event.target.value })
                    }
                  />
                  <Input
                    type="number"
                    placeholder="学分"
                    value={courseForm.credits}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, credits: event.target.value })
                    }
                  />
                  <Input
                    placeholder="学期，例如 2026春"
                    value={courseForm.semester}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, semester: event.target.value })
                    }
                  />
                  <select
                    className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                    value={courseForm.status}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, status: event.target.value })
                    }
                  >
                    {CURRICULUM_COURSE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                  <Textarea
                    placeholder="描述（可选）"
                    value={courseForm.description}
                    onChange={(event) =>
                      setCourseForm({ ...courseForm, description: event.target.value })
                    }
                    className="md:col-span-2 xl:col-span-3"
                  />
                  <div className="flex gap-2 md:col-span-2 xl:col-span-3">
                    <Button
                      onClick={() => void submitCourse()}
                      disabled={busy !== null || !courseForm.title.trim()}
                    >
                      {busy === 'course' ? <Loader2 className="animate-spin" /> : <Save />}
                      创建并打开课程
                      <ArrowRight />
                    </Button>
                  </div>
                </CardContent>
              </Card>

              <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <Card>
                  <CardHeader>
                    <CardTitle>课程台账</CardTitle>
                    <CardDescription>{visibleCourses.length} 门课程</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    {visibleCourses.map((course) => (
                      <div
                        key={course.id}
                        className="border-border flex flex-col gap-2 rounded-lg border p-3 text-sm"
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0">
                            <Link
                              href={`/curriculum/courses/${course.id}`}
                              className="font-medium hover:underline"
                            >
                              {course.title}
                            </Link>
                            <div className="text-muted-foreground text-xs">
                              {[course.code, course.chapter, course.section]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          </div>
                          <div className="flex shrink-0 gap-1">
                            <Button asChild size="xs" variant="outline">
                              <Link href={`/curriculum/courses/${course.id}`}>打开课程</Link>
                            </Button>
                            <Button
                              size="icon-xs"
                              variant="destructive"
                              onClick={() => void deleteCourse(course)}
                              disabled={busy !== null}
                            >
                              <Trash2 />
                            </Button>
                          </div>
                        </div>
                        <div className="text-muted-foreground grid grid-cols-2 gap-1 text-xs">
                          <span>学时：{course.hours ?? '-'}</span>
                          <span>状态：{course.status}</span>
                          <span className="col-span-2 break-all">
                            stage：
                            {course.stageId ? (
                              <Link
                                href={`/classroom/${course.stageId}`}
                                className="text-primary font-medium hover:underline"
                              >
                                {course.stageId} · 打开课堂
                              </Link>
                            ) : (
                              '-'
                            )}
                          </span>
                        </div>
                      </div>
                    ))}
                    {visibleCourses.length === 0 ? (
                      <p className="text-muted-foreground py-8 text-center text-sm">还没有课程</p>
                    ) : null}
                  </CardContent>
                </Card>

                <Card>
                  <CardHeader>
                    <CardTitle>课程关系</CardTitle>
                    <CardDescription>维护先修、后续、相关、支撑关系。</CardDescription>
                  </CardHeader>
                  <CardContent className="flex flex-col gap-3">
                    <div className="grid gap-2 md:grid-cols-2">
                      <select
                        className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                        value={relationSource}
                        onChange={(event) => setRelationSource(event.target.value)}
                      >
                        <option value="">源课程</option>
                        {snapshot.courses.map((course) => (
                          <option key={course.id} value={course.id}>
                            {course.title}
                          </option>
                        ))}
                      </select>
                      <select
                        className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                        value={relationTarget}
                        onChange={(event) => setRelationTarget(event.target.value)}
                      >
                        <option value="">目标课程</option>
                        {snapshot.courses.map((course) => (
                          <option key={course.id} value={course.id}>
                            {course.title}
                          </option>
                        ))}
                      </select>
                      <select
                        className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                        value={relationType}
                        onChange={(event) =>
                          setRelationType(event.target.value as CurriculumRelationType)
                        }
                      >
                        {CURRICULUM_RELATION_TYPES.map((type) => (
                          <option key={type} value={type}>
                            {RELATION_LABELS[type]}
                          </option>
                        ))}
                      </select>
                      <Input
                        placeholder="备注（可选）"
                        value={relationNote}
                        onChange={(event) => setRelationNote(event.target.value)}
                      />
                    </div>
                    <Button
                      onClick={() => void createRelation()}
                      disabled={
                        busy !== null ||
                        !relationSource ||
                        !relationTarget ||
                        relationSource === relationTarget
                      }
                    >
                      <Plus />
                      新建/更新关系
                    </Button>
                    <div className="flex flex-col gap-2">
                      {snapshot.relations.map((relation) => (
                        <div
                          key={relation.id}
                          className="border-border flex items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs"
                        >
                          <span>
                            {courseById.get(relation.sourceCourseId)?.title ??
                              relation.sourceCourseId}
                            {' → '}
                            {RELATION_LABELS[relation.relationType]}
                            {' → '}
                            {courseById.get(relation.targetCourseId)?.title ??
                              relation.targetCourseId}
                          </span>
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            onClick={() => void deleteRelation(relation)}
                            disabled={busy !== null}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </div>

              <Card>
                <CardHeader>
                  <CardTitle>课程关系图</CardTitle>
                  <CardDescription>当前筛选系列下的课程与关系。</CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="h-[520px] overflow-hidden rounded-lg border">
                    <Canvas nodes={graphNodes} edges={graphEdges} fitView>
                      <Controls />
                    </Canvas>
                  </div>
                </CardContent>
              </Card>
            </TabsContent>

            <TabsContent
              value="curriculum-knowledge"
              id="curriculum-knowledge"
              className={tabContentClass('curriculum-knowledge')}
              forceMount
            >
              <KnowledgePointsPanel
                seriesId={selectedSeriesId}
                courses={visibleCourses}
                knowledgePoints={snapshot.knowledgePoints}
                courseKnowledgePoints={snapshot.courseKnowledgePoints}
                onChanged={load}
              />

              <KnowledgeRelationsPanel
                seriesId={selectedSeriesId}
                courses={snapshot.courses}
                knowledgePoints={snapshot.knowledgePoints}
                knowledgePointRelations={snapshot.knowledgePointRelations}
                courseKnowledgePoints={snapshot.courseKnowledgePoints}
                onChanged={load}
              />
            </TabsContent>

            <TabsContent
              value="curriculum-program"
              id="curriculum-program"
              className={tabContentClass('curriculum-program')}
              forceMount
            >
              <ProgramPlanPanel snapshot={snapshot} onChanged={load} />
              <ProgramDiffPanel snapshot={snapshot} onChanged={load} />
            </TabsContent>

            <TabsContent
              value="curriculum-assembly"
              id="curriculum-assembly"
              className={tabContentClass('curriculum-assembly')}
              forceMount
            >
              <CourseAssemblerPanel
                seriesId={selectedSeriesId}
                courses={snapshot.courses}
                knowledgePoints={snapshot.knowledgePoints}
                courseKnowledgePoints={snapshot.courseKnowledgePoints}
                generationJobs={snapshot.generationJobs}
                onChanged={load}
              />
            </TabsContent>

            <TabsContent
              value="curriculum-batch"
              id="curriculum-batch"
              className={tabContentClass('curriculum-batch')}
              forceMount
            >
              <BatchQueuePanel
                seriesId={selectedSeriesId}
                courses={snapshot.courses}
                courseKnowledgePoints={snapshot.courseKnowledgePoints}
                batches={snapshot.batches}
                batchItems={snapshot.batchItems}
                onChanged={load}
              />
            </TabsContent>

            <TabsContent
              value="curriculum-export"
              id="curriculum-export"
              className={tabContentClass('curriculum-export')}
              forceMount
            >
              <BatchExportPanel
                seriesId={selectedSeriesId}
                courses={snapshot.courses}
                batchItems={snapshot.batchItems}
                exportJobs={snapshot.exportJobs}
                onChanged={load}
              />

              <Card size="sm">
                <CardHeader>
                  <CardTitle>已有 stage</CardTitle>
                  <CardDescription>生成出来的课堂，可被课程台账关联。</CardDescription>
                </CardHeader>
                <CardContent className="grid gap-2 md:grid-cols-2">
                  {stages.map((stage) => (
                    <div
                      key={stage.id}
                      className="border-border flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-xs"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">{stage.name}</div>
                        <div className="text-muted-foreground break-all">{stage.id}</div>
                      </div>
                      <Link
                        href={`/classroom/${stage.id}`}
                        className="text-primary shrink-0 font-medium hover:underline"
                      >
                        打开课堂
                      </Link>
                    </div>
                  ))}
                </CardContent>
              </Card>
            </TabsContent>
          </main>
        </div>
      </Tabs>
    </div>
  );
}
