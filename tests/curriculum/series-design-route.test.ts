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
import { POST as generateDirectionAi } from '@/app/api/curriculum/series/[id]/design/direction/ai/route';
import { POST as generateObjectivesAi } from '@/app/api/curriculum/series/[id]/design/objectives/ai/route';
import { POST as generateKnowledgeAi } from '@/app/api/curriculum/series/[id]/design/knowledge/ai/route';
import { POST as confirmDirection } from '@/app/api/curriculum/design/tasks/[id]/direction/route';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumTask,
} from '@/lib/server/curriculum/design-store';
import {
  createCurriculumSeries,
  createSeriesOutlineNode,
  updateSeriesOutlineNode,
} from '@/lib/server/curriculum/store';

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

const OBJECTIVE_CANDIDATES = [
  {
    title: '能交付一份可复现的 Writeup',
    type: 'task',
    expectedBehavior: '写完别人能照着复现',
    minCriteria: ['步骤可复现'],
    evidence: '作品评分',
  },
  {
    title: '能用 sqlmap 完成联合注入',
    type: 'skill',
    expectedBehavior: '独立跑完并取出数据',
    minCriteria: ['拿到目标表内容'],
    evidence: '靶场实操',
  },
  {
    title: '能解释注入成因',
    type: '知识',
    expectedBehavior: '说清触发条件',
    minCriteria: ['三类成因说对'],
    evidence: '理论题',
  },
  {
    title: '能独立拿下陌生靶场',
    type: '能力',
    expectedBehavior: '从信息收集走到拿 flag',
    minCriteria: ['60 分钟内拿 flag'],
    evidence: '综合靶场',
  },
  {
    title: '能说出三种编码的区别',
    type: 'knowledge',
    expectedBehavior: '举例说明',
    minCriteria: ['三类编码举例正确'],
    evidence: '理论题',
  },
  {
    title: '能独立完成目录扫描',
    type: 'skill',
    expectedBehavior: '扫出隐藏目录',
    minCriteria: ['找到至少一个隐藏目录'],
    evidence: '靶场实操',
  },
  {
    title: '能完成一套入门赛题',
    type: 'task',
    expectedBehavior: '限时独立完成',
    minCriteria: ['拿到至少 3 个 flag'],
    evidence: '模拟赛',
  },
  {
    title: '能解释同源策略',
    type: 'knowledge',
    expectedBehavior: '说清限制范围',
    minCriteria: ['能判断哪些请求会被拦'],
    evidence: '理论题',
  },
] as const;

/**
 * 第 3 步的候选：10 个点，知识在前、技能在后，故意包含两个已有节点的重名
 * （`HTTP 请求与响应` / `SQL 注入原理`），用来验证"重复候选被筛掉"。
 */
const KNOWLEDGE_CANDIDATES = [
  {
    name: 'SQL 注入原理',
    type: 'knowledge',
    summary: '注入成因与常见手法',
    difficulty: 'basic',
    prerequisites: [],
  },
  {
    name: 'HTTP 请求与响应',
    type: '知识',
    summary: '请求方法、状态码、Cookie',
    difficulty: '入门',
    prerequisites: [],
  },
  {
    name: '联合注入',
    type: 'knowledge',
    summary: 'UNION 回显的构造',
    difficulty: 'intermediate',
    prerequisites: ['SQL 注入原理'],
  },
  {
    name: 'RSA 数论基础',
    type: 'knowledge',
    summary: '模运算与欧拉函数',
    difficulty: 'advanced',
    prerequisites: [],
  },
  {
    name: '用 sqlmap 完成联合注入',
    type: 'skill',
    summary: '跑通 sqlmap 并取出目标表数据',
    difficulty: 'basic',
    prerequisites: ['联合注入'],
  },
  {
    name: '目录扫描',
    type: 'skill',
    summary: '用 ffuf 扫出隐藏目录',
    difficulty: 'basic',
    prerequisites: ['HTTP 请求与响应'],
  },
  {
    name: '抓包分析',
    type: 'skill',
    summary: '用 Wireshark 过滤并提取文件',
    difficulty: 'intermediate',
    prerequisites: [],
  },
  {
    name: '编写 Writeup',
    type: 'skill',
    summary: '把解题过程写成别人能复现的文档',
    difficulty: 'advanced',
    prerequisites: [],
  },
  {
    name: '栈溢出利用',
    type: 'skill',
    summary: '覆盖返回地址并跳转后门',
    difficulty: 'advanced',
    prerequisites: [],
  },
  {
    name: '编码识别',
    type: 'knowledge',
    summary: 'Base / URL / Unicode 的识别',
    difficulty: 'intro',
    prerequisites: [],
  },
] as const;

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
      coverage: {
        objectives: { total: number; unclaimed: number; titles: string[] };
        nodes: { total: number; unclaimed: number; names: string[] };
      };
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

  it('没有大纲也能起草：设计先行，提示词明说落点待大纲建好后校验', async () => {
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify({
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
    });

    const response = await generateDesignAi(
      request(`/api/curriculum/series/${seriesId}/design/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    expect(mocks.callLLM).toHaveBeenCalledTimes(1);
    const call = mocks.callLLM.mock.calls[0][0] as { prompt: string };
    // 没有大纲不是拒绝的理由；但提示词必须承认"没有核对过落点"，
    // 否则模型会假装自己落回过一份不存在的大纲。
    expect(call.prompt).toContain('还没有大纲');
    expect(call.prompt).toContain('落点');
    const body = await read<{ draft: { objectives: Array<{ title: string }> } }>(response);
    expect(body.draft.objectives[0]?.title).toBe('能独立完成入门级 Web 题');
  });

  it('AI 填写方向：只回草稿、不写库，槽位被规范化', async () => {
    mocks.callLLM.mockResolvedValueOnce({
      text: [
        '```json',
        JSON.stringify({
          direction: {
            audience: '零基础高校网络安全专业学生',
            learnerLevel: '会 Linux 基本命令',
            trainingScenario: '线下集中实训 + 线上自学',
            applicationScene: '校内选拔赛 / 校队集训',
            problemStatement: '覆盖 CTF 五个方向，不做真实攻防演练',
            // 中文对话里模型常把单位带上；这里必须收成数字，否则整格被丢。
            durationHours: '54 学时',
            notes: '模型自造的键必须被丢掉',
          },
        }),
        '```',
      ].join('\n'),
    });

    const response = await generateDirectionAi(
      request(`/api/curriculum/series/${seriesId}/design/direction/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{
      direction: {
        audience: string;
        durationHours: number;
        problemStatement: string;
        [key: string]: unknown;
      };
    }>(response);
    expect(body.direction.audience).toBe('零基础高校网络安全专业学生');
    expect(body.direction.durationHours).toBe(54);
    expect(body.direction.problemStatement).toContain('不做真实攻防演练');
    expect(body.direction).not.toHaveProperty('notes');

    // 草稿不是写入：再读接口，方向仍然是空的。
    const reread = await getSnapshot();
    expect(reread.design.direction).toMatchObject({ audience: null, durationHours: null });
  });

  it('AI 填写方向：把用户已经写下的方向送进提示词，让模型保留而不是覆盖', async () => {
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        direction: { audience: '计算机学院大三学生', learnerLevel: '会 Python 基础' },
      }),
      seriesParams(seriesId),
    );
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify({
        direction: {
          audience: '计算机学院大三学生',
          learnerLevel: '会 Python 基础',
          trainingScenario: '线上自学',
          applicationScene: '校队选拔',
          problemStatement: '面向校赛的 Web 与 Misc 入门训练，不做内网渗透',
          durationHours: 32,
        },
      }),
    });

    const response = await generateDirectionAi(
      request(`/api/curriculum/series/${seriesId}/design/direction/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const call = mocks.callLLM.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('计算机学院大三学生');
    expect(call.prompt).toContain('会 Python 基础');
  });

  it('AI 填写方向：没有授课对象时回 502，而不是存一份没有"谁学"的草稿', async () => {
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({ direction: { trainingScenario: '线上自学' } }),
    });
    const response = await generateDirectionAi(
      request(`/api/curriculum/series/${seriesId}/design/direction/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(502);
  });

  it('AI 生成课程目标候选：只回候选、不写库，中文类型收成枚举并按类型排序', async () => {
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify({ objectives: OBJECTIVE_CANDIDATES }),
    });
    const response = await generateObjectivesAi(
      request(`/api/curriculum/series/${seriesId}/design/objectives/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{ candidates: Array<{ title: string; type: string }> }>(response);
    expect(body.candidates.map((candidate) => candidate.type)).toEqual([
      'knowledge',
      'knowledge',
      'knowledge',
      'skill',
      'skill',
      'competency',
      'task',
      'task',
    ]);
    // 提示词把方向带进去了：候选目标是「这门系列要兑现什么」。
    const call = mocks.callLLM.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('授课对象');
    expect(call.prompt).toContain('18–28');
    // 候选不是写入：设计里仍然没有目标。
    const reread = await getSnapshot();
    expect(reread.design.objectives).toEqual([]);
  });

  it('AI 生成候选：已有目标进提示词，重复的候选被筛掉', async () => {
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        direction: { audience: '计算机学院大三学生' },
        objectives: [
          {
            title: '能解释注入成因',
            type: '知识',
            expectedBehavior: '说清触发条件',
            minCriteria: ['三类成因说对'],
            evidence: '理论题',
          },
        ],
      }),
      seriesParams(seriesId),
    );
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify({ objectives: OBJECTIVE_CANDIDATES }),
    });
    const response = await generateObjectivesAi(
      request(`/api/curriculum/series/${seriesId}/design/objectives/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{ candidates: Array<{ title: string }> }>(response);
    expect(body.candidates.some((candidate) => candidate.title === '能解释注入成因')).toBe(false);
    expect(body.candidates.length).toBeGreaterThanOrEqual(6);
    const call = mocks.callLLM.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('计算机学院大三学生');
    expect(call.prompt).toContain('能解释注入成因');
  });

  it('AI 生成候选：可用候选太少 → 502，而不是收下一小撮', async () => {
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({ objectives: OBJECTIVE_CANDIDATES.slice(0, 2) }),
    });
    const response = await generateObjectivesAi(
      request(`/api/curriculum/series/${seriesId}/design/objectives/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(502);
    expect(await readSnapshotBody(response)).toMatch(/至少 6 条/);
  });

  it('AI 生成知识体系候选：没有课程目标时 409，不调用模型', async () => {
    const response = await generateKnowledgeAi(
      request(`/api/curriculum/series/${seriesId}/design/knowledge/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(409);
    expect(await readSnapshotBody(response)).toMatch(/还没有课程目标/);
    // 前置条件不满足时不该烧一次模型调用。
    expect(mocks.callLLM).not.toHaveBeenCalled();
  });

  it('AI 生成知识体系候选：依据课程目标，只回候选不写库，按类型排序', async () => {
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        direction: DESIGN_BODY.direction,
        objectives: [
          {
            title: '能独立完成入门级 Web 题',
            type: '能力',
            expectedBehavior: '独立定位并利用题目漏洞拿到 flag',
            minCriteria: ['提交的 flag 正确'],
            evidence: 'Web 方向综合靶场',
          },
        ],
      }),
      seriesParams(seriesId),
    );
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify({ nodes: KNOWLEDGE_CANDIDATES }),
    });

    const response = await generateKnowledgeAi(
      request(`/api/curriculum/series/${seriesId}/design/knowledge/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{ candidates: Array<{ name: string; type: string }> }>(response);
    expect(body.candidates).toHaveLength(10);
    // 类型 / 难度两种写法都收成枚举，知识全部排在技能前面。
    const types = body.candidates.map((candidate) => candidate.type);
    expect(types.lastIndexOf('knowledge')).toBeLessThan(types.indexOf('skill'));

    // 提示词把第 2 步的目标与方向带进去了：知识体系是它们的支撑。
    const call = mocks.callLLM.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('能独立完成入门级 Web 题');
    expect(call.prompt).toContain('授课对象');
    expect(call.prompt).toContain('先修');

    // 候选不是写入：知识体系里仍然没有节点。
    const reread = await getSnapshot();
    expect(reread.design.nodes).toEqual([]);
  });

  it('AI 生成知识体系候选：已有节点进提示词，重复的候选被筛掉', async () => {
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', DESIGN_BODY),
      seriesParams(seriesId),
    );
    mocks.callLLM.mockResolvedValueOnce({
      text: JSON.stringify({ nodes: KNOWLEDGE_CANDIDATES }),
    });

    const response = await generateKnowledgeAi(
      request(`/api/curriculum/series/${seriesId}/design/knowledge/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{ candidates: Array<{ name: string }> }>(response);
    // DESIGN_BODY 里已有「HTTP 请求与响应」「SQL 注入原理」两个节点。
    expect(body.candidates).toHaveLength(8);
    expect(
      body.candidates.some(
        (candidate) => candidate.name === 'HTTP 请求与响应' || candidate.name === 'SQL 注入原理',
      ),
    ).toBe(false);
    const call = mocks.callLLM.mock.calls[0][0] as { prompt: string };
    expect(call.prompt).toContain('HTTP 请求与响应');
    expect(call.prompt).toContain('SQL 注入原理');
  });

  it('AI 生成知识体系候选：可用候选太少 → 502，而不是收下一小撮', async () => {
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', DESIGN_BODY),
      seriesParams(seriesId),
    );
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify({ nodes: KNOWLEDGE_CANDIDATES.slice(0, 3) }),
    });
    const response = await generateKnowledgeAi(
      request(`/api/curriculum/series/${seriesId}/design/knowledge/ai`, 'POST', {}),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(502);
    expect(await readSnapshotBody(response)).toMatch(/至少 8 个/);
  });

  it('保存带类型的课程目标：类型落库，读回来还是它；乱写的类型 400', async () => {
    const saved = await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        objectives: [
          {
            title: '能独立拿下陌生靶场',
            type: '能力',
            expectedBehavior: '从信息收集走到拿 flag',
            minCriteria: ['60 分钟内拿 flag'],
            evidence: '综合靶场',
          },
        ],
      }),
      seriesParams(seriesId),
    );
    expect(saved.status).toBe(200);
    const reread = await getSnapshot();
    expect(reread.design.objectives[0]).toMatchObject({ type: 'competency' });

    const rejected = await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', {
        objectives: [{ ...reread.design.objectives[0], type: '玄学' }],
      }),
      seriesParams(seriesId),
    );
    expect(rejected.status).toBe(400);
    expect(await readSnapshotBody(rejected)).toMatch(/类型/);
  });

  it('落点覆盖：只认本系列目里的承接，别的系列的声明不算', async () => {
    await patchDesign(
      request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', DESIGN_BODY),
      seriesParams(seriesId),
    );
    const fresh = await getSnapshot();
    expect(fresh.coverage.objectives).toMatchObject({ total: 1, unclaimed: 1 });
    expect(fresh.coverage.nodes).toMatchObject({ total: 2, unclaimed: 2 });

    // 另一个系列里也有目声明了同一个系列知识点：不能给它算落点。
    const other = await createCurriculumSeries(pool, OWNER, { name: '另一个系列' });
    const otherTask = await createCurriculumTask(pool, OWNER, {
      seriesId: other.id,
      title: '别的系列的一目',
    });
    await pool.query(
      `INSERT INTO curriculum_objective
         (id, owner_id, task_id, title, objective_type, expected_behavior, series_objective_id)
       VALUES ('obj_other', $1, $2, '别人的目标', 'knowledge', '', 'so_1')`,
      [OWNER, otherTask.id],
    );
    await pool.query(
      `INSERT INTO curriculum_learning_node
         (id, owner_id, task_id, name, node_type, series_node_id)
       VALUES ('node_other', $1, $2, '别人的知识点', 'knowledge', 'sn_1')`,
      [OWNER, otherTask.id],
    );
    const stillUnclaimed = await getSnapshot();
    expect(stillUnclaimed.coverage.objectives.unclaimed).toBe(1);
    expect(stillUnclaimed.coverage.nodes.unclaimed).toBe(2);

    // 本系列的目承接一条目标与一个知识点后，只剩没被承接的那些。
    const task = await createCurriculumTask(pool, OWNER, {
      seriesId,
      title: '本系列的一目',
    });
    await pool.query(
      `INSERT INTO curriculum_objective
         (id, owner_id, task_id, title, objective_type, expected_behavior, series_objective_id)
       VALUES ('obj_own', $1, $2, '承接下来的目标', 'knowledge', '', 'so_1')`,
      [OWNER, task.id],
    );
    await pool.query(
      `INSERT INTO curriculum_learning_node
         (id, owner_id, task_id, name, node_type, series_node_id)
       VALUES ('node_own', $1, $2, '承接下来的知识点', 'knowledge', 'sn_1')`,
      [OWNER, task.id],
    );
    const covered = await getSnapshot();
    expect(covered.coverage.objectives).toMatchObject({ total: 1, unclaimed: 0 });
    expect(covered.coverage.nodes).toMatchObject({ total: 2, unclaimed: 1 });
    expect(covered.coverage.nodes.names).toEqual(['SQL 注入原理']);
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

  /**
   * 设计变了之后的提示：推导出来的大纲与目必须记得"当时是哪一版设计"。
   *
   * 这组用例盯的是**提示的依据**，不是文案：
   * - 设计一改，按旧版生成的章 / 节 / 目都算过期，数量分类给出；
   * - 内容没变的重存不算（指纹按内容算，不按保存时间）；
   * - 手写 / 导入的行没有指纹，**永远不**被标成旧版——对来源不明的内容喊过期，
   *   用户没法用"重新生成"消掉它；
   * - 人改过标题或交底，那一行就不再算旧版（它已经被改对了）。
   */
  describe('系列设计变更后的过期提示（PGlite）', () => {
    async function saveDesign(body: unknown) {
      const response = await patchDesign(
        request(`/api/curriculum/series/${seriesId}/design`, 'PATCH', body),
        seriesParams(seriesId),
      );
      expect(response.status).toBe(200);
      return read<{
        designFingerprint: string;
        series: { designUpdatedAt: string | null };
        outlineDrift: {
          designUpdatedAt: string | null;
          fingerprint: string;
          stale: { chapters: number; sections: number; items: number };
          total: { chapters: number; sections: number; items: number };
        };
      }>(response);
    }

    async function seedDerivedOutline(fingerprint: string) {
      const chapter = await createSeriesOutlineNode(pool, OWNER, seriesId, {
        nodeType: 'chapter',
        title: 'Web 安全',
        note: '覆盖信息收集、注入与文件漏洞',
        designFingerprint: fingerprint,
      });
      const section = await createSeriesOutlineNode(pool, OWNER, seriesId, {
        nodeType: 'section',
        title: '信息收集',
        parentId: chapter.id,
        designFingerprint: fingerprint,
      });
      const item = await createCurriculumTask(pool, OWNER, {
        title: '信息收集实操',
        sectionId: section.id,
        designFingerprint: fingerprint,
      });
      return { chapter, section, item };
    }

    it('设计一改，按旧版生成的章 / 节 / 目都报过期', async () => {
      const first = await saveDesign(DESIGN_BODY);
      await seedDerivedOutline(first.designFingerprint);

      // 手写一行：没有指纹，不参与过期判断。
      await createSeriesOutlineNode(pool, OWNER, seriesId, {
        nodeType: 'chapter',
        title: '手工补的章',
      });

      const changed = await saveDesign({
        direction: { ...DESIGN_BODY.direction, audience: '改过的授课对象' },
      });
      expect(changed.designFingerprint).not.toBe(first.designFingerprint);
      expect(changed.series.designUpdatedAt).toBeTruthy();
      expect(changed.outlineDrift.designUpdatedAt).toBe(changed.series.designUpdatedAt);
      expect(changed.outlineDrift.stale).toEqual({ chapters: 1, sections: 1, items: 1 });
      expect(changed.outlineDrift.total).toEqual({ chapters: 2, sections: 1, items: 1 });

      // 读接口与保存接口同一口径（驾驶舱读 /outline，设计页读 /design）。
      const got = await getDesign(
        request(`/api/curriculum/series/${seriesId}/design`, 'GET'),
        seriesParams(seriesId),
      );
      const gotBody = await read<{
        outlineDrift: { stale: { chapters: number; sections: number; items: number } };
      }>(got);
      expect(gotBody.outlineDrift.stale).toEqual({ chapters: 1, sections: 1, items: 1 });
    });

    it('内容没变的重存不会把大纲标成过期：指纹按内容算，不按保存时间', async () => {
      const first = await saveDesign(DESIGN_BODY);
      await seedDerivedOutline(first.designFingerprint);
      const again = await saveDesign(DESIGN_BODY);
      expect(again.designFingerprint).toBe(first.designFingerprint);
      expect(again.outlineDrift.stale).toEqual({ chapters: 0, sections: 0, items: 0 });
    });

    it('人改过标题或交底后，那一行就不再算旧版', async () => {
      const first = await saveDesign(DESIGN_BODY);
      const { chapter } = await seedDerivedOutline(first.designFingerprint);
      await saveDesign({ direction: { ...DESIGN_BODY.direction, audience: '又改了一版对象' } });

      const edited = await updateSeriesOutlineNode(pool, OWNER, seriesId, chapter.id, {
        note: '人工按新设计改写的交底',
      });
      expect(edited.designFingerprint).toBeNull();
      const got = await getDesign(
        request(`/api/curriculum/series/${seriesId}/design`, 'GET'),
        seriesParams(seriesId),
      );
      const body = await read<{
        outlineDrift: { stale: { chapters: number; sections: number; items: number } };
      }>(got);
      expect(body.outlineDrift.stale).toEqual({ chapters: 0, sections: 1, items: 1 });
    });
  });
});

async function readSnapshotBody(response: Response): Promise<string> {
  const body = (await response.json()) as { error?: { message?: string } };
  return body.error?.message ?? '';
}
