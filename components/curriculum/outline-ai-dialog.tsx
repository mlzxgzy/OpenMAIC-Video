'use client';

/**
 * AI 生成大纲：一次只生成一层（章 / 节 / 目）。
 *
 * 这个对话框回答的核心问题是**"点了 AI，已有的内容怎么办"**，所以顺序是：
 *
 * 1. 先选处理方式（只补空位 / 覆盖重建），说明里写清代价；
 * 2. 生成**预览**——只调模型、不写库，界面展示"新增什么、删除什么、跳过什么"；
 * 3. 用户确认后才写入；写入用的是预览里那份计划，不会再调一次模型。
 *
 * 覆盖重建的"不能选"由服务端判断（`replaceAllowed`）：系列里已经有目时，
 * 重建章/节会让目失去归属，所以直接禁用而不是让用户点完再报错。目这一层可以
 * 覆盖，但只覆盖还没开始设计的目——已经开始设计的数据不会被 AI 删掉。
 */
import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, CheckCircle2, Loader2, Sparkles, Wand2 } from 'lucide-react';

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
import type { OutlineDesignDrift } from '@/lib/curriculum/series-design';
import {
  SERIES_OUTLINE_AI_LEVEL_NOUN,
  type SeriesOutlineAiDesignSummary,
  type SeriesOutlineAiLevel,
  type SeriesOutlineAiMode,
  type SeriesOutlineAiSummary,
} from '@/lib/curriculum/series-outline-ai';
import {
  commitSeriesOutlineAi,
  previewSeriesOutlineAi,
  saveSeriesDescription,
  type SeriesOutlineAiPreviewResponse,
} from '@/lib/curriculum/series-outline-ai-client';
import type { CurriculumSeriesRecord } from '@/lib/curriculum/types';
import { ITEM_KIND_LABEL } from '@/lib/curriculum/ui-labels';

const MODE_COPY: Record<
  SeriesOutlineAiLevel,
  Record<SeriesOutlineAiMode, { label: string; caption: string }>
> = {
  chapter: {
    fill: { label: '补充新章', caption: '已有的章保持不动，只追加不重名的新章' },
    replace: { label: '覆盖重建章', caption: '先删除现有的章（连同节）；系列里有目时不可用' },
  },
  section: {
    fill: { label: '只补空章', caption: '只给还没有节的章生成；已有节的章保持不动' },
    replace: { label: '覆盖重建节', caption: '先删除现有的节；系列里有目时不可用' },
  },
  item: {
    fill: { label: '只补空节', caption: '只给还没有目的节生成；已有目的节保持不动' },
    replace: { label: '覆盖重建目', caption: '只删除还没开始设计的目；已开始设计的目不会被碰' },
  },
};

const LEVEL_HINT: Record<SeriesOutlineAiLevel, string> = {
  chapter:
    '按系列设计（方向、课程目标、知识体系）与系列说明生成章（方向 / 大模块）。这一步只出章，不写节和目。',
  section: '给还没有节的章生成节（一个案例单元）。这一步只出节，不写章和目。',
  item: '给还没有目的节生成目（一节课：视频 + 题）。这一步只出目，不写章和节。',
};

interface CommittedCounts {
  created: { chapters: number; sections: number; items: number };
  removed: { chapters: number; sections: number; items: number };
}

function changeLine(summary: SeriesOutlineAiSummary): string {
  const parts: string[] = [];
  if (summary.writes.chapters > 0) parts.push(`新增 ${summary.writes.chapters} 章`);
  if (summary.writes.sections > 0) parts.push(`新增 ${summary.writes.sections} 节`);
  if (summary.writes.items > 0) parts.push(`新增 ${summary.writes.items} 目`);
  if (summary.removes.chapters > 0) parts.push(`删除 ${summary.removes.chapters} 章`);
  if (summary.removes.sections > 0) parts.push(`删除 ${summary.removes.sections} 节`);
  if (summary.removes.items > 0) parts.push(`删除 ${summary.removes.items} 目`);
  return parts.length === 0 ? '没有要写入的内容' : parts.join('；');
}

function PlanTree({
  level,
  summary,
}: {
  level: SeriesOutlineAiLevel;
  summary: SeriesOutlineAiSummary;
}) {
  const groups = useMemo(() => {
    if (level === 'chapter') return [];
    if (level === 'section') {
      const map = new Map<string, { title: string; note: string | null }[]>();
      for (const section of summary.sections) {
        const list = map.get(section.chapterCode) ?? [];
        list.push(section);
        map.set(section.chapterCode, list);
      }
      return [...map.entries()];
    }
    const map = new Map<string, typeof summary.items>();
    for (const item of summary.items) {
      const list = map.get(item.sectionCode) ?? [];
      list.push(item);
      map.set(item.sectionCode, list);
    }
    return [...map.entries()];
  }, [level, summary]);

  if (level === 'chapter') {
    return (
      <ul className="flex flex-col gap-1">
        {summary.chapters.map((chapter) => (
          <li key={chapter.title}>
            <span className="font-medium">{chapter.title}</span>
            {chapter.note ? (
              <span className="text-muted-foreground"> —— {chapter.note}</span>
            ) : null}
          </li>
        ))}
      </ul>
    );
  }
  if (level === 'section') {
    return (
      <div className="flex flex-col gap-2">
        {groups.map(([chapterCode, sections]) => (
          <div key={chapterCode}>
            <p className="text-muted-foreground">第 {chapterCode} 章</p>
            <ul className="ml-3 flex flex-col gap-0.5">
              {(sections as { title: string; note: string | null }[]).map((section) => (
                <li key={section.title}>
                  <span className="font-medium">{section.title}</span>
                  {section.note ? (
                    <span className="text-muted-foreground"> —— {section.note}</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      {groups.map(([sectionCode, items]) => (
        <div key={sectionCode}>
          <p className="text-muted-foreground">第 {sectionCode} 节</p>
          <ul className="ml-3 flex flex-col gap-0.5">
            {(items as SeriesOutlineAiSummary['items']).map((item) => (
              <li key={item.title}>
                <span className="font-medium">{item.title}</span>
                <span className="text-muted-foreground">
                  {item.kind ? ` · ${ITEM_KIND_LABEL[item.kind]}` : ''}
                  {item.hours !== null ? ` · ${item.hours} 学时` : ''}
                  {item.note ? ` —— ${item.note}` : ''}
                </span>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

export function OutlineAiDialog({
  open,
  onOpenChange,
  level,
  seriesId,
  series,
  design,
  drift,
  onCommitted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  level: SeriesOutlineAiLevel | null;
  seriesId: string;
  series: CurriculumSeriesRecord | null;
  /** 这次生成依据的系列设计；驾驶舱已经读过，不在这里再发一次请求。 */
  design: SeriesOutlineAiDesignSummary | null;
  /** 已有大纲里有多少是按旧版设计生成的；只补空位时它们不会被更新。 */
  drift: OutlineDesignDrift | null;
  onCommitted: (counts: CommittedCounts) => void;
}) {
  const [mode, setMode] = useState<SeriesOutlineAiMode>('fill');
  const [description, setDescription] = useState('');
  const [savedDescription, setSavedDescription] = useState('');
  const [preview, setPreview] = useState<SeriesOutlineAiPreviewResponse | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setMode('fill');
    setDescription(series?.description ?? '');
    setSavedDescription(series?.description ?? '');
    setPreview(null);
    setBusy(null);
    setError(null);
  }, [open, level, series]);

  if (!level) return null;
  const noun = SERIES_OUTLINE_AI_LEVEL_NOUN[level];
  const modeCopy = MODE_COPY[level];

  const changeMode = (next: SeriesOutlineAiMode) => {
    if (next === mode) return;
    setMode(next);
    // 目标集合随处理方式而变（覆盖时连已有的空位一起重来），旧计划不再成立。
    setPreview(null);
    setError(null);
  };

  const runPreview = async () => {
    setBusy('preview');
    setError(null);
    setPreview(null);
    try {
      const trimmed = description.trim();
      if (trimmed !== savedDescription.trim()) {
        await saveSeriesDescription(seriesId, trimmed === '' ? null : trimmed);
        setSavedDescription(trimmed);
      }
      setPreview(await previewSeriesOutlineAi({ seriesId, level, mode }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '生成失败');
    } finally {
      setBusy(null);
    }
  };

  const runCommit = async () => {
    if (!preview?.plan) return;
    setBusy('commit');
    setError(null);
    try {
      const result = await commitSeriesOutlineAi({ seriesId, level, mode, plan: preview.plan });
      onCommitted(result.committed);
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '写入失败');
    } finally {
      setBusy(null);
    }
  };

  const summary = preview?.preview ?? null;
  // 预览响应里的设计摘要更权威：它来自真正生成那一刻的读库结果，预览之后
  // 系列设计可能被人改过。没有预览时用打开对话框时的快照。
  const basis = preview?.design ?? design;
  const canWrite = Boolean(preview?.plan && summary?.canCommit && busy === null);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>AI 生成{noun}</DialogTitle>
          <DialogDescription>{LEVEL_HINT[level]}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {basis ? (
            basis.complete ? (
              <div
                className="rounded-md border border-emerald-500/30 bg-emerald-500/5 px-3 py-2 text-xs"
                data-testid="outline-ai-basis"
              >
                依据系列设计：课程目标 {basis.objectiveCount} 条 · 知识体系 {basis.nodeCount} 个点 ·
                方向与目标已定。
              </div>
            ) : (
              <div
                className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs"
                data-testid="outline-ai-basis"
              >
                <p className="flex items-center gap-1.5 font-medium">
                  <AlertTriangle className="size-3.5" />
                  系列设计还没定完，这次只能按系列名称和说明猜
                </p>
                <p className="text-muted-foreground mt-1">
                  缺：{basis.gaps.slice(0, 3).join('；')}。建议先补齐再生成——补齐后生成的结果会以
                  课程目标与知识体系为准。
                </p>
                <Link
                  href={`/curriculum/series/${seriesId}/design`}
                  className="mt-1 inline-block underline"
                  onClick={() => onOpenChange(false)}
                >
                  去完成系列设计
                </Link>
              </div>
            )
          ) : null}

          {drift && drift.stale.chapters + drift.stale.sections > 0 ? (
            <div className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-xs">
              <p className="flex items-center gap-1.5 font-medium">
                <AlertTriangle className="size-3.5" />
                已有的章 / 节里有 {drift.stale.chapters} 章 / {drift.stale.sections}{' '}
                节是按旧版设计生成的
              </p>
              <p className="text-muted-foreground mt-1">
                「只补空位」不会更新它们；要让它们跟上当前设计，选「覆盖重建」或在看板上直接改交底。
              </p>
            </div>
          ) : null}

          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium" htmlFor="outline-ai-description">
              系列说明
            </label>
            <Textarea
              id="outline-ai-description"
              className="min-h-20"
              value={description}
              placeholder="例如：面向零基础高校学生，6 个 CTF 方向各 3 个案例，理论用 slide 视频、实操用 Docker 靶场。"
              onChange={(event) => {
                setDescription(event.target.value);
                setPreview(null);
              }}
            />
            <p className="text-muted-foreground text-xs">
              生成依据系列设计、「{series?.name ?? '这个系列'}」和这段说明；改这里会同时保存到
              系列设置。
            </p>
          </div>

          <div className="flex flex-col gap-1.5">
            <span className="text-sm font-medium">已有{noun}怎么处理</span>
            <div className="grid gap-2 sm:grid-cols-2">
              {(['fill', 'replace'] as const).map((option) => {
                const active = mode === option;
                const disabled = option === 'replace' && summary?.replaceAllowed === false;
                return (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={active}
                    disabled={disabled}
                    onClick={() => changeMode(option)}
                    className={`rounded-md border p-2.5 text-left transition-colors ${
                      active
                        ? 'border-primary/60 bg-primary/5'
                        : 'border-border hover:border-primary/40'
                    } ${disabled ? 'cursor-not-allowed opacity-50' : ''}`}
                  >
                    <span className="block text-sm font-medium">{modeCopy[option].label}</span>
                    <span className="text-muted-foreground block text-xs">
                      {modeCopy[option].caption}
                    </span>
                  </button>
                );
              })}
            </div>
            {summary?.replaceAllowed === false && summary.replaceBlockedReason ? (
              <p className="text-muted-foreground flex items-start gap-1.5 text-xs">
                <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                {summary.replaceBlockedReason}
              </p>
            ) : null}
          </div>

          {error ? (
            <p className="text-destructive flex items-start gap-1.5 text-sm">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              {error}
            </p>
          ) : null}

          {summary ? (
            <div
              className="border-border flex max-h-72 flex-col gap-2 overflow-auto rounded-md border p-3 text-xs"
              data-testid="outline-ai-preview"
            >
              {summary.blockedReason ? (
                <p className="text-destructive flex items-start gap-1.5">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  {summary.blockedReason}
                </p>
              ) : (
                <p className="flex items-center gap-1.5 text-sm font-medium">
                  <CheckCircle2 className="size-3.5 text-emerald-600" />
                  {changeLine(summary)}
                </p>
              )}
              {summary.warnings.length > 0 ? (
                <ul className="text-muted-foreground list-disc pl-4">
                  {summary.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}
              {summary.skipped.length > 0 ? (
                <div>
                  <p className="text-muted-foreground">保留不动的已有内容：</p>
                  <ul className="list-disc pl-4">
                    {summary.skipped.slice(0, 8).map((skip) => (
                      <li key={`${skip.title}-${skip.reason}`}>
                        {skip.title} —— {skip.reason}
                      </li>
                    ))}
                    {summary.skipped.length > 8 ? (
                      <li>… 还有 {summary.skipped.length - 8} 项</li>
                    ) : null}
                  </ul>
                </div>
              ) : null}
              {preview?.plan && summary.canCommit ? (
                <div className="border-border/60 border-t pt-2">
                  <PlanTree level={level} summary={summary} />
                </div>
              ) : null}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="outline" onClick={() => void runPreview()} disabled={busy !== null}>
            {busy === 'preview' ? <Loader2 className="animate-spin" /> : <Sparkles />}
            {preview ? '重新生成预览' : '生成预览'}
          </Button>
          <Button onClick={() => void runCommit()} disabled={!canWrite}>
            {busy === 'commit' ? <Loader2 className="animate-spin" /> : <Wand2 />}
            写入
            {summary && summary.canCommit
              ? ` ${summary.writes.chapters + summary.writes.sections + summary.writes.items} 项`
              : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
