'use client';

/**
 * 第五步「生成课程大纲」的 AI 对话面板。
 *
 * 与前几步同一副骨架：左边对话，右边状态，底部确认。状态那一侧的重点换了：第二步是
 * 一份清单，第三步是一张图，这一步是**一棵树加上它每个叶子上的承诺**——章、节、目，
 * 以及每个目讲授/练习/考核了哪些目标。
 *
 * 四个刻意的决定：
 *
 * 1. **状态从服务端来，不在客户端维护副本。** 每轮的回包含库里重读后的大纲与缺口，
 *    刷新或从工作台打开时不会与服务端不一致。
 * 2. **确认有两条路径。** 对话里说"确认"由模型转成一次写入，按钮始终在而且更明确；
 *    两者都在卡片上留下"已确认"，只是记录来源不同。
 * 3. **没有覆盖的条目显眼。** 它不是错误状态，是一条等人挂上目标的行——用提示色
 *    而不是红色错误；但它是签收的阻塞项，所以它同时出现在缺口列表里。
 * 4. **出错不清屏。** 模型答不出可用 JSON 时留下作者输入的那句，并把服务端原话显示
 *    出来；静默失败会让作者以为 AI 没听见。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, FolderTree, Loader2, RotateCcw, Send, Sparkles } from 'lucide-react';

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
  COVERAGE_DEPTH_LABELS,
  COVERAGE_KIND_LABELS,
  UNIT_ROLE_LABELS,
} from '@/lib/curriculum/design-outline';
import type { OutlineGap } from '@/lib/curriculum/design-outline';
import {
  confirmOutline,
  readOutlineState,
  sendOutlineTurn,
  withdrawOutline,
  type OutlineStatePayload,
  type OutlineTurn,
} from '@/lib/curriculum/outline-client';
import type { CurriculumUnitRecord } from '@/lib/curriculum/design-types';

interface DesignOutlineDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task whose outline is being arranged. */
  taskId: string;
  /** Anything written: the caller re-reads its own snapshot and phase. */
  onChanged?: () => void | Promise<void>;
}

function initialTurn(): OutlineTurn {
  return {
    role: 'assistant',
    content:
      '这一步把已经确认的学习目标和知识技能图排成课程大纲：章、节归类和分层，条目才是真正上课的内容。每个条目我会写清楚它是讲授、练习还是考试，以及它讲授/练习/考核哪些学习目标，并让顺序与你在上一步签的先后关系一致。页面、讲稿和题目是下一步的事。',
  };
}

const EMPTY_STATE: OutlineStatePayload = {
  units: [],
  unitCoverage: [],
  objectives: [],
  unitDependencies: [],
  gaps: [{ text: '还没有大纲：先把学习目标组织成章、节，再把教学内容落到条目上' }],
  findings: [],
  auditFindings: [],
  confirmation: null,
  confirmed: false,
  nextPhase: null,
  phaseGaps: [],
  readyToAdvance: false,
};

export function DesignOutlineDialog({
  open,
  onOpenChange,
  taskId,
  onChanged,
}: DesignOutlineDialogProps) {
  const [turns, setTurns] = useState<OutlineTurn[]>([initialTurn()]);
  const [state, setState] = useState<OutlineStatePayload>(EMPTY_STATE);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | 'withdraw' | 'load' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // What the last turn could not honour. Kept separate from `error` because the
  // turn did succeed: the outline changed, one instruction did not land, and the
  // author has to be able to tell those apart.
  const [warnings, setWarnings] = useState<string[]>([]);
  const listEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    setTurns([initialTurn()]);
    setState(EMPTY_STATE);
    setError(null);
    setNotice(null);
    setWarnings([]);
    setBusy('load');
    void readOutlineState(taskId)
      .then(setState)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '读取课程大纲失败');
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
    setWarnings([]);
    try {
      const payload = await sendOutlineTurn({ taskId, instruction, history });
      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          // An empty message would leave the author staring at an outline change
          // with no explanation, so the outline's own state speaks instead.
          content: payload.message || '已按你说的更新课程大纲。',
        },
      ]);
      setState(payload);
      setWarnings(payload.warnings ?? []);
      if (payload.confirmedThisTurn) {
        setNotice('已按你在对话里的确认记录：课程大纲已确认。');
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
      setState(await confirmOutline(taskId));
      setNotice('课程大纲已确认。下一步是逐条的教学设计。');
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
      setState(await withdrawOutline(taskId));
      setNotice('已撤回确认，改完之后需要重新确认。');
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤回失败');
    } finally {
      setBusy(null);
    }
  }, [onChanged, taskId]);

  const busyNow = busy !== null;
  const titleOf = (id: string) => state.objectives.find((row) => row.id === id)?.title ?? id;
  const childrenOf = (parentId: string | null) =>
    state.units
      .filter((unit) => (unit.parentId ?? null) === parentId)
      .slice()
      .sort((left, right) => left.orderIndex - right.orderIndex);
  const coverageOf = (unitId: string) => state.unitCoverage.filter((row) => row.unitId === unitId);
  const blockers: OutlineGap[] = [
    ...state.gaps,
    ...state.auditFindings.map((finding) => ({ text: finding.message })),
  ];

  const renderUnit = (unit: CurriculumUnitRecord, depth: number): React.ReactNode => {
    const coverage = coverageOf(unit.id);
    return (
      <li key={unit.id} className="flex flex-col gap-1">
        <div
          className="flex flex-wrap items-center gap-1.5"
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          {unit.unitType === 'item' ? (
            <Badge variant="outline" className="px-1 py-0 text-[10px]">
              {UNIT_ROLE_LABELS[unit.unitRole ?? 'lecture']}
            </Badge>
          ) : (
            <FolderTree className="text-muted-foreground size-3" />
          )}
          {unit.hours !== null ? (
            <Badge variant="secondary" className="px-1 py-0 text-[10px]">
              {unit.hours} 学时
            </Badge>
          ) : null}
          {unit.unitType === 'item' && coverage.length === 0 ? (
            <Badge
              className="border-amber-500/50 bg-amber-500/10 px-1 py-0 text-[10px] text-amber-700 dark:text-amber-300"
              title="不覆盖任何学习目标：既不讲授、不练习，也不考核"
            >
              待挂目标
            </Badge>
          ) : null}
          <span className="font-medium">{unit.title}</span>
        </div>
        {coverage.length > 0 ? (
          <ul
            className="text-muted-foreground space-y-0.5"
            style={{ paddingLeft: `${depth * 12 + 16}px` }}
          >
            {coverage.map((row) => (
              <li key={row.id}>
                {COVERAGE_KIND_LABELS[row.coverageKind]}：{titleOf(row.objectiveId)}
                <span className="ml-1">（{COVERAGE_DEPTH_LABELS[row.depth]}）</span>
              </li>
            ))}
          </ul>
        ) : null}
        <ul>{childrenOf(unit.id).map((child) => renderUnit(child, depth + 1))}</ul>
      </li>
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            第五步：生成课程大纲
          </DialogTitle>
          <DialogDescription>
            聊清楚这门课分几章、每章几节、每节有哪些条目。AI 写的每个章、节、目和它覆盖
            的学习目标都会直接存进课程设计；你改完点「确认课程大纲」，才允许进入教学设计
            阶段。顺序必须与上一步签的先后关系一致——图上的先修关系在这里第一次变成真的 交付顺序。
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
                  AI 正在排大纲…
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
            <Textarea
              className="min-h-16 text-xs"
              placeholder="例如：按章→节→目排，每节固定理论、实操、复盘三个目；Web 那一章多给一个综合靶场"
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

          {/* ── The outline ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                课程大纲（{state.units.filter((unit) => unit.unitType === 'item').length} 个条目）
              </span>
              <ConfirmationBadge state={state} />
            </div>
            {state.units.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-lg border border-dashed p-3 text-xs">
                还没有大纲。章节只是归类，学生要学的内容必须落在条目上——每个条目都要说清
                它讲授、练习或考核哪些学习目标。
              </p>
            ) : (
              <ul className="border-border flex max-h-72 flex-col gap-2 overflow-y-auto rounded-lg border p-3 text-xs">
                {childrenOf(null).map((unit) => renderUnit(unit, 0))}
              </ul>
            )}
            <GapList gaps={state.gaps} />
            {state.auditFindings.length > 0 ? (
              <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
                {state.auditFindings.map((finding) => (
                  <li key={`${finding.rule}-${finding.message}`}>· {finding.message}</li>
                ))}
              </ul>
            ) : null}
            {state.findings.length > 0 ? (
              <ul className="text-muted-foreground space-y-0.5 text-[11px]">
                {state.findings.map((finding) => (
                  <li key={finding.text}>提醒：{finding.text}</li>
                ))}
              </ul>
            ) : null}
          </div>
        </div>

        {error ? (
          <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border p-3 text-xs">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            {error}
          </div>
        ) : null}
        {warnings.length > 0 ? (
          <div className="flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-300">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <ul className="space-y-0.5">
              <li className="font-medium">这一轮有 {warnings.length} 件事需要你确认：</li>
              {warnings.map((warning) => (
                <li key={warning}>· {warning}</li>
              ))}
            </ul>
          </div>
        ) : null}
        {notice ? (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-300">{notice}</p>
        ) : null}

        <DialogFooter className="flex-wrap gap-2">
          {state.confirmation ? (
            <Button variant="outline" size="sm" onClick={() => void withdraw()} disabled={busyNow}>
              {busy === 'withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              撤回确认
            </Button>
          ) : null}
          <Button
            size="sm"
            onClick={() => void confirm()}
            disabled={busyNow || state.confirmation !== null || blockers.length > 0}
            title={
              blockers.length > 0
                ? `还差：${blockers.map((gap) => gap.text).join('；')}`
                : undefined
            }
          >
            {busy === 'confirm' ? <Loader2 className="animate-spin" /> : <Check />}
            确认课程大纲
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConfirmationBadge({ state }: { state: OutlineStatePayload }) {
  if (!state.confirmation) return <Badge variant="outline">未确认</Badge>;
  return (
    <Badge className="gap-1">
      <Check className="size-3" />
      {state.confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
    </Badge>
  );
}

function GapList({ gaps }: { gaps: readonly OutlineGap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
        每个目标都有条目讲授，每个条目都覆盖了目标，顺序与先后关系一致。
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
