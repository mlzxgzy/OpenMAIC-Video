/**
 * 新建一章 / 一节。
 *
 * 章和节只是分类，所以这张表只问两件事：叫什么、说明（可空）。编号留空就自动
 * 生成（章 `7`、节 `2-4`），自动编号删除后不回收——编号是给人核对的，把 `2-4`
 * 叫回 `2-2` 会让作者手里那份大纲一夜之间对不上。
 *
 * 这个对话框存在的意义不在字段少，而在**顺序**：它挂在驾驶舱的大纲树上，所以
 * "先出章、再出节"是一条能走通的路，而不是先被迫写一个目。
 */
'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus } from 'lucide-react';

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

export interface OutlineNodeTarget {
  nodeType: 'chapter' | 'section';
  parentId: string | null;
  parentTitle?: string;
}

export function OutlineNodeDialog({
  open,
  onOpenChange,
  seriesId,
  target,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string;
  target: OutlineNodeTarget | null;
  onCreated: () => void;
}) {
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setCode('');
    setNote('');
    setError(null);
  }, [open, target]);

  const isChapter = target?.nodeType === 'chapter';
  const label = isChapter ? '章' : '节';

  const submit = async () => {
    if (!target || title.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch(`/api/curriculum/series/${seriesId}/outline`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          nodeType: target.nodeType,
          parentId: target.parentId,
          title: title.trim(),
          ...(code.trim() ? { code: code.trim() } : {}),
          ...(note.trim() ? { note: note.trim() } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? `失败：HTTP ${response.status}`);
      onCreated();
      onOpenChange(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '创建失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            新建一{label}
            {target?.parentTitle ? `（挂在「${target.parentTitle}」）` : ''}
          </DialogTitle>
          <DialogDescription>
            {isChapter
              ? '章只做分类，不承载教学。建完章，再在这一章里建节，目挂在节下面。'
              : '节只做分类。这一节里的目才是真正要设计、要出片的内容。'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={title}
            placeholder={
              isChapter ? '章名，例如：CTF 基础与工具环境' : '节名，例如：CTF 入门与赛制'
            }
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_2fr]">
            <Input
              value={code}
              placeholder={isChapter ? '编号（留空自动，如 1）' : '编号（留空自动，如 1-2）'}
              onChange={(event) => setCode(event.target.value)}
            />
            <Input
              value={note}
              placeholder="说明（可空）：这一章/节大概讲什么"
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || title.trim() === ''}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
