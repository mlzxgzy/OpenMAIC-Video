'use client';

import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { AlertTriangle, CircleHelp } from 'lucide-react';
import {
  DEFAULT_QWEN_INSTRUCTIONS,
  supportsQwenInstructionControl,
} from '@/lib/audio/qwen-instruct-control';
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';

/**
 * The body of the question mark's hover card: what instruction control does,
 * which model it needs, and how to hear it on the test TTS below.
 *
 * The instruction shown is the one this build actually sends
 * ({@link DEFAULT_QWEN_INSTRUCTIONS}) rather than a paraphrase, so the card
 * cannot drift from the request; the test speaks with it only when the service's
 * model accepts the parameter, which the switch's own warning says out loud.
 *
 * Rendered on its own so the copy can be asserted without opening a portal.
 */
export function QwenInstructHelpContent() {
  const { t } = useI18n();
  return (
    <div className="space-y-2.5 text-xs leading-relaxed">
      <p className="text-sm font-semibold text-foreground">{t('settings.qwenInstructHelpTitle')}</p>
      <p>{t('settings.qwenInstructHelpWhat')}</p>
      <div className="space-y-1">
        <p className="font-medium text-foreground">{t('settings.qwenInstructHelpHowTitle')}</p>
        <p>{t('settings.qwenInstructHelpHow')}</p>
      </div>
      <div className="space-y-1">
        <p className="font-medium text-foreground">
          {t('settings.qwenInstructHelpInstructionTitle')}
        </p>
        {/* The exact string the request carries, so what the user reads here is
            what the test TTS will speak with. */}
        <p className="rounded-md border border-border/60 bg-muted/40 px-2 py-1.5 font-mono text-[11px] leading-relaxed">
          {DEFAULT_QWEN_INSTRUCTIONS}
        </p>
      </div>
      <p className="text-muted-foreground">{t('settings.qwenInstructHelpTest')}</p>
      <p className="text-muted-foreground">{t('settings.qwenInstructHelpScript')}</p>
      <a
        href="https://help.aliyun.com/zh/model-studio/non-realtime-tts-user-guide"
        target="_blank"
        rel="noreferrer"
        className="inline-block text-primary underline underline-offset-2 hover:no-underline"
      >
        {t('settings.qwenInstructHelpDocs')}
      </a>
    </div>
  );
}

/**
 * The question mark beside the switch. A hover card rather than a tooltip: the
 * explanation is several paragraphs with an example and a link, which a
 * transient tooltip would cut off and which the user needs time to read.
 */
function InstructControlHelp() {
  const { t } = useI18n();
  return (
    <HoverCard openDelay={200} closeDelay={80}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          aria-label={t('settings.qwenInstructHelpLabel')}
          className="inline-flex size-4 shrink-0 items-center justify-center rounded-full text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
        >
          <CircleHelp className="size-4" aria-hidden="true" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="start" side="top" className="w-80">
        <QwenInstructHelpContent />
      </HoverCardContent>
    </HoverCard>
  );
}

/**
 * The Qwen instruction-control switch, shown on the Qwen TTS panel.
 *
 * The feature is model-gated, and the panel is also opened for a service that is
 * not (yet) the workspace's narration. The switch therefore renders as a plain
 * preference — it is never disabled — and the model that will speak decides
 * whether it takes effect; when it will not, the hint says so instead of the
 * switch silently doing nothing.
 */
export function QwenInstructControlField({
  capabilities,
  testModelId,
}: {
  capabilities: ModelCapabilities;
  /**
   * The model the panel's test TTS will speak with, which is not always the
   * narration slot's: the panel also opens for a service that is not in use,
   * and there the service's own saved model applies.
   */
  testModelId?: string;
}) {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.qwenTtsInstructControl);
  const setEnabled = useSettingsStore((state) => state.setQwenTtsInstructControl);

  // The model that decides whether the instruction reaches a voice: the one the
  // test speaks with, so the warning appears exactly when the test will not
  // honour the switch either.
  const modelId = testModelId ?? capabilities.tts?.modelId;
  const supported = supportsQwenInstructionControl(modelId);

  return (
    <div className="space-y-3">
      <Label className="text-sm text-muted-foreground">{t('settings.qwenInstructTitle')}</Label>
      <div className="flex items-start space-x-3">
        <Checkbox
          id="qwen-tts-instruct-control"
          checked={enabled}
          onCheckedChange={(value) => setEnabled(value === true)}
          className="mt-0.5"
        />
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <Label htmlFor="qwen-tts-instruct-control" className="cursor-pointer text-sm">
              {t('settings.qwenInstructControl')}
            </Label>
            <InstructControlHelp />
          </div>
          <p className="text-xs text-muted-foreground">{t('settings.qwenInstructControlHint')}</p>
          {enabled && !supported && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
              <span>{t('settings.qwenInstructModelUnsupported', { model: modelId ?? '' })}</span>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
