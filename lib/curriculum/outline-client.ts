'use client';

/**
 * The step-5 conversation as the browser sees it.
 *
 * Same three verbs as steps 1–3 — talk, confirm, withdraw — plus a read, because
 * two surfaces drive the same step (the dialog opened from the workbench, and the
 * sign-off strip itself). They live here rather than inside either surface for the
 * reason `direction-client.ts` gives: two copies of the endpoint strings is how
 * one of them ends up posting to a route that moved.
 *
 * Nothing is derived here. `gaps`, `auditFindings`, `phaseGaps` and
 * `readyToAdvance` all come from the server, which computes them from the store.
 * A client that recomputed "every outcome is taught" — or "this order is legal" —
 * would disagree with the gate the first time either changed.
 */
import type { OutlineGap } from '@/lib/curriculum/design-outline';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumObjectiveRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitDependencyRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

export interface OutlineTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One of the audit's own outline-layer findings, as the card shows it. */
export interface OutlineAuditFinding {
  rule: string;
  severity: string;
  message: string;
}

/** What both outline routes answer with; the turn adds three fields to it. */
export interface OutlineStatePayload {
  units: CurriculumUnitRecord[];
  unitCoverage: CurriculumUnitCoverageRecord[];
  objectives: CurriculumObjectiveRecord[];
  unitDependencies: CurriculumUnitDependencyRecord[];
  gaps: OutlineGap[];
  findings: OutlineGap[];
  auditFindings: OutlineAuditFinding[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
}

/** The shape `POST .../outline/turn` answers with. */
export interface OutlineTurnPayload extends OutlineStatePayload {
  message: string;
  /** What this turn could not honour, in the author's language. */
  warnings: string[];
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

/** One conversational turn. The server writes the outline and answers with it. */
export function sendOutlineTurn(input: {
  taskId: string;
  instruction: string;
  history: OutlineTurn[];
}): Promise<OutlineTurnPayload> {
  return requestJson<OutlineTurnPayload>(`${BASE}/tasks/${input.taskId}/outline/turn`, {
    method: 'POST',
    body: JSON.stringify({ instruction: input.instruction, history: input.history }),
  });
}

/** The outline's sign-off state, for a dialog opening on an existing task. */
export function readOutlineState(taskId: string): Promise<OutlineStatePayload> {
  return requestJson<OutlineStatePayload>(`${BASE}/tasks/${taskId}/outline`);
}

export function confirmOutline(taskId: string, note?: string): Promise<OutlineStatePayload> {
  return requestJson<OutlineStatePayload>(`${BASE}/tasks/${taskId}/outline`, {
    method: 'POST',
    ...(note ? { body: JSON.stringify({ note }) } : {}),
  });
}

export function withdrawOutline(taskId: string): Promise<OutlineStatePayload> {
  return requestJson<OutlineStatePayload>(`${BASE}/tasks/${taskId}/outline`, {
    method: 'DELETE',
  });
}
