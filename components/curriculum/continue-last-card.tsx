'use client';

/**
 * 首页的「继续上次」——全部课程里，现在最该动手的那一目。
 *
 * 排序不在这个组件里：`chooseNextItem` 是驾驶舱大卡片用的同一个纯函数，输入是
 * 驾驶舱用的同一个聚合接口。设计稿 §十.4 把这件事定成"由 `pendingItems` 给出，
 * 复用同一排序，首页不另立一套"，理由是**首页和驾驶舱是同一个问题**：我放下的是
 * 哪一目。两处各排一次，就会出现"首页让我做 2-1-2、进去以后驾驶舱推 2-2-1"，
 * 而用户没有任何办法判断哪个才是系统的想法。
 *
 * 三条边界写在这里，因为它们是"首页"这个位置特有的：
 *
 * 1. **没有待做的一目时整块不渲染。** 首页是产品门面，不该出现一块写着"没有
 *    内容"的卡片；没有待办就不占位置。
 * 2. **接口失败静默隐藏。** 首页的一次附带读取没成功，不能变成首页上的红色错误
 *    条——用户来这里是为了生成单课或进课程序列，这两个入口都还在。
 * 3. **读取期间不渲染占位。** 这块在 2×2 入口网格的上方，先渲染骨架再换成卡片
 *    会让下面两块按钮跳一次位置。
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ArrowRight, History } from 'lucide-react';

import { chooseNextItem, type NextItemDecision } from '@/lib/curriculum/next-item';
import { STEP_NAME, STEP_NUMBER } from '@/lib/curriculum/ui-labels';

interface OverviewRow {
  taskId: string;
  code: string;
  title: string;
  phase: NextItemDecision['phase'];
  unitCount: number;
  producedCount: number;
  objectiveCount: number;
  blockingCount: number;
  updatedAt: string;
}

export function ContinueLastCard() {
  const router = useRouter();
  const [decision, setDecision] = useState<NextItemDecision | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/curriculum/design/overview', {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        if (!response.ok) return;
        const payload = (await response.json()) as { rows?: OverviewRow[] };
        const next = chooseNextItem(payload.rows ?? []);
        if (!cancelled) setDecision(next);
      } catch {
        // 见文件头第 2 条：首页不能因为一次附带读取失败而报错。
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!decision) return null;

  return (
    <div className="mt-4 w-full">
      <button
        type="button"
        onClick={() => router.push(`/curriculum/design/${decision.taskId}`)}
        className="group border-primary/30 bg-primary/5 hover:border-primary/60 hover:bg-primary/10 flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors"
        aria-label="继续上次"
        data-testid="continue-last"
      >
        <span className="bg-primary/10 text-primary flex size-8 shrink-0 items-center justify-center rounded-lg">
          <History className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="text-muted-foreground flex items-center gap-1.5 text-xs">
            继续上次
            {/* 序号不再是从 `STEP_LABEL` 里切出来的圈字符（切法一改就空白），直接
                用 `STEP_NUMBER`/`STEP_NAME` 两个字段，并在前台色上放大一点。 */}
            <span className="text-foreground font-medium tabular-nums">
              第 {STEP_NUMBER[decision.phase]} 步
            </span>
            <span className="text-foreground/70">· {STEP_NAME[decision.phase]}</span>
          </span>
          <span className="mt-0.5 flex items-center gap-2 text-sm font-medium">
            {decision.code ? (
              <span className="text-muted-foreground tabular-nums">{decision.code}</span>
            ) : null}
            <span className="truncate">{decision.title}</span>
          </span>
          <span
            className="text-muted-foreground mt-0.5 block truncate text-xs"
            data-testid="continue-last-reason"
          >
            {decision.reason}
          </span>
        </span>
        <span className="text-primary flex shrink-0 items-center gap-1 text-xs font-medium">
          {decision.actionLabel}
          <ArrowRight className="size-3.5 transition-transform group-hover:translate-x-0.5" />
        </span>
      </button>
    </div>
  );
}
