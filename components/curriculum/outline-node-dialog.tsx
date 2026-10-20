/**
 * 新建 / 编辑一章或一节。
 *
 * 章和节只是分类，所以这张表只问两件事：叫什么、说明（可空）。编号留空就自动
 * 生成（章 `7`、节 `2-4`），自动编号删除后不回收——编号是给人核对的，把 `2-4`
 * 叫回 `2-2` 会让作者手里那份大纲一夜之间对不上。
 *
 * 这个对话框存在的意义不在字段少，而在**顺序**：它挂在驾驶舱的大纲树上，所以
 * "先出章、再出节"是一条能走通的路，而不是先被迫写一个目。
 *
 * 同一个组件也负责**改名**：看板的每一章 / 每一节都有「编辑」入口，打开的就是
 * 这张表。编辑态多一条限制——**编号不在这里改**。接口的 PATCH 根本不接受 `code`：
 * 它是目编号（`1-1-1`）的前缀，改了会让已经建好的目编号说谎。所以这里把它画成
 * 一行只读文本并说清理由，而不是给一个能填、保存后什么也不发生的输入框。
 */
'use client';

import { useEffect, useState } from 'react';
import { Loader2, Plus, Save } from 'lucide-react';

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
import { nodeEditPatch, type OutlineNodeEditValues } from '@/lib/curriculum/outline-actions';

export interface OutlineNodeTarget {
  nodeType: 'chapter' | 'section';
  parentId: string | null;
  parentTitle?: string;
}

/** 编辑态的现状。`code` 只读，标题与说明可改。 */
export interface OutlineNodeEditing extends OutlineNodeEditValues {
  id: string;
  nodeType: 'chapter' | 'section';
  code: string | null;
}

function levelLabel(nodeType: 'chapter' | 'section'): string {
  return nodeType === 'chapter' ? '章' : '节';
}

export function OutlineNodeDialog({
  open,
  onOpenChange,
  seriesId,
  target,
  editing,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string;
  /** 新建时用：挂在哪、是章还是节。编辑态传 null。 */
  target: OutlineNodeTarget | null;
  /** 编辑时用：现有的章 / 节。新建态传 null。 */
  editing?: OutlineNodeEditing | null;
  onSaved: () => void;
}) {
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(editing?.title ?? '');
    setCode('');
    setNote(editing?.note ?? '');
    setError(null);
  }, [open, target, editing]);

  const nodeType = editing?.nodeType ?? target?.nodeType ?? 'chapter';
  const isChapter = nodeType === 'chapter';
  const label = levelLabel(nodeType);

  const submit = async () => {
    if (title.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      if (editing) {
        // 没改就不发请求：接口把"标题 / 说明被写过"当成一次人改过的表态（清掉
        // 「旧版设计」指纹），原样保存一遍会替用户宣布"这一行我核过了"。
        const patch = nodeEditPatch({ title: editing.title, note: editing.note }, { title, note });
        if (patch === null) {
          onOpenChange(false);
          return;
        }
        const response = await fetch(
          `/api/curriculum/series/${seriesId}/outline/${encodeURIComponent(editing.id)}`,
          {
            method: 'PATCH',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(patch),
          },
        );
        const payload = (await response.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        if (!response.ok)
          throw new Error(payload?.error?.message ?? `失败：HTTP ${response.status}`);
      } else {
        if (!target) return;
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
        if (!response.ok)
          throw new Error(payload?.error?.message ?? `失败：HTTP ${response.status}`);
      }
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
          <DialogTitle>
            {editing
              ? `编辑${label}`
              : `新建一${label}${target?.parentTitle ? `（挂在「${target.parentTitle}」）` : ''}`}
          </DialogTitle>
          <DialogDescription>
            {editing
              ? `改这一${label}的名字与说明。编号不在编辑范围内——它是目编号（如 1-1-1）的前缀，改了会让已经建好的目编号对不上。`
              : isChapter
                ? '章只做分类，不承载教学。建完章，再在这一章里建节，目挂在节下面。'
                : '节只做分类。这一节里的目才是真正要设计、要出片的内容。'}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            data-testid="outline-node-title"
            value={title}
            placeholder={
              isChapter ? '章名，例如：CTF 基础与工具环境' : '节名，例如：CTF 入门与赛制'
            }
            onChange={(event) => setTitle(event.target.value)}
          />
          {editing ? (
            <p className="text-muted-foreground text-xs">
              编号：{editing.code ?? '未编号'}（建好后不能改）。编号是目编号（如 1-1-1）的前缀，
              改了会让已经建好的目编号对不上；要换编号，请删掉这一{label}重建。
            </p>
          ) : (
            <Input
              value={code}
              placeholder={isChapter ? '编号（留空自动，如 1）' : '编号（留空自动，如 1-2）'}
              onChange={(event) => setCode(event.target.value)}
            />
          )}
          <Input
            data-testid="outline-node-note"
            value={note}
            placeholder="说明（可空）：这一章/节大概讲什么"
            onChange={(event) => setNote(event.target.value)}
          />
          {editing ? (
            <p className="text-muted-foreground text-xs">
              说明会原样进入「AI 生成下一层」的提示词——写偏了，下一层会跟着偏。
            </p>
          ) : null}
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            data-testid="outline-node-save"
            onClick={() => void submit()}
            disabled={busy || title.trim() === '' || (!editing && !target)}
          >
            {busy ? <Loader2 className="animate-spin" /> : editing ? <Save /> : <Plus />}
            {editing ? '保存' : '创建'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
