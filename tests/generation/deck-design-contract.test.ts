/**
 * The `deck_design` → outline contract.
 *
 * This module is the answer to "讲课设计应该输出给后续课件生成模型使用": the
 * teaching design has to arrive at slide generation as data, not as a paragraph
 * a generator re-interprets. The tests pin the three properties that make it
 * a contract rather than a suggestion, plus the two that keep a broken plan
 * from producing a plausible-looking deck.
 */
import { describe, expect, it } from 'vitest';

import { buildDeckDesignBlock } from '@/lib/server/generation/steps/deck-design-contract';
import type { DeckDesign } from '@/lib/types/generation';

const page = (overrides: Partial<DeckDesign['pages'][number]> = {}) => ({
  order: 1,
  title: '什么是 SQL 注入',
  goal: '能说出为什么这个载荷绕过了认证',
  coreInfo: '参数值被直接拼进查询',
  mode: 'explain' as const,
  ...overrides,
});

describe('deck design contract', () => {
  it('returns null for an absent or empty plan, so the ad-hoc path is untouched', () => {
    expect(buildDeckDesignBlock(undefined)).toBeNull();
    expect(buildDeckDesignBlock({ pages: [] })).toBeNull();
  });

  it('renders every page with its goal, core message and mode', () => {
    const block = buildDeckDesignBlock({
      pages: [
        page({
          order: 1,
          title: '问题场景',
          goal: '建立问题场景',
          coreInfo: '一个登录请求',
          mode: 'case',
        }),
        page({
          order: 2,
          title: '注入原理',
          goal: '解释注入为何成立',
          coreInfo: '值被拼进查询',
          mode: 'compare',
        }),
      ],
    })!;
    expect(block).toContain('Page 1: 问题场景');
    expect(block).toContain('建立问题场景');
    expect(block).toContain('解释注入为何成立');
    // Mode becomes an instruction, not a bare enum value: the model is told
    // how to present the page, which is the part a bare title loses.
    expect(block).toMatch(/concrete situation/i);
    expect(block).toMatch(/side by side/i);
  });

  it('orders pages by their order field, not by array position', () => {
    // A plan stored out of order must still teach in the right sequence.
    const block = buildDeckDesignBlock({
      pages: [
        page({ order: 3, title: 'THIRD' }),
        page({ order: 1, title: 'FIRST' }),
        page({ order: 2, title: 'SECOND' }),
      ],
    })!;
    expect(block.indexOf('FIRST')).toBeLessThan(block.indexOf('SECOND'));
    expect(block.indexOf('SECOND')).toBeLessThan(block.indexOf('THIRD'));
    // Numbered by position, so the model reads a contiguous sequence.
    expect(block).toContain('Page 1: FIRST');
    expect(block).toContain('Page 3: THIRD');
  });

  it('keeps code verbatim and marks it as such', () => {
    const block = buildDeckDesignBlock({
      pages: [page({ code: "SELECT * FROM users WHERE name = '" + "' + $1;" })],
    })!;
    expect(block).toContain('```');
    expect(block).toContain('$1;');
    expect(block).toMatch(/verbatim/i);
  });

  it('flags a page with no goal instead of passing a title through as a design', () => {
    // The core failure: a page with only a title produces a plausible slide
    // that traces back to no teaching decision.
    const block = buildDeckDesignBlock({
      pages: [page({ goal: '' })],
    })!;
    expect(block).toMatch(/MISSING/);
    expect(block).toMatch(/Do not invent one/i);
  });

  it('counts only the incomplete pages, so a mostly-good plan is not called broken', () => {
    const block = buildDeckDesignBlock({
      pages: [page({ order: 1 }), page({ order: 2, coreInfo: '   ' })],
    })!;
    // One broken page out of two. Counting the whole plan would tell the model
    // to distrust a plan that is nearly complete, and it would stop trying.
    expect(block).toMatch(/1 of 2 planned page\(s\) are missing/i);
  });

  it('tells the model the plan is authoritative over its own restructuring', () => {
    const block = buildDeckDesignBlock({ pages: [page()] })!;
    // These three lines are the contract. Without them a generator merges
    // pages, adds pages, or drops the weakest one, and the teaching design is
    // discarded at the last step.
    expect(block).toMatch(/exactly these pages/i);
    expect(block).toMatch(/Do not merge pages, split them, or add pages/i);
    expect(block).toMatch(/not to redesign the lesson/i);
  });

  it('notes an estimate that disagrees with the specified pages, and defers to the pages', () => {
    const block = buildDeckDesignBlock({ estPages: 20, pages: [page()] })!;
    expect(block).toMatch(/estimates 20 pages but specifies 1/i);
    expect(block).toMatch(/Follow the specified pages/i);
  });
});
