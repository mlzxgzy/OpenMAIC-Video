/**
 * 系列级设计接口的契约：方向 / 课程目标 / 知识体系，以及目对方向的继承。
 *
 * 这组用例盯的是"上三步属于系列"这件事在接口层是否真的成立：
 * - 保存方向后，新建的目自动带上授课对象与学时，不需要每目再填一遍；
 * - 系列方向在目建好之后才补，目照样能离开第 1 步（门禁查的是有效值，不是列值）；
 * - 目标与知识体系的名字引用在写入时被解析成 id，坏引用被拒；
 * - AI 起草只回草稿，**不写库**——用户看过再保存。
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:series-design';
const DATABASE_URL = 'postgres://series-design';

const mocks = vi.hoisted(() => ({
  resolveOwnerId: vi.fn(),
  resolveModel: vi.fn(),
  callLLM: vi.fn(),
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
vi.mock('@/lib/server/resolve-model', () => ({ resolveModel: mocks.resolveModel }));
vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@/lib/server/model-config/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/model-config/runtime')>();
  return { ...actual, backgroundWorkspaceId: async (ownerId: string) => ownerId };
});
vi.mock('@/lib/server/curriculum/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/curriculum/store')>();
  return {
    ...actual,
    getCurriculumProvider: async () => ({
      pool: mocks.provider.current?.pool,
      withTransaction: (body: (queryable: unknown) => Promise<unknown>) =>
        mocks.provider.current!.withTransaction(body),
    }),
  };
});

import {
  GET as getDesign,
  PATCH as patchDesign,
} from '@/app/api/curriculum/series/[id]/design/route';
import { POST as generateDesignAi } from '@/app/api/curriculum/series/[id]/design/ai/route';
import { POST as confirmDirection } from '@/app/api/curriculum/design/tasks/[id]/direction/route';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumTask,
} from '@/lib/server/curriculum/design-store';
import { createCurriculumSeries, createSeriesOutlineNode } from '@/lib/server/curriculum/store';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow extends Record<string, unknown>>(text: string, params?: unknown[]) {
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

const seriesParams = (id: string) => ({ params: Promise.resolve({ id }) });
const taskParams = (id: string) => ({ params: Promise.resolve({ id }) });

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const DESIGN_BODY = {
  direction: {
    audience: '零基础高校网络安全专业学生',
    learnerLevel: '会 Linux 基本命令',
    trainingScenario: '线下集中实训',
    applicationScene: '校内选拔赛',
    problemStatement: '覆盖 CTF 五个方向，不做内网渗透',
    durationHours: 54,
  },
  nodes: [
    {
      name: 'HTTP 请求与响应',
      type: 'knowledge',
      summary: '请求方法、状态码、Cookie',
      difficulty: 'intro',
      prerequisites: [],
    },
    {
      name: 'SQL 注入原理',
      type: 'knowledge',
      summary: '注入成因与常见手法',
      difficulty: 'basic',
      prerequisites: ['HTTP 请求与响应'],
    },
  ],
  objectives: [
    {
      title: '能独立完成入门级 Web 题',
      expectedBehavior: '独立定位并利用题目漏洞拿到 flag',
      minCriteria: ['提交的 flag 正确', 'writeup 可复现'],
      evidence: 'Web 方向综合靶场',
      nodeIds: ['HTTP 请求与响应', 'SQL 注入原理'],
    },
  ],
};

describe('series design routes (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let seriesId: string;

  beforeEach(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    mocks.resolveOwnerId.mockReturnValue(OWNER);
    mocks.callLLM.mockReset();
    mocks.resolveModel.mockResolvedValue({
      model: {},
      modelInfo: {},
      modelString: 'test/model',
      thinkingConfig: undefined,
      serverManaged: false,
    });
    mocks.provider.current = { pool, withTransaction: (body) => body(pool) };
    const series = await createCurriculumSeries(pool, OWNER, {
      name: 'CTF综合实战',
      description: '入门到实战',
    });
    seriesId = series.id;
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    await db.close();
  });

  async function getSnapshot() {
    const response = await getDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'GET'),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    return read<{
      series: { id: string; name: string };
      phase: string;
      gaps: { direction: string[]; objectives: string[]; knowledge: string[] };
      design: {
        direction: Record<string, unknown>;
        objectives: Array<{ id: string; title: string; nodeIds: string[] }>;
        nodes: Array<{ id: string; name: string; prerequisites: string[] }>;
      };
      nodeNames: Record<string, string>;
    }>(response);
  }

  it('初始状态：停在方向，缺口点名授课对象', async () => {
    const body = await getSnapshot();
    expect(body.phase).toBe('direction');
    expect(body.gaps.direction.join()).toMatch(/授课对象/);
    expect(body.gaps.objectives.join()).toMatch(/还没有课程目标/);
  });

  it('保存方向、目标与知识体系，名字引用被解析成 id', async () => {
    const patched = await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', DESIGN_BODY),
      seriesParams(seriesId),
    );
    expect(patched.status).toBe(200);
    const saved = await read<{
      phase: string;
      design: {
        objectives: Array<{ nodeIds: string[] }>;
        nodes: Array<{ id: string; prerequisites: string[] }>;
      };
      nodeNames: Record<string, string>;
    }>(patched);
    expect(saved.phase).toBe('knowledge');
    expect(saved.design.objectives[0].nodeIds).toEqual(['sn_1', 'sn_2']);
    expect(saved.design.nodes[1].prerequisites).toEqual(['sn_1']);
    expect(saved.nodeNames.sn_2).toBe('SQL 注入原理');

    const reread = await getSnapshot();
    expect(reread.design.direction.audience).toBe('零基础高校网络安全专业学生');
    expect(reread.design.objectives[0].id).toBe('so_1');
    expect(reread.gaps.direction).toEqual([]);
    expect(reread.gaps.objectives).toEqual([]);
  });

  it('课程目标没有达标线 → 400，且一行都不写', async () => {
    const response = await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        objectives: [
          {
            title: '能完成 Web 题',
            expectedBehavior: '拿到 flag',
            minCriteria: [],
            evidence: '靶场',
          },
        ],
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(400);
    const body = await readSnapshotBody(response);
    expect(body).toMatch(/最低达标标准/);
    const reread = await getSnapshot();
    expect(reread.design.objectives).toEqual([]);
  });

  it('知识点先修成环 → 400', async () => {
    const response = await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        nodes: [
          { name: 'A', type: 'knowledge', difficulty: 'basic', prerequisites: ['B'] },
          { name: 'B', type: 'knowledge', difficulty: 'basic', prerequisites: ['A'] },
        ],
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(400);
    expect(await readSnapshotBody(response)).toMatch(/成环/);
  });

  it('别的 owner 读不到这个系列', async () => {
    mocks.resolveOwnerId.mockReturnValue('owner:someone-else');
    const response = await getDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'GET'),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(404);
  });

  it('AI 起草只回草稿，不写库', async () => {
    const chapter = await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'chapter',
      title: 'Web 安全',
      code: '2',
      note: '覆盖 Web 常见漏洞',
    });
    await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'section',
      title: 'SQL 注入',
      parentId: chapter.id,
      note: '拆 3 目',
    });
    mocks.callLLM.mockResolvedValueOnce({
      text: [
        '```json',
        JSON.stringify({
          objectives: [
            {
              title: '能独立完成入门级 Web 题',
              expectedBehavior: '拿到 flag',
              minCriteria: ['flag 正确'],
              evidence: '靶场',
              nodeNames: ['SQL 注入原理'],
            },
          ],
          nodes: [
            {
              name: 'SQL 注入原理',
              type: 'knowledge',
              summary: '联合查询',
              difficulty: 'basic',
              prerequisites: [],
            },
          ],
        }),
        '```',
      ].join('\n'),
    });

    const response = await generateDesignAi(
      request(`/api/curriculum/series/${seriesId}/design/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{
      draft: {
        objectives: Array<{ title: string; nodeIds: string[] }>;
        nodes: Array<{ name: string }>;
      };
    }>(response);
    expect(body.draft.objectives[0].title).toBe('能独立完成入门级 Web 题');
    expect(body.draft.objectives[0].nodeIds).toEqual(['sn_1']);

    // 草稿没有被写进去：再读仍然是空的。
    const reread = await getSnapshot();
    expect(reread.design.objectives).toEqual([]);
    expect(reread.design.nodes).toEqual([]);
  });

  it('没有大纲时 AI 起草直接拒绝，不花模型预算', async () => {
    const response = await generateDesignAi(
      request(`/api/curriculum/series/${seriesId}/design/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(400);
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('目先建、方向后补：确认第 1 步也认系列方向', async () => {
    const chapter = await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'chapter',
      title: 'Web 安全',
      code: '2',
    });
    const section = await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'section',
      title: '信息收集',
      parentId: chapter.id,
    });
    // 系列方向还没有，目建出来时受众为空——这正是 63 个已有目的状态。
    const task = await createCurriculumTask(pool, OWNER, {
      title: '信息收集实操',
      sectionId: section.id,
      problemStatement: '学完这一目，能说清并处理：目录扫描、源码泄露',
    });
    expect(task.audience).toBeNull();

    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', DESIGN_BODY),
      seriesParams(seriesId),
    );

    // 确认路由读的是有效值（目 ?? 系列），所以不必先给目回填受众。
    const confirmed = await confirmDirection(
      request(`/api/curriculum/design/tasks/${task.id}/direction`, 'POST', {}),
      taskParams(task.id),
    );
    expect(confirmed.status).toBe(200);
    const body = await read<{ values: { audience: string | null }; gaps: string[] }>(confirmed);
    expect(body.values.audience).toBe('零基础高校网络安全专业学生');
    expect(body.gaps).toEqual([]);
  });

  it('新建的目继承系列方向；系列后补方向时门禁也认', async () => {
    // 先保存方向，再建目：创建时直接带上受众与学时。
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', DESIGN_BODY),
      seriesParams(seriesId),
    );
    const chapter = await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'chapter',
      title: 'Web 安全',
      code: '2',
    });
    const section = await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'section',
      title: '信息收集',
      parentId: chapter.id,
    });
    const task = await createCurriculumTask(pool, OWNER, {
      title: '信息收集实操',
      sectionId: section.id,
      problemStatement: '学完这一目，能说清并处理：目录扫描、源码泄露',
    });
    expect(task.audience).toBe('零基础高校网络安全专业学生');
    expect(task.learnerLevel).toBe('会 Linux 基本命令');
    expect(task.trainingScenario).toBe('线下集中实训');
    expect(task.applicationScene).toBe('校内选拔赛');
    expect(task.durationHours).toBe(54);

    // 另一条路径：目先建、方向后补，门禁读的是有效值而不是列值。
    const lateSection = await createSeriesOutlineNode(pool, OWNER, seriesId, {
      nodeType: 'section',
      title: '注入',
      parentId: chapter.id,
    });
    const lateTask = await createCurriculumTask(pool, OWNER, {
      title: 'SQL 注入',
      sectionId: lateSection.id,
      problemStatement: '学完这一目，能说清并处理：联合注入',
    });
    expect(lateTask.audience).toBe('零基础高校网络安全专业学生');
    await confirmCurriculumDesignStep(pool, OWNER, lateTask.id, 'task', 'user');
    const advanced = await advanceCurriculumTaskPhase(pool, OWNER, lateTask.id);
    expect(advanced.designPhase).toBe('outcomes');
  });
});

async function readSnapshotBody(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { message?: string } };
  return body.error?.message ?? '';
}
