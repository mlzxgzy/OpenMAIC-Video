/**
 * 导出队列的两条入队路径与一条读取路径，在 PGlite 上跑真实存储。
 *
 * 这一层之前**一条测试都没有**：批量导出是"浏览器认领任务 → 构建 ZIP → 提交
 * 渲染"，而这三步里只有"入队"和"读取"是服务端的事。这一次改动往队列里加了一
 * 种新的来源（目工作台按 stage 导出），所以先把这个缺口补上，再钉住新路径：
 *
 * 1. **stage 入队的行长什么样。** `batch_item_id` 必须是 NULL——批量面板按
 *    `batchItemId` 过滤自己的列表，写错会让旧台账里凭空多出一条对不上课程的任务。
 * 2. **幂等。** 同一个 stage 连点两次导出不能排两个 MP4。这是"用户点两下"最
 *    常见的后果，而且症状（两份渲染账单）发生在用户看不见的地方。
 * 3. **批量那条路没被改坏。** 新分支写在函数最前面，所以它是唯一可能"顺手吞掉"
 *    旧路径形状的地方。
 * 4. **读取能筛 stage。** 目工作台只该看到这一目那几个课堂的任务。
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:export-jobs';
const OTHER = 'owner:export-jobs-other';
const DATABASE_URL = 'postgres://export-jobs';

const mocks = vi.hoisted(() => ({
  persistenceConfigured: true,
  resolveOwnerId: vi.fn(),
  provider: { current: null as null | { pool: unknown } },
}));

vi.mock('@/lib/config/feature-flags', () => ({
  isServerPersistenceConfigured: () => mocks.persistenceConfigured,
}));
vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolveOwnerId),
);
vi.mock('@/lib/server/curriculum/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/curriculum/store')>();
  return { ...actual, getCurriculumProvider: async () => mocks.provider.current };
});

import { GET, POST } from '@/app/api/curriculum/export-jobs/route';
import { PATCH } from '@/app/api/curriculum/export-jobs/[id]/route';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  createCurriculumBatch,
  createCurriculumSeries,
  listCurriculumExportJobs,
} from '@/lib/server/curriculum/store';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

function request(url: string, method: string, payload?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
}

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('导出队列路由（PGlite）', () => {
  let db: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    mocks.persistenceConfigured = true;
    mocks.resolveOwnerId.mockReturnValue(OWNER);
    mocks.provider.current = { pool };
  });

  it('gates on configured server persistence', async () => {
    mocks.persistenceConfigured = false;
    const response = await GET(request('/api/curriculum/export-jobs', 'GET'));
    expect(response.status).toBe(404);
    expect(
      (await POST(request('/api/curriculum/export-jobs', 'POST', { stageIds: ['s1'] }))).status,
    ).toBe(404);
  });

  it('queues a stage-sourced job with no batch item and the caller’s display name', async () => {
    const response = await POST(
      request('/api/curriculum/export-jobs', 'POST', {
        stageIds: ['stage-1'],
        stageTitle: '2-1-2 信息收集实操',
      }),
    );
    expect(response.status, await response.clone().text()).toBe(202);
    const { jobs } = await read<{ jobs: Array<Record<string, unknown>> }>(response);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      stageId: 'stage-1',
      batchItemId: null,
      courseId: null,
      title: '2-1-2 信息收集实操',
      status: 'queued',
      resolution: '1080p',
    });
  });

  it('falls back to a plain title when the caller sends none', async () => {
    const response = await POST(
      request('/api/curriculum/export-jobs', 'POST', { stageIds: ['stage-2'] }),
    );
    const { jobs } = await read<{ jobs: Array<{ title: string }> }>(response);
    expect(jobs[0]?.title).toBe('课堂');
  });

  /**
   * 幂等的那一面：重复请求返回**同一条**任务，而不是新建一条。
   * 这正是"用户点了两下"与"要交两份渲染账单"之间的区别。
   */
  it('returns the live job instead of queueing a second MP4 for one stage', async () => {
    const first = await POST(
      request('/api/curriculum/export-jobs', 'POST', { stageIds: ['stage-3'] }),
    );
    const second = await POST(
      request('/api/curriculum/export-jobs', 'POST', { stageIds: ['stage-3', 'stage-3'] }),
    );
    const firstJobs = (await read<{ jobs: Array<{ id: string }> }>(first)).jobs;
    const secondJobs = (await read<{ jobs: Array<{ id: string }> }>(second)).jobs;
    expect(secondJobs).toHaveLength(1);
    expect(secondJobs[0]?.id).toBe(firstJobs[0]?.id);
  });

  /**
   * 失败的任务可以被替换 —— 这是界面上"取消后能重新导出"依赖的行为。
   * 反过来说：如果 `failed` 也被当成"已有一条活任务"，取消按钮就变成了摆设。
   */
  it('replaces a cancelled job with a fresh queued one', async () => {
    const created = await POST(
      request('/api/curriculum/export-jobs', 'POST', { stageIds: ['stage-4'] }),
    );
    const jobId = (await read<{ jobs: Array<{ id: string }> }>(created)).jobs[0]!.id;
    const cancelled = await PATCH(
      request(`/api/curriculum/export-jobs/${jobId}`, 'PATCH', { action: 'cancel' }),
      { params: Promise.resolve({ id: jobId }) },
    );
    expect(cancelled.status, await cancelled.text()).toBe(200);

    const again = await POST(
      request('/api/curriculum/export-jobs', 'POST', { stageIds: ['stage-4'] }),
    );
    const jobs = (await read<{ jobs: Array<{ id: string; status: string }> }>(again)).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]?.status).toBe('queued');
    expect(jobs[0]?.id).not.toBe(jobId);
  });

  it('still queues batch items, and keeps them out of the stage filter', async () => {
    const series = await createCurriculumSeries(pool as never, OWNER, {
      name: '导出回归系列',
      description: null,
    });
    const course = await pool.query<{ id: string }>(
      `INSERT INTO curriculum_course (id, owner_id, series_id, title)
       VALUES ('course-1', $1, $2, '导出回归课') RETURNING id`,
      [OWNER, series.id],
    );
    expect(course.rows[0]?.id).toBe('course-1');
    const batch = await createCurriculumBatch(pool as never, OWNER, {
      name: '导出回归批次',
      items: [{ courseId: 'course-1', title: '第一项', request: { topic: 'x' } }],
    });
    // A batch item is only exportable once completed with a stage; that is the
    // column the legacy panel reads, so it is the one worth writing directly.
    await pool.query(
      `UPDATE curriculum_batch_item SET status = 'completed', stage_id = 'stage-batch'
        WHERE owner_id = $1 AND batch_id = $2`,
      [OWNER, batch.batch.id],
    );

    const queued = await POST(
      request('/api/curriculum/export-jobs', 'POST', { batchId: batch.batch.id }),
    );
    expect(queued.status, await queued.clone().text()).toBe(202);
    const jobs = (
      await read<{ jobs: Array<{ stageId: string; batchItemId: string | null }> }>(queued)
    ).jobs;
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ stageId: 'stage-batch' });
    expect(jobs[0]?.batchItemId).not.toBeNull();

    // 读取按 stage 筛：批量那条路排出来的任务不该出现在目工作台的列表里，
    // 除非它就是这个 stage。这一条同时钉住"筛选真的生效"。
    const filtered = await GET(request('/api/curriculum/export-jobs?stageIds=stage-1', 'GET'));
    const onlyStageOne = await read<{ jobs: Array<{ stageId: string }> }>(filtered);
    expect(onlyStageOne.jobs).toEqual([]);
    const matched = await GET(request('/api/curriculum/export-jobs?stageIds=stage-batch', 'GET'));
    expect((await read<{ jobs: unknown[] }>(matched)).jobs).toHaveLength(1);
  });

  it('never answers with another owner’s jobs', async () => {
    await POST(request('/api/curriculum/export-jobs', 'POST', { stageIds: ['stage-mine'] }));
    mocks.resolveOwnerId.mockReturnValue(OTHER);
    const response = await GET(request('/api/curriculum/export-jobs', 'GET'));
    expect((await read<{ jobs: unknown[] }>(response)).jobs).toEqual([]);
    mocks.resolveOwnerId.mockReturnValue(OWNER);
    const mine = await GET(request('/api/curriculum/export-jobs', 'GET'));
    expect((await read<{ jobs: unknown[] }>(mine)).jobs).toHaveLength(1);
  });

  it('rejects an over-long stage filter instead of silently ignoring it', async () => {
    const stageIds = Array.from({ length: 51 }, (_, index) => `stage-${index}`).join(',');
    const response = await GET(
      request(`/api/curriculum/export-jobs?stageIds=${encodeURIComponent(stageIds)}`, 'GET'),
    );
    expect(response.status).toBe(400);
  });

  /** 入队是写：它必须落到库里，而不只是回包好看。 */
  it('writes what it returns', async () => {
    const response = await POST(
      request('/api/curriculum/export-jobs', 'POST', {
        stageIds: ['stage-5'],
        stageTitle: '落库检查',
      }),
    );
    const job = (await read<{ jobs: Array<{ id: string }> }>(response)).jobs[0]!;
    const stored = await listCurriculumExportJobs(pool as never, OWNER, ['stage-5']);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({
      id: job.id,
      stageId: 'stage-5',
      title: '落库检查',
      batchItemId: null,
    });
  });
});
