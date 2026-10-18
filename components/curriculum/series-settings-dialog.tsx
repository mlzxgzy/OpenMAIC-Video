/**
 * 系列设置：名称、说明，以及**默认 brief**。
 *
 * 培训对象和默认学时属于整个系列。它们不是每一目的问题——五十四目各填一遍
 * 得到的是四份互相矛盾的答案——所以放在这里，新建目时自动继承、仍可在第 1 步
 * 覆盖。
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
import { Textarea } from '@/components/ui/textarea';
import type { CurriculumSeriesRecord } from '@/lib/curriculum/types';

export function SeriesSettingsDialog({
  open,
  onOpenChange,
  series,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  series: CurriculumSeriesRecord;
  onSaved: () => void;
}) {
  const [name, setName] = useState(series.name);
  const [description, setDescription] = useState(series.description ?? '');
  const [audience, setAudience] = useState(series.audience ?? '');
  const [defaultHours, setDefaultHours] = useState(
    series.defaultHours === null ? '' : String(series.defaultHours),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setName(series.name);
    setDescription(series.description ?? '');
    setAudience(series.audience ?? '');
    setDefaultHours(series.defaultHours === null ? '' : String(series.defaultHours));
    setError(null);
  }, [open, series]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/curriculum/series/${series.id}`, {
        method: 'PATCH',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          description: description.trim() === '' ? null : description.trim(),
          audience: audience.trim() === '' ? null : audience.trim(),
          defaultHours: defaultHours.trim() === '' ? null : Number(defaultHours),
        }),
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
          <DialogTitle>系列设置</DialogTitle>
          <DialogDescription>默认 brief 会被新建的目继承，之后仍可在目里改。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input value={name} onChange={(event) => setName(event.target.value)} />
          <Textarea
            className="min-h-16"
            value={description}
            placeholder="系列说明（可空）"
            onChange={(event) => setDescription(event.target.value)}
          />
          <Input
            value={audience}
            placeholder="默认培训对象，例如：零基础高校网络安全专业学生"
            onChange={(event) => setAudience(event.target.value)}
          />
          <Input
            type="number"
            value={defaultHours}
            placeholder="默认学时，例如：1"
            onChange={(event) => setDefaultHours(event.target.value)}
          />
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || name.trim() === ''}>
            {busy ? <Loader2 className="animate-spin" /> : <Save />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
