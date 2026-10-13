'use client';

/**
 * 工作台里"这一栏 AI 副驾"的落位件：把 {@link StepCopilot} 与它需要的三样东西装在一起。
 *
 * 它存在的理由是**四份配置不该在四个地方各写一遍**：每一步要给出起草路径、示例指令、
 * "现在库里是什么"那句话，以及删除冲突的判定。四处各写一遍的结果是"考核那一步忘了传
 * 冲突判定"，而那个遗漏在界面上表现为"删掉和改写同一道题时两个按钮都能按"——一个只有
 * 作者真的那么干了才会发现的 bug。
 *
 * `blocked` 由**纯函数**在渲染时现算，而不是由调用方存成 state：它是"这份草稿 + 当前库"
 * 的函数，存在 state 里就有一份会过期的副本，而过期的冲突判定会把一个该灰掉的按钮放开。
 */

import { StepCopilot } from '@/components/curriculum/step-copilot';
import type { StepDraft, StepDraftLive } from '@/lib/curriculum/step-draft';

export interface StepCopilotSlotProps {
  taskId: string;
  /** 起草路径的最后一段，例如 `outcomes` → `.../outcomes/draft`。 */
  step: 'outcomes' | 'outline' | 'teaching' | 'assessment';
  heading: string;
  examples: readonly string[];
  /** 面板底部那句"现在库里有 N 个…"。 */
  contextLine?: string;
  /** 整表替换那一类行在采纳那一刻要的当前库。 */
  live: StepDraftLive;
  /**
   * 冲突判定：给出行 id → 人话理由。返回空对象表示这一步没有删除冲突
   * （第五步"教学内容"就是这种：它只 PATCH，不删不建）。
   */
  conflicts?: (draft: StepDraft) => Record<string, string>;
  /** 采纳成功之后刷新左栏。 */
  onAdopted: () => Promise<void>;
}

export function StepCopilotSlot({
  taskId,
  step,
  heading,
  examples,
  contextLine,
  live,
  conflicts,
  onAdopted,
}: StepCopilotSlotProps) {
  return (
    <StepCopilot
      draftRoute={`/api/curriculum/design/tasks/${taskId}/${step}/draft`}
      heading={heading}
      examples={examples}
      {...(contextLine === undefined ? {} : { contextLine })}
      live={live}
      {...(conflicts === undefined ? {} : { conflicts })}
      onAdopted={onAdopted}
    />
  );
}
