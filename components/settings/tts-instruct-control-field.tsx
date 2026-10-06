'use client';

import { Label } from '@/components/ui/label';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import { AlertTriangle } from 'lucide-react';
import { supportsQwenInstructionControl } from '@/lib/audio/qwen-instruct-control';
import type { ModelCapabilities } from '@/lib/model-settings/capabilities';

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
}: {
  capabilities: ModelCapabilities;
}) {
  const { t } = useI18n();
  const enabled = useSettingsStore((state) => state.qwenTtsInstructControl);
  const setEnabled = useSettingsStore((state) => state.setQwenTtsInstructControl);

  // The model that decides whether the instruction reaches a voice.
  const modelId = capabilities.tts?.modelId;
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
          <Label htmlFor="qwen-tts-instruct-control" className="cursor-pointer text-sm">
            {t('settings.qwenInstructControl')}
          </Label>
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
