'use client';

/**
 * NarrationVoicePanel — the independent place to re-voice a course.
 *
 * The Pro-mode timeline has always had per-line and "Voice all" controls, but
 * they live inside the editor: a teacher who only wants to hear a wording
 * change has to enter Pro mode, find the clip, and click a 12px icon. This is
 * the same power at the surface where the teacher already is — the classroom
 * header — with the two things the tiny icons could never show:
 *
 *   1. WHICH voice and pace the regeneration will use, read from the same
 *      resolvers the synthesis itself uses (`lib/audio/narration-voice-summary.ts`
 *      mirrors `generateAndStoreTTS`), so "same voice as before" is a fact the
 *      user can see rather than a promise. This matters because regenerating
 *      with a changed setting would silently re-voice the whole course in
 *      another timbre, and the only symptom would be that it no longer sounds
 *      like the teacher.
 *   2. WHICH lines are voiced, so a partial course is obvious before paying to
 *      finish it.
 *
 * It regenerates by calling `regenerateSpeechAudio` — the exact function the
 * Pro-mode bar calls — so there is one synthesis path and therefore no way for
 * the two surfaces to disagree about voice, pace, or what a fresh clip costs.
 *
 * Nothing here decides authorization: the trigger is withheld unless
 * `mayGenerate` (the stage-meta ownership gate) and `regenerateSpeechAudio`
 * refuses for a course this browser may not generate for, so the control and
 * the action answer the same question.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AlertCircle, Loader2, RefreshCw, Volume2 } from 'lucide-react';
import { toast } from 'sonner';

import { flushStageSave, useStageStore } from '@/lib/store/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { cn } from '@/lib/utils';
import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import { useModelCapabilities } from '@/lib/model-settings/use-model-settings';
import {
  narrationVoiceSummary,
  type NarrationVoiceSummary,
} from '@/lib/audio/narration-voice-summary';
import { useNarrationLines, type NarrationLine } from '@/lib/audio/use-narration-lines';
import { audioExistsBulk, regenerateSpeechAudio } from '@/lib/audio/regenerate-speech-tts';
import { setAudioIdById } from '@/components/edit/ActionsBar/actions-edit';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

/** Lines being re-voiced right now, for the per-row spinner. */
const NO_LINES: ReadonlySet<string> = new Set();

type Scope = 'page' | 'course';

export function NarrationVoicePanel({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useI18n();
  const stageId = useStageStore((s) => s.stage?.id);
  const currentSceneId = useStageStore((s) => s.currentSceneId);
  const language = useStageStore((s) => s.stage?.languageDirective);
  const mayGenerate = useMayGenerateForStage(stageId);

  // Managed (server) TTS is what regeneration means here; browser-native speech
  // has no per-line asset and is synthesized by the playback engine instead, so
  // there is nothing for this panel to spend. Same predicate the Pro-mode
  // timeline uses to decide whether to show its own controls.
  const ttsTarget = useModelCapabilities().tts;
  const ttsActive = !!ttsTarget && ttsTarget.registryId !== 'browser-native-tts';

  const [scope, setScope] = useState<Scope>('page');
  const [summary, setSummary] = useState<NarrationVoiceSummary | null>(null);
  const [summaryLoaded, setSummaryLoaded] = useState(false);
  const [busyLines, setBusyLines] = useState<ReadonlySet<string>>(NO_LINES);
  const [running, setRunning] = useState(false);
  // Bumped after a batch (and after a single regeneration) so every row
  // re-reads whether its audio actually resolved. The Pro-mode bar reaches the
  // same state through its own per-row `audioExists` probe; this is the
  // panel-wide equivalent, and it is why a regeneration is not reported as
  // voiced until the stored blob is actually there.
  const [refreshKey, setRefreshKey] = useState(0);
  const [voiced, setVoiced] = useState<ReadonlySet<string>>(NO_LINES);

  const pageLines = useNarrationLines(currentSceneId);
  const courseLines = useNarrationLines(null);
  const lines = scope === 'page' ? pageLines : courseLines;

  // Which lines actually have audio. Re-probed whenever the lines themselves
  // change or a regeneration finishes, never on a timer.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    (async () => {
      // A pool id is a bare `ast_*`; an unconverted pair's `audioId` is a
      // relative media path. Probing the latter as a pool id is a guaranteed
      // miss, so it is routed to the URL branch instead of asked about.
      const byPoolId = lines.filter(
        (line) => !!line.audioId && !line.audioId.startsWith('http') && !line.audioId.includes('/'),
      );
      // Narration that exists only as a legacy URL: no id to look up, and
      // there is nothing to prove — the URL IS the audio.
      const byUrl = lines
        .filter((line) => !line.audioId && !!line.audioUrl)
        .map((line) => line.actionId);
      const ids = byPoolId.map((line) => line.audioId as string);
      if (ids.length === 0) {
        if (alive) setVoiced(new Set(byUrl));
        return;
      }
      try {
        const present = await audioExistsBulk(ids);
        if (!alive) return;
        const presentIds = new Set(present);
        setVoiced(
          new Set([
            ...byUrl,
            ...byPoolId
              .filter((line) => presentIds.has(line.audioId as string))
              .map((l) => l.actionId),
          ]),
        );
      } catch {
        // A failed probe leaves the previous reading rather than claiming
        // everything is unvoiced, which would invite a re-pay for clips that
        // are in fact fine.
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, lines, refreshKey]);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    narrationVoiceSummary()
      .then((next) => {
        if (alive) setSummary(next);
      })
      .catch(() => {
        if (alive) setSummary(null);
      })
      .finally(() => {
        if (alive) setSummaryLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [open]);

  const commitAudioId = useCallback((sceneId: string, actionId: string, audioId: string) => {
    const store = useStageStore.getState();
    const scene = store.scenes.find((candidate) => candidate.id === sceneId);
    if (!scene) return;
    store.updateScene(sceneId, { actions: setAudioIdById(scene.actions ?? [], actionId, audioId) });
    // Persistence is debounced; the stamped reference must be durable once the
    // bytes are stored (bytes land first, the stamp second), so the line does
    // not come back unvoiced after a reload.
    void flushStageSave().catch(() => undefined);
  }, []);

  /**
   * Re-voice one line. Returns whether it succeeded, so a batch can count
   * without inferring from state.
   *
   * Reads the live action at the moment of the call rather than closing over a
   * snapshot: the user may have edited the text or reordered the deck since the
   * panel listed it, and synthesizing the text the user just changed is the
   * only correct answer.
   */
  const regenerateOne = useCallback(
    async (line: NarrationLine): Promise<boolean> => {
      const store = useStageStore.getState();
      const scene = store.scenes.find((candidate) => candidate.id === line.sceneId);
      const action = scene?.actions?.find((candidate) => candidate.id === line.actionId);
      if (!scene || !action || action.type !== 'speech') return false;
      const text = (action as { text?: string }).text ?? '';
      if (!text.trim()) return false;

      const audioId = await regenerateSpeechAudio(
        scene.order,
        {
          id: line.actionId,
          text,
          ...((action as { audioId?: string }).audioId
            ? { audioId: (action as { audioId?: string }).audioId }
            : {}),
        },
        language,
      );
      if (!audioId) return false;
      commitAudioId(line.sceneId, line.actionId, audioId);
      return true;
    },
    [commitAudioId, language],
  );

  const regenerateLine = useCallback(
    async (line: NarrationLine) => {
      if (running) return;
      setBusyLines((current) => new Set(current).add(line.actionId));
      try {
        const ok = await regenerateOne(line);
        if (ok) {
          toast.success(t('edit.narration.lineDone'));
        } else {
          toast.error(t('edit.narration.lineFailed'));
        }
        setRefreshKey((n) => n + 1);
      } catch (error) {
        // The refusal detail (a missing clone, a provider error) is already
        // reported by the synthesis path itself; this is the summary the user
        // acts on.
        console.error('[Narration] regeneration failed', error);
        toast.error(t('edit.narration.lineFailed'));
      } finally {
        setBusyLines((current) => {
          const next = new Set(current);
          next.delete(line.actionId);
          return next;
        });
      }
    },
    [regenerateOne, running, t],
  );

  const regenerateScope = useCallback(async () => {
    if (running) return;
    // An empty line has nothing to speak; attempting it would be a paid no-op.
    const queued = lines.filter((line) => line.text.trim());
    if (queued.length === 0) return;

    setRunning(true);
    setBusyLines(new Set(queued.map((line) => line.actionId)));
    let done = 0;
    let failed = 0;
    try {
      // Sequential, not parallel: these bill the operator's TTS provider, and a
      // deck of forty clips arriving at once is a burst of rate-limit refusals
      // the user then pays for again on retry.
      for (const line of queued) {
        try {
          if (await regenerateOne(line)) done += 1;
          else failed += 1;
        } catch {
          // One line's failure must not abandon the rest — the same rule the
          // Pro-mode "Voice all" follows.
          failed += 1;
        }
        setBusyLines((current) => {
          const next = new Set(current);
          next.delete(line.actionId);
          return next;
        });
      }
      if (failed === 0) {
        toast.success(t('edit.narration.done', { count: done }));
      } else {
        toast.warning(t('edit.narration.partial', { done, failed }));
      }
    } finally {
      setRunning(false);
      setBusyLines(NO_LINES);
      setRefreshKey((n) => n + 1);
    }
  }, [lines, regenerateOne, running, t]);

  const stats = useMemo(() => {
    const speakable = lines.filter((line) => line.text.trim());
    const voicedCount = speakable.filter((line) => voiced.has(line.actionId)).length;
    return {
      total: speakable.length,
      voiced: voicedCount,
      unvoiced: speakable.length - voicedCount,
    };
  }, [lines, voiced]);

  if (!ttsActive || !mayGenerate) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl gap-0 overflow-hidden p-0">
        <DialogHeader className="space-y-1 px-5 pt-5">
          <DialogTitle className="flex items-center gap-2 text-base">
            <Volume2 className="size-4 text-primary" />
            {t('edit.narration.title')}
          </DialogTitle>
          <DialogDescription>{t('edit.narration.description')}</DialogDescription>
        </DialogHeader>

        {/* The voice and pace the regeneration will use. Read from the same
            resolvers the synthesis uses, so this is a readout of the request
            that is about to be made — not a restatement of a setting. */}
        <div className="mx-5 mt-3 rounded-lg border border-border/70 bg-muted/30 px-3 py-2.5">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px]">
            <span className="text-muted-foreground">{t('edit.narration.voice')}</span>
            <span className="font-medium" data-testid="narration-voice-name">
              {summary?.voiceName ?? (summaryLoaded ? t('chat.unknown') : '…')}
            </span>
            <span className="text-muted-foreground">{t('edit.narration.speed')}</span>
            <span className="font-medium tabular-nums" data-testid="narration-voice-speed">
              {summary ? `${summary.speed.toFixed(2)}×` : '…'}
            </span>
          </div>
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/80">
            {t('edit.narration.voiceConsistentHint')}
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2 px-5">
          <div className="flex rounded-full border border-border p-0.5">
            {(['page', 'course'] as const).map((value) => (
              <button
                key={value}
                type="button"
                onClick={() => setScope(value)}
                disabled={running}
                className={cn(
                  'rounded-full px-3 py-0.5 text-[11.5px] transition-colors',
                  scope === value
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {value === 'page' ? t('edit.narration.scopePage') : t('edit.narration.scopeCourse')}
              </button>
            ))}
          </div>
          <span
            className="ml-auto text-[11.5px] text-muted-foreground"
            data-testid="narration-stats"
          >
            {t('edit.narration.stats', {
              voiced: stats.voiced,
              total: stats.total,
              unvoiced: stats.unvoiced,
            })}
          </span>
        </div>

        <div className="mt-3 max-h-[38vh] min-h-0 flex-1 overflow-y-auto border-y border-border/60 px-5">
          {lines.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-muted-foreground">
              {t('edit.narration.emptyHint')}
            </p>
          ) : (
            <ul className="divide-y divide-border/50 py-1">
              {lines.map((line) => {
                const busy = busyLines.has(line.actionId);
                const isVoiced = voiced.has(line.actionId);
                const speakable = !!line.text.trim();
                return (
                  <li key={line.actionId} className="flex items-center gap-3 py-2">
                    <span className="w-8 shrink-0 font-mono text-[10.5px] tabular-nums text-muted-foreground/60">
                      {line.position}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[12px] leading-snug text-foreground/90">
                        {speakable ? line.text : t('edit.narration.emptyLine')}
                      </p>
                      {scope === 'course' && (
                        <p className="truncate text-[10.5px] text-muted-foreground/60">
                          {line.sceneTitle}
                        </p>
                      )}
                    </div>
                    <span
                      className={cn(
                        'shrink-0 text-[10.5px]',
                        isVoiced
                          ? 'text-emerald-600 dark:text-emerald-400'
                          : 'text-muted-foreground/70',
                      )}
                    >
                      {busy
                        ? t('edit.narration.statusGenerating')
                        : isVoiced
                          ? t('edit.narration.statusVoiced')
                          : t('edit.narration.statusUnvoiced')}
                    </span>
                    <button
                      type="button"
                      data-testid={`narration-regenerate-${line.actionId}`}
                      onClick={() => void regenerateLine(line)}
                      disabled={running || busy || !speakable}
                      title={t('edit.narration.regenerateOne')}
                      aria-label={t('edit.narration.regenerateOne')}
                      className="grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground/60 transition-colors hover:bg-muted hover:text-foreground disabled:opacity-30 disabled:hover:bg-transparent"
                    >
                      {busy ? (
                        <Loader2 className="size-3.5 animate-spin" />
                      ) : (
                        <RefreshCw className="size-3.5" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <DialogFooter className="flex-row items-center gap-3 px-5 py-4">
          <p className="mr-auto flex items-center gap-1.5 text-[11px] text-muted-foreground/80">
            <AlertCircle className="size-3 shrink-0" />
            {t('edit.narration.revoiceWarning')}
          </p>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            disabled={running}
            className="rounded-md px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-muted disabled:opacity-50"
          >
            {t('common.close')}
          </button>
          <button
            type="button"
            data-testid="narration-regenerate-scope"
            onClick={() => void regenerateScope()}
            disabled={running || stats.total === 0}
            className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-[12.5px] font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {running ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <RefreshCw className="size-3.5" />
            )}
            {t('edit.narration.regenerateAll')}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
