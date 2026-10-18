'use client';

/**
 * 第二步「学习目标与考核标准」的 AI 对话面板。
 *
 * 与第一步同一副骨架：左边对话，右边状态，底部确认。与第一步相反的是状态那一侧
 * ——第一步是一张七格卡片，第二步是一份**会增长、有序、可增删的清单**，所以这里显示
 * 的是每一条目标的四个要素和它的考核方式，以及一条条"还差什么"。
 *
 * 四个刻意的决定：
 *
 * 1. **清单从服务端来，不在客户端维护副本。** 每轮的回包含库里重读后的目标与证据，
 *    所以刷新或从工作台打开时不会与服务端不一致。
 * 2. **确认有两条路径。** 用户选了宽松模式：对话里说"确认"由模型转成一次写入，
 *    按钮始终在而且更明确。两者都在卡片上留下"已确认"，只是记录来源不同。
 * 3. **不可验证的目标显眼。** 它不是错误状态，是一条等人补一句最低标准的行——所以
 *    用提示色而不是红色错误，避免作者以为系统坏了。
 * 4. **出错不清屏。** 模型答不出可用 JSON 时留下用户输入的那句，并把服务端原话显示
 *    出来；静默失败会让用户以为 AI 没听见。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw, Send, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  ASSESSMENT_MODE_LABELS,
  EVIDENCE_TYPE_LABELS,
  OUTCOME_TYPE_LABELS,
} from '@/lib/curriculum/design-outcomes';
import type { OutcomeGap } from '@/lib/curriculum/design-outcomes';
import { stepRef, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';
import {
  confirmOutcomes,
  readOutcomesState,
  sendOutcomesTurn,
  withdrawOutcomes,
  type OutcomesStatePayload,
  type OutcomesTurn,
} from '@/lib/curriculum/outcomes-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumEvidenceRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';

interface DesignOutcomesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task whose outcomes are being drafted. Step 2 has no "create first" turn. */
  taskId: string;
  /** Anything written: the caller re-reads its own snapshot and phase. */
  onChanged?: () => void | Promise<void>;
}

function initialTurn(): OutcomesTurn {
  return {
    role: 'assistant',
    content:
      '说清楚学完之后学生要能独立完成什么就行。我会把它拆成一条条学习目标，每条配一个可观察行为、一条最低标准和一种考核方式——你改完点确认，就进入下一步。',
  };
}

const EMPTY_STATE: OutcomesStatePayload = {
  objectives: [],
  evidence: [],
  gaps: [{ text: '还没有学习目标：先写下学生学完后能独立完成什么' }],
  confirmation: null,
  confirmed: false,
  nextPhase: null,
  phaseGaps: [],
  readyToAdvance: false,
};

export function DesignOutcomesDialog({
  open,
  onOpenChange,
  taskId,
  onChanged,
}: DesignOutcomesDialogProps) {
  const [turns, setTurns] = useState<OutcomesTurn[]>([initialTurn()]);
  const [state, setState] = useState<OutcomesStatePayload>(EMPTY_STATE);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | 'withdraw' | 'load' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTurns([initialTurn()]);
    setState(EMPTY_STATE);
    setError(null);
    setNotice(null);
    setBusy('load');
    void readOutcomesState(taskId)
      .then(setState)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '读取学习目标失败');
      })
      .finally(() => setBusy(null));
  }, [open, taskId]);

  useEffect(() => {
    listEnd.current?.scrollIntoView({ block: 'end' });
  }, [turns]);

  const send = useCallback(async () => {
    const instruction = draft.trim();
    if (instruction === '' || busy) return;
    const history = turns;
    setTurns([...history, { role: 'user', content: instruction }]);
    setDraft('');
    setBusy('send');
    setError(null);
    setNotice(null);
    try {
      const payload = await sendOutcomesTurn({ taskId, instruction, history });
      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          // An empty message would leave the user staring at a list change with no
          // explanation, so the list's own state speaks instead.
          content: payload.message || '已按你说的更新学习目标清单。',
        },
      ]);
      setState(payload);
      if (payload.confirmedThisTurn) {
        setNotice('已按你在对话里的确认记录：学习目标与考核标准已确认。');
      }
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 对话失败');
    } finally {
      setBusy(null);
    }
  }, [busy, draft, onChanged, taskId, turns]);

  const confirm = useCallback(async () => {
    setBusy('confirm');
    setError(null);
    setNotice(null);
    try {
      setState(await confirmOutcomes(taskId));
      setNotice(`${STEP_WORK_NAME.outcomes}已确认。下一步是${stepRef('graph')}。`);
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认失败');
    } finally {
      setBusy(null);
    }
  }, [onChanged, taskId]);

  const withdraw = useCallback(async () => {
    setBusy('withdraw');
    setError(null);
    setNotice(null);
    try {
      setState(await withdrawOutcomes(taskId));
      setNotice('已撤回确认，改完之后需要重新确认。');
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤回失败');
    } finally {
      setBusy(null);
    }
  }, [onChanged, taskId]);

  const busyNow = busy !== null;
  const evidenceOf = (objective: CurriculumObjectiveRecord) =>
    state.evidence.filter((row) => row.objectiveId === objective.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            第二步：学习目标与考核标准
          </DialogTitle>
          <DialogDescription>
            聊清楚学完之后学生能独立完成什么。AI
            写的每一条目标和每一条考核方式都会直接存进课程设计；你改完点「确认
            {STEP_WORK_NAME.outcomes}」，才允许进入{stepRef('graph')}。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
          {/* ── Conversation ─────────────────────────────────────────────── */}
          <div className="flex min-h-[24rem] flex-col gap-2">
            <div className="border-border flex-1 space-y-2 overflow-y-auto rounded-lg border p-3">
              {turns.map((turn, index) => (
                <div
                  key={index}
                  className={
                    turn.role === 'user'
                      ? 'bg-primary text-primary-foreground ml-auto max-w-[85%] rounded-lg px-3 py-2 text-xs'
                      : 'bg-muted max-w-[90%] rounded-lg px-3 py-2 text-xs'
                  }
                >
                  {turn.content}
                </div>
              ))}
              {busy === 'send' ? (
                <div className="text-muted-foreground flex items-center gap-1.5 text-xs">
                  <Loader2 className="size-3 animate-spin" />
                  AI 正在整理学习目标…
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
            <Textarea
              className="min-h-16 text-xs"
              placeholder="例如：核心是 6 个方向各能独立解一类题，Web 和 Pwn 要能完整写出 Writeup"
              value={draft}
              disabled={busyNow}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
            />
            <Button size="sm" onClick={() => void send()} disabled={busyNow || draft.trim() === ''}>
              {busy === 'send' ? <Loader2 className="animate-spin" /> : <Send />}
              发送
            </Button>
          </div>

          {/* ── The list ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                学习目标清单（{state.objectives.length} 条）
              </span>
              <ConfirmationBadge confirmation={state.confirmation} />
            </div>
            {state.objectives.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-lg border border-dashed p-3 text-xs">
                还没有学习目标。逆向设计从「学生最终要能做什么」开始，不是从「讲什么」开始。
              </p>
            ) : (
              <ul className="border-border flex max-h-72 flex-col divide-y overflow-y-auto rounded-lg border text-xs">
                {state.objectives.map((objective) => (
                  <li key={objective.id} className="flex flex-col gap-1 px-3 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <Badge variant="outline" className="px-1 py-0 text-[10px]">
                        {OUTCOME_TYPE_LABELS[objective.objectiveType]}
                      </Badge>
                      {!objective.verifiable ? (
                        <Badge
                          className="border-amber-500/50 bg-amber-500/10 px-1 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                          title="缺可观察行为或最低标准，现在无法考核"
                        >
                          待补标准
                        </Badge>
                      ) : null}
                      <span className="font-medium">{objective.title}</span>
                    </div>
                    {objective.expectedBehavior ? (
                      <span className="text-muted-foreground">
                        行为：{objective.expectedBehavior}
                      </span>
                    ) : null}
                    {objective.minCriteria.length > 0 ? (
                      <span className="text-muted-foreground">
                        最低标准：{objective.minCriteria.join('、')}
                      </span>
                    ) : null}
                    <EvidenceSummary rows={evidenceOf(objective)} />
                  </li>
                ))}
              </ul>
            )}
            <GapList gaps={state.gaps} />
          </div>
        </div>

        {error ? (
          <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </div>
        ) : null}
        {notice ? (
          <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300">
            <Check className="mt-0.5 size-3.5 shrink-0" />
            {notice}
          </div>
        ) : null}

        <DialogFooter className="flex-row flex-wrap items-center justify-between gap-2 sm:justify-between">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void confirm()}
              disabled={busyNow || state.confirmed || state.gaps.length > 0}
              title={
                state.confirmed
                  ? '已确认'
                  : state.gaps.length > 0
                    ? state.gaps.map((gap) => gap.text).join('；')
                    : `确认${STEP_WORK_NAME.outcomes}，进入${stepRef('graph')}`
              }
            >
              {busy === 'confirm' ? <Loader2 className="animate-spin" /> : <Check />}
              确认{STEP_WORK_NAME.outcomes}
            </Button>
            {state.confirmed ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => void withdraw()}
                disabled={busyNow}
              >
                {busy === 'withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                撤回确认
              </Button>
            ) : null}
          </div>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmationBadge({
  confirmation,
}: {
  confirmation: CurriculumDesignConfirmationRecord | null;
}) {
  if (!confirmation) return <Badge variant="outline">未确认</Badge>;
  return (
    <Badge className="gap-1">
      <Check className="size-3" />
      {confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
    </Badge>
  );
}

function EvidenceSummary({ rows }: { rows: readonly CurriculumEvidenceRecord[] }) {
  if (rows.length === 0) {
    return <span className="text-amber-700 dark:text-amber-300">考核：还没有</span>;
  }
  return (
    <span className="text-muted-foreground">
      考核：
      {rows
        .map((row) => {
          const success =
            row.successCondition.length > 40
              ? `${row.successCondition.slice(0, 40)}…`
              : row.successCondition;
          return `${EVIDENCE_TYPE_LABELS[row.evidenceType]}（${ASSESSMENT_MODE_LABELS[row.assessmentMode]}）${success}`;
        })
        .join('；')}
    </span>
  );
}

function GapList({ gaps }: { gaps: readonly OutcomeGap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
        每条目标都可考核，可以确认。
      </p>
    );
  }
  return (
    <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
      {gaps.map((gap) => (
        <li key={`${gap.ref ?? ''}-${gap.text}`}>· {gap.text}</li>
      ))}
    </ul>
  );
}
