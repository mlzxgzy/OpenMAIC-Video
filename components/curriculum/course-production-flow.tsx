'use client';

import type { LucideIcon } from 'lucide-react';
import { Check, ChevronRight, Workflow } from 'lucide-react';
import Link from 'next/link';

import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

export interface CourseProductionStep {
  id: string;
  label: string;
  hint: string;
  done: boolean;
  icon: LucideIcon;
  /** Used when the caller does not provide `onSelect`. */
  href?: string;
}

interface CourseProductionFlowProps {
  steps: readonly CourseProductionStep[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}

/**
 * The four-step user journey for one course product:
 * design it, assemble the outline, generate the classroom, export the video.
 *
 * The component is intentionally presentational: callers own the step data and
 * decide whether selecting a card should switch a tab or navigate.
 */
export function CourseProductionFlow({
  steps,
  activeId,
  onSelect,
  className,
}: CourseProductionFlowProps) {
  const completed = steps.filter((step) => step.done).length;
  const percent = steps.length > 0 ? Math.round((completed / steps.length) * 100) : 0;

  return (
    <section
      className={cn(
        'border-border/70 from-background to-muted/20 rounded-xl border bg-gradient-to-br p-4',
        className,
      )}
      aria-label="课程生产流程"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold">
            <Workflow className="text-primary size-4" />
            课程生产流程
          </div>
          <p className="text-muted-foreground mt-0.5 text-xs">
            设计课程 → 生成大纲 → 生成课堂 → 导出视频，按顺序完成即可。
          </p>
        </div>
        <div className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {completed}/{steps.length} 步完成 · {percent}%
        </div>
      </div>

      <div className="mt-3 grid gap-2 md:grid-cols-2 xl:grid-cols-4">
        {steps.map((step, index) => {
          const Icon = step.icon;
          const active = step.id === activeId;
          const content = (
            <>
              <span
                className={cn(
                  'mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold transition-colors',
                  step.done
                    ? 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300'
                    : active
                      ? 'bg-primary text-primary-foreground'
                      : 'bg-muted text-muted-foreground',
                )}
              >
                {step.done ? <Check className="size-3.5" /> : index + 1}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">{step.label}</span>
                  {onSelect || step.href ? (
                    <ChevronRight
                      className={cn(
                        'ml-auto size-3.5 shrink-0 opacity-30 transition-transform',
                        active ? 'text-primary opacity-80' : 'group-hover:translate-x-0.5',
                      )}
                    />
                  ) : null}
                </span>
                <span className="text-muted-foreground mt-0.5 block text-xs leading-4">
                  {step.hint}
                </span>
              </span>
            </>
          );

          const cardClass = cn(
            'group flex h-full items-start gap-3 rounded-lg border px-3 py-2.5 text-left transition-all',
            step.done
              ? 'border-emerald-500/25 bg-emerald-500/[0.03]'
              : 'border-border/70 bg-background/70',
            active && 'border-primary/50 ring-primary/10 shadow-sm ring-2',
            (onSelect || step.href) && 'hover:border-primary/40 hover:bg-primary/[0.03]',
          );

          if (onSelect) {
            return (
              <button
                key={step.id}
                type="button"
                className={cardClass}
                onClick={() => onSelect(step.id)}
              >
                {content}
              </button>
            );
          }

          if (step.href) {
            return (
              <Link key={step.id} href={step.href} className={cardClass}>
                {content}
              </Link>
            );
          }

          return (
            <div key={step.id} className={cardClass}>
              {content}
            </div>
          );
        })}
      </div>

      <Progress value={percent} className="mt-3 h-1.5" />
    </section>
  );
}
