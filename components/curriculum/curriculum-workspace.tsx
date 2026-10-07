'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Plus, RefreshCw, Save, Trash2 } from 'lucide-react';

import { Canvas } from '@/components/ai-elements/canvas';
import { KnowledgePointsPanel } from '@/components/curriculum/knowledge-points-panel';
import { KnowledgeRelationsPanel } from '@/components/curriculum/knowledge-relations-panel';
import { Controls } from '@/components/ai-elements/controls';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
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
  const [snapshot, setSnapshot] = useState<CurriculumSnapshot>({
    series: [],
    courses: [],
    relations: [],
    knowledgePoints: [],
    courseKnowledgePoints: [],
    knowledgePointRelations: [],
  });
  const [stages, setStages] = useState<StageOption[]>([]);
  const [selectedSeriesId, setSelectedSeriesId] = useState<string>('');
  const [courseForm, setCourseForm] = useState<CourseFormState>(EMPTY_COURSE_FORM);
  const [editingCourseId, setEditingCourseId] = useState<string | null>(null);
  const [seriesName, setSeriesName] = useState('');
  const [seriesDescription, setSeriesDescription] = useState('');
  const [relationSource, setRelationSource] = useState('');
  const [relationTarget, setRelationTarget] = useState('');
  const [relationType, setRelationType] = useState<CurriculumRelationType>('prerequisite');
  const [relationNote, setRelationNote] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (!selectedSeriesId && curriculum.series[0]) {
        setSelectedSeriesId(curriculum.series[0].id);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, [selectedSeriesId]);

  useEffect(() => {
    void load();
  }, [load]);

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

  const resetCourseForm = () => {
    setCourseForm({ ...EMPTY_COURSE_FORM, seriesId: selectedSeriesId });
    setEditingCourseId(null);
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
      await requestJson(
        editingCourseId ? `/api/curriculum/courses/${editingCourseId}` : '/api/curriculum/courses',
        {
          method: editingCourseId ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        },
      );
      resetCourseForm();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const editCourse = (course: CurriculumCourseRecord) => {
    setEditingCourseId(course.id);
    setCourseForm({
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
    });
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
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-muted-foreground text-sm">课程产品层 / Curriculum</p>
          <h1 className="text-2xl font-semibold">课程体系与关系图</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            用稳定课程实体管理生成出来的课堂，并维护先修/后续/支撑关系。
          </p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy !== null}>
          {busy === 'load' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新
        </Button>
      </header>

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
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              <button
                type="button"
                onClick={() => setSelectedSeriesId('')}
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
                  onClick={() => setSelectedSeriesId(series.id)}
                  className={`rounded-md border px-3 py-2 text-left text-sm ${
                    selectedSeriesId === series.id ? 'border-primary bg-primary/5' : 'border-border'
                  }`}
                >
                  <span className="block font-medium">{series.name}</span>
                  <span className="text-muted-foreground text-xs">{series.courseCount} 门课程</span>
                </button>
              ))}
            </CardContent>
          </Card>
        </aside>

        <main className="flex flex-col gap-6">
          <Card>
            <CardHeader>
              <CardTitle>{editingCourseId ? '编辑课程' : '新建课程'}</CardTitle>
              <CardDescription>
                课程实体可关联一个已生成的 stage；一个 stage 只能挂到一门课程。
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Input
                placeholder="课程标题 *"
                value={courseForm.title}
                onChange={(event) => setCourseForm({ ...courseForm, title: event.target.value })}
              />
              <Input
                placeholder="课程编号，例如 CTF-1-1-1"
                value={courseForm.code}
                onChange={(event) => setCourseForm({ ...courseForm, code: event.target.value })}
              />
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={courseForm.seriesId}
                onChange={(event) => setCourseForm({ ...courseForm, seriesId: event.target.value })}
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
                onChange={(event) => setCourseForm({ ...courseForm, stageId: event.target.value })}
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
                onChange={(event) => setCourseForm({ ...courseForm, chapter: event.target.value })}
              />
              <Input
                placeholder="节，例如 第一节 CTF入门"
                value={courseForm.section}
                onChange={(event) => setCourseForm({ ...courseForm, section: event.target.value })}
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
                onChange={(event) => setCourseForm({ ...courseForm, hours: event.target.value })}
              />
              <Input
                type="number"
                placeholder="学分"
                value={courseForm.credits}
                onChange={(event) => setCourseForm({ ...courseForm, credits: event.target.value })}
              />
              <Input
                placeholder="学期，例如 2026春"
                value={courseForm.semester}
                onChange={(event) => setCourseForm({ ...courseForm, semester: event.target.value })}
              />
              <select
                className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                value={courseForm.status}
                onChange={(event) => setCourseForm({ ...courseForm, status: event.target.value })}
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
                  {editingCourseId ? '保存修改' : '新建课程'}
                </Button>
                {editingCourseId ? (
                  <Button variant="outline" onClick={resetCourseForm} disabled={busy !== null}>
                    取消编辑
                  </Button>
                ) : null}
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
                      <div>
                        <div className="font-medium">{course.title}</div>
                        <div className="text-muted-foreground text-xs">
                          {[course.code, course.chapter, course.section]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                      <div className="flex gap-1">
                        <Button size="xs" variant="outline" onClick={() => editCourse(course)}>
                          编辑
                        </Button>
                        <Button
                          size="xs"
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
                      <span className="col-span-2 break-all">stage：{course.stageId ?? '-'}</span>
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
                        {courseById.get(relation.sourceCourseId)?.title ?? relation.sourceCourseId}
                        {' → '}
                        {RELATION_LABELS[relation.relationType]}
                        {' → '}
                        {courseById.get(relation.targetCourseId)?.title ?? relation.targetCourseId}
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

          <Card size="sm">
            <CardHeader>
              <CardTitle>已有 stage</CardTitle>
              <CardDescription>生成出来的课堂，可被课程台账关联。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-2 md:grid-cols-2">
              {stages.map((stage) => (
                <div key={stage.id} className="border-border rounded-md border px-3 py-2 text-xs">
                  <div className="font-medium">{stage.name}</div>
                  <div className="text-muted-foreground break-all">{stage.id}</div>
                </div>
              ))}
            </CardContent>
          </Card>
        </main>
      </div>
    </div>
  );
}
