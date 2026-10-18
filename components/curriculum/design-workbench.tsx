'use client';

/**
 * The design workbench: the editing half of `/curriculum/design/[id]`.
 *
 * Until now the design screens could be read, reviewed and advanced, and nothing
 * could be typed into them. Every row had to arrive from the agent tools or a
 * hand-written POST, which made the reverse-design model something you watched
 * rather than something you did. This is the half that lets you do it — and the
 * path from a brief to a producible course now runs entirely inside the browser.
 *
 * Four decisions carry the component, and each one exists because of a specific
 * way the earlier rounds went wrong.
 *
 * **1. What may be typed is decided in one place, not per section.**
 * {@link authoringAvailability} answers it, transcribed from the store's own
 * `assertPhase` calls and pinned against the live store by
 * `tests/curriculum/design-editing.test.ts`. Sections do not compute it. A create
 * button the server answers 409 to after the click is the same defect as the dead
 * paths removed in the previous rounds, wearing a new screen; deriving the answer
 * once and sharing it is the only reliable way to avoid re-creating it.
 *
 * **2. Editing is never gated; creating always is.**
 * This mirrors the store, which gates `create*`/`set*` and never `update*`/
 * `delete*`, because "a course being revised should not be frozen at the phase it
 * first reached". A task sitting in `review` with one bad objective has to be
 * able to delete it. Delete buttons stay live at every phase, and the gate only
 * ever closes *adding* something.
 *
 * **3. Cross-record references are chosen, not pasted.**
 * Questions attach to an outcome and a coverage unit; a node supports an
 * objective; a dependency joins two of them. Every one of those is a foreign key
 * the author has no reason to know, so the form offers a `<select>` of real
 * rows. This is the specific reason this could not be built out of `window.prompt`
 * dialogs: a dialog asking for a raw id is the HTTP API wearing a UI.
 *
 * **4. Coverage is written as one set, with an explicit save.**
 * The store replaces a task's whole coverage inside a single transaction, so a
 * partially applied edit would show a closed loop that does not exist. It is
 * therefore the one section that stages its edits and saves explicitly, rather
 * than writing on click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  GitBranch,
  Link2,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
/**
 * 第二步的冲突判定：删除与改写同一个目标时，改写那一行不可按。
 *
 * 包一层是因为 {@link outcomesDraftConflicts} 说的是"谁挡了谁"（一个数组），而面板要的是
 * "行 id → 人话理由"（一个对象）。转换放在这里而不是面板里，是因为它每渲染一次都要算，
 * 放进 `useMemo` 就等于给一个纯函数套一层没有意义的缓存。
 */
const outcomesConflicts = (draft: StepDraft): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const one of outcomesDraftConflicts(draft)) {
    out[one.lineId] = '这一条已经被这一轮删掉了，按它会把它改回来。';
  }
  return out;
};

/**
 * 整表替换那几类行在采纳那一刻要的当前库。
 *
 * 一个稳定的空引用而不是 `{}` 字面量：它会进 `StepCopilot` 的 `useMemo` 依赖，字面量每次
 * 渲染都是新引用，于是它算出同样的答案而下游以为它变了。
 */
const emptyLive = { nodeObjectives: [], unitCoverage: [] } as const;

import Link from 'next/link';

import { DesignDirectionCard } from '@/components/curriculum/design-direction-card';
import { SeriesInheritPanel } from '@/components/curriculum/series-inherit-panel';
import { StepBadge } from '@/components/curriculum/step-rail';
import { DesignOutcomesSignOff } from '@/components/curriculum/design-outcomes-signoff';
import { DesignKnowledgeSignOff } from '@/components/curriculum/design-knowledge-signoff';
import { StepCopilot } from '@/components/curriculum/step-copilot';
import { StepCopilotSlot } from '@/components/curriculum/step-copilot-slot';
import { outcomesDraftConflicts } from '@/lib/curriculum/outcomes-draft';
import { assessmentDraftConflicts } from '@/lib/curriculum/assessment-draft';
import type { StepDraft } from '@/lib/curriculum/step-draft';
import { DesignOutlineSignOff } from '@/components/curriculum/design-outline-signoff';
import { DesignTeachingSignOff } from '@/components/curriculum/design-teaching-signoff';
import { DesignAssessmentSignOff } from '@/components/curriculum/design-assessment-signoff';
import { ASSIGNED_NODE_BUCKETS, TEACHING_DEPTH_LABELS } from '@/lib/curriculum/design-teaching';
import { ITEM_OWNED_PHASES, SERIES_OWNED_PHASES } from '@/lib/curriculum/step-ownership';
import {
  ASSESSMENT_MODE_LABELS,
  DIFFICULTY_LABELS,
  QUESTION_TYPE_LABELS,
  describeVerifyRule,
} from '@/lib/curriculum/design-assessment';
import {
  CreateForm,
  InlineEdit,
  type FormField,
  type FormValues,
} from '@/components/curriculum/design-workbench-forms';
import { authoringAvailability } from '@/lib/curriculum/design-editing';
import { stepRef, STEP_NUMBER, STEP_WORK_NAME } from '@/lib/curriculum/ui-labels';
import {
  EXAM_FORCED_VALUES,
  LAB_VERIFY_KINDS,
  labVerifyKindLabel,
  labVerifyRuleFrom,
  labVerifyTargetOf,
  type LabVerifyKind,
} from '@/lib/curriculum/lab-authoring';
import type {
  CurriculumCoverageKind,
  CurriculumDesignPhase,
  CurriculumDesignSnapshot,
  CurriculumEvidenceRecord,
  CurriculumLearningNodeRecord,
  CurriculumObjectiveRecord,
  CurriculumUnitRecord,
  LabVerifyRule,
} from '@/lib/curriculum/design-types';

interface DesignWorkbenchProps {
  taskId: string;
  /** Owned by the shell, so the two halves cannot disagree about the phase. */
  phase: CurriculumDesignPhase;
  /**
   * The shell's shared refresh counter.
   *
   * The editor re-reads its snapshot when this changes. Without it the editor
   * fetched once on mount: a refresh moved the phase and the gate, but left the
   * data behind the gate stale, so a unit created outside the editor was
   * missing from the very form that needed to select it. Re-reading through
   * `load` rather than remounting is deliberate — see the shell's comment.
   */
  version: number;
  /**
   * Re-read the phase as well as this snapshot.
   *
   * The refresh button has to go through the same callback a write does, not call
   * `load` directly. It did the latter at first, which re-read the design but left
   * the phase stale — so a task advanced from anywhere but this editor stayed
   * gated forever, on a button that no amount of clicking could open. The live
   * walk caught it; the type check and the unit suite both passed.
   */
  onChanged: () => Promise<void> | void;
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
}

const COVERAGE_KINDS: { value: CurriculumCoverageKind; label: string }[] = [
  { value: 'teach', label: '教' },
  { value: 'practice', label: '练' },
  { value: 'assess', label: '考' },
];

const OBJECTIVE_TYPE_OPTIONS = [
  { value: 'knowledge', label: '知识' },
  { value: 'skill', label: '技能' },
  { value: 'competency', label: '能力' },
  { value: 'task', label: '任务' },
];

const ROLE_OPTIONS = [
  { value: 'lecture', label: '讲课' },
  { value: 'practice', label: '练习' },
  { value: 'exam', label: '考试' },
];

/**
 * Verify kinds, each labelled with what its target is.
 *
 * The label is the whole point: "验证方式" and "验证目标" then read as one
 * sentence — pick `file_read`, give the path — so the author chooses by intent
 * instead of having to know which of the record's seven condition fields the
 * kind is stored in.
 */
const LAB_VERIFY_KIND_OPTIONS = LAB_VERIFY_KINDS.map((kind) => ({
  value: kind,
  label: `${kind} — ${labVerifyKindLabel(kind)}`,
}));

const LAB_VERIFY_TARGET_HINT = `目标会按验证方式自动写入对应字段：${LAB_VERIFY_KINDS.map(
  (kind) => `${kind}→${labVerifyKindLabel(kind)}`,
).join('；')}。`;

/** The rule's asserted condition, for the list. */
const labRuleTarget = (rule: LabVerifyRule) => labVerifyTargetOf(rule) || '(未填写)';

/** A number field's text as an integer; `NaN` for blank, so callers can default. */
function intFrom(value: string | boolean | string[] | undefined): number {
  return typeof value === 'string' && value.trim() !== '' ? Number.parseInt(value, 10) : Number.NaN;
}

const roleLabel = (role: string | null | undefined) =>
  ROLE_OPTIONS.find((option) => option.value === role)?.label ?? role ?? '未指定';

/** An empty state that says which phase opens this section. */
function EmptySection({
  phase,
  kind,
  children,
}: {
  phase: CurriculumDesignPhase;
  kind: Parameters<typeof authoringAvailability>[1];
  children: React.ReactNode;
}) {
  const availability = authoringAvailability(phase, kind);
  return (
    <div className="border-border flex flex-col gap-1 rounded-lg border border-dashed p-5 text-center">
      <p className="text-muted-foreground text-xs">{children}</p>
      {!availability.allowed && (
        <p className="text-muted-foreground text-[11px]">{availability.reason}</p>
      )}
    </div>
  );
}

/** A delete button, which the phase never gates. */
function DeleteButton({
  label,
  busyKey,
  busy,
  onDelete,
}: {
  label: string;
  busyKey: string;
  busy: string | null;
  onDelete: () => Promise<void>;
}) {
  return (
    <Button
      variant="ghost"
      size="sm"
      aria-label={label}
      title={label}
      disabled={busy === busyKey}
      onClick={() => void onDelete()}
    >
      <Trash2 className="size-3.5" />
    </Button>
  );
}

export function DesignWorkbench({ taskId, phase, version, onChanged }: DesignWorkbenchProps) {
  const [snapshot, setSnapshot] = useState<CurriculumDesignSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [coverageDraft, setCoverageDraft] = useState<
    { unitId: string; objectiveId: string; coverageKind: CurriculumCoverageKind }[] | null
  >(null);

  const base = `/api/curriculum/design/tasks/${taskId}`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const payload = await requestJson<CurriculumDesignSnapshot>(base);
      setSnapshot(payload);
      setCoverageDraft(null);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, [base]);

  /**
   * 采纳一行之后刷新左栏。
   *
   * **刻意不经过 `run`**：`run` 把失败吞进页面的错误条然后正常返回，于是右栏会一边显示
   * "已采纳这一行，左栏已经改好"、一边库是空的（B2 的 e2e 逮到过这个）。所以失败必须
   * 抛回右栏，右栏才有资格决定"这一行算不算已采纳"。
   */
  const refreshAfterAdoption = useCallback(async () => {
    await load();
    await onChanged();
  }, [load, onChanged]);

  useEffect(() => {
    void load();
    // `version` is the shell's shared refresh: a change means another half
    // changed something, so the data behind this editor's gates may have moved.
  }, [load, version]);

  /**
   * One write, with its own busy key.
   *
   * Every mutation goes through here so a refusal surfaces once, in the strip
   * above the sections, and so the busy state is per-row rather than one global
   * spinner that would freeze the whole workbench while a single field saves.
   * The reload happens after the write, not before, so what is on screen is what
   * the store actually accepted — including when the store derived a field
   * (verifiability) the form never sent.
   */
  const run = useCallback(
    async (key: string, work: () => Promise<string>) => {
      setBusy(key);
      setError(null);
      setNotice(null);
      try {
        const message = await work();
        await load();
        await onChanged();
        if (message) setNotice(message);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '操作失败');
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged],
  );

  /**
   * A module-level empty array, so the `??` below cannot hand `useMemo` a new
   * reference on every render. `?? []` inline allocates each time, which would make
   * every downstream memo miss on each render — the kind of warning that is easy to
   * silence and expensive to leave.
   */
  const EMPTY: readonly never[] = [];

  const objectives = snapshot?.objectives ?? (EMPTY as unknown as CurriculumObjectiveRecord[]);
  const nodes = snapshot?.nodes ?? (EMPTY as unknown as CurriculumLearningNodeRecord[]);
  const units = snapshot?.units ?? (EMPTY as unknown as CurriculumUnitRecord[]);

  const items = useMemo(
    () =>
      units.filter((unit) => unit.unitType === 'item').sort((a, b) => a.orderIndex - b.orderIndex),
    [units],
  );

  const objectiveById = useMemo(
    () => new Map(objectives.map((objective) => [objective.id, objective])),
    [objectives],
  );
  const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const unitById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);

  const evidenceByObjective = useMemo(() => {
    const grouped = new Map<string, CurriculumEvidenceRecord[]>();
    for (const row of snapshot?.evidence ?? []) {
      grouped.set(row.objectiveId, [...(grouped.get(row.objectiveId) ?? []), row]);
    }
    return grouped;
  }, [snapshot]);

  /**
   * 系列层给的两份清单，以及这一目已经承接了哪些。
   *
   * 承接面板要显示"系列里共几条、已承接几条"，而"已承接"必须按来源 id 判断而不
   * 是按标题：改过标题的承接行如果按标题比对，会被当成没承接，于是再承接一遍，
   * 库里出现两条内容一样的行。
   */
  const seriesObjectiveItems = useMemo(
    () =>
      (snapshot?.seriesDesign?.objectives ?? []).map((objective) => ({
        id: objective.id,
        title: objective.title,
        detail: objective.expectedBehavior,
      })),
    [snapshot?.seriesDesign],
  );
  const seriesNodeItems = useMemo(
    () =>
      (snapshot?.seriesDesign?.nodes ?? []).map((node) => ({
        id: node.id,
        title: node.name,
        detail: node.summary,
      })),
    [snapshot?.seriesDesign],
  );
  const inheritedObjectiveIds = useMemo(
    () =>
      new Set(
        objectives
          .map((objective) => objective.seriesObjectiveId)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    [objectives],
  );
  const inheritedNodeIds = useMemo(
    () =>
      new Set(
        nodes
          .map((node) => node.seriesNodeId)
          .filter((id): id is string => typeof id === 'string' && id !== ''),
      ),
    [nodes],
  );

  /** Select options for an outcome, labelled by its title so ids are never shown. */
  const objectiveOptions = useMemo(
    () =>
      objectives.map((objective) => ({
        value: objective.id,
        label: objective.code ? `${objective.code} ${objective.title}` : objective.title,
      })),
    [objectives],
  );

  const itemOptions = useMemo(
    () =>
      items.map((unit) => ({
        value: unit.id,
        label: `${unit.title}（${roleLabel(unit.unitRole)}）`,
      })),
    [items],
  );

  const coverageKey = (unitId: string, objectiveId: string, kind: CurriculumCoverageKind) =>
    `${unitId}|${objectiveId}|${kind}`;

  const activeCoverage = useMemo(() => {
    const source =
      coverageDraft ??
      (snapshot?.unitCoverage ?? []).map((row) => ({
        unitId: row.unitId,
        objectiveId: row.objectiveId,
        coverageKind: row.coverageKind,
      }));
    return new Set(source.map((row) => coverageKey(row.unitId, row.objectiveId, row.coverageKind)));
  }, [coverageDraft, snapshot]);

  const toggleCoverage = useCallback(
    (unitId: string, objectiveId: string, kind: CurriculumCoverageKind) => {
      setCoverageDraft((current) => {
        const source =
          current ??
          (snapshot?.unitCoverage ?? []).map((row) => ({
            unitId: row.unitId,
            objectiveId: row.objectiveId,
            coverageKind: row.coverageKind,
          }));
        const key = coverageKey(unitId, objectiveId, kind);
        const exists = source.some(
          (row) => coverageKey(row.unitId, row.objectiveId, row.coverageKind) === key,
        );
        return exists
          ? source.filter(
              (row) => coverageKey(row.unitId, row.objectiveId, row.coverageKind) !== key,
            )
          : [...source, { unitId, objectiveId, coverageKind: kind }];
      });
    },
    [snapshot],
  );

  /**
   * 整表替换那几类行在采纳那一刻要的当前库。
   *
   * **这里传的是真库而不是空对象**：大纲的覆盖关系是 `PUT /unit-coverage` 整份替换，传空
   * 就等于"按一下把现有覆盖全删了"，而那**不会报错**——它只会让后面某个目标变成"没东西
   * 可教"。`useMemo` 不是为了省算力，而是为了给这个对象一个稳定引用：它会进右栏的
   * `useMemo` 依赖，每次渲染新建一个字面量会让它算出同样的答案而下游以为它变了。
   *
   * 位置在**两处早退之前**，这是这一段唯一真正难的地方：本组件有两处提前 `return`
   * （加载中、快照为空），把 Hook 放在它们后面就成了条件调用——某次渲染走了早退那条
   * 路径，下一次没走，React 记的调用顺序就对不上，界面直接崩。用 `snapshot?.…` 是为了
   * 能在快照为空时也算出一个稳定的值，而不是把它挪到守卫之后。
   */
  const liveCoverage = useMemo(
    () => ({ nodeObjectives: [], unitCoverage: snapshot?.unitCoverage ?? [] }),
    [snapshot?.unitCoverage],
  );

  /**
   * 知识技能图的当前连线。整表替换那一类行在采纳那一刻按它重算，所以必须是真库。
   *
   * 位置与 `liveCoverage` 同一个理由：本组件有两处提前 `return`，Hook 放在它们后面就成了
   * 条件调用。
   */
  const liveKnowledge = useMemo(
    () => ({ nodeObjectives: snapshot?.nodeObjectives ?? [], unitCoverage: [] }),
    [snapshot?.nodeObjectives],
  );

  if (loading && !snapshot) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-8 text-sm">
        <Loader2 className="size-4 animate-spin" />
        正在加载设计编辑器…
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="border-destructive/40 bg-destructive/5 text-destructive m-6 rounded-lg border p-4 text-sm">
        {error ?? '无法加载课程设计'}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-base font-semibold">设计编辑器</h2>
          <Button variant="outline" size="sm" onClick={() => void onChanged()}>
            <RotateCcw />
            刷新
          </Button>
        </div>
        {/*
          这里不再挂步骤条：七步条由 `DesignTaskShell` 渲染在 Tabs 之外，三个 Tab 上
          都在。编辑器里再放一份会出现两个"当前步"——壳上的那个说第 7 步、编辑器里的
          那个也上色，读者要花力气判断它们是不是同一件事。
        */}
        <p className="text-muted-foreground text-xs">
          阶段决定能新增什么，不决定能改什么——写错了的东西，任何阶段都能改掉或删掉。
        </p>
      </header>

      {/*
        「哪几步是系列的、哪几步是本目的」。

        用户进到某一目的设计编辑器，看到的是一排卡片：课程方向、学习目标、知识技能、
        课程大纲……他的原话是「咋又是课程方向和目标和大纲」。卡片本身没错——七步是
        标准流程——错的是**没说清归属**：前三步属于系列，这里只继承/承接。归属表在
        `step-ownership.ts`，这里把结论直接写在页面上，而不是让用户自己拼。
      */}
      <section
        aria-label="七步归属"
        className="border-border bg-muted/20 flex flex-col gap-2 rounded-lg border p-3 text-xs"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-col gap-1.5">
            <p className="font-medium">
              这 {SERIES_OWNED_PHASES.length + ITEM_OWNED_PHASES.length} 步分两层：前{' '}
              {SERIES_OWNED_PHASES.length} 步在系列层定一次，后 {ITEM_OWNED_PHASES.length}{' '}
              步才是这一目自己的活。
            </p>
            <p className="text-muted-foreground">
              <span className="text-foreground font-medium">系列层</span>（本目继承 / 承接）：
              {SERIES_OWNED_PHASES.map(
                (entry) => `第 ${STEP_NUMBER[entry]} 步 ${STEP_WORK_NAME[entry]}`,
              ).join(' · ')}
            </p>
            <p className="text-muted-foreground">
              <span className="text-foreground font-medium">本目</span>：
              {ITEM_OWNED_PHASES.map(
                (entry) => `第 ${STEP_NUMBER[entry]} 步 ${STEP_WORK_NAME[entry]}`,
              ).join(' · ')}
            </p>
          </div>
          {snapshot.task.seriesId ? (
            <Link
              href={`/curriculum/series/${snapshot.task.seriesId}/design`}
              className="text-foreground shrink-0 text-xs underline underline-offset-2"
            >
              去系列设计页（前 {SERIES_OWNED_PHASES.length} 步）
            </Link>
          ) : (
            <span className="text-muted-foreground shrink-0 text-[11px]">
              这一目不属于任何系列，所以前三步也在这里填。
            </span>
          )}
        </div>
        <p className="text-muted-foreground text-[11px]">
          系列层改一次，所有目跟着变；本目的改动不会反向影响系列。
        </p>
      </section>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border p-3 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-500/40 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-300">
          <Check className="mt-0.5 size-3.5 shrink-0" />
          {notice}
        </div>
      )}

      {/* ── Step 1: the course direction and its sign-off ──────────────────── */}
      {/* Above outcomes because it is the phase this task is actually in when it
          is created, and because the confirmation — not the fields — is what
          opens the outcomes section. */}
      <DesignDirectionCard
        task={snapshot.task}
        seriesDirection={snapshot.seriesDirection}
        confirmation={snapshot.confirmations.find((entry) => entry.step === 'task') ?? null}
        run={run}
        busy={busy}
        onRefresh={async () => {
          await load();
          await onChanged();
        }}
      />

      {/* ── Outcomes and evidence ──────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="outcomes" currentPhase={phase} />
                学习目标与证据
              </CardTitle>
              <CardDescription>
                目标要写得出可观察的行为和最低标准，否则系统会判定它不可验证
              </CardDescription>
              <p className="text-muted-foreground mt-1 text-xs">
                整门课的课程目标在系列层定义一次，这一目只承接其中相关的几条。
                {snapshot.task.seriesId ? (
                  <Link
                    className="text-foreground ml-1 underline underline-offset-2"
                    href={`/curriculum/series/${snapshot.task.seriesId}/design`}
                  >
                    去系列设计
                  </Link>
                ) : null}
              </p>
            </div>
            <CreateForm
              kind="outcomes"
              phase={phase}
              busyKey="objective:new"
              busy={busy}
              submitLabel="新建目标"
              fields={[
                {
                  kind: 'text',
                  name: 'title',
                  label: '目标标题',
                  required: true,
                  placeholder: '例如：能利用 SQL 注入读取指定数据',
                },
                {
                  kind: 'select',
                  name: 'objectiveType',
                  label: '类型',
                  options: OBJECTIVE_TYPE_OPTIONS,
                  initial: 'skill',
                },
                {
                  kind: 'textarea',
                  name: 'expectedBehavior',
                  label: '可观察行为',
                  required: true,
                  placeholder: '在什么条件下做出什么可被观察到的动作',
                },
                {
                  kind: 'tags',
                  name: 'minCriteria',
                  label: '最低标准（每行一条）',
                  placeholder: '识别注入点\n成功读取 flag',
                },
              ]}
              onSubmit={(values) =>
                run('objective:new', async () => {
                  await requestJson(`${base}/objectives`, {
                    method: 'POST',
                    body: JSON.stringify(values),
                  });
                  return '已新建学习目标。';
                })
              }
            />
          </div>
          {/* The list below and this sign-off are two faces of the same step, so
              the strip lives inside this card rather than beside it: an editor of
              the list, and the "I have read it" that opens the next phase. */}
          <DesignOutcomesSignOff
            taskId={snapshot.task.id}
            objectives={objectives}
            evidence={snapshot.evidence ?? []}
            confirmation={snapshot.confirmations.find((entry) => entry.step === 'outcomes') ?? null}
            run={run}
            busy={busy}
            onRefresh={async () => {
              await load();
              await onChanged();
            }}
          />
        </CardHeader>
        {/* 两栏：左边是**作者要决定的事**，右边是 AI 的草稿。右栏的每一行都要人在左边
            再点一次"采纳"才写库，所以它必须是看得见的另一栏，而不是一个弹窗后面的一条
            对话。见 SERIES-UI-REDESIGN §5.2。 */}
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-3">
            {/*
              第 2 步在目里真正要做的事：从系列的课程目标里挑。没有系列时面板不出现，
              卡片下半部分就是原来那个"新建目标"表单。
            */}
            {snapshot.task.seriesId ? (
              <SeriesInheritPanel
                kind="objectives"
                taskId={snapshot.task.id}
                seriesId={snapshot.task.seriesId}
                items={seriesObjectiveItems}
                inheritedIds={inheritedObjectiveIds}
                phase={phase}
                busy={busy}
                run={run}
              />
            ) : null}
            {objectives.length === 0 ? (
              <EmptySection phase={phase} kind="outcomes">
                还没有学习目标。逆向设计从「学生最终要能做什么」开始，不是从「讲什么」开始。
              </EmptySection>
            ) : (
              <ul className="flex flex-col gap-3">
                {objectives.map((objective) => (
                  <li key={objective.id} className="border-border rounded-lg border p-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex min-w-0 flex-col gap-1">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="px-1 py-0 text-[10px]">
                            {OBJECTIVE_TYPE_OPTIONS.find(
                              (type) => type.value === objective.objectiveType,
                            )?.label ?? objective.objectiveType}
                          </Badge>
                          {objective.code && (
                            <span className="text-muted-foreground font-mono text-[10px]">
                              {objective.code}
                            </span>
                          )}
                          {!objective.verifiable && (
                            <Badge variant="destructive" className="px-1 py-0 text-[10px]">
                              不可验证
                            </Badge>
                          )}
                        </div>
                        <span className="text-sm font-medium">{objective.title}</span>
                      </div>
                      <DeleteButton
                        label={`删除目标「${objective.title}」`}
                        busyKey={`objective:${objective.id}`}
                        busy={busy}
                        onDelete={() =>
                          run(`objective:${objective.id}`, async () => {
                            await requestJson(`${base}/objectives/${objective.id}`, {
                              method: 'DELETE',
                            });
                            return '已删除学习目标。';
                          })
                        }
                      />
                    </div>

                    <div className="mt-2">
                      <InlineEdit
                        rowId={objective.id}
                        field="expectedBehavior"
                        label="可观察行为"
                        value={objective.expectedBehavior}
                        multiline
                        busyKey={`objective-save:${objective.id}`}
                        busy={busy}
                        onSave={(next) =>
                          run(`objective-save:${objective.id}`, async () => {
                            await requestJson(`${base}/objectives/${objective.id}`, {
                              method: 'PATCH',
                              body: JSON.stringify({ expectedBehavior: next }),
                            });
                            return '已保存学习目标。';
                          })
                        }
                      />
                    </div>

                    <EvidenceBlock
                      objective={objective}
                      evidence={evidenceByObjective.get(objective.id) ?? []}
                      base={base}
                      phase={phase}
                      busy={busy}
                      run={run}
                    />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <aside className="border-border flex flex-col gap-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <StepCopilotSlot
              taskId={snapshot.task.id}
              step="outcomes"
              heading="让 AI 帮你起草学习目标"
              examples={[
                '这一目要学生能独立完成什么？每条目标配一条考核证据。',
                '目标已经有了，但每条都还没有考核方式，请补上。',
                '把「能读懂 HTTP 响应」拆成更具体、可观察的目标。',
              ]}
              contextLine={`现在有 ${objectives.length} 个目标；草稿只会动其中明确提到的那几个。`}
              live={emptyLive}
              conflicts={outcomesConflicts}
              onAdopted={refreshAfterAdoption}
            />
          </aside>
        </CardContent>
      </Card>

      {/* ── Knowledge and the order it is taught in ─────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="graph" currentPhase={phase} />
                知识技能与依赖
              </CardTitle>
              <CardDescription>
                两端都要连上：每个知识点支撑至少一个目标，每个目标也至少有一个知识点
              </CardDescription>
              <p className="text-muted-foreground mt-1 text-xs">
                知识体系属于整个系列；这一目只挑本目要讲的点，不另造一套图。
                {snapshot.task.seriesId ? (
                  <Link
                    className="text-foreground ml-1 underline underline-offset-2"
                    href={`/curriculum/series/${snapshot.task.seriesId}/design`}
                  >
                    去系列设计
                  </Link>
                ) : null}
              </p>
            </div>
            <CreateForm
              kind="nodes"
              phase={phase}
              busyKey="node:new"
              busy={busy}
              submitLabel="新建知识点"
              fields={[
                {
                  kind: 'text',
                  name: 'name',
                  label: '知识点名称',
                  required: true,
                  placeholder: '例如：SQL 查询与参数化',
                },
                {
                  kind: 'select',
                  name: 'nodeType',
                  label: '类型',
                  options: [
                    { value: 'knowledge', label: '知识' },
                    { value: 'skill', label: '技能' },
                  ],
                  initial: 'knowledge',
                },
                {
                  kind: 'textarea',
                  name: 'summary',
                  label: '摘要',
                  placeholder: '一句话说明它是什么',
                },
              ]}
              onSubmit={(values) =>
                run('node:new', async () => {
                  await requestJson(`${base}/nodes`, {
                    method: 'POST',
                    body: JSON.stringify(values),
                  });
                  return '已新建知识点，接着给它勾上支撑的目标。';
                })
              }
            />
          </div>
          {/* Same arrangement as the outcome list above, for the same reason: the
              nodes below and this sign-off are two faces of the same step, so the
              strip lives inside this card rather than beside it. */}
          <DesignKnowledgeSignOff
            taskId={snapshot.task.id}
            nodes={nodes}
            nodeObjectives={snapshot.nodeObjectives ?? []}
            objectives={objectives}
            confirmation={snapshot.confirmations.find((entry) => entry.step === 'graph') ?? null}
            run={run}
            busy={busy}
            onRefresh={async () => {
              await load();
              await onChanged();
            }}
          />
        </CardHeader>
        {/* 两栏：左边是**作者要决定的事**（手工新建、勾支撑、加先后关系），右边是 AI
            的草稿。这不是排版偏好——右栏的每一行都要人在左边再点一次"采纳"才写库，
            所以它必须是**看得见的另一栏**而不是一个弹窗后面的一条对话。见 B2 设计稿 §5.2。 */}
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-3">
            {/* 第 3 步在目里真正要做的事：在系列知识体系里挑本目要讲的点。 */}
            {snapshot.task.seriesId ? (
              <SeriesInheritPanel
                kind="nodes"
                taskId={snapshot.task.id}
                seriesId={snapshot.task.seriesId}
                items={seriesNodeItems}
                inheritedIds={inheritedNodeIds}
                phase={phase}
                busy={busy}
                run={run}
              />
            ) : null}
            {nodes.length === 0 ? (
              <EmptySection phase={phase} kind="nodes">
                还没有知识点。它们由学习目标反推，不是由章节标题得到。
              </EmptySection>
            ) : (
              <ul className="flex flex-col gap-2">
                {nodes.map((node) => (
                  <NodeBlock
                    key={node.id}
                    node={node}
                    objectiveOptions={objectiveOptions}
                    supportedObjectiveIds={
                      new Set(
                        (snapshot.nodeObjectives ?? [])
                          .filter((link) => link.nodeId === node.id)
                          .map((link) => link.objectiveId),
                      )
                    }
                    base={base}
                    busy={busy}
                    run={run}
                  />
                ))}
              </ul>
            )}

            <DependencyBlock
              dependencies={snapshot.dependencies ?? []}
              objectiveById={objectiveById}
              nodeById={nodeById}
              base={base}
              phase={phase}
              objectiveOptions={objectiveOptions}
              nodeOptions={nodes.map((node) => ({ value: node.id, label: node.name }))}
              busy={busy}
              run={run}
            />
          </div>

          <aside className="border-border flex flex-col gap-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <StepCopilot
              draftRoute={`/api/curriculum/design/tasks/${snapshot.task.id}/knowledge/draft`}
              heading="让 AI 帮你起草知识点"
              examples={[
                '这一目要讲「目录扫描」和「指纹识别」，各自依赖什么？按已确认的学习目标补齐知识点。',
                '把已经列出的知识点按「先学哪个」排出先后关系，并说明理由。',
                '有一个目标到现在还没有任何知识点支撑，请补上。',
              ]}
              contextLine={`图上现有 ${nodes.length} 个知识点、${objectives.length} 个目标；草稿只会动其中明确提到的那几个。`}
              live={liveKnowledge}
              onAdopted={refreshAfterAdoption}
            />
          </aside>
        </CardContent>
      </Card>

      {/* ── Outline ─────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="outline" currentPhase={phase} />
                本目大纲
              </CardTitle>
              <CardDescription>
                这一目分几段，每段教 / 练 / 考什么。条目角色决定它生成什么：讲课出幻灯片，
                练习多出交互，考试不收提示。系列大纲（章 → 节 → 目）在驾驶舱维护，它决定
                有哪些目，不决定这一目内部怎么分段。
              </CardDescription>
            </div>
            <CreateForm
              kind="units"
              phase={phase}
              busyKey="unit:new"
              busy={busy}
              submitLabel="新建条目"
              fields={[
                {
                  kind: 'text',
                  name: 'title',
                  label: '条目标题',
                  required: true,
                  placeholder: '例如：1.1 SQL 注入原理',
                },
                {
                  kind: 'select',
                  name: 'unitRole',
                  label: '角色',
                  options: ROLE_OPTIONS,
                  initial: 'lecture',
                },
                { kind: 'number', name: 'hours', label: '学时', placeholder: '2' },
              ]}
              onSubmit={(values) =>
                run('unit:new', async () => {
                  const body: Record<string, unknown> = {
                    unitType: 'item',
                    title: values.title,
                    unitRole: values.unitRole,
                    orderIndex: items.length,
                  };
                  if (typeof values.hours === 'string' && values.hours.trim() !== '') {
                    body.hours = Number(values.hours);
                  }
                  await requestJson(`${base}/units`, {
                    method: 'POST',
                    body: JSON.stringify(body),
                  });
                  return '已新建大纲条目，接着在下面勾它教/练/考哪个目标。';
                })
              }
            />
          </div>
          {/* Same arrangement as the graph card above: the entries below and this
              sign-off are two faces of the same step, so the strip lives inside
              this card rather than beside it. */}
          <DesignOutlineSignOff
            taskId={snapshot.task.id}
            units={units}
            unitCoverage={snapshot.unitCoverage ?? []}
            confirmation={snapshot.confirmations.find((entry) => entry.step === 'outline') ?? null}
            run={run}
            busy={busy}
            onRefresh={async () => {
              await load();
              await onChanged();
            }}
          />
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-3">
            {items.length === 0 ? (
              <EmptySection phase={phase} kind="units">
                还没有条目。条目是「这个目具体怎么教、怎么练、怎么考」，没有条目就没有可生产的内容。
              </EmptySection>
            ) : (
              <ul className="flex flex-col gap-2">
                {items.map((unit) => (
                  <UnitBlock
                    key={unit.id}
                    unit={unit}
                    base={base}
                    nodeOptions={nodes.map((node) => ({ value: node.id, label: node.name }))}
                    busy={busy}
                    run={run}
                  />
                ))}
              </ul>
            )}
            <ItemOrderBlock
              edges={snapshot.unitDependencies ?? []}
              unitById={unitById}
              base={base}
              phase={phase}
              itemOptions={itemOptions}
              busy={busy}
              run={run}
            />
          </div>

          <aside className="border-border flex flex-col gap-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <StepCopilotSlot
              taskId={snapshot.task.id}
              step="outline"
              heading="让 AI 帮你起草大纲"
              examples={[
                '按上面的学习目标排出这一目的条目，每个条目说明教什么、练什么、考什么。',
                '章和节已经在了，请补上每个条目，并勾它教/练/考哪个目标。',
                '有一项目标没有任何条目教它，请补上。',
              ]}
              contextLine={`现在有 ${items.length} 个条目；草稿只会动其中明确提到的那几个。`}
              live={liveCoverage}
              onAdopted={refreshAfterAdoption}
            />
          </aside>
        </CardContent>
      </Card>

      {/* ── Coverage ────────────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                {/* 覆盖是第 4 步的一部分：`setCurriculumUnitCoverage` 与创建条目同一个
                    `outline` 门禁，勾选改变的是大纲里每一条教/练/考什么。 */}
                <StepBadge phase="outline" currentPhase={phase} />教 / 练 / 考 覆盖
              </CardTitle>
              <CardDescription>
                勾选即改变热力矩阵。整份覆盖一次事务写入，避免闭环被看到写了一半的状态
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={!coverageDraft || busy === 'coverage:save'}
                onClick={() =>
                  void run('coverage:save', async () => {
                    await requestJson(`${base}/unit-coverage`, {
                      method: 'PUT',
                      body: JSON.stringify({ rows: coverageDraft ?? [] }),
                    });
                    return '覆盖已保存，热力矩阵已更新。';
                  })
                }
              >
                {busy === 'coverage:save' ? <Loader2 className="animate-spin" /> : <Save />}
                保存覆盖
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!coverageDraft}
                onClick={() => setCoverageDraft(null)}
              >
                放弃修改
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {items.length === 0 || objectives.length === 0 ? (
            <EmptySection phase={phase} kind="coverage">
              需要先有目标和条目，才能声明谁教、谁练、谁考哪个目标。
            </EmptySection>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full border-separate border-spacing-0 text-xs">
                <thead>
                  <tr>
                    <th className="bg-background sticky left-0 z-10 min-w-[13rem] px-2 py-2 text-left font-medium">
                      目标
                    </th>
                    {items.map((unit) => (
                      <th
                        key={unit.id}
                        className="border-border min-w-[6.5rem] border-b px-2 py-2 text-center font-medium"
                      >
                        <span className="line-clamp-2">{unit.title}</span>
                        <span className="text-muted-foreground block text-[10px]">
                          {roleLabel(unit.unitRole)}
                        </span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {objectives.map((objective) => (
                    <tr key={objective.id} className="group">
                      <td className="bg-background group-hover:bg-muted/40 sticky left-0 z-10 px-2 py-2">
                        <span className="leading-tight font-medium">{objective.title}</span>
                      </td>
                      {items.map((unit) => (
                        <td key={unit.id} className="group-hover:bg-muted/40 px-1 py-1">
                          <div className="flex items-center justify-center gap-1">
                            {COVERAGE_KINDS.map((kind) => (
                              <label
                                key={kind.value}
                                className="flex flex-col items-center gap-0.5"
                                title={`${unit.title} ${kind.label}「${objective.title}」`}
                              >
                                <Checkbox
                                  checked={activeCoverage.has(
                                    coverageKey(unit.id, objective.id, kind.value),
                                  )}
                                  onCheckedChange={() =>
                                    toggleCoverage(unit.id, objective.id, kind.value)
                                  }
                                />
                                <span className="text-muted-foreground text-[10px]">
                                  {kind.label}
                                </span>
                              </label>
                            ))}
                          </div>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── Teaching design: the script and the storyboard ──────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="teaching" currentPhase={phase} />
                授课脚本与分镜
              </CardTitle>
              <CardDescription>
                每个条目讲什么、讲到什么程度，以及这件事落在哪几页上——分镜直接进生成提示词
              </CardDescription>
            </div>
            {/* Same arrangement as the cards above: the scripts below and this
                sign-off are two faces of one step. */}
            <DesignTeachingSignOff
              taskId={snapshot.task.id}
              units={units}
              confirmation={
                snapshot.confirmations.find((entry) => entry.step === 'teaching') ?? null
              }
              run={run}
              busy={busy}
              onRefresh={async () => {
                await load();
                await onChanged();
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-3">
            {items.length === 0 ? (
              <EmptySection phase={phase} kind="units">
                还没有条目。分镜是逐条写的，先把这一目的条目（讲授 / 练习 / 考核）排出来。
              </EmptySection>
            ) : (
              <ul className="flex flex-col gap-3">
                {items.map((unit) => {
                  const design = unit.teachingDesign ?? {};
                  const pages = unit.deckDesign?.pages ?? [];
                  return (
                    <li key={unit.id} className="flex flex-col gap-1 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="px-1 py-0 text-[10px]">
                          {ROLE_OPTIONS.find((option) => option.value === unit.unitRole)?.label ??
                            unit.unitRole ??
                            '—'}
                        </Badge>
                        <span className="font-medium">{unit.title}</span>
                        {unit.unitRole === 'lecture' ? (
                          <span className="text-muted-foreground">{pages.length} 页</span>
                        ) : null}
                      </div>
                      {ASSIGNED_NODE_BUCKETS.map((bucket) => {
                        const ids = design[bucket] ?? [];
                        if (ids.length === 0) return null;
                        return (
                          <div key={bucket} className="text-muted-foreground pl-4">
                            {TEACHING_DEPTH_LABELS[bucket]}：
                            {ids
                              .map((id) => nodes.find((node) => node.id === id)?.name ?? id)
                              .join('、')}
                          </div>
                        );
                      })}
                      {unit.unitRole === 'lecture' && pages.length > 0 ? (
                        <ol className="text-muted-foreground flex flex-col gap-0.5 pl-4">
                          {pages.map((page) => (
                            <li key={page.order}>
                              {page.order}. {page.title}｜{page.goal}
                              {(page.teaches ?? []).length > 0
                                ? `｜讲：${(page.teaches ?? [])
                                    .map((id) => nodes.find((node) => node.id === id)?.name ?? id)
                                    .join('、')}`
                                : ''}
                            </li>
                          ))}
                        </ol>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          <aside className="border-border flex flex-col gap-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <StepCopilotSlot
              taskId={snapshot.task.id}
              step="teaching"
              heading="让 AI 帮你写授课脚本"
              examples={[
                '按大纲逐条写：这个条目讲什么、哪些知识点讲全、哪些点到为止。',
                '讲课条目还没有分镜，请按它的脚本排页。',
              ]}
              contextLine={`现在有 ${items.length} 个条目；草稿只会改它明确提到的那几条。`}
              live={emptyLive}
              onAdopted={refreshAfterAdoption}
            />
          </aside>
        </CardContent>
      </Card>

      {/* ── Assessment: the AI-written artifacts and their sign-off ─────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="assessment" currentPhase={phase} />
                题目与实操
              </CardTitle>
              <CardDescription>
                每个承诺要被考核的目标，都要有题目或实操接着，并且挂在承担它的目上——挂错条目的产物看起来完全正常，但在学员的考核闭环里读不到它
              </CardDescription>
            </div>
            {/* Same arrangement as the cards above: the artifacts below and this
                sign-off are two faces of one step. */}
            <DesignAssessmentSignOff
              taskId={snapshot.task.id}
              questions={snapshot.questions}
              labTasks={snapshot.labTasks}
              confirmation={
                snapshot.confirmations.find((entry) => entry.step === 'assessment') ?? null
              }
              run={run}
              busy={busy}
              onRefresh={async () => {
                await load();
                await onChanged();
              }}
            />
          </div>
        </CardHeader>
        <CardContent className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="flex flex-col gap-3">
            {items.length === 0 ? (
              <EmptySection phase={phase} kind="units">
                还没有条目。题目和实操是逐条挂上去的，先把这一目的条目（讲授 / 练习 / 考核）排出来。
              </EmptySection>
            ) : (
              <ul className="flex flex-col gap-3">
                {items.map((unit) => {
                  const questions = (snapshot.questions ?? []).filter(
                    (question) => question.unitId === unit.id,
                  );
                  const labs = (snapshot.labTasks ?? []).filter((lab) => lab.unitId === unit.id);
                  return (
                    <li key={unit.id} className="flex flex-col gap-1 text-xs">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <Badge variant="outline" className="px-1 py-0 text-[10px]">
                          {roleLabel(unit.unitRole)}
                        </Badge>
                        <span className="font-medium">{unit.title}</span>
                        <span className="text-muted-foreground">
                          {questions.length} 题、{labs.length} 个实操
                        </span>
                      </div>
                      {questions.length === 0 && labs.length === 0 ? (
                        <div className="pl-4 text-amber-700 dark:text-amber-300">
                          还没有题目和实操
                        </div>
                      ) : (
                        <ul className="text-muted-foreground flex flex-col gap-0.5 pl-4">
                          {questions.map((question) => (
                            <li key={question.id}>
                              <Badge variant="outline" className="mr-1 px-1 py-0 text-[10px]">
                                {QUESTION_TYPE_LABELS[question.questionType]}
                              </Badge>
                              {question.stem}
                              {`｜答案 ${question.answer.join('/') || '（空）'}｜${DIFFICULTY_LABELS[question.difficulty]}｜${question.score} 分`}
                            </li>
                          ))}
                          {labs.map((lab) => (
                            <li key={lab.id}>
                              <Badge
                                variant={lab.assessmentMode === 'exam' ? 'default' : 'secondary'}
                                className="mr-1 px-1 py-0 text-[10px]"
                              >
                                {ASSESSMENT_MODE_LABELS[lab.assessmentMode]}
                              </Badge>
                              {lab.taskGoal}
                              {`｜镜像 ${lab.dockerImage}｜`}
                              {lab.verifyRules.length === 0
                                ? '没有验证规则：这样判不了分'
                                : lab.verifyRules.map(describeVerifyRule).join('；')}
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* An artifact whose `unitId` is not an item would otherwise vanish from
              the one screen where the author is looking for it — and "a question
              hung on a chapter" is exactly the defect this step refuses to write
              and the audit reports. It stays visible here instead. */}
            {(() => {
              const itemIds = new Set(items.map((unit) => unit.id));
              const adrift = [
                ...(snapshot.questions ?? [])
                  .filter((question) => !itemIds.has(question.unitId))
                  .map((question) => `题目「${question.stem}」`),
                ...(snapshot.labTasks ?? [])
                  .filter((lab) => !itemIds.has(lab.unitId))
                  .map((lab) => `实操「${lab.taskGoal}」`),
              ];
              if (adrift.length === 0) return null;
              return (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">
                  挂错位置的产物（不在任何目上，考核闭环里读不到）：{adrift.join('、')}
                </p>
              );
            })()}
          </div>

          <aside className="border-border flex flex-col gap-2 border-t pt-4 lg:border-t-0 lg:border-l lg:pt-0 lg:pl-6">
            <StepCopilotSlot
              taskId={snapshot.task.id}
              step="assessment"
              heading="让 AI 帮你出题与实操"
              examples={[
                '按每条目标配的考核方式出题，并挂在承担它的那个条目上。',
                '有一条目标承诺了考试但还没有实操，请补一个 Docker 靶场任务。',
              ]}
              contextLine={`现在有 ${(snapshot.questions ?? []).length} 道题、${(snapshot.labTasks ?? []).length} 个实操；草稿只会动其中明确提到的那几个。`}
              live={emptyLive}
              conflicts={assessmentDraftConflicts}
              onAdopted={refreshAfterAdoption}
            />
          </aside>
        </CardContent>
      </Card>

      {/* ── The manual editors for the same two tables ──────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="assessment" currentPhase={phase} />
                测验题
              </CardTitle>
              <CardDescription>每道题挂在一个目标和一条覆盖它的条目上</CardDescription>
            </div>
            <CreateForm
              kind="questions"
              phase={phase}
              busyKey="question:new"
              busy={busy}
              submitLabel="新建题目"
              fields={[
                {
                  kind: 'select',
                  name: 'unitId',
                  label: '条目',
                  options: itemOptions,
                  required: true,
                },
                {
                  kind: 'select',
                  name: 'objectiveId',
                  label: '目标',
                  options: objectiveOptions,
                  required: true,
                },
                {
                  kind: 'textarea',
                  name: 'stem',
                  label: '题干',
                  required: true,
                  placeholder: '题干',
                },
                {
                  kind: 'text',
                  name: 'optionA',
                  label: '选项 A',
                  required: true,
                  placeholder: '选项 A 的文本',
                },
                {
                  kind: 'text',
                  name: 'optionB',
                  label: '选项 B',
                  required: true,
                  placeholder: '选项 B 的文本',
                },
                {
                  kind: 'select',
                  name: 'answer',
                  label: '正确答案',
                  options: [
                    { value: 'A', label: 'A' },
                    { value: 'B', label: 'B' },
                  ],
                  initial: 'A',
                },
                {
                  kind: 'textarea',
                  name: 'explanation',
                  label: '解析',
                  placeholder: '为什么是这个答案',
                },
              ]}
              onSubmit={(values) =>
                run('question:new', async () => {
                  // The option pair is assembled here because the form's job is
                  // fields, not the question record's two-key shape.
                  const body = {
                    unitId: values.unitId,
                    objectiveId: values.objectiveId,
                    questionType: 'single',
                    stem: values.stem,
                    options: [
                      { key: 'A', text: values.optionA },
                      { key: 'B', text: values.optionB },
                    ],
                    answer: [values.answer],
                    explanation: values.explanation || null,
                  };
                  await requestJson(`${base}/questions`, {
                    method: 'POST',
                    body: JSON.stringify(body),
                  });
                  return '已新建测验题。';
                })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(snapshot.questions ?? []).length === 0 ? (
            <EmptySection phase={phase} kind="questions">
              还没有测验题。目标要「被考」，就需要一道题或一个实操任务来验证它。
            </EmptySection>
          ) : (
            <ul className="flex flex-col gap-2">
              {(snapshot.questions ?? []).map((question) => (
                <li
                  key={question.id}
                  className="border-border flex items-start justify-between gap-3 rounded-lg border p-2.5"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs font-medium">{question.stem}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {objectiveById.get(question.objectiveId)?.title ?? question.objectiveId}
                      {' · '}
                      {unitById.get(question.unitId)?.title ?? question.unitId}
                    </span>
                  </div>
                  <DeleteButton
                    label={`删除题目「${question.stem}」`}
                    busyKey={`question:${question.id}`}
                    busy={busy}
                    onDelete={() =>
                      run(`question:${question.id}`, async () => {
                        await requestJson(`${base}/questions/${question.id}`, { method: 'DELETE' });
                        return '已删除题目。';
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ── Hands-on tasks ─────────────────────────────────────────────────── */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <CardTitle className="flex flex-wrap items-center gap-2 text-base">
                <StepBadge phase="assessment" currentPhase={phase} />
                实操任务
              </CardTitle>
              <CardDescription>
                一道上机题：结果由「验证规则」判定，参考解法只用于提示与复盘
              </CardDescription>
            </div>
            <CreateForm
              kind="lab-tasks"
              phase={phase}
              busyKey="lab:new"
              busy={busy}
              submitLabel="新建实操任务"
              fields={[
                {
                  kind: 'select',
                  name: 'unitId',
                  label: '条目',
                  options: itemOptions,
                  required: true,
                },
                {
                  kind: 'select',
                  name: 'objectiveId',
                  label: '目标',
                  options: objectiveOptions,
                  required: true,
                },
                {
                  kind: 'select',
                  name: 'assessmentMode',
                  label: '考核方式',
                  options: [
                    { value: 'practice', label: '练习（可提示、可重试）' },
                    { value: 'exam', label: '考试（无提示、不重试、限时）' },
                  ],
                  initial: 'practice',
                },
                {
                  kind: 'text',
                  name: 'taskGoal',
                  label: '任务目标',
                  required: true,
                  placeholder: '例如：对给定站点完成一次注入检测并取出 flag',
                },
                {
                  kind: 'text',
                  name: 'dockerImage',
                  label: '靶场镜像',
                  required: true,
                  placeholder: '例如：sqlmap:latest',
                },
                {
                  kind: 'select',
                  name: 'verifyKind',
                  label: '验证方式',
                  options: LAB_VERIFY_KIND_OPTIONS,
                  initial: 'file_read',
                },
                {
                  kind: 'text',
                  name: 'verifyTarget',
                  label: '验证目标',
                  required: true,
                  placeholder: '例如：/flag',
                  // The kind decides which record field this lands in; the
                  // mapping is a pure function with its own tests, because a
                  // condition stored in the wrong field is stored successfully
                  // and then never matches.
                  hint: LAB_VERIFY_TARGET_HINT,
                },
                {
                  kind: 'number',
                  name: 'timeLimitSec',
                  label: '限时（秒）',
                  placeholder: '考试必填；留空按 1800',
                  hint: '考试模式必须有时限，留空会按 1800 秒（30 分钟）提交。',
                },
                {
                  kind: 'textarea',
                  name: 'brief',
                  label: '任务说明',
                  placeholder: '给学员看的背景与要求',
                },
              ]}
              onSubmit={(values) =>
                run('lab:new', async () => {
                  const rule = labVerifyRuleFrom(
                    values.verifyKind as LabVerifyKind,
                    String(values.verifyTarget ?? ''),
                  );
                  if (!rule) {
                    throw new Error('请填写「验证目标」：没有它的规则无法判定结果。');
                  }
                  const mode = String(values.assessmentMode ?? 'practice');
                  const isExam = mode === 'exam';
                  const limit = Number(intFrom(values.timeLimitSec));
                  const body = {
                    unitId: values.unitId,
                    objectiveId: values.objectiveId,
                    assessmentMode: mode,
                    taskGoal: values.taskGoal,
                    dockerImage: values.dockerImage,
                    brief: values.brief || '',
                    verifyRules: [rule],
                    // An exam is taken cold, and the server refuses anything
                    // else. Rather than let the author submit a combination the
                    // server will reject, choosing "exam" submits the only
                    // values that satisfy the rule — and the field hints say so.
                    ...(isExam
                      ? {
                          hintPolicy: EXAM_FORCED_VALUES.hintPolicy,
                          allowRetry: EXAM_FORCED_VALUES.allowRetry,
                          timeLimitSec: Number.isFinite(limit) && limit > 0 ? limit : 1800,
                        }
                      : {}),
                  };
                  await requestJson(`${base}/lab-tasks`, {
                    method: 'POST',
                    body: JSON.stringify(body),
                  });
                  return isExam
                    ? '已新建实操任务（考试：无提示、不重试、限时）。'
                    : '已新建实操任务。';
                })
              }
            />
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {(snapshot.labTasks ?? []).length === 0 ? (
            <EmptySection phase={phase} kind="lab-tasks">
              还没有实操任务。实操类评价证据如果没有对应的实操任务，审核会报「有承诺、无交付」。
            </EmptySection>
          ) : (
            <ul className="flex flex-col gap-2">
              {(snapshot.labTasks ?? []).map((lab) => (
                <li
                  key={lab.id}
                  className="border-border flex items-start justify-between gap-3 rounded-lg border p-2.5"
                >
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-xs font-medium">{lab.taskGoal}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {objectiveById.get(lab.objectiveId)?.title ?? lab.objectiveId}
                      {' · '}
                      {unitById.get(lab.unitId)?.title ?? lab.unitId}
                      {' · '}
                      {lab.assessmentMode === 'exam' ? '考试' : '练习'}
                      {' · '}
                      {/* Shown per rule, by kind, so an author can see that the
                          condition was stored where the grader will read it. */}
                      {lab.verifyRules
                        .map((rule) => `${rule.kind}:${labRuleTarget(rule)}`)
                        .join('，')}
                    </span>
                  </div>
                  <DeleteButton
                    label={`删除实操任务「${lab.taskGoal}」`}
                    busyKey={`lab:${lab.id}`}
                    busy={busy}
                    onDelete={() =>
                      run(`lab:${lab.id}`, async () => {
                        await requestJson(`${base}/lab-tasks/${lab.id}`, { method: 'DELETE' });
                        return '已删除实操任务。';
                      })
                    }
                  />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/** One objective's evidence, with its own gated create form. */
function EvidenceBlock({
  objective,
  evidence,
  base,
  phase,
  busy,
  run,
}: {
  objective: CurriculumObjectiveRecord;
  evidence: CurriculumEvidenceRecord[];
  base: string;
  phase: CurriculumDesignPhase;
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}) {
  return (
    <div className="mt-3 flex flex-col gap-1.5 border-t pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px]">证据（{evidence.length}）</span>
        <CreateForm
          kind="evidence"
          phase={phase}
          busyKey={`evidence:${objective.id}`}
          busy={busy}
          submitLabel="加证据"
          fields={[
            {
              kind: 'select',
              name: 'evidenceType',
              label: '证据类型',
              options: [
                { value: 'quiz', label: '测验' },
                { value: 'lab', label: '实操' },
                { value: 'performance', label: '表现' },
                { value: 'dialogue', label: '对话' },
                { value: 'artifact', label: '产出物' },
              ],
              initial: 'quiz',
            },
            {
              kind: 'text',
              name: 'verificationMethod',
              label: '验证方式',
              required: true,
              placeholder: '实操验证',
            },
            {
              kind: 'textarea',
              name: 'successCondition',
              label: '成功条件',
              required: true,
              placeholder: '成功读取 /flag',
            },
          ]}
          onSubmit={(values) =>
            run(`evidence:${objective.id}`, async () => {
              await requestJson(`${base}/evidence`, {
                method: 'POST',
                body: JSON.stringify({ ...values, objectiveId: objective.id }),
              });
              return '已绑定评价证据。';
            })
          }
        />
      </div>
      {evidence.length === 0 ? (
        <span className="text-muted-foreground text-[11px]">
          没有证据的目标进不了{stepRef('graph')}。
        </span>
      ) : (
        evidence.map((row) => (
          <div
            key={row.id}
            className="border-border flex items-start justify-between gap-2 rounded border p-2 text-[11px]"
          >
            <span className="min-w-0">
              <span className="font-medium">{row.verificationMethod}</span>
              <span className="text-muted-foreground block">{row.successCondition}</span>
            </span>
            <DeleteButton
              label="删除证据"
              busyKey={`evidence-del:${row.id}`}
              busy={busy}
              onDelete={() =>
                run(`evidence-del:${row.id}`, async () => {
                  await requestJson(`${base}/evidence/${row.id}`, { method: 'DELETE' });
                  return '已删除证据。';
                })
              }
            />
          </div>
        ))
      )}
    </div>
  );
}

/** One node, with the objectives it supports chosen rather than pasted. */
function NodeBlock({
  node,
  objectiveOptions,
  supportedObjectiveIds,
  base,
  busy,
  run,
}: {
  node: CurriculumLearningNodeRecord;
  objectiveOptions: { value: string; label: string }[];
  supportedObjectiveIds: Set<string>;
  base: string;
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}) {
  /**
   * The link set is replaced whole on every change.
   *
   * `setCurriculumNodeObjectives` deletes and re-inserts, so a client that only
   * sent the delta would drop every other node's links. That is why the next set
   * is built from the current one minus/plus this one id rather than from just
   * the checked box.
   */
  const toggle = (objectiveId: string) => {
    const next = supportedObjectiveIds.has(objectiveId)
      ? [...supportedObjectiveIds].filter((id) => id !== objectiveId)
      : [...supportedObjectiveIds, objectiveId];
    void run(`links:${node.id}`, async () => {
      await requestJson(`${base}/node-objectives`, {
        method: 'PUT',
        body: JSON.stringify({ links: next.map((id) => ({ nodeId: node.id, objectiveId: id })) }),
      });
      return '已更新支撑关系。';
    });
  };

  return (
    <li className="border-border rounded-lg border p-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{node.name}</span>
        <DeleteButton
          label={`删除知识点「${node.name}」`}
          busyKey={`node:${node.id}`}
          busy={busy}
          onDelete={() =>
            run(`node:${node.id}`, async () => {
              await requestJson(`${base}/nodes/${node.id}`, { method: 'DELETE' });
              return '已删除知识点。';
            })
          }
        />
      </div>
      {objectiveOptions.length === 0 ? (
        <span className="text-muted-foreground text-[11px]">还没有目标可以让它支撑。</span>
      ) : (
        <div className="mt-1.5 flex flex-wrap gap-2">
          {objectiveOptions.map((option) => (
            <label
              key={option.value}
              className="text-muted-foreground flex max-w-56 items-center gap-1.5 text-[11px]"
              title={option.label}
            >
              <Checkbox
                checked={supportedObjectiveIds.has(option.value)}
                disabled={busy === `links:${node.id}`}
                onCheckedChange={() => toggle(option.value)}
              />
              <span className="truncate">{option.label}</span>
            </label>
          ))}
        </div>
      )}
    </li>
  );
}

/** The objective-order edges, plus the create that declares a new one. */
function DependencyBlock({
  dependencies,
  objectiveById,
  nodeById,
  base,
  phase,
  objectiveOptions,
  nodeOptions,
  busy,
  run,
}: {
  dependencies: { id: string; sourceId: string; targetId: string; edgeType: string }[];
  objectiveById: Map<string, CurriculumObjectiveRecord>;
  nodeById: Map<string, CurriculumLearningNodeRecord>;
  base: string;
  phase: CurriculumDesignPhase;
  objectiveOptions: { value: string; label: string }[];
  nodeOptions: { value: string; label: string }[];
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}) {
  const label = (id: string) =>
    objectiveById.get(id)?.title ?? nodeById.get(id)?.name ?? id.slice(0, 8);
  // One select for "any row in the graph", because an edge may join two
  // outcomes, two nodes, or one of each — the store keeps them in one table.
  const allOptions = useMemo(
    () => [
      ...objectiveOptions.map((option) => ({
        value: option.value,
        label: `目标 · ${option.label}`,
      })),
      ...nodeOptions.map((option) => ({ value: option.value, label: `知识点 · ${option.label}` })),
    ],
    [nodeOptions, objectiveOptions],
  );
  const kindOf = (id: string) =>
    objectiveById.has(id) ? 'objective' : nodeById.has(id) ? 'node' : null;

  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <GitBranch className="text-muted-foreground size-3.5" />
          <span className="text-muted-foreground text-[11px]">
            学习顺序依赖（{dependencies.length}）
          </span>
        </div>
        <CreateForm
          kind="dependencies"
          phase={phase}
          busyKey="dependency:new"
          busy={busy}
          submitLabel="加依赖"
          fields={[
            { kind: 'select', name: 'sourceId', label: '先学', options: allOptions },
            { kind: 'select', name: 'targetId', label: '后学', options: allOptions },
            {
              kind: 'select',
              name: 'edgeType',
              label: '关系',
              options: [
                { value: 'prerequisite', label: '先修（约束顺序）' },
                { value: 'derives', label: '推导' },
                { value: 'composes', label: '组成' },
                { value: 'supports', label: '支撑' },
                { value: 'practices', label: '练习' },
                { value: 'progresses', label: '进阶' },
              ],
              initial: 'prerequisite',
            },
          ]}
          onSubmit={async (values) => {
            const sourceKind = kindOf(String(values.sourceId));
            const targetKind = kindOf(String(values.targetId));
            if (!sourceKind || !targetKind) return;
            await run('dependency:new', async () => {
              await requestJson(`${base}/dependencies`, {
                method: 'POST',
                body: JSON.stringify({
                  sourceId: values.sourceId,
                  targetId: values.targetId,
                  sourceKind,
                  targetKind,
                  edgeType: values.edgeType,
                }),
              });
              return '已加入学习顺序依赖。';
            });
          }}
        />
      </div>
      {dependencies.length === 0 ? (
        <span className="text-muted-foreground text-[11px]">
          还没有声明先后关系。先修关系会被审核用来检查教学顺序。
        </span>
      ) : (
        <ul className="flex flex-col gap-1">
          {dependencies.map((edge) => (
            <li
              key={edge.id}
              className="border-border flex items-center justify-between gap-2 rounded border p-1.5 text-[11px]"
            >
              <span className="flex min-w-0 items-center gap-1">
                <Link2 className="text-muted-foreground size-3 shrink-0" />
                <span className="truncate">
                  {label(edge.sourceId)} → {label(edge.targetId)}
                </span>
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  {edge.edgeType}
                </Badge>
              </span>
              <DeleteButton
                label="撤回这条依赖"
                busyKey={`dependency:${edge.id}`}
                busy={busy}
                onDelete={() =>
                  run(`dependency:${edge.id}`, async () => {
                    await requestJson(`${base}/dependencies/${edge.id}`, { method: 'DELETE' });
                    return '已撤回依赖。';
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One item: title, role, hours and teaching design editable; delete always available. */
function UnitBlock({
  unit,
  base,
  nodeOptions,
  busy,
  run,
}: {
  unit: CurriculumUnitRecord;
  base: string;
  nodeOptions: { value: string; label: string }[];
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}) {
  return (
    <li className="border-border flex flex-col gap-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="outline" className="px-1 py-0 text-[10px]">
          {roleLabel(unit.unitRole)}
        </Badge>
        <span className="text-xs font-medium">{unit.title}</span>
        {unit.hours !== null && (
          <span className="text-muted-foreground text-[10px]">{unit.hours} 学时</span>
        )}
        {unit.stageId && (
          <Badge className="bg-emerald-500/15 px-1 py-0 text-[10px] text-emerald-700 dark:text-emerald-300">
            已出课
          </Badge>
        )}
        <span className="ml-auto">
          <DeleteButton
            label={`删除条目「${unit.title}」`}
            busyKey={`unit:${unit.id}`}
            busy={busy}
            onDelete={() =>
              run(`unit:${unit.id}`, async () => {
                await requestJson(`${base}/units/${unit.id}`, { method: 'DELETE' });
                return '已删除条目及其覆盖。';
              })
            }
          />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={unit.unitRole ?? 'lecture'}
          onValueChange={(value) =>
            void run(`unit-role:${unit.id}`, async () => {
              await requestJson(`${base}/units/${unit.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ unitRole: value }),
              });
              return '已更新角色，它生成什么随之改变。';
            })
          }
        >
          <SelectTrigger className="h-8 w-32 text-xs" aria-label="条目角色">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {ROLE_OPTIONS.map((role) => (
              <SelectItem key={role.value} value={role.value}>
                {role.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <InlineEdit
          rowId={unit.id}
          field="title"
          label="标题"
          value={unit.title}
          busyKey={`unit-title:${unit.id}`}
          busy={busy}
          onSave={(next) =>
            run(`unit-title:${unit.id}`, async () => {
              await requestJson(`${base}/units/${unit.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ title: next }),
              });
              return '已保存条目。';
            })
          }
        />
        <InlineEdit
          rowId={unit.id}
          field="hours"
          label="学时"
          value={unit.hours === null ? '' : String(unit.hours)}
          busyKey={`unit-hours:${unit.id}`}
          busy={busy}
          placeholder="2"
          onSave={(next) =>
            run(`unit-hours:${unit.id}`, async () => {
              const trimmed = next.trim();
              await requestJson(`${base}/units/${unit.id}`, {
                method: 'PATCH',
                body: JSON.stringify({ hours: trimmed === '' ? null : Number(trimmed) }),
              });
              return '已保存学时。';
            })
          }
        />
      </div>
      <TeachingDesignEditor
        unit={unit}
        nodeOptions={nodeOptions}
        base={base}
        busy={busy}
        run={run}
      />
    </li>
  );
}

/**
 * What the item teaches, and what it deliberately leaves out.
 *
 * This exists because the item form above can create a row the course then
 * cannot export. `objective_missing_prereq` requires that some item's
 * `teachingDesign` name the primary node of an objective the item teaches, and
 * without a control for it the workbench produced items that were permanently
 * stuck at one audit finding — the gate was right, and the screen offered no way
 * to satisfy it.
 *
 * The four depth buckets are the point of the design rather than of the form: an
 * item that says "everything relevant" has not decided what to skip, and the
 * `omit` bucket is where that decision becomes reviewable instead of implicit.
 *
 * The node fields take **node ids**, because the audit compares against ids. A
 * label saying so is not decoration — writing a node's *name* here passes the
 * form and then fails the audit, which is exactly the mistake this control is
 * most likely to invite. The picker below therefore offers names and writes ids.
 */
function TeachingDesignEditor({
  unit,
  nodeOptions,
  base,
  busy,
  run,
}: {
  unit: CurriculumUnitRecord;
  nodeOptions: { value: string; label: string }[];
  base: string;
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const design = unit.teachingDesign ?? {};
  const namedNodeIds = design.nodes ?? [];
  const coreNodeIds = design.core ?? [];

  const toggleNode = (nodeId: string, bucket: 'nodes' | 'core') => {
    const key = bucket === 'core' ? `unit-core:${unit.id}` : `unit-nodes:${unit.id}`;
    const current = new Set(bucket === 'core' ? coreNodeIds : namedNodeIds);
    const next = current.has(nodeId)
      ? [...current].filter((id) => id !== nodeId)
      : [...current, nodeId];
    void run(key, async () => {
      await requestJson(`${base}/units/${unit.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ teachingDesign: { ...design, [bucket]: next } }),
      });
      return '已保存教学设计。';
    });
  };

  const summary =
    [
      namedNodeIds.length > 0 ? `涉及 ${namedNodeIds.length} 个知识点` : null,
      coreNodeIds.length > 0 ? `其中 ${coreNodeIds.length} 个必须讲透` : null,
    ]
      .filter(Boolean)
      .join(' · ') || '还没有教学设计';

  return (
    <div className="border-border rounded border p-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px]">{summary}</span>
        <Button size="sm" variant="ghost" onClick={() => setOpen((current) => !current)}>
          {open ? '收起教学设计' : '编辑教学设计'}
        </Button>
      </div>
      {open ? (
        <div className="mt-2 flex flex-col gap-3">
          <div className="text-muted-foreground text-[10px]">
            下面两个列表是审核真正读的地方：目标被某个条目教了，而这个条目必须点名支撑它的知识点。勾选后保存的是知识点
            id，标签显示的是名称。
          </div>
          {nodeOptions.length === 0 ? (
            <span className="text-muted-foreground text-[11px]">
              还没有知识点可挂，先在「知识技能与依赖」里建一个。
            </span>
          ) : (
            nodeOptions.map((option) => (
              <div
                key={option.value}
                data-testid="teaching-node-row"
                data-node-id={option.value}
                className="flex flex-wrap items-center gap-2"
              >
                <span className="min-w-32 flex-1 truncate text-[11px]">{option.label}</span>
                <label className="flex items-center gap-1 text-[11px]">
                  <input
                    type="checkbox"
                    aria-label={`涉及 ${option.label}`}
                    className="size-3.5 accent-primary"
                    checked={namedNodeIds.includes(option.value)}
                    disabled={busy === `unit-nodes:${unit.id}`}
                    onChange={() => toggleNode(option.value, 'nodes')}
                  />
                  涉及
                </label>
                <label className="flex items-center gap-1 text-[11px]">
                  <input
                    type="checkbox"
                    aria-label={`讲透 ${option.label}`}
                    className="size-3.5 accent-primary"
                    checked={coreNodeIds.includes(option.value)}
                    disabled={busy === `unit-core:${unit.id}`}
                    onChange={() => toggleNode(option.value, 'core')}
                  />
                  讲透
                </label>
              </div>
            ))
          )}
          <InlineEdit
            rowId={unit.id}
            field="omit"
            label="明确不讲什么（每行一条）"
            value={(design.omit ?? []).join('\n')}
            busyKey={`unit-omit:${unit.id}`}
            busy={busy}
            multiline
            placeholder={'SQLMap 的安装\n存储型注入的细节'}
            onSave={(next) =>
              run(`unit-omit:${unit.id}`, async () => {
                await requestJson(`${base}/units/${unit.id}`, {
                  method: 'PATCH',
                  body: JSON.stringify({
                    teachingDesign: {
                      ...design,
                      omit: next
                        .split('\n')
                        .map((line) => line.trim())
                        .filter((line) => line !== ''),
                    },
                  }),
                });
                return '已保存教学设计。';
              })
            }
          />
        </div>
      ) : null}
    </div>
  );
}

/**
 * The teaching order the author declared, between items.
 *
 * The two order audits read different things and both are worth showing: the
 * dependency graph's edges, and the outline sequence itself. A course can be
 * internally consistent and still teach things in the wrong order, and the
 * sequence edges are the only record of the author's intent to compare against.
 */
function ItemOrderBlock({
  edges,
  unitById,
  base,
  phase,
  itemOptions,
  busy,
  run,
}: {
  edges: { id: string; sourceUnitId: string; targetUnitId: string; edgeType: string }[];
  unitById: Map<string, CurriculumUnitRecord>;
  base: string;
  phase: CurriculumDesignPhase;
  itemOptions: { value: string; label: string }[];
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}) {
  const label = (id: string) => unitById.get(id)?.title ?? id.slice(0, 8);
  return (
    <div className="border-border flex flex-col gap-2 rounded-lg border p-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Link2 className="text-muted-foreground size-3.5" />
          <span className="text-muted-foreground text-[11px]">条目教学顺序（{edges.length}）</span>
        </div>
        <CreateForm
          kind="unit-dependencies"
          phase={phase}
          busyKey="order:new"
          busy={busy}
          submitLabel="声明顺序"
          fields={[
            { kind: 'select', name: 'sourceUnitId', label: '先讲', options: itemOptions },
            { kind: 'select', name: 'targetUnitId', label: '后讲', options: itemOptions },
            {
              kind: 'select',
              name: 'edgeType',
              label: '关系',
              options: [
                { value: 'prerequisite', label: '先修（会检查顺序）' },
                { value: 'follow-up', label: '后续' },
                { value: 'related', label: '相关（不检查顺序）' },
              ],
              initial: 'prerequisite',
            },
          ]}
          onSubmit={(values) =>
            run('order:new', async () => {
              await requestJson(`${base}/unit-dependencies`, {
                method: 'POST',
                body: JSON.stringify(values),
              });
              return '已声明教学顺序。';
            })
          }
        />
      </div>
      {edges.length === 0 ? (
        <span className="text-muted-foreground text-[11px]">
          还没有声明条目前后。只有「先修」会被审核拿去检查是否与大纲顺序一致。
        </span>
      ) : (
        <ul className="flex flex-col gap-1">
          {edges.map((edge) => (
            <li
              key={edge.id}
              className="border-border flex items-center justify-between gap-2 rounded border p-1.5 text-[11px]"
            >
              <span className="flex min-w-0 items-center gap-1">
                <span className="truncate">
                  {label(edge.sourceUnitId)} → {label(edge.targetUnitId)}
                </span>
                <Badge variant="outline" className="px-1 py-0 text-[10px]">
                  {edge.edgeType}
                </Badge>
              </span>
              <DeleteButton
                label="撤回这条顺序"
                busyKey={`order:${edge.id}`}
                busy={busy}
                onDelete={() =>
                  run(`order:${edge.id}`, async () => {
                    await requestJson(`${base}/unit-dependencies/${edge.id}`, { method: 'DELETE' });
                    return '已撤回教学顺序。';
                  })
                }
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export type { FormField, FormValues };
