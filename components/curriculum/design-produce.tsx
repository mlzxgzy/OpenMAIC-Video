'use client';

/**
 * 目工作台的「生成与导出」——设计做完之后的最后一段路。
 *
 * 这一段原来只在旧台账里：设计编辑器里把七步做完，然后要去 `/curriculum` 的
 * 「课程组装」Tab 找到同一个设计、点生成，再去「视频导出」Tab 排队。用户在目
 * 工作台里做完设计之后，**这个页面上没有任何一个按钮能让他拿到视频**——设计
 * 产物（`curriculum_unit.deckDesign` → `stageId`）是断的。
 *
 * 这个面板把那段路接上，规则和别处一致：
 *
 * 1. **门禁先跑，且不由前端判断。** `units/[id]/generate` 在服务端重新评估整份
 *    设计；这里的 `exportable` 只是用来**提前说明为什么按钮是灰的**，不是授权。
 *    两者可能不一致（用户在别处改了设计），所以按钮的可用性不承担正确性。
 * 2. **禁用必须给理由。** 灰掉的生成按钮旁必须有门禁给的那句话，行内展示。
 * 3. **导出以 stage 为单位。** 批量队列那条路要求课程先有"批量项"，而设计直接
 *    产出课堂没有批量项；导出 worker 只认 `stage_id`，所以这里按 stage 入队。
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  Download,
  ExternalLink,
  Loader2,
  RefreshCw,
  Rocket,
  Video,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { CurriculumDesignSnapshot, CurriculumUnitRecord } from '@/lib/curriculum/design-types';
import {
  patchCurriculumExportJob,
  requestExportJson,
  useCurriculumExportWorker,
} from '@/lib/curriculum/export-worker';
import { outlineItems } from '@/lib/curriculum/outline-items';
import type { CurriculumExportJobRecord, CurriculumExportJobStatus } from '@/lib/curriculum/types';
import { useI18n } from '@/lib/hooks/use-i18n';

interface DesignProducePanelProps {
  taskId: string;
  /** Bumped by the shell after any write, so this panel re-reads the design. */
  version: number;
  onChanged: () => Promise<void> | void;
}

interface GateState {
  exportable: boolean;
  blockers: string[];
}

/** 一个条目正在跑的那次生成。`stageId` 由 run 回包带来，不落在这里。 */
interface ItemRun {
  runId: string;
  state: string;
  step: string | null;
  stageId: string | null;
}

const ACTIVE_STATES = new Set(['queued', 'running', 'paused', 'countdown']);

const ROLE_LABELS: Record<string, string> = {
  lecture: '讲课',
  practice: '练习',
  exam: '考试',
};

/**
 * 角色决定生成什么。这张表是**文案**，不是规则：真正的 sceneTypes 由服务端的
 * `unitRoleSceneTypes` 决定，两者不一致时以服务端为准。写在这里是为了让作者在
 * 点之前知道会得到什么。
 */
const ROLE_OUTPUT_LABELS: Record<string, string> = {
  lecture: '幻灯片课程',
  practice: '带引导的练习',
  exam: '不带提示的考核',
};

const EXPORT_STATUS_LABELS: Record<CurriculumExportJobStatus, string> = {
  queued: '排队中',
  building: '构建中',
  submitting: '提交中',
  rendering: '渲染中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
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

export function DesignProducePanel({ taskId, version, onChanged }: DesignProducePanelProps) {
  const { locale } = useI18n();
  const [units, setUnits] = useState<CurriculumUnitRecord[]>([]);
  const [gate, setGate] = useState<GateState | null>(null);
  const [jobs, setJobs] = useState<CurriculumExportJobRecord[]>([]);
  const [runs, setRuns] = useState<Record<string, ItemRun>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  const stageIds = useMemo(
    () => units.map((unit) => unit.stageId).filter((id): id is string => Boolean(id)),
    [units],
  );
  // 依赖的是 stage id 的集合而不是数组本身：`units` 每次读取都是新数组，直接
  // 依赖它会让下面的回调每次都换身份，进而让"读取 → setState → 回调换身份 →
  // 再读取"变成一个不会停的循环。
  const stageKey = stageIds.join(',');

  const loadDesign = useCallback(async () => {
    const [snapshot, gatePayload] = await Promise.all([
      requestJson<CurriculumDesignSnapshot>(`/api/curriculum/design/tasks/${taskId}`),
      requestJson<GateState>(`/api/curriculum/design/tasks/${taskId}/export-gate`),
    ]);
    setUnits(snapshot.units ?? []);
    setGate({ exportable: gatePayload.exportable === true, blockers: gatePayload.blockers ?? [] });
  }, [taskId]);

  const loadJobs = useCallback(async () => {
    const query = stageKey ? `?stageIds=${encodeURIComponent(stageKey)}` : '';
    const payload = await requestJson<{ jobs: CurriculumExportJobRecord[] }>(
      `/api/curriculum/export-jobs${query}`,
    );
    setJobs(payload.jobs ?? []);
  }, [stageKey]);

  const load = useCallback(async () => {
    setBusy('load');
    setError(null);
    try {
      await Promise.all([loadDesign(), loadJobs()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
      setBusy(null);
    }
  }, [loadDesign, loadJobs]);

  useEffect(() => {
    void load();
    // `version` is in the dependency list on purpose: the shell bumps it after
    // every write in either half, and a design edit changes the gate.
  }, [load, version]);

  /**
   * 生成一个条目。
   *
   * 这里直接把失败抛到页面错误条：`units/[id]/generate` 的门禁拒绝（409）和
   * 并发上限（429）都是**用户能处理的状态**，不是"系统坏了"，所以原文照传。
   */
  const generate = useCallback(
    async (unitId: string) => {
      setBusy(`generate:${unitId}`);
      setError(null);
      try {
        const payload = await requestJson<{
          run: { id: string; state: string; step: string | null; stageId: string | null };
        }>(`/api/curriculum/design/tasks/${taskId}/units/${unitId}/generate`, { method: 'POST' });
        setRuns((current) => ({
          ...current,
          [unitId]: {
            runId: payload.run.id,
            state: payload.run.state,
            step: payload.run.step,
            stageId: payload.run.stageId,
          },
        }));
        await Promise.all([loadDesign(), onChanged()]);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [loadDesign, onChanged, taskId],
  );

  // Follow every started run until it produces a stage or stops moving. The
  // item's `stageId` arrives from the run, not from this panel: the generation
  // hook writes it when the first scene commits.
  useEffect(() => {
    const live = Object.entries(runs).filter(([, run]) => ACTIVE_STATES.has(run.state));
    if (live.length === 0) return;
    const timer = window.setInterval(() => {
      for (const [unitId, run] of live) {
        void (async () => {
          try {
            const payload = await requestJson<{
              run: { id: string; state: string; step: string | null; stageId: string | null };
            }>(`/api/generation-runs/${run.runId}`);
            setRuns((current) => ({
              ...current,
              [unitId]: {
                runId: run.runId,
                state: payload.run.state,
                step: payload.run.step,
                stageId: payload.run.stageId,
              },
            }));
            if (!ACTIVE_STATES.has(payload.run.state)) await loadDesign();
          } catch {
            // A run that cannot be read right now is still running as far as
            // this panel is concerned; the next tick settles it.
          }
        })();
      }
    }, 4000);
    return () => window.clearInterval(timer);
  }, [loadDesign, runs]);

  const worker = useCurriculumExportWorker({ jobs, onChanged: loadJobs, locale });
  const { runWorker, enabled: workerEnabled, busy: workerBusy, error: workerError } = worker;
  const hasQueueWork = jobs.some(
    (job) =>
      job.status === 'queued' ||
      job.status === 'building' ||
      job.status === 'submitting' ||
      job.status === 'rendering',
  );
  // 依赖拆到具体的函数与布尔值上，不用整个 `worker` 对象：那个对象每次渲染都是
  // 新的，拿它当依赖会让这个 effect 每次都跑，`runWorker` 又会在里面 setState。
  useEffect(() => {
    if (workerEnabled && hasQueueWork) void runWorker();
  }, [hasQueueWork, runWorker, workerEnabled]);

  const jobByStage = useMemo(() => {
    const map = new Map<string, CurriculumExportJobRecord>();
    for (const job of jobs) {
      const previous = map.get(job.stageId);
      if (!previous || job.createdAt > previous.createdAt) map.set(job.stageId, job);
    }
    return map;
  }, [jobs]);

  /**
   * 按 stage 入队一条导出。已有一条在跑的会被服务端直接返回，不会重复排队。
   *
   * **stage id 是参数，不是从 `unit.stageId` 现读的。** 这一行界面上显示的 stage
   * 可能来自刚跑完的那次 run（`unit.stageId ?? run.stageId`），而 `unit` 是上一次
   * 读取快照的结果——生成 hook 还没把 `stage_id` 写回库里。第一版在这里现读
   * `unit.stageId`，于是"生成完了、按钮亮了、点下去什么也没发生"：界面看到的和
   * 发出去的是两个来源。这个 bug 只有 e2e 读队列时才会现形。
   */
  const exportStage = useCallback(
    async (stageId: string, title: string) => {
      setBusy(`export:${stageId}`);
      setError(null);
      try {
        await requestExportJson('/api/curriculum/export-jobs', {
          method: 'POST',
          body: JSON.stringify({
            stageIds: [stageId],
            stageTitle: title,
            resolution: '1080p',
            fps: 30,
            quality: 'standard',
            burnInSubtitles: false,
          }),
        });
        await loadJobs();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [loadJobs],
  );

  const cancelJob = useCallback(
    async (job: CurriculumExportJobRecord) => {
      setBusy(`cancel:${job.id}`);
      setError(null);
      try {
        await patchCurriculumExportJob(job.id, { action: 'cancel' });
        await loadJobs();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setBusy(null);
      }
    },
    [loadJobs],
  );

  const items = useMemo(() => outlineItems(units), [units]);
  const producedCount = stageIds.length;
  // 门禁的那句话只在这里算一次：灰按钮的 title、行内说明和顶部横幅必须同源，
  // 否则同一份阻塞会在页面上出现三种说法。
  const gateReason = gate && !gate.exportable ? (gate.blockers[0] ?? '设计还没通过审核') : null;

  if (!loaded) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
        <Loader2 className="size-4 animate-spin" />
        正在读这一目的出片状态…
      </div>
    );
  }

  return (
    <Card className="mx-6 my-6" aria-label="生成与导出" data-testid="produce-panel">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Rocket className="size-4" />
          生成与导出
          <Badge variant="outline" className="px-1.5 py-0 text-[10px]">
            {producedCount}/{items.length} 已出课
          </Badge>
        </CardTitle>
        <CardDescription>
          每个条目按自己的角色生成：讲课出幻灯片课程，练习带引导，考核不给提示。生成之后在这里直接导出
          MP4，不需要再去旧台账。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {gateReason ? (
          <div className="border-amber-500/40 bg-amber-500/5 flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-600" />
            <div className="min-w-0">
              <div className="font-medium">现在还不能生成：设计审核没过</div>
              <ul className="text-muted-foreground mt-1 flex list-disc flex-col gap-0.5 pl-4">
                {gate?.blockers.slice(0, 5).map((blocker) => (
                  <li key={blocker}>{blocker}</li>
                ))}
                {(gate?.blockers.length ?? 0) > 5 ? (
                  <li>还有 {gate!.blockers.length - 5} 条…</li>
                ) : null}
              </ul>
            </div>
          </div>
        ) : null}

        {error || workerError ? (
          <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-xs">
            {error ?? workerError}
          </div>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy !== null}>
            {busy === 'load' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新出片状态
          </Button>
          <span className="text-muted-foreground text-xs">
            {hasQueueWork ? '导出队列处理中…（保持本页打开）' : '导出队列空闲'}
          </span>
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={workerEnabled}
              onChange={(event) => worker.setEnabled(event.target.checked)}
            />
            浏览器导出工作器
          </label>
        </div>

        <div className="flex flex-col gap-2">
          {items.map(({ chapterTitle, unit }) => {
            const run = runs[unit.id];
            const running = run ? ACTIVE_STATES.has(run.state) : false;
            const stageId = unit.stageId ?? run?.stageId ?? null;
            const job = stageId ? jobByStage.get(stageId) : undefined;
            /**
             * 服务端把"已有未失败任务"的 stage 原样返回、不新建任务（入队是幂等
             * 的），所以这里**不能**给一个已经导出成功的条目再放一个"重新导出"
             * 按钮：按下去会静默无操作。要重导就先取消旧任务。
             */
            const jobBlocksEnqueue =
              job !== undefined && job.status !== 'failed' && job.status !== 'cancelled';
            const generating = busy === `generate:${unit.id}` || running;
            return (
              <div
                key={unit.id}
                className="border-border flex flex-col gap-2 rounded-lg border p-3"
                data-testid={`produce-item-${unit.id}`}
              >
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge variant="outline" className="px-1 py-0 text-[10px]">
                    {ROLE_LABELS[unit.unitRole ?? ''] ?? unit.unitRole ?? '无角色'}
                  </Badge>
                  {unit.code ? (
                    <span className="text-muted-foreground font-mono text-[10px]">{unit.code}</span>
                  ) : null}
                  <span className="text-sm font-medium">{unit.title}</span>
                  {chapterTitle ? (
                    <span className="text-muted-foreground text-[11px]">属于 {chapterTitle}</span>
                  ) : null}
                </div>

                <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                  <span>
                    将生成：
                    {ROLE_OUTPUT_LABELS[unit.unitRole ?? 'lecture'] ?? '按角色决定'}
                    {unit.unitRole === 'lecture' && (unit.deckDesign?.pages?.length ?? 0) > 0
                      ? ` · 已规划 ${unit.deckDesign.pages?.length ?? 0} 页`
                      : ''}
                  </span>
                  {run ? (
                    <span className="font-mono">
                      run {run.runId} · {run.state}
                      {run.step ? ` · ${run.step}` : ''}
                    </span>
                  ) : null}
                  {job ? (
                    <span data-testid={`export-status-${unit.id}`}>
                      导出：{EXPORT_STATUS_LABELS[job.status]}
                      {job.error?.message ? `（${job.error.message}）` : ''}
                    </span>
                  ) : null}
                </div>

                {job && job.status !== 'succeeded' && job.status !== 'cancelled' ? (
                  <div className="bg-muted h-1.5 overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full transition-[width]"
                      style={{ width: `${Math.round((job.progress || 0) * 100)}%` }}
                    />
                  </div>
                ) : null}

                <div className="flex flex-wrap items-center gap-2">
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
                    disabled={busy !== null || generating || !unit.unitRole || gateReason !== null}
                    title={gateReason ?? undefined}
                    onClick={() => void generate(unit.id)}
                  >
                    {generating ? <Loader2 className="animate-spin" /> : <Rocket />}
                    {stageId ? '重新生成' : '生成'}
                  </Button>
                  {stageId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy !== null || jobBlocksEnqueue}
                      title={
                        jobBlocksEnqueue
                          ? '这一目已经有一条导出任务了。要重新导出，先取消它。'
                          : undefined
                      }
                      onClick={() => void exportStage(stageId, unit.title)}
                    >
                      <Video />
                      {jobBlocksEnqueue ? '已排队导出' : '导出 MP4'}
                    </Button>
                  ) : null}
                  {job?.status === 'succeeded' && job.renderJobId ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={workerBusy !== null}
                      onClick={() => void worker.download(job)}
                    >
                      <Download />
                      下载
                    </Button>
                  ) : null}
                  {job &&
                  job.status !== 'succeeded' &&
                  job.status !== 'cancelled' &&
                  job.status !== 'failed' ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy !== null}
                      onClick={() => void cancelJob(job)}
                    >
                      取消
                    </Button>
                  ) : null}
                  {!unit.unitRole ? (
                    <span className="text-muted-foreground text-[11px]">
                      这是一个章节，不承载教学角色，所以没有可生成的内容。
                    </span>
                  ) : null}
                </div>
              </div>
            );
          })}
          {items.length === 0 ? (
            <p className="text-muted-foreground border-border rounded-lg border border-dashed p-6 text-center text-xs">
              这一目还没有条目。先在「设计编辑器」的第 ④ 步把大纲写出来。
            </p>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
