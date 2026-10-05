'use client';

import { Check, ChevronDown } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Checkbox } from '@/components/ui/checkbox';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ALL_SCENE_TYPES, type SceneType } from '@/lib/types/generation';
import { cn } from '@/lib/utils';

/** The localized name of each scene type the outline can be made of. */
const SCENE_TYPE_LABEL_KEYS: Record<SceneType, string> = {
  slide: 'generation.sceneTypeSlide',
  quiz: 'generation.sceneTypeQuiz',
  interactive: 'generation.sceneTypeInteractive',
  pbl: 'generation.sceneTypePbl',
};

export interface SceneTypeFilterProps {
  /** The scene types the outline may create. */
  value: readonly SceneType[];
  onChange: (next: SceneType[]) => void;
  /**
   * The types the current mode can actually produce; anything else is shown
   * disabled. Interactive-first and task-engine outlines are made of slides
   * and widgets only, so quizzes and PBL are never created in those modes.
   */
  availableTypes?: readonly SceneType[];
  /** Freeze the control while a run is starting. */
  disabled?: boolean;
  className?: string;
}

/**
 * The composer's scene-type multi-select. Defaults to every type checked; the
 * selection rides the run input, so an unchecked type is never created rather
 * than merely hidden.
 */
export function SceneTypeFilter({
  value,
  onChange,
  availableTypes = ALL_SCENE_TYPES,
  disabled = false,
  className,
}: SceneTypeFilterProps) {
  const { t } = useI18n();
  const available = new Set(availableTypes);
  const selected = new Set(value);
  const allChecked = value.length === ALL_SCENE_TYPES.length;

  const toggle = (type: SceneType, checked: boolean) => {
    const next = checked
      ? ALL_SCENE_TYPES.filter((candidate) => candidate === type || selected.has(candidate))
      : ALL_SCENE_TYPES.filter((candidate) => candidate !== type && selected.has(candidate));
    onChange([...next]);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          role="group"
          aria-label={t('toolbar.sceneTypeFilterLabel')}
          disabled={disabled}
          className={cn(
            'inline-flex h-8 shrink-0 cursor-pointer select-none items-center gap-1.5 whitespace-nowrap rounded-full border border-border/70 bg-transparent px-3 py-1.5 text-xs font-medium text-muted-foreground transition-all hover:bg-muted/60 active:scale-95 focus-visible:outline-2 focus-visible:outline-offset-2 disabled:cursor-not-allowed disabled:opacity-50 motion-reduce:transition-none motion-reduce:active:scale-100',
            !allChecked && 'border-primary/50 text-primary',
            className,
          )}
        >
          <span className="hidden sm:inline">{t('toolbar.sceneTypeFilterLabel')}</span>
          <span className="tabular-nums text-[11px] opacity-70">
            {value.length}/{ALL_SCENE_TYPES.length}
          </span>
          <ChevronDown aria-hidden="true" className="size-3 opacity-60" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" side="top" className="w-52 p-2">
        <div className="flex flex-col gap-0.5">
          {ALL_SCENE_TYPES.map((type) => {
            const checked = selected.has(type);
            // A type the current mode never produces: shown, but not a choice.
            const unavailable = !available.has(type);
            // The last checked type stays checked: an empty selection would
            // leave the outline with no scene to generate.
            const isLast = checked && value.length === 1;
            const locked = unavailable || isLast;
            return (
              <label
                key={type}
                title={unavailable ? t('toolbar.sceneTypeUnavailableHint') : undefined}
                className={cn(
                  'flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors',
                  locked ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-accent',
                )}
              >
                <Checkbox
                  checked={checked}
                  disabled={locked}
                  onCheckedChange={(next) => toggle(type, next === true)}
                  aria-label={t(SCENE_TYPE_LABEL_KEYS[type])}
                  className="size-4"
                />
                <span className="flex-1">{t(SCENE_TYPE_LABEL_KEYS[type])}</span>
                {unavailable ? (
                  <span className="text-[10px] text-muted-foreground/70">
                    {t('toolbar.sceneTypeUnavailableTag')}
                  </span>
                ) : checked ? (
                  <Check aria-hidden="true" className="size-3.5 opacity-50" />
                ) : null}
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}