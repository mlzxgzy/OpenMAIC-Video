'use client';

/**
 * The step-1 conversation as the browser sees it.
 *
 * Three calls, one per thing the user can do — talk, confirm, withdraw — plus a
 * read for when the dialog opens on an existing card. They live here rather than
 * inside the dialog because two surfaces drive the same step: the dialog itself
 * (from the task list, where a course is created) and the card in the workbench
 * (where it is edited and confirmed). Two copies of the endpoint strings is how
 * one of them ends up posting to a route that moved.
 *
 * The response type is the route's own payload, declared once. Nothing is derived
 * here: `gaps`, `phaseGaps` and `readyToAdvance` all come from the server, which
 * computes them from the store. A client that recomputed "the card is complete"
 * would disagree with the gate the first time either changed.
 */
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumTaskRecord,
} from '@/lib/curriculum/design-types';
import type { CurriculumDirectionValues } from '@/lib/curriculum/design-direction';

export interface DirectionTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** The shape `POST /api/curriculum/design/direction` answers with. */
export interface DirectionTurnPayload {
  /** `null` until the turn that names the course — there is no row before that. */
  task: CurriculumTaskRecord | null;
  message: string;
  values: CurriculumDirectionValues;
  gaps: string[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  confirmedThisTurn: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
}

/** The shape both direction routes answer with once a task exists. */
export interface DirectionStatePayload {
  values: CurriculumDirectionValues;
  gaps: string[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
}

const BASE = '/api/curriculum/design';

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    throw new Error(payload?.error?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return payload as T;
}

/** One conversational turn. The server writes the card and answers with it. */
export function sendDirectionTurn(input: {
  taskId: string | null;
  instruction: string;
  history: DirectionTurn[];
}): Promise<DirectionTurnPayload> {
  return requestJson<DirectionTurnPayload>(`${BASE}/direction`, {
    method: 'POST',
    body: JSON.stringify({
      ...(input.taskId ? { taskId: input.taskId } : {}),
      instruction: input.instruction,
      history: input.history,
    }),
  });
}

export function patchTaskBrief(
  taskId: string,
  patch: Partial<CurriculumDirectionValues>,
): Promise<{ task: CurriculumTaskRecord }> {
  return requestJson<{ task: CurriculumTaskRecord }>(`${BASE}/tasks/${taskId}`, {
    method: 'PATCH',
    body: JSON.stringify(patch),
  });
}

/** The card's sign-off state, for a dialog opening on an existing task. */
export function readDirectionState(taskId: string): Promise<DirectionStatePayload> {
  return requestJson<DirectionStatePayload>(`${BASE}/tasks/${taskId}/direction`);
}

export function confirmDirection(taskId: string, note?: string): Promise<DirectionStatePayload> {
  return requestJson<DirectionStatePayload>(`${BASE}/tasks/${taskId}/direction`, {
    method: 'POST',
    ...(note ? { body: JSON.stringify({ note }) } : {}),
  });
}

export function withdrawDirection(taskId: string): Promise<DirectionStatePayload> {
  return requestJson<DirectionStatePayload>(`${BASE}/tasks/${taskId}/direction`, {
    method: 'DELETE',
  });
}
