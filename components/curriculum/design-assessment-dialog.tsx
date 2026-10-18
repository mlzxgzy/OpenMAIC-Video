'use client';

/**
 * 第七步「题目与实操」的 AI 对话面板：**作业与考试**。
 *
 * 左边对话，右边逐条的题目与实操，底部确认——和第六步同一副骨架。状态那一侧的重点换成
 * 了这一步唯一真正的判断：**每个产物挂在哪个条目上，以及那条承诺的"考核在这里"兑现了
 * 没有。**
 *
 * 四个刻意的决定：
 *
 * 1. **按条目分组显示，因为"挂在哪儿"就是这一步的内容。** 照题号或创建顺序平铺，一道
 *    挂错条目的题看起来和挂对的完全一样；按条目分组，错位就表现为"这个条目下有一道
 *    谁也不认识的题"。
 * 2. **挂到章/节上的产物单独列出来。** 分组只画条目，挂错地方的产物会在分组里凭空消失
 *    ——被静默丢掉的题在界面上必须留下痕迹，所以它们有一个自己的位置，并且写着它挂在哪。
 * 3. **缺口与审核结论从服务端来。** 判定跨大纲、证据和产物三份文档，在浏览器里再实现
 *    一遍就是第二份定义。
 * 4. **出错不清屏。** 模型答不出可用 JSON 时留下作者那句话，并把服务端原话显示出来。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ClipboardList,
  HelpCircle,
  Loader2,
  RotateCcw,
  Send,
  Sparkles,
  Terminal,
} from 'lucide-react';

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
  DIFFICULTY_LABELS,
  QUESTION_TYPE_LABELS,
  describeVerifyRule,
  type AssessmentGap,
} from '@/lib/curriculum/design-assessment';
import { ROLE_LABELS } from '@/lib/curriculum/design-teaching';
import { stepRef, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';
import {
  confirmAssessment,
  readAssessmentState,
  sendAssessmentTurn,
  withdrawAssessment,
  type AssessmentStatePayload,
  type AssessmentTurn,
} from '@/lib/curriculum/assessment-client';
import type {
  CurriculumLabTaskRecord,
  CurriculumQuestionRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

interface DesignAssessmentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The task whose assessments are being designed. */
  taskId: string;
  /** Anything written: the caller re-reads its own snapshot and phase. */
  onChanged?: () => void | Promise<void>;
}

function initialTurn(): AssessmentTurn {
  return {
    role: 'assistant',
    content:
      '这一步把每个条目变成可以判分的考核：题目（单选 / 多选 / 判断，要写清选项、答案和干扰项对应的误解）和实操（Docker 镜像 + 验证规则，判的是结果不是某一种解法）。每一道题、每一个实操都要说清它考哪个学习目标、由哪个条目交付——挂在讲它的那个条目上，学员才见过它。审核与导出是下一步的事。',
  };
}

const EMPTY_STATE: AssessmentStatePayload = {
  units: [],
  unitCoverage: [],
  objectives: [],
  evidence: [],
  questions: [],
  labTasks: [],
  gaps: [
    {
      kind: 'no_items',
      text: `还没有条目：题目与实操是逐条挂上去的，先到${stepRef('outline')}排出章节目`,
    },
  ],
  findings: [],
  auditFindings: [],
  confirmation: null,
  confirmed: false,
  nextPhase: null,
  phaseGaps: [],
  readyToAdvance: false,
  plan: '',
};

export function DesignAssessmentDialog({
  open,
  onOpenChange,
  taskId,
  onChanged,
}: DesignAssessmentDialogProps) {
  const [turns, setTurns] = useState<AssessmentTurn[]>([initialTurn()]);
  const [state, setState] = useState<AssessmentStatePayload>(EMPTY_STATE);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState<'send' | 'confirm' | 'withdraw' | 'load' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const listEnd = useRef<HTMLDivElement | null>(null);

  // The dialog is opened for one task at a time; `open`/`taskId` is all it keys on,
  // so switching tasks in the workbench cannot show the previous task's artifacts.
  useEffect(() => {
    if (!open) return;
    setTurns([initialTurn()]);
    setState(EMPTY_STATE);
    setError(null);
    setNotice(null);
    setWarnings([]);
    setBusy('load');
    void readAssessmentState(taskId)
      .then(setState)
      .catch((caught: unknown) => {
        setError(caught instanceof Error ? caught.message : '读取题目与实操失败');
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
      const payload = await sendAssessmentTurn({ taskId, instruction, history });
      setTurns((current) => [
        ...current,
        { role: 'assistant', content: payload.message || '已按你说的更新题目与实操。' },
      ]);
      setState(payload);
      setWarnings(payload.warnings ?? []);
      if (payload.confirmedThisTurn) {
        setNotice('已按你在对话里的确认记录：题目与实操已确认。');
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
      setState(await confirmAssessment(taskId));
      setNotice(`${STEP_WORK_NAME.assessment}已确认。下一步是${stepRef('review')}。`);
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
      setState(await withdrawAssessment(taskId));
      setNotice('已撤回确认，改完之后需要重新确认。');
      await onChanged?.();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '撤回失败');
    } finally {
      setBusy(null);
    }
  }, [onChanged, taskId]);

  const busyNow = busy !== null;
  const items = useMemo(
    () => state.units.filter((unit) => unit.unitType === 'item'),
    [state.units],
  );
  const questionsOf = useCallback(
    (unitId: string) => state.questions.filter((question) => question.unitId === unitId),
    [state.questions],
  );
  const labTasksOf = useCallback(
    (unitId: string) => state.labTasks.filter((lab) => lab.unitId === unitId),
    [state.labTasks],
  );
  // Artifacts whose home is not an item: they are exactly what the gaps above are
  // complaining about, and grouping by item would drop them off the panel.
  const misplaced = useMemo(() => {
    const itemIds = new Set(items.map((unit) => unit.id));
    return {
      questions: state.questions.filter((question) => !itemIds.has(question.unitId)),
      labTasks: state.labTasks.filter((lab) => !itemIds.has(lab.unitId)),
    };
  }, [items, state.labTasks, state.questions]);

  const gapsOf = (unitId: string): AssessmentGap[] =>
    state.gaps.filter((gap) => gap.ref === unitId);
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
            第七步：题目与实操
          </DialogTitle>
          <DialogDescription>
            给每个条目写出可以判分的考核：题目要写清选项、答案和干扰项对应的误解；实操要写清 Docker
            镜像与验证规则——验证规则判结果（flag、文件、命令输出…），参考解答只用于提示
            与复盘。每一道题、每一个实操都只能挂在承担它目标的那个目上。确认之后才允许进入
            {stepRef('review')}。
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
                  AI 正在写题目与实操…
                </div>
              ) : null}
              <div ref={listEnd} />
            </div>
            <Textarea
              className="min-h-16 text-xs"
              placeholder="例如：1.2 这个实操条目配一道练习，镜像 ctf/web-sqli，验证规则用 flag：flag{...}；1.1 出 5 道单选"
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

          {/* ── Questions and labs, per item ─────────────────────────────── */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-medium">
                题目与实操（{items.length} 个条目）｜{state.questions.length} 题、
                {state.labTasks.length} 个实操
              </span>
              <ConfirmationBadge state={state} />
            </div>
            <GapList gaps={state.gaps} />
            {items.length === 0 ? (
              <p className="text-muted-foreground border-border rounded-lg border border-dashed p-3 text-xs">
                还没有条目。章和节只做归类，能挂题目和实操的是目——先到{stepRef('outline')}
                把它们排出来。
              </p>
            ) : (
              <ul className="border-border flex max-h-80 flex-col gap-3 overflow-y-auto rounded-lg border p-3 text-xs">
                {items.map((unit) => (
                  <ItemAssessment
                    key={unit.id}
                    unit={unit}
                    questions={questionsOf(unit.id)}
                    labTasks={labTasksOf(unit.id)}
                    gaps={gapsOf(unit.id)}
                  />
                ))}
              </ul>
            )}
            {misplaced.questions.length > 0 || misplaced.labTasks.length > 0 ? (
              <MisplacedArtifacts
                units={state.units}
                questions={misplaced.questions}
                labTasks={misplaced.labTasks}
              />
            ) : null}
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
            {state.plan ? (
              <details className="border-border rounded-lg border text-[11px]">
                <summary className="text-muted-foreground cursor-pointer p-2">
                  模型看到的现状（含各产物的 id，改和删都要靠它指名）
                </summary>
                <pre className="max-h-48 overflow-auto p-2 whitespace-pre-wrap">{state.plan}</pre>
              </details>
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
            确认题目与实操
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One item: the questions and labs that hang on it. */
function ItemAssessment({
  unit,
  questions,
  labTasks,
  gaps,
}: {
  unit: CurriculumUnitRecord;
  questions: readonly CurriculumQuestionRecord[];
  labTasks: readonly CurriculumLabTaskRecord[];
  gaps: readonly AssessmentGap[];
}) {
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

      {questions.length === 0 && labTasks.length === 0 ? (
        <div className="pl-4 text-amber-700 dark:text-amber-300">还没有题目和实操</div>
      ) : null}

      <ul className="flex flex-col gap-1.5 pl-4">
        {questions.map((question) => (
          <QuestionLine key={question.id} question={question} />
        ))}
        {labTasks.map((lab) => (
          <LabLine key={lab.id} lab={lab} />
        ))}
      </ul>

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

function QuestionLine({ question }: { question: CurriculumQuestionRecord }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex items-start gap-1">
        <HelpCircle className="mt-0.5 size-3 shrink-0" />
        <span>
          <Badge variant="outline" className="mr-1 px-1 py-0 text-[10px]">
            {QUESTION_TYPE_LABELS[question.questionType]}
          </Badge>
          {question.stem}
        </span>
      </span>
      <span className="text-muted-foreground pl-4">
        答案 {question.answer.join('/') || '（空）'}
        {question.options.length > 0
          ? `｜${question.options.map((option) => `${option.key}.${option.text}`).join(' ')}`
          : ''}
        ｜{DIFFICULTY_LABELS[question.difficulty]}｜{question.score} 分
      </span>
    </li>
  );
}

function LabLine({ lab }: { lab: CurriculumLabTaskRecord }) {
  return (
    <li className="flex flex-col gap-0.5">
      <span className="flex items-start gap-1">
        <Terminal className="mt-0.5 size-3 shrink-0" />
        <span>
          <Badge
            variant={lab.assessmentMode === 'exam' ? 'default' : 'secondary'}
            className="mr-1 px-1 py-0 text-[10px]"
          >
            {ASSESSMENT_MODE_LABELS[lab.assessmentMode]}
          </Badge>
          {lab.taskGoal}
        </span>
      </span>
      <span className="text-muted-foreground pl-4">镜像 {lab.dockerImage}</span>
      {lab.verifyRules.length === 0 ? (
        <span className="pl-4 text-amber-700 dark:text-amber-300">没有验证规则：这样判不了分</span>
      ) : (
        <ul className="text-muted-foreground pl-4">
          {lab.verifyRules.map((rule, index) => (
            <li key={`${rule.kind}-${index}`}>· {describeVerifyRule(rule)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

/**
 * Artifacts that hang on a chapter, a section or nowhere at all.
 *
 * The per-item grouping above would simply not draw them, and a question that
 * vanishes from the panel is indistinguishable from a question that was never
 * written — which is exactly the failure this step exists to catch.
 */
function MisplacedArtifacts({
  units,
  questions,
  labTasks,
}: {
  units: readonly CurriculumUnitRecord[];
  questions: readonly CurriculumQuestionRecord[];
  labTasks: readonly CurriculumLabTaskRecord[];
}) {
  const titleOf = (unitId: string) =>
    units.find((unit) => unit.id === unitId)?.title ?? `不在大纲里的条目 ${unitId}`;
  return (
    <ul className="space-y-0.5 text-[11px] text-amber-700 dark:text-amber-300">
      <li className="flex items-center gap-1 font-medium">
        <ClipboardList className="size-3" />
        挂错位置的产物（不挂在目上，学员的考核闭环里读不到它）
      </li>
      {questions.map((question) => (
        <li key={question.id} className="pl-4">
          · 题目「{question.stem}」挂在「{titleOf(question.unitId)}」
        </li>
      ))}
      {labTasks.map((lab) => (
        <li key={lab.id} className="pl-4">
          · 实操「{lab.taskGoal}」挂在「{titleOf(lab.unitId)}」
        </li>
      ))}
    </ul>
  );
}

function ConfirmationBadge({ state }: { state: AssessmentStatePayload }) {
  if (!state.confirmation) return <Badge variant="outline">未确认</Badge>;
  return (
    <Badge className="gap-1">
      <Check className="size-3" />
      {state.confirmation.confirmedBy === 'user' ? '你已确认' : '对话中确认'}
    </Badge>
  );
}

function GapList({ gaps }: { gaps: readonly AssessmentGap[] }) {
  // Gaps belonging to one item are shown beside it; these are the ones that belong
  // to the step as a whole (no items at all), so the list is not doubled up.
  const overall = gaps.filter((gap) => gap.ref === undefined);
  if (overall.length === 0) {
    return (
      <p className="text-[11px] text-emerald-700 dark:text-emerald-300">
        每个承诺要考核的目标都有题目或实操接着，都挂在承担它的条目上，实操都有能判分的验证规则。
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
