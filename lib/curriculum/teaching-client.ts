'use client';

/**
 * The step-6 conversation as the browser sees it.
 *
 * Same four calls as step 5 — talk, confirm, withdraw, read — and the same reason
 * for living here rather than inside a surface: two copies of the endpoint strings
 * is how one of them ends up posting to a route that moved.
 *
 * Nothing is derived here. `gaps`, `auditFindings`, `phaseGaps` and
 * `readyToAdvance` all come from the server, and that matters more in this step
 * than in the ones before it: whether a storyboard contradicts the script is a
 * judgement over two documents, and a client that re-implemented it would start
 * disagreeing with the gate the day either rule changed.
 */
import type { TeachingGap } from '@/lib/curriculum/design-teaching';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumNodeObjectiveRecord,
  CurriculumLearningNodeRecord,
  CurriculumObjectiveRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

export interface TeachingTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One of the audit's own teaching-layer findings, as the card shows it. */
export interface TeachingAuditFinding {
  rule: string;
  severity: string;
  message: string;
}

/** What both teaching routes answer with; the turn adds three fields to it. */
export interface TeachingStatePayload {
  units: CurriculumUnitRecord[];
  unitCoverage: CurriculumUnitCoverageRecord[];
  nodes: CurriculumLearningNodeRecord[];
  nodeObjectives: CurriculumNodeObjectiveRecord[];
  objectives: CurriculumObjectiveRecord[];
  gaps: TeachingGap[];
  findings: { text: string }[];
  auditFindings: TeachingAuditFinding[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
  /** The rendered plan, so the panel shows what the prompt showed. */
  plan: string;
}

/** The shape `POST .../teaching/turn` answers with. */
export interface TeachingTurnPayload extends TeachingStatePayload {
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

/** One conversational turn. The server writes the design and answers with it. */
export function sendTeachingTurn(input: {
  taskId: string;
  instruction: string;
  history: TeachingTurn[];
}): Promise<TeachingTurnPayload> {
  return requestJson<TeachingTurnPayload>(`${BASE}/tasks/${input.taskId}/teaching/turn`, {
    method: 'POST',
    body: JSON.stringify({ instruction: input.instruction, history: input.history }),
  });
}

/** The design's sign-off state, for a dialog opening on an existing task. */
export function readTeachingState(taskId: string): Promise<TeachingStatePayload> {
  return requestJson<TeachingStatePayload>(`${BASE}/tasks/${taskId}/teaching`);
}

export function confirmTeaching(taskId: string, note?: string): Promise<TeachingStatePayload> {
  return requestJson<TeachingStatePayload>(`${BASE}/tasks/${taskId}/teaching`, {
    method: 'POST',
    ...(note ? { body: JSON.stringify({ note }) } : {}),
  });
}

export function withdrawTeaching(taskId: string): Promise<TeachingStatePayload> {
  return requestJson<TeachingStatePayload>(`${BASE}/tasks/${taskId}/teaching`, {
    method: 'DELETE',
  });
}
