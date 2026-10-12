/**
 * What a designed item becomes when it is produced.
 *
 * The defect this module replaces was one line of code: the assembler forced
 * `sceneTypes: ['slide']` on every course, so a practice item produced slides
 * and an exam item produced slides. These tests pin the mapping that makes
 * `unit_role` mean something to the generator, and they pin the two properties
 * that mapping is easy to get half-right.
 */
import { describe, expect, it } from 'vitest';

import {
  UNIT_ROLE_SCENE_TYPES,
  deckDesignForGeneration,
  deckDesignForRole,
  describeDesignedItem,
  unitRoleRunModes,
  unitRoleSceneTypes,
} from '@/lib/server/curriculum/unit-role-run';
import { CURRICULUM_UNIT_ROLES } from '@/lib/curriculum/design-types';

const PLAN = {
  estPages: 1,
  pages: [
    {
      order: 1,
      title: 'SQL 注入是什么',
      goal: '能说出注入为何成立',
      coreInfo: '值被拼进查询',
      mode: 'explain' as const,
    },
  ],
};

describe('a role decides what the outline may build', () => {
  it('gives every role a non-empty, distinct set of scene types', () => {
    // Distinct matters as much as non-empty: a mapping where all three roles
    // resolve to the same list is the old defect wearing a new signature.
    const seen = new Set<string>();
    for (const role of CURRICULUM_UNIT_ROLES) {
      const types = unitRoleSceneTypes(role);
      expect(types.length).toBeGreaterThan(0);
      seen.add(types.join(','));
    }
    expect(seen.size).toBe(CURRICULUM_UNIT_ROLES.length);
  });

  it('teaches a lecture with slides alone', () => {
    expect(unitRoleSceneTypes('lecture')).toEqual(['slide']);
  });

  it('gives a practice item a quiz and an interactive surface, not just slides', () => {
    // The interactive scene is where the learner performs the task. Without it
    // a "practice" item is a lecture with a quiz bolted on.
    expect(unitRoleSceneTypes('practice')).toEqual(['slide', 'quiz', 'interactive']);
  });

  it('keeps an interactive scene out of an exam item', () => {
    // A free-form procedural widget in an exam is a surface where the learner
    // can succeed without demonstrating the outcome the item assesses.
    expect(unitRoleSceneTypes('exam')).not.toContain('interactive');
    expect(unitRoleSceneTypes('exam')).toContain('quiz');
  });

  it('never offers a pbl scene, for any role', () => {
    // A project-based scene is a different kind of course. Allowing it lets a
    // model substitute a project for a graded lab.
    for (const role of CURRICULUM_UNIT_ROLES) {
      expect(UNIT_ROLE_SCENE_TYPES[role]).not.toContain('pbl');
    }
  });

  it('returns a fresh array, so a caller cannot mutate the mapping', () => {
    const first = unitRoleSceneTypes('lecture');
    first.push('quiz');
    expect(unitRoleSceneTypes('lecture')).toEqual(['slide']);
  });
});

describe('a role decides whether hints survive', () => {
  it('offers no interactive surface or task engine to a lecture', () => {
    expect(unitRoleRunModes('lecture')).toEqual({ interactive: false, taskEngine: false });
  });

  it('turns the task engine on for practice, because procedural skills need it', () => {
    // The outline step gates procedural-skill behind taskEngineMode and
    // downgrades it to a plain diagram when it is off. A practice item that
    // asked for `interactive` without this flag would get a flowchart where
    // the drill was supposed to be: the scene type honoured, the intent gone.
    expect(unitRoleRunModes('practice')).toEqual({ interactive: true, taskEngine: true });
  });

  it('offers interactive but never the task engine for an exam', () => {
    // The exam is graded independently. The procedural-drill path builds
    // guided, hintable experiences — wrong for an item that must certify.
    expect(unitRoleRunModes('exam')).toEqual({ interactive: true, taskEngine: false });
  });

  it('keeps the scene list and the mode flags in step for every role', () => {
    for (const role of CURRICULUM_UNIT_ROLES) {
      const types = unitRoleSceneTypes(role);
      const modes = unitRoleRunModes(role);
      if (types.includes('interactive')) {
        expect(modes.interactive).toBe(true);
      }
      // The reverse must not hold: a lecture may still turn interactivity on
      // for other reasons, but nothing requires it from the role alone.
      if (!modes.taskEngine) {
        expect(role).not.toBe('practice');
      }
    }
  });
});

describe('the page plan reaches only a lecture', () => {
  it('passes a lecture plan through unchanged', () => {
    expect(deckDesignForRole('lecture', PLAN)).toEqual(PLAN);
  });

  it('drops it for a practice or exam item', () => {
    // A page plan is the shape of slides. Handing one to a practice item has
    // the outline build a lecture and call it a drill.
    expect(deckDesignForRole('practice', PLAN)).toBeUndefined();
    expect(deckDesignForRole('exam', PLAN)).toBeUndefined();
  });

  it('reads an empty plan as absent rather than as an authoritative structure', () => {
    // Not an error: course design may not have run, and refusing to start would
    // make the export gate unreachable in exactly the case it exists for.
    expect(deckDesignForRole('lecture', { pages: [] })).toBeUndefined();
    expect(deckDesignForRole('lecture', {})).toBeUndefined();
    expect(deckDesignForRole('lecture', null)).toBeUndefined();
    expect(deckDesignForRole('lecture', 'two pages')).toBeUndefined();
  });
});

describe('the page plan reaches the generator with names, not ids', () => {
  const nodeNames = new Map([
    ['node-sql', 'SQL 查询与参数化'],
    ['node-union', '联合查询读数据'],
  ]);
  const withTeaches = {
    ...PLAN,
    pages: [{ ...PLAN.pages[0]!, teaches: ['node-sql', '联合查询读数据'] }],
  };

  it('translates stored ids into the names the generator can read', () => {
    // The design stores ids, because that is the only addressing its own audit can
    // compare against the teaching script. The generator has never seen a
    // `node_…` id, and the prompt prints whatever it is handed.
    const plan = deckDesignForGeneration('lecture', withTeaches, nodeNames);
    expect(plan?.pages?.[0]?.teaches).toEqual(['SQL 查询与参数化', '联合查询读数据']);
  });

  it('drops a knowledge point that resolves to no node', () => {
    const plan = deckDesignForGeneration(
      'lecture',
      { ...PLAN, pages: [{ ...PLAN.pages[0]!, teaches: ['node-ghost'] }] },
      nodeNames,
    );
    expect(plan?.pages?.[0]?.teaches).toEqual([]);
  });

  it('leaves a plan with no named knowledge points exactly as it was', () => {
    expect(deckDesignForGeneration('lecture', PLAN, nodeNames)).toEqual(PLAN);
  });

  it('still refuses a plan for a non-lecture item', () => {
    expect(deckDesignForGeneration('practice', withTeaches, nodeNames)).toBeUndefined();
  });
});

describe('the requirement is built from the outcomes the item serves', () => {
  it('carries the outcome behaviors, not the item title alone', () => {
    const text = describeDesignedItem({
      title: '1.2 SQL 注入练习',
      role: 'practice',
      outcomes: ['在靶场中构造 payload 读取 flag'],
    });
    expect(text).toContain('在靶场中构造 payload 读取 flag');
    // The stage is named after this text, so a title-only requirement would put
    // "1.2 SQL 注入练习" on the course card and teach nothing about the promise.
    expect(text).toContain('1.2 SQL 注入练习');
  });

  it('says so when no outcome is bound, instead of passing an empty list as fine', () => {
    const text = describeDesignedItem({ title: '1.3 复习', role: 'lecture', outcomes: [] });
    expect(text).toMatch(/No learning outcome is bound/i);
  });

  it('tells an exam item not to show the answer, and a lecture not to quiz', () => {
    expect(describeDesignedItem({ title: 'e', role: 'exam', outcomes: ['x'] })).toMatch(
      /No hints, no worked solutions/i,
    );
    expect(describeDesignedItem({ title: 'l', role: 'lecture', outcomes: ['x'] })).toMatch(
      /do not add a quiz/i,
    );
  });

  it('tells a practice item it may retry and may offer hints', () => {
    // The two modes that make a drill a drill. A model told only "this is
    // practice" will still grade the learner and lock them out of a retry.
    expect(describeDesignedItem({ title: 'p', role: 'practice', outcomes: ['x'] })).toMatch(
      /hints are available/i,
    );
    expect(describeDesignedItem({ title: 'p', role: 'practice', outcomes: ['x'] })).toMatch(
      /retry/i,
    );
  });

  it('warns when the plan it is handing over is empty', () => {
    const text = describeDesignedItem({
      title: '1.1 原理',
      role: 'lecture',
      outcomes: ['x'],
      plannedPages: 0,
    });
    expect(text).toMatch(/page plan is empty/i);
  });
});
