/**
 * 在某节里新建一目。
 *
 * 与上一版"新建目"表单的区别只有一条，但它是根因：这一目**有位置**。编号从
 * 节的编号往下排（`2-1-3`），培训对象和学时从系列默认继承，标题就是大纲里
 * 那一行。用户不再需要凭空编一门课——他是在给一个已经存在的槽位填名字。
 *
 * brief 只要求标题。培训对象、学时、要解决的问题都可以在目工作台第 1 步改；
 * 创建弹窗逼用户一次答完，等于把"这门课是什么"这一整步塞进一个只有三行的
 * 弹窗里。
 */
'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import type { CurriculumTaskKind } from '@/lib/curriculum/design-types';
import { ITEM_KIND_LABEL } from '@/lib/curriculum/ui-labels';

export interface CreateItemSection {
  id: string;
  code: string | null;
  title: string;
}

export function CreateItemDialog({
  open,
  onOpenChange,
  seriesId,
  section,
  defaults,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string;
  section: CreateItemSection | null;
  defaults: { audience: string | null; defaultHours: number | null };
  onCreated: () => void;
}) {
  const router = useRouter();
  const [title, setTitle] = useState('');
  const [code, setCode] = useState('');
  const [kind, setKind] = useState<CurriculumTaskKind>('theory');
  const [hours, setHours] = useState('');
  const [audience, setAudience] = useState('');
  const [problemStatement, setProblemStatement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setTitle('');
    setCode('');
    setKind('theory');
    setHours(defaults.defaultHours === null ? '' : String(defaults.defaultHours));
    setAudience(defaults.audience ?? '');
    setProblemStatement('');
    setError(null);
  }, [open, section, defaults.audience, defaults.defaultHours]);

  const submit = async () => {
    if (!section || title.trim() === '') return;
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/curriculum/design/tasks', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          seriesId,
          sectionId: section.id,
          title: title.trim(),
          kind,
          ...(code.trim() ? { code: code.trim() } : {}),
          ...(hours.trim() !== '' ? { durationHours: Number(hours) } : {}),
          ...(audience.trim() ? { audience: audience.trim() } : {}),
          ...(problemStatement.trim() ? { problemStatement: problemStatement.trim() } : {}),
        }),
      });
      const payload = (await response.json().catch(() => null)) as {
        task?: { id: string };
        error?: { message?: string };
      } | null;
      if (!response.ok || !payload?.task) {
        throw new Error(payload?.error?.message ?? `失败：HTTP ${response.status}`);
      }
      onCreated();
      onOpenChange(false);
      // 建完直接进这一目的第 1 步，而不是回到列表里让用户再去点它。
      router.push(`/curriculum/design/${payload.task.id}`);
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
          <DialogTitle>在这一节里新建一目</DialogTitle>
          <DialogDescription>
            {section
              ? `位置：${section.code ?? ''} ${section.title}。编号留空会自动排成 ${section.code ?? '?'}-下一号。`
              : '还没有选中节。'}{' '}
            创建后进入第 1 步「这门课是什么」，培训对象和学时已经按系列默认填好。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <Input
            autoFocus
            value={title}
            placeholder="目标题，例如：CTF 概述与竞赛形式"
            onChange={(event) => setTitle(event.target.value)}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <Input
              value={code}
              placeholder={`编号（留空自动，如 ${section?.code ?? '1-1'}-1）`}
              onChange={(event) => setCode(event.target.value)}
            />
            <Select value={kind} onValueChange={(value) => setKind(value as CurriculumTaskKind)}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="类型" />
              </SelectTrigger>
              <SelectContent>
                {(Object.keys(ITEM_KIND_LABEL) as CurriculumTaskKind[]).map((value) => (
                  <SelectItem key={value} value={value}>
                    {ITEM_KIND_LABEL[value]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input
              type="number"
              value={hours}
              placeholder="学时"
              onChange={(event) => setHours(event.target.value)}
            />
          </div>
          <Input
            value={audience}
            placeholder="培训对象（默认继承系列）"
            onChange={(event) => setAudience(event.target.value)}
          />
          <Textarea
            className="min-h-20"
            value={problemStatement}
            placeholder="这一目要让学员能做什么？（可空，第 1 步再写）"
            onChange={(event) => setProblemStatement(event.target.value)}
          />
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={() => void submit()} disabled={busy || title.trim() === '' || !section}>
            {busy ? <Loader2 className="animate-spin" /> : <Plus />}
            创建并开始设计
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
