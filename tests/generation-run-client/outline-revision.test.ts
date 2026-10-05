import { describe, expect, it } from 'vitest';

import {
  MAX_REVISION_HISTORY_CHARS,
  MAX_REVISION_HISTORY_TURNS,
  historyForRequest,
  summarizeOutlineChange,
} from '@/lib/generation-run-client/outline-revision';
import type { SceneOutline } from '@/lib/types/generation';

const scene = (overrides: Partial<SceneOutline> = {}): SceneOutline => ({
  id: 'o1',
  type: 'slide',
  title: 'Intro',
  description: 'Why',
  keyPoints: ['a'],
  order: 1,
  ...overrides,
});

describe('the conversation a revision request carries', () => {
  it('keeps only the recent turns', () => {
    const turns = Array.from({ length: MAX_REVISION_HISTORY_TURNS + 3 }, (_, index) => ({
      role: (index % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: String(index),
    }));
    const kept = historyForRequest(turns);
    expect(kept).toHaveLength(MAX_REVISION_HISTORY_TURNS);
    expect(kept[0]!.content).toBe('3');
    expect(kept.at(-1)!.content).toBe('10');
  });

  it('caps one turn at the length the server accepts', () => {
    const kept = historyForRequest([
      { role: 'user', content: 'x'.repeat(MAX_REVISION_HISTORY_CHARS + 50) },
    ]);
    expect(kept[0]!.content).toHaveLength(MAX_REVISION_HISTORY_CHARS);
  });
});

describe('what one revision changed', () => {
  it('counts added, removed and changed scenes by id', () => {
    const summary = summarizeOutlineChange(
      [scene(), scene({ id: 'o2', title: 'Old' }), scene({ id: 'o3' })],
      [scene(), scene({ id: 'o2', title: 'New' }), scene({ id: 'o4' })],
    );
    expect(summary).toEqual({ added: 1, removed: 1, changed: 1 });
  });

  it('ignores a reorder alone, and the media element ids the server re-mints', () => {
    const withMedia = scene({
      id: 'o1',
      mediaGenerations: [{ type: 'image', prompt: 'a leaf', elementId: 'gen_img_1' }],
    });
    const reminted = scene({
      id: 'o1',
      mediaGenerations: [{ type: 'image', prompt: 'a leaf', elementId: 'gen_img_2' }],
    });
    expect(
      summarizeOutlineChange([withMedia, scene({ id: 'o2' })], [reminted, scene({ id: 'o2' })]),
    ).toEqual({ added: 0, removed: 0, changed: 0 });
    expect(
      summarizeOutlineChange(
        [scene({ id: 'o1', order: 1 }), scene({ id: 'o2', order: 2 })],
        [scene({ id: 'o2', order: 1 }), scene({ id: 'o1', order: 2 })],
      ),
    ).toEqual({ added: 0, removed: 0, changed: 0 });
  });

  it('counts a changed key point or configuration as a change', () => {
    expect(summarizeOutlineChange([scene()], [scene({ keyPoints: ['a', 'b'] })])).toEqual({
      added: 0,
      removed: 0,
      changed: 1,
    });
    expect(
      summarizeOutlineChange(
        [scene({ type: 'quiz' })],
        [
          scene({
            type: 'quiz',
            quizConfig: { questionCount: 3, difficulty: 'easy', questionTypes: ['single'] },
          }),
        ],
      ),
    ).toEqual({ added: 0, removed: 0, changed: 1 });
  });
});
