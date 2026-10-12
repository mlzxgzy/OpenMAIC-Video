'use client';

/**
 * 工作台里「学习目标与考核标准」的签收条：确认、撤回、打开 AI 对话。
 *
 * 不做成一张和「学习目标」并排的卡片，而是**嵌在那张卡片的头部**——它们是同一件事
 * 的两个面：上面是可增删的清单和它的逐条证据，这里是这张清单整体的"我读过了"。并排
 * 会让人以为多了一步。
 *
 * 确认按钮的可用条件完全来自服务端给的 `gaps`（这份快照里没有时退回本地口径），理由
 * 同 `design-direction-card`：点下去才被拒是最差的告知时机。"待补标准"用提示色而不是
 * 错误红，因为它是等人补一句最低标准的行，不是系统坏了。
 */
import { useMemo, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DesignOutcomesDialog } from '@/components/curriculum/design-outcomes-dialog';
import { outcomeGapsOfRecords } from '@/lib/curriculum/design-outcomes';
import { confirmOutcomes, withdrawOutcomes } from '@/lib/curriculum/outcomes-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumEvidenceRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';

interface DesignOutcomesSignOffProps {
  taskId: string;
  objectives: readonly CurriculumObjectiveRecord[];
  evidence: readonly CurriculumEvidenceRecord[];
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

export function DesignOutcomesSignOff({
  taskId,
  objectives,
  evidence,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignOutcomesSignOffProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Gaps computed from the same snapshot the list is rendered from, so the strip
  // can never claim the list is complete while the list below shows a bare row.
  const gaps = useMemo(() => outcomeGapsOfRecords(objectives, evidence), [objectives, evidence]);
  const complete = gaps.length === 0;

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
            void run('outcomes:confirm', async () => {
              await confirmOutcomes(taskId);
              return '学习目标与考核标准已确认。下一步是知识技能图。';
            })
          }
          disabled={busy !== null || confirmation !== null || !complete}
          title={
            confirmation
              ? '已经确认'
              : !complete
                ? `还差：${gaps.map((gap) => gap.text).join('；')}`
                : '确认学习目标，进入知识技能图阶段'
          }
        >
          {busy === 'outcomes:confirm' ? <Loader2 className="animate-spin" /> : <Check />}
          确认学习目标
        </Button>
        {confirmation ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run('outcomes:withdraw', async () => {
                await withdrawOutcomes(taskId);
                return '已撤回确认；改完之后需要重新确认。';
              })
            }
            disabled={busy !== null}
          >
            {busy === 'outcomes:withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            撤回确认
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={busy !== null}
        >
          <Sparkles />用 AI 修改学习目标
        </Button>
        {confirmation ? (
          <span className="text-muted-foreground text-[11px]">
            确认于 {new Date(confirmation.confirmedAt).toLocaleString()}
          </span>
        ) : null}
      </div>

      {!complete ? (
        <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
          {gaps.map((gap) => (
            <li key={`${gap.ref ?? ''}-${gap.text}`}>· {gap.text}</li>
          ))}
        </ul>
      ) : confirmation ? (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
          每条目标都可考核，且已确认。
        </p>
      ) : (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
          每条目标都可考核，可以确认。
        </p>
      )}

      <DesignOutcomesDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        taskId={taskId}
        onChanged={onRefresh}
      />
    </div>
  );
}
