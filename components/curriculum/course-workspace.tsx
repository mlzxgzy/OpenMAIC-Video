'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import {
  ArrowLeft,
  BookOpen,
  Boxes,
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
  Network,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Video,
} from 'lucide-react';

import { CourseAssemblerPanel } from '@/components/curriculum/course-assembler-panel';
import { KnowledgePointsPanel } from '@/components/curriculum/knowledge-points-panel';
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

interface CourseWorkspaceProps {
  courseId: string;
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

const EMPTY_SNAPSHOT: CurriculumSnapshot = {
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
};

const RELATION_LABELS: Record<CurriculumRelationType, string> = {
  prerequisite: '先修',
  'follow-up': '后续',
  related: '相关',
  supports: '支撑',
};

const GENERATION_ACTIVE_STATUSES = ['queued', 'running', 'awaiting_outline', 'paused'] as const;
const EXPORT_ACTIVE_STATUSES = ['queued', 'building', 'submitting', 'rendering'] as const;

type CourseTabId = 'profile' | 'knowledge' | 'relations' | 'assembly' | 'classroom';

const COURSE_TABS = [
  { id: 'profile', label: '基本信息', hint: '课程台账字段', icon: BookOpen },
  { id: 'knowledge', label: '知识点', hint: '课程知识覆盖', icon: Network },
  { id: 'relations', label: '课程关系', hint: '先修 / 后续 / 支撑', icon: Link2 },
  { id: 'assembly', label: '组装与生成', hint: '从知识点生成课堂', icon: Boxes },
  { id: 'classroom', label: '课堂与视频', hint: '生成记录和导出状态', icon: Video },
] as const satisfies ReadonlyArray<{
  id: CourseTabId;
  label: string;
  hint: string;
  icon: typeof BookOpen;
}>;

function parseCourseTab(value: string | null): CourseTabId {
  return COURSE_TABS.some((tab) => tab.id === value) ? (value as CourseTabId) : 'profile';
}

function currentCourseTab(): CourseTabId {
  if (typeof window === 'undefined') return 'profile';
  return parseCourseTab(new URLSearchParams(window.location.search).get('tab'));
}

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

function courseToForm(course: CurriculumCourseRecord): CourseFormState {
  return {
    title: course.title,
    code: course.code ?? '',
    seriesId: course.seriesId ?? '',
    stageId: course.stageId ?? '',
    chapter: course.chapter ?? '',
    section: course.section ?? '',
    lessonOrder: String(course.lessonOrder),
    hours: course.hours === null ? '' : String(course.hours),
    credits: course.credits === null ? '' : String(course.credits),
    semester: course.semester ?? '',
    status: course.status,
    description: course.description ?? '',
  };
}

function relationText(
  relation: CurriculumRelationRecord,
  courseId: string,
  titleById: Map<string, string>,
) {
  const otherId =
    relation.sourceCourseId === courseId ? relation.targetCourseId : relation.sourceCourseId;
  const otherTitle = titleById.get(otherId) ?? otherId;
  const outgoing = relation.sourceCourseId === courseId;
  const arrow = outgoing ? `${otherTitle} → 本课程` : `本课程 → ${otherTitle}`;
  return {
    arrow,
    relationType: RELATION_LABELS[relation.relationType],
    note: relation.note,
  };
}

export function CourseWorkspace({ courseId }: CourseWorkspaceProps) {
  const router = useRouter();
  const pathname = usePathname();
  const [snapshot, setSnapshot] = useState<CurriculumSnapshot>(EMPTY_SNAPSHOT);
  const [stages, setStages] = useState<StageOption[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<CourseTabId>('profile');
  const [form, setForm] = useState<CourseFormState>(EMPTY_COURSE_FORM);
  const [otherCourseId, setOtherCourseId] = useState('');
  const [relationDirection, setRelationDirection] = useState<'outgoing' | 'incoming'>('outgoing');
  const [relationType, setRelationType] = useState<CurriculumRelationType>('prerequisite');
  const [relationNote, setRelationNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const hydratedCourseRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [curriculum, stagePayload] = await Promise.all([
        requestJson<CurriculumSnapshot>(`/api/curriculum/courses/${courseId}`),
        requestJson<{ stages: Array<{ id: string; name: string }> }>('/api/stages'),
      ]);
      setSnapshot(curriculum);
      setStages((stagePayload.stages ?? []).map((stage) => ({ id: stage.id, name: stage.name })));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, [courseId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const syncFromUrl = () => setActiveTab(currentCourseTab());
    syncFromUrl();
    window.addEventListener('popstate', syncFromUrl);
    return () => window.removeEventListener('popstate', syncFromUrl);
  }, []);

  const course = useMemo(
    () => snapshot.courses.find((candidate) => candidate.id === courseId) ?? null,
    [courseId, snapshot.courses],
  );

  useEffect(() => {
    if (!course || hydratedCourseRef.current === course.id) return;
    hydratedCourseRef.current = course.id;
    setForm(courseToForm(course));
  }, [course]);

  const courseJobs = useMemo(
    () => snapshot.generationJobs.filter((job) => job.courseId === courseId),
    [courseId, snapshot.generationJobs],
  );
  const courseExportJobs = useMemo(
    () => snapshot.exportJobs.filter((job) => job.courseId === courseId),
    [courseId, snapshot.exportJobs],
  );
  const courseRelations = useMemo(
    () =>
      snapshot.relations.filter(
        (relation) => relation.sourceCourseId === courseId || relation.targetCourseId === courseId,
      ),
    [courseId, snapshot.relations],
  );
  const courseKnowledgeLinks = useMemo(
    () => snapshot.courseKnowledgePoints.filter((link) => link.courseId === courseId),
    [courseId, snapshot.courseKnowledgePoints],
  );
  const otherCourses = useMemo(
    () => snapshot.courses.filter((candidate) => candidate.id !== courseId),
    [courseId, snapshot.courses],
  );
  const courseTitleById = useMemo(
    () => new Map(snapshot.courses.map((candidate) => [candidate.id, candidate.title])),
    [snapshot.courses],
  );
  const seriesName = useMemo(
    () => snapshot.series.find((series) => series.id === course?.seriesId)?.name ?? '未归属系列',
    [course?.seriesId, snapshot.series],
  );

  const hasActiveWork = useMemo(
    () =>
      courseJobs.some((job) =>
        (GENERATION_ACTIVE_STATUSES as readonly string[]).includes(job.status),
      ) ||
      courseExportJobs.some((job) =>
        (EXPORT_ACTIVE_STATUSES as readonly string[]).includes(job.status),
      ),
    [courseExportJobs, courseJobs],
  );

  useEffect(() => {
    if (!hasActiveWork) return;
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [hasActiveWork, load]);

  const tabContentClass = (value: CourseTabId) =>
    `flex-col gap-6 outline-none ${activeTab === value ? 'flex' : 'hidden'}`;

  const handleTabChange = useCallback(
    (value: string) => {
      const nextTab = parseCourseTab(value);
      setActiveTab(nextTab);
      const params = new URLSearchParams(window.location.search);
      if (nextTab === 'profile') params.delete('tab');
      else params.set('tab', nextTab);
      const query = params.toString();
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
    },
    [pathname, router],
  );

  const submitProfile = async () => {
    if (!form.title.trim()) return;
    setBusy('profile');
    setError(null);
    try {
      await requestJson(`/api/curriculum/courses/${courseId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          title: form.title.trim(),
          code: form.code.trim() || null,
          seriesId: form.seriesId || null,
          stageId: form.stageId || null,
          chapter: form.chapter.trim() || null,
          section: form.section.trim() || null,
          lessonOrder: Number.parseInt(form.lessonOrder, 10) || 0,
          hours: form.hours.trim() === '' ? null : Number(form.hours),
          credits: form.credits.trim() === '' ? null : Number(form.credits),
          semester: form.semester.trim() || null,
          status: form.status,
          description: form.description.trim() || null,
        }),
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteCourse = async () => {
    if (!course) return;
    if (!window.confirm(`删除课程“${course.title}”？不会删除已生成的课堂。`)) return;
    setBusy('delete-course');
    setError(null);
    try {
      await requestJson(`/api/curriculum/courses/${courseId}`, { method: 'DELETE' });
      router.push('/curriculum');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setBusy(null);
    }
  };

  const createRelation = async () => {
    if (!course || !otherCourseId) return;
    setBusy('relation');
    setError(null);
    try {
      const body =
        relationDirection === 'outgoing'
          ? {
              sourceCourseId: course.id,
              targetCourseId: otherCourseId,
              relationType,
              note: relationNote.trim() || null,
            }
          : {
              sourceCourseId: otherCourseId,
              targetCourseId: course.id,
              relationType,
              note: relationNote.trim() || null,
            };
      await requestJson('/api/curriculum/relations', {
        method: 'POST',
        body: JSON.stringify(body),
      });
      setOtherCourseId('');
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

  if (!loaded) {
    return (
      <div className="text-muted-foreground flex min-h-[60vh] items-center justify-center gap-2 text-sm">
        <Loader2 className="animate-spin" />
        正在加载课程产品...
      </div>
    );
  }

  if (!course) {
    return (
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-6">
        <Card>
          <CardHeader>
            <CardTitle>没有找到这个课程产品</CardTitle>
            <CardDescription>它可能已被删除，或者当前浏览器身份没有访问权限。</CardDescription>
          </CardHeader>
          <CardContent>
            <Button asChild variant="outline">
              <Link href="/curriculum">
                <ArrowLeft />
                返回课程体系
              </Link>
            </Button>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => router.push('/curriculum')}
            title="返回课程体系"
            aria-label="返回课程体系"
            className="mt-0.5 shrink-0"
          >
            <ArrowLeft />
          </Button>
          <div className="min-w-0">
            <p className="text-muted-foreground text-sm">
              课程产品层 / Curriculum / {course.code ?? '课程产品'}
            </p>
            <h1 className="text-2xl font-semibold">{course.title}</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              {seriesName}
              {course.chapter ? ` · ${course.chapter}` : ''}
              {course.section ? ` · ${course.section}` : ''}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={busy !== null}>
            {busy === 'load' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
          {course.stageId ? (
            <Button asChild>
              <Link href={`/classroom/${course.stageId}`}>
                <ExternalLink />
                打开课堂
              </Link>
            </Button>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Card size="sm">
          <CardHeader>
            <CardDescription>课程状态</CardDescription>
            <CardTitle className="text-base">{course.status}</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            {course.code ?? '未设置课程编号'} · {course.hours ?? '-'} 学时 · {course.credits ?? '-'}{' '}
            学分
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>知识点覆盖</CardDescription>
            <CardTitle className="text-base">{courseKnowledgeLinks.length} 条</CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            在“知识点”页把本课程绑定到知识点，并设置引入、练习或掌握。
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>生成记录</CardDescription>
            <CardTitle className="flex items-center gap-2 text-base">
              {course.stageId ? <CheckCircle2 className="size-4 text-emerald-600" /> : null}
              {courseJobs.length} 次
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            {course.stageId ? `已关联课堂 ${course.stageId}` : '还没有生成课堂'}
          </CardContent>
        </Card>
        <Card size="sm">
          <CardHeader>
            <CardDescription>视频导出</CardDescription>
            <CardTitle className="text-base">
              {courseExportJobs.filter((job) => job.status === 'succeeded').length}/
              {courseExportJobs.length}
            </CardTitle>
          </CardHeader>
          <CardContent className="text-muted-foreground text-xs">
            单课导出入口在课堂页；这里汇总导出任务状态。
          </CardContent>
        </Card>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange} className="gap-6">
        <TabsList className="grid! h-auto! min-h-0 w-full! grid-cols-1 justify-stretch! gap-2 overflow-visible bg-transparent! p-0! sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {COURSE_TABS.map((tab, index) => {
            const Icon = tab.icon;
            return (
              <TabsTrigger
                key={tab.id}
                value={tab.id}
                title={tab.hint}
                className="h-auto! min-h-20 min-w-0 flex-col items-start! justify-start! gap-1.5 rounded-xl border bg-muted/30 px-3 py-3 text-left whitespace-normal! data-active:border-primary data-active:bg-primary/5 data-active:shadow-none"
              >
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="bg-background/80 text-muted-foreground flex size-4 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold tabular-nums">
                    {index + 1}
                  </span>
                  <Icon className="size-3.5 shrink-0" />
                  <span className="min-w-0 truncate font-medium">{tab.label}</span>
                </span>
                <span className="text-muted-foreground line-clamp-2 w-full min-w-0 text-xs leading-4">
                  {tab.hint}
                </span>
              </TabsTrigger>
            );
          })}
        </TabsList>

        <TabsContent value="profile" className={tabContentClass('profile')} forceMount>
          <Card>
            <CardHeader>
              <CardTitle>基本信息</CardTitle>
              <CardDescription>课程产品台账字段；保存后立即写回课程实体。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Input
                placeholder="课程标题 *"
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
              />
              <Input
                placeholder="课程编号，例如 CTF-1-1-1"
                value={form.code}
                onChange={(event) => setForm({ ...form, code: event.target.value })}
              />
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={form.seriesId}
                onChange={(event) => setForm({ ...form, seriesId: event.target.value })}
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
                value={form.stageId}
                onChange={(event) => setForm({ ...form, stageId: event.target.value })}
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
                value={form.chapter}
                onChange={(event) => setForm({ ...form, chapter: event.target.value })}
              />
              <Input
                placeholder="节，例如 第一节 CTF入门"
                value={form.section}
                onChange={(event) => setForm({ ...form, section: event.target.value })}
              />
              <Input
                type="number"
                placeholder="目顺序"
                value={form.lessonOrder}
                onChange={(event) => setForm({ ...form, lessonOrder: event.target.value })}
              />
              <Input
                type="number"
                placeholder="学时"
                value={form.hours}
                onChange={(event) => setForm({ ...form, hours: event.target.value })}
              />
              <Input
                type="number"
                placeholder="学分"
                value={form.credits}
                onChange={(event) => setForm({ ...form, credits: event.target.value })}
              />
              <Input
                placeholder="学期，例如 2026春"
                value={form.semester}
                onChange={(event) => setForm({ ...form, semester: event.target.value })}
              />
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={form.status}
                onChange={(event) => setForm({ ...form, status: event.target.value })}
              >
                {CURRICULUM_COURSE_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
              <Textarea
                placeholder="描述（可选）"
                value={form.description}
                onChange={(event) => setForm({ ...form, description: event.target.value })}
                className="md:col-span-2 xl:col-span-3"
              />
              <div className="flex flex-wrap gap-2 md:col-span-2 xl:col-span-3">
                <Button
                  onClick={() => void submitProfile()}
                  disabled={busy !== null || !form.title.trim()}
                >
                  {busy === 'profile' ? <Loader2 className="animate-spin" /> : <Save />}
                  保存基本信息
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card className="border-destructive/30 mt-6">
            <CardHeader>
              <CardTitle className="text-destructive">危险操作</CardTitle>
              <CardDescription>删除课程产品不会删除已经生成出来的课堂。</CardDescription>
            </CardHeader>
            <CardContent>
              <Button
                variant="destructive"
                onClick={() => void deleteCourse()}
                disabled={busy !== null}
              >
                {busy === 'delete-course' ? <Loader2 className="animate-spin" /> : <Trash2 />}
                删除课程产品
              </Button>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="knowledge" className={tabContentClass('knowledge')} forceMount>
          <KnowledgePointsPanel
            seriesId={course.seriesId ?? ''}
            courses={[course]}
            knowledgePoints={snapshot.knowledgePoints}
            courseKnowledgePoints={snapshot.courseKnowledgePoints}
            defaultCourseId={course.id}
            onChanged={load}
          />
        </TabsContent>

        <TabsContent value="relations" className={tabContentClass('relations')} forceMount>
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Link2 className="size-4" />
                课程关系
              </CardTitle>
              <CardDescription>
                维护这门课程与其他课程之间的先修、后续、相关或支撑关系。
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                <select
                  className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                  value={relationDirection}
                  onChange={(event) =>
                    setRelationDirection(event.target.value as 'outgoing' | 'incoming')
                  }
                >
                  <option value="outgoing">本课程 → 其他课程</option>
                  <option value="incoming">其他课程 → 本课程</option>
                </select>
                <select
                  className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                  value={otherCourseId}
                  onChange={(event) => setOtherCourseId(event.target.value)}
                >
                  <option value="">选择另一门课程</option>
                  {otherCourses.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.title}
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
              <div>
                <Button
                  onClick={() => void createRelation()}
                  disabled={busy !== null || !otherCourseId}
                >
                  {busy === 'relation' ? <Loader2 className="animate-spin" /> : <Plus />}
                  新建 / 更新关系
                </Button>
              </div>

              <div className="flex flex-col gap-2">
                {courseRelations.map((relation) => {
                  const text = relationText(relation, course.id, courseTitleById);
                  return (
                    <div
                      key={relation.id}
                      className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                    >
                      <div className="min-w-0">
                        <div className="font-medium">
                          {text.relationType} · {text.arrow}
                        </div>
                        {text.note ? (
                          <div className="text-muted-foreground text-xs">{text.note}</div>
                        ) : null}
                      </div>
                      <Button
                        size="icon-xs"
                        variant="ghost"
                        onClick={() => void deleteRelation(relation)}
                        disabled={busy !== null}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  );
                })}
                {courseRelations.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    这门课程还没有配置任何关系。
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="assembly" className={tabContentClass('assembly')} forceMount>
          <CourseAssemblerPanel
            seriesId={course.seriesId ?? ''}
            courses={[course]}
            knowledgePoints={snapshot.knowledgePoints}
            courseKnowledgePoints={snapshot.courseKnowledgePoints}
            generationJobs={snapshot.generationJobs}
            initialCourseId={course.id}
            targetCourseId={course.id}
            onChanged={load}
          />
        </TabsContent>

        <TabsContent value="classroom" className={tabContentClass('classroom')} forceMount>
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader>
                <CardTitle>课堂</CardTitle>
                <CardDescription>
                  课程生成完成后会把 stage 自动回写到这门课程；从课堂页导出视频。
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {course.stageId ? (
                  <div className="border-border flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm">
                    <span className="break-all">{course.stageId}</span>
                    <Button asChild size="sm">
                      <Link href={`/classroom/${course.stageId}`}>
                        <ExternalLink />
                        打开课堂并导出
                      </Link>
                    </Button>
                  </div>
                ) : (
                  <p className="text-muted-foreground py-6 text-center text-sm">
                    还没有生成课堂。先到“组装与生成”页从课程知识点生成。
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>生成记录</CardTitle>
                <CardDescription>{courseJobs.length} 次生成任务</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {courseJobs.map((job) => (
                  <div
                    key={job.id}
                    className="border-border flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-sm"
                  >
                    <div className="min-w-0">
                      <div className="font-medium">{job.status}</div>
                      <div className="text-muted-foreground break-all text-xs">
                        {job.runId ? `run ${job.runId}` : 'run 未创建'}
                        {job.stageId ? ` · stage ${job.stageId}` : ''}
                      </div>
                      {job.error ? (
                        <div className="text-destructive text-xs">
                          {job.error.code}
                          {job.error.message ? `：${job.error.message}` : ''}
                        </div>
                      ) : null}
                    </div>
                    {job.stageId ? (
                      <Button asChild size="sm" variant="outline">
                        <Link href={`/classroom/${job.stageId}`}>
                          <ExternalLink />
                          打开课堂
                        </Link>
                      </Button>
                    ) : null}
                  </div>
                ))}
                {courseJobs.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">还没有生成记录。</p>
                ) : null}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>导出记录</CardTitle>
                <CardDescription>{courseExportJobs.length} 个导出任务</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                {courseExportJobs.map((job) => (
                  <div
                    key={job.id}
                    className="border-border flex flex-col gap-2 rounded-md border p-3"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                      <span className="font-medium">{job.status}</span>
                      <span className="text-muted-foreground text-xs">
                        {job.resolution} · {job.fps}fps · {job.quality}
                      </span>
                    </div>
                    <Progress value={job.progress} className="h-2" />
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                      <span className="text-muted-foreground break-all">
                        {job.renderJobId ? `render ${job.renderJobId}` : job.stageId}
                      </span>
                      {job.status === 'succeeded' && job.renderJobId ? (
                        <Button asChild size="xs" variant="outline">
                          <a href={`/api/export-video/render/${job.renderJobId}/download`}>
                            <Video />
                            下载 MP4
                          </a>
                        </Button>
                      ) : null}
                    </div>
                    {job.error ? (
                      <div className="text-destructive text-xs">
                        {job.error.code}
                        {job.error.message ? `：${job.error.message}` : ''}
                      </div>
                    ) : null}
                  </div>
                ))}
                {courseExportJobs.length === 0 ? (
                  <p className="text-muted-foreground py-8 text-center text-sm">
                    还没有导出任务。导出入口在课堂页，完成后这里会显示状态和下载按钮。
                  </p>
                ) : null}
              </CardContent>
            </Card>
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}
