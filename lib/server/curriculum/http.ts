import { NextResponse } from 'next/server';

import {
  CurriculumConflictError,
  CurriculumNotFoundError,
  CurriculumValidationError,
} from './store';

/** The error envelope used by the curriculum family. */
export function curriculumJsonError(
  status: number,
  code: string,
  message: string,
  headers?: Headers,
): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status, headers });
}

/** Map the store's typed failures onto the route's status codes. */
export function mapCurriculumError(error: unknown, headers: Headers): NextResponse | undefined {
  if (error instanceof CurriculumNotFoundError) {
    return curriculumJsonError(404, 'CURRICULUM_NOT_FOUND', error.message, headers);
  }
  if (error instanceof CurriculumValidationError) {
    return curriculumJsonError(400, 'CURRICULUM_INVALID', error.message, headers);
  }
  if (error instanceof CurriculumConflictError) {
    return curriculumJsonError(409, 'CURRICULUM_CONFLICT', error.message, headers);
  }
  return undefined;
}
