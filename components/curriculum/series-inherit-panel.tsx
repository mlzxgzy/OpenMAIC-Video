'use client';

/**
 * 「从系列承接」面板：目第 2 / 3 步真正要做的事。
 *
 * 课程目标与知识体系属于整个系列，在系列设计页定一次。目这一级不该从零重写一遍
 * ——那正是用户说的「每个目都有 7 步需要做？？？」。目要做的是**挑**：这一目承担
 * 哪几条课程目标、讲哪几个知识技能点。这个面板就是那个"挑"。
 *
 * 三个决定：
 *
 * 1. **承接是复制，但带来源。** 写进目的是真行（要挂证据、连条目、挂题目），同时
 *    记下 `series_objective_id` / `series_node_id`。于是按钮可以反复按（幂等）、
 *    列表能说清"这条来自系列"，系列改了哪些目还没跟上也有据可查。
 * 2. **已承接的显示出来但不可再选。** 藏起来会让用户以为系列里只有剩下几条；而
 *    允许再选一次只会得到一条 400。显示成"已承接"是这一屏唯一诚实的做法。
 * 3. **门禁理由来自 `authoringAvailability`。** 与卡片上的"新建"按钮同一套判断：
 *    点下去才被拒是最差的告知时机。
 */

import Link from 'next/link';
import { useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { authoringAvailability } from '@/lib/curriculum/design-editing';
import type { CurriculumDesignPhase } from '@/lib/curriculum/design-types';
import { stepRef } from '@/lib/curriculum/ui-labels';

export interface SeriesInheritItem {
  id: string;
  title: string;
  /** 第二行说明：目标写可观察行为，节点写摘要。 */
  detail: string;
}

interface SeriesInheritPanelProps {
  kind: 'objectives' | 'nodes';
  taskId: string;
  seriesId: string;
  items: readonly SeriesInheritItem[];
  /** 这一目已经承接过的系列 id。 */
  inheritedIds: ReadonlySet<string>;
  phase: CurriculumDesignPhase;
  busy: string | null;
  run: (key: string, work: () => Promise<string>) => Promise<void>;
}

interface InheritResponse {
  created?: unknown[];
  skippedSeriesIds?: string[];
  unknownSeriesIds?: string[];
  links?: number;
}

async function postInherit(
  taskId: string,
  kind: 'objectives' | 'nodes',
  ids: string[],
): Promise<InheritResponse> {
  const response = await fetch(`/api/curriculum/design/tasks/${taskId}/inherit`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ kind, ids }),
  });
  const payload = (await response.json().catch(() => null)) as
    | (InheritResponse & { error?: { message?: string } })
    | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `承接失败：HTTP ${response.status}`);
  }
  return payload ?? {};
}

export function SeriesInheritPanel({
  kind,
  taskId,
  seriesId,
  items,
  inheritedIds,
  phase,
  busy,
  run,
}: SeriesInheritPanelProps) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  // `objectives` 不是 authoring 的 kind（那张表叫 outcomes），这里做一次映射；
  // 两层的门禁阶段本来就是同一个（第 2 步 / 第 3 步）。
  const availability = authoringAvailability(phase, kind === 'objectives' ? 'outcomes' : 'nodes');
  const noun = kind === 'objectives' ? '课程目标' : '知识技能点';
  const available = items.filter((item) => !inheritedIds.has(item.id));

  const toggle = (id: string) => {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const busyKey = `inherit:${kind}`;
  const working = busy === busyKey;

  if (items.length === 0) {
    return (
      <div className="border-border rounded-lg border border-dashed p-3 text-xs">
        <p className="text-muted-foreground">
          系列还没有{kind === 'objectives' ? '课程目标' : '知识体系'}。它属于整个系列，
          定一次所有目共用——这一目不用重写。
        </p>
        <Link
          href={`/curriculum/series/${seriesId}/design`}
          className="text-foreground mt-1 inline-block underline underline-offset-2"
        >
          去系列设计页定一次
        </Link>
      </div>
    );
  }

  return (
    <div className="border-border bg-muted/20 flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-xs font-medium">
            从系列承接{noun}
            <Badge variant="outline" className="ml-2 px-1 py-0 text-[10px]">
              系列层
            </Badge>
          </span>
          <span className="text-muted-foreground text-[11px]">
            系列里共 {items.length} 条，这一目已承接 {items.length - available.length} 条。
            {kind === 'objectives'
              ? '承接时会按系列声明的方式给每条配一条本目证据。'
              : '承接时会自动连到这一目承接的对应目标。'}
          </span>
        </div>
        <Link
          href={`/curriculum/series/${seriesId}/design`}
          className="text-muted-foreground text-[11px] underline underline-offset-2"
        >
          改系列设计
        </Link>
      </div>

      {available.length === 0 ? (
        <p className="flex items-center gap-1 text-[11px] text-emerald-700 dark:text-emerald-300">
          <Check className="size-3.5" />
          系列里的{noun}已经全部承接。
        </p>
      ) : (
        <>
          <ul className="flex max-h-56 flex-col gap-1 overflow-y-auto">
            {available.map((item) => (
              <li key={item.id}>
                <label className="hover:bg-background flex cursor-pointer items-start gap-2 rounded px-1.5 py-1 text-xs">
                  <input
                    type="checkbox"
                    className="mt-0.5"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    disabled={working}
                  />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="font-medium">{item.title}</span>
                    {item.detail ? (
                      <span className="text-muted-foreground line-clamp-2 text-[11px]">
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                </label>
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={busy !== null || selected.size === 0 || !availability.allowed}
              title={
                !availability.allowed
                  ? (availability.reason ?? undefined)
                  : selected.size === 0
                    ? `先勾选要承接的${noun}`
                    : `把选中的 ${selected.size} 条承接进这一目`
              }
              onClick={() =>
                void run(busyKey, async () => {
                  const result = await postInherit(taskId, kind, [...selected]);
                  setSelected(new Set());
                  const created = result.created?.length ?? 0;
                  const skipped = result.skippedSeriesIds?.length ?? 0;
                  const unknown = result.unknownSeriesIds?.length ?? 0;
                  const links = result.links ?? 0;
                  const parts = [`已承接 ${created} 条${noun}`];
                  if (links > 0) parts.push(`连上 ${links} 条支撑关系`);
                  if (skipped > 0) parts.push(`${skipped} 条之前已经承接`);
                  if (unknown > 0) parts.push(`${unknown} 条在系列里找不到，已跳过`);
                  return `${parts.join('，')}。`;
                })
              }
            >
              {working ? <Loader2 className="animate-spin" /> : <Download />}
              承接选中的 {selected.size > 0 ? `${selected.size} 条` : ''}
            </Button>
            {!availability.allowed ? (
              <span className="text-muted-foreground text-[11px]">
                需要先推进到{stepRef(availability.requiredPhase)}。
              </span>
            ) : null}
          </div>
        </>
      )}

      {inheritedIds.size > 0 ? (
        <p className="text-muted-foreground text-[11px]">
          已从系列承接 {inheritedIds.size} 条；它们在本目里可以继续改，不会改动系列。
        </p>
      ) : null}
    </div>
  );
}
