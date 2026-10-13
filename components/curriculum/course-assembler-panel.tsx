'use client';

/**
 * The production panel: two ways to get a classroom, and the seam between them.
 *
 * This replaces a panel that had one button and one path — pick knowledge
 * points, build a plan, start a run whose requirement was a paragraph of
 * assembled prose. That path is still here, because it is still real: batches
 * run through it, and a course whose design does not exist yet has nothing else.
 * What changed is that it is no longer the *only* thing on the screen, and it is
 * no longer what happens when someone has designed a course properly.
 *
 * `chooseProductionPath` decides which one is offered, and the panel renders
 * exactly what it decides — the two branches below are not a preference, they
 * are the two arms of that one function. A task that has settled its outcomes,
 * evidence, knowledge and dependencies produces through its designed items: the
 * export gate runs first, the role decides the scene types, and the requirement
 * is the outcome behaviors rather than a summary. A task that has not been
 * designed gets the assembler, labelled so nobody mistakes it for the real one.
 *
 * What this panel deliberately does not do is edit the design. Objectives,
 * evidence, the graph, the outline, questions and lab tasks belong to the
 * design workbench, where the matrix shows what each edit does to the closed
 * loop. This screen starts runs and reports their state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Boxes,
  Download,
  ExternalLink,
  Loader2,
  Rocket,
  Save,
  Sparkles,
  Workflow,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { chooseProductionPath, type ProductionPath } from '@/lib/curriculum/production-path';
import type { CourseAssemblyPlan } from '@/lib/curriculum/assembly';
import {
  COURSE_KNOWLEDGE_COVERAGE_LEVELS,
  type CourseKnowledgeCoverageLevel,
  type CurriculumCourseRecord,
  type CurriculumGenerationJobRecord,
  type KnowledgePointRecord,
} from '@/lib/curriculum/types';
import type {
  CurriculumDesignPhase,
  CurriculumDesignSnapshot,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

interface CourseAssemblerPanelProps {
  seriesId: string;
  courses: CurriculumCourseRecord[];
  knowledgePoints: KnowledgePointRecord[];
  /** Per-course knowledge-point links, used only by the assembly form. */
  courseKnowledgePoints: {
    courseId: string;
    knowledgePointId: string;
    coverageLevel: CourseKnowledgeCoverageLevel;
  }[];
  generationJobs: CurriculumGenerationJobRecord[];
  /** Pre-populate the form and selected knowledge points from this course. */
  initialCourseId?: string | null;
  /** Update this course instead of creating a new draft when saving/generating. */
  targetCourseId?: string | null;
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

const EMPTY_FORM: AssemblyFormState = {
  title: '',
  code: '',
  chapter: '',
  section: '',
  type: 'theory',
  hours: '',
};

const COURSE_TYPES = ['theory', 'practice', 'project', 'review'];

/** What a run is doing, as far as this panel can see without the workbench. */
interface ItemRun {
  runId: string;
  state: string;
  step: string | null;
  stageId: string | null;
  error: string | null;
}

const ACTIVE_STATES = new Set(['queued', 'running', 'paused', 'countdown']);

const COVERAGE_LABELS: Record<CourseKnowledgeCoverageLevel, string> = {
  introduced: '引入',
  practiced: '练习',
  mastered: '掌握',
};

const ROLE_LABELS: Record<string, string> = {
  lecture: '讲课',
  practice: '练习',
  exam: '考试',
};

/** What each role will be allowed to generate — shown so the role has a cost. */
const ROLE_SCENE_LABELS: Record<string, string> = {
  lecture: '幻灯片（不含测验、不含交互）',
  practice: '幻灯片 + 测验 + 交互（可用提示，可重试）',
  exam: '幻灯片 + 测验（不给提示，独立评分）',
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

/** Items in outline order, with their chapter as a grouping prefix. */
function outlineItems(units: readonly CurriculumUnitRecord[]): {
  chapterTitle: string | null;
  unit: CurriculumUnitRecord;
}[] {
  const chapters = new Map(
    units
      .filter((unit) => unit.unitType === 'chapter')
      .map((chapter) => [chapter.id, chapter.title]),
  );
  return units
    .filter((unit) => unit.unitType === 'item')
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((unit) => ({
      chapterTitle: unit.parentId ? (chapters.get(unit.parentId) ?? null) : null,
      unit,
    }));
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
  initialCourseId,
  targetCourseId,
  onChanged,
}: CourseAssemblerPanelProps) {
  // ── Design path state ──
  const [designTaskId, setDesignTaskId] = useState<string | null>(null);
  const [designTitle, setDesignTitle] = useState('');
  const [designPhase, setDesignPhase] = useState<CurriculumDesignPhase>('task');
  const [designUnits, setDesignUnits] = useState<CurriculumUnitRecord[]>([]);
  const [designObjectiveCount, setDesignObjectiveCount] = useState(0);
  const [itemRuns, setItemRuns] = useState<Record<string, ItemRun>>({});
  const [designReady, setDesignReady] = useState<{
    exportable: boolean;
    blockers: string[];
    /** Defects the author accepted: this export proceeds with them. */
    accepted: { id: string; message: string }[];
  } | null>(null);

  const [loadingDesign, setLoadingDesign] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const bootstrappedRef = useRef(false);

  // ── Assembly path state (unchanged behaviour) ──
  const [form, setForm] = useState<AssemblyFormState>(EMPTY_FORM);
  const [selection, setSelection] = useState<Record<string, CourseKnowledgeCoverageLevel>>({});
  const [sourceCourseId, setSourceCourseId] = useState('');
  const [plan, setPlan] = useState<CourseAssemblyPlan | null>(null);
  const [savedCourseId, setSavedCourseId] = useState<string | null>(null);

  const base = '/api/curriculum/design';

  const loadDesign = useCallback(async () => {
    setLoadingDesign(true);
    try {
      const list = await requestJson<{
        tasks: { id: string; title: string; designPhase: CurriculumDesignPhase }[];
      }>(`${base}/tasks${seriesId ? `?seriesId=${encodeURIComponent(seriesId)}` : ''}`);
      const task = list.tasks[0];
      if (!task) {
        setDesignTaskId(null);
        setDesignUnits([]);
        setDesignObjectiveCount(0);
        return;
      }
      setDesignTaskId(task.id);
      setDesignTitle(task.title);
      setDesignPhase(task.designPhase);
      const [snapshot, gate] = await Promise.all([
        requestJson<CurriculumDesignSnapshot>(`${base}/tasks/${task.id}`),
        requestJson<{
          exportable: boolean;
          blockers: string[];
          accepted?: { id: string; message: string }[];
        }>(`${base}/tasks/${task.id}/export-gate`),
      ]);
      setDesignUnits(snapshot.units);
      setDesignObjectiveCount(snapshot.objectives.length);
      setDesignReady({
        exportable: gate.exportable,
        blockers: gate.blockers,
        accepted: gate.accepted ?? [],
      });
    } catch (caught) {
      // A series with no design at all is the normal case for the legacy
      // screen, so a failure to read one must not become an error banner here.
      setError(caught instanceof Error ? caught.message : '读取课程设计失败');
    } finally {
      setLoadingDesign(false);
    }
  }, [base, seriesId]);

  useEffect(() => {
    void loadDesign();
  }, [loadDesign]);

  const choice = useMemo(
    () =>
      chooseProductionPath({
        phase: designPhase,
        units: designUnits,
        objectiveCount: designObjectiveCount,
      }),
    [designPhase, designUnits, designObjectiveCount],
  );

  const items = useMemo(
    () => (designTaskId ? outlineItems(designUnits) : []),
    [designTaskId, designUnits],
  );

  /**
   * Produce one designed item.
   *
   * The gate runs server-side before the run is created, so a refusal here means
   * nothing was started — this is the button that replaces "一键生成" for a
   * course that was designed, and the only difference a user sees between the
   * two paths is which design decisions produced the course.
   */
  const generateItem = useCallback(
    async (unitId: string) => {
      if (!designTaskId) return;
      setBusy(`generate:${unitId}`);
      setError(null);
      try {
        const payload = await requestJson<{ run: ItemRun & { id: string } }>(
          `${base}/tasks/${designTaskId}/units/${unitId}/generate`,
          { method: 'POST' },
        );
        setItemRuns((current) => ({
          ...current,
          [unitId]: {
            runId: payload.run.id,
            state: payload.run.state,
            step: payload.run.step,
            stageId: payload.run.stageId,
            error: null,
          },
        }));
        // The gate may have passed on the last read and be refused now, because
        // the design changed; either way the snapshot's stageId and the run's
        // disagree until this re-read settles it.
        void loadDesign();
        void onChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '生成失败');
      } finally {
        setBusy(null);
      }
    },
    [base, designTaskId, loadDesign, onChanged],
  );

  /** Follow one started run until it produces a stage or stops moving. */
  useEffect(() => {
    const live = Object.entries(itemRuns).filter(([, run]) => ACTIVE_STATES.has(run.state));
    if (live.length === 0) return;
    const timer = window.setInterval(() => {
      for (const [unitId, run] of live) {
        void (async () => {
          try {
            const payload = await requestJson<{
              run: { id: string; state: string; step: string | null; stageId: string | null };
            }>(`/api/generation-runs/${run.runId}`);
            setItemRuns((current) => ({
              ...current,
              [unitId]: {
                runId: run.runId,
                state: payload.run.state,
                step: payload.run.step,
                stageId: payload.run.stageId,
                error: null,
              },
            }));
          } catch {
            // A run that cannot be read right now is still running as far as
            // this panel is concerned; the next tick or the workbench will
            // resolve it, so the tick stays silent rather than flashing an error.
          }
        })();
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [itemRuns]);

  const visiblePoints = useMemo(() => {
    if (!seriesId) return knowledgePoints;
    return knowledgePoints.filter((point) => point.seriesId === seriesId);
  }, [knowledgePoints, seriesId]);

  const visibleCourses = useMemo(() => {
    if (!seriesId) return courses;
    return courses.filter((course) => course.seriesId === seriesId);
  }, [courses, seriesId]);

  const selectedPointIds = useMemo(() => Object.keys(selection), [selection]);

  const fillFromCourse = useCallback(
    (courseId: string) => {
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
    },
    [courseKnowledgePoints, courses],
  );

  useEffect(() => {
    if (bootstrappedRef.current || !initialCourseId) return;
    if (!courses.some((course) => course.id === initialCourseId)) return;
    bootstrappedRef.current = true;
    fillFromCourse(initialCourseId);
  }, [courses, fillFromCourse, initialCourseId]);

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
      const targetCourse = targetCourseId
        ? courses.find((candidate) => candidate.id === targetCourseId)
        : undefined;
      const courseBody = {
        title: currentPlan.title,
        code: currentPlan.code.trim() || null,
        seriesId: currentPlan.seriesId,
        chapter: currentPlan.chapter.trim() || null,
        section: currentPlan.section.trim() || null,
        lessonOrder: targetCourse?.lessonOrder ?? visibleCourses.length + 1,
        hours: currentPlan.hours,
        status: targetCourse?.status ?? ('draft' as const),
        description: currentPlan.coursePackage.objectives.join('；'),
      };
      const savedCourse = savedCourseId ?? targetCourseId;
      const coursePayload = savedCourse
        ? await requestJson<{ course: CurriculumCourseRecord }>(
            `/api/curriculum/courses/${savedCourse}`,
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
          courseId: targetCourseId ?? savedCourseId,
          outlineReview: 'auto',
        }),
      });
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

  const trackedJobs = useMemo(() => {
    const visibleCourseIds = new Set(visibleCourses.map((course) => course.id));
    return generationJobs
      .filter((job) => visibleCourseIds.has(job.courseId))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, 3);
  }, [generationJobs, visibleCourses]);

  const path: ProductionPath = loadingDesign ? 'assembly' : choice.path;

  if (path === 'design') {
    return (
      <DesignProductionCard
        taskId={designTaskId}
        title={designTitle}
        items={items}
        itemRuns={itemRuns}
        ready={designReady}
        busy={busy}
        error={error}
        blockedReason={choice.blockedReason}
        onGenerate={generateItem}
      />
    );
  }

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
      <CardContent className="flex flex-col gap-4">
        {designTaskId ? (
          // The design exists but has not reached the outline. Say so here,
          // because this screen offers a button that skips everything the design
          // screens enforce, and a person who has started a design should not be
          // able to produce a course from the knowledge library by accident.
          <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              这个系列已有一门课程设计（
              <Link href={`/curriculum/design/${designTaskId}`} className="font-medium underline">
                {designTitle}
              </Link>
              ），但它还没到大纲阶段。下面这条路按知识点生成课程，
              <b>不检查学习目标是否被教、被练、被考</b>
              ，产出的课不会进入设计矩阵，也不会被出课闸门审核。
            </span>
          </div>
        ) : (
          // No design at all. The assembler is a legitimate way to make a course,
          // but saying so is what keeps it from reading as the equal of the
          // designed path — the difference is what happens to the promises.
          <div className="text-muted-foreground rounded-md border px-3 py-2 text-xs">
            这个系列还没有课程设计。下面这条路按知识点生成课程，
            <b>不检查学习目标是否被教、被练、被考</b>
            ；产出的课不会进入设计矩阵，也不会被出课闸门审核。想走逆向设计，先到
            <Link href="/curriculum/design" className="mx-1 font-medium underline">
              课程设计
            </Link>
            建一个。
          </div>
        )}

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
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
                placeholder="学时，留空按知识点数量估算"
                value={form.hours}
                onChange={(event) => setForm({ ...form, hours: event.target.value })}
              />
            </div>

            <div className="border-border flex flex-col gap-2 rounded-lg border p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <div className="text-sm font-medium">选择知识点</div>
                  <div className="text-muted-foreground text-xs">
                    已选 {selectedPointIds.length} 个
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
                {visiblePoints.map((point) => {
                  const checked = selection[point.id] !== undefined;
                  return (
                    <div
                      key={point.id}
                      className="hover:bg-muted/40 flex items-center gap-2 rounded-md px-2 py-1.5 text-sm"
                    >
                      <input
                        type="checkbox"
                        className="size-4 accent-primary"
                        checked={checked}
                        onChange={(event) => togglePoint(point.id, event.target.checked)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        <span className="font-medium">{point.name}</span>
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
                {savedCourseId ? '已保存' : targetCourseId ? '保存课程信息' : '保存为课程草稿'}
              </Button>
              <Button variant="outline" onClick={() => void copyRunCommand()} disabled={!plan}>
                复制启动命令
              </Button>
              <Button
                onClick={() => void startGeneration()}
                disabled={busy !== null || !form.title.trim() || selectedPointIds.length === 0}
              >
                {busy === 'generate' ? <Loader2 className="animate-spin" /> : <Rocket />}
                一键生成
              </Button>
            </div>

            {error ? (
              <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
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
                {plan.warnings.map((warning) => (
                  <div
                    key={`${warning.code}-${warning.knowledgePointIds.join('-')}`}
                    className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800"
                  >
                    {warning.message}
                  </div>
                ))}
                <div className="border-border flex max-h-[420px] flex-col gap-2 overflow-y-auto rounded-lg border p-3">
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
                选择知识点后生成组装方案。
              </div>
            )}
          </div>
        </div>

        {trackedJobs.length > 0 ? (
          <div className="text-muted-foreground flex flex-col gap-1 text-xs">
            {trackedJobs.map((job) => (
              <div key={job.id} className="flex items-center gap-2">
                <span className="font-medium">{job.status}</span>
                {job.stageId ? (
                  <Link
                    href={`/classroom/${job.stageId}`}
                    className="text-primary inline-flex items-center gap-1 hover:underline"
                  >
                    打开课堂
                    <ExternalLink className="size-3" />
                  </Link>
                ) : null}
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

/**
 * The designed path: one row per item, one button per item.
 *
 * The gate's blockers are shown in full rather than as a disabled button,
 * because the common reason a course cannot be produced is a coverage gap the
 * design screens can fix, and the blocker text names exactly which outcomes are
 * untaught, unpractised or unassessed.
 */
function DesignProductionCard({
  taskId,
  title,
  items,
  itemRuns,
  ready,
  busy,
  error,
  blockedReason,
  onGenerate,
}: {
  taskId: string | null;
  title: string;
  items: { chapterTitle: string | null; unit: CurriculumUnitRecord }[];
  itemRuns: Record<string, ItemRun>;
  ready: {
    exportable: boolean;
    blockers: string[];
    accepted: { id: string; message: string }[];
  } | null;
  busy: string | null;
  error: string | null;
  blockedReason: string | null;
  onGenerate: (unitId: string) => Promise<void>;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2">
              <Workflow className="size-4" />
              按设计生成
            </CardTitle>
            <CardDescription>
              每个条目按自己的教学角色生成：讲课出幻灯片，练习出可交互可重试的练习，考试出无提示的测验。
              生成前先过出课闸门。
            </CardDescription>
          </div>
          {taskId ? (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/curriculum/design/${taskId}`}>
                打开设计工作台
                <ExternalLink />
              </Link>
            </Button>
          ) : null}
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">{title}</span>
          {ready?.exportable ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              可以出课
            </Badge>
          ) : (
            <Badge variant="destructive">不能出课</Badge>
          )}
        </div>

        {ready && !ready.exportable && ready.blockers.length > 0 ? (
          <ul className="flex flex-col gap-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-800">
            {ready.blockers.map((blocker) => (
              <li key={blocker} className="flex items-start gap-2">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {blocker}
              </li>
            ))}
          </ul>
        ) : null}

        {/* Accepted defects do not block, and saying so here is what keeps the
            acceptance honest: an export that carries known gaps has to name them
            rather than look like a clean run. */}
        {ready && ready.accepted.length > 0 ? (
          <ul className="text-muted-foreground flex flex-col gap-1 rounded-md border px-3 py-2 text-xs">
            {ready.accepted.map((entry) => (
              <li key={entry.id} className="flex items-start gap-2">
                <span className="shrink-0 font-medium">已接受</span>
                {entry.message}
              </li>
            ))}
          </ul>
        ) : null}

        {blockedReason ? (
          <p className="text-muted-foreground rounded-md border px-3 py-2 text-xs">
            {blockedReason}
          </p>
        ) : null}

        <div className="flex flex-col gap-2">
          {items.map(({ chapterTitle, unit }) => {
            const run = itemRuns[unit.id];
            const running = run ? ACTIVE_STATES.has(run.state) : false;
            const stageId = unit.stageId ?? run?.stageId ?? null;
            const producedPages = unit.deckDesign.pages?.length ?? 0;
            return (
              <div
                key={unit.id}
                className="border-border flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline" className="px-1 py-0 text-[10px]">
                      {ROLE_LABELS[unit.unitRole ?? ''] ?? unit.unitRole ?? '无角色'}
                    </Badge>
                    {unit.code ? (
                      <span className="text-muted-foreground font-mono text-[10px]">
                        {unit.code}
                      </span>
                    ) : null}
                    <span className="text-sm font-medium">{unit.title}</span>
                  </div>
                  {chapterTitle ? (
                    <span className="text-muted-foreground text-[11px]">属于 {chapterTitle}</span>
                  ) : null}
                  <span className="text-muted-foreground text-[11px]">
                    将生成：{ROLE_SCENE_LABELS[unit.unitRole ?? 'lecture'] ?? '按角色决定'}
                    {unit.unitRole === 'lecture' && producedPages > 0
                      ? ` · 已规划 ${producedPages} 页`
                      : ''}
                  </span>
                  {run ? (
                    <span className="text-muted-foreground font-mono text-[10px]">
                      run {run.runId} · {run.state}
                      {run.step ? ` · ${run.step}` : ''}
                    </span>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {stageId ? (
                    <Button variant="outline" size="sm" asChild>
                      <Link href={`/classroom/${stageId}`}>
                        打开课堂
                        <ExternalLink />
                      </Link>
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    disabled={
                      busy !== null ||
                      running ||
                      !taskId ||
                      !unit.unitRole ||
                      ready?.exportable === false
                    }
                    onClick={() => void onGenerate(unit.id)}
                  >
                    {busy === `generate:${unit.id}` ? (
                      <Loader2 className="animate-spin" />
                    ) : (
                      <Rocket />
                    )}
                    {stageId ? '重新生成' : '生成'}
                  </Button>
                </div>
              </div>
            );
          })}
          {items.length === 0 ? (
            <p className="text-muted-foreground border-border rounded-lg border border-dashed p-6 text-center text-xs">
              大纲里还没有条目。
            </p>
          ) : null}
        </div>

        {error ? (
          <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-md border px-3 py-2 text-sm">
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
