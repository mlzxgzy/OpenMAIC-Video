'use client';

/**
 * 浏览器侧的导出队列 worker —— MP4 导出唯一的一份实现。
 *
 * 为什么必须在浏览器里跑：Hyperframes 的 ZIP 需要**离屏 DOM 快照**和本地资产
 * 视图（`build-export-zip`），服务端没有这两样。所以服务端只拥有队列和渲染
 * job id，页面认领一个任务、为它的 stage 构建 ZIP、上传到已有的渲染路由、
 * 然后轮询渲染服务直到 MP4 就绪。
 *
 * 这份实现被两个页面共用：旧台账的批量导出（`batch-export-panel.tsx`）和目
 * 工作台的出片（`design-produce.tsx`）。**共用不是省代码，是避免两套认领逻辑**：
 * 认领是全局按 owner 取最旧一条（`/export-jobs/claim` 不认识来源），所以两个
 * 页面本来就会互相认领对方排的队。如果各写一份，一份修了"被中断的 building
 * 任务"另一份没修，就会出现"在某些页面上导出永远卡住"这种只在特定入口复现的
 * 故障。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import type { CurriculumExportJobRecord } from '@/lib/curriculum/types';
import type { Locale } from '@/lib/i18n';
import type { Scene, Stage } from '@/lib/types/stage';

/** 认领/状态回写共用的 JSON 请求。错误信息优先取服务端的 `error.message`。 */
export async function requestExportJson<T>(url: string, init?: RequestInit): Promise<T> {
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

export async function patchCurriculumExportJob(
  id: string,
  body: Record<string, unknown>,
): Promise<CurriculumExportJobRecord> {
  const payload = await requestExportJson<{ job: CurriculumExportJobRecord }>(
    `/api/curriculum/export-jobs/${id}`,
    { method: 'PATCH', body: JSON.stringify(body) },
  );
  return payload.job;
}

/** 触发浏览器下载已渲染好的 MP4。下载名取任务的 `title`，服务端不参与。 */
export async function downloadCurriculumExportJob(job: CurriculumExportJobRecord): Promise<void> {
  if (!job.renderJobId) throw new Error('这条导出还没有渲染任务，无法下载');
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
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface ExportWorkerOptions {
  /** 当前页面看见的任务。认领是全局的，但"有没有活干"要看页面自己的列表。 */
  jobs: CurriculumExportJobRecord[];
  onChanged: () => Promise<void> | void;
  locale: Locale;
}

/**
 * 轮询一个已经提交给渲染服务的任务。
 *
 * 每次进度回写失败都吞掉：账本的一次更新失败不该让一个正在进行的渲染变成失败。
 * 真正决定成败的是渲染服务自己的状态字段。
 */
async function pollRenderJob(job: CurriculumExportJobRecord): Promise<void> {
  if (!job.renderJobId) throw new Error('渲染任务缺少 jobId');
  const pollIntervalMs = 3000;
  const maxAttempts = Math.ceil((60 * 60 * 1000) / pollIntervalMs);
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await sleep(pollIntervalMs);
    const response = await fetch(
      `/api/export-video/render/${encodeURIComponent(job.renderJobId)}`,
      {
        credentials: 'same-origin',
        cache: 'no-store',
      },
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
        await patchCurriculumExportJob(job.id, { action: 'progress', progress });
      } catch {
        // A transient ledger update must not fail the render itself.
      }
    }
    if (payload.status === 'succeeded') {
      await patchCurriculumExportJob(job.id, { action: 'complete' });
      return;
    }
    if (payload.status === 'failed' || payload.status === 'cancelled') {
      throw new Error(payload.error || `渲染任务${payload.status}`);
    }
  }
  throw new Error('渲染超时');
}

/** 为一条任务构建 ZIP 并提交渲染，返回新的账本记录。 */
async function buildAndSubmit(
  job: CurriculumExportJobRecord,
  locale: Locale,
): Promise<CurriculumExportJobRecord> {
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

  return patchCurriculumExportJob(job.id, {
    action: 'attach-render',
    renderJobId: submitPayload.jobId,
  });
}

export interface ExportWorker {
  busy: string | null;
  error: string | null;
  setError: (value: string | null) => void;
  setBusy: (value: string | null) => void;
  enabled: boolean;
  setEnabled: (value: boolean) => void;
  /** 跑一轮认领循环。页面在"有活干"时调用它。 */
  runWorker: () => Promise<void>;
  /** 认领并处理一条任务（含失败回写）。 */
  processJob: (job: CurriculumExportJobRecord) => Promise<void>;
  download: (job: CurriculumExportJobRecord) => Promise<void>;
}

export function useCurriculumExportWorker({
  jobs,
  onChanged,
  locale,
}: ExportWorkerOptions): ExportWorker {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [enabled, setEnabled] = useState(true);
  const jobsRef = useRef(jobs);
  const onChangedRef = useRef(onChanged);
  const enabledRef = useRef(true);
  const runningRef = useRef(false);

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);
  useEffect(() => {
    onChangedRef.current = onChanged;
  }, [onChanged]);
  useEffect(() => {
    enabledRef.current = enabled;
  }, [enabled]);

  const processJob = useCallback(
    async (job: CurriculumExportJobRecord): Promise<void> => {
      if (job.renderJobId && (job.status === 'rendering' || job.status === 'submitting')) {
        await pollRenderJob(job);
        return;
      }
      const attached = await buildAndSubmit(job, locale);
      await pollRenderJob(attached);
    },
    [locale],
  );

  const runWorker = useCallback(async () => {
    if (runningRef.current || !enabledRef.current) return;
    runningRef.current = true;
    try {
      for (let guard = 0; guard < 50; guard += 1) {
        if (!enabledRef.current) break;
        const rendering = jobsRef.current.find(
          (job) => job.status === 'rendering' && job.renderJobId,
        );
        if (rendering) {
          await processJob(rendering);
          await onChangedRef.current();
          continue;
        }
        const claimed = await requestExportJson<{ job: CurriculumExportJobRecord | null }>(
          '/api/curriculum/export-jobs/claim',
          { method: 'POST' },
        );
        if (!claimed.job) break;
        try {
          await processJob(claimed.job);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : String(cause);
          await patchCurriculumExportJob(claimed.job.id, {
            action: 'fail',
            error: { code: 'EXPORT_FAILED', message },
          });
        }
        await onChangedRef.current();
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      runningRef.current = false;
    }
  }, [processJob]);

  const download = useCallback(async (job: CurriculumExportJobRecord) => {
    setBusy(`download-${job.id}`);
    setError(null);
    try {
      await downloadCurriculumExportJob(job);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  return {
    busy,
    error,
    setError,
    setBusy,
    enabled,
    setEnabled,
    runWorker,
    processJob,
    download,
  };
}
