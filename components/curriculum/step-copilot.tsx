'use client';

/**
 * 通用的「让 AI 帮你起草」右栏：出草稿、逐行签字，不替作者改任何东西。
 *
 * 骨架是一条硬规则：**左边是决定，右边是建议；右边写的每一样都要人在左边再确认一次。**
 * 所以这个面板没有任何一个按钮能改库——它只有"让 AI 起草"和"丢掉草稿"，行上的采纳由
 * {@link applyStepLineWrites} 发出，而那些写入都是**已经存在的手工路由**。
 *
 * 这不是多此一举：那些路由里有阶段校验、端点归属校验和"整表替换链接"的那条规则，让草稿
 * 走它们，采纳和手工编辑就是**同一件事**，也就没有"AI 那条路少了一层校验"这种差异要记得。
 *
 * 它取代 B2 试点里那个写死了知识技能图的 `KnowledgeCopilot`。通用化之后仍然只认
 * {@link StepDraftLine}，而它不认识任何领域概念——所以同一副面板装得下目标、大纲、教案、
 * 考核和知识点五个步骤，代价是每个领域要写一个把结果算成行的转换函数。
 *
 * 三个刻意的决定：
 *
 * 1. **模型说的话不叫"建议"，叫草稿；每一行都是一条可点的行，不是一段散文。** 一段散文
 *    没法逐行同意，而"整段一起接受"就是这次要取消的那个按钮。
 * 2. **灰掉的行必须写为什么。** 要等别的行落地、或与一次删除冲突时不可按，理由由纯函数
 *    给出，这个组件只负责显示，不自己判断。
 * 3. **失败的采纳不吞。** 起草失败与采纳失败都把服务端原话显示出来，因为"AI 什么都没说"
 *    和"AI 说了一句你没看懂的话"要能被分开——而"库没改"与"库改了"更是。
 */

import { useCallback, useMemo, useState } from 'react';
import { AlertTriangle, Check, Loader2, RotateCcw, Sparkles, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { applyStepLineWrites } from '@/lib/curriculum/step-adopt';
import {
  EMPTY_STEP_DRAFT_LINES,
  stepLineAvailability,
  stepLineBlockedBy,
  type StepDraft,
  type StepDraftLine,
  type StepDraftLineStatus,
  type StepDraftLive,
} from '@/lib/curriculum/step-draft';

export interface StepCopilotProps {
  /** 打这个草稿的路由，由各步骤自己给（`.../outcomes/draft` 之类）。 */
  draftRoute: string;
  /** 这一栏的标题，界面上要能一眼看出它在帮哪一步。 */
  heading: string;
  /** 起草指令的具体示例，而不是"你想让它做什么？"的开放式提问。 */
  examples: readonly string[];
  /**
   * 现在库里的样子，只用来在面板底部说一句"图上现有 N 个…"。**不参与判定**。
   *
   * 刻意不让面板自己读库：它一旦读，就会有一份可能过期的副本，而"草稿基于哪一刻的库"
   * 这个问题只有服务端答得准（草稿的回包就带着那一刻的图）。
   */
  contextLine?: string;
  /** 整表替换那一类行在采纳那一刻要的当前库。 */
  live: StepDraftLive;
  /**
   * 冲突判定：给出草稿，返回"行 id → 人话理由"。
   *
   * **在渲染时现算，而不是由调用方存成 state**：它是"这份草稿"与"库里有没有被删的东西"
   * 的函数，存成 state 就有一份会过期的副本——而过期的判定会把一个该灰掉的按钮放开，
   * 作者按下去才发现它和一次删除打架。
   *
   * 可选，且**可省略**：第五步"教学内容"只 PATCH、不删不建，所以它没有冲突可言，缺省
   * 就是"没有冲突"，而不是"算一遍所有行"。
   */
  conflicts?: (draft: StepDraft) => Record<string, string>;
  /** 采纳成功之后刷新左栏。 */
  onAdopted: () => Promise<void>;
}

/** 与 `EMPTY_STEP_DRAFT_LINES` 同一个理由：一个稳定的空引用。 */
const EMPTY_BLOCKED: Readonly<Record<string, string>> = {};

/** 同上，但这一份是**话**而不是行——类型不同，所以不能借用行的那一个空引用。 */
const EMPTY_MESSAGES: readonly string[] = [];

export function StepCopilot({
  draftRoute,
  heading,
  examples,
  contextLine,
  live,
  conflicts,
  onAdopted,
}: StepCopilotProps) {
  const [draft, setDraft] = useState<StepDraft | null>(null);
  const [statuses, setStatuses] = useState<Record<string, StepDraftLineStatus>>({});
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [producedIds, setProducedIds] = useState<Record<string, string>>({});
  const [instruction, setInstruction] = useState('');
  const [busy, setBusy] = useState<'draft' | 'adopt' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = useCallback(() => {
    setDraft(null);
    setStatuses({});
    setEdits({});
    setProducedIds({});
    setNotice(null);
    setError(null);
  }, []);

  const draftIt = useCallback(async () => {
    const text = instruction.trim();
    if (text === '' || busy) return;
    setBusy('draft');
    setError(null);
    setNotice(null);
    try {
      const response = await fetch(draftRoute, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ instruction: text, history: [] }),
      });
      const payload = (await response.json().catch(() => null)) as {
        draft?: StepDraft;
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.draft) {
        throw new Error(payload?.error?.message ?? `起草失败：HTTP ${response.status}`);
      }
      setDraft(payload.draft);
      // 重新起草就是重新开始：旧草稿的行 id 与新草稿的不是一回事，留着旧的采纳记录
      // 会把"这一行按过了"套到另一行上。
      setStatuses({});
      setEdits({});
      setProducedIds({});
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '起草失败');
    } finally {
      setBusy(null);
    }
  }, [busy, draftRoute, instruction]);

  const decide = useCallback((id: string, status: StepDraftLineStatus) => {
    setStatuses((current) => ({ ...current, [id]: status }));
    setNotice(null);
  }, []);

  const adopt = useCallback(
    async (line: StepDraftLine) => {
      setBusy('adopt');
      setError(null);
      setNotice(null);
      try {
        const produced = await applyStepLineWrites({
          line,
          state: { producedIds, edits, statuses },
          live,
        });
        if (produced !== null) {
          setProducedIds((current) => ({ ...current, [line.id]: produced }));
        }
        await onAdopted();
        decide(line.id, 'adopted');
        setNotice('已采纳这一行，左栏已经改好。');
      } catch (caught) {
        // 失败抛回右栏，右栏才有资格决定"这一行算不算已采纳"——采纳记录与存储必须由
        // 同一次结果决定，否则状态和事实会各说各话。
        setError(caught instanceof Error ? caught.message : '采纳失败');
      } finally {
        setBusy(null);
      }
    },
    [decide, edits, live, onAdopted, producedIds, statuses],
  );

  // `EMPTY_STEP_DRAFT_LINES` 而不是 `?? []`：空数组字面量每次渲染都是新引用，会让下面这个
  // `useMemo` 的依赖在每一帧都变，于是它算出同样的答案而下游以为它变了。
  const lines = draft?.lines ?? EMPTY_STEP_DRAFT_LINES;
  /**
   * 与 {@link EMPTY_STEP_DRAFT_LINES} 同一个理由，另加一条：**少了 `warnings` 的草稿不能把
   * 整页打死。** 一份形状不对的回包（比如某个 mock、或某个版本的服务端）会让
   * `draft.warnings.length` 抛在渲染里，而这一页同时挂着五个面板——一个字段的缺失会变成整页
   * 的 Runtime TypeError 盖住所有东西，作者连"哪一步出错"都看不到。
   */
  const warnings = draft?.warnings ?? EMPTY_MESSAGES;
  const blocked = useMemo(
    () => (draft && conflicts ? conflicts(draft) : EMPTY_BLOCKED),
    [conflicts, draft],
  );
  /**
   * 作者**还要决定**的行数。
   *
   * 说明行不算：它没有采纳这回事，所以永远是"未处理"。把它数进去的后果是这句计数永远到不了
   * 零——作者把所有能按的行都处理完之后，右栏仍然写着"还有 1 行等你决定"，而那一行上没有一个
   * 按钮。这类"状态永远说不清"正是这次大修要消灭的东西。
   */
  const pending = useMemo(
    () => lines.filter((line) => line.note === undefined && statuses[line.id] === undefined).length,
    [lines, statuses],
  );

  return (
    <div className="flex flex-col gap-3" aria-label={`${heading}（AI 草稿）`}>
      <div className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{heading}</h3>
        <Textarea
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder="说一句你要它起草什么"
          rows={3}
          aria-label="给 AI 的起草指令"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            onClick={() => void draftIt()}
            disabled={busy !== null || instruction.trim() === ''}
          >
            {busy === 'draft' ? <Loader2 className="animate-spin" /> : <Sparkles />}让 AI 起草
          </Button>
          {draft ? (
            <Button size="sm" variant="outline" onClick={reset} disabled={busy !== null}>
              <RotateCcw />
              丢掉这份草稿
            </Button>
          ) : null}
        </div>
        {!draft && instruction.trim() === '' ? (
          <ul className="text-muted-foreground flex flex-col gap-1 text-[11px]">
            {examples.map((example) => (
              <li key={example}>
                <button
                  type="button"
                  className="underline-offset-2 hover:underline"
                  onClick={() => setInstruction(example)}
                >
                  {example}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      {error ? (
        <p className="text-destructive flex items-start gap-1 text-[11px]" role="alert">
          <AlertTriangle className="mt-0.5 size-3 shrink-0" />
          {error}
        </p>
      ) : null}
      {notice ? <p className="text-[11px]">{notice}</p> : null}

      {draft ? (
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-[11px]">
            按「{draft.instruction}」起草。草稿一行都不写进库；你按哪一行，它才改哪一行。
            {pending > 0 ? `还有 ${pending} 行等你决定。` : '这一份已经逐行处理完。'}
          </p>
          {draft.message ? <p className="text-[11px]">{draft.message}</p> : null}
          {warnings.length > 0 ? (
            <ul className="text-muted-foreground flex flex-col gap-0.5 text-[11px]">
              {warnings.map((warning) => (
                <li key={warning}>⚠ {warning}</li>
              ))}
            </ul>
          ) : null}
          <ul className="flex flex-col gap-1.5">
            {lines.map((line) => {
              const { availability, reason } = stepLineAvailability(line, {
                statuses,
                producedIds,
              });
              return (
                <DraftLine
                  key={line.id}
                  line={line}
                  blockedReason={blocked[line.id]}
                  blockedBy={stepLineBlockedBy(line, lines)}
                  availability={availability}
                  reason={reason}
                  status={statuses[line.id]}
                  edit={edits[line.id]}
                  busy={busy === 'adopt'}
                  onEdit={(value) => setEdits((current) => ({ ...current, [line.id]: value }))}
                  onAdopt={() => void adopt(line)}
                  onDrop={() => decide(line.id, 'dropped')}
                  onRestore={() => decide(line.id, 'pending')}
                />
              );
            })}
          </ul>
        </div>
      ) : null}

      {contextLine ? <p className="text-muted-foreground text-[11px]">{contextLine}</p> : null}
    </div>
  );
}

function DraftLine({
  line,
  availability,
  reason,
  status,
  edit,
  blockedBy,
  blockedReason,
  busy,
  onEdit,
  onAdopt,
  onDrop,
  onRestore,
}: {
  line: StepDraftLine;
  availability: 'ready' | 'waiting' | 'done';
  reason: string;
  status: StepDraftLineStatus | undefined;
  edit: string | undefined;
  blockedBy: string[];
  blockedReason: string | undefined;
  busy: boolean;
  onEdit: (value: string) => void;
  onAdopt: () => void;
  onDrop: () => void;
  onRestore: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const isNote = line.note !== undefined;
  const disabled = busy || availability !== 'ready' || blockedReason !== undefined;
  const why = blockedReason ?? reason;

  return (
    <li
      className="border-border flex flex-col gap-1.5 rounded-lg border p-2"
      data-line-id={line.id}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <span className="min-w-0 flex-1 text-[11px]">
          {isNote ? (
            <span className="text-muted-foreground">{line.text}</span>
          ) : (
            <span className="block break-words">{line.text}</span>
          )}
        </span>
        {status === 'adopted' ? (
          <Badge variant="outline" className="gap-1 px-1 py-0 text-[10px]">
            <Check className="size-3" />
            已采纳
          </Badge>
        ) : status === 'dropped' ? (
          <Badge variant="outline" className="gap-1 px-1 py-0 text-[10px]">
            <X className="size-3" />
            已丢弃
          </Badge>
        ) : null}
      </div>

      {line.detail ? <p className="text-muted-foreground text-[11px]">{line.detail}</p> : null}

      {!isNote && line.name !== undefined && editing ? (
        <Input
          value={edit ?? line.name}
          onChange={(event) => onEdit(event.target.value)}
          aria-label="改一改这一行的名称"
        />
      ) : null}

      {!isNote && status !== 'adopted' && status !== 'dropped' ? (
        <div className="flex flex-wrap items-center gap-1.5">
          <Button size="xs" onClick={onAdopt} disabled={disabled} title={why || '按这一行写入左栏'}>
            {busy ? <Loader2 className="animate-spin" /> : <Check />}
            采纳
          </Button>
          {line.name !== undefined ? (
            <Button size="xs" variant="outline" onClick={() => setEditing((v) => !v)}>
              改一改
            </Button>
          ) : null}
          <Button size="xs" variant="outline" onClick={onDrop}>
            丢弃
          </Button>
        </div>
      ) : null}

      {status === 'dropped' ? (
        <Button size="xs" variant="outline" onClick={onRestore}>
          撤销丢弃
        </Button>
      ) : null}

      {!isNote && (availability === 'waiting' || blockedReason !== undefined) ? (
        <p className="text-muted-foreground text-[10px]" title={blockedBy.join(',')}>
          ⓘ {blockedReason ?? reason}
        </p>
      ) : null}
    </li>
  );
}
