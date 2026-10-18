'use client';

/**
 * 工作台里「题目与实操」的签收条：确认、撤回、打开 AI 对话。
 *
 * 与前面五步的签收条同一副骨架、同一处位置：**嵌在那张卡片的头部**。缺口同样从服务端
 * 读（`readAssessmentState`），理由在这一步比前面任何一步都硬：判定要同时跨大纲、证据
 * 和产物三份文档，在浏览器里再实现一遍就是第二份定义——两份定义分歧的那天，按钮说可以
 * 确认，门禁说不行。
 *
 * 两处与前几步不同的地方：
 *
 * 1. **缺口与审核结论会重复。** 同一条判定可以从"还差什么"和审核两条路各来一次（比如
 *    "题目挂在不承担该目标的条目上"），照抄前几步会把同一句话说两遍。去重按文本做：
 *    两处的文案不一致时它们本来就是两件事，不该被合并。
 * 2. **签名只盖产物本身。** 前面几步的签名来自挂在条目上的字段（脚本、分镜），这一步的
 *    题目和实操是**独立的行**，所以签名得由它们的 id 拼出来——改一道题干在条目记录上
 *    没有痕迹，条目的 `updatedAt` 是脏的，不能拿来当"变了没有"。
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DesignAssessmentDialog } from '@/components/curriculum/design-assessment-dialog';
import {
  confirmAssessment,
  readAssessmentState,
  withdrawAssessment,
  type AssessmentStatePayload,
} from '@/lib/curriculum/assessment-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumLabTaskRecord,
  CurriculumQuestionRecord,
} from '@/lib/curriculum/design-types';
import { stepRef, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';

interface DesignAssessmentSignOffProps {
  taskId: string;
  questions: readonly CurriculumQuestionRecord[];
  labTasks: readonly CurriculumLabTaskRecord[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  /** The workbench's single-write helper: error strip, notice, reload. */
  run: (key: string, work: () => Promise<string>) => Promise<void>;
  busy: string | null;
  /** Re-read the design and the phase without going through `run`. */
  onRefresh: () => void | Promise<void>;
}

export function DesignAssessmentSignOff({
  taskId,
  questions,
  labTasks,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignAssessmentSignOffProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [state, setState] = useState<AssessmentStatePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  // A cheap signature of the artifacts themselves: the strip re-reads the server's
  // verdict when a question, a lab or the sign-off changed — not on every parent
  // render. Unit fields would not do: a question is a row of its own.
  const signature = useMemo(
    () =>
      [
        confirmation?.confirmedAt ?? '',
        questions
          .map(
            (question) =>
              `${question.id}:${question.unitId}:${question.objectiveId}:${question.updatedAt}`,
          )
          .join(','),
        labTasks
          .map((lab) => `${lab.id}:${lab.unitId}:${lab.objectiveId}:${lab.updatedAt}`)
          .join(','),
      ].join('|'),
    [confirmation?.confirmedAt, labTasks, questions],
  );

  const reload = useCallback(async () => {
    try {
      setState(await readAssessmentState(taskId));
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取题目与实操状态失败');
    }
  }, [taskId]);

  useEffect(() => {
    // Inlined so the state lands in a promise callback rather than synchronously in
    // the effect body; `reload` stays for the event handlers.
    let cancelled = false;
    void readAssessmentState(taskId).then(
      (next) => {
        if (cancelled) return;
        setState(next);
        setError(null);
      },
      (caught: unknown) => {
        if (cancelled) return;
        setError(caught instanceof Error ? caught.message : '读取题目与实操状态失败');
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
    ...new Set([
      ...state.gaps.map((gap) => gap.text),
      ...state.auditFindings.map((finding) => finding.message),
    ]),
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
            void run('assessment:confirm', async () => {
              await confirmAssessment(taskId);
              await reload();
              return `${STEP_WORK_NAME.assessment}已确认。下一步是${stepRef('review')}。`;
            })
          }
          disabled={busy !== null || confirmation !== null || !complete}
          title={
            confirmation
              ? '已经确认'
              : !complete
                ? `还差：${blockers.join('；')}`
                : `确认${STEP_WORK_NAME.assessment}，进入${stepRef('review')}`
          }
        >
          {busy === 'assessment:confirm' ? <Loader2 className="animate-spin" /> : <Check />}
          确认题目与实操
        </Button>
        {confirmation ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run('assessment:withdraw', async () => {
                await withdrawAssessment(taskId);
                await reload();
                return '已撤回确认；改完之后需要重新确认。';
              })
            }
            disabled={busy !== null}
          >
            {busy === 'assessment:withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            撤回确认
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={busy !== null}
        >
          <Sparkles />用 AI 出题与实操
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
          每个承诺要考核的目标都有题目或实操接着，都挂在承担它的条目上，实操都有能判分的验证规则，可以确认。
        </p>
      )}

      {state.findings.length > 0 ? (
        <ul className="text-muted-foreground space-y-0.5 text-[11px]">
          {state.findings.map((finding) => (
            <li key={finding.text}>提醒：{finding.text}</li>
          ))}
        </ul>
      ) : null}

      <DesignAssessmentDialog
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
