'use client';

import { useEffect, useMemo, useState } from 'react';
import { BookOpen, Link2, Loader2, Save, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  COURSE_KNOWLEDGE_COVERAGE_LEVELS,
  KNOWLEDGE_POINT_DIFFICULTIES,
  KNOWLEDGE_POINT_TYPES,
  type CourseKnowledgeCoverageLevel,
  type CourseKnowledgePointRecord,
  type CurriculumCourseRecord,
  type KnowledgePointDifficulty,
  type KnowledgePointRecord,
  type KnowledgePointType,
} from '@/lib/curriculum/types';

interface KnowledgePointsPanelProps {
  seriesId: string;
  courses: CurriculumCourseRecord[];
  knowledgePoints: KnowledgePointRecord[];
  courseKnowledgePoints: CourseKnowledgePointRecord[];
  onChanged: () => Promise<void> | void;
}

interface KnowledgePointFormState {
  name: string;
  code: string;
  type: KnowledgePointType;
  difficulty: KnowledgePointDifficulty | '';
  parentId: string;
  summary: string;
  sortOrder: string;
}

const EMPTY_FORM: KnowledgePointFormState = {
  name: '',
  code: '',
  type: 'knowledge',
  difficulty: '',
  parentId: '',
  summary: '',
  sortOrder: '0',
};

const TYPE_LABELS: Record<KnowledgePointType, string> = {
  knowledge: '知识',
  skill: '技能',
  competency: '素养/能力',
};

const DIFFICULTY_LABELS: Record<KnowledgePointDifficulty, string> = {
  intro: '入门',
  basic: '基础',
  intermediate: '进阶',
  advanced: '高级',
};

const COVERAGE_LABELS: Record<CourseKnowledgeCoverageLevel, string> = {
  introduced: '引入',
  practiced: '练习',
  mastered: '掌握',
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

export function KnowledgePointsPanel({
  seriesId,
  courses,
  knowledgePoints,
  courseKnowledgePoints,
  onChanged,
}: KnowledgePointsPanelProps) {
  const [form, setForm] = useState<KnowledgePointFormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedCourseId, setSelectedCourseId] = useState('');
  const [coverageDraft, setCoverageDraft] = useState<Record<string, CourseKnowledgeCoverageLevel>>(
    {},
  );
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

  useEffect(() => {
    if (!selectedCourseId) {
      setCoverageDraft({});
      return;
    }
    const linked = courseKnowledgePoints.filter((link) => link.courseId === selectedCourseId);
    setCoverageDraft(
      Object.fromEntries(linked.map((link) => [link.knowledgePointId, link.coverageLevel])),
    );
  }, [courseKnowledgePoints, selectedCourseId]);

  const resetForm = () => {
    setForm(EMPTY_FORM);
    setEditingId(null);
  };

  const submit = async () => {
    if (!form.name.trim()) return;
    setBusy('save');
    setError(null);
    try {
      const body = {
        name: form.name.trim(),
        code: form.code.trim() || null,
        seriesId: seriesId || null,
        parentId: form.parentId || null,
        type: form.type,
        difficulty: form.difficulty || null,
        summary: form.summary.trim() || null,
        sortOrder: Number.parseInt(form.sortOrder, 10) || 0,
      };
      await requestJson(
        editingId
          ? `/api/curriculum/knowledge-points/${editingId}`
          : '/api/curriculum/knowledge-points',
        {
          method: editingId ? 'PATCH' : 'POST',
          body: JSON.stringify(body),
        },
      );
      resetForm();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const edit = (point: KnowledgePointRecord) => {
    setEditingId(point.id);
    setForm({
      name: point.name,
      code: point.code ?? '',
      type: point.type,
      difficulty: point.difficulty ?? '',
      parentId: point.parentId ?? '',
      summary: point.summary ?? '',
      sortOrder: String(point.sortOrder),
    });
  };

  const remove = async (point: KnowledgePointRecord) => {
    if (!window.confirm(`删除知识点“${point.name}”？课程绑定会一并取消。`)) return;
    setBusy(`delete-${point.id}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/knowledge-points/${point.id}`, { method: 'DELETE' });
      if (editingId === point.id) resetForm();
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const toggleCoursePoint = (pointId: string, checked: boolean) => {
    setCoverageDraft((current) => {
      const next = { ...current };
      if (checked) next[pointId] = next[pointId] ?? 'introduced';
      else delete next[pointId];
      return next;
    });
  };

  const saveCoursePoints = async () => {
    if (!selectedCourseId) return;
    setBusy('course-points');
    setError(null);
    try {
      await requestJson(`/api/curriculum/courses/${selectedCourseId}/knowledge-points`, {
        method: 'PUT',
        body: JSON.stringify({
          knowledgePoints: Object.entries(coverageDraft).map(
            ([knowledgePointId, coverageLevel]) => ({
              knowledgePointId,
              coverageLevel,
            }),
          ),
        }),
      });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4" />
          知识点库与课程绑定
        </CardTitle>
        <CardDescription>
          维护知识点树，并把知识点绑定到课程；同一知识点可以在不同课程中处于不同掌握层级。
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-6 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)]">
        <div className="flex flex-col gap-4">
          <div className="grid gap-2 md:grid-cols-2">
            <Input
              placeholder="知识点名称 *"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
            />
            <Input
              placeholder="编号，例如 KP-01"
              value={form.code}
              onChange={(event) => setForm({ ...form, code: event.target.value })}
            />
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={form.type}
              onChange={(event) =>
                setForm({ ...form, type: event.target.value as KnowledgePointType })
              }
            >
              {KNOWLEDGE_POINT_TYPES.map((type) => (
                <option key={type} value={type}>
                  {TYPE_LABELS[type]}
                </option>
              ))}
            </select>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={form.difficulty}
              onChange={(event) =>
                setForm({
                  ...form,
                  difficulty: event.target.value as KnowledgePointDifficulty | '',
                })
              }
            >
              <option value="">未设置难度</option>
              {KNOWLEDGE_POINT_DIFFICULTIES.map((difficulty) => (
                <option key={difficulty} value={difficulty}>
                  {DIFFICULTY_LABELS[difficulty]}
                </option>
              ))}
            </select>
            <select
              className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
              value={form.parentId}
              onChange={(event) => setForm({ ...form, parentId: event.target.value })}
            >
              <option value="">无父知识点</option>
              {visiblePoints
                .filter((point) => point.id !== editingId)
                .map((point) => (
                  <option key={point.id} value={point.id}>
                    {point.name}
                  </option>
                ))}
            </select>
            <Input
              type="number"
              placeholder="排序"
              value={form.sortOrder}
              onChange={(event) => setForm({ ...form, sortOrder: event.target.value })}
            />
            <Textarea
              placeholder="说明（可选）"
              value={form.summary}
              onChange={(event) => setForm({ ...form, summary: event.target.value })}
              className="md:col-span-2"
            />
          </div>
          <div className="flex gap-2">
            <Button onClick={() => void submit()} disabled={busy !== null || !form.name.trim()}>
              {busy === 'save' ? <Loader2 className="animate-spin" /> : <Save />}
              {editingId ? '保存知识点' : '新建知识点'}
            </Button>
            {editingId ? (
              <Button variant="outline" onClick={resetForm} disabled={busy !== null}>
                取消编辑
              </Button>
            ) : null}
          </div>

          <div className="flex flex-col gap-2">
            {visiblePoints.map((point) => {
              const linkedCourseCount = courseKnowledgePoints.filter(
                (link) => link.knowledgePointId === point.id,
              ).length;
              return (
                <div
                  key={point.id}
                  className="border-border flex items-start justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                >
                  <div>
                    <div className="font-medium">
                      {point.code ? `${point.code} · ` : ''}
                      {point.name}
                    </div>
                    <div className="text-muted-foreground text-xs">
                      {TYPE_LABELS[point.type]}
                      {point.difficulty ? ` · ${DIFFICULTY_LABELS[point.difficulty]}` : ''}
                      {` · ${linkedCourseCount} 门课程`}
                    </div>
                    {point.summary ? (
                      <div className="text-muted-foreground mt-1 text-xs">{point.summary}</div>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button size="xs" variant="outline" onClick={() => edit(point)}>
                      编辑
                    </Button>
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      onClick={() => void remove(point)}
                      disabled={busy !== null}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
              );
            })}
            {visiblePoints.length === 0 ? (
              <p className="text-muted-foreground py-6 text-center text-sm">当前系列还没有知识点</p>
            ) : null}
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <Link2 className="size-4" />
            <span className="text-sm font-medium">课程知识点绑定</span>
          </div>
          <select
            className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
            value={selectedCourseId}
            onChange={(event) => setSelectedCourseId(event.target.value)}
          >
            <option value="">选择课程</option>
            {visibleCourses.map((course) => (
              <option key={course.id} value={course.id}>
                {course.title}
              </option>
            ))}
          </select>

          {selectedCourseId ? (
            <div className="flex max-h-[420px] flex-col gap-2 overflow-auto pr-1">
              {visiblePoints.map((point) => {
                const coverage = coverageDraft[point.id];
                const checked = coverage !== undefined;
                return (
                  <label
                    key={point.id}
                    className="border-border flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(event) => toggleCoursePoint(point.id, event.target.checked)}
                      />
                      <span>
                        {point.code ? `${point.code} · ` : ''}
                        {point.name}
                      </span>
                    </span>
                    {checked ? (
                      <select
                        className="border-input h-8 rounded-md border bg-transparent px-2 text-xs"
                        value={coverage}
                        onChange={(event) =>
                          setCoverageDraft((current) => ({
                            ...current,
                            [point.id]: event.target.value as CourseKnowledgeCoverageLevel,
                          }))
                        }
                      >
                        {COURSE_KNOWLEDGE_COVERAGE_LEVELS.map((level) => (
                          <option key={level} value={level}>
                            {COVERAGE_LABELS[level]}
                          </option>
                        ))}
                      </select>
                    ) : null}
                  </label>
                );
              })}
              {visiblePoints.length === 0 ? (
                <p className="text-muted-foreground py-6 text-center text-sm">
                  先创建知识点，再绑定课程
                </p>
              ) : null}
            </div>
          ) : (
            <p className="text-muted-foreground py-8 text-center text-sm">
              选择一门课程查看并维护知识点绑定
            </p>
          )}

          <Button
            onClick={() => void saveCoursePoints()}
            disabled={busy !== null || !selectedCourseId}
          >
            {busy === 'course-points' ? <Loader2 className="animate-spin" /> : <Save />}
            保存课程知识点绑定
          </Button>
        </div>
      </CardContent>
      {error ? <CardContent className="text-sm text-destructive">{error}</CardContent> : null}
    </Card>
  );
}
