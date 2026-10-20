/**
 * 改一目的「大纲行」：标题、编号、类型、学时。
 *
 * 目的其它信息（受众、学员基础、训练场景、课程范围）属于第 1 步的判断，不在这里
 * 重复一份——两个入口改同一批字段，总有一个会先漂移。这里只改那些**大纲上看得见**
 * 的东西：驾驶舱看板画的就是这四样。
 *
 * 两个必须说清楚的事实：
 *
 * 1. **改标题 / 学时会让第 1 步的确认重新打开。** 确认属于它当时确认过的内容
 *    （`withdrawCurriculumDesignStep` 在方向字段真的变了时撤回），所以保存后那一目
 *    要再确认一次。编号和类型不在方向字段里，改了不会撤回。这句话写在框里，而不是
 *    让用户保存完回到工作台才发现"怎么又要确认"。
 * 2. **编号可以为空，但不能重复。** 编号是给人对着大纲核数的，留空就是"没编号"，
 *    不替用户编一个；重复由库上的唯一索引拒绝，接口回「该值已被占用」。
 */
'use client';

import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import type { CurriculumTaskKind, CurriculumTaskRecord } from '@/lib/curriculum/design-types';
import {
  parseTaskEditDraft,
  taskEditPatch,
  type TaskEditValues,
} from '@/lib/curriculum/outline-actions';
import { ITEM_KIND_LABEL } from '@/lib/curriculum/ui-labels';

const TASK_KIND_VALUES = Object.keys(ITEM_KIND_LABEL) as CurriculumTaskKind[];

function toValues(task: CurriculumTaskRecord): TaskEditValues {
  return {
    title: task.title,
    code: task.code,
    kind: task.kind,
    durationHours: task.durationHours,
  };
}

export function EditItemDialog({
  open,
  onOpenChange,
  taskId,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 要编辑的目；null 表示还没选中（对话框不应打开）。 */
  taskId: string | null;
  onSaved: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [before, setBefore] = useState<TaskEditValues | null>(null);
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState('');
  const [hours, setHours] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !taskId) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setError(null);
    setBefore(null);
    void (async () => {
      try {
        // 看板只带标题 / 编号 / 类型，学时不在那一行里；一次 GET 换四个字段都
        // 现成，比给看板接口加字段更不容易让两个读口径漂移。
        const response = await fetch(`/api/curriculum/design/tasks/${encodeURIComponent(taskId)}`, {
          credentials: 'same-origin',
          cache: 'no-store',
        });
        const payload = (await response.json().catch(() => null)) as {
          task?: CurriculumTaskRecord;
          error?: { message?: string };
        } | null;
        if (cancelled) return;
        if (!response.ok || !payload?.task) {
          throw new Error(payload?.error?.message ?? `读取失败：HTTP ${response.status}`);
        }
        const values = toValues(payload.task);
        setBefore(values);
        setTitle(values.title);
        setCode(values.code ?? '');
        setKind(values.kind ?? '');
        setHours(values.durationHours === null ? '' : String(values.durationHours));
      } catch (caught) {
        if (!cancelled) {
          setLoadError(caught instanceof Error ? caught.message : '读取失败');
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, taskId]);

  const submit = async () => {
    if (!taskId || !before) return;
    const parsed = parseTaskEditDraft({ title, code, kind, hours });
    if (!parsed.ok) {
      setError(parsed.message);
      return;
    }
    const patch = taskEditPatch(before, parsed.value);
    if (patch === null) {
      onOpenChange(false);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/curriculum/design/tasks/${encodeURIComponent(taskId)}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? `失败：HTTP ${response.status}`);
      onSaved();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '保存失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>编辑目</DialogTitle>
          <DialogDescription>
            改的是大纲上这一行：标题、编号、类型、学时。受众、学员基础、训练场景与课程范围
            在目工作台第 1 步改。
          </DialogDescription>
        </DialogHeader>
        {loading ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="animate-spin" />
            正在读这一目…
          </p>
        ) : loadError ? (
          <p className="text-destructive text-sm">{loadError}</p>
        ) : (
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              data-testid="item-edit-title"
              value={title}
              placeholder="目标题，例如：CTF 概述与竞赛形式"
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="grid gap-3 sm:grid-cols-3">
              <Input
                data-testid="item-edit-code"
                value={code}
                placeholder="编号（可空，如 1-1-1）"
                onChange={(event) => setCode(event.target.value)}
              />
              <Select
                value={kind === '' ? undefined : kind}
                onValueChange={(value) => setKind(value)}
              >
                <SelectTrigger className="w-full" data-testid="item-edit-kind">
                  <SelectValue placeholder="类型（未标注）" />
                </SelectTrigger>
                <SelectContent>
                  {TASK_KIND_VALUES.map((value) => (
                    <SelectItem key={value} value={value}>
                      {ITEM_KIND_LABEL[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                data-testid="item-edit-hours"
                type="number"
                value={hours}
                placeholder="学时"
                onChange={(event) => setHours(event.target.value)}
              />
            </div>
            <p className="text-muted-foreground text-xs">
              改标题或学时会让第 1 步的确认重新打开——确认的是改动之前的内容，保存后需要再确认
              一次。编号与类型不影响已确认的步骤。
            </p>
            {error ? <p className="text-destructive text-xs">{error}</p> : null}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            data-testid="item-edit-save"
            onClick={() => void submit()}
            disabled={busy || loading || loadError !== null || before === null}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
