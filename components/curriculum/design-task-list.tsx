'use client';

/**
 * The design task list: the way into the heat matrix.
 *
 * Deliberately a list of *designs*, not of courses. A design that has not
 * closed its outcome loop is not a course yet, and showing both in one table
 * is how a half-designed thing starts looking finished. The phase badge is the
 * honest status here, because the phase machine is what decides what may be
 * authored next.
 *
 * The create form is here rather than on a separate route because a task with no
 * brief cannot leave the `task` phase — so "create" and "describe what you are
 * training" are the same action, and splitting them would produce a list of
 * titles that cannot be opened into anything.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { AlertTriangle, Loader2, Plus, RotateCcw } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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

/**
 * The brief fields.
 *
 * Only three of the seven are required to leave the `task` phase — audience,
 * duration and problem statement — and those three are the ones shown here. The
 * remaining four (`learnerLevel`, `trainingScenario`, `applicationScene`) are
 * optional context the audit likes to have but the phase machine does not
 * require, so requiring them on this form would teach people that the gate is
 * arbitrary. They are edited on the task itself after creation.
 */
interface BriefForm {
  title: string;
  audience: string;
  durationHours: string;
  problemStatement: string;
}

const EMPTY_BRIEF: BriefForm = {
  title: '',
  audience: '',
  durationHours: '',
  problemStatement: '',
};

export function DesignTaskList() {
  const [tasks, setTasks] = useState<CurriculumTaskRecord[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [brief, setBrief] = useState<BriefForm>(EMPTY_BRIEF);
  const [creating, setCreating] = useState(false);
  const [showForm, setShowForm] = useState(false);

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

  const briefComplete =
    brief.title.trim() !== '' &&
    brief.audience.trim() !== '' &&
    brief.problemStatement.trim() !== '' &&
    brief.durationHours.trim() !== '' &&
    Number.isFinite(Number(brief.durationHours));

  const createTask = async () => {
    setCreating(true);
    setError(null);
    try {
      const payload = await requestJson<{ task: CurriculumTaskRecord }>(
        '/api/curriculum/design/tasks',
        {
          method: 'POST',
          body: JSON.stringify({
            title: brief.title.trim(),
            audience: brief.audience.trim(),
            problemStatement: brief.problemStatement.trim(),
            durationHours: Number(brief.durationHours),
          }),
        },
      );
      setBrief(EMPTY_BRIEF);
      setShowForm(false);
      setTasks((current) => [payload.task, ...current]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建失败');
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-semibold">课程设计</h1>
          <p className="text-muted-foreground text-xs">
            逆向设计：先确定学习成果与评价证据，再反推知识技能、依赖关系和大纲
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowForm((current) => !current)}>
            <Plus />
            新建课程设计
          </Button>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RotateCcw />
            刷新
          </Button>
        </div>
      </header>

      {showForm ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">新课程设计</CardTitle>
            <CardDescription>
              下面三项是进入学习成果阶段的硬性条件：没有培训对象、要解决的问题和时长，课程就只能停在这里。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <Input
              placeholder="课程标题，例如：CTF Web 入门实战"
              value={brief.title}
              onChange={(event) => setBrief({ ...brief, title: event.target.value })}
            />
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_8rem]">
              <Input
                placeholder="培训对象，例如：零基础高校网络安全专业学生"
                value={brief.audience}
                onChange={(event) => setBrief({ ...brief, audience: event.target.value })}
              />
              <Input
                type="number"
                placeholder="学时"
                value={brief.durationHours}
                onChange={(event) => setBrief({ ...brief, durationHours: event.target.value })}
              />
            </div>
            <Textarea
              placeholder="要解决的问题：这门课要让学员最终能做什么？"
              className="min-h-20"
              value={brief.problemStatement}
              onChange={(event) => setBrief({ ...brief, problemStatement: event.target.value })}
            />
            <div className="flex items-center gap-2">
              <Button onClick={() => void createTask()} disabled={creating || !briefComplete}>
                {creating ? <Loader2 className="animate-spin" /> : <Plus />}
                创建并开始设计
              </Button>
              <Button variant="ghost" onClick={() => setShowForm(false)}>
                取消
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

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
        也可以走 <code className="font-mono">POST /api/curriculum/design/tasks</code>，或用
        <Link href="/api/curriculum/design/tasks" className="underline">
          设计工具
        </Link>
        让模型驱动整个设计过程。
      </p>
    </div>
  );
}
