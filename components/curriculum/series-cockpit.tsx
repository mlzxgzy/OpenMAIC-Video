/**
 * 系列驾驶舱 —— 用户进入一个系列后唯一要面对的页面。
 *
 * 上一版（`curriculum-workspace.tsx`）在这里同时摊开了课程台账、知识体系、培养方案、
 * 课程组装、批量生成、视频导出六块平级内容，`activeTab` 只切 `hidden` class，所以
 * 六个 Tab 的 DOM 全部渲染。结果是"铺天盖地"和"不知道下一步干什么"——因为没有
 * 任何一处声明"现在该做这一目"。
 *
 * 这个页面遵守三条硬规则（设计稿 §2）：
 *
 * 1. **一次只有一个主角。** 只有一块"现在做这一目"卡片里有主 CTA，其余是次要信息。
 * 2. **状态必须有名字。** 用 `ui-labels.ts` 的用户语言，不出现 `graph`、`waived`。
 * 3. **禁用必须给理由。** 空状态里每个被禁用的按钮旁都有一句话说明为什么现在不能做。
 *
 * 页面只回答一个问题：**"现在做哪一目，为什么是它，卡在哪一步"。**
 */

'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  ChevronDown,
  Loader2,
  RefreshCw,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  ObjectiveMatrix,
  type MatrixChapter,
  type MatrixUnit,
} from '@/components/curriculum/objective-matrix';
import { chooseNextItem, pendingItems, type NextItemRow } from '@/lib/curriculum/next-item';
import { STEP_LABEL, UNIT_ROLE_LABEL } from '@/lib/curriculum/ui-labels';

interface OverviewRow {
  taskId: string;
  code: string;
  title: string;
  phase: NextItemRow['phase'];
  unitCount: number;
  itemCount: number;
  producedCount: number;
  objectiveCount: number;
  blockingCount: number;
  acceptedCount: number;
  exportable: boolean;
  updatedAt: string;
}

async function requestJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  return payload as T;
}

/**
 * 章分组。
 *
 * 库里没有"目属于哪一章"这一个字段——章是 `curriculum_unit(unitType='chapter')`，
 * 目是同一棵树下的另一类 `unit`，而 task 本身是目之上的东西。所以驾驶舱读的
 * `/overview` 里没有章节信息，只能按目编号的前缀分组（`2-1-2` → 第二章）。
 *
 * 这是一个**明确降级**而非设计：编号本来就是用户对着大纲核数的依据，按前缀分组
 * 与课程大纲一致。若将来目可以不属于任何编号序列（自由创建的目），这里会退化成
 * 一组"未编号"，那时才需要真正的 parentId 关系。
 */
function groupByChapterCode(rows: OverviewRow[]): MatrixChapter[] {
  const groups = new Map<string, MatrixUnit[]>();
  for (const row of rows) {
    const chapter = row.code ? `第 ${row.code[0]} 章` : '未编号';
    const list = groups.get(chapter) ?? [];
    list.push({
      unitId: row.taskId,
      taskId: row.taskId,
      code: row.code || null,
      title: row.title,
      phase: row.phase,
      produced: row.producedCount > 0,
      blockingCount: row.blockingCount,
      started: row.phase !== 'task' || row.objectiveCount > 0 || row.unitCount > 0,
    });
    groups.set(chapter, list);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b, 'zh-CN'))
    .map(([chapter, units]) => ({ chapter, units }));
}

export function SeriesCockpit({ seriesId }: { seriesId: string }) {
  const [rows, setRows] = useState<OverviewRow[]>([]);
  const [seriesName, setSeriesName] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showAllTodos, setShowAllTodos] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await requestJson<{ rows: OverviewRow[] }>(
        `/api/curriculum/design/overview?seriesId=${encodeURIComponent(seriesId)}`,
      );
      setRows(payload.rows ?? []);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, [seriesId]);

  useEffect(() => {
    void load();
  }, [load]);

  // The name is a nicety, not a prerequisite: an owner whose series was deleted
  // still gets a usable cockpit from the overview. A failed name lookup must not
  // blank the page — that would turn a cosmetic problem into a dead end.
  useEffect(() => {
    let cancelled = false;
    void requestJson<{ series: Array<{ id: string; name: string }> }>('/api/curriculum')
      .then((payload) => {
        const found = payload.series?.find((item) => item.id === seriesId);
        if (!cancelled && found) setSeriesName(found.name);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [seriesId]);

  const decision = useMemo(() => chooseNextItem(rows), [rows]);
  const chapters = useMemo(() => groupByChapterCode(rows), [rows]);
  const totalItems = rows.length;

  /**
   * 待办与推荐共用 `pendingItems` 的顺序（同一个比较函数）。
   *
   * 这一步不能各写一套排序：两块内容并排显示，一旦顺序不同，用户看到的就是
   * "大卡片让我做 2-1-2，待办第一条却是 2-2-1"，且无从判断哪个是系统的想法。
   * 共用之后二者第一条在构造上不可能不同——`next-item.test.ts` 有一条测试钉住。
   */
  const todos = useMemo(() => pendingItems(rows), [rows]);

  const visibleTodos = showAllTodos ? todos : todos.slice(0, 5);

  if (!loaded) {
    return (
      <div className="text-muted-foreground flex min-h-[40vh] items-center justify-center gap-2 text-sm">
        <Loader2 className="animate-spin" />
        正在读这个系列的目...
      </div>
    );
  }

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
            <h1 className="truncate text-2xl font-semibold">{seriesName ?? '系列'}</h1>
          </div>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={busy}>
          {busy ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          刷新
        </Button>
      </header>

      {error ? (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-4 py-3 text-sm">
          {error}
        </div>
      ) : null}

      {decision ? (
        // `aria-label` 而不是包一层 heading：`CardTitle` 渲染成 div，而这一块的
        // 身份（"页面上唯一的主角"）是页面结构的事实，不是文案的事实。用文案当
        // locator 就等于把测试焊死在措辞上，改一次"现在做这一目"要连带改测试。
        <Card className="border-primary/30" aria-label="现在做这一目">
          <CardHeader>
            <CardTitle className="text-muted-foreground text-xs font-normal">
              现在做这一目
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <div className="flex flex-wrap items-baseline gap-2">
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
              <span className="text-muted-foreground text-xs">
                这一步是第 {STEP_LABEL[decision.phase].slice(0, 1)} 步 ·{' '}
                {STEP_LABEL[decision.phase].replace(/^[①-⑦]\s*/, '')}
              </span>
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col items-start gap-2 py-6">
            <h2 className="text-base font-semibold">这个系列没有待做的目了</h2>
            <p className="text-muted-foreground text-sm">
              {totalItems > 0
                ? `${totalItems} 目全部出了片。要改哪一目，在下面的看板里点对应的方块。`
                : '这个系列还没有目。新建一个目，就是现在的下一步。'}
            </p>
            <Button asChild>
              {/* The query is the point: without it the design list and the AI
                  dialog create the new task outside this series, and it never
                  shows up in this cockpit's matrix. */}
              <Link href={`/curriculum/design?seriesId=${encodeURIComponent(seriesId)}`}>
                新建目
              </Link>
            </Button>
          </CardContent>
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,320px)_minmax(0,1fr)]">
        <Card className="h-fit" aria-label="待办">
          <CardHeader>
            <CardTitle className="text-sm">待办</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-2">
            {todos.length === 0 ? (
              <p className="text-muted-foreground text-sm">没有待办，所有目都已出片。</p>
            ) : (
              <>
                {visibleTodos.map((row) => (
                  <Link
                    key={row.taskId}
                    href={`/curriculum/design/${row.taskId}`}
                    className="border-border hover:border-primary/40 hover:bg-accent/40 flex items-start gap-2 rounded-md border px-2.5 py-2 text-sm transition-colors"
                  >
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-muted-foreground/60" />
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
                        {row.blockingCount > 0
                          ? `${row.blockingCount} 处审核未处理`
                          : `第 ${STEP_LABEL[row.phase].slice(0, 1)} 步 · ${STEP_LABEL[row.phase].replace(/^[①-⑦]\s*/, '')}`}
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

        <ObjectiveMatrix
          chapters={chapters}
          recommendedTaskId={decision?.taskId ?? null}
          totalItems={totalItems}
        />
      </div>

      <p className="text-muted-foreground text-xs">
        每一目的生成与导出在那一目的工作台里（打开任意一目的「生成与导出」Tab）。跨系列的课程台账、知识体系、培养方案与批量队列在
        <Link href="/curriculum/legacy" className="mx-1 underline">
          课程台账（存档）
        </Link>
        ，不在这个页面的主路径上。条目角色：
        {Object.values(UNIT_ROLE_LABEL).join(' / ')}。
      </p>
    </div>
  );
}
