/**
 * 系列设计页 —— 课程方向、课程目标、知识体系，一次定完。
 *
 * 它回答的正是用户在驾驶舱里的疑问：**「六十多个目，每个目都要走七步吗？」**
 * 不。第 1–3 步的目标是系列，不是目：谁学、学完能做什么、这门课的知识体系长
 * 什么样，六十三目各写一遍只会得到六十三份互相矛盾的答案。所以它们在这里做
 * 一次，目在那里继承与承接。
 *
 * 页面按"先方向、再目标、再知识体系、最后大纲"排，与生成顺序一致：知识体系
 * 要能落回大纲，所以最后引用大纲（第 4 步在驾驶舱里，已有）。
 *
 * 两份文档都可以「AI 起草」或「直接编辑文本」：AI 只是把空白填成草稿，最终写进
 * 去的是用户看过的那一份；文本编辑走同一套解析函数，所以人改的和模型写的没有
 * 两种格式。
 */
'use client';

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ArrowLeft, BookOpen, Loader2, PencilLine, Sparkles, Target } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  formatNodesText,
  formatObjectivesText,
  parseNodesText,
  parseObjectivesText,
  seriesDesignComplete,
  type OutlineDesignDrift,
  type SeriesDesignDoc,
  type SeriesDesignSnapshot,
} from '@/lib/curriculum/series-design';

const STEP_LABEL = ['① 方向', '② 课程目标', '③ 知识体系'] as const;

const PHASE_INDEX: Record<SeriesDesignSnapshot['phase'], number> = {
  direction: 0,
  objectives: 1,
  knowledge: 2,
};

/**
 * 设计接口的读 / 写响应：设计快照 + 大纲跟没跟上的读数。
 *
 * 放在一起返回，是因为"刚存完这一版，之前生成的大纲要不要重做"是同一个问题的
 * 两半；分成两次请求会出现"保存成功、提示却来自上一版"的窗口。
 */
type SeriesDesignPayload = SeriesDesignSnapshot & { outlineDrift: OutlineDesignDrift };

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  return payload as T;
}

export function SeriesDesignWorkspace({ seriesId }: { seriesId: string }) {
  const [snapshot, setSnapshot] = useState<SeriesDesignPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [directionOpen, setDirectionOpen] = useState(false);
  const [objectivesTextOpen, setObjectivesTextOpen] = useState(false);
  const [nodesTextOpen, setNodesTextOpen] = useState(false);
  const [aiDraft, setAiDraft] = useState<SeriesDesignDoc | null>(null);
  const [textError, setTextError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const next = await requestJson<SeriesDesignPayload>(
        `/api/curriculum/series/${seriesId}/design`,
      );
      setSnapshot(next);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '读取系列设计失败');
    }
  }, [seriesId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const save = useCallback(
    async (patch: Record<string, unknown>, label: string) => {
      setBusy(label);
      setError(null);
      try {
        const next = await requestJson<SeriesDesignPayload>(
          `/api/curriculum/series/${seriesId}/design`,
          {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          },
        );
        setSnapshot(next);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : '保存失败');
      } finally {
        setBusy(null);
      }
    },
    [seriesId],
  );

  const draftWithAi = useCallback(async () => {
    setBusy('ai');
    setError(null);
    try {
      const payload = await requestJson<{ draft: SeriesDesignDoc }>(
        `/api/curriculum/series/${seriesId}/design/ai`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      setAiDraft(payload.draft);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 起草失败');
    } finally {
      setBusy(null);
    }
  }, [seriesId]);

  const adoptDraft = useCallback(async () => {
    if (!aiDraft) return;
    await save({ objectives: aiDraft.objectives, nodes: aiDraft.nodes }, 'adopt');
    setAiDraft(null);
  }, [aiDraft, save]);

  if (!snapshot) {
    return (
      <main className="mx-auto w-full max-w-6xl px-4 py-10">
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          {error ? (
            <span className="text-destructive">{error}</span>
          ) : (
            <>
              <Loader2 className="size-4 animate-spin" /> 正在读取系列设计…
            </>
          )}
        </div>
      </main>
    );
  }

  const design = snapshot.design;
  const currentIndex = PHASE_INDEX[snapshot.phase];
  // 前三步是否定完：相位只看目标与节点，方向为空时相位仍停在 knowledge，
  // 所以"能不能去搭大纲"必须看缺口，而不是相位。
  const complete = seriesDesignComplete(design);

  return (
    <main className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-4 py-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-col gap-2">
          <Link
            href={`/curriculum/series/${seriesId}`}
            className="text-muted-foreground hover:text-foreground flex w-fit items-center gap-1 text-xs"
          >
            <ArrowLeft className="size-3.5" /> 课程系列 / 返回驾驶舱
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight">
            系列设计 · {snapshot.series.name}
          </h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            方向、课程目标、知识体系属于整个系列，只做一次；每个目继承方向、承接目标、在知识体系里挑点。做完这三步，目只需要管自己的条目、讲稿、题目与审核。
          </p>
        </div>
        <Button onClick={() => void draftWithAi()} disabled={busy !== null}>
          {busy === 'ai' ? <Loader2 className="animate-spin" /> : <Sparkles />}
          AI 起草目标与知识体系
        </Button>
      </div>

      <ol className="border-border bg-muted/30 flex flex-wrap gap-2 rounded-xl border p-2 text-sm">
        {STEP_LABEL.map((label, index) => {
          const state = complete
            ? 'done'
            : index < currentIndex
              ? 'done'
              : index === currentIndex
                ? 'current'
                : 'todo';
          return (
            <li
              key={label}
              className={
                state === 'done'
                  ? 'rounded-md bg-emerald-500/15 px-3 py-1 text-emerald-700 dark:text-emerald-300'
                  : state === 'current'
                    ? 'bg-primary text-primary-foreground rounded-md px-3 py-1'
                    : 'text-muted-foreground rounded-md px-3 py-1'
              }
            >
              {label}
              {state === 'done' ? ' ✓' : state === 'current' ? ' · 你在这' : ''}
            </li>
          );
        })}
        <li
          className={
            complete
              ? 'rounded-md bg-emerald-500/15 px-3 py-1 text-emerald-700 dark:text-emerald-300'
              : 'text-muted-foreground rounded-md px-3 py-1'
          }
        >
          ④ 大纲（驾驶舱）{complete ? ' · 下一步' : ''}
        </li>
      </ol>

      {error ? (
        <div className="border-destructive/40 bg-destructive/10 text-destructive rounded-lg border p-3 text-sm">
          {error}
        </div>
      ) : null}

      {snapshot.outlineDrift.stale.chapters +
        snapshot.outlineDrift.stale.sections +
        snapshot.outlineDrift.stale.items >
      0 ? (
        <Card
          className="border-amber-500/40 bg-amber-500/5"
          data-testid="design-outline-drift"
          aria-label="大纲还没跟上这版设计"
        >
          <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4 text-sm">
            <div className="min-w-0">
              <p className="font-medium">大纲里还有内容是按旧版设计生成的</p>
              <p className="text-muted-foreground mt-1 text-xs">
                已有 {snapshot.outlineDrift.stale.chapters} 章 /{' '}
                {snapshot.outlineDrift.stale.sections} 节 / {snapshot.outlineDrift.stale.items}{' '}
                目没跟上。已生成的内容不会自动跟着改：去驾驶舱重新生成对应层，或直接改章 / 节的
                交底（改过就不再算旧版）。
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href={`/curriculum/series/${seriesId}`}>去驾驶舱看大纲</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <DirectionCard
        snapshot={snapshot}
        busy={busy !== null}
        onEdit={() => setDirectionOpen(true)}
      />

      <ObjectivesCard
        snapshot={snapshot}
        busy={busy !== null}
        onAi={() => void draftWithAi()}
        onEdit={() => {
          setTextError(null);
          setObjectivesTextOpen(true);
        }}
      />

      <NodesCard
        snapshot={snapshot}
        busy={busy !== null}
        onAi={() => void draftWithAi()}
        onEdit={() => {
          setTextError(null);
          setNodesTextOpen(true);
        }}
      />

      <Card>
        <CardHeader className="flex flex-row items-center gap-2 pb-2">
          <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-medium">
            第 4 步
          </span>
          <CardTitle className="text-base">大纲（章 → 节 → 目）</CardTitle>
        </CardHeader>
        <CardContent className="text-muted-foreground flex flex-wrap items-center justify-between gap-3 text-sm">
          {complete ? (
            <span>前三步已经定下来。去驾驶舱搭大纲：章 → 节 → 目，AI 生成会以这份设计为依据。</span>
          ) : (
            <span>前三步先定下来，大纲才有依据。现在去驾驶舱，AI 只能按系列名称和说明猜。</span>
          )}
          {complete ? (
            <Button asChild size="sm" data-testid="design-outline-cta">
              <Link href={`/curriculum/series/${seriesId}`}>
                <BookOpen /> 去搭建大纲
              </Link>
            </Button>
          ) : (
            <Button
              size="sm"
              disabled
              data-testid="design-outline-cta"
              title="先把方向、课程目标、知识体系补齐"
            >
              <BookOpen /> 去搭建大纲
            </Button>
          )}
        </CardContent>
      </Card>

      {/* 对话框只在打开时挂载：表单从快照初始化，关掉即销毁。不用 effect 重置状态，
          因为「打开时把 props 抄进 state」在 React 里是反模式，也会触发级联渲染。 */}
      {directionOpen ? (
        <DirectionDialog
          open
          onOpenChange={(open) => {
            if (!open) setDirectionOpen(false);
          }}
          snapshot={snapshot}
          busy={busy !== null}
          onSave={async (direction) => {
            await save({ direction }, 'direction');
            setDirectionOpen(false);
          }}
        />
      ) : null}

      {objectivesTextOpen ? (
        <TextDialog
          open
          onOpenChange={(open) => {
            if (!open) setObjectivesTextOpen(false);
          }}
          title="编辑课程目标"
          description="按「## 标题」分块，每块四行：能做什么 / 最低达标 / 怎么证明 / 支撑知识点（用「、」分隔）。"
          initialText={formatObjectivesText(design.objectives, design)}
          error={textError}
          onSave={async (text) => {
            const parsed = parseObjectivesText(text, design.nodes);
            if (parsed.errors.length > 0) {
              setTextError(parsed.errors.join('；'));
              return;
            }
            await save({ objectives: parsed.value }, 'objectives');
            setObjectivesTextOpen(false);
          }}
        />
      ) : null}

      {nodesTextOpen ? (
        <TextDialog
          open
          onOpenChange={(open) => {
            if (!open) setNodesTextOpen(false);
          }}
          title="编辑知识体系"
          description="按「## 名字 | knowledge 或 skill | 难度」分块，下面两行：摘要 / 先修（用「、」分隔节点名）。"
          initialText={formatNodesText(design.nodes)}
          error={textError}
          onSave={async (text) => {
            const parsed = parseNodesText(text);
            if (parsed.errors.length > 0) {
              setTextError(parsed.errors.join('；'));
              return;
            }
            await save({ nodes: parsed.value }, 'nodes');
            setNodesTextOpen(false);
          }}
        />
      ) : null}

      <AiDraftDialog
        draft={aiDraft}
        onOpenChange={(open) => {
          if (!open) setAiDraft(null);
        }}
        busy={busy === 'adopt'}
        onAdopt={() => void adoptDraft()}
      />
    </main>
  );
}

function DirectionCard({
  snapshot,
  busy,
  onEdit,
}: {
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  onEdit: () => void;
}) {
  const direction = snapshot.design.direction;
  const gaps = snapshot.gaps.direction;
  const rows: { label: string; value: string | null }[] = [
    { label: '授课对象', value: direction.audience },
    { label: '学员基础', value: direction.learnerLevel },
    { label: '训练场景', value: direction.trainingScenario },
    { label: '应用场景', value: direction.applicationScene },
    { label: '课程范围', value: direction.problemStatement },
    {
      label: '系列总学时',
      value: direction.durationHours === null ? null : String(direction.durationHours),
    },
  ];
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2">
          <StepChip step={1} />
          <CardTitle className="text-base">方向：谁学、什么基础、什么场景</CardTitle>
        </div>
        <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
          <PencilLine /> 编辑方向
        </Button>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <div className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          {rows.map((row) => (
            <div key={row.label} className="flex flex-col">
              <span className="text-muted-foreground text-xs">{row.label}</span>
              <span className={row.value ? '' : 'text-muted-foreground italic'}>
                {row.value ?? '未填写'}
              </span>
            </div>
          ))}
        </div>
        {gaps.length > 0 ? (
          <ul className="text-amber-700 dark:text-amber-400 list-disc pl-5 text-xs">
            {gaps.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-emerald-700 dark:text-emerald-400">方向已完整，目会继承它。</p>
        )}
      </CardContent>
    </Card>
  );
}

function ObjectivesCard({
  snapshot,
  busy,
  onAi,
  onEdit,
}: {
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  onAi: () => void;
  onEdit: () => void;
}) {
  const { objectives } = snapshot.design;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2">
          <StepChip step={2} />
          <CardTitle className="text-base">
            课程目标与证据（{objectives.length} 条，属于整个系列）
          </CardTitle>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onAi} disabled={busy}>
            <Sparkles /> AI 起草
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <PencilLine /> 编辑文本
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {objectives.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有课程目标。目标回答「学完整个系列能做出什么」，每一条都会被目承接。
          </p>
        ) : (
          objectives.map((objective) => (
            <div key={objective.id} className="border-border rounded-lg border p-3">
              <div className="flex items-start gap-2">
                <Target className="text-primary mt-0.5 size-4 shrink-0" />
                <div className="flex flex-col gap-1">
                  <span className="font-medium">{objective.title}</span>
                  <span className="text-sm">
                    {objective.expectedBehavior || '（缺可观察行为）'}
                  </span>
                  {objective.minCriteria.length > 0 ? (
                    <span className="text-muted-foreground text-xs">
                      最低达标：{objective.minCriteria.join('；')}
                    </span>
                  ) : null}
                  {objective.evidence ? (
                    <span className="text-muted-foreground text-xs">
                      证明：{objective.evidence}
                    </span>
                  ) : null}
                  <span className="text-muted-foreground text-xs">
                    支撑知识点：
                    {objective.nodeIds
                      .map((id) => snapshot.nodeNames[id])
                      .filter(Boolean)
                      .join('、') || '（无）'}
                  </span>
                </div>
              </div>
            </div>
          ))
        )}
        {snapshot.gaps.objectives.length > 0 ? (
          <ul className="text-amber-700 dark:text-amber-400 list-disc pl-5 text-xs">
            {snapshot.gaps.objectives.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function NodesCard({
  snapshot,
  busy,
  onAi,
  onEdit,
}: {
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  onAi: () => void;
  onEdit: () => void;
}) {
  const { nodes } = snapshot.design;
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2">
          <StepChip step={3} />
          <CardTitle className="text-base">知识体系（{nodes.length} 个知识 / 技能点）</CardTitle>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onAi} disabled={busy}>
            <Sparkles /> AI 起草
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <PencilLine /> 编辑文本
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
        {nodes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有知识点。知识体系是整门系列的知识地图，每一目只挑其中几个点来讲。
          </p>
        ) : (
          nodes.map((node) => (
            <div
              key={node.id}
              className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
            >
              <span className="font-medium">{node.name}</span>
              <span className="bg-muted text-muted-foreground rounded px-1.5 text-xs">
                {node.type === 'skill' ? '技能' : '知识'}
              </span>
              <span className="text-muted-foreground text-xs">{node.difficulty}</span>
              <span className="text-muted-foreground flex-1 text-xs">{node.summary}</span>
              {node.prerequisites.length > 0 ? (
                <span className="text-muted-foreground text-xs">
                  先修：{node.prerequisites.map((id) => byId.get(id)?.name ?? id).join('、')}
                </span>
              ) : null}
            </div>
          ))
        )}
        {snapshot.gaps.knowledge.length > 0 ? (
          <ul className="text-amber-700 dark:text-amber-400 list-disc pl-5 text-xs">
            {snapshot.gaps.knowledge.map((gap) => (
              <li key={gap}>{gap}</li>
            ))}
          </ul>
        ) : null}
      </CardContent>
    </Card>
  );
}

function StepChip({ step }: { step: number }) {
  return (
    <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-medium">
      第 {step} 步
    </span>
  );
}

function DirectionDialog({
  open,
  onOpenChange,
  snapshot,
  busy,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  onSave: (direction: Record<string, unknown>) => Promise<void>;
}) {
  const direction = snapshot.design.direction;
  const [audience, setAudience] = useState(direction.audience ?? '');
  const [learnerLevel, setLearnerLevel] = useState(direction.learnerLevel ?? '');
  const [trainingScenario, setTrainingScenario] = useState(direction.trainingScenario ?? '');
  const [applicationScene, setApplicationScene] = useState(direction.applicationScene ?? '');
  const [problemStatement, setProblemStatement] = useState(direction.problemStatement ?? '');
  const [durationHours, setDurationHours] = useState(
    direction.durationHours === null ? '' : String(direction.durationHours),
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>系列方向</DialogTitle>
          <DialogDescription>
            目会继承这里的授课对象、基础与场景；每个目只写自己的范围与学时。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Field label="授课对象">
            <Input
              value={audience}
              placeholder="例如：零基础高校网络安全专业学生"
              onChange={(event) => setAudience(event.target.value)}
            />
          </Field>
          <Field label="学员基础">
            <Input
              value={learnerLevel}
              placeholder="例如：会 Linux 基本命令、懂 HTTP 请求"
              onChange={(event) => setLearnerLevel(event.target.value)}
            />
          </Field>
          <Field label="训练场景">
            <Input
              value={trainingScenario}
              placeholder="例如：线下集中实训 + 线上自学"
              onChange={(event) => setTrainingScenario(event.target.value)}
            />
          </Field>
          <Field label="应用场景">
            <Input
              value={applicationScene}
              placeholder="例如：校内选拔赛 / 校队集训"
              onChange={(event) => setApplicationScene(event.target.value)}
            />
          </Field>
          <Field label="课程范围">
            <Textarea
              className="min-h-20"
              value={problemStatement}
              placeholder="这门系列要解决什么问题，以及明确不做什么"
              onChange={(event) => setProblemStatement(event.target.value)}
            />
          </Field>
          <Field label="系列总学时">
            <Input
              type="number"
              value={durationHours}
              placeholder="例如：54"
              onChange={(event) => setDurationHours(event.target.value)}
            />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void onSave({
                audience: audience.trim() || null,
                learnerLevel: learnerLevel.trim() || null,
                trainingScenario: trainingScenario.trim() || null,
                applicationScene: applicationScene.trim() || null,
                problemStatement: problemStatement.trim() || null,
                durationHours: durationHours.trim() === '' ? null : Number(durationHours),
              })
            }
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            保存方向
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="text-muted-foreground text-xs">{label}</span>
      {children}
    </label>
  );
}

function TextDialog({
  open,
  onOpenChange,
  title,
  description,
  initialText,
  error,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  initialText: string;
  error: string | null;
  onSave: (text: string) => Promise<void>;
}) {
  // 初次挂载即当前值：父组件只在打开时渲染这个对话框。
  const [text, setText] = useState(initialText);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <Textarea
          className="min-h-[50vh] font-mono text-xs"
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        {error ? <p className="text-destructive text-xs">{error}</p> : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void onSave(text)}>保存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AiDraftDialog({
  draft,
  onOpenChange,
  busy,
  onAdopt,
}: {
  draft: SeriesDesignDoc | null;
  onOpenChange: (open: boolean) => void;
  busy: boolean;
  onAdopt: () => void;
}) {
  return (
    <Dialog open={draft !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI 起草结果</DialogTitle>
          <DialogDescription>
            采用会整体替换课程目标与知识体系。已有的手写内容如果不在草稿里，会被覆盖——不放心就先取消，把它抄进文本编辑框里再点采用。
          </DialogDescription>
        </DialogHeader>
        {draft ? (
          <div className="flex max-h-[55vh] flex-col gap-3 overflow-y-auto text-sm">
            <div>
              <p className="font-medium">课程目标（{draft.objectives.length}）</p>
              <ul className="text-muted-foreground list-disc pl-5 text-xs">
                {draft.objectives.map((objective) => (
                  <li key={objective.id}>{objective.title}</li>
                ))}
              </ul>
            </div>
            <div>
              <p className="font-medium">知识体系（{draft.nodes.length}）</p>
              <ul className="text-muted-foreground list-disc pl-5 text-xs">
                {draft.nodes.slice(0, 40).map((node) => (
                  <li key={node.id}>
                    {node.name}（{node.type === 'skill' ? '技能' : '知识'}）
                  </li>
                ))}
                {draft.nodes.length > 40 ? <li>… 其余 {draft.nodes.length - 40} 个</li> : null}
              </ul>
            </div>
          </div>
        ) : null}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={onAdopt} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            采用这份草稿
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
