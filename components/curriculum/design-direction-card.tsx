'use client';

/**
 * 工作台里的「课程方向」卡片：第一步的编辑与确认面。
 *
 * 这块补的是一个真实的洞。此前七个字段只有列表页那个一次性表单和 agent 工具能
 * 写，`design-task-list.tsx` 的注释说它们"创建后在任务本身上编辑"——而那个编辑
 * 界面并不存在，任务建完之后方向就再也改不动了。现在它在这里：逐格编辑、显式
 * 保存、确认、撤回，以及打开 AI 对话继续聊。
 *
 * 三个决定：
 *
 * 1. **写走工作台唯一的写入路径。** 每格用 `InlineEdit` 显式保存，并通过父组件
 *    的 `run` 提交，于是报错和"已保存"提示与其它区块共用同一条通道，而不是这块
 *    卡片自己发明一套提示。
 * 2. **确认按钮的条件来自服务端。** 缺口由快照里的字段算
 *    （`directionGaps`），阶段是否就绪由工作台读到的 `phaseGaps` 说。禁用状态
 *    永远带一句原因，理由同 `design-editing.ts`：点下去才被拒是最差的告知时机。
 * 3. **改了就退回未确认。** 这是 store 的规则（改字段即撤回确认），卡片必须把它
 *    显示出来——否则用户会以为改完之后门禁还开着。
 */
import { useState } from 'react';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DesignDirectionDialog } from '@/components/curriculum/design-direction-dialog';
import { InlineEdit } from '@/components/curriculum/design-workbench-forms';
import {
  CURRICULUM_DIRECTION_FIELDS,
  directionGaps,
  directionValuesOf,
} from '@/lib/curriculum/design-direction';
import {
  confirmDirection,
  patchTaskBrief,
  withdrawDirection,
} from '@/lib/curriculum/direction-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumTaskRecord,
} from '@/lib/curriculum/design-types';

interface DesignDirectionCardProps {
  task: CurriculumTaskRecord;
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

/** One field's value as the PATCH body wants it, or a refusal to show the author. */
function briefPatchValue(
  field: (typeof CURRICULUM_DIRECTION_FIELDS)[number],
  next: string,
): string | number | null {
  const trimmed = next.trim();
  if (trimmed === '') return null;
  if (field.kind !== 'number') return trimmed;
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${field.label}要填数字，例如 48。`);
  }
  return parsed;
}

export function DesignDirectionCard({
  task,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignDirectionCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const values = directionValuesOf(task);
  const gaps = directionGaps(values);
  const complete = gaps.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex items-center gap-2 text-base">
              课程方向（第一步）
              {confirmation ? (
                <Badge className="gap-1">
                  <Check className="size-3" />
                  {confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
                </Badge>
              ) : (
                <Badge variant="outline">未确认</Badge>
              )}
            </CardTitle>
            <CardDescription>
              受众、范围、基础、场景、时长。七个字段随时可改；改过之后需要重新确认，确认后阶段门禁才会打开。
            </CardDescription>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setDialogOpen(true)}
            disabled={busy !== null}
          >
            <Sparkles />用 AI 修改方向
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-3 md:grid-cols-2">
          {CURRICULUM_DIRECTION_FIELDS.map((field) => {
            const value = values[field.key];
            return (
              <div
                key={field.key}
                className={field.kind === 'textarea' ? 'md:col-span-2' : undefined}
              >
                <InlineEdit
                  rowId={task.id}
                  field={field.key}
                  label={`${field.label}${field.required ? ' *' : ''}`}
                  value={value === null ? '' : String(value)}
                  placeholder={field.hint}
                  multiline={field.kind === 'textarea'}
                  busyKey={`direction:${field.key}`}
                  busy={busy}
                  onSave={(next) =>
                    run(`direction:${field.key}`, async () => {
                      await patchTaskBrief(task.id, {
                        [field.key]: briefPatchValue(field, next),
                      });
                      return `已更新「${field.label}」。`;
                    })
                  }
                />
              </div>
            );
          })}
        </div>

        {gaps.length > 0 ? (
          <p className="text-muted-foreground text-[11px]">还差：{gaps.join('；')}</p>
        ) : (
          <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
            必填项已齐{confirmation ? '，且已确认' : '，可以确认'}。
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            disabled={busy !== null || confirmation !== null || !complete}
            title={
              confirmation
                ? '已经确认'
                : !complete
                  ? `还差：${gaps.join('；')}`
                  : '确认课程方向，进入学习目标阶段'
            }
            onClick={() =>
              void run('direction:confirm', async () => {
                await confirmDirection(task.id);
                return '课程方向已确认。下一步是学习目标。';
              })
            }
          >
            {busy === 'direction:confirm' ? <Loader2 className="animate-spin" /> : <Check />}
            确认课程方向
          </Button>
          {confirmation ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null}
              onClick={() =>
                void run('direction:withdraw', async () => {
                  await withdrawDirection(task.id);
                  return '已撤回确认；改完之后需要重新确认。';
                })
              }
            >
              {busy === 'direction:withdraw' ? <Loader2 className="animate-spin" /> : <RotateCcw />}
              撤回确认
            </Button>
          ) : null}
          {confirmation ? (
            <span className="text-muted-foreground text-[11px]">
              确认于 {new Date(confirmation.confirmedAt).toLocaleString()}
            </span>
          ) : null}
        </div>
      </CardContent>

      <DesignDirectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        taskId={task.id}
        onChanged={onRefresh}
      />
    </Card>
  );
}
