/**
 * `POST /api/curriculum/design/tasks/[id]/inherit`：承接系列层目标的接口契约。
 *
 * 这一条路由是「每个目都要七步」这个问题的修法：目第 2/3 步不再从零写目标与知识
 * 点，而是从系列里挑。所以这里断言的重点全在**库里真正落了什么**：
 *
 * - 承接会建目标，并顺手给每条配一条证据（否则用户"承接完了"照样被第 2 步的门禁
 *   拦在"目标没有证据"上，承接反而制造更多工作）；
 * - 再点一次不重复建（来源 id 幂等），否则用户点两下就有两套目标；
 * - 不认识 id 时说清楚跳过了哪几条，而不是静默少写；
 * - 节点承接会按系列目标声明的支撑关系自动连线，否则第 3 步门禁报"节点不支撑任何目标"；
 * - 目标/节点确实记住了来源 id（界面靠它显示"来自系列"，系列级覆盖检查也靠它）。
 *
 * 门禁（阶段、跨系列）也在这里钉：这两个拒绝都是 store 抛的，路由必须映射成
 * 400/409 而不是 500。
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:inherit-route';
const OTHER = 'owner:inherit-route-other';
const DATABASE_URL = 'postgres://inherit-route';

const mocks = vi.hoisted(() => ({
  resolveOwnerId: vi.fn(),
  provider: {
    current: null as null | {
      pool: unknown;
      withTransaction: (body: (queryable: unknown) => Promise<unknown>) => Promise<unknown>;
    },
  },
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolveOwnerId),
);
vi.mock('@/lib/server/curriculum/design-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/curriculum/design-store')>();
  return { ...actual, getCurriculumDesignProvider: async () => mocks.provider.current };
});

import { POST as inheritRoute } from '@/app/api/curriculum/design/tasks/[id]/inherit/route';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumTask,
  getCurriculumDesignSnapshot,
} from '@/lib/server/curriculum/design-store';
import { updateSeriesDesign } from '@/lib/server/curriculum/series-design';
import { createCurriculumSeries } from '@/lib/server/curriculum/store';

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

/** 读一次 body：`response.text()` 之后再 `.json()` 会抛 "Body is unusable"。 */
async function readJson<T>(response: Response, expectedStatus: number): Promise<T> {
  const text = await response.text();
  expect(response.status, text).toBe(expectedStatus);
  return JSON.parse(text) as T;
}

function call(taskId: string, body: unknown): Promise<Response> {
  return inheritRoute(
    new NextRequest(`http://localhost/api/curriculum/design/tasks/${taskId}/inherit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: taskId }) },
  );
}

/** 一个方向完整、已确认、推进到 `outcomes` 的目。 */
async function seedTaskAtOutcomes(pool: PGlitePool, seriesId: string): Promise<string> {
  const task = await createCurriculumTask(pool, OWNER, {
    title: '1-1-1 SQL 注入原理',
    seriesId,
    audience: '大二信息安全专业学生',
    durationHours: 2,
    problemStatement: '这一目解决 SQL 注入的判断与利用',
  });
  await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
  await advanceCurriculumTaskPhase(pool, OWNER, task.id);
  return task.id;
}

describe('POST 承接系列目标与知识点', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let seriesId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    vi.clearAllMocks();
    mocks.resolveOwnerId.mockReturnValue(OWNER);
    mocks.provider.current = { pool, withTransaction: (work) => work(pool) };

    const series = await createCurriculumSeries(pool, OWNER, { name: 'CTF 综合实战' });
    seriesId = series.id;
    await updateSeriesDesign(pool, OWNER, seriesId, {
      direction: {
        audience: '大二信息安全专业学生',
        problemStatement: '整个系列要解决的问题',
        durationHours: 54,
      },
      nodes: [
        {
          id: 'sn_1',
          name: 'SQL 注入闭合方式',
          type: 'knowledge',
          summary: '单引号 / 数字型闭合的判断',
          difficulty: 'basic',
          prerequisites: [],
        },
      ],
      objectives: [
        {
          id: 'so_1',
          title: '能利用 SQL 注入读出指定数据',
          expectedBehavior: '在靶场里判断注入点并读出 flag',
          minCriteria: ['判断出注入点', '读出 flag'],
          evidence: '在 Docker 靶场中独立完成一次拖库',
          nodeIds: ['sn_1'],
        },
        {
          id: 'so_2',
          title: '能写出注入的修复建议',
          expectedBehavior: '给出一句参数化的修复方案',
          minCriteria: ['指出参数化查询'],
          evidence: '笔试',
          nodeIds: ['sn_1'],
        },
      ],
    });
  });

  it('承接目标会建目标 + 证据，并记住来源 id', async () => {
    const taskId = await seedTaskAtOutcomes(pool, seriesId);
    const response = await call(taskId, { kind: 'objectives', ids: ['so_1', 'so_2'] });
    const body = await readJson<{
      created: { id: string; title: string }[];
      skippedSeriesIds: string[];
    }>(response, 201);
    expect(body.created).toHaveLength(2);
    expect(body.skippedSeriesIds).toEqual([]);

    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    expect(snapshot.objectives.map((objective) => objective.seriesObjectiveId)).toEqual([
      'so_1',
      'so_2',
    ]);
    // 每条承接的目标都配了证据：离开第 2 步要求"每个目标都有证据"。
    const evidenced = new Set(snapshot.evidence.map((row) => row.objectiveId));
    for (const objective of snapshot.objectives) {
      expect(evidenced.has(objective.id)).toBe(true);
    }
  });

  it('再点一次不重复建（来源 id 幂等），并把跳过的条数报回来', async () => {
    const taskId = await seedTaskAtOutcomes(pool, seriesId);
    await call(taskId, { kind: 'objectives', ids: ['so_1'] });
    const again = await call(taskId, { kind: 'objectives', ids: ['so_1'] });
    const body = await readJson<{ created: unknown[]; skippedSeriesIds: string[] }>(again, 201);
    expect(body.created).toHaveLength(0);
    expect(body.skippedSeriesIds).toEqual(['so_1']);

    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    expect(snapshot.objectives).toHaveLength(1);
  });

  it('不认识的 id 被报告，而不是静默跳过', async () => {
    const taskId = await seedTaskAtOutcomes(pool, seriesId);
    const response = await call(taskId, { kind: 'objectives', ids: ['so_1', 'so_不存在'] });
    const body = await readJson<{ created: unknown[]; unknownSeriesIds: string[] }>(response, 201);
    expect(body.created).toHaveLength(1);
    expect(body.unknownSeriesIds).toEqual(['so_不存在']);
  });

  it('承接知识点会按系列目标的支撑关系自动连线', async () => {
    const taskId = await seedTaskAtOutcomes(pool, seriesId);
    // 先承接目标（第 2 步有了内容），确认后推进到第 3 步，再承接知识点。
    const objectives = await call(taskId, { kind: 'objectives', ids: ['so_1'] });
    await readJson<{ created: unknown[] }>(objectives, 201);
    await confirmCurriculumDesignStep(pool, OWNER, taskId, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, taskId);

    const response = await call(taskId, { kind: 'nodes', ids: ['sn_1'] });
    const body = await readJson<{ created: unknown[]; links: number }>(response, 201);
    expect(body.created).toHaveLength(1);
    // so_1 声明由 sn_1 支撑，所以承接节点时那条连线一起建。
    expect(body.links).toBe(1);

    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    expect(snapshot.nodes[0].seriesNodeId).toBe('sn_1');
    expect(snapshot.nodeObjectives).toHaveLength(1);
  });

  it('阶段没到就拒绝，而且是有理由的 409', async () => {
    const task = await createCurriculumTask(pool, OWNER, {
      title: '还停在第一目的目',
      seriesId,
    });
    const response = await call(task.id, { kind: 'objectives', ids: ['so_1'] });
    expect(response.status).toBe(409);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe('CURRICULUM_DESIGN_PHASE_LOCKED');
  });

  it('不属于任何系列时给 400，而不是 500', async () => {
    const standalone = await createCurriculumTask(pool, OWNER, {
      title: '独立课程',
      audience: '任何人',
      durationHours: 1,
      problemStatement: '没有系列',
    });
    await confirmCurriculumDesignStep(pool, OWNER, standalone.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, standalone.id);
    const response = await call(standalone.id, { kind: 'objectives', ids: ['so_1'] });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toContain('不属于任何系列');
  });

  it('请求体不合法时 400，一行都不写', async () => {
    const taskId = await seedTaskAtOutcomes(pool, seriesId);
    for (const body of [
      {},
      { kind: 'whatever', ids: ['so_1'] },
      { kind: 'objectives', ids: [] },
      { kind: 'objectives', ids: [''] },
    ]) {
      const response = await call(taskId, body);
      expect(response.status).toBe(400);
    }
    const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, taskId);
    expect(snapshot.objectives).toHaveLength(0);
  });

  it('跨 owner 承接别人的系列被拒', async () => {
    const taskId = await seedTaskAtOutcomes(pool, seriesId);
    mocks.resolveOwnerId.mockReturnValue(OTHER);
    const response = await call(taskId, { kind: 'objectives', ids: ['so_1'] });
    expect(response.status).toBe(404);
  });
});
