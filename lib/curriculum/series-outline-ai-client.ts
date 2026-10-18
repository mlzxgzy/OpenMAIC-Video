'use client';

/**
 * 系列大纲 AI 生成的两个请求：预览、写入。
 *
 * 与 `outline-client.ts` 同一个理由：请求字符串只在这里出现一次，两个界面
 * （驾驶舱的空态卡片和看板上方的工具条）调同一份代码，改路由时不会漏掉一个。
 *
 * 这里不复制任何规则。"覆盖能不能选"、"哪些章有空位"都由服务端算，客户端只
 * 渲染服务端给的 `summary`——界面自己算一份的话，预览和写入会给出不同结论。
 */
import type {
  SeriesOutlineAiAppliedSummary,
  SeriesOutlineAiDesignSummary,
  SeriesOutlineAiLevel,
  SeriesOutlineAiMode,
  SeriesOutlineAiPlan,
  SeriesOutlineAiSummary,
} from '@/lib/curriculum/series-outline-ai';

export interface SeriesOutlineAiPreviewResponse {
  preview: SeriesOutlineAiSummary;
  /** 预检已经拒绝时为空：没有计划可以写入。 */
  plan: SeriesOutlineAiPlan | null;
  /** 这次依据的系列设计（服务端算的完成度与缺口）；界面只渲染，不重算。 */
  design: SeriesOutlineAiDesignSummary;
}

export interface SeriesOutlineAiCommitResponse {
  committed: SeriesOutlineAiAppliedSummary;
  preview: SeriesOutlineAiSummary;
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

const BASE = '/api/curriculum/series';

/** 只解析 + 算计划，不写库。 */
export function previewSeriesOutlineAi(input: {
  seriesId: string;
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
}): Promise<SeriesOutlineAiPreviewResponse> {
  return requestJson<SeriesOutlineAiPreviewResponse>(`${BASE}/${input.seriesId}/outline/ai`, {
    method: 'POST',
    body: JSON.stringify({
      level: input.level,
      action: 'preview',
      replace: input.mode === 'replace',
    }),
  });
}

/** 把用户看过的那份计划写进库；不再调模型。 */
export function commitSeriesOutlineAi(input: {
  seriesId: string;
  level: SeriesOutlineAiLevel;
  mode: SeriesOutlineAiMode;
  plan: SeriesOutlineAiPlan;
}): Promise<SeriesOutlineAiCommitResponse> {
  return requestJson<SeriesOutlineAiCommitResponse>(`${BASE}/${input.seriesId}/outline/ai`, {
    method: 'POST',
    body: JSON.stringify({
      level: input.level,
      action: 'commit',
      replace: input.mode === 'replace',
      plan: input.plan,
    }),
  });
}

/**
 * 生成用的系列说明。
 *
 * 单独一个 PATCH 而不是塞进生成请求：说明是系列自己的字段，用户在这里改完，
 * 系列设置里应该也看得到；如果只作为一次生成的参数，第二次生成时它就丢了。
 */
export async function saveSeriesDescription(
  seriesId: string,
  description: string | null,
): Promise<void> {
  await requestJson<{ series: unknown }>(`${BASE}/${seriesId}`, {
    method: 'PATCH',
    body: JSON.stringify({ description }),
  });
}
