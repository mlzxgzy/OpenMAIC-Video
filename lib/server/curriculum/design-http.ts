/**
 * Route plumbing for the design workspace (`/api/curriculum/design/*`).
 *
 * Every design route answers the same four questions the same way: is server
 * persistence configured, who is the owner, inside which transaction do writes
 * go, and how does a store refusal become a status code. Written per route,
 * that is how one route ends up missing the owner fence, or answering 500
 * where a 409 belongs, so it lives here once.
 *
 * The phase refusal is the one worth reading carefully. The store raises
 * {@link CurriculumPhaseError} when a write belongs to a design phase the task
 * has not reached — the enforcement of "outcomes before knowledge, knowledge
 * before outline". The route answers 409 and carries both phases in the body,
 * because "you cannot do this yet" is only actionable when it also says which
 * phase would allow it.
 */
import { NextResponse, type NextRequest } from 'next/server';

import type { Queryable } from '@openmaic/storage/document/pg';

import { isServerPersistenceConfigured } from '@/lib/config/feature-flags';
import { fenceOwnerWrite, ownerWriteErrorResponse } from '@/lib/persistence/owner-merges';
import { curriculumJsonError, mapCurriculumError } from '@/lib/server/curriculum/http';
import {
  CurriculumDesignNotFoundError,
  CurriculumDesignValidationError,
  CurriculumPhaseError,
  getCurriculumDesignProvider,
} from '@/lib/server/curriculum/design-store';
import { withRequestOwner } from '@/lib/server/identity/with-owner';

/** A caller mistake the store does not model, such as a body that is not JSON. */
export class DesignRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DesignRequestError';
  }
}

export interface DesignContext {
  req: NextRequest;
  ownerId: string;
  /** The response headers owner resolution produced; every answer must carry them. */
  headers: Headers;
  /** A pool connection, for reads. */
  queryable: Queryable;
  /**
   * The design task from `params.id`. Empty only on the collection route
   * (`/design/tasks`), which has no task in its path.
   */
  taskId: string;
  /** Every dynamic segment of the path, by name. */
  params: Record<string, string>;
  /** The request body, parsed once. Raises a 400 on a body that is not JSON. */
  body: () => Promise<unknown>;
  /** Run `work` in one transaction fenced by the owner. Use for every write. */
  write: <T>(work: (tx: Queryable) => Promise<T>) => Promise<T>;
}

export type DesignHandler = (context: DesignContext) => Promise<NextResponse>;

/**
 * The database constraints a caller can trip.
 *
 * The store validates ownership, the design phase and the shape of what it
 * writes, but a handful of rules live only in a table constraint: a chapter
 * carrying a teaching role, a dependency strength outside 0..1, two outcomes
 * sharing a code. Those arrive as `pg` errors, and an unmapped one answers 500
 * for what is really a bad request. Mapping them to 400 keeps the constraint's
 * own name in the response, so the refusal is still actionable; the console
 * line keeps it diagnosable if the violation turns out to be ours.
 */
const CONSTRAINT_REFUSALS: Record<string, string> = {
  '23502': 'a required field was missing',
  '23503': 'a referenced row does not exist or is not this owner’s',
  '23505': 'that value is already taken',
  '23514': 'a rule on this field was not satisfied',
  '22P02': 'a value had the wrong format',
};

function mapConstraintViolation(error: unknown, headers: Headers): NextResponse | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code !== 'string') return undefined;
  const reason = CONSTRAINT_REFUSALS[code];
  if (!reason) return undefined;
  const constraint = (error as { constraint?: unknown } | null)?.constraint;
  const named = typeof constraint === 'string' && constraint !== '' ? ` (${constraint})` : '';
  console.warn(`[CurriculumDesign] write refused by ${code}${named}`);
  return curriculumJsonError(400, 'CURRICULUM_DESIGN_INVALID', `${reason}${named}`, headers);
}

/**
 * Map the design store's typed failures onto status codes, then the database
 * constraints a bad request can trip, then fall through to the older
 * curriculum family so a series-ownership refusal is still a 404 rather than
 * an unhandled 500.
 */
export function mapDesignError(error: unknown, headers: Headers): NextResponse | undefined {
  if (error instanceof CurriculumDesignNotFoundError) {
    return curriculumJsonError(404, 'CURRICULUM_DESIGN_NOT_FOUND', error.message, headers);
  }
  if (error instanceof CurriculumDesignValidationError) {
    return curriculumJsonError(400, 'CURRICULUM_DESIGN_INVALID', error.message, headers);
  }
  if (error instanceof CurriculumPhaseError) {
    return NextResponse.json(
      {
        error: {
          code: 'CURRICULUM_DESIGN_PHASE_LOCKED',
          message: error.message,
          details: { current: error.current, required: error.required },
        },
      },
      { status: 409, headers },
    );
  }
  return mapConstraintViolation(error, headers) ?? mapCurriculumError(error, headers);
}

/**
 * The 400 for a body this layer refused, in the curriculum error envelope.
 *
 * Routes return this from a `ParseResult` that came back `ok: false`. The
 * message is the reader's own, which already names every offending field, so
 * nothing is added here.
 */
export function designInvalid(message: string, headers: Headers): NextResponse {
  return curriculumJsonError(400, 'CURRICULUM_DESIGN_INVALID', message, headers);
}

/**
 * Run one design route handler with owner resolution, the design provider and
 * the shared error mapping.
 *
 * `params` is the route's own promise of dynamic segments; pass `undefined` on
 * a route with none. Body parsing is lazy so a GET never touches the request
 * stream, and it happens *inside* the owner wrapper so a 400 still carries a
 * freshly minted owner cookie — a client that fixes its JSON and retries must
 * land in the same partition it started in.
 */
export async function runDesignRoute(
  req: NextRequest,
  params: Promise<Record<string, string>> | undefined,
  handler: DesignHandler,
): Promise<Response> {
  if (!isServerPersistenceConfigured()) return new Response('Not found', { status: 404 });

  return withRequestOwner(req, async ({ ownerId }, headers) => {
    const resolved = (await params) ?? {};
    let cached: unknown;
    let read = false;
    const body = async () => {
      if (!read) {
        read = true;
        try {
          cached = await req.json();
        } catch {
          throw new DesignRequestError(
            400,
            'CURRICULUM_DESIGN_INVALID',
            'request body must be JSON',
          );
        }
      }
      return cached;
    };

    try {
      const provider = await getCurriculumDesignProvider();
      return await handler({
        req,
        ownerId,
        headers,
        queryable: provider.pool as unknown as Queryable,
        taskId: resolved.id ?? '',
        params: resolved,
        body,
        write: (work) =>
          provider.withTransaction(async (tx) => {
            await fenceOwnerWrite(tx, ownerId);
            return work(tx);
          }),
      });
    } catch (error) {
      if (error instanceof DesignRequestError) {
        return curriculumJsonError(error.status, error.code, error.message, headers);
      }
      const claimed = ownerWriteErrorResponse(error, headers);
      if (claimed) return claimed;
      const known = mapDesignError(error, headers);
      if (known) return known;
      console.error(
        `[CurriculumDesign] ${req.method} ${req.nextUrl.pathname} failed [owner=${ownerId}]:`,
        error,
      );
      return curriculumJsonError(
        500,
        'CURRICULUM_DESIGN_FAILED',
        'The course design operation failed',
        headers,
      );
    }
  });
}

/** A required path segment that the route table guarantees is present. */
export function requiredParam(context: DesignContext, name: string): string {
  const value = context.params[name];
  if (!value) {
    throw new DesignRequestError(
      400,
      'CURRICULUM_DESIGN_INVALID',
      `${name} is missing from the request path`,
    );
  }
  return value;
}
