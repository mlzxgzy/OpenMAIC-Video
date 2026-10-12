'use client';

/**
 * 工作台里「教学内容」的签收条：确认、撤回、打开 AI 对话。
 *
 * 与前面四步的签收条同一副骨架、同一处位置：**嵌在那张卡片的头部**。一处与前几步
 * 不同的地方：缺口从服务端读（`readTeachingState`），因为"分镜和脚本打不打架"是一条
 * 跨两份文档的判定，在浏览器里再实现一遍就是第二份定义——两份定义分歧的那天，按钮说
 * 可以确认，门禁说不行。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DesignTeachingDialog } from '@/components/curriculum/design-teaching-dialog';
import {
  confirmTeaching,
  readTeachingState,
  withdrawTeaching,
  type TeachingStatePayload,
} from '@/lib/curriculum/teaching-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

interface DesignTeachingSignOffProps {
  taskId: string;
  units: readonly CurriculumUnitRecord[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  /** The workbench's single-write helper: error strip, notice, reload. */
  run: (key: string, work: () => Promise<string>) => Promise<void>;
  busy: string | null;
  /** Re-read the design and the phase without going through `run`. */
  onRefresh: () => void | Promise<void>;
}

export function DesignTeachingSignOff({
  taskId,
  units,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignTeachingSignOffProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [state, setState] = useState<TeachingStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A cheap signature of the design itself: the strip re-reads the server's verdict
  // when a script or a storyboard changed, not on every parent render.
  const signature = useMemo(
    () =>
      [
        confirmation?.confirmedAt ?? '',
        units
          .map(
            (unit) =>
              `${unit.id}:${unit.title}:${JSON.stringify(unit.teachingDesign ?? null)}:` +
              `${JSON.stringify(unit.deckDesign ?? null)}`,
          )
          .join(','),
      ].join('|'),
    [confirmation?.confirmedAt, units],
  );

  const reload = useCallback(async () => {
    try {
      setState(await readTeachingState(taskId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取教学内容状态失败');
    }
  }, [taskId]);

  useEffect(() => {
    // Inlined so the state lands in a promise callback rather than synchronously in
    // the effect body; `reload` stays for the event handlers.
    let cancelled = false;
    void readTeachingState(taskId).then(
      (next) => {
        if (cancelled) return;
        setState(next);
        setError(null);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : '读取教学内容状态失败');
      },
    );
    return () => {
      cancelled = true;
    };
  }, [taskId, signature]);

  // While the first read is in flight the strip shows nothing rather than a green
  // "complete": a badge that appears before the verdict is a claim.
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
            void run('teaching:confirm', async () => {
              await confirmTeaching(taskId);
              await reload();
              return '授课脚本与分镜已确认。下一步是逐条的题目、实操与考试。';
            })
          }
          disabled={busy !== null || confirmation !== null || !complete}
          title={
            confirmation
              ? '已经确认'
              : !complete
                ? `还差：${blockers.join('；')}`
                : '确认授课脚本与分镜，进入题目与实操阶段'
          }
        >
          {busy === 'teaching:confirm' ? <Loader2 className="animate-spin" /> : <Check />}
          确认教学内容
        </Button>
        {confirmation ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run('teaching:withdraw', async () => {
                await withdrawTeaching(taskId);
                await reload();
                return '已撤回确认；改完之后需要重新确认。';
              })
            }
            disabled={busy !== null}
          >
            {busy === 'teaching:withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            撤回确认
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={busy !== null}
        >
          <Sparkles />用 AI 写脚本与分镜
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
          每个条目都说清了讲什么、讲到什么程度，讲课条目都有分镜，分镜与脚本不矛盾，可以确认。
        </p>
      )}

      {state.findings.length > 0 ? (
        <ul className="text-muted-foreground space-y-0.5 text-[11px]">
          {state.findings.map((finding) => (
            <li key={finding.text}>提醒：{finding.text}</li>
          ))}
        </ul>
      ) : null}

      <DesignTeachingDialog
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
