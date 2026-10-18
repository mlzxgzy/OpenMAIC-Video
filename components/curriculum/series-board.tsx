/**
 * 系列看板：章 → 节 → 目的目录，每一目一块状态砖。
 *
 * 它取代了上一版 `objective-matrix.tsx`。旧版按编号前缀猜章（`2-1-2` → 第二章），
 * 因为库里没有"目属于哪一章"这个字段——那块注释里自己写着这是**明确降级**。
 * 现在章和节是真实的行，看板直接渲染目录树，同时保留矩阵的两件事：
 *
 * 1. **一屏看得完 54 目**：砖块比表格密度低但颜色一眼可扫。
 * 2. **空节也在**：先出章、再出节、最后出目，中间状态必须能看见，所以一节
 *    没有目时显示一块虚线占位「＋ 新建目」，而不是让这一节从看板上消失。
 *
 * 砖块颜色四种（已出片 / 有阻塞 / 进行中 / 没开始），理由见 `toneOf`。
 */
'use client';

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleDashed, Film, PencilLine, Plus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type {
  BoardChapter,
  BoardItem,
  BoardSection,
  SeriesBoard,
} from '@/lib/curriculum/series-board';
import { ITEM_KIND_LABEL, PHASE_STATE_LABEL } from '@/lib/curriculum/ui-labels';

type TileTone = 'done' | 'blocked' | 'active' | 'skeleton';

function toneOf(item: BoardItem): TileTone {
  if (item.produced) return 'done';
  if (item.blockingCount > 0) return 'blocked';
  return item.started ? 'active' : 'skeleton';
}

const TONE_CLASS: Record<TileTone, string> = {
  done: 'bg-emerald-500/15 border-emerald-500/40 text-emerald-700 dark:text-emerald-300',
  blocked: 'bg-destructive/15 border-destructive/50 text-destructive',
  active: 'bg-primary/15 border-primary/40 text-primary',
  skeleton: 'bg-muted/40 border-border text-muted-foreground',
};

const TONE_LABEL: Record<TileTone, string> = {
  done: '已出片',
  blocked: '有阻塞问题',
  active: '进行中',
  skeleton: '没开始',
};

function itemStatusText(item: BoardItem): string {
  const tone = toneOf(item);
  if (tone === 'done') return TONE_LABEL.done;
  if (tone === 'blocked') return `${item.blockingCount} 处阻塞`;
  if (tone === 'active') return PHASE_STATE_LABEL[item.phase] ?? TONE_LABEL.active;
  return TONE_LABEL.skeleton;
}

function Tile({ item, recommended }: { item: BoardItem; recommended: boolean }) {
  const tone = toneOf(item);
  return (
    <Link
      href={`/curriculum/design/${item.taskId}`}
      title={`${item.code ? `${item.code} ` : ''}${item.title} —— ${itemStatusText(item)}`}
      className={`relative flex min-h-[72px] flex-col gap-0.5 rounded-md border p-1.5 text-left transition-colors hover:ring-2 hover:ring-primary/40 ${TONE_CLASS[tone]}`}
    >
      {recommended ? (
        <span className="bg-primary text-primary-foreground absolute -top-1.5 -right-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium">
          现在做这目
        </span>
      ) : null}
      <span className="flex items-baseline justify-between gap-1">
        <span className="truncate text-[10px] opacity-70 tabular-nums">{item.code || '—'}</span>
        {item.kind ? (
          <span className="shrink-0 text-[10px] opacity-70">{ITEM_KIND_LABEL[item.kind]}</span>
        ) : null}
      </span>
      <span className="line-clamp-2 text-[11px] leading-tight font-medium">{item.title}</span>
    </Link>
  );
}

function ProgressText({ produced, total }: { produced: number; total: number }) {
  return (
    <span className="text-muted-foreground text-[11px] tabular-nums">
      {produced}/{total}
    </span>
  );
}

/**
 * 章 / 节的「交底」：生成下一层时原样进入提示词的那段备注。
 *
 * 看板显示它，是因为用户接下来点「AI 生成节 / 目」时，模型看到的就是这句话——
 * 备注写偏了，下一层必然跟着偏。两行 + `title` 全文，既不把看板撑爆，也不逼
 * 用户去对话框里猜。
 */
function HandoffNote({ note }: { note: string | null }) {
  if (!note) return null;
  return (
    <p className="text-muted-foreground line-clamp-2 text-[11px] leading-relaxed" title={note}>
      {note}
    </p>
  );
}

function EmptySection({
  section,
  onAddItem,
}: {
  section: BoardSection;
  onAddItem: (section: BoardSection) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onAddItem(section)}
      className="text-muted-foreground hover:border-primary/40 hover:text-foreground border-border flex min-h-[72px] w-full items-center justify-center gap-1 rounded-md border border-dashed text-xs transition-colors"
    >
      <Plus className="size-3.5" />
      新建这一节的第一目
    </button>
  );
}

function SectionBlock({
  section,
  recommendedTaskId,
  onAddItem,
}: {
  section: BoardSection;
  recommendedTaskId: string | null;
  onAddItem: (section: BoardSection) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className="text-muted-foreground tabular-nums">{section.code ?? '—'}</span>
          <span className="truncate font-medium">{section.title}</span>
          <ProgressText produced={section.produced} total={section.total} />
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
          onClick={() => onAddItem(section)}
        >
          <Plus className="size-3" />
          新建目
        </Button>
      </div>
      <HandoffNote note={section.note} />
      {section.items.length === 0 ? (
        <EmptySection section={section} onAddItem={onAddItem} />
      ) : (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
          {section.items.map((item) => (
            <Tile key={item.taskId} item={item} recommended={item.taskId === recommendedTaskId} />
          ))}
        </div>
      )}
    </div>
  );
}

function ChapterBlock({
  chapter,
  recommendedTaskId,
  onAddSection,
  onAddItem,
}: {
  chapter: BoardChapter;
  recommendedTaskId: string | null;
  onAddSection: (chapter: BoardChapter) => void;
  onAddItem: (section: BoardSection) => void;
}) {
  return (
    <div className="border-border/70 flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {chapter.code ? `第 ${chapter.code} 章` : '章'}
          </span>
          <span className="text-sm font-semibold">{chapter.title}</span>
          <ProgressText produced={chapter.produced} total={chapter.total} />
        </span>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-xs"
          onClick={() => onAddSection(chapter)}
        >
          <Plus className="size-3" />
          新建节
        </Button>
      </div>
      <HandoffNote note={chapter.note} />
      {chapter.sections.length === 0 ? (
        <button
          type="button"
          onClick={() => onAddSection(chapter)}
          className="text-muted-foreground hover:border-primary/40 hover:text-foreground border-border flex items-center justify-center gap-1 rounded-md border border-dashed py-3 text-xs transition-colors"
        >
          <Plus className="size-3.5" />
          这一章还没有节，先建一节
        </button>
      ) : (
        <div className="flex flex-col gap-2.5">
          {chapter.sections.map((section) => (
            <SectionBlock
              key={section.id}
              section={section}
              recommendedTaskId={recommendedTaskId}
              onAddItem={onAddItem}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function SeriesBoardView({
  board,
  recommendedTaskId,
  onAddSection,
  onAddItem,
}: {
  board: SeriesBoard;
  recommendedTaskId: string | null;
  onAddSection: (chapter: BoardChapter) => void;
  onAddItem: (section: BoardSection) => void;
}) {
  return (
    <section aria-label="系列大纲与出片" className="flex flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">系列大纲与出片</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          {board.totals.chapters} 章 · {board.totals.sections} 节 · {board.totals.items} 目 · 已出片{' '}
          {board.totals.produced}
        </span>
      </header>

      <div className="text-muted-foreground flex flex-wrap gap-3 text-[11px]">
        {[
          { tone: 'done' as const, icon: Film, text: '已出片' },
          { tone: 'blocked' as const, icon: AlertTriangle, text: '有阻塞问题' },
          { tone: 'active' as const, icon: PencilLine, text: '进行中' },
          { tone: 'skeleton' as const, icon: CircleDashed, text: '没开始' },
        ].map(({ tone, icon: Icon, text }) => (
          <span key={tone} className="inline-flex items-center gap-1">
            <Icon className="size-3" />
            {text}
          </span>
        ))}
      </div>

      {board.chapters.length === 0 && board.unassigned.items.length === 0 ? (
        <div className="text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
          这个系列还没有章。先建第一章，再从那一章里建节——目挂在节下面。
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {board.chapters.map((chapter) => (
            <ChapterBlock
              key={chapter.id}
              chapter={chapter}
              recommendedTaskId={recommendedTaskId}
              onAddSection={onAddSection}
              onAddItem={onAddItem}
            />
          ))}
          {board.chapters.length === 0 ? (
            // 有目、没有大纲：驾驶舱的主角卡已经让用户先补大纲，这里只把
            // 已有的目原样摆出来，而不是让它们从看板上消失。
            <p className="text-muted-foreground rounded-md border border-dashed px-4 py-3 text-center text-xs">
              这些目还没有挂进任何一章。先建第一章，再从那一章里建节。
            </p>
          ) : null}
          {board.unassigned.items.length > 0 ? (
            <div className="border-border/70 flex flex-col gap-1.5 rounded-lg border p-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">未归类</span>
                  <ProgressText
                    produced={board.unassigned.produced}
                    total={board.unassigned.total}
                  />
                </span>
                <span className="text-muted-foreground text-xs">
                  这些目还没有挂进任何一节（老数据或删节后留下的）。
                </span>
              </div>
              <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
                {board.unassigned.items.map((item) => (
                  <Tile
                    key={item.taskId}
                    item={item}
                    recommended={item.taskId === recommendedTaskId}
                  />
                ))}
              </div>
            </div>
          ) : null}
          {board.totals.items > 0 && board.totals.produced === board.totals.items ? (
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
              <CheckCircle2 className="size-3.5 text-emerald-600" />
              这个系列的目全部出了片。改哪一目，点对应的方块。
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}
