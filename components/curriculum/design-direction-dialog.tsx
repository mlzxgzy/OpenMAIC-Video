'use client';

/**
 * 第一步「课程方向」的 AI 对话面板。
 *
 * 这是新建课程流程的入口：和模型聊几句，卡片就被填出来；点「确认课程方向」，
 * 这一步才算完成，阶段门禁才打开。它同时是已有课程改方向的界面——从工作台的
 * 卡片点「用 AI 修改方向」打开的是同一个组件，只是带上了 taskId。
 *
 * 四个刻意的决定：
 *
 * 1. **对话只讲意图，卡片才是状态。** 每一轮的 `history` 是原始对话，字段值由
 *    服务端在库里读出来再回给对话框。客户端不维护一份"我以为的卡片"，所以刷新
 *    或换入口打开时不会和服务端不一致。
 * 2. **确认是按钮 + 对话两种方式。** 用户选了宽松模式：对话里说"确认"由模型
 *    转成一次写入，但按钮始终在（而且更明确）。两者都会在卡片上留下"已确认"，
 *    只是记录来源不同。
 * 3. **未建任务时也显示卡片。** 第一轮之前库里没有行（`title` 是 NOT NULL），
 *    卡片显示的是这一轮的服务端回包，而不是本地草稿——所以它和真写进去的东西
 *    永远是同一个来源。
 * 4. **出错不清屏。** 模型答不出可用 JSON 时留下用户输入的那句，并把服务端的
 *    原话显示出来；静默失败会让用户以为 AI 没听见。
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
  CURRICULUM_DIRECTION_FIELDS,
  directionGaps,
  type CurriculumDirectionValues,
} from '@/lib/curriculum/design-direction';
import {
  confirmDirection,
  readDirectionState,
  sendDirectionTurn,
  withdrawDirection,
  type DirectionTurn,
} from '@/lib/curriculum/direction-client';
import type { CurriculumDesignConfirmationRecord } from '@/lib/curriculum/design-types';

interface DesignDirectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task being revised, or `null` when this dialog is creating one. */
  taskId: string | null;
  /**
   * Fired the moment the conversation creates the task, so the caller can route
   * to it — the user asked for a new course and should not have to hunt for the
   * row that the next message created.
   */
  onTaskChange?: (taskId: string) => void;
  /** Anything written: the caller re-reads its own snapshot and phase. */
  onChanged?: () => void | Promise<void>;
  /**
   * Present exactly where the dialog is the way into a course (the task list),
   * so the user can leave for the design page without hunting for the row their
   * own words just created. Absent when the dialog is already inside the task.
   */
  onOpenTask?: (taskId: string) => void;
  /**
   * The series a task created by this conversation joins. Only sent while no
   * task exists yet; revisions of an existing task never move it.
   */
  seriesId?: string | null;
}

const EMPTY_VALUES: CurriculumDirectionValues = {
  title: null,
  audience: null,
  learnerLevel: null,
  trainingScenario: null,
  durationHours: null,
  applicationScene: null,
  problemStatement: null,
};

function initialTurn(): DirectionTurn {
  return {
    role: 'assistant',
    content:
      '先说这门课给谁上、要解决什么问题、大概多少学时。信息够了我把「课程方向」卡填出来，你改完点确认，就进入下一步。',
  };
}

export function DesignDirectionDialog({
  open,
  onOpenChange,
  taskId,
  onTaskChange,
  onChanged,
  onOpenTask,
  seriesId,
}: DesignDirectionDialogProps) {
  const [currentTaskId, setCurrentTaskId] = useState<string | null>(taskId);
  const [turns, setTurns] = useState<DirectionTurn[]>([initialTurn()]);
  const [values, setValues] = useState<CurriculumDirectionValues>(EMPTY_VALUES);
  const [gaps, setGaps] = useState<string[]>(directionGaps(EMPTY_VALUES));
  const [confirmation, setConfirmation] = useState<CurriculumDesignConfirmationRecord | null>(null);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | 'withdraw' | 'load' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const listEnd = useRef<HTMLDivElement | null>(null);

  /** A fresh conversation, or one resuming the task it was opened on. */
  useEffect(() => {
    if (!open) return;
    setCurrentTaskId(taskId);
    setTurns([initialTurn()]);
    setValues(EMPTY_VALUES);
    setGaps(directionGaps(EMPTY_VALUES));
    setConfirmation(null);
    setError(null);
    setNotice(null);
    if (!taskId) return;
    setBusy('load');
    void readDirectionState(taskId)
      .then((state) => {
        setValues(state.values);
        setGaps(state.gaps);
        setConfirmation(state.confirmation);
      })
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '读取课程方向失败');
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
      const payload = await sendDirectionTurn({
        taskId: currentTaskId,
        instruction,
        history,
        seriesId: currentTaskId ? undefined : (seriesId ?? undefined),
      });
      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          // An empty message would leave the user staring at a card change with
          // no explanation, so the card's own state speaks instead.
          content: payload.message || '已按你说的更新课程方向卡片。',
        },
      ]);
      setValues(payload.values);
      setGaps(payload.gaps);
      setConfirmation(payload.confirmation);
      if (payload.task && payload.task.id !== currentTaskId) {
        setCurrentTaskId(payload.task.id);
        onTaskChange?.(payload.task.id);
      }
      if (payload.confirmedThisTurn) {
        setNotice('已按你在对话里的确认记录：课程方向已确认，可以进入下一步。');
      }
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 对话失败');
    } finally {
      setBusy(null);
    }
  }, [busy, currentTaskId, draft, onChanged, onTaskChange, seriesId, turns]);

  const confirm = useCallback(async () => {
    if (!currentTaskId) {
      setError('先让 AI 填出课程方向名称（课程标题），才有可确认的卡片。');
      return;
    }
    setBusy('confirm');
    setError(null);
    setNotice(null);
    try {
      const state = await confirmDirection(currentTaskId);
      setValues(state.values);
      setGaps(state.gaps);
      setConfirmation(state.confirmation);
      setNotice('课程方向已确认。下一步是学习目标。');
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '确认失败');
    } finally {
      setBusy(null);
    }
  }, [currentTaskId, onChanged]);

  const withdraw = useCallback(async () => {
    if (!currentTaskId) return;
    setBusy('withdraw');
    setError(null);
    setNotice(null);
    try {
      const state = await withdrawDirection(currentTaskId);
      setValues(state.values);
      setGaps(state.gaps);
      setConfirmation(state.confirmation);
      setNotice('已撤回确认，改完之后需要重新确认。');
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤回失败');
    } finally {
      setBusy(null);
    }
  }, [currentTaskId, onChanged]);

  const busyNow = busy !== null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            第一步：课程方向
          </DialogTitle>
          <DialogDescription>
            聊清楚受众、范围、基础和时长。AI
            写的每一格都会直接存进课程任务；你改完点「确认课程方向」，才允许进入学习目标阶段。
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          {/* ── Conversation ─────────────────────────────────────────────── */}
          <div className="flex min-h-[22rem] flex-col gap-2">
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
                  AI 正在整理课程方向…
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
            <Textarea
              className="min-h-16 text-xs"
              placeholder="例如：给大二信息安全专业学生上一门 CTF 综合实战，48 学时左右"
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

          {/* ── Card ─────────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">课程方向卡片</span>
              {confirmation ? (
                <Badge className="gap-1">
                  <Check className="size-3" />
                  {confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
                </Badge>
              ) : (
                <Badge variant="outline">未确认</Badge>
              )}
            </div>
            <ul className="border-border flex flex-col divide-y rounded-lg border text-xs">
              {CURRICULUM_DIRECTION_FIELDS.map((field) => {
                const value = values[field.key];
                return (
                  <li key={field.key} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="text-muted-foreground shrink-0">
                      {field.label}
                      {field.required ? ' *' : ''}
                    </span>
                    <span className="text-right break-words">
                      {value === null || value === '' ? (
                        <span className="text-destructive">未填</span>
                      ) : (
                        String(value)
                      )}
                    </span>
                  </li>
                );
              })}
            </ul>
            {gaps.length > 0 ? (
              <p className="text-muted-foreground text-[11px]">还差：{gaps.join('；')}</p>
            ) : (
              <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
                必填项已齐，可以确认。
              </p>
            )}
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
              disabled={busyNow || confirmation !== null || gaps.length > 0}
              title={
                confirmation
                  ? '已确认'
                  : gaps.length > 0
                    ? `还差：${gaps.join('；')}`
                    : '确认课程方向'
              }
            >
              {busy === 'confirm' ? <Loader2 className="animate-spin" /> : <Check />}
              确认课程方向
            </Button>
            {confirmation ? (
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
          <div className="flex items-center gap-2">
            {onOpenTask && currentTaskId ? (
              <Button size="sm" variant="outline" onClick={() => onOpenTask(currentTaskId)}>
                进入这门课的设计
              </Button>
            ) : null}
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              关闭
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
