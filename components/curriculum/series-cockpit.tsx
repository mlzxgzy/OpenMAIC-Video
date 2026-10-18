/**
 * 系列驾驶舱 —— 用户进入一个系列后唯一要面对的页面。
 *
 * 这一版回答的问题比上一版多一个：**大纲怎么先搭出来**。上一版的创建入口
 * 只有一个「新建目」，它要求用户凭空写出一节课的标题、对象、时长和要解决的
 * 问题——而这一目在系列里还没有位置、没有编号、没有大纲。用户的反馈是
 * "我怎么写啊"，那不是一个文案问题，是**操作顺序被系统跳过了**。
 *
 * 现在页面的顺序就是工作的顺序：
 *
 * 1. 没有章 → 主角卡是"先把大纲搭出来"（建第一章 / 从大纲导入）。
 * 2. 有章没有目 → 建成第一目；目挂在节下面，编号由节决定。
 * 3. 有目 → "现在做这一目"（推荐规则见 `next-item.ts`，按大纲顺序）。
 *
 * 三条硬规则沿用上一版（设计稿 §2）：一次只有一个主角；状态必须有名字；
 * 禁用必须给理由。看板本身在 `series-board.tsx`，那里章、节、目是真实层级，
 * 不再靠编号前缀猜。
 */
'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Compass,
  FileUp,
  Loader2,
  Plus,
  RefreshCw,
  Settings,
  Sparkles,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { CreateItemDialog } from '@/components/curriculum/create-item-dialog';
import { OutlineAiDialog } from '@/components/curriculum/outline-ai-dialog';
import { OutlineImportDialog } from '@/components/curriculum/outline-import-dialog';
import {
  OutlineNodeDialog,
  type OutlineNodeTarget,
} from '@/components/curriculum/outline-node-dialog';
import { SeriesBoardView } from '@/components/curriculum/series-board';
import { SeriesSettingsDialog } from '@/components/curriculum/series-settings-dialog';
import { StepBadge, StepRail } from '@/components/curriculum/step-rail';
import { chooseNextItem, pendingItems, type NextItemRow } from '@/lib/curriculum/next-item';
import { seriesDesignComplete, type SeriesDesignSnapshot } from '@/lib/curriculum/series-design';
import type {
  SeriesOutlineAiDesignSummary,
  SeriesOutlineAiLevel,
} from '@/lib/curriculum/series-outline-ai';
import { buildSeriesBoard, type BoardRow } from '@/lib/curriculum/series-board';
import type {
  CurriculumSeriesOutlineNodeRecord,
  CurriculumSeriesRecord,
} from '@/lib/curriculum/types';
import { STEP_NAME, STEP_NUMBER } from '@/lib/curriculum/ui-labels';

interface OverviewRow {
  taskId: string;
  code: string;
  title: string;
  phase: NextItemRow['phase'];
  sectionId: string | null;
  kind: NextItemRow['kind'];
  orderIndex: number;
  unitCount: number;
  itemCount: number;
  producedCount: number;
  objectiveCount: number;
  blockingCount: number;
  acceptedCount: number;
  exportable: boolean;
  updatedAt: string;
}

interface OutlinePayload {
  series: CurriculumSeriesRecord;
  nodes: CurriculumSeriesOutlineNodeRecord[];
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  return payload as T;
}

function boardRowOf(row: OverviewRow): BoardRow {
  return {
    taskId: row.taskId,
    code: row.code || null,
    title: row.title,
    phase: row.phase,
    kind: row.kind ?? null,
    produced: row.producedCount > 0,
    blockingCount: row.blockingCount,
    started: row.phase !== 'task' || row.objectiveCount > 0 || row.unitCount > 0,
    sectionId: row.sectionId,
    orderIndex: row.orderIndex,
  };
}

export function SeriesCockpit({ seriesId }: { seriesId: string }) {
  const router = useRouter();
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [outline, setOutline] = useState<OutlinePayload | null>(null);
  const [design, setDesign] = useState<SeriesDesignSnapshot | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllTodos, setShowAllTodos] = useState(false);

  const [nodeTarget, setNodeTarget] = useState<OutlineNodeTarget | null>(null);
  const [nodeOpen, setNodeOpen] = useState(false);
  const [itemSection, setItemSection] = useState<{
    id: string;
    code: string | null;
    title: string;
  } | null>(null);
  const [itemOpen, setItemOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [aiLevel, setAiLevel] = useState<SeriesOutlineAiLevel | null>(null);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    // 跳转时不能把 loaded 置真：那会在 router.replace 生效前先渲染一次
    // "空大纲"的驾驶舱，用户看到的是闪一下的错页面。
    let redirecting = false;
    try {
      const [overview, outlinePayload, designPayload] = await Promise.all([
        requestJson<{ rows: OverviewRow[] }>(
          `/api/curriculum/design/overview?seriesId=${encodeURIComponent(seriesId)}`,
        ),
        requestJson<OutlinePayload>(`/api/curriculum/series/${seriesId}/outline`),
        requestJson<SeriesDesignSnapshot>(`/api/curriculum/series/${seriesId}/design`),
      ]);
      // 系列设计是前三步，大纲是它的推导结果：没有设计、也还没有大纲的系列，
      // 先落到系列设计页，而不是让用户对着一个只能靠名称猜的 AI 按钮。
      // 已经有大纲的系列不跳转（那是历史数据），只在上方给横幅说明缺依据。
      const chapterCount = (outlinePayload.nodes ?? []).filter(
        (node) => node.nodeType === 'chapter',
      ).length;
      if (chapterCount === 0 && !seriesDesignComplete(designPayload.design)) {
        redirecting = true;
        router.replace(`/curriculum/series/${seriesId}/design`);
        return;
      }
      setDesign(designPayload);
      setRows(overview.rows ?? []);
      setOutline(outlinePayload);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (!redirecting) setLoaded(true);
      setBusy(false);
    }
  }, [router, seriesId]);

  useEffect(() => {
    void load();
  }, [load]);

  const nodes = useMemo(() => outline?.nodes ?? [], [outline]);
  const board = useMemo(() => buildSeriesBoard(nodes, rows.map(boardRowOf)), [nodes, rows]);
  const designGaps = useMemo(
    () => (design ? [...design.gaps.direction, ...design.gaps.objectives] : []),
    [design],
  );
  const designSummary: SeriesOutlineAiDesignSummary | null = useMemo(
    () =>
      design
        ? {
            complete: seriesDesignComplete(design.design),
            gaps: designGaps,
            objectiveCount: design.design.objectives.length,
            nodeCount: design.design.nodes.length,
          }
        : null,
    [design, designGaps],
  );

  /**
   * 每一目在大纲里的位置。推荐与看板共用同一个数：`chooseNextItem` 在"还没
   * 开始"的那一档按它升序，所以"现在做这一目"与看板第一块未做的砖不会打架。
   */
  const rankByTask = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const chapter of board.chapters) {
      for (const section of chapter.sections) {
        for (const item of section.items) map.set(item.taskId, item.outlineRank);
      }
    }
    for (const item of board.unassigned.items) map.set(item.taskId, null);
    return map;
  }, [board]);

  const nextRows = useMemo<NextItemRow[]>(
    () =>
      rows.map((row) => ({
        taskId: row.taskId,
        code: row.code || null,
        title: row.title,
        phase: row.phase,
        unitCount: row.unitCount,
        producedCount: row.producedCount,
        objectiveCount: row.objectiveCount,
        blockingCount: row.blockingCount,
        updatedAt: row.updatedAt,
        outlineRank: rankByTask.get(row.taskId) ?? null,
        sectionId: row.sectionId,
        kind: row.kind ?? null,
      })),
    [rows, rankByTask],
  );

  const decision = useMemo(() => chooseNextItem(nextRows), [nextRows]);
  const todos = useMemo(() => pendingItems(nextRows), [nextRows]);
  const visibleTodos = showAllTodos ? todos : todos.slice(0, 5);

  const firstSection = useMemo(() => {
    for (const chapter of board.chapters) {
      if (chapter.sections.length > 0) return chapter.sections[0];
    }
    return null;
  }, [board]);

  const openAddChapter = () => {
    setNodeTarget({ nodeType: 'chapter', parentId: null });
    setNodeOpen(true);
  };
  const openAddSection = (chapter: { id: string; title: string }) => {
    setNodeTarget({ nodeType: 'section', parentId: chapter.id, parentTitle: chapter.title });
    setNodeOpen(true);
  };
  const openAddItem = (section: { id: string; code: string | null; title: string }) => {
    setItemSection(section);
    setItemOpen(true);
  };

  if (!loaded) {
    return (
      <div className="text-muted-foreground flex min-h-[40vh] items-center justify-center gap-2 text-sm">
        <Loader2 className="animate-spin" />
        正在读这个系列的章、节、目...
      </div>
    );
  }

  const hasOutline = board.totals.chapters > 0;

  return (
    <div className="mx-auto flex w-full max-w-[1500px] flex-col gap-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <Button variant="ghost" size="icon" asChild className="mt-0.5 shrink-0">
            <Link href="/curriculum/series" title="返回课程序列" aria-label="返回课程序列">
              <ArrowLeft />
            </Link>
          </Button>
          <div className="min-w-0">
            <p className="text-muted-foreground text-sm">课程序列 / 系列</p>
            <h1 className="truncate text-2xl font-semibold">{outline?.series.name ?? '系列'}</h1>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <Link
              href={`/curriculum/series/${seriesId}/design`}
              title="方向、课程目标、知识体系一次定完"
            >
              <Compass />
              系列设计
            </Link>
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={busy}>
            {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setSettingsOpen(true)}
            disabled={!outline}
          >
            <Settings />
            系列设置
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
            disabled={hasOutline}
            title={hasOutline ? '导入只用于从零建骨架；这个系列已经有大纲了。' : undefined}
          >
            <FileUp />
            从大纲导入
          </Button>
        </div>
      </header>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      {design && designSummary && !designSummary.complete && hasOutline ? (
        <Card className="border-amber-500/40 bg-amber-500/5" aria-label="系列设计未完成">
          <CardContent className="flex flex-wrap items-start justify-between gap-3 py-4">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-sm font-medium">
                <AlertTriangle className="size-4 text-amber-600" />
                系列设计还没定完，这份大纲缺少课程级依据
              </p>
              <p className="text-muted-foreground mt-1 text-xs">
                缺：{designGaps.slice(0, 3).join('；')}。AI 生成现在只能按系列名称和系列说明
                猜；补齐后重新生成会以方向、课程目标与知识体系为准（已有目不会被删）。
              </p>
            </div>
            <Button asChild size="sm" variant="outline">
              <Link href={`/curriculum/series/${seriesId}/design`}>去完成系列设计</Link>
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {!hasOutline ? (
        <Card className="border-primary/30" aria-label="先把大纲搭出来">
          <CardHeader>
            <CardTitle className="text-muted-foreground text-xs font-normal">
              先把大纲搭出来
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">
              这个系列还没有章。先出章，再出节，最后才是目。
            </h2>
            <p className="text-muted-foreground text-sm">
              目是一节课，它必须挂在某一节下面——所以系统现在不会让你直接写目。你可以手建第一章，
              也可以把已经写好的大纲整份贴进来，一次建出全部章、节、目。
            </p>
            <div className="flex flex-wrap gap-2">
              <Button onClick={openAddChapter}>
                <Plus />
                建第一章
              </Button>
              <Button variant="outline" onClick={() => setImportOpen(true)}>
                <FileUp />
                从大纲导入
              </Button>
              <Button variant="outline" onClick={() => setAiLevel('chapter')}>
                <Sparkles />让 AI 生成章
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : decision ? (
        <Card className="border-primary/30" aria-label="现在做这一目">
          <CardHeader>
            <CardTitle className="text-muted-foreground text-xs font-normal">
              现在做这一目
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
              <StepBadge phase={decision.phase} className="self-center" />
              <h2 className="text-xl font-semibold" data-testid="decision-title">
                {decision.code ? (
                  <span className="text-muted-foreground mr-2 tabular-nums">{decision.code}</span>
                ) : null}
                {decision.title}
              </h2>
            </div>
            <p className="text-sm" data-testid="decision-reason">
              {decision.reason}
            </p>
            {decision.blockers.length > 0 ? (
              <ul className="text-destructive flex flex-col gap-1 text-sm">
                {decision.blockers.map((blocker) => (
                  <li key={blocker} className="flex items-center gap-1.5">
                    <AlertTriangle className="size-3.5 shrink-0" />
                    {blocker}
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="mt-1 flex flex-wrap items-center gap-2">
              <Button asChild>
                <Link href={`/curriculum/design/${decision.taskId}`}>
                  {decision.actionLabel}
                  <ArrowRight />
                </Link>
              </Button>
            </div>
            <StepRail phase={decision.phase} className="bg-background" />
          </CardContent>
        </Card>
      ) : board.totals.items === 0 ? (
        <Card className="border-primary/30" aria-label="大纲搭好了">
          <CardHeader>
            <CardTitle className="text-muted-foreground text-xs font-normal">
              大纲搭好了，接下来建第一目
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <h2 className="text-xl font-semibold">章和节已经有了，但它们下面还没有目</h2>
            <p className="text-muted-foreground text-sm">
              目才是真正要设计、要出片的内容。每一目的标题、编号、学时都在大纲里定好了，
              建的时候只需要点一下。
            </p>
            <div className="flex flex-wrap gap-2">
              {firstSection ? (
                <Button onClick={() => openAddItem(firstSection)}>
                  <Plus />
                  在「{firstSection.title}」里建第一目
                </Button>
              ) : (
                <Button onClick={() => openAddSection(board.chapters[0])}>
                  <Plus />
                  先给「{board.chapters[0].title}」建一节
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 py-6">
            <h2 className="text-base font-semibold">这个系列没有待做的目了</h2>
            <p className="text-muted-foreground text-sm">
              {board.totals.items} 目全部出了片。要改哪一目，在下面的看板里点对应的方块。
            </p>
          </CardContent>
        </Card>
      )}

      <Card aria-label="用 AI 生成大纲">
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-sm font-medium">
              <Sparkles className="size-4" />用 AI 生成大纲
            </p>
            <p className="text-muted-foreground mt-0.5 text-xs">
              按系列设计（方向、课程目标、知识体系）和系列说明生成，章 → 节 → 目 分三次出。
              每一步先预览「新增 / 删除 / 跳过」什么，确认后才写库；默认只补空位，不会悄悄改掉
              已有内容。
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAiLevel('chapter')}
              disabled={!outline}
            >
              <Sparkles />
              AI 生成章
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAiLevel('section')}
              disabled={!hasOutline}
              title={hasOutline ? undefined : '先有章才能生成节'}
            >
              <Sparkles />
              AI 生成节
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setAiLevel('item')}
              disabled={board.totals.sections === 0}
              title={board.totals.sections === 0 ? '先有节才能生成目' : undefined}
            >
              <Sparkles />
              AI 生成目
            </Button>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card className="h-fit" aria-label="待办">
          <CardHeader>
            <CardTitle className="text-sm">待办</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {todos.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {board.totals.items === 0
                  ? '还没有目。先把大纲搭出来，再从节里建目。'
                  : '没有待办，所有目都已出片。'}
              </p>
            ) : (
              <>
                {visibleTodos.map((row) => (
                  <Link
                    key={row.taskId}
                    href={`/curriculum/design/${row.taskId}`}
                    className="border-border hover:border-primary/40 hover:bg-accent/40 flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors"
                  >
                    <span className="bg-muted-foreground/60 mt-1.5 size-1.5 shrink-0 rounded-full" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate">
                        {row.code ? (
                          <span className="text-muted-foreground mr-1.5 tabular-nums">
                            {row.code}
                          </span>
                        ) : null}
                        {row.title}
                      </span>
                      <span className="text-muted-foreground block text-xs">
                        <span className="text-foreground/70 tabular-nums">
                          第 {STEP_NUMBER[row.phase]} 步
                        </span>
                        {' · '}
                        {STEP_NAME[row.phase]}
                        {row.blockingCount > 0 ? ` · ${row.blockingCount} 处审核未处理` : ''}
                      </span>
                    </span>
                  </Link>
                ))}
                {todos.length > 5 ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowAllTodos((current) => !current)}
                  >
                    {showAllTodos ? '只看前 5 条' : `全部待办（${todos.length}）`}
                    <ChevronDown
                      className={
                        showAllTodos ? 'rotate-180 transition-transform' : 'transition-transform'
                      }
                    />
                  </Button>
                ) : null}
              </>
            )}
          </CardContent>
        </Card>

        <SeriesBoardView
          board={board}
          recommendedTaskId={decision?.taskId ?? null}
          onAddSection={(chapter) => openAddSection(chapter)}
          onAddItem={(section) => openAddItem(section)}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        每一目的生成与导出在那一目的工作台里（打开任意一目的「生成与导出」Tab）。节的每个目
        没有建时，看板上会留一块「新建目」的空位；删掉一节不会删目，那些目会回到「未归类」。
        跨系列的课程台账、知识体系、培养方案与批量队列在
        <Link href="/curriculum/legacy" className="mx-1 underline">
          课程台账（存档）
        </Link>
        ，不在这个页面的主路径上。
      </p>

      {outline ? (
        <>
          <SeriesSettingsDialog
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
            series={outline.series}
            onSaved={() => void load()}
          />
          <OutlineNodeDialog
            open={nodeOpen}
            onOpenChange={setNodeOpen}
            seriesId={seriesId}
            target={nodeTarget}
            onCreated={() => void load()}
          />
          <CreateItemDialog
            open={itemOpen}
            onOpenChange={setItemOpen}
            seriesId={seriesId}
            section={itemSection}
            defaults={{
              audience: outline.series.audience,
              defaultHours: outline.series.defaultHours,
            }}
            onCreated={() => void load()}
          />
          <OutlineImportDialog
            open={importOpen}
            onOpenChange={setImportOpen}
            seriesId={seriesId}
            onImported={() => void load()}
          />
          <OutlineAiDialog
            open={aiLevel !== null}
            onOpenChange={(open) => {
              if (!open) setAiLevel(null);
            }}
            level={aiLevel}
            seriesId={seriesId}
            series={outline.series}
            design={designSummary}
            onCommitted={() => void load()}
          />
        </>
      ) : null}
    </div>
  );
}
