'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { Boxes, Download, ExternalLink, Loader2, Rocket, Save, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import type { CourseAssemblyPlan } from '@/lib/curriculum/assembly';
import {
  COURSE_KNOWLEDGE_COVERAGE_LEVELS,
  type CourseKnowledgeCoverageLevel,
  type CourseKnowledgePointRecord,
  type CurriculumCourseRecord,
  type CurriculumGenerationJobRecord,
  type KnowledgePointRecord,
} from '@/lib/curriculum/types';

interface CourseAssemblerPanelProps {
  seriesId: string;
  courses: CurriculumCourseRecord[];
  knowledgePoints: KnowledgePointRecord[];
  courseKnowledgePoints: CourseKnowledgePointRecord[];
  generationJobs: CurriculumGenerationJobRecord[];
  onChanged: () => Promise<void> | void;
}

interface AssemblyFormState {
  title: string;
  code: string;
  chapter: string;
  section: string;
  type: string;
  hours: string;
}

interface PointRow {
  point: KnowledgePointRecord;
  depth: number;
}

const EMPTY_FORM: AssemblyFormState = {
  title: '',
  code: '',
  chapter: '',
  section: '',
  type: 'theory',
  hours: '',
};

const COURSE_TYPES = ['theory', 'practice', 'project', 'review'];

const COVERAGE_LABELS: Record<CourseKnowledgeCoverageLevel, string> = {
  introduced: '引入',
  practiced: '练习',
  mastered: '掌握',
};

const WARNING_STYLES =
  'rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800';

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

function comparePoints(a: KnowledgePointRecord, b: KnowledgePointRecord): number {
  if (a.sortOrder !== b.sortOrder) return a.sortOrder - b.sortOrder;
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function downloadJson(fileName: string, value: unknown): void {
  const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

export function CourseAssemblerPanel({
  seriesId,
  courses,
  knowledgePoints,
  courseKnowledgePoints,
  generationJobs,
  onChanged,
}: CourseAssemblerPanelProps) {
  const [form, setForm] = useState<AssemblyFormState>(EMPTY_FORM);
  const [selection, setSelection] = useState<Record<string, CourseKnowledgeCoverageLevel>>({});
  const [sourceCourseId, setSourceCourseId] = useState('');
  const [plan, setPlan] = useState<CourseAssemblyPlan | null>(null);
  const [savedCourseId, setSavedCourseId] = useState<string | null>(null);
  const [startedJob, setStartedJob] = useState<CurriculumGenerationJobRecord | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visiblePoints = useMemo(() => {
    if (!seriesId) return knowledgePoints;
    return knowledgePoints.filter((point) => point.seriesId === seriesId);
  }, [knowledgePoints, seriesId]);

  const visibleCourses = useMemo(() => {
    if (!seriesId) return courses;
    return courses.filter((course) => course.seriesId === seriesId);
  }, [courses, seriesId]);

  const pointRows = useMemo<PointRow[]>(() => {
    const ids = new Set(visiblePoints.map((point) => point.id));
    const children = new Map<string, KnowledgePointRecord[]>();
    const roots: KnowledgePointRecord[] = [];
    for (const point of visiblePoints) {
      if (point.parentId && ids.has(point.parentId)) {
        const list = children.get(point.parentId) ?? [];
        list.push(point);
        children.set(point.parentId, list);
      } else {
        roots.push(point);
      }
    }
    for (const list of children.values()) list.sort(comparePoints);
    roots.sort(comparePoints);

    const rows: PointRow[] = [];
    const seen = new Set<string>();
    const walk = (point: KnowledgePointRecord, depth: number) => {
      if (seen.has(point.id)) return;
      seen.add(point.id);
      rows.push({ point, depth });
      for (const child of children.get(point.id) ?? []) walk(child, depth + 1);
    };
    for (const root of roots) walk(root, 0);
    for (const point of visiblePoints) walk(point, 0);
    return rows;
  }, [visiblePoints]);

  const trackedJobs = useMemo(() => {
    const visibleCourseIds = new Set(visibleCourses.map((course) => course.id));
    return generationJobs
      .filter((job) => visibleCourseIds.has(job.courseId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
  }, [generationJobs, visibleCourses]);

  const latestJob = useMemo(() => {
    if (startedJob) {
      const refreshed = generationJobs.find((job) => job.id === startedJob.id);
      if (refreshed) return refreshed;
    }
    return trackedJobs[0] ?? startedJob ?? null;
  }, [generationJobs, startedJob, trackedJobs]);
  const activeGeneration =
    latestJob !== null &&
    ['queued', 'running', 'awaiting_outline', 'paused'].includes(latestJob.status);

  useEffect(() => {
    if (!activeGeneration) return;
    const timer = window.setInterval(() => {
      void onChanged();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeGeneration, onChanged]);

  const selectedPointIds = useMemo(() => Object.keys(selection), [selection]);
  const estimatedHours = useMemo(() => {
    const count = selectedPointIds.length;
    if (count === 0) return 0;
    return Math.max(1, Math.ceil(count / 4));
  }, [selectedPointIds.length]);

  const togglePoint = (pointId: string, checked: boolean) => {
    setSelection((current) => {
      const next = { ...current };
      if (checked) next[pointId] = next[pointId] ?? 'introduced';
      else delete next[pointId];
      return next;
    });
    setPlan(null);
    setSavedCourseId(null);
  };

  const setCoverage = (pointId: string, coverageLevel: CourseKnowledgeCoverageLevel) => {
    setSelection((current) => ({ ...current, [pointId]: coverageLevel }));
    setPlan(null);
    setSavedCourseId(null);
  };

  const fillFromCourse = (courseId: string) => {
    setSourceCourseId(courseId);
    const course = courses.find((candidate) => candidate.id === courseId);
    if (!course) return;
    const links = courseKnowledgePoints.filter((link) => link.courseId === courseId);
    setForm((current) => ({
      ...current,
      title: current.title || course.title,
      code: current.code || course.code || '',
      chapter: current.chapter || course.chapter || '',
      section: current.section || course.section || '',
      hours: current.hours || (course.hours === null ? '' : String(course.hours)),
    }));
    setSelection(
      Object.fromEntries(links.map((link) => [link.knowledgePointId, link.coverageLevel])),
    );
    setPlan(null);
    setSavedCourseId(null);
  };

  const buildPlan = useCallback(async () => {
    if (!form.title.trim()) {
      setError('请先填写课程标题。');
      return null;
    }
    if (selectedPointIds.length === 0) {
      setError('请至少选择一个知识点。');
      return null;
    }
    setBusy('assemble');
    setError(null);
    try {
      const payload = await requestJson<{ assembly: CourseAssemblyPlan }>(
        '/api/curriculum/assemblies',
        {
          method: 'POST',
          body: JSON.stringify({
            seriesId: seriesId || null,
            title: form.title.trim(),
            code: form.code.trim() || null,
            chapter: form.chapter.trim() || null,
            section: form.section.trim() || null,
            type: form.type || null,
            hours: form.hours.trim() ? Number(form.hours) : null,
            knowledgePoints: Object.entries(selection).map(([knowledgePointId, coverageLevel]) => ({
              knowledgePointId,
              coverageLevel,
            })),
          }),
        },
      );
      setPlan(payload.assembly);
      setSavedCourseId(null);
      return payload.assembly;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setBusy(null);
    }
  }, [form, selection, selectedPointIds.length, seriesId]);

  const saveDraft = async () => {
    const currentPlan = plan ?? (await buildPlan());
    if (!currentPlan) return;
    setBusy('save');
    setError(null);
    try {
      const courseBody = {
        title: currentPlan.title,
        code: currentPlan.code.trim() || null,
        seriesId: currentPlan.seriesId,
        chapter: currentPlan.chapter.trim() || null,
        section: currentPlan.section.trim() || null,
        lessonOrder: visibleCourses.length + 1,
        hours: currentPlan.hours,
        status: 'draft' as const,
        description: currentPlan.coursePackage.objectives.join('；'),
      };
      const coursePayload = savedCourseId
        ? await requestJson<{ course: CurriculumCourseRecord }>(
            `/api/curriculum/courses/${savedCourseId}`,
            { method: 'PATCH', body: JSON.stringify(courseBody) },
          )
        : await requestJson<{ course: CurriculumCourseRecord }>('/api/curriculum/courses', {
            method: 'POST',
            body: JSON.stringify(courseBody),
          });
      const courseId = coursePayload.course.id;
      await requestJson(`/api/curriculum/courses/${courseId}/knowledge-points`, {
        method: 'PUT',
        body: JSON.stringify({
          knowledgePoints: currentPlan.knowledgePoints.map((point) => ({
            knowledgePointId: point.knowledgePointId,
            coverageLevel: point.coverageLevel,
          })),
        }),
      });
      setSavedCourseId(courseId);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const startGeneration = async () => {
    const currentPlan = plan ?? (await buildPlan());
    if (!currentPlan) return;
    setBusy('generate');
    setError(null);
    try {
      const payload = await requestJson<{
        job: CurriculumGenerationJobRecord;
        run: { id: string; state: string };
        courseId: string;
        createdCourse: boolean;
      }>('/api/curriculum/generation-jobs', {
        method: 'POST',
        body: JSON.stringify({
          assembly: {
            seriesId: currentPlan.seriesId,
            title: currentPlan.title,
            code: currentPlan.code,
            chapter: currentPlan.chapter,
            section: currentPlan.section,
            type: currentPlan.type,
            hours: currentPlan.hours,
            knowledgePoints: currentPlan.knowledgePoints.map((point) => ({
              knowledgePointId: point.knowledgePointId,
              coverageLevel: point.coverageLevel,
            })),
          },
          courseId: savedCourseId,
          outlineReview: 'auto',
        }),
      });
      setStartedJob(payload.job);
      setSavedCourseId(payload.courseId);
      setError(`一键生成已启动：run ${payload.run.id}，stage 生成后会自动回写到课程台账。`);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const copyRunCommand = async () => {
    if (!plan) return;
    try {
      await navigator.clipboard.writeText(plan.suggestedRunCommand);
      setError('启动命令已复制到剪贴板。');
    } catch {
      setError('浏览器不允许写剪贴板，请手动复制右侧命令。');
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Boxes className="size-4" />
          课程组装器
        </CardTitle>
        <CardDescription>
          从知识点和先修关系中生成课程页序，导出可交给生成链路的 course-package
          JSON，并保存为课程草稿。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <div className="flex flex-col gap-4">
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              placeholder="课程标题 *"
              value={form.title}
              onChange={(event) => setForm({ ...form, title: event.target.value })}
            />
            <Input
              placeholder="课程编号，例如 CTF-1-1-4"
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
            />
            <Input
              placeholder="章，例如 第一章 CTF基础"
              value={form.chapter}
              onChange={(event) => setForm({ ...form, chapter: event.target.value })}
            />
            <Input
              placeholder="节，例如 第二节 工具环境"
              value={form.section}
              onChange={(event) => setForm({ ...form, section: event.target.value })}
            />
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={form.type}
              onChange={(event) => setForm({ ...form, type: event.target.value })}
            >
              {COURSE_TYPES.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
            <Input
              type="number"
              placeholder={`学时，留空按 ${estimatedHours || 1} 估算`}
              value={form.hours}
              onChange={(event) => setForm({ ...form, hours: event.target.value })}
            />
          </div>

          <div className="border-border flex flex-col gap-2 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-medium">选择知识点</div>
                <div className="text-muted-foreground text-xs">
                  已选 {selectedPointIds.length} 个，估算 {estimatedHours || 1} 学时
                </div>
              </div>
              <select
                className="border-input h-9 min-w-56 rounded-md border bg-transparent px-2.5 text-sm"
                value={sourceCourseId}
                onChange={(event) => fillFromCourse(event.target.value)}
              >
                <option value="">从已有课程带入知识点...</option>
                {visibleCourses.map((course) => (
                  <option key={course.id} value={course.id}>
                    {course.title}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex max-h-[420px] flex-col gap-1 overflow-y-auto pr-1">
              {pointRows.map(({ point, depth }) => {
                const checked = selection[point.id] !== undefined;
                return (
                  <div
                    key={point.id}
                    className="hover:bg-muted/40 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                    style={{ marginLeft: depth * 18 }}
                  >
                    <input
                      type="checkbox"
                      className="size-4 accent-primary"
                      checked={checked}
                      onChange={(event) => togglePoint(point.id, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      <span className="font-medium">{point.name}</span>
                      <span className="text-muted-foreground ml-2 text-xs">
                        {[point.code, point.difficulty].filter(Boolean).join(' · ')}
                      </span>
                    </span>
                    <select
                      className="border-input h-8 rounded-md border bg-transparent px-2 text-xs disabled:opacity-40"
                      value={selection[point.id] ?? 'introduced'}
                      disabled={!checked}
                      onChange={(event) =>
                        setCoverage(point.id, event.target.value as CourseKnowledgeCoverageLevel)
                      }
                    >
                      {COURSE_KNOWLEDGE_COVERAGE_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {COVERAGE_LABELS[level]}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
              {pointRows.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  当前系列还没有知识点。
                </p>
              ) : null}
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => void buildPlan()}
              disabled={busy !== null || !form.title.trim() || selectedPointIds.length === 0}
            >
              {busy === 'assemble' ? <Loader2 className="animate-spin" /> : <Sparkles />}
              生成组装方案
            </Button>
            <Button
              variant="outline"
              onClick={saveDraft}
              disabled={busy !== null || !plan || savedCourseId !== null}
            >
              {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}
              {savedCourseId ? '已保存为课程草稿' : '保存为课程草稿'}
            </Button>
            <Button variant="outline" onClick={() => void copyRunCommand()} disabled={!plan}>
              复制启动命令
            </Button>
            <Button
              onClick={() => void startGeneration()}
              disabled={
                busy !== null ||
                !form.title.trim() ||
                selectedPointIds.length === 0 ||
                activeGeneration
              }
            >
              {busy === 'generate' ? <Loader2 className="animate-spin" /> : <Rocket />}
              一键生成
            </Button>
          </div>

          {latestJob ? (
            <div className="border-border bg-muted/30 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border px-3 py-2 text-xs">
              <span className="font-medium">生成任务</span>
              <span className="text-muted-foreground">
                {latestJob.status}
                {latestJob.runId ? ` · ${latestJob.runId}` : ''}
              </span>
              {latestJob.stageId ? (
                <Link
                  href={`/classroom/${latestJob.stageId}`}
                  className="text-primary inline-flex items-center gap-1 font-medium hover:underline"
                >
                  打开课堂
                  <ExternalLink className="size-3" />
                </Link>
              ) : null}
              {latestJob.error ? (
                <span className="text-amber-700">
                  {latestJob.error.code}
                  {latestJob.error.message ? `：${latestJob.error.message}` : ''}
                </span>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <div className="border-primary/30 bg-primary/5 text-primary rounded-md border px-3 py-2 text-sm">
              {error}
            </div>
          ) : null}
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          {plan ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">{plan.title}</div>
                  <div className="text-muted-foreground text-xs">
                    {plan.code || '无编号'} · {plan.hours} 学时 · {plan.slides.length} 页
                  </div>
                </div>
                <Button
                  size="sm"
                  onClick={() => downloadJson(plan.packageFileName, plan.coursePackage)}
                >
                  <Download />
                  下载课程包
                </Button>
              </div>

              {plan.warnings.length > 0 ? (
                <div className="flex flex-col gap-2">
                  {plan.warnings.map((warning) => (
                    <div
                      key={`${warning.code}-${warning.knowledgePointIds.join('-')}`}
                      className={WARNING_STYLES}
                    >
                      {warning.message}
                    </div>
                  ))}
                </div>
              ) : null}

              <div className="border-border flex max-h-[620px] flex-col gap-2 overflow-y-auto rounded-lg border p-3">
                {plan.slides.map((slide) => (
                  <div
                    key={`${slide.order}-${slide.title}`}
                    className="border-border rounded-md border p-2 text-sm"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium">
                        {slide.order}. {slide.title}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {slide.knowledgePointIds.length} 个知识点
                      </span>
                    </div>
                    {slide.points.length > 0 ? (
                      <ul className="text-muted-foreground mt-1 list-disc pl-5 text-xs">
                        {slide.points.map((point) => (
                          <li key={point}>{point}</li>
                        ))}
                      </ul>
                    ) : null}
                  </div>
                ))}
              </div>

              <Textarea
                readOnly
                value={plan.suggestedRunCommand}
                className="text-muted-foreground min-h-20 font-mono text-xs"
              />
            </>
          ) : (
            <div className="border-border text-muted-foreground flex min-h-80 items-center justify-center rounded-lg border border-dashed p-6 text-center text-sm">
              选择知识点后生成组装方案，这里会显示课程页序、警告和可下载的 course-package JSON。
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
