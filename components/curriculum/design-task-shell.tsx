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

import { useCallback, useState } from 'react';
import { Loader2 } from 'lucide-react';

import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DesignHeatmap } from '@/components/curriculum/design-heatmap';
import { DesignWorkbench } from '@/components/curriculum/design-workbench';
import type { CurriculumDesignPhase } from '@/lib/curriculum/design-types';

export interface DesignTaskShellProps {
  taskId: string;
  /** The phase at first render, so the screen is correct before any fetch. */
  initialPhase?: CurriculumDesignPhase | null;
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

  /**
   * Bump both halves, then re-read the phase.
   *
   * A failed phase read is deliberately silent. Every write in either half
   * already reports its own error, and leaving the gate on the last known phase
   * is the safe direction to fail: the store would refuse the write anyway, and
   * a wrong "you may create this" would be worse than a stale one.
   */
  const reload = useCallback(async () => {
    setVersion((current) => current + 1);
    try {
      const response = await fetch(`/api/curriculum/design/tasks/${taskId}/phase`, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) return;
      const payload = (await response.json()) as { phase?: CurriculumDesignPhase };
      if (payload.phase) setPhase(payload.phase);
    } catch {
      // A navigation or an offline moment: keep the last known phase.
    }
  }, [taskId]);

  return (
    <Tabs defaultValue="matrix" className="w-full">
      <TabsList className="mx-6 mt-6">
        <TabsTrigger value="matrix">目标闭环矩阵</TabsTrigger>
        <TabsTrigger value="editor">设计编辑器</TabsTrigger>
      </TabsList>
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
          <DesignWorkbench taskId={taskId} phase={phase} onChanged={reload} />
        )}
      </TabsContent>
    </Tabs>
  );
}
