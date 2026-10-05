// @vitest-environment jsdom
/**
 * The scene-type filter offers only the types the current mode can actually
 * build. An interactive-first outline is made of slides and widgets, so a quiz
 * or a PBL is shown as unavailable there instead of as a choice that would be
 * silently dropped later.
 */
import { createElement, Fragment, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import i18next, { type i18n as I18n } from 'i18next';

import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

const i18nState = vi.hoisted(() => ({ locale: 'en-US' as 'en-US' | 'zh-CN' }));
let i18n: I18n;

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      i18n.getFixedT(i18nState.locale)(key, options ?? {}),
    locale: i18nState.locale,
  }),
}));

// Render the popover's content inline so every type is reachable without
// driving Radix's open state.
vi.mock('@/components/ui/popover', () => {
  const Passthrough = ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children);
  return { Popover: Passthrough, PopoverTrigger: Passthrough, PopoverContent: Passthrough };
});

import { SceneTypeFilter } from '@/components/generation/scene-type-filter';
import { ALL_SCENE_TYPES, type SceneType } from '@/lib/types/generation';

function render(props: {
  value?: SceneType[];
  availableTypes?: SceneType[];
}): string {
  return renderToStaticMarkup(
    createElement(SceneTypeFilter, {
      value: props.value ?? [...ALL_SCENE_TYPES],
      onChange: () => {},
      ...(props.availableTypes ? { availableTypes: props.availableTypes } : {}),
    }),
  );
}

/** How many of the rendered checkboxes are locked. */
function lockedCount(html: string): number {
  return (html.match(/<button[^>]*role="checkbox"[^>]*\sdisabled=""/g) ?? []).length;
}

describe('scene-type filter', () => {
  beforeAll(async () => {
    await i18next.init({
      lng: 'en-US',
      fallbackLng: 'en-US',
      resources: {
        'en-US': { translation: enUS },
        'zh-CN': { translation: zhCN },
      },
    });
    i18n = i18next as unknown as I18n;
  });

  it('offers every type by default', () => {
    const html = render({});
    for (const label of ['Slide', 'Quiz', 'Interactive', 'PBL']) {
      expect(html).toContain(label);
    }
    expect(html).not.toContain('Not produced in this mode');
    expect(lockedCount(html)).toBe(0);
  });

  it('marks a quiz and a PBL unavailable in an interactive-first outline', () => {
    const html = render({ availableTypes: ['slide', 'interactive'] });

    // Marked, not removed: the learner still sees the full set.
    expect(html).toContain('Quiz');
    expect(html).toContain('PBL');
    expect(html).toContain('Not produced in this mode');
    // The two unavailable types are locked; the available two are not.
    expect(lockedCount(html)).toBe(2);
  });

  it('keeps the last checked type checked so the outline is never empty', () => {
    // The only checked type is locked; unchecking it would leave no scene.
    expect(lockedCount(render({ value: ['quiz'] }))).toBe(1);
  });

  it('locks an unavailable type even when it is the only one checked', () => {
    // quiz is the only checked type, so it is locked twice over: unavailable
    // in this mode, and the last one standing. pbl is locked as unavailable.
    const html = render({ value: ['quiz'], availableTypes: ['slide', 'interactive'] });
    expect(lockedCount(html)).toBe(2);
    expect(html).toContain('Not produced in this mode');
  });

  it('localizes the unavailable hint', () => {
    i18nState.locale = 'zh-CN';
    try {
      const html = render({ availableTypes: ['slide', 'interactive'] });
      expect(html).toContain('该模式下不生成此类场景');
      expect(html).toContain('不适用');
    } finally {
      i18nState.locale = 'en-US';
    }
  });
});
