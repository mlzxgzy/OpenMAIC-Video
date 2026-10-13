'use client';

/**
 * The step-7 conversation as the browser sees it.
 *
 * Same four calls as step 6 — talk, confirm, withdraw, read — and the same reason
 * for living here rather than inside a surface: two copies of the endpoint strings
 * is how one of them ends up posting to a route that moved.
 *
 * Nothing is derived here. `gaps`, `auditFindings`, `phaseGaps` and
 * `readyToAdvance` all come from the server, and that matters more in this step
 * than in the ones before it: whether a question hangs where something promised to
 * grade it is a judgement over the outline, the evidence and the artifacts at once,
 * and a client that re-implemented it would start disagreeing with the gate the day
 * either rule changed.
 */
import type { AssessmentGap } from '@/lib/curriculum/design-assessment';
import type {
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumEvidenceRecord,
  CurriculumLabTaskRecord,
  CurriculumObjectiveRecord,
  CurriculumQuestionRecord,
  CurriculumUnitCoverageRecord,
  CurriculumUnitRecord,
} from '@/lib/curriculum/design-types';

export interface AssessmentTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** One of the audit's own assessment-layer findings, as the card shows it. */
export interface AssessmentAuditFinding {
  rule: string;
  severity: string;
  message: string;
}

/** What both assessment routes answer with; the turn adds three fields to it. */
export interface AssessmentStatePayload {
  units: CurriculumUnitRecord[];
  unitCoverage: CurriculumUnitCoverageRecord[];
  objectives: CurriculumObjectiveRecord[];
  evidence: CurriculumEvidenceRecord[];
  questions: CurriculumQuestionRecord[];
  labTasks: CurriculumLabTaskRecord[];
  gaps: AssessmentGap[];
  findings: { text: string }[];
  auditFindings: AssessmentAuditFinding[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
  /** The rendered plan, so the panel shows what the prompt showed. */
  plan: string;
}

/** The shape `POST .../assessment/turn` answers with. */
export interface AssessmentTurnPayload extends AssessmentStatePayload {
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

/** One conversational turn. The server writes the artifacts and answers with them. */
export function sendAssessmentTurn(input: {
  taskId: string;
  instruction: string;
  history: AssessmentTurn[];
}): Promise<AssessmentTurnPayload> {
  return requestJson<AssessmentTurnPayload>(`${BASE}/tasks/${input.taskId}/assessment/turn`, {
    method: 'POST',
    body: JSON.stringify({ instruction: input.instruction, history: input.history }),
  });
}

/** The assessment's sign-off state, for a dialog opening on an existing task. */
export function readAssessmentState(taskId: string): Promise<AssessmentStatePayload> {
  return requestJson<AssessmentStatePayload>(`${BASE}/tasks/${taskId}/assessment`);
}

export function confirmAssessment(taskId: string, note?: string): Promise<AssessmentStatePayload> {
  return requestJson<AssessmentStatePayload>(`${BASE}/tasks/${taskId}/assessment`, {
    method: 'POST',
    ...(note ? { body: JSON.stringify({ note }) } : {}),
  });
}

export function withdrawAssessment(taskId: string): Promise<AssessmentStatePayload> {
  return requestJson<AssessmentStatePayload>(`${BASE}/tasks/${taskId}/assessment`, {
    method: 'DELETE',
  });
}
