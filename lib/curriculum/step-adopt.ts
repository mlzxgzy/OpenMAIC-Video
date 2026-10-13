'use client';

/**
 * 采纳一行草稿 = 发出 {@link resolveStepLineWrite} 算出的那些写入，并回报结果。
 *
 * 这个文件是 B2 试点里 `adoptKnowledgeDraftLine` 的**引擎版本**。它与那版有一条根本
 * 区别：不再认识任何领域概念。领域含义（"连线是整表替换""证据要跟着目标建"）都在服务端
 * 算草稿时变成了一串普通的写入，所以这里只剩下一件事——**按顺序把它们发出去**，把第一跳
 * 产出的 id 填进后续跳。
 *
 * 三条刻意的决定：
 *
 * 1. **失败抛回右栏，不吞。** B2 的 e2e 逮到一个真 bug：`run()` 把失败吞进页面的错误条然后
 *    正常返回，于是右栏会一边显示"已采纳这一行，左栏已经改好"、一边库是空的。采纳记录与
 *    存储必须由**同一次结果**决定，所以这里抛。
 * 2. **一行的多跳要么都成，要么报错。** 不回滚——已经写进去的目标是真的写进去了，把它删掉
 *    是第二次写入，而删除同样会失败。这里做的是**说实话**：报"第 2 跳失败"，作者知道目标
 *    建出来了、证据没建成，可以单独补。假装整行没发生会让作者以为重按一次就行，于是建出
 *    两个目标。
 * 3. **不经过工作台的 `run`**，理由同 1。
 */

import {
  resolveStepLineWrite,
  substituteFreshId,
  type StepDraftLine,
  type StepDraftLive,
  type StepDraftState,
} from '@/lib/curriculum/step-draft';

interface WriteResponse {
  ok: boolean;
  /** 第一跳的响应，用来取新行的真实 id。 */
  payload: unknown;
  error: string | null;
}

async function send(route: string, init: RequestInit): Promise<WriteResponse> {
  const response = await fetch(route, {
    credentials: 'same-origin',
    cache: 'no-store',
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  const payload = (await response.json().catch(() => null)) as {
    error?: { message?: string };
  } | null;
  if (!response.ok) {
    return {
      ok: false,
      payload: null,
      error: payload?.error?.message ?? `请求失败：HTTP ${response.status}`,
    };
  }
  return { ok: true, payload, error: null };
}

/** 从回包里取出新行的 id，键由草稿给出（`objective`、`unit`、`node`…）。 */
function pickId(payload: unknown, idKey: string): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  const row = record[idKey];
  if (typeof row === 'object' && row !== null) {
    const id = (row as Record<string, unknown>).id;
    if (typeof id === 'string' && id !== '') return id;
  }
  const direct = record.id;
  return typeof direct === 'string' && direct !== '' ? direct : null;
}

/**
 * 采纳一行，返回它产出的真实 id（没有产出则为 null）。
 *
 * 抛出的错误里**已经带上了人的说法**（"第 2 跳失败：…"），因为右栏把它原样显示，而作者
 * 需要知道的是"哪一跳"——"请求失败：HTTP 500"对他没有任何用处。
 */
export async function applyStepLineWrites(input: {
  line: StepDraftLine;
  state: Pick<StepDraftState, 'producedIds' | 'edits' | 'statuses'>;
  live: StepDraftLive;
}): Promise<string | null> {
  const { line } = input;
  const { write, producedIdKey } = resolveStepLineWrite(line, input.state, input.live);

  const first = await send(write.route, {
    method: write.method,
    ...(write.body === undefined ? {} : { body: JSON.stringify(write.body) }),
  });
  if (!first.ok) {
    throw new Error(
      write.then && write.then.length > 0 ? `第 1 跳失败：${first.error}` : (first.error as string),
    );
  }

  const produced = producedIdKey === null ? null : pickId(first.payload, producedIdKey);

  // 第二跳要第一跳的 id，而这个 id 只有在第一跳成功之后才存在——所以它不能和第一跳
  // 一起算出来，必须在这里填。
  const followers = [...(write.then ?? []), ...(write.thenAfter ?? [])];
  for (const [index, follow] of followers.entries()) {
    if (produced === null) {
      throw new Error(`第 ${index + 2} 跳失败：新建的行没有返回 id，无法挂上它要带的东西。`);
    }
    // `thenAfter` 的 body 不含 `#id`（它看到的是新建之前的库），所以这里是空操作——
    // 统一走一次替换比分成两条路径更不容易漏。
    const next = await send(follow.route, {
      method: follow.method,
      body: JSON.stringify(substituteFreshId(follow.body, produced)),
    });
    if (!next.ok) {
      throw new Error(`第 ${index + 2} 跳失败：${next.error}`);
    }
  }

  if (producedIdKey !== null && produced === null) {
    // 写成功了但取不到 id：后续依赖这一行的行会因此填不上，而那个失败会出现在别处。
    // 在这里说清楚，比让作者在别处遇到一个与建议无关的错误要好。
    throw new Error('这一行已经写进库里，但没有取到它的 id。');
  }
  return produced;
}
