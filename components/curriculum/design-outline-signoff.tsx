'use client';

/**
 * 工作台里「课程大纲」的签收条：确认、撤回、打开 AI 对话。
 *
 * 与第二、三步的签收条同一副骨架、同一处位置：**嵌在那张卡片的头部**，而不是和它
 * 并排一张新卡——它们是同一份大纲的两个面。
 *
 * 一处刻意的不同：**缺口从服务端读，不在客户端算。**
 * 前两步的缺口是纯函数，客户端能算且必须算得一样；这一步的缺口里有一条是"大纲顺序与
 * 图上声明的先后关系是否矛盾"，那条判定要跨三层（节点 → 支撑的目标 → 讲授它的条目），
 * 在浏览器里再实现一遍就是第二份定义——两份定义分歧的那天，按钮说可以确认，门禁说
 * 不行。所以这里读服务器的 `gaps` 与 `auditFindings`，与门禁读的是同一份。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DesignOutlineDialog } from '@/components/curriculum/design-outline-dialog';
import {
  confirmOutline,
  readOutlineState,
  withdrawOutline,
  type OutlineStatePayload,
} from '@/lib/curriculum/outline-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

interface DesignOutlineSignOffProps {
  taskId: string;
  units: readonly CurriculumUnitRecord[];
  unitCoverage: readonly CurriculumUnitCoverageRecord[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  /** The workbench's single-write helper: error strip, notice, reload. */
  run: (key: string, work: () => Promise<string>) => Promise<void>;
  busy: string | null;
  /**
   * Re-read the design and the phase, without going through `run`.
   *
   * The dialog writes through its own routes and has no busy key to own here, so
   * routing its refresh through `run` would flash a write it did not make.
   */
  onRefresh: () => void | Promise<void>;
}

export function DesignOutlineSignOff({
  taskId,
  units,
  unitCoverage,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignOutlineSignOffProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [state, setState] = useState<OutlineStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A cheap signature of the outline itself: the strip re-reads the server's
  // verdict when the document changed, not on every parent render.
  const signature = useMemo(
    () =>
      [
        units.length,
        unitCoverage.length,
        confirmation?.confirmedAt ?? '',
        units
          .map((unit) => `${unit.id}:${unit.title}:${unit.orderIndex}:${unit.unitRole ?? ''}`)
          .join(','),
      ].join('|'),
    [unitCoverage.length, units, confirmation?.confirmedAt],
  );

  const reload = useCallback(async () => {
    try {
      setState(await readOutlineState(taskId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取课程大纲状态失败');
    }
  }, [taskId]);

  useEffect(() => {
    // Inlined rather than calling `reload` so the state lands in a promise
    // callback, not synchronously in the effect body: a synchronous setState here
    // cascades a render on every signature change. `reload` stays for the write
    // handlers, which run from events.
    let cancelled = false;
    void readOutlineState(taskId).then(
      (next) => {
        if (cancelled) return;
        setState(next);
        setError(null);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : '读取课程大纲状态失败');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, signature]);

  // While the first read is in flight the strip shows nothing rather than a
  // green "complete": a badge that appears before the verdict is a claim.
  if (state === null) {
    return error === null ? null : <p className="text-destructive text-[11px]">{error}</p>;
  }

  const blockers = [
    ...state.gaps.map((gap) => gap.text),
    ...state.auditFindings.map((finding) => finding.message),
  ];
  const complete = blockers.length === 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        {confirmation ? (
          <Badge className="gap-1">
            <Check className="size-3" />
            {confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
          </Badge>
        ) : (
          <Badge variant="outline">未确认</Badge>
        )}
        <Button
          size="sm"
          onClick={() =>
            void run('outline:confirm', async () => {
              await confirmOutline(taskId);
              await reload();
              return '课程大纲已确认。下一步是逐条的教学设计。';
            })
          }
          disabled={busy !== null || confirmation !== null || !complete}
          title={
            confirmation
              ? '已经确认'
              : !complete
                ? `还差：${blockers.join('；')}`
                : '确认课程大纲，进入教学设计阶段'
          }
        >
          {busy === 'outline:confirm' ? <Loader2 className="animate-spin" /> : <Check />}
          确认课程大纲
        </Button>
        {confirmation ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run('outline:withdraw', async () => {
                await withdrawOutline(taskId);
                await reload();
                return '已撤回确认；改完之后需要重新确认。';
              })
            }
            disabled={busy !== null}
          >
            {busy === 'outline:withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            撤回确认
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={busy !== null}
        >
          <Sparkles />用 AI 排大纲
        </Button>
        {confirmation ? (
          <span className="text-muted-foreground text-[11px]">
            确认于 {new Date(confirmation.confirmedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      {!complete ? (
        <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
          {blockers.map((blocker) => (
            <li key={blocker}>· {blocker}</li>
          ))}
        </ul>
      ) : confirmation ? null : (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
          每个目标都有条目讲授，每个条目都覆盖了目标，顺序与先后关系一致，可以确认。
        </p>
      )}

      {state.findings.length > 0 ? (
        <ul className="text-muted-foreground space-y-0.5 text-[11px]">
          {state.findings.map((finding) => (
            <li key={finding.text}>提醒：{finding.text}</li>
          ))}
        </ul>
      ) : null}

      <DesignOutlineDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        taskId={taskId}
        onChanged={async () => {
          await reload();
          await onRefresh();
        }}
      />
    </div>
  );
}
