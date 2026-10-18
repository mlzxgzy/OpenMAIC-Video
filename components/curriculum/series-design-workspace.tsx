/**
 * 系列设计页 —— 课程方向、课程目标、知识体系，一次定完。
 *
 * 它回答的正是用户在驾驶舱里的疑问：**「六十多个目，每个目都要走七步吗？」**
 * 不。第 1–3 步的目标是系列，不是目：谁学、学完能做什么、这门课的知识体系长
 * 什么样，六十三目各写一遍只会得到六十三份互相矛盾的答案。所以它们在这里做
 * 一次，目在那里继承与承接。
 *
 * 页面按"先方向、再目标、再知识体系、最后大纲"排：知识体系是设计，大纲是它的
 * 编排结果（第 4 步在驾驶舱里）。所以这里**不要求先有大纲**——没有大纲时 AI
 * 只能依据名称与方向起草，落点覆盖等大纲建好后再校验（`readSeriesDesignCoverage`）。
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
  appendNodeCandidates,
  appendObjectiveCandidates,
  countDroppedNodePrerequisites,
  formatNodesText,
  formatObjectivesText,
  groupSeriesNodes,
  groupSeriesObjectives,
  parseNodesText,
  parseObjectivesText,
  screenNodeCandidates,
  screenObjectiveCandidates,
  seriesDesignComplete,
  seriesNodeDifficultyLabel,
  seriesNodeTypeLabel,
  seriesObjectiveTypeLabel,
  type OutlineDesignDrift,
  type SeriesCourseObjective,
  type SeriesDesignCoverage,
  type SeriesDesignDirection,
  type SeriesDesignDoc,
  type SeriesDesignSnapshot,
  type SeriesKnowledgeCandidate,
  type SeriesKnowledgeNode,
  type SeriesObjectiveCandidate,
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
/**
 * 设计接口的读 / 写响应：设计快照 + 两份派生读数。
 *
 * `outlineDrift` 回答"大纲跟没跟上这版设计"；`coverage` 回答"设计有没有落到目里"。
 * 两者方向相反，但都是"保存之后才知道"的事，所以跟快照一起返回；分成两次请求会
 * 出现"保存成功、提示却来自上一版"的窗口。
 */
type SeriesDesignPayload = SeriesDesignSnapshot & {
  outlineDrift: OutlineDesignDrift;
  coverage: SeriesDesignCoverage;
};

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
  const [directionDraft, setDirectionDraft] = useState<SeriesDesignDirection | null>(null);
  const [objectivesTextOpen, setObjectivesTextOpen] = useState(false);
  const [nodesTextOpen, setNodesTextOpen] = useState(false);
  const [aiDraft, setAiDraft] = useState<SeriesDesignDoc | null>(null);
  // 候选池不是设计文档：勾选前它只是内存里的一份清单，取消就丢掉。
  const [objectivesDraft, setObjectivesDraft] = useState<SeriesObjectiveCandidate[] | null>(null);
  const [nodesDraft, setNodesDraft] = useState<SeriesKnowledgeCandidate[] | null>(null);
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

  // 方向单独起草：它是第 1 步，用户在这一步停住时目标与知识体系还没有依据。
  // 共用 busy 状态，但用不同的标签，按钮各自转自己的圈。
  const draftDirectionWithAi = useCallback(async () => {
    setBusy('direction-ai');
    setError(null);
    try {
      const payload = await requestJson<{ direction: SeriesDesignDirection }>(
        `/api/curriculum/series/${seriesId}/design/direction/ai`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      setDirectionDraft(payload.direction);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 填写方向失败');
    } finally {
      setBusy(null);
    }
  }, [seriesId]);

  // 课程目标单独生成**候选池**：第 2 步的 AI 不是"替我写完"，而是"给我一批可挑的"。
  // 采用哪些由弹窗里的勾选决定，写库仍走 PATCH；所以这个入口不会动已有目标。
  const draftObjectivesWithAi = useCallback(async () => {
    setBusy('objectives-ai');
    setError(null);
    try {
      const payload = await requestJson<{ candidates: SeriesObjectiveCandidate[] }>(
        `/api/curriculum/series/${seriesId}/design/objectives/ai`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      setObjectivesDraft(payload.candidates);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 生成候选目标失败');
    } finally {
      setBusy(null);
    }
  }, [seriesId]);

  // 知识体系单独生成**候选池**：依据是第 2 步的目标。没有目标时按钮是灰的，
  // 接口也回 409——生成的每个点都要能回答"它支撑哪条承诺"。
  const draftNodesWithAi = useCallback(async () => {
    setBusy('knowledge-ai');
    setError(null);
    try {
      const payload = await requestJson<{ candidates: SeriesKnowledgeCandidate[] }>(
        `/api/curriculum/series/${seriesId}/design/knowledge/ai`,
        { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
      );
      setNodesDraft(payload.candidates);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'AI 生成候选知识点失败');
    } finally {
      setBusy(null);
    }
  }, [seriesId]);

  const adoptDirection = useCallback(
    async (direction: SeriesDesignDirection) => {
      await save({ direction }, 'direction-ai-adopt');
      setDirectionDraft(null);
    },
    [save],
  );

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
  // 大纲：设计不需要它，落点校验需要它。两个场景分开处理，不要混成一道门禁。
  const hasOutline =
    snapshot.outlineDrift.total.chapters +
      snapshot.outlineDrift.total.sections +
      snapshot.outlineDrift.total.items >
    0;

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

      {hasOutline ? null : (
        <Card
          className="border-primary/30 bg-primary/5"
          data-testid="design-no-outline"
          aria-label="还没有大纲"
        >
          <CardContent className="py-4 text-sm">
            <p className="font-medium">这个系列还没有大纲</p>
            <p className="text-muted-foreground mt-1 text-xs">
              课程目标与知识体系在这里先定。AI
              起草时只能依据系列名称、说明与方向，不核对落点；建好大纲后回来，这页会检查每条目标与每个知识点是否都有目承接。
            </p>
          </CardContent>
        </Card>
      )}

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
        aiBusy={busy === 'direction-ai'}
        onAi={() => void draftDirectionWithAi()}
        onEdit={() => setDirectionOpen(true)}
      />

      <ObjectivesCard
        snapshot={snapshot}
        busy={busy !== null}
        aiBusy={busy === 'objectives-ai'}
        onAi={() => void draftObjectivesWithAi()}
        onEdit={() => {
          setTextError(null);
          setObjectivesTextOpen(true);
        }}
      />

      <NodesCard
        snapshot={snapshot}
        busy={busy !== null}
        aiBusy={busy === 'knowledge-ai'}
        onAi={() => void draftNodesWithAi()}
        onEdit={() => {
          setTextError(null);
          setNodesTextOpen(true);
        }}
      />

      <LandingCoverageCard
        coverage={snapshot.coverage}
        hasOutline={hasOutline}
        seriesId={seriesId}
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
          description="按「## 标题」分块，每块四到五行：类型（可选，知识 / 技能 / 能力 / 任务）/ 能做什么 / 最低达标 / 怎么证明 / 支撑知识点（用「、」分隔）。"
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

      {directionDraft ? (
        <DirectionAiDialog
          draft={directionDraft}
          current={design.direction}
          busy={busy === 'direction-ai-adopt'}
          onOpenChange={(open) => {
            if (!open) setDirectionDraft(null);
          }}
          onAdopt={(direction) => void adoptDirection(direction)}
        />
      ) : null}

      {objectivesDraft ? (
        <ObjectiveCandidatesDialog
          candidates={objectivesDraft}
          existing={design.objectives}
          busy={busy === 'objectives-ai-adopt'}
          onOpenChange={(open) => {
            if (!open) setObjectivesDraft(null);
          }}
          onAdopt={(selected) => {
            void (async () => {
              // 采用 = 把勾选的追加到现有目标之后。已有目标与目里的承接都不动：
              // 目标是按数组下标发 id 的，重排会让已经承接的目指向别的目标。
              await save(
                { objectives: appendObjectiveCandidates(design.objectives, selected) },
                'objectives-ai-adopt',
              );
              setObjectivesDraft(null);
            })();
          }}
        />
      ) : null}

      {nodesDraft ? (
        <KnowledgeCandidatesDialog
          candidates={nodesDraft}
          existing={design.nodes}
          busy={busy === 'knowledge-ai-adopt'}
          onOpenChange={(open) => {
            if (!open) setNodesDraft(null);
          }}
          onAdopt={(selected) => {
            void (async () => {
              // 采用 = 把勾选的追加到现有节点之后。已有节点与目标里的 nodeIds 都不动：
              // 节点 id 按数组下标发，重排会让已有引用指向别的点。
              await save(
                { nodes: appendNodeCandidates(design.nodes, selected) },
                'knowledge-ai-adopt',
              );
              setNodesDraft(null);
            })();
          }}
        />
      ) : null}

      <AiDraftDialog
        draft={aiDraft}
        hasOutline={hasOutline}
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
  aiBusy,
  onAi,
  onEdit,
}: {
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  aiBusy: boolean;
  onAi: () => void;
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
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onAi}
            disabled={busy}
            data-testid="direction-ai"
          >
            {aiBusy ? <Loader2 className="animate-spin" /> : <Sparkles />} AI 填写
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <PencilLine /> 编辑方向
          </Button>
        </div>
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
  aiBusy,
  onAi,
  onEdit,
}: {
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  aiBusy: boolean;
  onAi: () => void;
  onEdit: () => void;
}) {
  const { objectives } = snapshot.design;
  // 显示按类型分组；存库顺序不动（目标 id 按数组下标发，重排会让目里的承接
  // 指向别的目标）。未分类是分类出现之前写的旧目标，排最后。
  const groups = useMemo(() => groupSeriesObjectives(objectives), [objectives]);
  const summary = groups
    .map((group) => `${seriesObjectiveTypeLabel(group.type)} ${group.items.length}`)
    .join(' · ');
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
          <Button
            variant="outline"
            size="sm"
            onClick={onAi}
            disabled={busy}
            data-testid="objectives-ai"
          >
            {aiBusy ? <Loader2 className="animate-spin" /> : <Sparkles />} AI 生成候选
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <PencilLine /> 编辑文本
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {objectives.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有课程目标。目标回答「学完整个系列能做出什么」，每一条都会被目承接。 「AI
            生成候选」会一次给出一批带类型（知识 / 技能 / 能力 / 任务）的目标，勾选要的即可。
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">分类：{summary}</p>
            <div className="flex max-h-[560px] flex-col gap-3 overflow-y-auto">
              {groups.map((group) => (
                <section key={group.type ?? 'untyped'} className="flex flex-col gap-2">
                  <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                    <span className="bg-muted rounded px-1.5 py-0.5">
                      {seriesObjectiveTypeLabel(group.type)}
                    </span>
                    {group.items.length} 条
                  </h3>
                  {group.items.map((objective) => (
                    <div key={objective.id} className="border-border rounded-lg border p-3">
                      <div className="flex items-start gap-2">
                        <Target className="text-primary mt-0.5 size-4 shrink-0" />
                        <div className="flex flex-col gap-1">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{objective.title}</span>
                            <span className="bg-muted text-muted-foreground rounded px-1.5 py-0 text-[10px]">
                              {seriesObjectiveTypeLabel(objective.type)}
                            </span>
                          </span>
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
                  ))}
                </section>
              ))}
            </div>
          </>
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
  aiBusy,
  onAi,
  onEdit,
}: {
  snapshot: SeriesDesignSnapshot;
  busy: boolean;
  aiBusy: boolean;
  onAi: () => void;
  onEdit: () => void;
}) {
  const { nodes, objectives } = snapshot.design;
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  // 显示按类型分组（知识在前、技能在后，组内由浅入深）；存库顺序不动（节点 id
  // 按数组下标发，目标里的 nodeIds 与目里的承接都按 id 引用）。
  const groups = useMemo(() => groupSeriesNodes(nodes), [nodes]);
  const summary = groups
    .map((group) => `${seriesNodeTypeLabel(group.type)} ${group.items.length}`)
    .join(' · ');
  // 没有课程目标时不让 AI 生成：知识体系是目标的支撑，先有目标才有依据。
  const canAi = objectives.length > 0;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <div className="flex items-center gap-2">
          <StepChip step={3} />
          <CardTitle className="text-base">知识体系（{nodes.length} 个知识 / 技能点）</CardTitle>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onAi}
            disabled={busy || !canAi}
            data-testid="nodes-ai"
            title={canAi ? undefined : '先定课程目标：知识体系要支撑它们'}
          >
            {aiBusy ? <Loader2 className="animate-spin" /> : <Sparkles />} AI 生成候选
          </Button>
          <Button variant="outline" size="sm" onClick={onEdit} disabled={busy}>
            <PencilLine /> 编辑文本
          </Button>
        </div>
      </CardHeader>
      <CardContent className="flex max-h-[420px] flex-col gap-2 overflow-y-auto">
        {nodes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            还没有知识点。知识体系是整门系列的知识地图，每一目只挑其中几个点来讲。 「AI
            生成候选」会依据第 2 步的课程目标给出一批知识 /
            技能点，勾选要的即可；没有课程目标时它不可用。
          </p>
        ) : (
          <>
            <p className="text-muted-foreground text-xs">分类：{summary}</p>
            {groups.map((group) => (
              <section key={group.type} className="flex flex-col gap-1.5">
                <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                  <span className="bg-muted rounded px-1.5 py-0.5">
                    {seriesNodeTypeLabel(group.type)}
                  </span>
                  {group.items.length} 个
                </h3>
                {group.items.map((node) => (
                  <div
                    key={node.id}
                    className="border-border flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-lg border px-3 py-2 text-sm"
                  >
                    <span className="font-medium">{node.name}</span>
                    <span className="bg-muted text-muted-foreground rounded px-1.5 text-xs">
                      {seriesNodeTypeLabel(node.type)}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {seriesNodeDifficultyLabel(node.difficulty)}
                    </span>
                    <span className="text-muted-foreground flex-1 text-xs">{node.summary}</span>
                    {node.prerequisites.length > 0 ? (
                      <span className="text-muted-foreground text-xs">
                        先修：{node.prerequisites.map((id) => byId.get(id)?.name ?? id).join('、')}
                      </span>
                    ) : null}
                  </div>
                ))}
              </section>
            ))}
          </>
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

/**
 * 设计在目里的落点覆盖：每条课程目标 / 知识点，有没有被某个目的第 2 / 3 步承接。
 *
 * 方向和「大纲过期」相反：那是大纲落后于设计，这是设计还没落到目里。没有大纲时
 * 不摆读数——那时候所有点都"未承接"是必然的，摆出来只是噪声。
 */
function LandingCoverageCard({
  coverage,
  hasOutline,
  seriesId,
}: {
  coverage: SeriesDesignCoverage;
  hasOutline: boolean;
  seriesId: string;
}) {
  const { objectives, nodes } = coverage;
  const hasDesign = objectives.total > 0 || nodes.total > 0;
  const allCovered = objectives.unclaimed === 0 && nodes.unclaimed === 0;
  return (
    <Card data-testid="design-coverage" aria-label="设计落到目里了吗">
      <CardHeader className="flex flex-row items-center gap-2 pb-2">
        <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-xs font-medium">
          落点
        </span>
        <CardTitle className="text-base">设计落到目里了吗</CardTitle>
      </CardHeader>
      <CardContent className="text-muted-foreground flex flex-col gap-2 text-sm">
        {!hasOutline ? (
          <p className="text-xs">
            还没有大纲，暂时没有落点可核对。前三步定完后去驾驶舱搭章 → 节 → 目，回过来源目第 2 / 3
            步承接目标与知识点。
          </p>
        ) : !hasDesign ? (
          <p className="text-xs">还没有课程目标与知识点。</p>
        ) : allCovered ? (
          <p className="text-xs">
            全部 {objectives.total} 条课程目标与 {nodes.total} 个知识点都已有目承接。
          </p>
        ) : (
          <>
            <p className="text-amber-700 dark:text-amber-400">
              还有 {objectives.unclaimed} 条课程目标 / {nodes.unclaimed} 个知识点没有目承接：
              设计里写了，但还没有哪一目的第 2 / 3 步把它挑进去。
            </p>
            {objectives.titles.length > 0 || nodes.names.length > 0 ? (
              <ul className="list-disc pl-5 text-xs">
                {objectives.titles.slice(0, 6).map((title, index) => (
                  <li key={`objective-${index}`}>目标：{title}</li>
                ))}
                {objectives.titles.length > 6 ? (
                  <li>… 还有 {objectives.titles.length - 6} 条目标</li>
                ) : null}
                {nodes.names.slice(0, 6).map((name, index) => (
                  <li key={`node-${index}`}>知识点：{name}</li>
                ))}
                {nodes.names.length > 6 ? <li>… 还有 {nodes.names.length - 6} 个知识点</li> : null}
              </ul>
            ) : null}
            <Button asChild size="sm" variant="outline" className="w-fit">
              <Link href={`/curriculum/series/${seriesId}`}>去驾驶舱看大纲</Link>
            </Button>
          </>
        )}
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

/**
 * 方向草稿的预览与采用。
 *
 * 与其他 AI 起草不同，这一份**可以逐格改**：方向只有六个短槽位，让用户为了改
 * 一个词去关掉对话框、点"编辑方向"、再重填六格，比直接在这里改贵得多。所以
 * 采用的是"你眼前这六个输入框里的值"，不是模型原样返回的那一份。
 *
 * 合并语义：模型没给的槽位保留用户当前值（`draft.x ?? current.x`）。AI 的任务是
 * 把空白填上，不是把用户写的抹掉；要抹掉就手动清空输入框。
 */
function DirectionAiDialog({
  draft,
  current,
  busy,
  onOpenChange,
  onAdopt,
}: {
  draft: SeriesDesignDirection;
  current: SeriesDesignDirection;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (direction: SeriesDesignDirection) => void;
}) {
  const [values, setValues] = useState<Record<keyof SeriesDesignDirection, string>>(() => ({
    audience: draft.audience ?? current.audience ?? '',
    learnerLevel: draft.learnerLevel ?? current.learnerLevel ?? '',
    trainingScenario: draft.trainingScenario ?? current.trainingScenario ?? '',
    applicationScene: draft.applicationScene ?? current.applicationScene ?? '',
    problemStatement: draft.problemStatement ?? current.problemStatement ?? '',
    durationHours:
      draft.durationHours !== null
        ? String(draft.durationHours)
        : current.durationHours !== null
          ? String(current.durationHours)
          : '',
  }));
  const [error, setError] = useState<string | null>(null);

  const rows: {
    key: keyof SeriesDesignDirection;
    label: string;
    placeholder: string;
    multiline?: boolean;
  }[] = [
    { key: 'audience', label: '授课对象', placeholder: '例如：零基础高校网络安全专业学生' },
    {
      key: 'learnerLevel',
      label: '学员基础',
      placeholder: '例如：会 Linux 基本命令、懂 HTTP 请求',
    },
    {
      key: 'trainingScenario',
      label: '训练场景',
      placeholder: '例如：线下集中实训 + 线上自学',
    },
    {
      key: 'applicationScene',
      label: '应用场景',
      placeholder: '例如：校内选拔赛 / 校队集训',
    },
    {
      key: 'problemStatement',
      label: '课程范围',
      placeholder: '这门系列要解决什么问题，以及明确不做什么',
      multiline: true,
    },
    { key: 'durationHours', label: '系列总学时', placeholder: '例如：54' },
  ];

  const adopt = () => {
    const hours = values.durationHours.trim();
    const durationHours = hours === '' ? null : Number(hours);
    if (durationHours !== null && (!Number.isFinite(durationHours) || durationHours < 0)) {
      setError('系列总学时只填整数小时');
      return;
    }
    const text = (key: keyof SeriesDesignDirection) => {
      const value = values[key].trim();
      return value === '' ? null : value;
    };
    onAdopt({
      audience: text('audience'),
      learnerLevel: text('learnerLevel'),
      trainingScenario: text('trainingScenario'),
      applicationScene: text('applicationScene'),
      problemStatement: text('problemStatement'),
      durationHours,
    });
  };

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl" data-testid="direction-ai-dialog">
        <DialogHeader>
          <DialogTitle>AI 填写方向</DialogTitle>
          <DialogDescription>
            AI
            依据系列名称与说明填写，并保留了已经写过的槽位。这里可以先改再保存——保存的是你眼前这份，不是模型原样返回的那份。
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
          {rows.map((row) => {
            const wasDifferent =
              current[row.key] !== null &&
              String(current[row.key]) !== String(draft[row.key] ?? '');
            return (
              <Field key={row.key} label={row.label}>
                {row.multiline ? (
                  <Textarea
                    className="min-h-20"
                    value={values[row.key]}
                    placeholder={row.placeholder}
                    data-testid={`direction-ai-${row.key}`}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [row.key]: event.target.value }))
                    }
                  />
                ) : (
                  <Input
                    value={values[row.key]}
                    placeholder={row.placeholder}
                    data-testid={`direction-ai-${row.key}`}
                    onChange={(event) =>
                      setValues((previous) => ({ ...previous, [row.key]: event.target.value }))
                    }
                  />
                )}
                {wasDifferent ? (
                  <span className="text-muted-foreground text-xs">
                    原：{String(current[row.key])}
                  </span>
                ) : null}
              </Field>
            );
          })}
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={adopt} disabled={busy} data-testid="direction-ai-adopt">
            {busy ? <Loader2 className="animate-spin" /> : null}
            采用并保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 候选目标清单：按类型分组，勾选要采用的。
 *
 * 与另外两个 AI 弹窗的差别：采用的不是"模型原样返回的那一份"，而是**用户勾选的
 * 那个子集**。这里没有输入框——单条目标有五行字，改一条不如重新生成或保存后去
 * 文本编辑。已有目标只作为"不会被改动"出现在说明里，不在这张清单里勾选：删它们
 * 属于「编辑文本」，在候选弹窗里顺手删会让已经承接这条目标的目指向别的目标
 * （目标 id 按数组下标发）。
 */
function ObjectiveCandidatesDialog({
  candidates,
  existing,
  busy,
  onOpenChange,
  onAdopt,
}: {
  candidates: readonly SeriesObjectiveCandidate[];
  existing: readonly SeriesCourseObjective[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (selected: SeriesObjectiveCandidate[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  // 服务端已经按已有目标筛过一遍；这里再筛一次，防御"请求返回之后已有目标被别处改过"。
  const indexed = useMemo(
    () =>
      screenObjectiveCandidates(candidates, existing).map((candidate, index) => ({
        ...candidate,
        index,
      })),
    [candidates, existing],
  );
  const groups = useMemo(() => groupSeriesObjectives(indexed), [indexed]);

  const toggle = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleGroup = (indices: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = indices.every((index) => next.has(index));
      for (const index of indices) {
        if (allSelected) next.delete(index);
        else next.add(index);
      }
      return next;
    });
  };

  const selectedCandidates: SeriesObjectiveCandidate[] = indexed
    .filter((entry) => selected.has(entry.index))
    .map((entry) => ({
      title: entry.title,
      type: entry.type,
      expectedBehavior: entry.expectedBehavior,
      minCriteria: entry.minCriteria,
      evidence: entry.evidence,
    }));

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="objective-candidates-dialog">
        <DialogHeader>
          <DialogTitle>AI 生成候选课程目标</DialogTitle>
          <DialogDescription>
            按类型分组列出 {indexed.length} 条候选，勾选要采用的。采用会把选中的追加到现有{' '}
            {existing.length} 条目标之后；已有目标不会被改动，要删它们用「编辑文本」。
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[58vh] flex-col gap-3 overflow-y-auto text-sm">
          {groups.map((group) => {
            const indices = group.items.map((item) => item.index);
            return (
              <section key={group.type ?? 'untyped'} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                    <span className="bg-muted rounded px-1.5 py-0.5">
                      {seriesObjectiveTypeLabel(group.type)}
                    </span>
                    {group.items.length} 条
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => toggleGroup(indices)}
                    disabled={busy}
                  >
                    全选 / 取消
                  </Button>
                </div>
                <ul className="flex flex-col gap-1">
                  {group.items.map((candidate) => (
                    <li key={candidate.index}>
                      <label className="hover:bg-muted/50 flex cursor-pointer items-start gap-2 rounded px-1.5 py-1">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selected.has(candidate.index)}
                          onChange={() => toggle(candidate.index)}
                          disabled={busy}
                          data-testid={`objective-candidate-${candidate.index}`}
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium">{candidate.title}</span>
                          <span className="text-muted-foreground line-clamp-2 text-[11px]">
                            {candidate.expectedBehavior}
                          </span>
                          <span className="text-muted-foreground text-[11px]">
                            达标：{candidate.minCriteria.join('；')} · 证明：{candidate.evidence}
                          </span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            取消
          </Button>
          <Button
            onClick={() => onAdopt(selectedCandidates)}
            disabled={busy || selectedCandidates.length === 0}
            data-testid="objective-candidates-adopt"
          >
            {busy ? <Loader2 className="animate-spin" /> : null}
            采用选中（{selectedCandidates.length} 条）
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * 候选知识 / 技能点清单：按类型（知识 / 技能）分组，组内由浅入深，勾选要采用的。
 *
 * 与第 2 步的候选弹窗同一套语义：采用的是**用户勾选的子集**，追加在已有节点之后，
 * 已有节点不动。差别在先修关系：候选之间的先修用节点名引用，采用时解析成 id；
 * 指向未勾选候选（或排在后面的候选）的引用会被丢弃，所以底部会先把条数亮出来，
 * 而不是让它们悄悄消失。
 */
function KnowledgeCandidatesDialog({
  candidates,
  existing,
  busy,
  onOpenChange,
  onAdopt,
}: {
  candidates: readonly SeriesKnowledgeCandidate[];
  existing: readonly SeriesKnowledgeNode[];
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onAdopt: (selected: SeriesKnowledgeCandidate[]) => void;
}) {
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  // 服务端已经按已有节点筛过一遍；这里再筛一次，防御"请求返回之后已有节点被别处改过"。
  const indexed = useMemo(
    () =>
      screenNodeCandidates(candidates, existing).map((candidate, index) => ({
        ...candidate,
        index,
      })),
    [candidates, existing],
  );
  const groups = useMemo(() => groupSeriesNodes(indexed), [indexed]);

  const toggle = (index: number) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const toggleGroup = (indices: number[]) => {
    setSelected((current) => {
      const next = new Set(current);
      const allSelected = indices.every((index) => next.has(index));
      for (const index of indices) {
        if (allSelected) next.delete(index);
        else next.add(index);
      }
      return next;
    });
  };

  const selectedCandidates: SeriesKnowledgeCandidate[] = indexed
    .filter((entry) => selected.has(entry.index))
    .map((entry) => ({
      name: entry.name,
      type: entry.type,
      summary: entry.summary,
      difficulty: entry.difficulty,
      prerequisites: [...entry.prerequisites],
    }));
  const droppedPrerequisites = countDroppedNodePrerequisites(existing, selectedCandidates);

  return (
    <Dialog open onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl" data-testid="knowledge-candidates-dialog">
        <DialogHeader>
          <DialogTitle>AI 生成候选知识 / 技能点</DialogTitle>
          <DialogDescription>
            依据第 2 步的课程目标，按类型分组列出 {indexed.length}{' '}
            个候选，勾选要采用的。采用会把选中的追加到现有 {existing.length}{' '}
            个节点之后；已有节点不会被改动，要删它们用「编辑文本」。
          </DialogDescription>
        </DialogHeader>
        <div className="flex max-h-[58vh] flex-col gap-3 overflow-y-auto text-sm">
          {groups.map((group) => {
            const indices = group.items.map((item) => item.index);
            return (
              <section key={group.type} className="flex flex-col gap-1.5">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
                    <span className="bg-muted rounded px-1.5 py-0.5">
                      {seriesNodeTypeLabel(group.type)}
                    </span>
                    {group.items.length} 个
                  </h3>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs"
                    onClick={() => toggleGroup(indices)}
                    disabled={busy}
                  >
                    全选 / 取消
                  </Button>
                </div>
                <ul className="flex flex-col gap-1">
                  {group.items.map((candidate) => (
                    <li key={candidate.index}>
                      <label className="hover:bg-muted/50 flex cursor-pointer items-start gap-2 rounded px-1.5 py-1">
                        <input
                          type="checkbox"
                          className="mt-0.5"
                          checked={selected.has(candidate.index)}
                          onChange={() => toggle(candidate.index)}
                          disabled={busy}
                          data-testid={`knowledge-candidate-${candidate.index}`}
                        />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="flex flex-wrap items-center gap-2">
                            <span className="font-medium">{candidate.name}</span>
                            <span className="bg-muted text-muted-foreground rounded px-1.5 text-[10px]">
                              {seriesNodeDifficultyLabel(candidate.difficulty)}
                            </span>
                          </span>
                          {candidate.summary ? (
                            <span className="text-muted-foreground line-clamp-2 text-[11px]">
                              {candidate.summary}
                            </span>
                          ) : null}
                          {candidate.prerequisites.length > 0 ? (
                            <span className="text-muted-foreground text-[11px]">
                              先修：{candidate.prerequisites.join('、')}
                            </span>
                          ) : null}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
        <DialogFooter className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
          {droppedPrerequisites > 0 ? (
            <span className="text-muted-foreground text-left text-[11px]">
              其中 {droppedPrerequisites} 条先修引用指向未勾选（或排在后面）的候选，采用时会被丢弃。
            </span>
          ) : (
            <span />
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
              取消
            </Button>
            <Button
              onClick={() => onAdopt(selectedCandidates)}
              disabled={busy || selectedCandidates.length === 0}
              data-testid="knowledge-candidates-adopt"
            >
              {busy ? <Loader2 className="animate-spin" /> : null}
              采用选中（{selectedCandidates.length} 个）
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AiDraftDialog({
  draft,
  hasOutline,
  onOpenChange,
  busy,
  onAdopt,
}: {
  draft: SeriesDesignDoc | null;
  hasOutline: boolean;
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
        {!hasOutline ? (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-2 text-xs">
            这个系列还没有大纲：草稿只依据名称、说明与方向，没有核对过落点。建好大纲后回来，这页会检查每条目标与每个知识点是否都有目承接。
          </p>
        ) : null}
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
