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
import Link from 'next/link';
import { Check, Loader2, RotateCcw, Sparkles } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { DesignDirectionDialog } from '@/components/curriculum/design-direction-dialog';
import { InlineEdit } from '@/components/curriculum/design-workbench-forms';
import {
  CURRICULUM_DIRECTION_FIELDS,
  directionGaps,
  directionValuesOf,
  effectiveDirectionValues,
} from '@/lib/curriculum/design-direction';
import {
  confirmDirection,
  patchTaskBrief,
  withdrawDirection,
} from '@/lib/curriculum/direction-client';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumSeriesDirectionRecord,
  CurriculumTaskRecord,
} from '@/lib/curriculum/design-types';
import { StepBadge } from '@/components/curriculum/step-rail';
import { STEP_OWNERSHIP } from '@/lib/curriculum/step-ownership';
import { stepRef, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';

interface DesignDirectionCardProps {
  task: CurriculumTaskRecord;
  /**
   * 所属系列的方向。目留空的受众 / 基础 / 场景 / 学时由它回退，与门禁读的是
   * 同一个有效值；`title` 与 `problemStatement` 不继承。
   */
  seriesDirection: CurriculumSeriesDirectionRecord | null;
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
  seriesDirection,
  confirmation,
  run,
  busy,
  onRefresh,
}: DesignDirectionCardProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  /**
   * 有系列时，默认**只读**显示继承来的方向。
   *
   * 这一格原来是七个可编辑输入框，于是用户进到某一目看到"课程方向"就以为要在
   * 这里重填一遍受众——他的原话是「咋又是课程方向和目标和大纲」。这些字段属于
   * 整个系列，目默认继承；只有本目确实不同才需要点开覆盖。
   */
  const [overrideOpen, setOverrideOpen] = useState(false);
  const values = directionValuesOf(task);
  const seriesOwned = task.seriesId !== null;
  // 显示与"还缺什么"都用有效值：系列填了受众而目不填，这里就不该再报缺。
  const effective = effectiveDirectionValues(values, seriesDirection);
  const gaps = directionGaps(effective);
  const complete = gaps.length === 0;

  return (
    <Card>
      <CardHeader>
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-col gap-1">
            <CardTitle className="flex flex-wrap items-center gap-2 text-base">
              {/* 序号角标与七步条里的圆圈是同一个数字（`STEP_NUMBER`），文案里不再
                  写"（第一步）"——那是同一件事的第二种说法，改一处就会漏一处。 */}
              <StepBadge phase="task" currentPhase={task.designPhase} />
              课程方向
              {seriesOwned ? (
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  系列层
                </Badge>
              ) : null}
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
              {seriesOwned
                ? STEP_OWNERSHIP.task.note
                : '受众、范围、基础、场景、时长。七个字段随时可改；改过之后需要重新确认，确认后阶段门禁才会打开。'}
            </CardDescription>
            {task.seriesId ? (
              <p className="text-muted-foreground text-xs">
                默认继承系列；本目确实不同时再点右边「覆盖」。改系列方向请去
                <Link
                  href={`/curriculum/series/${task.seriesId}/design`}
                  className="text-foreground ml-1 underline underline-offset-2"
                >
                  系列设计页
                </Link>
                。
              </p>
            ) : null}
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
        {seriesOwned ? (
          <div className="border-border bg-muted/20 rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-muted-foreground text-[11px]">
                这一目继承的课程方向（来自系列）。值只在系列设计页维护。
              </p>
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null}
                onClick={() => setOverrideOpen((current) => !current)}
              >
                {overrideOpen ? '收起覆盖项' : '本目确实不同，覆盖'}
              </Button>
            </div>
            <dl className="mt-2 grid gap-x-6 gap-y-1.5 text-xs md:grid-cols-2">
              {CURRICULUM_DIRECTION_FIELDS.map((field) => {
                const value = effective[field.key];
                /**
                 * 来源按**值**判断，而不是"目里那一列是不是空"。
                 *
                 * 建目时会把系列方向复制进任务行（审核与提示词都直接读任务行），
                 * 于是"列非空"并不等于"作者改过"。拿值和系列比一次能说清来源：
                 * 与系列相同的标「系列」，与系列不同的才可能是本目改的。
                 */
                const fromSeries =
                  seriesDirection !== null &&
                  field.key !== 'title' &&
                  seriesDirection[field.key as keyof typeof seriesDirection] === value &&
                  value !== null;
                return (
                  <div key={field.key} className="flex min-w-0 gap-1.5">
                    <dt className="text-muted-foreground shrink-0">
                      {field.key === 'title' ? '本目标题' : field.label}
                    </dt>
                    <dd className="min-w-0 break-words">
                      {value === null ? (
                        <span className="text-destructive">未填写</span>
                      ) : (
                        String(value)
                      )}
                      {field.key !== 'title' ? (
                        <span className="text-muted-foreground ml-1 text-[10px]">
                          {value === null ? '' : fromSeries ? '（系列）' : '（本目改过）'}
                        </span>
                      ) : null}
                    </dd>
                  </div>
                );
              })}
            </dl>
            {gaps.length > 0 ? (
              <p className="text-destructive mt-2 text-[11px]">
                系列方向还差：{gaps.join('；')}。去
                <Link
                  href={`/curriculum/series/${task.seriesId}/design`}
                  className="underline underline-offset-2"
                >
                  系列设计页
                </Link>
                补一次，所有目都会跟着齐。
              </p>
            ) : null}
          </div>
        ) : null}

        <div
          className={cn('grid gap-3 md:grid-cols-2', seriesOwned && !overrideOpen ? 'hidden' : '')}
        >
          {CURRICULUM_DIRECTION_FIELDS.map((field) => {
            const raw = values[field.key];
            const value = effective[field.key];
            const inherited = raw === null && value !== null && seriesDirection !== null;
            return (
              <div
                key={field.key}
                className={field.kind === 'textarea' ? 'md:col-span-2' : undefined}
              >
                <InlineEdit
                  rowId={task.id}
                  field={field.key}
                  label={`${field.label}${field.required ? ' *' : ''}${
                    inherited ? '（继承系列）' : ''
                  }`}
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
                  : `确认${STEP_WORK_NAME.task}，进入${stepRef('outcomes')}`
            }
            onClick={() =>
              void run('direction:confirm', async () => {
                await confirmDirection(task.id);
                return `${STEP_WORK_NAME.task}已确认。下一步是${stepRef('outcomes')}。`;
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
