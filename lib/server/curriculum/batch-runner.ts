/**
 * Process-scoped curriculum batch scanner. It is intentionally tiny: the
 * durable queue and `FOR UPDATE SKIP LOCKED` claims live in `batch.ts`; this
 * module only schedules owner scans and lets a start/finish wake them.
 */
import { createLogger } from '@/lib/logger';

import { generationRunConfig } from '@/lib/server/generation/run/config';

import { advanceAllCurriculumBatches } from './batch';

const log = createLogger('CurriculumBatchRunner');

const RUNNER_KEY = Symbol.for('openmaic.curriculum.batch-runner');
const runnerState = globalThis as typeof globalThis & {
  [RUNNER_KEY]?: CurriculumBatchRunnerHandle;
};

export interface CurriculumBatchRunnerHandle {
  wake(): void;
  stop(): Promise<void>;
}

export interface CurriculumBatchRunnerOptions {
  /** Tests only. */
  scanIntervalMs?: number;
}

/** Ask this process's batch scanner to try starting queued items now. */
export function wakeCurriculumBatchRunner(): void {
  runnerState[RUNNER_KEY]?.wake();
}

export function startCurriculumBatchRunner(
  options: CurriculumBatchRunnerOptions = {},
): CurriculumBatchRunnerHandle {
  const intervalMs = options.scanIntervalMs ?? generationRunConfig().scanIntervalMs;
  let stopping = false;
  let scanning = false;
  let pending = false;

  const scan = async (): Promise<void> => {
    if (stopping) return;
    if (scanning) {
      pending = true;
      return;
    }
    scanning = true;
    try {
      do {
        pending = false;
        await advanceAllCurriculumBatches().catch((error) => log.warn('batch scan failed', error));
      } while (pending && !stopping);
    } finally {
      scanning = false;
    }
  };

  const timer = setInterval(() => void scan(), intervalMs);
  timer.unref?.();
  void scan();
  log.info(`curriculum batch runner started (scan=${intervalMs}ms)`);

  const handle: CurriculumBatchRunnerHandle = {
    wake: () => void scan(),
    async stop() {
      stopping = true;
      if (runnerState[RUNNER_KEY] === handle) delete runnerState[RUNNER_KEY];
      clearInterval(timer);
      const deadline = Date.now() + 10_000;
      while (scanning && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    },
  };
  runnerState[RUNNER_KEY] = handle;
  return handle;
}
