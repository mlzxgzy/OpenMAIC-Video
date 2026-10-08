'use client';

/**
 * The design task list: the way into the heat matrix.
 *
 * Deliberately a list of *designs*, not of courses. A design that has not
 * closed its outcome loop is not a course yet, and showing both in one table
 * is how a half-designed thing starts looking finished. The phase badge is the
 * honest status here, because the phase machine is what decides what may be
 * authored next.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, Plus, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import type { CurriculumDesignPhase, CurriculumTaskRecord } from '@/lib/curriculum/design-types';

const PHASE_LABELS: Record<CurriculumDesignPhase, string> = {
  task: '课程任务',
  outcomes: '学习成果',
  graph: '依赖图',
  outline: '课程大纲',
  teaching: '教学设计',
  assessment: '评价设计',
  review: '课程审核',
};

/** The phases in order, so "how far along" is legible at a glance. */
const PHASE_ORDER: CurriculumDesignPhase[] = [
  'task',
  'outcomes',
  'graph',
  'outline',
  'teaching',
  'assessment',
  'review',
];

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
}

export function DesignTaskList() {
  const [tasks, setTasks] = useState<CurriculumTaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const payload = await requestJson<{ tasks: CurriculumTaskRecord[] }>(
        '/api/curriculum/design/tasks',
      );
      setTasks(payload.tasks);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">课程设计</h1>
          <p className="text-muted-foreground text-xs">
            逆向设计：先确定学习成果与评价证据，再反推知识技能、依赖关系和大纲
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
          <RotateCcw />
          刷新
        </Button>
      </header>

      {error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 rounded-lg border p-3 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          {error}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">设计任务</CardTitle>
          <CardDescription>每个任务是一门课程的设计过程；阶段由系统锁定，不能跳过</CardDescription>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              正在加载…
            </div>
          ) : tasks.length === 0 ? (
            <p className="text-muted-foreground border-border rounded-lg border border-dashed p-6 text-center text-xs">
              还没有课程设计任务。创建一个任务并填写培训对象、要解决的问题和时长，才能进入学习成果阶段。
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {tasks.map((task) => {
                const step = PHASE_ORDER.indexOf(task.designPhase) + 1;
                return (
                  <li key={task.id}>
                    <Link
                      href={`/curriculum/design/${task.id}`}
                      className="border-border hover:bg-muted/40 flex items-center justify-between gap-3 rounded-lg border p-3 transition-colors"
                    >
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="truncate text-sm font-medium">{task.title}</span>
                        <span className="text-muted-foreground text-[11px]">
                          {task.audience ?? '未填写培训对象'} ·{' '}
                          {task.durationHours === null
                            ? '未填写时长'
                            : `${task.durationHours} 学时`}
                        </span>
                      </div>
                      <Badge variant="secondary" className="shrink-0">
                        {step}/{PHASE_ORDER.length} {PHASE_LABELS[task.designPhase]}
                      </Badge>
                    </Link>
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>

      <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
        <Plus className="size-3.5" />
        新建任务走 <code className="font-mono">POST /api/curriculum/design/tasks</code>
      </p>
    </div>
  );
}
