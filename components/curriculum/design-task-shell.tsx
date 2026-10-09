'use client';

/**
 * `/curriculum/design/[id]` — the two halves of one design.
 *
 * The matrix answers "for each outcome, is it taught, trained and checked, and by
 * which item". The workbench answers "change that". They are tabs on one screen
 * rather than two screens because they are two views of the same read: an author
 * working in the editor needs to see the matrix move, and a reader looking at a
 * gap needs to reach the control that closes it. Splitting them across routes is
 * how the gap and the fix end up separated by a page load.
 *
 * This component owns the phase, because both halves need it and neither may
 * fetch it independently — two copies disagree for exactly as long as an advance
 * takes to propagate, and that disagreement surfaces as a 409 the author did not
 * cause. The header comment used to say the editor simply trusted this prop; the
 * live walk found that was wrong, and the reasoning is below where the read
 * happens.
 */

import { useCallback, useEffect, useState } from 'react';
import { ArrowRight, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DesignHeatmap } from '@/components/curriculum/design-heatmap';
import { DesignWorkbench } from '@/components/curriculum/design-workbench';
import type { CurriculumDesignPhase } from '@/lib/curriculum/design-types';

export interface DesignTaskShellProps {
  taskId: string;
  /** The phase at first render, so the screen is correct before any fetch. */
  initialPhase?: CurriculumDesignPhase | null;
}

const PHASE_LABELS: Record<CurriculumDesignPhase, string> = {
  task: '课程任务',
  outcomes: '学习成果',
  graph: '依赖图',
  outline: '课程大纲',
  teaching: '教学设计',
  assessment: '评价设计',
  review: '课程审核',
};

/** What `GET /phase` answers: where the design is, and what is still missing. */
interface PhaseState {
  phase: CurriculumDesignPhase;
  nextPhase: CurriculumDesignPhase | null;
  gaps: string[];
  readyToAdvance: boolean;
}

/**
 * The phase, held above both halves.
 *
 * The editor's own 刷新 button once re-read the snapshot but not the phase,
 * because the phase arrived as a prop and props are not re-fetched. The result
 * was a task advanced from anywhere but the editor staying permanently gated: a
 * create button that could never open, with no control on the screen able to
 * un-gate it. The live walk is the only thing that found that — the type check
 * passed, the unit suite passed, and the editor still could not be used.
 *
 * So every shared refresh re-reads the phase too. That makes either half reaching
 * for a refresh re-gate both, which is what "they share one read" has to mean
 * when one of them can change the thing they share.
 *
 * `version` is a counter rather than a payload because neither half needs the
 * other's data: both re-read the snapshot themselves. What they must share is
 * *that* something changed, and a counter cannot go stale in the way a cached
 * snapshot can after an advance the parent missed.
 */
export function DesignTaskShell({ taskId, initialPhase }: DesignTaskShellProps) {
  const [phase, setPhase] = useState<CurriculumDesignPhase | null>(initialPhase ?? null);
  const [version, setVersion] = useState(0);
  const [phaseState, setPhaseState] = useState<PhaseState | null>(null);
  const [advancing, setAdvancing] = useState(false);
  const [advanceError, setAdvanceError] = useState<string | null>(null);

  /**
   * Read where the design is, and what the next phase still needs.
   *
   * This used to live inside the matrix, which is why the only control that
   * moves the design forward sat on the tab an author is *not* working in: every
   * phase boundary meant switching to the matrix, advancing, and switching back.
   * The state is read here now and the control is rendered above both tabs, so
   * the button is reachable from wherever the work is happening.
   *
   * A failed phase read is deliberately silent. Every write in either half
   * already reports its own error, and leaving the gate on the last known phase
   * is the safe direction to fail: the store would refuse the write anyway, and
   * a wrong "you may create this" would be worse than a stale one.
   */
  const readPhase = useCallback(async () => {
    try {
      const response = await fetch(`/api/curriculum/design/tasks/${taskId}/phase`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as Partial<PhaseState>;
      if (!payload.phase) return;
      setPhase(payload.phase);
      setPhaseState({
        phase: payload.phase,
        nextPhase: payload.nextPhase ?? null,
        gaps: payload.gaps ?? [],
        readyToAdvance: payload.readyToAdvance === true,
      });
    } catch {
      // A navigation or an offline moment: keep the last known phase.
    }
  }, [taskId]);

  useEffect(() => {
    void readPhase();
  }, [readPhase]);

  /** Bump both halves, then re-read the phase. */
  const reload = useCallback(async () => {
    setVersion((current) => current + 1);
    await readPhase();
  }, [readPhase]);

  /**
   * Advance one phase.
   *
   * The button is enabled exactly when the move will succeed, and when it is
   * not, `gaps` says what is missing instead of the click arriving as a 409. The
   * POST still re-checks, because the design can change between read and click.
   */
  const advancePhase = useCallback(async () => {
    setAdvancing(true);
    setAdvanceError(null);
    try {
      const response = await fetch(`/api/curriculum/design/tasks/${taskId}/phase`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        throw new Error(payload?.error?.message ?? `推进阶段失败：HTTP ${response.status}`);
      }
      await reload();
    } catch (caught) {
      setAdvanceError(caught instanceof Error ? caught.message : '推进阶段失败');
    } finally {
      setAdvancing(false);
    }
  }, [reload, taskId]);

  return (
    <Tabs defaultValue="matrix" className="w-full">
      <div className="mx-6 mt-6 flex flex-wrap items-start justify-between gap-3">
        <TabsList>
          <TabsTrigger value="matrix">目标闭环矩阵</TabsTrigger>
          <TabsTrigger value="editor">设计编辑器</TabsTrigger>
        </TabsList>
        {phaseState && phaseState.nextPhase ? (
          <div className="flex flex-col items-end gap-1">
            <Button
              size="sm"
              onClick={() => void advancePhase()}
              disabled={advancing || !phaseState.readyToAdvance}
              title={
                phaseState.readyToAdvance
                  ? `进入${PHASE_LABELS[phaseState.nextPhase]}阶段`
                  : phaseState.gaps.join('；')
              }
            >
              {advancing ? <Loader2 className="animate-spin" /> : <ArrowRight />}
              进入{PHASE_LABELS[phaseState.nextPhase]}
            </Button>
            {!phaseState.readyToAdvance && phaseState.gaps.length > 0 ? (
              <span className="text-muted-foreground max-w-md text-right text-[11px]">
                还差：{phaseState.gaps.join('；')}
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
      {advanceError ? (
        <div className="border-destructive/40 bg-destructive/5 text-destructive mx-6 mt-3 rounded-lg border p-3 text-xs">
          {advanceError}
        </div>
      ) : null}
      <TabsContent value="matrix">
        <DesignHeatmap
          taskId={taskId}
          version={version}
          onPhaseChange={setPhase}
          onChanged={reload}
        />
      </TabsContent>
      <TabsContent value="editor">
        {phase === null ? (
          <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
            <Loader2 className="size-4 animate-spin" />
            正在读取课程阶段…
          </div>
        ) : (
          // Not keyed on `version`. Remounting on every refresh was tried and
          // reverted: it discards the editor's staged coverage edits and its
          // confirmation banner along with the stale data, so saving a row
          // erased the "已保存" the author needed to see. Staged coverage is
          // discarded inside the editor's own `load`, which is where the new
          // snapshot actually arrives.
          //
          // `version` is passed rather than only read here because the editor
          // must re-read through `load`, not remount. The sentence above ("both
          // halves re-read the snapshot themselves") was false without it: the
          // editor fetched once on mount, so a unit or outcome created anywhere
          // but inside the editor stayed invisible to it after a refresh. The
          // phase moved — the gate opened — while the form's selects stayed
          // empty, which is a control that opens and then offers nothing. The
          // live walk for the hands-on-task form is what found it.
          <DesignWorkbench taskId={taskId} phase={phase} version={version} onChanged={reload} />
        )}
      </TabsContent>
    </Tabs>
  );
}
