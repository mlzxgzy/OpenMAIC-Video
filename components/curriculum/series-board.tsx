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
 *
 * 三层都有「编辑 / 删除」菜单：看板是用户核对大纲的地方，改错一个标题不该迫使他
 * 去别处找入口。菜单只负责把"要改哪一行"交给驾驶舱（`series-cockpit.tsx`）——
 * 删除的后果文案、保存时只发改过的字段，都在 `lib/curriculum/outline-actions.ts`
 * 里，由那里钉测试。看板自己不发请求。
 */
'use client';

import Link from 'next/link';
import {
  AlertTriangle,
  CheckCircle2,
  CircleDashed,
  Film,
  MoreHorizontal,
  PencilLine,
  Plus,
  Trash2,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
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

/**
 * 「按旧版系列设计生成」的标记。
 *
 * 设计改过之后，已生成的章 / 节 / 目不会自动跟着变。不标出来，用户改完设计
 * 回到驾驶舱会觉得"怎么什么都没变"。标记只说事实，处理方式（重新生成、手工
 * 改备注把这一层改对）由用户决定，所以放在 title 里说清楚。
 */
function StaleBadge() {
  return (
    <span
      data-testid="board-stale-badge"
      title="按旧版系列设计生成：系列设计后来改过，这一层不会自动跟着变"
      className="inline-flex shrink-0 items-center gap-0.5 rounded bg-amber-500/15 px-1 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300"
    >
      <AlertTriangle className="size-2.5" />
      旧版设计
    </span>
  );
}

function itemStatusText(item: BoardItem): string {
  const tone = toneOf(item);
  if (tone === 'done') return TONE_LABEL.done;
  if (tone === 'blocked') return `${item.blockingCount} 处阻塞`;
  if (tone === 'active') return PHASE_STATE_LABEL[item.phase] ?? TONE_LABEL.active;
  return TONE_LABEL.skeleton;
}

/**
 * 一行右侧的「⋯」菜单。
 *
 * 用下拉菜单而不是把两个按钮平铺出来：看板一屏要装 54 目，每行两个常驻按钮会
 * 把注意力从"现在做哪一目"上拉走；删除是低频且危险的操作，藏一层是好事。
 * `data-testid` 用 id 而不是行号：e2e 播种时手里就有 id，断言不依赖排序。
 */
function RowActions({
  testId,
  ariaLabel,
  editLabel,
  deleteLabel,
  onEdit,
  onDelete,
}: {
  testId: string;
  ariaLabel: string;
  editLabel: string;
  deleteLabel: string;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          data-testid={testId}
          aria-label={ariaLabel}
          className="text-muted-foreground/70 hover:text-foreground shrink-0"
        >
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[9rem]">
        <DropdownMenuItem onSelect={onEdit}>
          <PencilLine />
          {editLabel}
        </DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onSelect={onDelete}>
          <Trash2 />
          {deleteLabel}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Tile({
  item,
  recommended,
  onEdit,
  onDelete,
}: {
  item: BoardItem;
  recommended: boolean;
  onEdit: (item: BoardItem) => void;
  onDelete: (item: BoardItem) => void;
}) {
  const tone = toneOf(item);
  return (
    <div className="relative">
      <Link
        href={`/curriculum/design/${item.taskId}`}
        title={`${item.code ? `${item.code} ` : ''}${item.title} —— ${itemStatusText(item)}`}
        className={`relative flex min-h-[72px] flex-col gap-0.5 rounded-md border p-1.5 pr-7 text-left transition-colors hover:ring-2 hover:ring-primary/40 ${TONE_CLASS[tone]}`}
      >
        {recommended ? (
          // 挂在砖块上边线的正中，而不是某个角："现在做这目"是给整块砖贴的标签，
          // 贴角上会压住编号或类型，而这两样正是用户核对大纲时要看的东西。
          <span className="bg-primary text-primary-foreground absolute -top-2 left-1/2 -translate-x-1/2 rounded-full px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap">
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
        {item.stale ? <StaleBadge /> : null}
      </Link>
      <div className="absolute top-0.5 right-0.5">
        <RowActions
          testId={`item-actions-${item.taskId}`}
          ariaLabel={`目「${item.code ? `${item.code} ` : ''}${item.title}」的操作`}
          editLabel="编辑目"
          deleteLabel="删除目"
          onEdit={() => onEdit(item)}
          onDelete={() => onDelete(item)}
        />
      </div>
    </div>
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

interface EntryHandlers {
  onAddSection: (chapter: BoardChapter) => void;
  onAddItem: (section: BoardSection) => void;
  onEditChapter: (chapter: BoardChapter) => void;
  onDeleteChapter: (chapter: BoardChapter) => void;
  onEditSection: (section: BoardSection) => void;
  onDeleteSection: (section: BoardSection) => void;
  onEditItem: (item: BoardItem) => void;
  onDeleteItem: (item: BoardItem) => void;
}

function SectionBlock({
  section,
  recommendedTaskId,
  onAddItem,
  onEditSection,
  onDeleteSection,
  onEditItem,
  onDeleteItem,
}: {
  section: BoardSection;
  recommendedTaskId: string | null;
} & Pick<
  EntryHandlers,
  'onAddItem' | 'onEditSection' | 'onDeleteSection' | 'onEditItem' | 'onDeleteItem'
>) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 items-baseline gap-2 text-xs">
          <span className="text-muted-foreground tabular-nums">{section.code ?? '—'}</span>
          <span className="truncate font-medium">{section.title}</span>
          <ProgressText produced={section.produced} total={section.total} />
          {section.stale ? <StaleBadge /> : null}
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => onAddItem(section)}
          >
            <Plus className="size-3" />
            新建目
          </Button>
          <RowActions
            testId={`section-actions-${section.id}`}
            ariaLabel={`节「${section.code ? `${section.code} ` : ''}${section.title}」的操作`}
            editLabel="编辑节"
            deleteLabel="删除节"
            onEdit={() => onEditSection(section)}
            onDelete={() => onDeleteSection(section)}
          />
        </span>
      </div>
      <HandoffNote note={section.note} />
      {section.items.length === 0 ? (
        <EmptySection section={section} onAddItem={onAddItem} />
      ) : (
        <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
          {section.items.map((item) => (
            <Tile
              key={item.taskId}
              item={item}
              recommended={item.taskId === recommendedTaskId}
              onEdit={onEditItem}
              onDelete={onDeleteItem}
            />
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
  onEditChapter,
  onDeleteChapter,
  onEditSection,
  onDeleteSection,
  onEditItem,
  onDeleteItem,
}: {
  chapter: BoardChapter;
  recommendedTaskId: string | null;
} & EntryHandlers) {
  return (
    <div className="border-border/70 flex flex-col gap-2 rounded-lg border p-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="flex min-w-0 flex-wrap items-baseline gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {chapter.code ? `第 ${chapter.code} 章` : '章'}
          </span>
          <span className="text-sm font-semibold">{chapter.title}</span>
          <ProgressText produced={chapter.produced} total={chapter.total} />
          {chapter.stale ? <StaleBadge /> : null}
        </span>
        <span className="flex items-center gap-0.5">
          <Button
            size="xs"
            variant="ghost"
            className="h-6 px-1.5 text-xs"
            onClick={() => onAddSection(chapter)}
          >
            <Plus className="size-3" />
            新建节
          </Button>
          <RowActions
            testId={`chapter-actions-${chapter.id}`}
            ariaLabel={`章「${chapter.code ? `第 ${chapter.code} 章 ` : ''}${chapter.title}」的操作`}
            editLabel="编辑章"
            deleteLabel="删除章"
            onEdit={() => onEditChapter(chapter)}
            onDelete={() => onDeleteChapter(chapter)}
          />
        </span>
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
              onEditSection={onEditSection}
              onDeleteSection={onDeleteSection}
              onEditItem={onEditItem}
              onDeleteItem={onDeleteItem}
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
  onEditChapter,
  onDeleteChapter,
  onEditSection,
  onDeleteSection,
  onEditItem,
  onDeleteItem,
}: {
  board: SeriesBoard;
  recommendedTaskId: string | null;
} & EntryHandlers) {
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
              onEditChapter={onEditChapter}
              onDeleteChapter={onDeleteChapter}
              onEditSection={onEditSection}
              onDeleteSection={onDeleteSection}
              onEditItem={onEditItem}
              onDeleteItem={onDeleteItem}
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
                    onEdit={onEditItem}
                    onDelete={onDeleteItem}
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
