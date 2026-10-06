import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US', setLocale: () => {} }),
}));

// Rendered through `renderToStaticMarkup`, where a store hook resolves its
// server snapshot — the store's initial state, which `setState` cannot reach.
// Mock the hook so each case can state the switch it is about.
const store = vi.hoisted(() => ({ qwenTtsInstructControl: false, qwenTtsInstructText: '' }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: (
    selector: (state: { qwenTtsInstructControl: boolean; qwenTtsInstructText: string }) => unknown,
  ) => selector(store),
}));

import {
  QwenInstructControlField,
  QwenInstructHelpContent,
} from '@/components/settings/tts-instruct-control-field';
import {
  DEFAULT_QWEN_INSTRUCTIONS,
  QWEN_INSTRUCT_MAX_CHARS,
} from '@/lib/audio/qwen-instruct-control';
import type { EffectiveTarget, ModelCapabilities } from '@/lib/model-settings/capabilities';
import type { SlotId } from '@/lib/config/model-slots';
import enUS from '@/lib/i18n/locales/en-US.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';

/** Capabilities with nothing assigned, and the one `tts` slot named. */
function capabilities(ttsModelId?: string): ModelCapabilities {
  return {
    known: true,
    llm: null,
    asr: null,
    image: null,
    video: null,
    webSearch: null,
    document: null,
    resolved: new Set<SlotId>(),
    tts: ttsModelId
      ? ({
          registryId: 'qwen-tts',
          providerId: 'qwen-tts',
          providerSource: 'workspace',
          presetId: 'qwen-tts',
          modelId: ttsModelId,
        } satisfies EffectiveTarget)
      : null,
  };
}

function renderField(props: Partial<ComponentProps<typeof QwenInstructControlField>> = {}) {
  return renderToStaticMarkup(
    createElement(QwenInstructControlField, { capabilities: capabilities(), ...props }),
  );
}

const helpKeys = (locale: typeof enUS) =>
  Object.keys(locale.settings).filter((key) => key.startsWith('qwenInstructHelp'));

describe('QwenInstructControlField', () => {
  beforeEach(() => {
    store.qwenTtsInstructControl = true;
    store.qwenTtsInstructText = '';
  });

  it('offers a help trigger next to the switch label', () => {
    const html = renderField();

    expect(html).toContain('settings.qwenInstructHelpLabel');
    // A real button, so it is reachable by keyboard and announced by a screen
    // reader rather than being a decoration that only answers to hover.
    expect(html).toMatch(/<button[^>]*aria-label="settings\.qwenInstructHelpLabel"/);
  });

  it('warns when the model the test speaks with cannot accept the instruction', () => {
    // The panel for a service that is not the narration one: the model that
    // decides is that service's own, passed in by the panel above.
    const html = renderField({
      capabilities: capabilities('qwen3-tts-instruct-flash'),
      testModelId: 'qwen3-tts-flash',
    });

    expect(html).toContain('settings.qwenInstructModelUnsupported');
  });

  it('does not warn on a model that accepts the instruction', () => {
    expect(renderField({ testModelId: 'qwen3-tts-instruct-flash' })).not.toContain(
      'settings.qwenInstructModelUnsupported',
    );
  });

  it('falls back to the narration slot when the panel names no test model', () => {
    const html = renderField({ capabilities: capabilities('qwen3-tts-flash') });

    expect(html).toContain('settings.qwenInstructModelUnsupported');
  });

  it('stays quiet about the model while the switch is off', () => {
    // The switch is a preference, not a capability report: nagging before the
    // user has asked for the feature would be noise.
    store.qwenTtsInstructControl = false;
    const html = renderField({ testModelId: 'qwen3-tts-flash' });

    expect(html).toContain('settings.qwenInstructHelpLabel');
    expect(html).not.toContain('settings.qwenInstructModelUnsupported');
  });
});

describe('the instruction text box', () => {
  beforeEach(() => {
    store.qwenTtsInstructControl = true;
    store.qwenTtsInstructText = '';
  });

  it('sits under the switch while the switch is on', () => {
    const html = renderField({ testModelId: 'qwen3-tts-instruct-flash' });

    expect(html).toContain('settings.qwenInstructTextLabel');
    expect(html).toMatch(/<textarea[^>]*id="qwen-tts-instruct-text"/);
    // Empty means the built-in default, so the placeholder states it.
    expect(html).toContain(`placeholder="${DEFAULT_QWEN_INSTRUCTIONS}"`);
  });

  it('holds what the user wrote', () => {
    store.qwenTtsInstructText = '语速放慢。';
    const html = renderField({ testModelId: 'qwen3-tts-instruct-flash' });

    expect(html).toContain('语速放慢。');
  });

  it('is absent while the switch is off', () => {
    // An instruction nobody sends is a stray note, and it would be edited in
    // the belief that it took effect.
    store.qwenTtsInstructControl = false;
    const html = renderField({ testModelId: 'qwen3-tts-instruct-flash' });

    expect(html).not.toContain('qwen-tts-instruct-text');
  });

  it('warns when the text is past what the provider accepts', () => {
    store.qwenTtsInstructText = 'x'.repeat(QWEN_INSTRUCT_MAX_CHARS + 1);
    const html = renderField({ testModelId: 'qwen3-tts-instruct-flash' });

    expect(html).toContain('settings.qwenInstructTextTooLong');
  });

  it('does not warn about length at the cap itself', () => {
    store.qwenTtsInstructText = 'x'.repeat(QWEN_INSTRUCT_MAX_CHARS);
    const html = renderField({ testModelId: 'qwen3-tts-instruct-flash' });

    expect(html).not.toContain('settings.qwenInstructTextTooLong');
  });
});

describe('QwenInstructHelpContent', () => {
  it('shows the instruction the request actually sends', () => {
    // A paraphrase here would teach the user to expect a delivery the request
    // does not produce; the constant is the only true answer.
    expect(
      renderToStaticMarkup(
        createElement(QwenInstructHelpContent, { instructions: DEFAULT_QWEN_INSTRUCTIONS }),
      ),
    ).toContain(DEFAULT_QWEN_INSTRUCTIONS);
  });

  it('shows a custom instruction instead of the default', () => {
    const html = renderToStaticMarkup(
      createElement(QwenInstructHelpContent, { instructions: '语速放慢，句末上扬。' }),
    );

    expect(html).toContain('语速放慢，句末上扬。');
    // And says what the default would have been, so the box is not a dead end.
    expect(html).toContain('settings.qwenInstructHelpDefaultFallback');
  });

  it('says no instruction is sent when the model cannot take one', () => {
    // The card must not promise a delivery a request will not carry.
    const html = renderToStaticMarkup(createElement(QwenInstructHelpContent));

    expect(html).toContain('settings.qwenInstructHelpNoInstruction');
    expect(html).not.toContain(DEFAULT_QWEN_INSTRUCTIONS);
  });

  it('points at the test TTS and the official docs', () => {
    const html = renderToStaticMarkup(
      createElement(QwenInstructHelpContent, { instructions: DEFAULT_QWEN_INSTRUCTIONS }),
    );

    expect(html).toContain('settings.qwenInstructHelpTest');
    expect(html).toContain('https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide');
  });

  it('translates the help into Chinese rather than repeating the English', () => {
    const english = enUS.settings as unknown as Record<string, string>;
    const chinese = zhCN.settings as unknown as Record<string, string>;

    expect(helpKeys(zhCN).length).toBe(helpKeys(enUS).length);
    for (const key of helpKeys(enUS)) {
      expect(chinese[key], `${key} is empty`).toBeTruthy();
      expect(chinese[key], `${key} is still English`).not.toBe(english[key]);
    }
  });
});
