'use client';

/**
 * The review page's "ask AI to edit the outline" chat. Each instruction is one
 * request to `POST /api/generation-runs/:id/revise-outline` (the outline stage's
 * model); the answer replaces the editor's outline through `onApply`, and one
 * step of undo is kept in the dialog. Nothing here is stored on the server: the
 * outline reaches the run only when the learner confirms it.
 */
import { useEffect, useRef, useState } from 'react';
import { Loader2, Send, Sparkles, Undo2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { RunApiError, reviseRunOutline, runApiErrorText } from '@/lib/generation-run-client/api';
import {
  historyForRequest,
  summarizeOutlineChange,
  type OutlineChangeSummary,
} from '@/lib/generation-run-client/outline-revision';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { OutlineRevisionTurn, SceneOutline } from '@/lib/types/generation';
import { cn } from '@/lib/utils';

interface ChatMessage {
  id: number;
  role: 'user' | 'assistant' | 'notice';
  content: string;
  /** What the assistant's revision changed; absent for user and notice messages. */
  summary?: OutlineChangeSummary;
}

export interface OutlineAiDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  /** The editor's current outline: the source of truth for the next request. */
  outlines: SceneOutline[];
  /** Replace the editor's outline (the page's own change handler). */
  onApply: (outlines: SceneOutline[]) => void;
  /** The run moved on (confirmed elsewhere / streaming): close and stop sending. */
  disabled?: boolean;
}

export function OutlineAiDialog({
  open,
  onOpenChange,
  runId,
  outlines,
  onApply,
  disabled = false,
}: OutlineAiDialogProps) {
  const { t } = useI18n();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The outline each revision replaced, for one step of undo.
  const [undo, setUndo] = useState<SceneOutline[] | null>(null);
  const nextMessageId = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const push = (message: Omit<ChatMessage, 'id'>) => {
    nextMessageId.current += 1;
    const entry = { ...message, id: nextMessageId.current };
    setMessages((current) => [...current, entry]);
    return entry;
  };

  // The run moved on: an outline revision could no longer be used.
  useEffect(() => {
    if (disabled && open) onOpenChange(false);
  }, [disabled, open, onOpenChange]);

  // Closing abandons an in-flight revision: it is never applied or remembered.
  useEffect(() => {
    if (!open) controllerRef.current?.abort();
  }, [open]);

  useEffect(() => {
    const list = listRef.current;
    if (list) list.scrollTop = list.scrollHeight;
  }, [messages, busy]);

  const send = async () => {
    const instruction = draft.trim();
    if (!instruction || busy || disabled) return;
    const before = outlines;
    const history: OutlineRevisionTurn[] = historyForRequest(
      messages
        .filter((message) => message.role !== 'notice')
        .map((message) => ({
          role: message.role === 'user' ? 'user' : 'assistant',
          content: message.content,
        })),
    );

    push({ role: 'user', content: instruction });
    setDraft('');
    setError(null);
    setBusy(true);
    const controller = new AbortController();
    controllerRef.current = controller;
    try {
      const answer = await reviseRunOutline(
        runId,
        { instruction, outlines: before, history },
        controller.signal,
      );
      const summary = summarizeOutlineChange(before, answer.outlines);
      push({
        role: 'assistant',
        content: answer.message || t('generation.aiEditApplied'),
        summary,
      });
      setUndo(before);
      onApply(answer.outlines);
    } catch (caught) {
      if (controller.signal.aborted) return;
      setError(
        caught instanceof RunApiError
          ? runApiErrorText(caught, t)
          : caught instanceof Error
            ? caught.message
            : String(caught),
      );
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      setBusy(false);
    }
  };

  const undoLast = () => {
    if (!undo || busy) return;
    onApply(undo);
    setUndo(null);
    push({ role: 'notice', content: t('generation.aiEditUndone') });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="outline-ai-dialog"
        className="flex max-h-[85vh] w-[min(92vw,36rem)] flex-col gap-4 sm:max-w-lg"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-blue-500" />
            {t('generation.aiEditTitle')}
          </DialogTitle>
          <DialogDescription>{t('generation.aiEditDescription')}</DialogDescription>
        </DialogHeader>

        <div
          ref={listRef}
          className="min-h-[8rem] flex-1 space-y-3 overflow-y-auto rounded-lg bg-muted/40 p-3"
          data-testid="outline-ai-messages"
        >
          {messages.length === 0 && (
            <p className="py-6 text-center text-sm text-muted-foreground">
              {t('generation.aiEditIntro')}
            </p>
          )}
          {messages.map((message) => (
            <div
              key={message.id}
              className={cn('flex', message.role === 'user' ? 'justify-end' : 'justify-start')}
            >
              {message.role === 'notice' ? (
                <p className="w-full text-center text-xs text-muted-foreground">
                  {message.content}
                </p>
              ) : (
                <div
                  className={cn(
                    'max-w-[85%] space-y-1 rounded-2xl px-3 py-2 text-sm',
                    message.role === 'user'
                      ? 'bg-blue-500 text-white'
                      : 'bg-background text-foreground ring-1 ring-border/50',
                  )}
                >
                  <p className="whitespace-pre-wrap break-words">{message.content}</p>
                  {message.summary &&
                    message.summary.added + message.summary.removed + message.summary.changed >
                      0 && (
                      <p className="text-xs opacity-70">
                        {t('generation.aiEditChangeSummary', {
                          added: message.summary.added,
                          removed: message.summary.removed,
                          changed: message.summary.changed,
                        })}
                      </p>
                    )}
                </div>
              )}
            </div>
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {t('generation.aiEditThinking')}
            </div>
          )}
        </div>

        {error && (
          <p className="rounded-md border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-600 dark:text-red-300">
            {error}
          </p>
        )}

        <div className="space-y-2">
          <Textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault();
                void send();
              }
            }}
            disabled={busy || disabled}
            rows={2}
            placeholder={t('generation.aiEditPlaceholder')}
            aria-label={t('generation.aiEditPlaceholder')}
            data-testid="outline-ai-input"
            className="min-h-[3.5rem] resize-none"
          />
          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={undoLast}
              disabled={!undo || busy}
              data-testid="outline-ai-undo"
              className="text-muted-foreground"
            >
              <Undo2 className="size-3.5 mr-1.5" />
              {t('generation.aiEditUndo')}
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => void send()}
              disabled={busy || disabled || !draft.trim()}
              data-testid="outline-ai-send"
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
              {t('generation.aiEditSend')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
