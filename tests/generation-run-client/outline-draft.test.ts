/**
 * The browser's draft of a learner's unconfirmed outline edits: what is put
 * back in the review when the page is left and opened again, and what is
 * refused.
 */
import { describe, expect, it } from 'vitest';

import {
  clearOutlineDraft,
  outlineDraftKey,
  readOutlineDraft,
  restoreOutlineDraft,
  writeOutlineDraft,
} from '@/lib/generation-run-client/outline-draft';
import type { SceneOutline } from '@/lib/types/generation';

function memoryStorage(seed: Record<string, string> = {}): Storage & {
  entries: Map<string, string>;
} {
  const entries = new Map(Object.entries(seed));
  return {
    entries,
    get length() {
      return entries.size;
    },
    clear: () => entries.clear(),
    getItem: (key: string) => entries.get(key) ?? null,
    key: (index: number) => [...entries.keys()][index] ?? null,
    removeItem: (key: string) => void entries.delete(key),
    setItem: (key: string, value: string) => void entries.set(key, value),
  };
}

const scene = (overrides: Partial<SceneOutline> = {}): SceneOutline => ({
  id: 'o1',
  type: 'slide',
  title: 'Intro',
  description: 'Why',
  keyPoints: ['a'],
  order: 1,
  ...overrides,
});

describe('a run outline draft', () => {
  it('reads back what it wrote, per run', () => {
    const storage = memoryStorage();
    const outlines = [scene(), scene({ id: 'o2', title: 'Quiz', type: 'quiz', order: 2 })];

    writeOutlineDraft('run-1', { revision: 2, outlines }, storage);

    expect(readOutlineDraft('run-1', storage)).toEqual({ revision: 2, outlines });
    expect(readOutlineDraft('run-2', storage)).toBeNull();
    expect(storage.getItem(outlineDraftKey('run-1'))).not.toBeNull();
  });

  it('restores a draft made against the outline revision the run still has', () => {
    const storage = memoryStorage();
    const outlines = [scene({ title: 'Revised' })];
    writeOutlineDraft('run-1', { revision: 3, outlines }, storage);

    expect(restoreOutlineDraft('run-1', 3, storage)).toEqual(outlines);
    expect(readOutlineDraft('run-1', storage)).not.toBeNull();
  });

  it('drops a stale draft instead of shadowing a re-outlined run', () => {
    const storage = memoryStorage();
    writeOutlineDraft('run-1', { revision: 3, outlines: [scene()] }, storage);

    expect(restoreOutlineDraft('run-1', 4, storage)).toBeNull();
    expect(readOutlineDraft('run-1', storage)).toBeNull();
  });

  it('forgets a draft on request', () => {
    const storage = memoryStorage();
    writeOutlineDraft('run-1', { revision: 1, outlines: [scene()] }, storage);

    clearOutlineDraft('run-1', storage);

    expect(readOutlineDraft('run-1', storage)).toBeNull();
  });

  it('fills a missing key point list rather than handing the editor an undefined one', () => {
    const storage = memoryStorage({
      [outlineDraftKey('run-1')]: JSON.stringify({
        revision: 1,
        outlines: [{ id: 'o1', type: 'slide', title: 'Intro', description: 'Why', order: 1 }],
      }),
    });

    expect(readOutlineDraft('run-1', storage)?.outlines[0]!.keyPoints).toEqual([]);
  });
});

describe('what a draft read refuses', () => {
  const unusable: ReadonlyArray<readonly [string, string]> = [
    ['unparseable JSON', '{oops'],
    ['a bare value', '"nope"'],
    ['no revision', JSON.stringify({ outlines: [scene()] })],
    ['a revision that is not a number', JSON.stringify({ revision: '2', outlines: [scene()] })],
    ['no outlines', JSON.stringify({ revision: 1 })],
    ['an empty outline', JSON.stringify({ revision: 1, outlines: [] })],
    ['a scene with no id', JSON.stringify({ revision: 1, outlines: [{ ...scene(), id: '' }] })],
    [
      'a scene of an unknown type',
      JSON.stringify({ revision: 1, outlines: [{ ...scene(), type: 'video' }] }),
    ],
    [
      'a scene with a non-string title',
      JSON.stringify({ revision: 1, outlines: [{ ...scene(), title: 7 }] }),
    ],
    [
      'a scene whose key points are not strings',
      JSON.stringify({ revision: 1, outlines: [{ ...scene(), keyPoints: [1, 2] }] }),
    ],
  ];

  for (const [name, raw] of unusable) {
    it(`refuses ${name}`, () => {
      const storage = memoryStorage({ [outlineDraftKey('run-1')]: raw });
      expect(readOutlineDraft('run-1', storage)).toBeNull();
    });
  }
});

describe('a draft where storage is missing or hostile', () => {
  const throwing = {
    getItem: () => {
      throw new Error('denied');
    },
    setItem: () => {
      throw new Error('quota');
    },
    removeItem: () => {
      throw new Error('denied');
    },
  } as unknown as Storage;

  it('answers nothing when there is no storage at all', () => {
    expect(readOutlineDraft('run-1', null as unknown as Storage)).toBeNull();
  });

  it('reads, writes and clears without throwing', () => {
    expect(readOutlineDraft('run-1', throwing)).toBeNull();
    expect(() =>
      writeOutlineDraft('run-1', { revision: 1, outlines: [scene()] }, throwing),
    ).not.toThrow();
    expect(() => clearOutlineDraft('run-1', throwing)).not.toThrow();
  });
});
