'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BookOpen,
  MessageSquare,
  Flashlight,
  MousePointer2,
  Pencil,
  Play,
  Highlighter,
  SlidersHorizontal,
  StickyNote,
  Eye,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { LectureNoteEntry } from '@/lib/types/chat';

const ACTION_ICON_ONLY: Record<string, { Icon: typeof Flashlight; style: string }> = {
  spotlight: {
    Icon: Flashlight,
    style:
      'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300',
  },
  laser: {
    Icon: MousePointer2,
    style:
      'bg-red-50 dark:bg-red-500/15 border-red-300/40 dark:border-red-500/30 text-red-600 dark:text-red-300',
  },
  play_video: {
    Icon: Play,
    style:
      'bg-yellow-50 dark:bg-yellow-500/15 border-yellow-300/40 dark:border-yellow-500/30 text-yellow-700 dark:text-yellow-300',
  },
  widget_highlight: {
    Icon: Highlighter,
    style:
      'bg-amber-50 dark:bg-amber-500/15 border-amber-300/40 dark:border-amber-500/30 text-amber-700 dark:text-amber-300',
  },
  widget_setState: {
    Icon: SlidersHorizontal,
    style:
      'bg-indigo-50 dark:bg-indigo-500/15 border-indigo-300/40 dark:border-indigo-500/30 text-indigo-700 dark:text-indigo-300',
  },
  widget_annotation: {
    Icon: StickyNote,
    style:
      'bg-sky-50 dark:bg-sky-500/15 border-sky-300/40 dark:border-sky-500/30 text-sky-700 dark:text-sky-300',
  },
  widget_reveal: {
    Icon: Eye,
    style:
      'bg-emerald-50 dark:bg-emerald-500/15 border-emerald-300/40 dark:border-emerald-500/30 text-emerald-700 dark:text-emerald-300',
  },
};

interface LectureNotesViewProps {
  notes: LectureNoteEntry[];
  currentSceneId?: string | null;
  currentActionIndex?: number | null;
  canJumpToAction?: (sceneId: string, actionIndex: number) => boolean;
  onJumpToAction?: (sceneId: string, actionIndex: number) => void;
  /**
   * Whether the viewer may rewrite the script at all. Read from the stage
   * store's owner/read-only facts, so a visitor gets the notes exactly as
   * before: a jump target, never an editor. Absent ⇒ not editable.
   */
  canEditScript?: boolean;
  /**
   * Commit an edited line. The host is responsible for the write AND for
   * dropping the line's now-stale audio (the blob is keyed by scene+action,
   * not by text, so an edit that left it in place would replay the old
   * wording); the view only carries the identity and the new text.
   */
  onCommitScriptText?: (sceneId: string, actionId: string, text: string) => void;
}

/** One editable narration line: the jump target that can become a textarea. */
function EditableSpeechLine({
  text,
  canJump,
  onJump,
  canEdit,
  onCommit,
  badges,
  className,
}: {
  text: string;
  canJump: boolean;
  onJump?: () => void;
  canEdit: boolean;
  onCommit?: (text: string) => void;
  badges: React.ReactNode;
  className: string;
}) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  // Has the user typed since the last external sync? Mirrors the Pro-mode
  // `SpeechClip` rule (`components/edit/ActionsBar/ActionsBar.tsx:574`): an
  // external rewrite (a regeneration landing while this line is open) is
  // adopted only when the line is not mid-edit, so a stale draft can never
  // clobber freshly generated narration on commit.
  const dirtyRef = useRef(false);

  useEffect(() => {
    if (editing && dirtyRef.current) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- adopt external text only when not mid-edit
    setDraft(text);
    dirtyRef.current = false;
  }, [text, editing]);

  useEffect(() => {
    if (editing) textareaRef.current?.focus();
  }, [editing]);

  const close = useCallback(() => {
    setEditing(false);
    dirtyRef.current = false;
  }, []);

  const commit = useCallback(() => {
    const next = draft.trim();
    // A blank line is a real edit the user may want (they are mid-rewrite),
    // but an UNCHANGED one is not an edit at all: committing it would clear
    // the line's audio for nothing.
    dirtyRef.current = false;
    setEditing(false);
    if (next === text.trim() || !next) return;
    onCommit?.(next);
  }, [draft, text, onCommit]);

  if (editing) {
    return (
      <div className="rounded-md border border-violet-300 bg-violet-50/60 p-1 dark:border-violet-700 dark:bg-violet-950/30">
        <textarea
          ref={textareaRef}
          data-testid="lecture-note-edit-textarea"
          value={draft}
          onChange={(e) => {
            dirtyRef.current = true;
            setDraft(e.target.value);
          }}
          onBlur={commit}
          onKeyDown={(e) => {
            // Escape abandons the edit and restores what was there; the next
            // blur (from the click that focused elsewhere) must not then commit
            // the abandoned draft, so the guard is cleared on the way out.
            if (e.key === 'Escape') {
              e.preventDefault();
              setDraft(text);
              dirtyRef.current = false;
              close();
            } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              commit();
            }
          }}
          placeholder={t('chat.lectureNotes.editPlaceholder')}
          aria-label={t('chat.lectureNotes.editLine')}
          className="min-h-[4.5rem] w-full resize-y bg-transparent px-1.5 py-1 text-[12px] leading-[1.8] text-gray-800 outline-none placeholder:text-muted-foreground/40 dark:text-gray-100"
        />
        <div className="flex items-center justify-end gap-1 px-1 pb-0.5">
          <span className="mr-auto text-[10px] text-muted-foreground/60">
            {t('chat.lectureNotes.editHint')}
          </span>
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={close}
            className="rounded px-1.5 py-0.5 text-[10.5px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            {t('chat.lectureNotes.cancel')}
          </button>
          <button
            type="button"
            data-testid="lecture-note-edit-save"
            onMouseDown={(e) => e.preventDefault()}
            onClick={commit}
            className="rounded bg-primary px-2 py-0.5 text-[10.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            {t('chat.lectureNotes.save')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={cn('group/line relative rounded-md', className)}>
      <button
        type="button"
        disabled={!canJump}
        onClick={onJump}
        className={cn(
          'block w-full rounded-md px-1 py-0.5 text-left text-[12px] leading-[1.8] transition-colors',
          canJump
            ? 'cursor-pointer hover:bg-purple-50 dark:hover:bg-purple-950/25'
            : 'cursor-default',
        )}
        aria-label={
          canJump ? t('chat.lectureNotes.jumpToLine') : t('chat.lectureNotes.jumpUnavailable')
        }
      >
        {badges}
        {text}
      </button>
      {canEdit && (
        <button
          type="button"
          data-testid="lecture-note-edit-button"
          onClick={() => {
            // An uncommitted draft from a previous visit is not something the
            // user can see or cancel any more, so the line starts clean.
            dirtyRef.current = false;
            setDraft(text);
            setEditing(true);
          }}
          title={t('chat.lectureNotes.editLine')}
          aria-label={t('chat.lectureNotes.editLine')}
          className="absolute -left-0.5 top-0 grid size-4 place-items-center rounded text-muted-foreground/0 transition-colors group-hover/line:text-muted-foreground/45 hover:!text-primary focus-visible:text-primary group-hover/line:bg-purple-50 dark:group-hover/line:bg-purple-950/25"
        >
          <Pencil className="size-2.5" />
        </button>
      )}
    </div>
  );
}

export function LectureNotesView({
  notes,
  currentSceneId,
  currentActionIndex,
  canJumpToAction,
  onJumpToAction,
  canEditScript = false,
  onCommitScriptText,
}: LectureNotesViewProps) {
  const { t } = useI18n();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleCommit = useCallback(
    (sceneId: string, actionId: string, text: string) => {
      onCommitScriptText?.(sceneId, actionId, text);
    },
    [onCommitScriptText],
  );

  // Auto-scroll to the current scene note
  useEffect(() => {
    if (!currentSceneId || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-scene-id="${currentSceneId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, [currentSceneId]);

  // Empty state
  if (notes.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center p-6">
        <div className="w-12 h-12 bg-purple-50 dark:bg-purple-900/20 rounded-2xl flex items-center justify-center mb-3 text-purple-300 dark:text-purple-600 ring-1 ring-purple-100 dark:ring-purple-800/30">
          <BookOpen className="w-6 h-6" />
        </div>
        <p className="text-xs font-medium text-gray-500 dark:text-gray-400">
          {t('chat.lectureNotes.empty')}
        </p>
        <p className="text-[10px] text-gray-400 dark:text-gray-500 mt-1">
          {t('chat.lectureNotes.emptyHint')}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-2 scrollbar-hide"
    >
      {notes.map((note, index) => {
        const isCurrent = note.sceneId === currentSceneId;
        const pageNum = index + 1;
        const pageLabel = t('chat.lectureNotes.pageLabel', { n: pageNum });

        return (
          <div
            key={note.sceneId}
            data-scene-id={note.sceneId}
            className={cn(
              'relative mb-3 last:mb-0 rounded-lg px-3 py-2.5 transition-colors duration-200',
              isCurrent
                ? 'bg-purple-50/80 dark:bg-purple-950/25 ring-1 ring-purple-200/60 dark:ring-purple-700/30'
                : 'bg-gray-50/50 dark:bg-gray-800/30',
            )}
          >
            {/* Page label row */}
            <div className="flex items-center gap-2 mb-1.5">
              {/* Timeline dot */}
              <div
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  isCurrent
                    ? 'bg-purple-500 dark:bg-purple-400 shadow-sm shadow-purple-400/40'
                    : 'bg-gray-300 dark:bg-gray-600',
                )}
              />
              <span
                className={cn(
                  'text-[10px] font-semibold tracking-wide',
                  isCurrent
                    ? 'text-purple-600 dark:text-purple-400'
                    : 'text-gray-400 dark:text-gray-500',
                )}
              >
                {pageLabel}
              </span>
              {isCurrent && (
                <span className="text-[9px] font-bold px-1.5 py-px rounded-full bg-purple-100 dark:bg-purple-900/40 text-purple-600 dark:text-purple-300">
                  {t('chat.lectureNotes.currentPage')}
                </span>
              )}
            </div>

            {/* Scene title */}
            <h4 className="text-[13px] font-bold text-gray-800 dark:text-gray-100 mb-1.5 leading-snug pl-4">
              {note.sceneTitle}
            </h4>

            {/* Ordered items: spotlight/laser inline at sentence start, discussion as card */}
            <div className="pl-4 space-y-1">
              {(() => {
                // Build render rows: group inline actions (spotlight/laser) with next speech,
                // but render discussion as its own block
                type Row =
                  | {
                      kind: 'speech';
                      inlineActions: string[];
                      text: string;
                      actionIndex: number;
                      actionId: string;
                    }
                  | { kind: 'discussion'; label?: string; actionIndex: number; actionId: string }
                  | { kind: 'trailing'; inlineActions: string[] };
                const rows: Row[] = [];
                let pendingInline: string[] = [];
                for (const item of note.items) {
                  if (item.kind === 'action' && item.type === 'discussion') {
                    // Flush pending inline actions as trailing if any
                    if (pendingInline.length > 0) {
                      rows.push({
                        kind: 'trailing',
                        inlineActions: pendingInline,
                      });
                      pendingInline = [];
                    }
                    rows.push({
                      kind: 'discussion',
                      label: item.label,
                      actionIndex: item.actionIndex,
                      actionId: item.actionId,
                    });
                  } else if (item.kind === 'action') {
                    pendingInline.push(item.type);
                  } else {
                    rows.push({
                      kind: 'speech',
                      inlineActions: pendingInline,
                      text: item.text,
                      actionIndex: item.actionIndex,
                      actionId: item.actionId,
                    });
                    pendingInline = [];
                  }
                }
                if (pendingInline.length > 0) {
                  rows.push({ kind: 'trailing', inlineActions: pendingInline });
                }
                return rows.map((row, i) => {
                  if (row.kind === 'discussion') {
                    return (
                      <div
                        key={i}
                        className="my-1.5 flex items-start gap-1.5 rounded-md border border-amber-200/60 dark:border-amber-700/30 bg-amber-50/60 dark:bg-amber-900/10 px-2 py-1.5"
                      >
                        <MessageSquare className="w-3 h-3 text-amber-500 dark:text-amber-400 shrink-0 mt-0.5" />
                        <span className="text-[11px] leading-snug text-amber-800 dark:text-amber-300">
                          {row.label}
                        </span>
                      </div>
                    );
                  }
                  const actions = row.kind === 'trailing' ? row.inlineActions : row.inlineActions;
                  const isSpeech = row.kind === 'speech';
                  const isActiveSpeech =
                    isCurrent && isSpeech && row.actionIndex === currentActionIndex;
                  const canJump =
                    isCurrent &&
                    isSpeech &&
                    !!onJumpToAction &&
                    (canJumpToAction?.(note.sceneId, row.actionIndex) ?? false);
                  const badges = (
                    <>
                      {actions.map((a, j) => {
                        const cfg = ACTION_ICON_ONLY[a];
                        if (!cfg) return null;
                        const { Icon, style } = cfg;
                        return (
                          <span
                            key={j}
                            className={cn(
                              'inline-flex items-center justify-center w-4 h-4 rounded-full border align-middle mr-0.5',
                              style,
                            )}
                          >
                            <Icon className="w-2.5 h-2.5" />
                          </span>
                        );
                      })}
                    </>
                  );
                  if (isSpeech) {
                    return (
                      <EditableSpeechLine
                        key={row.actionId}
                        text={row.text}
                        canJump={canJump}
                        onJump={() => onJumpToAction?.(note.sceneId, row.actionIndex)}
                        canEdit={canEditScript && !!onCommitScriptText}
                        onCommit={(next) => handleCommit(note.sceneId, row.actionId, next)}
                        badges={badges}
                        className={cn(
                          isActiveSpeech
                            ? 'bg-purple-100/80 text-purple-800 dark:bg-purple-900/35 dark:text-purple-200'
                            : 'text-gray-700 dark:text-gray-300',
                        )}
                      />
                    );
                  }
                  return (
                    <p
                      key={i}
                      className="text-[12px] leading-[1.8] text-gray-700 dark:text-gray-300"
                    >
                      {badges}
                    </p>
                  );
                });
              })()}
            </div>
          </div>
        );
      })}
    </div>
  );
}
