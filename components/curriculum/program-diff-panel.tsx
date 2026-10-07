'use client';

import { useEffect, useMemo, useState } from 'react';
import { ArrowRightLeft, GitCompare, Loader2, RefreshCw, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import {
  buildProgramVersionDiff,
  type ProgramCourseDiff,
  type ProgramCourseSupportDiff,
  type ProgramCourseValue,
  type ProgramDiffChangeType,
  type ProgramDiffFieldChange,
  type ProgramDiffValue,
  type ProgramIndicatorDiff,
  type ProgramIndicatorValue,
  type ProgramSupportValue,
} from '@/lib/curriculum/program-diff';
import type {
  CurriculumProgramCourseCategory,
  CurriculumProgramRecord,
  CurriculumProgramVersionRecord,
  CurriculumSnapshot,
} from '@/lib/curriculum/types';

interface ProgramDiffPanelProps {
  snapshot: CurriculumSnapshot;
  onChanged: () => Promise<void> | void;
}

interface VersionGroup {
  program: CurriculumProgramRecord;
  versions: CurriculumProgramVersionRecord[];
}

const CATEGORY_LABELS: Record<CurriculumProgramCourseCategory, string> = {
  required: '必修',
  elective: '选修',
  practice: '实践',
  general: '通识',
};

const CHANGE_LABELS: Record<ProgramDiffChangeType, string> = {
  added: '新增',
  removed: '删除',
  changed: '修改',
};

function changeClass(change: ProgramDiffChangeType): string {
  if (change === 'added') return 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700';
  if (change === 'removed') return 'border-destructive/40 bg-destructive/10 text-destructive';
  return 'border-amber-500/40 bg-amber-500/10 text-amber-700';
}

function formatValue(value: ProgramDiffValue): string {
  if (value === null) return '空';
  return String(value);
}

function formatVersion(version: CurriculumProgramVersionRecord): string {
  return [version.name, version.version, version.gradeYear].filter(Boolean).join(' · ');
}

function indicatorSummary(value: ProgramIndicatorValue | null): string {
  if (!value) return '';
  return `${value.code} · ${value.title} · 目标权重 ${value.targetWeight} · 排序 ${value.sortOrder}`;
}

function courseSummary(value: ProgramCourseValue | null): string {
  if (!value) return '';
  return [
    value.code,
    value.semester,
    CATEGORY_LABELS[value.category],
    value.credits !== null ? `${value.credits} 学分` : null,
    value.hours !== null ? `${value.hours} 学时` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function supportSummary(value: ProgramSupportValue | null): string {
  if (!value) return '';
  return `${value.indicatorCode} · 权重 ${value.weight}${value.note ? ` · ${value.note}` : ''}`;
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

function ChangeBadge({ change }: { change: ProgramDiffChangeType }) {
  return (
    <span
      className={`inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 text-[11px] font-medium ${changeClass(change)}`}
    >
      {CHANGE_LABELS[change]}
    </span>
  );
}

function FieldChanges({ fields }: { fields: ProgramDiffFieldChange[] }) {
  if (fields.length === 0) return null;
  return (
    <div className="text-muted-foreground flex flex-col gap-0.5 text-xs">
      {fields.map((field) => (
        <div key={field.field}>
          <span className="font-medium text-foreground">{field.label}</span>
          {'：'}
          <span className="line-through">{formatValue(field.before)}</span>
          {' → '}
          <span className="text-emerald-700">{formatValue(field.after)}</span>
        </div>
      ))}
    </div>
  );
}

function IndicatorDiffRow({ item }: { item: ProgramIndicatorDiff }) {
  return (
    <div className="border-border flex flex-col gap-1.5 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">
            {item.code} · {item.title}
          </div>
          {item.change !== 'changed' ? (
            <div className="text-muted-foreground mt-0.5 text-xs">
              {item.change === 'added'
                ? indicatorSummary(item.after)
                : indicatorSummary(item.before)}
            </div>
          ) : null}
        </div>
        <ChangeBadge change={item.change} />
      </div>
      <FieldChanges fields={item.fields} />
    </div>
  );
}

function SupportDiffRow({ item }: { item: ProgramCourseSupportDiff }) {
  return (
    <div className="border-border/70 rounded border px-2 py-1.5 text-xs">
      <div className="flex items-start justify-between gap-2">
        <span>
          {item.indicatorCode} · {item.indicatorTitle}
        </span>
        <ChangeBadge change={item.change} />
      </div>
      {item.change !== 'changed' ? (
        <div className="text-muted-foreground mt-0.5">
          {supportSummary(item.change === 'added' ? item.after : item.before)}
        </div>
      ) : (
        <FieldChanges fields={item.fields} />
      )}
    </div>
  );
}

function CourseDiffRow({ item }: { item: ProgramCourseDiff }) {
  return (
    <div className="border-border flex flex-col gap-2 rounded-md border px-3 py-2 text-sm">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="truncate font-medium">{item.title}</div>
          {item.change !== 'changed' ? (
            <div className="text-muted-foreground mt-0.5 text-xs">
              {item.change === 'added' ? courseSummary(item.after) : courseSummary(item.before)}
            </div>
          ) : null}
        </div>
        <ChangeBadge change={item.change} />
      </div>
      <FieldChanges fields={item.fields} />
      {item.supports.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <div className="text-muted-foreground text-xs font-medium">指标点支撑变化</div>
          {item.supports.map((support) => (
            <SupportDiffRow key={support.key} item={support} />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ProgramDiffPanel({ snapshot, onChanged }: ProgramDiffPanelProps) {
  const [baseVersionId, setBaseVersionId] = useState('');
  const [targetVersionId, setTargetVersionId] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const versionGroups = useMemo(() => {
    const groups = new Map<string, VersionGroup>();
    for (const program of snapshot.programs) {
      groups.set(program.id, { program, versions: [] });
    }
    for (const version of snapshot.programVersions) {
      const group = groups.get(version.programId);
      if (group) group.versions.push(version);
    }
    return [...groups.values()]
      .map((group) => ({
        ...group,
        versions: [...group.versions].sort((left, right) =>
          formatVersion(left).localeCompare(formatVersion(right), 'zh-CN'),
        ),
      }))
      .sort((left, right) => left.program.name.localeCompare(right.program.name, 'zh-CN'));
  }, [snapshot.programs, snapshot.programVersions]);

  useEffect(() => {
    const ids = versionGroups.flatMap((group) => group.versions.map((version) => version.id));
    if (ids.length === 0) {
      setBaseVersionId('');
      setTargetVersionId('');
      return;
    }
    setBaseVersionId((current) => (ids.includes(current) ? current : ids[0]));
    setTargetVersionId((current) => {
      if (ids.includes(current)) return current;
      return ids.find((id) => id !== ids[0]) ?? ids[0];
    });
  }, [versionGroups]);

  const report = useMemo(() => {
    if (!baseVersionId || !targetVersionId) return null;
    return buildProgramVersionDiff(snapshot, baseVersionId, targetVersionId);
  }, [snapshot, baseVersionId, targetVersionId]);

  const baseVersion = snapshot.programVersions.find((version) => version.id === baseVersionId);
  const targetVersion = snapshot.programVersions.find((version) => version.id === targetVersionId);

  const swap = () => {
    setBaseVersionId(targetVersionId);
    setTargetVersionId(baseVersionId);
  };

  const sync = async () => {
    if (!baseVersion || !targetVersion) return;
    if (baseVersion.id === targetVersion.id) {
      setError('请选择两个不同的培养方案版本。');
      return;
    }
    if (
      !window.confirm(
        `以“${formatVersion(baseVersion)}”同步到“${formatVersion(targetVersion)}”？\n` +
          '目标版本的指标点、计划课程和支撑矩阵会被重写；版本名称、版号、年级、状态和目标学分保留。',
      )
    ) {
      return;
    }
    setBusy('sync');
    setError(null);
    setNotice(null);
    try {
      await requestJson('/api/curriculum/program-versions/sync', {
        method: 'POST',
        body: JSON.stringify({
          sourceVersionId: baseVersion.id,
          targetVersionId: targetVersion.id,
        }),
      });
      setNotice('培养方案内容已同步：指标点、计划课程和支撑矩阵已按基准版重写。');
      await onChanged();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const refresh = async () => {
    setBusy('refresh');
    setError(null);
    setNotice(null);
    try {
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
          <GitCompare className="size-4" />
          培养方案版本对比与同步
        </CardTitle>
        <CardDescription>
          比较两个培养方案版本的指标点、计划课程和支撑矩阵；同步会以基准版内容重写目标版，目标版本元数据保留。
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {error ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700">
            {notice}
          </div>
        ) : null}

        {versionGroups.length === 0 ? (
          <p className="text-muted-foreground py-4 text-center text-sm">
            尚无培养方案版本，请先在上方创建。
          </p>
        ) : (
          <>
            <div className="border-border flex flex-col gap-3 rounded-lg border bg-muted/20 p-3">
              <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]">
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    基准版（来源）
                  </label>
                  <select
                    className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                    value={baseVersionId}
                    onChange={(event) => setBaseVersionId(event.target.value)}
                    disabled={busy !== null}
                  >
                    {versionGroups.map((group) => (
                      <optgroup key={group.program.id} label={group.program.name}>
                        {group.versions.map((version) => (
                          <option key={version.id} value={version.id}>
                            {formatVersion(version)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
                <div className="flex items-end justify-center">
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={swap}
                    disabled={busy !== null || !baseVersionId || !targetVersionId}
                    title="交换方向"
                  >
                    <ArrowRightLeft />
                  </Button>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">
                    目标版（当前）
                  </label>
                  <select
                    className="border-input h-9 rounded-md border bg-transparent px-2.5 text-sm"
                    value={targetVersionId}
                    onChange={(event) => setTargetVersionId(event.target.value)}
                    disabled={busy !== null}
                  >
                    {versionGroups.map((group) => (
                      <optgroup key={group.program.id} label={group.program.name}>
                        {group.versions.map((version) => (
                          <option key={version.id} value={version.id}>
                            {formatVersion(version)}
                          </option>
                        ))}
                      </optgroup>
                    ))}
                  </select>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-muted-foreground text-xs">
                  同步只应用内容：指标点、计划课程和支撑矩阵；目标版本的名称、版号、年级、状态和目标学分不会被覆盖。
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void refresh()}
                    disabled={busy !== null}
                  >
                    {busy === 'refresh' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
                    刷新快照
                  </Button>
                  <Button
                    size="sm"
                    onClick={() => void sync()}
                    disabled={
                      busy !== null ||
                      !report ||
                      baseVersionId === targetVersionId ||
                      report.summary.totalChangeCount === 0
                    }
                  >
                    {busy === 'sync' ? <Loader2 className="animate-spin" /> : <Save />}
                    以基准版同步到目标版
                  </Button>
                </div>
              </div>
            </div>

            {!report ? (
              <p className="text-muted-foreground py-4 text-center text-sm">
                请选择两个培养方案版本。
              </p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="border-border rounded border px-2 py-1">
                    指标点
                    <span className="ml-1 font-medium">
                      +{report.summary.indicatorAddedCount} / -
                      {report.summary.indicatorRemovedCount} / ~
                      {report.summary.indicatorChangedCount}
                    </span>
                  </span>
                  <span className="border-border rounded border px-2 py-1">
                    课程
                    <span className="ml-1 font-medium">
                      +{report.summary.courseAddedCount} / -{report.summary.courseRemovedCount} / ~
                      {report.summary.courseChangedCount}
                    </span>
                  </span>
                  <span className="border-border rounded border px-2 py-1">
                    支撑关系
                    <span className="ml-1 font-medium">
                      +{report.summary.supportAddedCount} / -{report.summary.supportRemovedCount} /
                      ~{report.summary.supportChangedCount}
                    </span>
                  </span>
                  <span className="border-border rounded border px-2 py-1">
                    总变化 <span className="font-medium">{report.summary.totalChangeCount}</span>
                  </span>
                </div>

                <div className="border-border rounded-lg border p-3">
                  <div className="text-sm font-medium">版本元数据</div>
                  {report.version.fields.length > 0 ? (
                    <div className="mt-2">
                      <FieldChanges fields={report.version.fields} />
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">无变化</p>
                  )}
                </div>

                <div className="border-border rounded-lg border p-3">
                  <div className="text-sm font-medium">指标点变化</div>
                  {report.indicators.length > 0 ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {report.indicators.map((item) => (
                        <IndicatorDiffRow key={item.key} item={item} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">无变化</p>
                  )}
                </div>

                <div className="border-border rounded-lg border p-3">
                  <div className="text-sm font-medium">课程与支撑变化</div>
                  {report.courses.length > 0 ? (
                    <div className="mt-2 flex flex-col gap-2">
                      {report.courses.map((item) => (
                        <CourseDiffRow key={item.key} item={item} />
                      ))}
                    </div>
                  ) : (
                    <p className="text-muted-foreground mt-1 text-xs">无变化</p>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
