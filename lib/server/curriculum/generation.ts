/**
 * One-click curriculum generation: turn an assembled course package into a
 * curriculum course, a server-side generation run and the durable link the
 * runner's event hook uses to write the produced `stage_id` back.
 *
 * The route owns request identity; this module is called with the resolved
 * owner and principal. It fences owner writes on every curriculum transaction,
 * then starts the run through the shared generation-run start path.
 */
import { fenceOwnerWrite } from '@/lib/persistence/owner-merges';
import type { CourseAssemblyPlan } from '@/lib/curriculum/assembly';
import type { GenerationRunInput } from '@/lib/server/generation/run/types';
import { startGenerationRun } from '@/lib/server/generation/run/start';
import { discardGenerationRun } from '@/lib/server/generation/run/store';
import type { OwnerPrincipal } from '@/lib/server/identity/types';

import {
  attachGenerationRunToCurriculumJob,
  createCurriculumCourse,
  createCurriculumGenerationJob,
  getCurriculumProvider,
  setCourseKnowledgePoints,
  updateCurriculumCourse,
} from './store';
import type { ParsedGenerationJobInput } from './validation';

export interface StartCurriculumGenerationJobInput {
  ownerId: string;
  /** Present for a user-request start; absent for a background queue drain. */
  principal?: OwnerPrincipal;
  /** Present for a user-request start; absent for a background queue drain. */
  request?: Request;
  assembly: CourseAssemblyPlan;
  parsed: ParsedGenerationJobInput;
  lessonOrder: number;
}

export interface StartedCurriculumGenerationJob {
  job: Awaited<ReturnType<typeof createCurriculumGenerationJob>>;
  run: Awaited<ReturnType<typeof startGenerationRun>>;
  courseId: string;
  createdCourse: boolean;
}

function courseCoreDetailsFromAssembly(assembly: CourseAssemblyPlan) {
  return {
    seriesId: assembly.seriesId,
    title: assembly.title,
    code: assembly.code.trim() || null,
    description: assembly.objectives.join('；') || null,
    chapter: assembly.chapter.trim() || null,
    section: assembly.section.trim() || null,
    hours: assembly.hours,
  };
}

function courseDetailsFromAssembly(assembly: CourseAssemblyPlan, lessonOrder: number) {
  return {
    ...courseCoreDetailsFromAssembly(assembly),
    lessonOrder,
    status: 'draft' as const,
  };
}

function courseKnowledgePointsFromAssembly(assembly: CourseAssemblyPlan) {
  return assembly.knowledgePoints.map((point, index) => ({
    knowledgePointId: point.knowledgePointId,
    coverageLevel: point.coverageLevel,
    sortOrder: index,
    note: point.note,
  }));
}

export async function startCurriculumGenerationJob(
  input: StartCurriculumGenerationJobInput,
): Promise<StartedCurriculumGenerationJob> {
  const { ownerId, principal, request, assembly, parsed, lessonOrder } = input;
  const { withTransaction } = await getCurriculumProvider();

  const created = await withTransaction(async (tx) => {
    await fenceOwnerWrite(tx, ownerId);
    let createdCourse = false;
    let courseId = parsed.courseId ?? null;

    if (courseId) {
      const course = await updateCurriculumCourse(
        tx,
        ownerId,
        courseId,
        courseCoreDetailsFromAssembly(assembly),
      );
      courseId = course.id;
    } else {
      const course = await createCurriculumCourse(
        tx,
        ownerId,
        courseDetailsFromAssembly(assembly, lessonOrder),
      );
      courseId = course.id;
      createdCourse = true;
    }

    await setCourseKnowledgePoints(
      tx,
      ownerId,
      courseId,
      courseKnowledgePointsFromAssembly(assembly),
    );

    const job = await createCurriculumGenerationJob(tx, ownerId, {
      courseId,
      outlineReview: parsed.outlineReview,
      request: {
        assembly: parsed.assembly as unknown as Record<string, unknown>,
        outlineReview: parsed.outlineReview,
        interactive: parsed.interactive,
        taskEngine: parsed.taskEngine,
        ...(parsed.voice ? { voice: parsed.voice } : {}),
      },
    });

    return { courseId, createdCourse, job };
  });

  const runInput: GenerationRunInput = {
    requirement: assembly.coursePackage.generation.requirement,
    materialIds: [],
    interactive: parsed.interactive,
    taskEngine: parsed.taskEngine,
    sceneTypes: assembly.coursePackage.generation.sceneTypes,
    agents: { mode: 'auto' },
    outlineReview: parsed.outlineReview,
    ...(parsed.voice ? { voice: parsed.voice } : {}),
  };

  let run: Awaited<ReturnType<typeof startGenerationRun>>;
  try {
    run = await startGenerationRun(
      ownerId,
      runInput,
      principal && request
        ? {
            principal,
            request,
            origin: 'generation-runs',
          }
        : undefined,
    );
  } catch (error) {
    // Starting failed before a run existed: remove the just-created job, and
    // the draft course when this request created it, so a retry is clean.
    try {
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        await tx.query('DELETE FROM curriculum_generation_job WHERE owner_id = $1 AND id = $2', [
          ownerId,
          created.job.id,
        ]);
        if (created.createdCourse) {
          await tx.query('DELETE FROM curriculum_course WHERE owner_id = $1 AND id = $2', [
            ownerId,
            created.courseId,
          ]);
        }
      });
    } catch (cleanupError) {
      console.error('[Curriculum] Failed to clean up a refused generation start', cleanupError);
    }
    throw error;
  }

  try {
    const job = await withTransaction(async (tx) => {
      await fenceOwnerWrite(tx, ownerId);
      return attachGenerationRunToCurriculumJob(tx, ownerId, created.job.id, run.id);
    });
    return {
      job,
      run,
      courseId: created.courseId,
      createdCourse: created.createdCourse,
    };
  } catch (error) {
    // The run exists but the link did not commit. End the run when it still
    // has no course; that keeps the one-click retry from leaving a duplicate
    // generation behind.
    try {
      await discardGenerationRun(run.id, ownerId);
    } catch (discardError) {
      console.error('[Curriculum] Failed to discard an unlinked generation run', discardError);
    }
    throw error;
  }
}
