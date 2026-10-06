// @vitest-environment jsdom

/**
 * Per-line editing in the notes tab.
 *
 * The notes tab was a pure read surface — every narration line was a button
 * whose only job was to jump playback. Rewriting a line there is a course edit,
 * so the two things this pins are the two things that could make it dangerous:
 *
 *   - a viewer (or a course with no owner recorded) must still get exactly the
 *     read-only surface they had, with no way to start an edit; and
 *   - a commit must carry the line's IDENTITY, not its position. Regeneration
 *     and the audio drop both address an action by id, so committing by index
 *     would let a concurrent reorder write the new wording onto the wrong line.
 *
 * The "unchanged text is not an edit" rule is pinned too: committing identical
 * text would clear the line's cached audio and force a re-pay for a clip the
 * user never actually changed.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { LectureNoteEntry } from '@/lib/types/chat';

const translations: Record<string, string> = {
  'chat.lectureNotes.empty': 'Notes appear here after you play',
  'chat.lectureNotes.emptyHint': 'Press play to start',
  'chat.lectureNotes.pageLabel': 'Page {{n}}',
  'chat.lectureNotes.currentPage': 'Current',
  'chat.lectureNotes.jumpToLine': 'Jump to this line',
  'chat.lectureNotes.jumpUnavailable': 'Jump unavailable for this line',
  'chat.lectureNotes.editLine': 'Edit this line',
  'chat.lectureNotes.editPlaceholder': 'Type this line of narration…',
  'chat.lectureNotes.editHint': 'Mod+Enter to save · Esc to cancel',
  'chat.lectureNotes.save': 'Save',
  'chat.lectureNotes.cancel': 'Cancel',
};

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      translations[key]?.replace(/\{\{(\w+)\}\}/g, (_m, name) => String(options?.[name] ?? '')) ??
      key,
  }),
}));

import { LectureNotesView } from '@/components/chat/lecture-notes-view';

function notes(): LectureNoteEntry[] {
  return [
    {
      sceneId: 'scene-1',
      sceneTitle: 'What is Linux',
      sceneOrder: 0,
      completedAt: 0,
      items: [
        {
          kind: 'speech',
          text: 'Welcome to the course',
          actionIndex: 0,
          actionId: 'act-a',
          actionType: 'speech',
        },
        {
          kind: 'speech',
          text: 'Linux is a kernel',
          actionIndex: 2,
          actionId: 'act-b',
          actionType: 'speech',
        },
      ],
    },
  ];
}

describe('LectureNotesView — per-line script editing', () => {
  let container: HTMLDivElement;
  let root: Root;

  const render = (props: Partial<React.ComponentProps<typeof LectureNotesView>>) =>
    act(() => {
      root.render(
        createElement(LectureNotesView, {
          notes: notes(),
          currentSceneId: 'scene-1',
          ...props,
        }),
      );
    });

  const editButtons = () =>
    Array.from(container.querySelectorAll('[data-testid="lecture-note-edit-button"]'));
  const textareas = () =>
    Array.from(container.querySelectorAll('textarea')) as HTMLTextAreaElement[];

  /** React maps `onBlur` to `focusout`, so a raw `blur` event never fires it. */
  const blur = async (element: HTMLElement) => {
    await act(async () => {
      element.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    });
  };

  const typeInto = async (textarea: HTMLTextAreaElement, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(textarea, value);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  };

  const openEditor = async (index: number) => {
    await act(async () => {
      editButtons()[index].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    return textareas()[0];
  };

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    // jsdom implements neither `scrollIntoView` nor the layout it drives; the
    // auto-scroll effect runs on every mount and is not what these tests are
    // about.
    Element.prototype.scrollIntoView ??= vi.fn();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('offers no editing affordance at all to a read-only viewer', () => {
    render({});
    expect(editButtons()).toHaveLength(0);
    // The read-only surface is unchanged: the line is still a jump target.
    expect(container.textContent).toContain('Linux is a kernel');
  });

  it('offers no editing affordance when the host grants editing but wires no commit', () => {
    // Both halves are required. A commit handler that is merely optional must
    // not leave an edit button that can only discard the user's work.
    render({ canEditScript: true });
    expect(editButtons()).toHaveLength(0);
  });

  it('exposes one edit control per narration line for an editor', () => {
    render({ canEditScript: true, onCommitScriptText: vi.fn() });
    expect(editButtons()).toHaveLength(2);
  });

  it('commits the line by id and drops a line that was not changed', async () => {
    const onCommitScriptText = vi.fn();
    render({ canEditScript: true, onCommitScriptText });

    const textarea = await openEditor(1);
    expect(textarea.value).toBe('Linux is a kernel');

    // Leaving the field with the text unchanged is not an edit at all:
    // committing it would clear the line's cached audio and force a re-pay for
    // a clip nobody rewrote.
    await blur(textarea);
    expect(onCommitScriptText).not.toHaveBeenCalled();
  });

  it('commits the edited wording against the line’s action id, not its index', async () => {
    const onCommitScriptText = vi.fn();
    render({ canEditScript: true, onCommitScriptText });

    const textarea = await openEditor(1);
    await typeInto(textarea, 'Linux is the kernel, not the whole system');
    await blur(textarea);

    // `act-b` is the SECOND line: an index-based commit would have written
    // this wording onto the first line and silently corrupted the other.
    expect(onCommitScriptText).toHaveBeenCalledWith(
      'scene-1',
      'act-b',
      'Linux is the kernel, not the whole system',
    );
  });

  it('abandons an edit on Escape without committing', async () => {
    const onCommitScriptText = vi.fn();
    render({ canEditScript: true, onCommitScriptText });

    const textarea = await openEditor(0);
    await typeInto(textarea, 'something the user backed out of');
    await act(async () => {
      textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    expect(onCommitScriptText).not.toHaveBeenCalled();
    // The blur that follows the escape must not commit the abandoned draft
    // either — this is the assertion a stale `dirtyRef` would fail.
    await blur(textarea);
    expect(onCommitScriptText).not.toHaveBeenCalled();
  });

  it('adopts an external rewrite of the line while no edit is open', async () => {
    const onCommitScriptText = vi.fn();
    render({ canEditScript: true, onCommitScriptText });
    expect(container.textContent).toContain('Linux is a kernel');

    // A regeneration landing while the user reads must be reflected…
    await act(async () => {
      root.render(
        createElement(LectureNotesView, {
          notes: [
            {
              ...notes()[0],
              items: [
                {
                  kind: 'speech',
                  text: 'Welcome',
                  actionIndex: 0,
                  actionId: 'act-a',
                  actionType: 'speech',
                },
                {
                  kind: 'speech',
                  text: 'Linux is an operating system kernel',
                  actionIndex: 2,
                  actionId: 'act-b',
                  actionType: 'speech',
                },
              ],
            },
          ],
          currentSceneId: 'scene-1',
          canEditScript: true,
          onCommitScriptText,
        }),
      );
    });

    expect(container.textContent).toContain('Linux is an operating system kernel');

    // …and the editor must open on the NEW text, not a stale snapshot.
    const textarea = await openEditor(1);
    expect(textarea.value).toBe('Linux is an operating system kernel');
  });
});
