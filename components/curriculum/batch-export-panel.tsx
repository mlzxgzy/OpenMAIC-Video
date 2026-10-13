'use client';

import { useEffect, useMemo } from 'react';
import { Download, Loader2, RotateCcw, Square, Video } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  patchCurriculumExportJob,
  requestExportJson,
  sleep,
  useCurriculumExportWorker,
} from '@/lib/curriculum/export-worker';
import type {
  CurriculumBatchItemRecord,
  CurriculumCourseRecord,
  CurriculumExportJobRecord,
  CurriculumExportJobStatus,
} from '@/lib/curriculum/types';
import { useI18n } from '@/lib/hooks/use-i18n';

interface BatchExportPanelProps {
  seriesId: string;
  courses: CurriculumCourseRecord[];
  batchItems: CurriculumBatchItemRecord[];
  exportJobs: CurriculumExportJobRecord[];
  onChanged: () => Promise<void> | void;
}

const STATUS_LABELS: Record<CurriculumExportJobStatus, string> = {
  queued: '排队中',
  building: '构建 ZIP',
  submitting: '提交渲染',
  rendering: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

/** 任务状态的中文名与颜色。认领与处理在 `lib/curriculum/export-worker.ts`。 */
function statusClass(status: CurriculumExportJobStatus): string {
  if (status === 'succeeded') return 'text-emerald-700';
  if (status === 'failed') return 'text-destructive';
  if (status === 'cancelled') return 'text-muted-foreground';
  if (status === 'rendering' || status === 'building' || status === 'submitting')
    return 'text-primary';
  return 'text-muted-foreground';
}

/**
 * 批量导出 MP4（旧台账的「视频导出」Tab）。
 *
 * 这里只剩"这一页看到哪些任务、怎么排队、怎么展示"；认领、构建 ZIP、提交渲染
 * 与轮询都在共用的 `useCurriculumExportWorker` 里，目工作台的出片面板用的是
 * 同一份。
 */
export function BatchExportPanel({
  seriesId,
  courses,
  batchItems,
  exportJobs,
  onChanged,
}: BatchExportPanelProps) {
  const { locale } = useI18n();

  const visibleCourses = useMemo(() => {
    if (!seriesId) return courses;
    return courses.filter((course) => course.seriesId === seriesId);
  }, [courses, seriesId]);
  const visibleCourseIds = useMemo(
    () => new Set(visibleCourses.map((course) => course.id)),
    [visibleCourses],
  );

  const visibleExportJobs = useMemo(
    () =>
      exportJobs.filter((job) =>
        batchItems.some(
          (item) =>
            item.id === job.batchItemId && (!item.courseId || visibleCourseIds.has(item.courseId)),
        ),
      ),
    [batchItems, exportJobs, visibleCourseIds],
  );

  const completedItems = useMemo(
    () =>
      batchItems.filter(
        (item) =>
          item.status === 'completed' &&
          !!item.stageId &&
          (!item.courseId || visibleCourseIds.has(item.courseId)),
      ),
    [batchItems, visibleCourseIds],
  );

  const jobByBatchItem = useMemo(() => {
    const map = new Map<string, CurriculumExportJobRecord>();
    for (const job of visibleExportJobs) {
      if (!job.batchItemId) continue;
      const previous = map.get(job.batchItemId);
      if (!previous || job.createdAt > previous.createdAt) map.set(job.batchItemId, job);
    }
    return map;
  }, [visibleExportJobs]);

  const exportableItems = useMemo(
    () =>
      completedItems.filter((item) => {
        const existing = item.id ? jobByBatchItem.get(item.id) : undefined;
        return !existing || existing.status === 'failed' || existing.status === 'cancelled';
      }),
    [completedItems, jobByBatchItem],
  );

  const hasQueueWork = visibleExportJobs.some(
    (job) =>
      job.status === 'queued' ||
      job.status === 'building' ||
      job.status === 'submitting' ||
      job.status === 'rendering',
  );

  const worker = useCurriculumExportWorker({ jobs: visibleExportJobs, onChanged, locale });
  const {
    busy,
    error,
    setError,
    setBusy,
    enabled: workerEnabled,
    setEnabled: setWorkerEnabled,
    runWorker,
    download: downloadJob,
  } = worker;

  useEffect(() => {
    if (workerEnabled && hasQueueWork) void runWorker();
  }, [hasQueueWork, runWorker, workerEnabled]);

  const enqueueExports = async () => {
    if (exportableItems.length === 0) return;
    setBusy('enqueue');
    setError(null);
    try {
      await requestExportJson('/api/curriculum/export-jobs', {
        method: 'POST',
        body: JSON.stringify({
          batchItemIds: exportableItems.map((item) => item.id),
          resolution: '1080p',
          fps: 30,
          quality: 'standard',
          burnInSubtitles: false,
        }),
      });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const act = async (job: CurriculumExportJobRecord, action: 'retry' | 'cancel') => {
    setBusy(`${action}-${job.id}`);
    setError(null);
    try {
      await patchCurriculumExportJob(job.id, { action });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const downloadAll = async () => {
    setBusy('download-all');
    setError(null);
    try {
      const succeeded = visibleExportJobs.filter(
        (job) => job.status === 'succeeded' && job.renderJobId,
      );
      for (const job of succeeded) {
        await downloadJob(job);
        await sleep(250);
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Video className="size-4" />
          批量导出 MP4
        </CardTitle>
        <CardDescription>
          对已完成且已有课堂的批量项排队导出；浏览器在本页构建 ZIP
          并提交渲染，页面保持打开直到构建/提交完成。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => void enqueueExports()}
            disabled={busy !== null || exportableItems.length === 0}
          >
            {busy === 'enqueue' ? <Loader2 className="animate-spin" /> : <Video />}
            导出可导出的 {exportableItems.length} 门课程
          </Button>
          <Button
            variant="outline"
            onClick={() => void downloadAll()}
            disabled={busy !== null || !visibleExportJobs.some((job) => job.status === 'succeeded')}
          >
            <Download />
            下载全部已完成
          </Button>
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={workerEnabled}
              onChange={(event) => setWorkerEnabled(event.target.checked)}
            />
            浏览器导出工作器
          </label>
          <span className="text-muted-foreground text-xs">
            {hasQueueWork ? '队列处理中…' : '队列空闲'}
          </span>
        </div>

        {error ? (
          <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
            {error}
          </div>
        ) : null}

        <div className="flex flex-col gap-2">
          {visibleExportJobs.length === 0 ? (
            <p className="text-muted-foreground rounded-md border border-dashed p-4 text-sm">
              还没有导出任务。先在上面加入已完成课程。
            </p>
          ) : null}
          {visibleExportJobs.map((job) => {
            const item = job.batchItemId
              ? batchItems.find((candidate) => candidate.id === job.batchItemId)
              : undefined;
            const progress = Math.round((job.progress || 0) * 100);
            return (
              <div
                key={job.id}
                className="border-border flex flex-col gap-2 rounded-lg border p-3 text-sm"
              >
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="truncate font-medium">{item?.title ?? job.title}</div>
                    <div className={`${statusClass(job.status)} text-xs`}>
                      {STATUS_LABELS[job.status]}
                      {job.error?.message ? `：${job.error.message}` : ''}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {job.status === 'succeeded' && job.renderJobId ? (
                      <Button size="xs" variant="outline" onClick={() => void downloadJob(job)}>
                        <Download />
                        下载
                      </Button>
                    ) : null}
                    {job.status === 'failed' || job.status === 'cancelled' ? (
                      <Button size="xs" variant="outline" onClick={() => void act(job, 'retry')}>
                        <RotateCcw />
                        重试
                      </Button>
                    ) : null}
                    {job.status !== 'succeeded' && job.status !== 'cancelled' ? (
                      <Button size="xs" variant="outline" onClick={() => void act(job, 'cancel')}>
                        <Square />
                        取消
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                  <div className="bg-primary h-full" style={{ width: `${progress}%` }} />
                </div>
                <div className="text-muted-foreground flex flex-wrap justify-between gap-2 text-xs">
                  <span>stage：{job.stageId.slice(0, 12)}…</span>
                  <span>
                    {job.resolution} · {job.fps}fps · {job.quality}
                  </span>
                  <span>{progress}%</span>
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
    </Card>
  );
}
