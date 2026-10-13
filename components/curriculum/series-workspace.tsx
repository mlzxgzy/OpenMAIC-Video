'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  ArrowLeft,
  ArrowRight,
  BookOpen,
  Boxes,
  CheckCircle2,
  Clock,
  ExternalLink,
  GraduationCap,
  Layers,
  Loader2,
  Network,
  Pencil,
  Plus,
  RefreshCw,
  Save,
  Trash2,
  Video,
  X,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Textarea } from '@/components/ui/textarea';
import type {
  CurriculumCourseRecord,
  CurriculumSeriesRecord,
  CurriculumSnapshot,
} from '@/lib/curriculum/types';

interface SeriesStats {
  courses: CurriculumCourseRecord[];
  knowledgePointCount: number;
  linkedKnowledgeCount: number;
  generatedCourseCount: number;
  exportedCourseCount: number;
  totalHours: number;
  totalCredits: number;
  completedSteps: number;
  percent: number;
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

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

function buildStats(snapshot: CurriculumSnapshot, series: CurriculumSeriesRecord): SeriesStats {
  const courses = snapshot.courses.filter((course) => course.seriesId === series.id);
  const courseIds = new Set(courses.map((course) => course.id));
  const knowledgePointCount = snapshot.knowledgePoints.filter(
    (point) => point.seriesId === series.id,
  ).length;
  const linkedKnowledgeCount = snapshot.courseKnowledgePoints.filter((link) =>
    courseIds.has(link.courseId),
  ).length;
  const generatedCourseCount = new Set(
    snapshot.generationJobs
      .filter((job) => courseIds.has(job.courseId) && job.stageId)
      .map((job) => job.courseId),
  ).size;
  const exportedCourseCount = new Set(
    snapshot.exportJobs
      .filter(
        (job) => job.courseId !== null && courseIds.has(job.courseId) && job.status === 'succeeded',
      )
      .map((job) => job.courseId as string),
  ).size;
  const totalHours = courses.reduce((sum, course) => sum + (course.hours ?? 0), 0);
  const totalCredits = courses.reduce((sum, course) => sum + (course.credits ?? 0), 0);
  const completedSteps = [
    courses.length > 0,
    linkedKnowledgeCount > 0,
    generatedCourseCount > 0,
    exportedCourseCount > 0,
  ].filter(Boolean).length;

  return {
    courses,
    knowledgePointCount,
    linkedKnowledgeCount,
    generatedCourseCount,
    exportedCourseCount,
    totalHours,
    totalCredits,
    completedSteps,
    percent: Math.round((completedSteps / 4) * 100),
  };
}

function SummaryStat({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof BookOpen;
  label: string;
  value: string | number;
}) {
  return (
    <Card size="sm">
      <CardContent className="flex items-center gap-3">
        <span className="bg-primary/10 text-primary flex size-9 shrink-0 items-center justify-center rounded-lg">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0">
          <span className="text-muted-foreground block text-xs">{label}</span>
          <span className="block text-lg font-semibold tabular-nums">{value}</span>
        </span>
      </CardContent>
    </Card>
  );
}

function SeriesMetric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof BookOpen;
  label: string;
  value: string | number;
}) {
  return (
    <div className="bg-muted/40 rounded-lg px-3 py-2">
      <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Icon className="size-3.5 shrink-0" />
        {label}
      </div>
      <div className="mt-0.5 text-sm font-semibold tabular-nums">{value}</div>
    </div>
  );
}

export function SeriesWorkspace() {
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
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [seriesName, setSeriesName] = useState('');
  const [seriesDescription, setSeriesDescription] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDescription, setEditDescription] = useState('');

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      const payload = await requestJson<CurriculumSnapshot>('/api/curriculum');
      setSnapshot(payload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
      setBusy(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const statsBySeries = useMemo(() => {
    const map = new Map<string, SeriesStats>();
    for (const series of snapshot.series) {
      map.set(series.id, buildStats(snapshot, series));
    }
    return map;
  }, [snapshot]);

  const overview = useMemo(() => {
    const totalHours = snapshot.courses.reduce((sum, course) => sum + (course.hours ?? 0), 0);
    const generated = new Set(
      snapshot.generationJobs.filter((job) => job.stageId).map((job) => job.courseId),
    ).size;
    return {
      totalHours,
      generated,
    };
  }, [snapshot.courses, snapshot.generationJobs]);

  const createSeries = async () => {
    if (!seriesName.trim()) return;
    setBusy('create');
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

  const startEdit = (series: CurriculumSeriesRecord) => {
    setEditingId(series.id);
    setEditName(series.name);
    setEditDescription(series.description ?? '');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName('');
    setEditDescription('');
  };

  const saveEdit = async () => {
    if (!editingId || !editName.trim()) return;
    setBusy(`edit-${editingId}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/series/${editingId}`, {
        method: 'PATCH',
        body: JSON.stringify({
          name: editName.trim(),
          description: editDescription.trim() || null,
        }),
      });
      cancelEdit();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const deleteSeries = async (series: CurriculumSeriesRecord) => {
    if (
      !window.confirm(
        `删除课程序列“${series.name}”？\n\n课程和知识点不会被删除，只会变成未归属系列。`,
      )
    ) {
      return;
    }
    setBusy(`delete-${series.id}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/series/${series.id}`, { method: 'DELETE' });
      if (editingId === series.id) cancelEdit();
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Button variant="ghost" size="icon" asChild className="mt-0.5 shrink-0">
            <Link href="/" title="返回首页" aria-label="返回首页">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="min-w-0">
            <p className="text-muted-foreground text-sm">课程产品层 / Curriculum / Series</p>
            <h1 className="text-2xl font-semibold">课程序列</h1>
            <p className="text-muted-foreground mt-1 text-sm">
              按专业方向或课程包管理系列，查看生产进度，进入系列继续设计和生成。
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void load()} disabled={busy !== null}>
            {busy === 'load' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
        </div>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <SummaryStat icon={Layers} label="系列" value={snapshot.series.length} />
        <SummaryStat icon={BookOpen} label="课程" value={snapshot.courses.length} />
        <SummaryStat icon={Clock} label="总学时" value={formatNumber(overview.totalHours)} />
        <SummaryStat icon={GraduationCap} label="已生成课堂" value={overview.generated} />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>新建课程序列</CardTitle>
          <CardDescription>
            一个专业方向或一个课程包系列。同名系列会复用并更新描述。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-3 md:grid-cols-2">
          <Input
            placeholder="系列名称，例如 CTF综合实战"
            value={seriesName}
            onChange={(event) => setSeriesName(event.target.value)}
          />
          <Textarea
            placeholder="描述（可选），例如 6 个方向 × 3 个案例"
            value={seriesDescription}
            onChange={(event) => setSeriesDescription(event.target.value)}
            className="min-h-9 md:min-h-9"
          />
          <div className="flex justify-end md:col-span-2">
            <Button
              onClick={() => void createSeries()}
              disabled={busy !== null || !seriesName.trim()}
            >
              {busy === 'create' ? <Loader2 className="animate-spin" /> : <Plus />}
              新建 / 更新系列
            </Button>
          </div>
        </CardContent>
      </Card>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      {!loaded ? (
        <div className="text-muted-foreground flex min-h-[30vh] items-center justify-center gap-2 text-sm">
          <Loader2 className="animate-spin" />
          正在加载课程序列...
        </div>
      ) : snapshot.series.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-3 py-12 text-center">
            <Layers className="text-muted-foreground size-8" />
            <div>
              <div className="font-medium">还没有课程序列</div>
              <p className="text-muted-foreground mt-1 text-sm">
                先在上方创建一个系列，再进入课程体系建课程。
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-2">
          {snapshot.series.map((series) => {
            const stats = statsBySeries.get(series.id);
            if (!stats) return null;
            const editing = editingId === series.id;
            const isBusy = busy === `edit-${series.id}` || busy === `delete-${series.id}`;

            return (
              <Card key={series.id} data-size="sm">
                <CardContent className="flex flex-col gap-4">
                  {editing ? (
                    <div className="flex flex-col gap-3">
                      <Input
                        value={editName}
                        onChange={(event) => setEditName(event.target.value)}
                        placeholder="系列名称"
                      />
                      <Textarea
                        value={editDescription}
                        onChange={(event) => setEditDescription(event.target.value)}
                        placeholder="系列描述（可选）"
                        className="min-h-20"
                      />
                      <div className="flex justify-end gap-2">
                        <Button variant="ghost" onClick={cancelEdit} disabled={isBusy}>
                          <X />
                          取消
                        </Button>
                        <Button
                          onClick={() => void saveEdit()}
                          disabled={isBusy || !editName.trim()}
                        >
                          {busy === `edit-${series.id}` ? (
                            <Loader2 className="animate-spin" />
                          ) : (
                            <Save />
                          )}
                          保存
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <h2 className="text-base font-semibold">{series.name}</h2>
                            <Badge variant="secondary">{series.courseCount} 门课程</Badge>
                            {stats.exportedCourseCount > 0 ? (
                              <Badge variant="outline" className="gap-1">
                                <CheckCircle2 className="text-emerald-600" />
                                {stats.exportedCourseCount} 门已出片
                              </Badge>
                            ) : null}
                          </div>
                          <p className="text-muted-foreground mt-1 line-clamp-2 text-sm">
                            {series.description || '暂无描述'}
                          </p>
                          <p className="text-muted-foreground mt-1 text-xs">
                            更新于 {formatDate(series.updatedAt)}
                          </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                          <Button asChild size="sm">
                            <Link href={`/curriculum/series/${series.id}`}>
                              进入系列
                              <ArrowRight />
                            </Link>
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="outline"
                            title="编辑系列"
                            aria-label="编辑系列"
                            onClick={() => startEdit(series)}
                            disabled={busy !== null}
                          >
                            <Pencil />
                          </Button>
                          <Button
                            size="icon-sm"
                            variant="destructive"
                            title="删除系列"
                            aria-label="删除系列"
                            onClick={() => void deleteSeries(series)}
                            disabled={busy !== null}
                          >
                            <Trash2 />
                          </Button>
                        </div>
                      </div>

                      <div className="flex flex-col gap-2">
                        <Progress value={stats.percent} className="h-1.5" />
                        <div className="text-muted-foreground flex items-center justify-between text-xs">
                          <span>
                            {stats.completedSteps}/4 步完成：课程 → 知识点 → 生成课堂 → 导出视频
                          </span>
                          <span className="tabular-nums">{stats.percent}%</span>
                        </div>
                      </div>

                      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <SeriesMetric icon={BookOpen} label="课程" value={stats.courses.length} />
                        <SeriesMetric
                          icon={Network}
                          label="知识点 / 绑定"
                          value={`${stats.knowledgePointCount} / ${stats.linkedKnowledgeCount}`}
                        />
                        <SeriesMetric
                          icon={Boxes}
                          label="已生成课堂"
                          value={stats.generatedCourseCount}
                        />
                        <SeriesMetric
                          icon={Video}
                          label="已导出"
                          value={stats.exportedCourseCount}
                        />
                      </div>

                      <div className="flex flex-wrap items-center gap-2">
                        {stats.courses.slice(0, 3).map((course) => (
                          <Link
                            key={course.id}
                            href={`/curriculum/courses/${course.id}`}
                            className="border-border bg-background hover:border-primary/40 hover:text-primary inline-flex max-w-full items-center gap-1 rounded-full border px-2.5 py-1 text-xs transition-colors"
                            title={course.title}
                          >
                            <span className="max-w-[180px] truncate">{course.title}</span>
                            <ExternalLink className="size-3 shrink-0 opacity-60" />
                          </Link>
                        ))}
                        {stats.courses.length > 3 ? (
                          <span className="text-muted-foreground text-xs">
                            +{stats.courses.length - 3} 门
                          </span>
                        ) : null}
                        {stats.courses.length === 0 ? (
                          <span className="text-muted-foreground text-xs">
                            这个系列还没有课程，进入系列后创建第一门课。
                          </span>
                        ) : null}
                      </div>
                    </>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/*
        存档入口。原来是页头的一个"全部课程"主按钮，但那个按钮指向的正是
        "看一眼没有想法"的六 Tab 台账；放在页头等于把废弃路径当主路径推荐。
        留成页脚一句小字：找得到，但不引导。
      */}
      <p className="text-muted-foreground text-xs">
        跨系列的课程台账、知识点先修关系、培养方案矩阵与批量生成队列在
        <Link href="/curriculum/legacy" className="mx-1 underline">
          课程台账（存档）
        </Link>
        。日常做课用上面的系列。
      </p>
    </div>
  );
}
