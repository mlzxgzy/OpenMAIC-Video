'use client';

/**
 * The step-3 conversation as the browser sees it.
 *
 * Same three verbs as steps 1 and 2 — talk, confirm, withdraw — plus a read,
 * because two surfaces drive the same step (the dialog opened from the workbench,
 * and the sign-off strip itself). They live here rather than inside either surface
 * for the reason `direction-client.ts` gives: two copies of the endpoint strings is
 * how one of them ends up posting to a route that moved.
 *
 * Nothing is derived here. `gaps`, `phaseGaps`, `teachingOrder` and
 * `readyToAdvance` all come from the server, which computes them from the store. A
 * client that recomputed "the graph is connected" — or "this is the teaching
 * order" — would disagree with the gate the first time either changed.
 */
import type {
  CurriculumDependencyRecord,
  CurriculumDesignConfirmationRecord,
  CurriculumDesignPhase,
  CurriculumLearningNodeRecord,
  CurriculumNodeObjectiveRecord,
  CurriculumObjectiveRecord,
  CurriculumSupportLevel,
} from '@/lib/curriculum/design-types';
import type { KnowledgeGap, KnowledgeNodePatch } from '@/lib/curriculum/design-knowledge';
import type { KnowledgeTurnLike } from '@/lib/curriculum/knowledge-draft';

export interface KnowledgeTurn {
  role: 'user' | 'assistant';
  content: string;
}

/** What both knowledge routes answer with; the turn adds two fields to it. */
export interface KnowledgeStatePayload {
  nodes: CurriculumLearningNodeRecord[];
  nodeObjectives: CurriculumNodeObjectiveRecord[];
  objectives: CurriculumObjectiveRecord[];
  dependencies: CurriculumDependencyRecord[];
  /** Node ids in teaching sequence, derived from `dependencies` on the server. */
  teachingOrder: string[];
  gaps: KnowledgeGap[];
  findings: KnowledgeGap[];
  confirmation: CurriculumDesignConfirmationRecord | null;
  confirmed: boolean;
  nextPhase: CurriculumDesignPhase | null;
  phaseGaps: string[];
  readyToAdvance: boolean;
}

/** The shape `POST .../knowledge/turn` answers with. */
export interface KnowledgeTurnPayload extends KnowledgeStatePayload {
  message: string;
  /** What this turn could not honour, in the user's language. */
  warnings: string[];
  confirmedThisTurn: boolean;
}

const BASE = '/api/curriculum/design';

/** 起草路由的回包。`patches` 是数组而不是 Map——Map 序列化出来是 `{}`。 */
export interface KnowledgeDraftPayload extends Omit<KnowledgeTurnLike, 'patches'> {
  patches: { nodeId: string; patch: Omit<KnowledgeNodePatch, 'ref'> }[];
  instruction: string;
  currentLinks: { nodeId: string; objectiveId: string; supportLevel: CurriculumSupportLevel }[];
  nodeNameById: Record<string, string>;
  objectiveTitleById: Record<string, string>;
}

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

/** One conversational turn. The server writes the graph and answers with it. */
export function sendKnowledgeTurn(input: {
  taskId: string;
  instruction: string;
  history: KnowledgeTurn[];
}): Promise<KnowledgeTurnPayload> {
  return requestJson<KnowledgeTurnPayload>(`${BASE}/tasks/${input.taskId}/knowledge/turn`, {
    method: 'POST',
    body: JSON.stringify({ instruction: input.instruction, history: input.history }),
  });
}

/** The graph's sign-off state, for a dialog opening on an existing task. */
export function readKnowledgeState(taskId: string): Promise<KnowledgeStatePayload> {
  return requestJson<KnowledgeStatePayload>(`${BASE}/tasks/${taskId}/knowledge`);
}

/**
 * 起草，**不写库**。
 *
 * 与 {@link sendKnowledgeTurn} 的区别不是参数，是承诺：那个路由回答之前已经把这一轮
 * 写进表了，这个路由的 handler 里没有任何写调用。它回包里带的是 `KnowledgeTurnLike`
 * 的全部字段加一份"动手前的图"，正好是 {@link knowledgeDraftOf} 需要的输入。
 */
export function draftKnowledge(input: {
  taskId: string;
  instruction: string;
  history?: KnowledgeTurn[];
}): Promise<KnowledgeDraftPayload> {
  return requestJson<KnowledgeDraftPayload>(`${BASE}/tasks/${input.taskId}/knowledge/draft`, {
    method: 'POST',
    body: JSON.stringify({ instruction: input.instruction, history: input.history ?? [] }),
  });
}

export function confirmKnowledge(taskId: string, note?: string): Promise<KnowledgeStatePayload> {
  return requestJson<KnowledgeStatePayload>(`${BASE}/tasks/${taskId}/knowledge`, {
    method: 'POST',
    ...(note ? { body: JSON.stringify({ note }) } : {}),
  });
}

export function withdrawKnowledge(taskId: string): Promise<KnowledgeStatePayload> {
  return requestJson<KnowledgeStatePayload>(`${BASE}/tasks/${taskId}/knowledge`, {
    method: 'DELETE',
  });
}
