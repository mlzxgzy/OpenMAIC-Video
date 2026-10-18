/**
 * `POST /api/curriculum/series/[id]/outline/ai` 的请求体。
 *
 * 单独一个模块而不是塞进 `design-validation.ts`：那一层是"设计七步"的 body
 * 校验，而这个接口是系列大纲的批量生成，错误文案与服务对象都不同。更重要的是，
 * 它只被一个路由使用——放在一个被几十个路由共享的大模块里，任何一次改动都会让
 * 所有那些路由一起重新编译。
 */
import {
  SERIES_OUTLINE_AI_LEVELS,
  type SeriesOutlineAiLevel,
} from '@/lib/curriculum/series-outline-ai';

import type { ParseResult } from './design-validation';

export interface SeriesOutlineAiRequestBody {
  level: SeriesOutlineAiLevel;
  action: 'preview' | 'commit';
  /** 覆盖重建这一层；缺省是只补空位。 */
  replace: boolean;
  /** preview 返回的计划，commit 时原样带回；preview 请求不需要它。 */
  plan?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * 只有 `commit` 需要 `plan`：模型只在 preview 里被调用一次，commit 只是把用户
 * **看过的那份计划**落库。这样"提交"不会再花一次模型预算，也不会出现用户点了
 * 两次、两次生成不一样的情况。
 */
export function parseSeriesOutlineAiRequest(
  body: unknown,
): ParseResult<SeriesOutlineAiRequestBody> {
  if (!isRecord(body)) return { ok: false, message: '请求体必须是一个 JSON 对象' };
  const errors: string[] = [];

  const levelRaw = body.level;
  const level =
    typeof levelRaw === 'string' &&
    (SERIES_OUTLINE_AI_LEVELS as readonly string[]).includes(levelRaw)
      ? (levelRaw as SeriesOutlineAiLevel)
      : undefined;
  if (level === undefined) {
    errors.push(
      levelRaw === undefined
        ? 'level 为必填'
        : `level 只能是以下之一：${SERIES_OUTLINE_AI_LEVELS.join(', ')}`,
    );
  }

  const actionRaw = body.action;
  const action = actionRaw === 'preview' || actionRaw === 'commit' ? actionRaw : undefined;
  if (action === undefined) {
    errors.push(
      actionRaw === undefined ? 'action 为必填' : 'action 只能是以下之一：preview, commit',
    );
  }

  const replaceRaw = body.replace;
  let replace = false;
  if (replaceRaw !== undefined) {
    if (typeof replaceRaw !== 'boolean') {
      errors.push('replace 必须是 true 或 false');
    } else {
      replace = replaceRaw;
    }
  }

  if (errors.length > 0) return { ok: false, message: errors.join('; ') };
  if (action === 'commit') {
    if (
      body.plan === undefined ||
      body.plan === null ||
      typeof body.plan !== 'object' ||
      Array.isArray(body.plan)
    ) {
      return { ok: false, message: 'commit 必须带回 preview 返回的 plan 对象' };
    }
  }
  if (!level || !action) return { ok: false, message: 'level、action 均为必填' };
  return { ok: true, value: { level, action, replace, plan: body.plan } };
}
