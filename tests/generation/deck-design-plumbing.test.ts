/**
 * The `deck_design` contract, end to end through the run.
 *
 * The existing `deck-design-contract.test.ts` calls `buildDeckDesignBlock`
 * directly, which proves the renderer works and proves nothing about whether
 * the outline ever receives a plan. That gap hid a real defect: `deckDesign`
 * existed on `UserRequirements` and on the prompt-rendering path, but no
 * producer ever set it, so a designed course silently generated from prose
 * while the code read as though the contract were wired.
 *
 * A contract test on an unreachable function is the failure mode, so these
 * tests go through the two functions the run actually calls —
 * `parseRunInput` and `runRequirements` — and one test renders the prompt.
 */
import { describe, expect, it } from 'vitest';

import { parseRunInput, MAX_DECK_PAGES } from '@/lib/server/generation/run/input';
import { runRequirements } from '@/lib/server/generation/run/engine';
import { buildDeckDesignBlock } from '@/lib/server/generation/steps/deck-design-contract';
import type { DeckDesign } from '@/lib/types/generation';

const BASE = {
  requirement: '讲一门 SQL 注入课',
  interactive: false,
  taskEngine: false,
  agents: { mode: 'auto' as const },
  outlineReview: 'auto' as const,
};

const PLAN: DeckDesign = {
  estPages: 2,
  pages: [
    {
      order: 1,
      title: '问题场景',
      goal: '建立问题场景',
      coreInfo: '一个登录请求被绕过',
      mode: 'case',
    },
    {
      order: 2,
      title: '注入原理',
      goal: '解释注入为何成立',
      coreInfo: '参数值被直接拼进查询',
      mode: 'compare',
    },
  ],
};

/** Parse a body the way `POST /api/generation-runs` does. */
function start(body: Record<string, unknown>) {
  const parsed = parseRunInput({ ...BASE, ...body });
  if (!parsed.ok) throw new Error(`refused: ${parsed.message}`);
  return parsed.value;
}

describe('carrying a page plan into a run', () => {
  it('carries a plan from the start body to the requirements the outline reads', () => {
    const input = start({ deckDesign: PLAN });
    // The step reads `UserRequirements`, not the run input, so the two are
    // joined here: a plan that reaches one but not the other is still a broken
    // contract, and this is the only place both halves are visible together.
    const requirements = runRequirements(input, false);

    expect(requirements.deckDesign?.pages).toHaveLength(2);
    expect(requirements.deckDesign?.pages[1]?.goal).toBe('解释注入为何成立');
    // And the plan renders into instructions from what the step was handed.
    expect(buildDeckDesignBlock(requirements.deckDesign)).toContain('Page 2: 注入原理');
  });

  it('leaves an ad-hoc run byte-identical', () => {
    const requirements = runRequirements(start({}), false);
    expect(requirements.deckDesign).toBeUndefined();
    expect(requirements.requirement).toBe('讲一门 SQL 注入课');
    // The renderer returning null is what keeps the shared prompt template's
    // bytes unchanged for every run that has no plan.
    expect(buildDeckDesignBlock(requirements.deckDesign)).toBeNull();
  });

  it('carries the design ids so a stage can be traced to an outcome', () => {
    const requirements = runRequirements(
      start({ curriculumTaskId: 'task-1', curriculumUnitId: 'unit-7' }),
      false,
    );
    expect(requirements.curriculumTaskId).toBe('task-1');
    expect(requirements.curriculumUnitId).toBe('unit-7');
  });

  it('omits absent ids rather than storing blanks', () => {
    const requirements = runRequirements(start({}), false);
    expect('curriculumTaskId' in requirements).toBe(false);
    expect('curriculumUnitId' in requirements).toBe(false);
  });

  it('defaults a page order to its position, so an unnumbered plan still teaches in sequence', () => {
    const requirements = runRequirements(
      start({
        deckDesign: {
          pages: [
            { order: undefined, title: 'A', goal: 'g', coreInfo: 'c', mode: 'explain' },
            { order: undefined, title: 'B', goal: 'g', coreInfo: 'c', mode: 'explain' },
          ] as unknown as DeckDesign['pages'],
        },
      }),
      false,
    );
    expect(requirements.deckDesign?.pages.map((p) => p.order)).toEqual([1, 2]);
  });
});

describe('refusing a plan that would produce a plausible-looking deck', () => {
  const refuse = (body: Record<string, unknown>) => parseRunInput({ ...BASE, ...body });

  it('refuses a page with no goal rather than passing a title through', () => {
    // The core failure this contract exists to prevent. A plan whose page is a
    // heading must not reach a generator that would invent content for it.
    const parsed = refuse({
      deckDesign: { pages: [{ order: 1, title: '什么是 SQL 注入', coreInfo: 'c', mode: 'case' }] },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('goal');
  });

  it('refuses an empty goal and a blank one identically to a missing one', () => {
    for (const goal of ['', '   ']) {
      const parsed = refuse({
        deckDesign: { pages: [{ order: 1, title: 'T', goal, coreInfo: 'c', mode: 'case' }] },
      });
      expect(parsed.ok).toBe(false);
    }
  });

  it('refuses a mode outside the contract, which a title could not express', () => {
    const parsed = refuse({
      deckDesign: { pages: [{ order: 1, title: 'T', goal: 'g', coreInfo: 'c', mode: 'lecture' }] },
    });
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain('mode');
  });

  it('refuses an empty plan and a non-object plan', () => {
    expect(refuse({ deckDesign: { pages: [] } }).ok).toBe(false);
    expect(refuse({ deckDesign: 'two pages please' }).ok).toBe(false);
    expect(refuse({ deckDesign: { pages: [{ order: 1 }] } }).ok).toBe(false);
  });

  it('refuses a plan past the page cap, which the start body could not hold anyway', () => {
    const pages = Array.from({ length: MAX_DECK_PAGES + 1 }, (_, index) => ({
      order: index + 1,
      title: `P${index + 1}`,
      goal: 'g',
      coreInfo: 'c',
      mode: 'explain',
    }));
    expect(refuse({ deckDesign: { pages } }).ok).toBe(false);
    // One page under the cap is accepted, so the bound is a bound and not a
    // refusal of the shape itself.
    expect(refuse({ deckDesign: { pages: pages.slice(0, MAX_DECK_PAGES) } }).ok).toBe(true);
  });

  it('refuses a page whose text is too long to be one page', () => {
    const parsed = refuse({
      deckDesign: {
        pages: [{ order: 1, title: 'T', goal: 'g'.repeat(5_000), coreInfo: 'c', mode: 'explain' }],
      },
    });
    expect(parsed.ok).toBe(false);
  });

  it('drops a non-string emphasis entry instead of carrying it into a prompt', () => {
    const requirements = runRequirements(
      start({
        deckDesign: {
          pages: [
            {
              order: 1,
              title: 'T',
              goal: 'g',
              coreInfo: 'c',
              mode: 'explain',
              emphasis: ['重点一', 42, '  ', '重点二'],
            },
          ],
        },
      }),
      false,
    );
    // An emphasis list is rendered by joining with '; ', so a number in it
    // would reach the model as bare text it could not act on.
    expect(requirements.deckDesign?.pages[0]?.emphasis).toEqual(['重点一', '重点二']);
  });
});
