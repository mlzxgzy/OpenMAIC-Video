'use client';

/**
 * 第三步「知识点与技能点拆解」的 AI 对话面板。
 *
 * 与前两步同一副骨架：左边对话，右边状态，底部确认。与第二步相反的是状态那一侧的
 * 重点——第二步显示的是一份清单，第三步显示的是**一张图的两端**：左边是知识点及其
 * 连线，右边是这条线上"每个知识点支撑哪个目标"，所以缺口条能同时点名两端。
 *
 * 四个刻意的决定：
 *
 * 1. **清单从服务端来，不在客户端维护副本。** 每轮的回包含库里重读后的节点与连线，
 *    刷新或从工作台打开时不会与服务端不一致。
 * 2. **确认有两条路径。** 对话里说"确认"由模型转成一次写入，按钮始终在而且更明确；
 *    两者都在卡片上留下"已确认"，只是记录来源不同。
 * 3. **缺连线的节点显眼。** 它不是错误状态，是一条等人挂上目标的行——用提示色而
 *    不是红色错误。
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
import { NODE_TYPE_LABELS, SUPPORT_LEVEL_LABELS } from '@/lib/curriculum/design-knowledge';
import type { KnowledgeGap } from '@/lib/curriculum/design-knowledge';
import {
  confirmKnowledge,
  readKnowledgeState,
  sendKnowledgeTurn,
  withdrawKnowledge,
  type KnowledgeStatePayload,
  type KnowledgeTurn,
} from '@/lib/curriculum/knowledge-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumLearningNodeRecord,
} from '@/lib/curriculum/design-types';

interface DesignKnowledgeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task whose graph is being built. Step 3 has no "create first" turn. */
  taskId: string;
  /** Anything written: the caller re-reads its own snapshot and phase. */
  onChanged?: () => void | Promise<void>;
}

function initialTurn(): KnowledgeTurn {
  return {
    role: 'assistant',
    content:
      '这一步只回答一个问题：为了做到那些学习目标，学生得先掌握哪些知识、练会哪些操作。我会把它们拆成知识技能点，并说明每一条支撑哪些目标——章节和讲授顺序留到下一步，你改完点确认。',
  };
}

const EMPTY_STATE: KnowledgeStatePayload = {
  nodes: [],
  nodeObjectives: [],
  objectives: [],
  gaps: [{ text: '还没有知识/技能点：从已确认的学习目标反推' }],
  confirmation: null,
  confirmed: false,
  nextPhase: null,
  phaseGaps: [],
  readyToAdvance: false,
};

export function DesignKnowledgeDialog({
  open,
  onOpenChange,
  taskId,
  onChanged,
}: DesignKnowledgeDialogProps) {
  const [turns, setTurns] = useState<KnowledgeTurn[]>([initialTurn()]);
  const [state, setState] = useState<KnowledgeStatePayload>(EMPTY_STATE);
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
    void readKnowledgeState(taskId)
      .then(setState)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '读取知识技能图失败');
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
      const payload = await sendKnowledgeTurn({ taskId, instruction, history });
      setTurns((current) => [
        ...current,
        {
          role: 'assistant',
          // An empty message would leave the user staring at a graph change with no
          // explanation, so the graph's own state speaks instead.
          content: payload.message || '已按你说的更新知识技能图。',
        },
      ]);
      setState(payload);
      if (payload.confirmedThisTurn) {
        setNotice('已按你在对话里的确认记录：知识技能图已确认。');
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
      setState(await confirmKnowledge(taskId));
      setNotice('知识技能图已确认。下一步是大纲。');
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
      setState(await withdrawKnowledge(taskId));
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
  const linksOf = (node: CurriculumLearningNodeRecord) =>
    state.nodeObjectives.filter((row) => row.nodeId === node.id);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            第三步：知识点与技能点拆解
          </DialogTitle>
          <DialogDescription>
            聊清楚为了做到那些学习目标，学生得先掌握什么。AI
            写的每个知识技能点和每条支撑关系都会直接存进课程设计；你改完点「确认知识技能图」，才允许进入大纲阶段。这一步不排章节。
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
                  AI 正在拆解知识技能点…
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
            <Textarea
              className="min-h-16 text-xs"
              placeholder="例如：SQL 注入那块拆细一点，区分原理和手工利用；Crypto 只保留密码学基础"
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

          {/* ── The graph ─────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">知识技能点（{state.nodes.length} 个）</span>
              <ConfirmationBadge confirmation={state.confirmation} />
            </div>
            {state.nodes.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-lg border border-dashed p-3 text-xs">
                还没有知识技能点。它们由学习目标反推，不是由章节标题得到——逆向设计
                先定「要能做什么」，再倒推「需要先会什么」。
              </p>
            ) : (
              <ul className="border-border flex max-h-72 flex-col divide-y overflow-y-auto rounded-lg border text-xs">
                {state.nodes.map((node) => {
                  const links = linksOf(node);
                  return (
                    <li key={node.id} className="flex flex-col gap-1 px-3 py-2">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="px-1 py-0 text-[10px]">
                          {NODE_TYPE_LABELS[node.nodeType]}
                        </Badge>
                        {links.length === 0 ? (
                          <Badge
                            className="border-amber-500/50 bg-amber-500/10 px-1 py-0 text-[10px] text-amber-700 dark:text-amber-300"
                            title="没有支撑任何学习目标，不会被讲授也不会被考核"
                          >
                            待挂目标
                          </Badge>
                        ) : null}
                        <span className="font-medium">{node.name}</span>
                      </div>
                      {node.summary ? (
                        <span className="text-muted-foreground">{node.summary}</span>
                      ) : null}
                      <LinkSummary
                        rows={links.map((link) => ({
                          id: link.id,
                          label: `${titleOf(link.objectiveId)}（${SUPPORT_LEVEL_LABELS[link.supportLevel]}）`,
                        }))}
                      />
                    </li>
                  );
                })}
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
                    : '确认知识技能图，进入大纲阶段'
              }
            >
              {busy === 'confirm' ? <Loader2 className="animate-spin" /> : <Check />}
              确认知识技能图
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

function LinkSummary({ rows }: { rows: readonly { id: string; label: string }[] }) {
  if (rows.length === 0) {
    return <span className="text-amber-700 dark:text-amber-300">支撑：还没有目标</span>;
  }
  return (
    <span className="text-muted-foreground">支撑：{rows.map((row) => row.label).join('；')}</span>
  );
}

function GapList({ gaps }: { gaps: readonly KnowledgeGap[] }) {
  if (gaps.length === 0) {
    return (
      <p className="text-[11px] text-emerald-700 dark:text-emerald-300">两端都已连上，可以确认。</p>
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
