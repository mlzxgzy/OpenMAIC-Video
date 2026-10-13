/**
 * 目矩阵 —— 驾驶舱右侧那块 54 目方块。
 *
 * 存在的理由不是"好看"，是**回答"我一共要干多少活、干完了多少"**。这一条信息
 * 现在整个系统里没有任何地方给出：序列页给的是 `completedSteps/4`（四个布尔
 * 拼出来的百分比），而它对"54 目做完了 3 目"这件事完全不敏感。
 *
 * 一目一个小方块而不是一张表，是因为这一屏要同时回答"哪一目"和"到什么程度"，
 * 表格的密度让后者必须滚动才看得见。方块能一眼扫出整片颜色分布。
 *
 * 章是行分组而不是可点开的层级 —— 已确认不做"章→节→目"逐层下钻，章只负责把
 * 同一章的方块聚在一起，便于对照课程大纲核数。
 */

import Link from 'next/link';
import { AlertTriangle, CheckCircle2, CircleDashed, Film, PencilLine } from 'lucide-react';

import { PHASE_STATE_LABEL, STEP_LABEL } from '@/lib/curriculum/ui-labels';

export interface MatrixUnit {
  unitId: string;
  taskId: string;
  code: string | null;
  title: string;
  phase: keyof typeof STEP_LABEL;
  produced: boolean;
  blockingCount: number;
  started: boolean;
}

export interface MatrixChapter {
  chapter: string;
  units: MatrixUnit[];
}

/**
 * 一目的方块有四种状态，颜色即语义，缺一不可。
 *
 * 单独区分"开始过"和"进行中"是有原因的：一个被打开过又改坏了的目（阶段回到了
 * `task`，但下面已经有目标和条目）不是"没开始"。把它和全新的目涂成同一个颜色，
 * 看板就会低报工作量——用户看到的进度比实际乐观。
 */
type TileTone = 'done' | 'blocked' | 'active' | 'skeleton';

function toneOf(unit: MatrixUnit): TileTone {
  if (unit.produced) return 'done';
  if (unit.blockingCount > 0) return 'blocked';
  return unit.started ? 'active' : 'skeleton';
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

function Tile({ unit, recommended }: { unit: MatrixUnit; recommended: boolean }) {
  const tone = toneOf(unit);
  const statusText =
    tone === 'done'
      ? TONE_LABEL.done
      : tone === 'blocked'
        ? `${unit.blockingCount} 处阻塞`
        : tone === 'active'
          ? PHASE_STATE_LABEL[unit.phase]
          : TONE_LABEL.skeleton;
  return (
    <Link
      href={`/curriculum/design/${unit.taskId}`}
      title={`${unit.code ? `${unit.code} ` : ''}${unit.title} —— ${statusText}`}
      className={`relative flex min-h-[68px] flex-col gap-0.5 rounded-md border p-1.5 text-left transition-colors hover:ring-2 hover:ring-primary/40 ${TONE_CLASS[tone]}`}
    >
      {recommended ? (
        <span className="absolute -top-1.5 -right-1.5 rounded-full bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground">
          现在做这目
        </span>
      ) : null}
      <span className="truncate text-[10px] opacity-70 tabular-nums">{unit.code || '—'}</span>
      <span className="line-clamp-2 text-[11px] leading-tight font-medium">{unit.title}</span>
    </Link>
  );
}

export function ObjectiveMatrix({
  chapters,
  recommendedTaskId,
  totalItems,
}: {
  chapters: MatrixChapter[];
  recommendedTaskId: string | null;
  totalItems: number;
}) {
  const produced = chapters
    .flatMap((chapter) => chapter.units)
    .filter((unit) => unit.produced).length;

  if (chapters.length === 0) {
    return (
      <div className="text-muted-foreground rounded-md border border-dashed px-4 py-8 text-center text-sm">
        这个系列还没有目。左侧那条「还没开始设计」就是现在的下一步。
      </div>
    );
  }

  return (
    <section aria-label="目进度矩阵" className="flex flex-col gap-3">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">出片看板</h2>
        <span className="text-muted-foreground text-xs tabular-nums">
          已出片 {produced} / {totalItems} 目
        </span>
      </header>

      <div className="flex flex-wrap gap-3 text-[11px] text-muted-foreground">
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

      <div className="flex flex-col gap-4">
        {chapters.map((group) => (
          <div key={group.chapter} className="flex flex-col gap-1.5">
            <div className="text-muted-foreground flex items-baseline gap-2 text-xs">
              <span className="font-medium">{group.chapter}</span>
              <span className="tabular-nums">
                {group.units.filter((unit) => unit.produced).length}/{group.units.length}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1.5 sm:grid-cols-4 lg:grid-cols-5">
              {group.units.map((unit) => (
                <Tile
                  key={unit.unitId}
                  unit={unit}
                  recommended={unit.taskId === recommendedTaskId}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      {produced === totalItems ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CheckCircle2 className="size-3.5 text-emerald-600" />
          这个系列的目全部出了片。改哪一目，点上面的方块。
        </p>
      ) : null}
    </section>
  );
}
