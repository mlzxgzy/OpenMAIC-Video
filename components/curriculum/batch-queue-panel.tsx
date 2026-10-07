'use client';

import { useEffect, useMemo, useState } from 'react';
import { ListChecks, Loader2, Pause, Play, RotateCcw, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import type {
  CourseKnowledgePointRecord,
  CurriculumBatchItemRecord,
  CurriculumBatchItemStatus,
  CurriculumBatchRecord,
  CurriculumCourseRecord,
} from '@/lib/curriculum/types';

interface BatchQueuePanelProps {
  seriesId: string;
  courses: CurriculumCourseRecord[];
  courseKnowledgePoints: CourseKnowledgePointRecord[];
  batches: CurriculumBatchRecord[];
  batchItems: CurriculumBatchItemRecord[];
  onChanged: () => Promise<void> | void;
}

const ITEM_STATUS_LABELS: Record<CurriculumBatchItemStatus, string> = {
  queued: '排队中',
  starting: '启动中',
  running: '生成中',
  awaiting_outline: '等待大纲',
  paused: '已暂停',
  completed: '已完成',
  failed: '失败',
  ended: '已结束',
  cancelled: '已取消',
};

const BATCH_STATUS_LABELS: Record<CurriculumBatchRecord['status'], string> = {
  queued: '排队中',
  running: '运行中',
  paused: '已暂停',
  completed: '已完成',
  failed: '有失败',
  cancelled: '已取消',
};

function statusClass(status: CurriculumBatchItemStatus): string {
  if (status === 'completed') return 'text-emerald-700';
  if (status === 'failed' || status === 'ended') return 'text-destructive';
  if (status === 'paused') return 'text-amber-700';
  if (status === 'running' || status === 'awaiting_outline') return 'text-primary';
  return 'text-muted-foreground';
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

export function BatchQueuePanel({
  seriesId,
  courses,
  courseKnowledgePoints,
  batches,
  batchItems,
  onChanged,
}: BatchQueuePanelProps) {
  const [name, setName] = useState('');
  const [selectedCourseIds, setSelectedCourseIds] = useState<Record<string, boolean>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const visibleCourses = useMemo(() => {
    if (!seriesId) return courses;
    return courses.filter((course) => course.seriesId === seriesId);
  }, [courses, seriesId]);

  const courseIdsWithPoints = useMemo(
    () => new Set(courseKnowledgePoints.map((link) => link.courseId)),
    [courseKnowledgePoints],
  );

  const selectedCount = useMemo(
    () => Object.values(selectedCourseIds).filter(Boolean).length,
    [selectedCourseIds],
  );

  const itemByCourse = useMemo(
    () => new Map(batchItems.map((item) => [item.courseId ?? item.id, item])),
    [batchItems],
  );

  const activeBatches = batches.some((batch) =>
    ['queued', 'running', 'paused'].includes(batch.status),
  );

  useEffect(() => {
    if (!activeBatches) return;
    const timer = window.setInterval(() => void onChanged(), 5000);
    return () => window.clearInterval(timer);
  }, [activeBatches, onChanged]);

  const toggleCourse = (courseId: string, checked: boolean) => {
    setSelectedCourseIds((current) => ({ ...current, [courseId]: checked }));
  };

  const createBatch = async () => {
    if (selectedCount === 0) return;
    setBusy('create');
    setError(null);
    try {
      const items = visibleCourses
        .filter((course) => selectedCourseIds[course.id])
        .map((course) => ({ courseId: course.id }));
      const payload = await requestJson<{ batchId: string; itemCount: number }>(
        '/api/curriculum/batches',
        {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim() || `批量生成 ${new Date().toLocaleString('zh-CN')}`,
            items,
          }),
        },
      );
      setSelectedCourseIds({});
      setName('');
      setError(`已创建批量队列：${payload.itemCount} 门课程排队中。`);
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const act = async (batchId: string, action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    if (
      action === 'cancel' &&
      !window.confirm('取消这个批量队列？正在运行的课程不会被强制停止。')
    ) {
      return;
    }
    setBusy(`${action}-${batchId}`);
    setError(null);
    try {
      await requestJson(`/api/curriculum/batches/${batchId}`, {
        method: 'PATCH',
        body: JSON.stringify({ action }),
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
          <ListChecks className="size-4" />
          批量生成队列
        </CardTitle>
        <CardDescription>
          把当前系列中已有知识点的课程加入队列；队列按 owner 的生成并发限制自动串行/并行推进。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-5">
        <div className="grid gap-3 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
          <div className="border-border flex flex-col gap-3 rounded-lg border p-3">
            <Input
              placeholder="队列名称（可选）"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <span>
                可加入{' '}
                {visibleCourses.filter((course) => courseIdsWithPoints.has(course.id)).length}{' '}
                门课程
              </span>
              <span>已选 {selectedCount}</span>
            </div>
            <div className="flex max-h-64 flex-col gap-1 overflow-y-auto pr-1">
              {visibleCourses.map((course) => {
                const hasPoints = courseIdsWithPoints.has(course.id);
                const existingItem = itemByCourse.get(course.id);
                return (
                  <label
                    key={course.id}
                    className={`flex items-start gap-2 rounded-md px-2 py-1.5 text-sm ${
                      hasPoints ? 'hover:bg-muted/40' : 'opacity-50'
                    }`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1 size-4 accent-primary"
                      disabled={!hasPoints}
                      checked={Boolean(selectedCourseIds[course.id])}
                      onChange={(event) => toggleCourse(course.id, event.target.checked)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">{course.title}</span>
                      <span className="text-muted-foreground block text-xs">
                        {course.code ?? '无编号'} · 知识点{' '}
                        {courseKnowledgePoints.filter((link) => link.courseId === course.id).length}
                        {existingItem
                          ? ` · 最近队列：${ITEM_STATUS_LABELS[existingItem.status]}`
                          : ''}
                      </span>
                    </span>
                  </label>
                );
              })}
              {visibleCourses.length === 0 ? (
                <p className="text-muted-foreground text-sm">当前系列还没有课程。</p>
              ) : null}
            </div>
            <Button
              onClick={() => void createBatch()}
              disabled={busy !== null || selectedCount === 0}
            >
              {busy === 'create' ? <Loader2 className="animate-spin" /> : <Play />}
              加入生成队列
            </Button>
          </div>

          <div className="flex flex-col gap-2">
            {batches.length === 0 ? (
              <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
                还没有批量队列。
              </p>
            ) : null}
            {batches.map((batch) => {
              const items = batchItems
                .filter((item) => item.batchId === batch.id)
                .sort((a, b) => a.position - b.position);
              const completed = items.filter((item) => item.status === 'completed').length;
              const failed = items.filter((item) =>
                ['failed', 'ended', 'paused'].includes(item.status),
              ).length;
              const progress =
                items.length === 0 ? 0 : Math.round((completed / items.length) * 100);
              return (
                <div
                  key={batch.id}
                  className="border-border flex flex-col gap-2 rounded-lg border p-3"
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="truncate text-sm font-medium">{batch.name}</div>
                      <div className="text-muted-foreground text-xs">
                        {BATCH_STATUS_LABELS[batch.status]} · {completed}/{items.length} 完成
                        {failed > 0 ? ` · ${failed} 需处理` : ''}
                      </div>
                    </div>
                    <div className="flex flex-wrap gap-1">
                      {batch.status !== 'cancelled' && batch.status !== 'completed' ? (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy !== null}
                          onClick={() =>
                            void act(batch.id, batch.status === 'paused' ? 'resume' : 'pause')
                          }
                        >
                          {batch.status === 'paused' ? <Play /> : <Pause />}
                          {batch.status === 'paused' ? '继续' : '暂停'}
                        </Button>
                      ) : null}
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null}
                        onClick={() => void act(batch.id, 'retry')}
                      >
                        <RotateCcw />
                        重试
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy !== null || batch.status === 'cancelled'}
                        onClick={() => void act(batch.id, 'cancel')}
                      >
                        <Trash2 />
                        取消
                      </Button>
                    </div>
                  </div>

                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div className="bg-primary h-full" style={{ width: `${progress}%` }} />
                  </div>

                  <div className="flex max-h-52 flex-col gap-1 overflow-y-auto">
                    {items.map((item) => (
                      <div
                        key={item.id}
                        className="bg-muted/30 flex items-start justify-between gap-2 rounded-md px-2 py-1.5 text-xs"
                      >
                        <span className="min-w-0">
                          <span className="block truncate font-medium">{item.title}</span>
                          <span className={`${statusClass(item.status)} block`}>
                            {ITEM_STATUS_LABELS[item.status]}
                            {item.error?.message ? `：${item.error.message}` : ''}
                          </span>
                        </span>
                        <span className="text-muted-foreground shrink-0">
                          {item.stageId
                            ? '已有课堂'
                            : item.attempts > 0
                              ? `尝试 ${item.attempts}`
                              : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {error ? (
          <div className="rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">
            {error}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
