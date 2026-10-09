/**
 * Batch generation queue: assemble many ledger courses once, then drain them
 * through the same generation-run limit as interactive starts. PostgreSQL
 * claims one item at a time with `FOR UPDATE SKIP LOCKED`; this module only
 * coordinates the local owner scan and never bypasses the run store's own
 * per-owner limit.
 */
import type { Queryable } from '@openmaic/storage/document/pg';

import type { CourseAssemblyInput, CourseAssemblyPlan } from '@/lib/curriculum/assembly';
import { buildCourseAssembly } from '@/lib/curriculum/assembly';
import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { generationRunConfig } from '@/lib/server/generation/run/config';
import { ActiveRunLimitError, WaitingRunLimitError } from '@/lib/server/generation/run/store';
import { listActiveGenerationRuns } from '@/lib/server/generation/run/store';
import { LIMITED_RUN_STATES } from '@/lib/server/generation/run/types';
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';

import { startCurriculumGenerationJob } from './generation';
import {
  applyCurriculumBatchAction,
  claimNextCurriculumBatchItem,
  createCurriculumBatch,
  CurriculumNotFoundError,
  CurriculumValidationError,
  failCurriculumBatchItem,
  getCurriculumProvider,
  listCurriculum,
  listOwnersWithRunnableCurriculumBatchItems,
  markCurriculumBatchItemRunning,
  requeueCurriculumBatchItem,
  type CurriculumBatchAction,
  type CurriculumBatchInput,
} from './store';
import type { ParsedCurriculumBatchInput, ParsedGenerationJobInput } from './validation';

export interface StoredCurriculumBatchItemRequest {
  version: 1;
  lessonOrder: number;
  parsed: ParsedGenerationJobInput;
  assembly: CourseAssemblyPlan;
}

function asStoredRequest(value: Record<string, unknown>): StoredCurriculumBatchItemRequest | null {
  const candidate = value as Partial<StoredCurriculumBatchItemRequest> | null;
  if (!candidate || candidate.version !== 1) return null;
  if (!candidate.parsed || !candidate.assembly) return null;
  if (typeof candidate.lessonOrder !== 'number') return null;
  return candidate as StoredCurriculumBatchItemRequest;
}

function nextLessonOrderInSeries(
  courses: Array<{ id: string; seriesId: string | null; lessonOrder: number }>,
  seriesId: string | null,
  courseId: string | null,
): number {
  if (courseId) {
    const course = courses.find((candidate) => candidate.id === courseId);
    if (course) return course.lessonOrder;
  }
  return courses.filter((course) => course.seriesId === seriesId).length + 1;
}

function courseAssemblyInputFromLedger(
  course: {
    seriesId: string | null;
    title: string;
    code: string | null;
    chapter: string | null;
    section: string | null;
    hours: number | null;
  },
  links: Array<{
    knowledgePointId: string;
    coverageLevel: CourseAssemblyInput['knowledgePoints'][number]['coverageLevel'];
    sortOrder: number;
    note: string | null;
  }>,
): CourseAssemblyInput {
  return {
    seriesId: course.seriesId,
    title: course.title,
    code: course.code,
    chapter: course.chapter,
    section: course.section,
    type: null,
    hours: course.hours,
    knowledgePoints: links
      .slice()
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map((link) => ({
        knowledgePointId: link.knowledgePointId,
        coverageLevel: link.coverageLevel,
        note: link.note,
      })),
  };
}

/**
 * Turn a validated batch request into durable items. Every item snapshots its
 * fully assembled course package, so later edits to the knowledge library do
 * not silently change what a queued job will generate.
 */
export async function enqueueCurriculumBatch(
  ownerId: string,
  parsed: ParsedCurriculumBatchInput,
): Promise<{ batchId: string; itemCount: number }> {
  if (!isServerPersistenceConfigured()) {
    throw new CurriculumValidationError('服务端持久化未配置');
  }
  const { pool, withTransaction } = await getCurriculumProvider();
  const snapshot = await listCurriculum(pool as unknown as Queryable, ownerId);
  const items: CurriculumBatchInput['items'] = [];

  for (const [index, item] of parsed.items.entries()) {
    let generation: ParsedGenerationJobInput;
    let assembly: CourseAssemblyPlan;
    let lessonOrder: number;

    if (item.kind === 'assembly') {
      generation = item.generation;
      if (
        generation.courseId &&
        !snapshot.courses.some((course) => course.id === generation.courseId)
      ) {
        throw new CurriculumNotFoundError(`items[${index}]：课程不存在`);
      }
      assembly = buildCourseAssembly(snapshot, generation.assembly);
      if (assembly.knowledgePoints.length === 0) {
        throw new CurriculumValidationError(`items[${index}]：没有可用的知识点`);
      }
      lessonOrder = nextLessonOrderInSeries(
        snapshot.courses,
        assembly.seriesId,
        generation.courseId ?? null,
      );
    } else {
      const course = snapshot.courses.find((candidate) => candidate.id === item.courseId);
      if (!course) throw new CurriculumNotFoundError(`items[${index}]：课程不存在`);
      const links = snapshot.courseKnowledgePoints.filter((link) => link.courseId === course.id);
      if (links.length === 0) {
        throw new CurriculumValidationError(`items[${index}]：课程没有绑定的知识点`);
      }
      const assemblyInput = courseAssemblyInputFromLedger(course, links);
      assembly = buildCourseAssembly(snapshot, assemblyInput);
      if (assembly.knowledgePoints.length === 0) {
        throw new CurriculumValidationError(`items[${index}]：没有可用的知识点`);
      }
      generation = {
        assembly: assemblyInput,
        courseId: course.id,
        outlineReview: item.options.outlineReview,
        interactive: item.options.interactive,
        taskEngine: item.options.taskEngine,
        ...(item.options.voice ? { voice: item.options.voice } : {}),
      };
      lessonOrder = course.lessonOrder;
    }

    const request: StoredCurriculumBatchItemRequest = {
      version: 1,
      lessonOrder,
      parsed: generation,
      assembly,
    };
    items.push({
      title: assembly.title,
      courseId: generation.courseId ?? null,
      request: request as unknown as Record<string, unknown>,
      maxAttempts: item.maxAttempts,
    });
  }

  const created = await withTransaction(async (tx) => {
    await fenceOwnerWrite(tx as Queryable, ownerId);
    return createCurriculumBatch(tx as Queryable, ownerId, { name: parsed.name, items });
  });
  const { wakeCurriculumBatchRunner } = await import('./batch-runner');
  wakeCurriculumBatchRunner();
  // Fallback drain for a process whose instrumentation did not register the
  // timer (for example, a hot-reloaded dev route). The runner is the durable
  // path; this just avoids making the first item wait for a restart.
  void advanceCurriculumBatch(ownerId).catch((error) =>
    console.error(`[CurriculumBatch] Immediate drain failed [owner=${ownerId}]:`, error),
  );
  return { batchId: created.batch.id, itemCount: created.items.length };
}

/** Map a start failure to the batch item error shape. */
function batchStartError(error: unknown): { code: string; message: string } {
  return {
    code: error instanceof Error && error.name ? error.name : 'BATCH_START_FAILED',
    message: error instanceof Error ? error.message : String(error),
  };
}

async function limitedActiveRunCount(ownerId: string): Promise<number> {
  const runs = await listActiveGenerationRuns(ownerId);
  return runs.filter((run) => (LIMITED_RUN_STATES as readonly string[]).includes(run.state)).length;
}

/**
 * Drain one owner's queue while the generation-run limit has room. Returns
 * how many items this call started. A capacity refusal re-queues the claimed
 * item and stops the scan until the next wake/timer.
 */
export async function advanceCurriculumBatch(ownerId: string): Promise<number> {
  if (!isServerPersistenceConfigured()) return 0;
  const { withTransaction } = await getCurriculumProvider();
  const config = generationRunConfig();
  let startedCount = 0;

  for (let slot = 0; slot < config.maxActiveRunsPerOwner; slot += 1) {
    if ((await limitedActiveRunCount(ownerId)) >= config.maxActiveRunsPerOwner) break;

    const claimed = await withTransaction(async (tx) => {
      await fenceOwnerWrite(tx as Queryable, ownerId);
      return claimNextCurriculumBatchItem(tx as Queryable, ownerId);
    });
    if (!claimed) break;

    const stored = asStoredRequest(claimed.request);
    if (!stored) {
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx as Queryable, ownerId);
        await failCurriculumBatchItem(tx as Queryable, ownerId, claimed.record.id, {
          code: 'BATCH_REQUEST_INVALID',
          message: '排队的批次项没有可读取的组装方案快照',
        });
      });
      continue;
    }

    try {
      const started = await startCurriculumGenerationJob({
        ownerId,
        assembly: stored.assembly,
        parsed: stored.parsed,
        lessonOrder: stored.lessonOrder,
      });
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx as Queryable, ownerId);
        await markCurriculumBatchItemRunning(
          tx as Queryable,
          ownerId,
          claimed.record.id,
          started.job.id,
          started.run.id,
        );
      });
      startedCount += 1;
    } catch (error) {
      if (error instanceof ActiveRunLimitError || error instanceof WaitingRunLimitError) {
        await withTransaction(async (tx) => {
          await fenceOwnerWrite(tx as Queryable, ownerId);
          await requeueCurriculumBatchItem(tx as Queryable, ownerId, claimed.record.id, {
            code: 'BATCH_WAITING_FOR_CAPACITY',
            message: error.message,
          });
        });
        break;
      }
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx as Queryable, ownerId);
        await failCurriculumBatchItem(
          tx as Queryable,
          ownerId,
          claimed.record.id,
          batchStartError(error),
        );
      });
    }
  }

  return startedCount;
}

/** Scan every owner with a runnable item; each owner is drained by its own limit. */
export async function advanceAllCurriculumBatches(limit = 50): Promise<number> {
  if (!isServerPersistenceConfigured()) return 0;
  const { pool } = await getCurriculumProvider();
  const owners = await listOwnersWithRunnableCurriculumBatchItems(
    pool as unknown as Queryable,
    limit,
  );
  let started = 0;
  for (const ownerId of owners) {
    try {
      started += await advanceCurriculumBatch(ownerId);
    } catch (error) {
      console.error(`[CurriculumBatch] Owner scan failed [owner=${ownerId}]:`, error);
    }
  }
  return started;
}

/** Apply a batch action and wake the queue after a resume/retry. */
export async function actOnCurriculumBatch(
  ownerId: string,
  batchId: string,
  action: CurriculumBatchAction,
) {
  const { withTransaction } = await getCurriculumProvider();
  const result = await withTransaction(async (tx) => {
    await fenceOwnerWrite(tx as Queryable, ownerId);
    return applyCurriculumBatchAction(tx as Queryable, ownerId, batchId, action);
  });
  if (action === 'resume' || action === 'retry') {
    const { wakeCurriculumBatchRunner } = await import('./batch-runner');
    wakeCurriculumBatchRunner();
    void advanceCurriculumBatch(ownerId).catch((error) =>
      console.error(`[CurriculumBatch] Immediate drain failed [owner=${ownerId}]:`, error),
    );
  }
  return result;
}
