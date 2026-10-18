'use client';

/**
 * The outcome × item heat matrix.
 *
 * This is the screen the whole reverse-design model exists to make possible.
 * Every other course view answers "what is in this course"; this one answers
 * "for each thing the learner must be able to do, is it taught, trained, and
 * checked, and by which item" — the question the old single `coverage_level`
 * enum could not express, because it collapsed those three into one value.
 *
 * A row is an outcome, a column is a teaching item, and a cell carries up to
 * three marks: 教 (taught), 练 (practised), 考 (assessed). A row with all three
 * is closed, and the count of closed rows over total rows is the single number
 * under the title — the number the export gate refuses to proceed without.
 *
 * Gaps are listed worst-first rather than in outline order, so the top of the
 * list is the most damaging absence: an outcome that is never assessed cannot
 * be claimed at all, which outranks one that merely lacks a second practice
 * item.
 *
 * Two separate things are shown and they are deliberately not merged. The
 * quality strip is computed live from the design on every load. The findings
 * list is what was *recorded* by the last review. They can disagree — that is
 * precisely the signal that the design changed since it was last reviewed, and
 * the button next to them is how that is resolved.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  CircleSlash,
  Loader2,
  RefreshCw,
  RotateCcw,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { StepBadge } from '@/components/curriculum/step-rail';
import type { CurriculumQualityEvaluation, CurriculumQualityLayer } from '@/lib/curriculum/audit';
import { CURRICULUM_QUALITY_LAYER_LABELS as LAYER_LABELS } from '@/lib/curriculum/quality-labels';
import type { CoverageVerdict, DesignCoverageReport } from '@/lib/curriculum/design-coverage';
import type {
  CurriculumAuditFindingRecord,
  CurriculumAuditFindingStatus,
  CurriculumDesignPhase,
  CurriculumObjectiveType,
} from '@/lib/curriculum/design-types';
import { STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';

interface SnapshotPayload {
  task: { title: string; designPhase: CurriculumDesignPhase };
  auditFindings: CurriculumAuditFindingRecord[];
}

interface CoveragePayload {
  report: DesignCoverageReport;
  verdict: CoverageVerdict;
  unitTitles: Record<string, { title: string; code: string | null; role: string | null }>;
}

interface ExportGatePayload {
  exportable: boolean;
  blockers: string[];
  quality: CurriculumQualityEvaluation;
  /** Defects the author accepted; production proceeds with them. */
  accepted?: { id: string; ruleCode: string; severity: string; message: string }[];
}

interface ReviewPayload {
  findings: CurriculumAuditFindingRecord[];
  exportable: boolean;
  quality: CurriculumQualityEvaluation;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
}

// 矩阵顶上的那枚阶段名与步骤条、卡片角标共用一张表（`STEP_WORK_NAME`）：同一目在
// 矩阵上叫「知识技能与依赖」、在步骤条上是第 3 步，用户才能把它们对上。

const OBJECTIVE_TYPE_LABELS: Record<CurriculumObjectiveType, string> = {
  knowledge: '知识',
  skill: '技能',
  competency: '能力',
  task: '任务',
};

const ROLE_LABELS: Record<string, string> = {
  lecture: '讲课',
  practice: '练习',
  exam: '考试',
};

const STATUS_LABELS: Record<CurriculumAuditFindingStatus, string> = {
  open: '待处理',
  // Only readable, never written: a review is derived, so "fixed" is not a state
  // an author can record — the defect leaves the list once the design is repaired.
  resolved: '已修复（旧数据）',
  waived: '已接受',
};

type CoverageKind = 'teach' | 'practice' | 'assess';

/** The three marks a cell can carry, in the order they are read. */
const MARKS: { kind: CoverageKind; label: string; className: string }[] = [
  { kind: 'teach', label: '教', className: 'bg-sky-500/15 text-sky-700 dark:text-sky-300' },
  {
    kind: 'practice',
    label: '练',
    className: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  },
  {
    kind: 'assess',
    label: '考',
    className: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  },
];

function missingKinds(row: DesignCoverageReport['objectives'][number]): string[] {
  const missing: string[] = [];
  if (!row.teaches) missing.push('未教');
  if (!row.practices) missing.push('未练');
  if (!row.assesses) missing.push('未考');
  return missing;
}

/**
 * The read-and-review half of the design screen.
 *
 * `onPhaseChange` is how the phase reaches the workbench: this component is the
 * only one that reads it, so the editor is re-gated by whatever the matrix last
 * saw rather than by a second, independently-fetched copy. Two copies would
 * disagree for exactly as long as a phase advance takes to propagate, and the
 * disagreement shows up as a 409 the author did not cause.
 *
 * `version` is a bump counter rather than a reload callback, so an edit in the
 * editor refreshes this half through the same path as its own save — one
 * mechanism, not two that can be wired to different things.
 */
export function DesignHeatmap({
  taskId,
  version,
  onPhaseChange,
  onChanged,
}: {
  taskId: string;
  version: number;
  onPhaseChange: (phase: CurriculumDesignPhase) => void;
  onChanged: () => Promise<void> | void;
}) {
  const [title, setTitle] = useState('');
  const [phase, setPhase] = useState<CurriculumDesignPhase | null>(null);
  const [coverage, setCoverage] = useState<CoveragePayload | null>(null);
  const [gate, setGate] = useState<ExportGatePayload | null>(null);
  const [findings, setFindings] = useState<CurriculumAuditFindingRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const base = `/api/curriculum/design/tasks/${taskId}`;

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [snapshot, coveragePayload, gatePayload] = await Promise.all([
        requestJson<SnapshotPayload>(base),
        requestJson<CoveragePayload>(`${base}/coverage`),
        requestJson<ExportGatePayload>(`${base}/export-gate`),
      ]);
      setTitle(snapshot.task.title);
      setPhase(snapshot.task.designPhase);
      setCoverage(coveragePayload);
      setGate(gatePayload);
      // What the last review recorded, which is not the same as what the
      // design currently is — see the file header.
      setFindings(snapshot.auditFindings);
      onPhaseChange(snapshot.task.designPhase);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败');
    } finally {
      setLoading(false);
    }
    // `onPhaseChange` is intentionally not a dependency: it is the shell's
    // setter, and including it would make `load` a new function on every render
    // of the parent, re-running this effect for no change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [base]);

  useEffect(() => {
    void load();
  }, [load, version]);

  /** Re-run the review and record it, so findings gain ids the status route acts on. */
  const runReview = useCallback(async () => {
    setBusy('review');
    try {
      const payload = await requestJson<ReviewPayload>(`${base}/review`, { method: 'POST' });
      setFindings(payload.findings);
      // The gate is derived from the same design, so re-read it too.
      setGate(await requestJson<ExportGatePayload>(`${base}/export-gate`));
      // A review does not change the design, but it does change the shell's
      // version, and the editor's create buttons are gated on the same snapshot
      // this read came from. Bumping keeps one refresh path for every write.
      await onChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '审核失败');
    } finally {
      setBusy(null);
    }
  }, [base, onChanged]);

  /**
   * Accept a finding, or take the acceptance back.
   *
   * There is no "mark as fixed" button: a finding is derived, so it disappears by
   * itself once the design is repaired, and a button claiming otherwise would be
   * a control that does nothing to the gate. Accepting one is a real decision —
   * it stops the defect blocking production and every export reports it — so the
   * button that exists is the one that means something, and it can be undone.
   */
  const setFindingStatus = useCallback(
    async (findingId: string, status: 'open' | 'waived') => {
      setBusy(findingId);
      try {
        const payload = await requestJson<{ finding: CurriculumAuditFindingRecord }>(
          `${base}/findings/${findingId}`,
          { method: 'PATCH', body: JSON.stringify({ status }) },
        );
        setFindings((current) =>
          current.map((finding) => (finding.id === payload.finding.id ? payload.finding : finding)),
        );
        // The gate is derived from the same decisions, so re-read it rather than
        // guessing what the acceptance did to it.
        setGate(await requestJson<ExportGatePayload>(`${base}/export-gate`));
        await onChanged();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '更新失败');
      } finally {
        setBusy(null);
      }
    },
    [base, onChanged],
  );

  /** Outcome id → which items cover it, and in which of the three ways. */
  const grid = useMemo(() => {
    if (!coverage) return null;
    return new Map<string, Record<CoverageKind, Set<string>>>(
      coverage.report.objectives.map((row) => [
        row.objectiveId,
        {
          teach: new Set(row.teach),
          practice: new Set(row.practice),
          assess: new Set(row.assess),
        },
      ]),
    );
  }, [coverage]);

  /**
   * The findings split by what they are worth to the author.
   *
   * `resolved` (a value only rows written before this step can hold) is counted
   * as open on purpose: a claim that a defect is fixed does not stop it blocking,
   * and the gate says so.
   */
  const openFindings = useMemo(
    () => findings.filter((finding) => finding.status !== 'waived'),
    [findings],
  );
  const acceptedFindings = useMemo(
    () => findings.filter((finding) => finding.status === 'waived'),
    [findings],
  );

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
        <Loader2 className="size-4 animate-spin" />
        正在加载课程设计…
      </div>
    );
  }

  if (error && !coverage) {
    return (
      <div className="border-destructive/40 bg-destructive/5 text-destructive m-6 rounded-lg border p-4 text-sm">
        {error}
      </div>
    );
  }

  if (!coverage || !gate) return null;

  const { report, verdict, unitTitles } = coverage;
  const { counts } = report;
  const percent = counts.total === 0 ? 0 : Math.round((counts.complete / counts.total) * 100);
  const itemIds = report.unitIds;

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold">{title || '课程设计'}</h1>
            {phase && <Badge variant="secondary">{STEP_WORK_NAME[phase]}</Badge>}
          </div>
          <p className="text-muted-foreground text-xs">
            目标 × 目 热力矩阵 —— 每一行是一个学习目标，看它被教、被练、被考的情况
          </p>
        </div>
        <div className="flex items-center gap-2">
          {/*
            The advance control used to live here. It moved up into the shell,
            above both tabs, because a phase boundary is not a property of the
            matrix: an author working in the editor had to switch tabs to move
            forward and switch back to keep working.
          */}
          {gate.exportable ? (
            <Badge className="bg-emerald-500/15 text-emerald-700 dark:text-emerald-300">
              <CheckCircle2 />
              可以出课
            </Badge>
          ) : (
            <Badge variant="destructive">
              <CircleSlash />
              不能出课
            </Badge>
          )}
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RotateCcw />
            刷新
          </Button>
        </div>
      </header>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border p-3 text-xs">
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">闭环进度</CardTitle>
          <CardDescription>{verdict.summary}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <Progress value={percent} />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
            {[
              { label: '学习目标', value: counts.total },
              { label: '已教', value: counts.taught },
              { label: '已练', value: counts.practiced },
              { label: '已考', value: counts.assessed },
              { label: '已闭环', value: counts.complete },
            ].map((stat) => (
              <div key={stat.label} className="border-border rounded-lg border p-3">
                <div className="text-muted-foreground text-xs">{stat.label}</div>
                <div className="text-xl font-semibold">{stat.value}</div>
              </div>
            ))}
          </div>
          {gate.blockers.length > 0 && (
            <ul className="flex flex-col gap-1">
              {gate.blockers.map((blocker) => (
                <li key={blocker} className="text-destructive flex items-start gap-2 text-xs">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {blocker}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">目标 × 目 热力矩阵</CardTitle>
          <CardDescription>空格表示该目与该目标无关；一行的教、练、考齐全才算闭环</CardDescription>
        </CardHeader>
        <CardContent>
          {report.objectives.length === 0 || itemIds.length === 0 ? (
            <p className="text-muted-foreground border-border rounded-lg border border-dashed p-6 text-center text-xs">
              {report.objectives.length === 0
                ? '还没有定义学习目标。课程设计要先确定学生最终要学会什么。'
                : '还没有课程大纲。目标与依赖关系确定后，才由它们生成目。'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-xs">
                <thead>
                  <tr>
                    <th className="bg-background sticky left-0 z-10 min-w-[16rem] px-2 py-2 text-left font-medium">
                      学习目标
                    </th>
                    {itemIds.map((unitId) => {
                      const unit = unitTitles[unitId];
                      return (
                        <th
                          key={unitId}
                          className="border-border min-w-[5.5rem] border-b px-2 py-2 align-bottom font-medium"
                          title={unit?.title ?? unitId}
                        >
                          <div className="flex flex-col items-center gap-1">
                            {unit?.role && (
                              <span className="text-muted-foreground text-[10px]">
                                {ROLE_LABELS[unit.role] ?? unit.role}
                              </span>
                            )}
                            <span className="line-clamp-3 max-w-[5.5rem] text-center leading-tight">
                              {unit?.code ?? unit?.title ?? unitId.slice(0, 8)}
                            </span>
                          </div>
                        </th>
                      );
                    })}
                    <th className="border-border min-w-[7rem] border-b px-2 py-2 text-left font-medium">
                      缺口
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {report.objectives.map((row) => {
                    const marks = grid?.get(row.objectiveId);
                    const missing = missingKinds(row);
                    return (
                      <tr key={row.objectiveId} className="group">
                        <td className="bg-background group-hover:bg-muted/40 sticky left-0 z-10 px-2 py-2">
                          <div className="flex flex-col gap-0.5">
                            <div className="flex items-center gap-1.5">
                              {row.code && (
                                <span className="text-muted-foreground font-mono text-[10px]">
                                  {row.code}
                                </span>
                              )}
                              <Badge variant="outline" className="px-1 py-0 text-[10px]">
                                {OBJECTIVE_TYPE_LABELS[row.objectiveType]}
                              </Badge>
                              {row.complete && (
                                <CheckCircle2 className="size-3.5 text-emerald-600" />
                              )}
                            </div>
                            <span className="leading-tight font-medium">{row.title}</span>
                          </div>
                        </td>
                        {itemIds.map((unitId) => {
                          const present = MARKS.filter((mark) => marks?.[mark.kind]?.has(unitId));
                          return (
                            <td
                              key={unitId}
                              className="group-hover:bg-muted/40 px-1 py-1 text-center"
                            >
                              {present.length === 0 ? (
                                <span className="text-muted-foreground/30">·</span>
                              ) : (
                                <div className="flex items-center justify-center gap-0.5">
                                  {present.map((mark) => (
                                    <span
                                      key={mark.kind}
                                      className={`inline-flex size-4 items-center justify-center rounded text-[10px] font-medium ${mark.className}`}
                                      title={`${mark.label}：${unitTitles[unitId]?.title ?? unitId}`}
                                    >
                                      {mark.label}
                                    </span>
                                  ))}
                                </div>
                              )}
                            </td>
                          );
                        })}
                        <td className="group-hover:bg-muted/40 px-2 py-2">
                          {missing.length === 0 ? (
                            <span className="text-emerald-600">已闭环</span>
                          ) : (
                            <span className="text-amber-600">{missing.join(' / ')}</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {report.gaps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">缺口（最严重在前）</CardTitle>
            <CardDescription>没有被考试验证的目标最优先——它无法被证明达成</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {report.gaps.map((row) => (
              <div
                key={row.objectiveId}
                className="border-border flex items-center justify-between gap-3 rounded-lg border p-2.5"
              >
                <div className="flex min-w-0 flex-col gap-0.5">
                  <span className="truncate text-xs font-medium">{row.title}</span>
                  <span className="text-muted-foreground text-[11px]">
                    被 {row.itemCount} 个目覆盖
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {MARKS.map((mark) => {
                    const covered =
                      mark.kind === 'teach'
                        ? row.teaches
                        : mark.kind === 'practice'
                          ? row.practices
                          : row.assesses;
                    return (
                      <span
                        key={mark.kind}
                        className={`inline-flex size-5 items-center justify-center rounded text-[10px] font-medium ${
                          covered
                            ? mark.className
                            : 'bg-muted text-muted-foreground/50 line-through'
                        }`}
                      >
                        {mark.label}
                      </span>
                    );
                  })}
                </div>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="review" currentPhase={phase} />
                课程审核
              </CardTitle>
              <CardDescription>
                九层质量链按顺序检查；修好后面的层而前面还断着，覆盖率会指向错误的东西
              </CardDescription>
            </div>
            <Button size="sm" onClick={() => void runReview()} disabled={busy === 'review'}>
              {busy === 'review' ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              运行审核
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {/* Live: computed from the current design on every load. */}
          <div className="flex flex-wrap gap-1.5">
            {(Object.keys(LAYER_LABELS) as CurriculumQualityLayer[]).map((layer) => (
              <span
                key={layer}
                className={`rounded px-1.5 py-0.5 text-[10px] ${
                  gate.quality.layers[layer]
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : 'bg-destructive/15 text-destructive'
                }`}
                title={gate.quality.firstBrokenLayer === layer ? '第一个断掉的层' : undefined}
              >
                {LAYER_LABELS[layer]}
              </span>
            ))}
          </div>

          {findings.length === 0 ? (
            <p className="text-muted-foreground text-xs">
              还没有记录审核结果。上面的质量链是实时计算的；审核结论要点「运行审核」才会记录。
            </p>
          ) : (
            <>
              {/* The two halves are read differently and are therefore counted
                  separately: an open defect blocks production, an accepted one is
                  shipping with it. One list would let the second kind read as a
                  problem that is still waiting for an answer. */}
              <p className="text-muted-foreground text-xs">
                待处理 {openFindings.length} 条（阻塞生成）
                {acceptedFindings.length > 0
                  ? ` · 已接受 ${acceptedFindings.length} 条（不阻塞，生成时会带着它们）`
                  : ''}
              </p>
              <ul className="flex flex-col gap-2">
                {findings.map((finding) => {
                  const accepted = finding.status === 'waived';
                  return (
                    <li
                      key={finding.id}
                      className={`flex items-start justify-between gap-3 rounded-lg border p-2.5 ${
                        accepted ? 'border-border/60 bg-muted/30' : 'border-border'
                      }`}
                    >
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge
                            variant={
                              accepted
                                ? 'secondary'
                                : finding.severity === 'error'
                                  ? 'destructive'
                                  : 'secondary'
                            }
                            className="px-1 py-0 text-[10px]"
                          >
                            {finding.severity}
                          </Badge>
                          <span className="text-muted-foreground font-mono text-[10px]">
                            {finding.ruleCode}
                          </span>
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            {STATUS_LABELS[finding.status]}
                          </Badge>
                        </div>
                        <span className={`text-xs ${accepted ? 'line-through opacity-70' : ''}`}>
                          {finding.message}
                        </span>
                      </div>
                      <div className="flex shrink-0 gap-1">
                        {accepted ? (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy === finding.id}
                            onClick={() => void setFindingStatus(finding.id, 'open')}
                          >
                            撤销接受
                          </Button>
                        ) : (
                          <Button
                            variant="ghost"
                            size="sm"
                            disabled={busy === finding.id}
                            onClick={() => void setFindingStatus(finding.id, 'waived')}
                          >
                            接受
                          </Button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
