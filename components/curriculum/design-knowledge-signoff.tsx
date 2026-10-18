'use client';

/**
 * 工作台里「知识技能与依赖」的签收条：确认、撤回、打开 AI 对话。
 *
 * 与第二步的签收条同一副骨架、同一处位置：**嵌在那张卡片的头部**，而不是和它并排
 * 一张新卡——它们是同一张图的两个面。
 *
 * 确认按钮的可用条件完全来自服务端给的 `gaps`。这一步的"完整"比第二步更强：
 * 缺口条会同时点名**两端**——没有目标的节点（不会被讲），没有节点的目标（没东西
 * 可讲）——所以按钮灰掉时，作者看到的不只是"少一个知识点"，而是"少了哪一头"。
 */
import { useMemo, useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DesignKnowledgeDialog } from '@/components/curriculum/design-knowledge-dialog';
import { knowledgeGapsOfRecords } from '@/lib/curriculum/design-knowledge';
import { confirmKnowledge, withdrawKnowledge } from '@/lib/curriculum/knowledge-client';
import { stepRef, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumLearningNodeRecord,
  CurriculumNodeObjectiveRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';

interface DesignKnowledgeSignOffProps {
  taskId: string;
  nodes: readonly CurriculumLearningNodeRecord[];
  nodeObjectives: readonly CurriculumNodeObjectiveRecord[];
  objectives: readonly CurriculumObjectiveRecord[];
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

export function DesignKnowledgeSignOff({
  taskId,
  nodes,
  nodeObjectives,
  objectives,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignKnowledgeSignOffProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  // Gaps computed from the same snapshot the list is rendered from, so the strip
  // can never claim the graph is connected while the list below shows a bare node.
  const gaps = useMemo(
    () =>
      knowledgeGapsOfRecords(
        nodes.map((row) => ({ id: row.id, name: row.name, nodeType: row.nodeType })),
        nodeObjectives,
        objectives.map((row) => ({ id: row.id, title: row.title })),
      ),
    [nodes, nodeObjectives, objectives],
  );
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
            void run('knowledge:confirm', async () => {
              await confirmKnowledge(taskId);
              return `${STEP_WORK_NAME.graph}已确认。下一步是${stepRef('outline')}。`;
            })
          }
          disabled={busy !== null || confirmation !== null || !complete}
          title={
            confirmation
              ? '已经确认'
              : !complete
                ? `还差：${gaps.map((gap) => gap.text).join('；')}`
                : `确认${STEP_WORK_NAME.graph}，进入${stepRef('outline')}`
          }
        >
          {busy === 'knowledge:confirm' ? <Loader2 className="animate-spin" /> : <Check />}
          确认{STEP_WORK_NAME.graph}
        </Button>
        {confirmation ? (
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              void run('knowledge:withdraw', async () => {
                await withdrawKnowledge(taskId);
                return '已撤回确认；改完之后需要重新确认。';
              })
            }
            disabled={busy !== null}
          >
            {busy === 'knowledge:withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
            撤回确认
          </Button>
        ) : null}
        <Button
          size="sm"
          variant="outline"
          onClick={() => setDialogOpen(true)}
          disabled={busy !== null}
        >
          <Sparkles />用 AI 拆解知识技能点
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
          每个知识点都有目标、每个目标都有知识点，且已确认。
        </p>
      ) : (
        <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
          两端都已连上，可以确认。
        </p>
      )}

      <DesignKnowledgeDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        taskId={taskId}
        onChanged={onRefresh}
      />
    </div>
  );
}
