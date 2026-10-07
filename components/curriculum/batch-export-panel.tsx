'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Loader2, RotateCcw, Square, Video } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type {
  CurriculumBatchItemRecord,
  CurriculumCourseRecord,
  CurriculumExportJobRecord,
  CurriculumExportJobStatus,
} from '@/lib/curriculum/types';
import type { Scene, Stage } from '@/lib/types/stage';
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

function statusClass(status: CurriculumExportJobStatus): string {
  if (status === 'succeeded') return 'text-emerald-700';
  if (status === 'failed') return 'text-destructive';
  if (status === 'cancelled') return 'text-muted-foreground';
  if (status === 'rendering' || status === 'building' || status === 'submitting')
    return 'text-primary';
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

async function patchExportJob(
  id: string,
  body: Record<string, unknown>,
): Promise<CurriculumExportJobRecord> {
  const payload = await requestJson<{ job: CurriculumExportJobRecord }>(
    `/api/curriculum/export-jobs/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return payload.job;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Browser-side export queue worker.
 *
 * The Hyperframes ZIP needs off-screen DOM snapshots and the local asset view,
 * so it can only be built in a browser page. The server owns the queue and
 * render job id; this component claims one job at a time, builds the ZIP for
 * its stage, uploads it to the existing render route, then polls the render
 * service until the MP4 is ready.
 */
export function BatchExportPanel({
  seriesId,
  courses,
  batchItems,
  exportJobs,
  onChanged,
}: BatchExportPanelProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { locale } = useI18n();
  const [workerEnabled, setWorkerEnabled] = useState(true);
  const jobsRef = useRef(exportJobs);
  const onChangedRef = useRef(onChanged);
  const workerEnabledRef = useRef(true);
  const workerRunningRef = useRef(false);

  useEffect(() => {
    jobsRef.current = exportJobs;
  }, [exportJobs]);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    workerEnabledRef.current = workerEnabled;
  }, [workerEnabled]);

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

  const pollRenderJob = useCallback(async (job: CurriculumExportJobRecord): Promise<void> => {
    if (!job.renderJobId) throw new Error('渲染任务缺少 jobId');
    const pollIntervalMs = 3000;
    const maxAttempts = Math.ceil((60 * 60 * 1000) / pollIntervalMs);
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      await sleep(pollIntervalMs);
      const response = await fetch(
        `/api/export-video/render/${encodeURIComponent(job.renderJobId)}`,
        { credentials: 'same-origin', cache: 'no-store' },
      );
      const payload = (await response.json().catch(() => ({}))) as {
        status?: string;
        progress?: number;
        error?: string;
      };
      if (!response.ok) {
        throw new Error(payload.error ?? `渲染状态查询失败：HTTP ${response.status}`);
      }
      const progress = Math.max(0, Math.min(1, Number(payload.progress) || 0));
      if (Number.isFinite(progress)) {
        try {
          await patchExportJob(job.id, { action: 'progress', progress });
        } catch {
          // A transient ledger update must not fail the render itself.
        }
      }
      if (payload.status === 'succeeded') {
        await patchExportJob(job.id, { action: 'complete' });
        return;
      }
      if (payload.status === 'failed' || payload.status === 'cancelled') {
        throw new Error(payload.error || `渲染任务${payload.status}`);
      }
    }
    throw new Error('渲染超时');
  }, []);

  const processJob = useCallback(
    async (job: CurriculumExportJobRecord): Promise<void> => {
      if (job.renderJobId && (job.status === 'rendering' || job.status === 'submitting')) {
        await pollRenderJob(job);
        return;
      }

      const [{ accessDocument }, { buildExportZip }] = await Promise.all([
        import('@/lib/document-store'),
        import('@/lib/video-export-app/build-export-zip'),
      ]);
      const accessed = await accessDocument(job.stageId);
      if (!accessed.document) throw new Error('找不到课程文档');
      const source = {
        stage: accessed.document.stage as unknown as Stage,
        scenes: accessed.document.scenes as unknown as Scene[],
      };
      const built = await buildExportZip({
        resolution: job.resolution as '720p' | '1080p' | '4k',
        burnInSubtitles: job.burnInSubtitles,
        locale,
        source,
      });

      const form = new FormData();
      form.append('project', built.zipBlob, 'project.zip');
      form.append('fps', String(job.fps));
      form.append('quality', job.quality);
      form.append('format', 'mp4');

      const submitResponse = await fetch('/api/export-video/render', {
        method: 'POST',
        credentials: 'same-origin',
        body: form,
      });
      const submitPayload = (await submitResponse.json().catch(() => ({}))) as {
        jobId?: string;
        error?: string;
        details?: string;
      };
      if (!submitResponse.ok || !submitPayload.jobId) {
        throw new Error(
          [submitPayload.error, submitPayload.details].filter(Boolean).join(': ') ||
            `提交渲染失败：HTTP ${submitResponse.status}`,
        );
      }

      const attached = await patchExportJob(job.id, {
        action: 'attach-render',
        renderJobId: submitPayload.jobId,
      });
      await pollRenderJob(attached);
    },
    [locale, pollRenderJob],
  );

  const runWorker = useCallback(async () => {
    if (workerRunningRef.current || !workerEnabledRef.current) return;
    workerRunningRef.current = true;
    try {
      for (let guard = 0; guard < 50; guard += 1) {
        if (!workerEnabledRef.current) break;
        const rendering = jobsRef.current.find(
          (job) => job.status === 'rendering' && job.renderJobId,
        );
        if (rendering) {
          await processJob(rendering);
          await onChangedRef.current();
          continue;
        }
        const claimed = await requestJson<{ job: CurriculumExportJobRecord | null }>(
          '/api/curriculum/export-jobs/claim',
          { method: 'POST' },
        );
        if (!claimed.job) break;
        try {
          await processJob(claimed.job);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          await patchExportJob(claimed.job.id, {
            action: 'fail',
            error: { code: 'EXPORT_FAILED', message },
          });
        }
        await onChangedRef.current();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      workerRunningRef.current = false;
    }
  }, [processJob]);

  useEffect(() => {
    if (workerEnabled && hasQueueWork) void runWorker();
  }, [hasQueueWork, runWorker, workerEnabled]);

  const enqueueExports = async () => {
    if (exportableItems.length === 0) return;
    setBusy('enqueue');
    setError(null);
    try {
      await requestJson('/api/curriculum/export-jobs', {
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
      await patchExportJob(job.id, { action });
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const downloadJob = async (job: CurriculumExportJobRecord) => {
    if (!job.renderJobId) return;
    setBusy(`download-${job.id}`);
    setError(null);
    try {
      const response = await fetch(
        `/api/export-video/render/${encodeURIComponent(job.renderJobId)}/download`,
        { credentials: 'same-origin' },
      );
      if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${job.title || 'classroom'}.mp4`;
      anchor.click();
      URL.revokeObjectURL(url);
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
