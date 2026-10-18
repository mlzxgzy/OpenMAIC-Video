/**
 * 从一份大纲文本建出整片骨架（章 → 节 → 目）。
 *
 * 这是"先出章、再出节、最后出目"的批量入口：导入一次，54 个目按编号落进对应
 * 的节里，培训对象/学时继承系列默认。导入前必须先解析预览，作者看得到系统读到
 * 的树和逐行错误——拒绝"点一下然后祈祷"。
 *
 * 三种行格式见 `lib/curriculum/outline-import.ts`；这个对话框只负责展示和提交，
 * 解析规则在纯函数里（可单测）。
 */
'use client';

import { useState } from 'react';
import { AlertTriangle, FileUp, Loader2, Sparkles } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import {
  OUTLINE_IMPORT_KIND_LABELS,
  type OutlineImportResult,
} from '@/lib/curriculum/outline-import';

const FORMAT_SAMPLE = `# CTF 基础与工具环境
## CTF 入门与赛制
- 1-1-1 | CTF概述与竞赛形式 | 理论 | 1 | CTF起源、Jeopardy/AWD、flag格式
- 1-1-2 | 竞赛平台与提交实操 | 实操 | 1 | 平台注册、题目下载、flag提交
## Linux 与网络基础
- 1-2-1 | Linux 基础与权限 | 理论 | 1 | 文件、目录、权限、进程`;

export function OutlineImportDialog({
  open,
  onOpenChange,
  seriesId,
  onImported,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  seriesId: string;
  onImported: () => void;
}) {
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<OutlineImportResult | null>(null);
  const [busy, setBusy] = useState<'preview' | 'commit' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const call = async (mode: 'preview' | 'commit') => {
    if (text.trim() === '') return;
    setBusy(mode);
    setError(null);
    try {
      const response = await fetch(`/api/curriculum/series/${seriesId}/outline/import`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mode, text }),
      });
      const payload = (await response.json().catch(() => null)) as {
        preview?: OutlineImportResult;
        imported?: { chapters: number; sections: number; items: number };
        error?: { message?: string };
      } | null;
      if (!response.ok) throw new Error(payload?.error?.message ?? `失败：HTTP ${response.status}`);
      if (mode === 'preview') {
        setPreview(payload?.preview ?? null);
        return;
      }
      onImported();
      onOpenChange(false);
      setText('');
      setPreview(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '导入失败');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>从大纲导入章、节、目</DialogTitle>
          <DialogDescription>
            一行一章（`#`）、一行一节（`##`）、一行一目（`-`）。目用竖线分隔： 编号 | 标题 | 类型 |
            学时 | 内容要点，除标题外都可省略。导入只能用于还没有大纲的系列。
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <div className="flex justify-end">
            <Button variant="ghost" size="sm" onClick={() => setText(FORMAT_SAMPLE)}>
              <Sparkles className="size-3.5" />
              插入格式示例
            </Button>
          </div>
          <Textarea
            className="min-h-40 font-mono text-xs"
            value={text}
            placeholder={FORMAT_SAMPLE}
            onChange={(event) => {
              setText(event.target.value);
              setPreview(null);
            }}
          />
          {error ? (
            <p className="text-destructive flex items-start gap-1.5 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              {error}
            </p>
          ) : null}
          {preview ? (
            <div className="border-border flex max-h-56 flex-col gap-2 overflow-auto rounded-md border p-3 text-xs">
              <p className="text-muted-foreground">
                读到 {preview.stats.chapters} 章 · {preview.stats.sections} 节 ·{' '}
                {preview.stats.items} 目
                {preview.issues.length > 0 ? ` · ${preview.issues.length} 处问题` : ''}
              </p>
              {preview.issues.length > 0 ? (
                <ul className="text-destructive list-disc pl-4">
                  {preview.issues.map((issue) => (
                    <li key={`${issue.line}-${issue.message}`}>
                      第 {issue.line} 行：{issue.message}
                    </li>
                  ))}
                </ul>
              ) : null}
              {preview.chapters.map((chapter) => (
                <div key={`${chapter.code}-${chapter.title}`}>
                  <p className="font-medium">
                    {chapter.code ? `第 ${chapter.code} 章 ` : ''}
                    {chapter.title}
                  </p>
                  {chapter.sections.map((section) => (
                    <div key={`${section.code}-${section.title}`} className="ml-3">
                      <p className="text-muted-foreground">
                        {section.code ? `${section.code} ` : ''}
                        {section.title}
                      </p>
                      <ul className="ml-3 list-disc">
                        {section.items.map((item) => (
                          <li key={`${item.code}-${item.title}`}>
                            {item.code ? `${item.code} ` : ''}
                            {item.title}
                            {item.kind ? ` · ${OUTLINE_IMPORT_KIND_LABELS[item.kind]}` : ''}
                            {item.hours !== null ? ` · ${item.hours} 学时` : ''}
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              ))}
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="outline" onClick={() => void call('preview')} disabled={busy !== null}>
            {busy === 'preview' ? <Loader2 className="animate-spin" /> : null}
            解析预览
          </Button>
          <Button
            onClick={() => void call('commit')}
            disabled={
              busy !== null || !preview || preview.issues.length > 0 || preview.stats.items === 0
            }
          >
            {busy === 'commit' ? <Loader2 className="animate-spin" /> : <FileUp />}
            导入{' '}
            {preview
              ? `${preview.stats.chapters} 章 ${preview.stats.sections} 节 ${preview.stats.items} 目`
              : ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
