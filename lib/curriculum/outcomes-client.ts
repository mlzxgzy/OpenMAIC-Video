'use client';

/**
 * The step-2 conversation as the browser sees it.
 *
 * Same three verbs as step 1 — talk, confirm, withdraw — plus a read, because two
 * surfaces drive the same step (the dialog opened from the workbench, and the card
 * itself). They live here rather than inside either surface for the reason
 * `direction-client.ts` gives: two copies of the endpoint strings is how one of them
 * ends up posting to a route that moved.
 *
 * Nothing is derived here. `gaps`, `phaseGaps` and `readyToAdvance` all come from the
 * server, which computes them from the store. A client that recomputed "the list is
 * complete" would disagree with the gate the first time either changed.
 */
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumEvidenceRecord,
  CurriculumObjectiveRecord,
} from '@/lib/curriculum/design-types';
import type { OutcomeGap } from '@/lib/curriculum/design-outcomes';

export interface OutcomesTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What both outcomes routes answer with; the turn adds two fields to it. */
export interface OutcomesStatePayload {
  objectives: CurriculumObjectiveRecord[];
  evidence: CurriculumEvidenceRecord[];
  gaps: OutcomeGap[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
}

/** The shape `POST .../outcomes/turn` answers with. */
export interface OutcomesTurnPayload extends OutcomesStatePayload {
  message: string;
  confirmedThisTurn: boolean;
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

/** One conversational turn. The server writes the list and answers with it. */
export function sendOutcomesTurn(input: {
  taskId: string;
  instruction: string;
  history: OutcomesTurn[];
}): Promise<OutcomesTurnPayload> {
  return requestJson<OutcomesTurnPayload>(`${BASE}/tasks/${input.taskId}/outcomes/turn`, {
    method: 'POST',
    body: JSON.stringify({ instruction: input.instruction, history: input.history }),
  });
}

/** The list's sign-off state, for a dialog opening on an existing task. */
export function readOutcomesState(taskId: string): Promise<OutcomesStatePayload> {
  return requestJson<OutcomesStatePayload>(`${BASE}/tasks/${taskId}/outcomes`);
}

export function confirmOutcomes(taskId: string, note?: string): Promise<OutcomesStatePayload> {
  return requestJson<OutcomesStatePayload>(`${BASE}/tasks/${taskId}/outcomes`, {
    method: 'POST',
    ...(note ? { body: JSON.stringify({ note }) } : {}),
  });
}

export function withdrawOutcomes(taskId: string): Promise<OutcomesStatePayload> {
  return requestJson<OutcomesStatePayload>(`${BASE}/tasks/${taskId}/outcomes`, {
    method: 'DELETE',
  });
}
