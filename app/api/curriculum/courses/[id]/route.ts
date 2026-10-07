/**
 * GET /api/curriculum/courses/[id] — focused snapshot for one course product.
 * PATCH /api/curriculum/courses/[id] — update one owned course.
 * DELETE /api/curriculum/courses/[id] — delete one owned course.
 *
 * The GET response intentionally has the `CurriculumSnapshot` shape so the
 * course product page can reuse the same client state as the ledger page. It
 * only carries the rows that page actually needs: all series and courses for
 * selects/relations, knowledge points of this course's series, and this
 * course's links, generation jobs and export jobs.
 *
 * Deleting a curriculum course never deletes the linked `stage`; it only
 * removes the ledger entity. The stage remains available in the course
 * library.
 */
import type { NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { ownerJson } from '@/lib/server/agent-runtime/route-response';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  deleteCurriculumCourse,
  getCurriculumCourseDetail,
  getCurriculumProvider,
  updateCurriculumCourse,
  type CurriculumCourseInput,
} from '@/lib/server/curriculum/store';
import { parseCourseInput } from '@/lib/server/curriculum/validation';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

export const runtime = 'nodejs';

type Params = { params: Promise<{ id: string }> };

export async function GET(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { pool } = await getCurriculumProvider();
      const snapshot = await getCurriculumCourseDetail(pool as unknown as Queryable, ownerId, id);
      return ownerJson(snapshot as unknown as Record<string, unknown>, 200, responseHeaders);
    } catch (error) {
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[Curriculum] Failed to load course [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_COURSE_FAILED',
        'Failed to load the course',
        responseHeaders,
      );
    }
  });
}

export async function PATCH(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', 'request body must be JSON');
  }
  const parsed = parseCourseInput(body, { requireTitle: false });
  if (!parsed.ok) return curriculumJsonError(400, 'CURRICULUM_INVALID', parsed.message);

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      const course = await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return updateCurriculumCourse(
          tx,
          ownerId,
          id,
          parsed.value as Partial<CurriculumCourseInput>,
        );
      });
      return ownerJson({ course }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[Curriculum] Failed to update course [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_COURSE_FAILED',
        'Failed to update the course',
        responseHeaders,
      );
    }
  });
}

export async function DELETE(req: NextRequest, { params }: Params) {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, responseHeaders) => {
    const { id } = await params;
    try {
      const { withTransaction } = await getCurriculumProvider();
      await withTransaction(async (tx) => {
        await fenceOwnerWrite(tx, ownerId);
        return deleteCurriculumCourse(tx, ownerId, id);
      });
      return ownerJson({ ok: true }, 200, responseHeaders);
    } catch (error) {
      const claimed = ownerWriteErrorResponse(error, responseHeaders);
      if (claimed) return claimed;
      const known = mapCurriculumError(error, responseHeaders);
      if (known) return known;
      console.error(`[Curriculum] Failed to delete course [owner=${ownerId}, id=${id}]:`, error);
      return curriculumJsonError(
        500,
        'CURRICULUM_COURSE_FAILED',
        'Failed to delete the course',
        responseHeaders,
      );
    }
  });
}
