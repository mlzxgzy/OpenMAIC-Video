'use client';

/**
 * 第六步「教学内容生产」的 AI 对话面板：**授课脚本 → 分镜**。
 *
 * 左边对话，右边逐条的脚本与分镜，底部确认——和第五步同一副骨架。状态那一侧的重点
 * 换了：第五步是一棵树加上每个叶子的承诺，这一步是**每个条目讲什么、讲到什么程度，
 * 以及这件事落在哪几页上**。
 *
 * 四个刻意的决定：
 *
 * 1. **脚本和分镜并排显示，因为它们必须互相解释。** 脚本一个表格、分镜一个列表、
 *    各自都完整，矛盾就只能等到生成出来的课件里才看得见——并排放，作者一眼能看出
 *    "脚本说要讲透的东西没有任何一页担着"。
 * 2. **缺口与矛盾从服务端来。** 这一条判定要跨两份文档，在浏览器里再实现一遍就是
 *    第二份定义。
 * 3. **分镜只画给讲课条目。** 练习和考试条目生成的是场景，规则层连存都不给它们存
 *    （见 `deckDesignForRole`），面板不该画一个不存在的格子。
 * 4. **出错不清屏。** 模型答不出可用 JSON 时留下作者那句话，并把服务端原话显示出来。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, LayoutList, Loader2, RotateCcw, Send, Sparkles } from 'lucide-react';

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
  ASSIGNED_NODE_BUCKETS,
  ROLE_LABELS,
  TEACHING_DEPTH_LABELS,
} from '@/lib/curriculum/design-teaching';
import type { TeachingGap } from '@/lib/curriculum/design-teaching';
import {
  confirmTeaching,
  readTeachingState,
  sendTeachingTurn,
  withdrawTeaching,
  type TeachingStatePayload,
  type TeachingTurn,
} from '@/lib/curriculum/teaching-client';
import type { CurriculumUnitRecord } from '@/lib/curriculum/design-types';
import { stepRef, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';

interface DesignTeachingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task whose lessons are being designed. */
  taskId: string;
  /** Anything written: the caller re-reads its own snapshot and phase. */
  onChanged?: () => void | Promise<void>;
}

function initialTurn(): TeachingTurn {
  return {
    role: 'assistant',
    content:
      '这一步把大纲里的每个条目变成可以生产的设计：先说清这一条讲什么、讲到什么程度（讲透 / 带过 / 点名 / 不讲），再把它落成分镜——每一页一句目标、一句核心信息、一种呈现方式。分镜是生成器唯一读得到的东西，脚本说讲透的知识点必须有某一页担着。题目、实操和考试是下一步的事。',
  };
}

const EMPTY_STATE: TeachingStatePayload = {
  units: [],
  unitCoverage: [],
  nodes: [],
  nodeObjectives: [],
  objectives: [],
  gaps: [{ kind: 'no_items', text: `还没有条目：先到${stepRef('outline')}排出这一目的条目` }],
  findings: [],
  auditFindings: [],
  confirmation: null,
  confirmed: false,
  nextPhase: null,
  phaseGaps: [],
  readyToAdvance: false,
  plan: '',
};

export function DesignTeachingDialog({
  open,
  onOpenChange,
  taskId,
  onChanged,
}: DesignTeachingDialogProps) {
  const [turns, setTurns] = useState<TeachingTurn[]>([initialTurn()]);
  const [state, setState] = useState<TeachingStatePayload>(EMPTY_STATE);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | 'withdraw' | 'load' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
    void readTeachingState(taskId)
      .then(setState)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '读取教学设计失败');
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
      const payload = await sendTeachingTurn({ taskId, instruction, history });
      setTurns((current) => [
        ...current,
        { role: 'assistant', content: payload.message || '已按你说的更新授课脚本与分镜。' },
      ]);
      setState(payload);
      setWarnings(payload.warnings ?? []);
      if (payload.confirmedThisTurn) {
        setNotice('已按你在对话里的确认记录：授课脚本与分镜已确认。');
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
      setState(await confirmTeaching(taskId));
      setNotice(`${STEP_WORK_NAME.teaching}已确认。下一步是${stepRef('assessment')}。`);
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
      setState(await withdrawTeaching(taskId));
      setNotice('已撤回确认，改完之后需要重新确认。');
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤回失败');
    } finally {
      setBusy(null);
    }
  }, [onChanged, taskId]);

  const busyNow = busy !== null;
  const nameOf = useCallback(
    (id: string) => state.nodes.find((node) => node.id === id)?.name ?? id,
    [state.nodes],
  );
  const items = useMemo(
    () => state.units.filter((unit) => unit.unitType === 'item'),
    [state.units],
  );

  const gapsOf = (unitId: string): TeachingGap[] => state.gaps.filter((gap) => gap.ref === unitId);
  const blockers: { text: string }[] = [
    ...state.gaps,
    ...state.auditFindings.map((finding) => ({ text: finding.message })),
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            第六步：教学内容生产
          </DialogTitle>
          <DialogDescription>
            把每个条目写成授课脚本（讲什么、讲到什么程度、什么顺序），再落成分镜——每页一句
            目标、一句核心信息、一种呈现方式。分镜直接进生成提示词，所以脚本与分镜必须互相对得上：
            脚本说要讲透的知识点，分镜里得有某一页担着。确认之后才允许进入{stepRef('assessment')}。
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
                  AI 正在写脚本与分镜…
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
            <Textarea
              className="min-h-16 text-xs"
              placeholder="例如：1.1 讲透参数化和联合查询，分 12 页；1.2 是实操条目，说清练什么就行"
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

          {/* ── Script and storyboard, per item ──────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">授课脚本与分镜（{items.length} 个条目）</span>
              <ConfirmationBadge state={state} />
            </div>
            {items.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-lg border border-dashed p-3 text-xs">
                还没有条目。章节只是归类，能上课的是条目——先到{stepRef('outline')}把它们排出来。
              </p>
            ) : (
              <ul className="border-border flex max-h-80 flex-col gap-3 overflow-y-auto rounded-lg border p-3 text-xs">
                {items.map((unit) => (
                  <ItemDesign key={unit.id} unit={unit} nameOf={nameOf} gaps={gapsOf(unit.id)} />
                ))}
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
              <li className="font-medium">这一轮有 {warnings.length} 件事没能照你说的写进去：</li>
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
            确认授课脚本与分镜
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One item: its script buckets, then the pages that carry them. */
function ItemDesign({
  unit,
  nameOf,
  gaps,
}: {
  unit: CurriculumUnitRecord;
  nameOf: (id: string) => string;
  gaps: readonly TeachingGap[];
}) {
  const design = unit.teachingDesign ?? {};
  const pages = unit.deckDesign?.pages ?? [];
  const omitted = design.omit ?? [];

  return (
    <li className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {ROLE_LABELS[unit.unitRole ?? 'lecture']}
        </Badge>
        {unit.hours !== null ? (
          <Badge variant="secondary" className="px-1 py-0 text-[10px]">
            {unit.hours} 学时
          </Badge>
        ) : null}
        <span className="font-medium">{unit.title}</span>
      </div>

      {ASSIGNED_NODE_BUCKETS.map((bucket) => {
        const ids = design[bucket] ?? [];
        if (ids.length === 0) return null;
        return (
          <div key={bucket} className="text-muted-foreground pl-4">
            {TEACHING_DEPTH_LABELS[bucket]}：{ids.map(nameOf).join('、')}
          </div>
        );
      })}
      {omitted.length > 0 ? (
        <div className="text-muted-foreground pl-4">明确不讲：{omitted.join('、')}</div>
      ) : null}
      {ASSIGNED_NODE_BUCKETS.every((bucket) => (design[bucket] ?? []).length === 0) ? (
        <div className="pl-4 text-amber-700 dark:text-amber-300">还没有授课脚本</div>
      ) : null}

      {unit.unitRole === 'lecture' ? (
        pages.length === 0 ? (
          <div className="pl-4 text-amber-700 dark:text-amber-300">
            还没有分镜（页面计划）：生成器拿不到页结构就会自己编一套
          </div>
        ) : (
          <ol className="text-muted-foreground flex flex-col gap-0.5 pl-4">
            {pages.map((page) => (
              <li key={page.order} className="flex items-start gap-1">
                <LayoutList className="mt-0.5 size-3 shrink-0" />
                <span>
                  <span className="text-foreground">
                    {page.order}. {page.title}
                  </span>
                  ｜目标：{page.goal}｜核心：{page.coreInfo}
                  {(page.teaches ?? []).length > 0
                    ? `｜讲：${(page.teaches ?? []).map(nameOf).join('、')}`
                    : ''}
                </span>
              </li>
            ))}
          </ol>
        )
      ) : null}

      {gaps.length > 0 ? (
        <ul className="space-y-0.5 pl-4 text-[11px] text-amber-700 dark:text-amber-300">
          {gaps.map((gap) => (
            <li key={gap.text}>· {gap.text}</li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function ConfirmationBadge({ state }: { state: TeachingStatePayload }) {
  if (!state.confirmation) return <Badge variant="outline">未确认</Badge>;
  return (
    <Badge className="gap-1">
      <Check className="size-3" />
      {state.confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
    </Badge>
  );
}

function GapList({ gaps }: { gaps: readonly TeachingGap[] }) {
  // Gaps belonging to one item are shown beside it; these are the ones that belong
  // to the step as a whole (no items at all), so the list is not doubled up.
  const overall = gaps.filter((gap) => gap.ref === undefined);
  if (overall.length === 0) {
    return (
      <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
        每个条目都写清了讲什么、讲到什么程度，讲课条目都有分镜，分镜与脚本不矛盾。
      </p>
    );
  }
  return (
    <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
      {overall.map((gap) => (
        <li key={gap.text}>· {gap.text}</li>
      ))}
    </ul>
  );
}
