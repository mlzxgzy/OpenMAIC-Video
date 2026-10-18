/**
 * 系列大纲（章 / 节）与"在节里建目"的接口契约。
 *
 * 这一层的核心承诺只有一条：**章和节能在任何目之前存在**。它看起来像一句废话，
 * 但上一版没有这层——驾驶舱按目编号前缀猜章，用户被要求先写一个目。所以这里的
 * 用例先建出空章空节、再挂目，而不是反过来。
 *
 * 另外三类失败必须钉住：
 * - 编号在系列内唯一（建两章都叫 `1` 会毁掉"对着大纲核数"的用途）；
 * - 导入只在空系列上跑（重复导入会得到两套 `1-1-1`）；
 * - 删节不删目（`ON DELETE SET NULL` 是"分类可变、教学单元不可丢"的实现）。
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const OWNER = 'owner:series-outline';
const DATABASE_URL = 'postgres://series-outline';

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
// The series-level PATCH route goes through the *curriculum product* provider,
// not the design provider. Substituting only the design one left that route
// reaching for a real Postgres it does not have in this test.
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
  GET as getOutline,
  POST as postNode,
} from '@/app/api/curriculum/series/[id]/outline/route';
import {
  DELETE as deleteNode,
  PATCH as patchNode,
} from '@/app/api/curriculum/series/[id]/outline/[nodeId]/route';
import { POST as importOutline } from '@/app/api/curriculum/series/[id]/outline/import/route';
import { GET as overview } from '@/app/api/curriculum/design/overview/route';
import { POST as createTask } from '@/app/api/curriculum/design/tasks/route';
import { PATCH as patchSeries } from '@/app/api/curriculum/series/[id]/route';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import { createCurriculumSeries, listSeriesOutline } from '@/lib/server/curriculum/store';

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

const seriesParams = (id: string) => ({ params: Promise.resolve({ id }) });
const nodeParams = (id: string, nodeId: string) => ({
  params: Promise.resolve({ id, nodeId }),
});

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

const OUTLINE = [
  '# CTF 基础与工具环境',
  '## CTF 入门与赛制',
  '- 1-1-1 | CTF概述与竞赛形式 | 理论 | 1 | CTF起源、flag格式',
  '- 1-1-2 | 竞赛平台与提交实操 | 实操 | 1 | 平台注册、flag提交',
  '## Linux 与网络基础',
  '- 1-2-1 | Linux 基础与权限 | 理论 | 1 | 文件、目录、权限',
].join('\n');

describe('series outline routes (PGlite)', () => {
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
    mocks.provider.current = { pool, withTransaction: (body) => body(pool) };
    const series = await createCurriculumSeries(pool, OWNER, {
      name: 'CTF综合实战',
      audience: '零基础高校网络安全专业学生',
      defaultHours: 1,
    });
    seriesId = series.id;
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    await db.close();
  });

  async function createChapter(title = 'CTF 基础与工具环境', code?: string): Promise<string> {
    const response = await postNode(
      request(`/api/curriculum/series/${seriesId}/outline`, 'POST', {
        nodeType: 'chapter',
        title,
        ...(code ? { code } : {}),
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(201);
    const body = await read<{ node: { id: string; code: string | null } }>(response);
    return body.node.id;
  }

  async function createSection(parentId: string, title = 'CTF 入门与赛制'): Promise<string> {
    const response = await postNode(
      request(`/api/curriculum/series/${seriesId}/outline`, 'POST', {
        nodeType: 'section',
        parentId,
        title,
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(201);
    const body = await read<{ node: { id: string } }>(response);
    return body.node.id;
  }

  it('章和节可以在任何目之前存在，编号自动生成', async () => {
    const chapterId = await createChapter();
    const sectionId = await createSection(chapterId);

    const response = await getOutline(
      request(`/api/curriculum/series/${seriesId}/outline`, 'GET'),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);
    const body = await read<{
      series: { audience: string | null; defaultHours: number | null };
      nodes: Array<{ id: string; nodeType: string; code: string | null; parentId: string | null }>;
    }>(response);
    expect(body.series).toMatchObject({
      audience: '零基础高校网络安全专业学生',
      defaultHours: 1,
    });
    expect(body.nodes).toHaveLength(2);
    const chapter = body.nodes.find((node) => node.id === chapterId)!;
    const section = body.nodes.find((node) => node.id === sectionId)!;
    expect(chapter).toMatchObject({ nodeType: 'chapter', code: '1', parentId: null });
    expect(section).toMatchObject({ nodeType: 'section', code: '1-1', parentId: chapterId });
  });

  it('节必须挂在章下面：父级是节的请求被拒绝', async () => {
    const chapterId = await createChapter();
    const sectionId = await createSection(chapterId);

    const response = await postNode(
      request(`/api/curriculum/series/${seriesId}/outline`, 'POST', {
        nodeType: 'section',
        parentId: sectionId,
        title: '套一节',
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(400);
    const body = await read<{ error: { message: string } }>(response);
    expect(body.error.message).toContain('只能挂在章下面');
  });

  it('章不能有父级', async () => {
    const chapterId = await createChapter();
    const response = await postNode(
      request(`/api/curriculum/series/${seriesId}/outline`, 'POST', {
        nodeType: 'chapter',
        parentId: chapterId,
        title: '章中章',
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(400);
  });

  it('同一系列里编号唯一', async () => {
    await createChapter('第一章', '1');
    const response = await postNode(
      request(`/api/curriculum/series/${seriesId}/outline`, 'POST', {
        nodeType: 'chapter',
        title: '又是第一章',
        code: '1',
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(409);
    expect((await read<{ error: { message: string } }>(response)).error.message).toContain('编号');
  });

  it('在节里建目：编号自动、系列由节决定、kind 落库', async () => {
    const chapterId = await createChapter();
    const sectionId = await createSection(chapterId);

    const first = await createTask(
      request('/api/curriculum/design/tasks', 'POST', {
        sectionId,
        title: 'CTF概述与竞赛形式',
        kind: 'theory',
      }),
    );
    expect(first.status).toBe(201);
    const firstBody = await read<{
      task: {
        id: string;
        seriesId: string | null;
        sectionId: string | null;
        code: string | null;
        kind: string | null;
        orderIndex: number;
      };
    }>(first);
    expect(firstBody.task).toMatchObject({
      seriesId,
      sectionId,
      code: '1-1-1',
      kind: 'theory',
      orderIndex: 1,
    });

    const second = await createTask(
      request('/api/curriculum/design/tasks', 'POST', {
        sectionId,
        title: '竞赛平台与提交实操',
        kind: 'practice',
      }),
    );
    const secondBody = await read<{ task: { code: string | null; orderIndex: number } }>(second);
    expect(secondBody.task).toMatchObject({ code: '1-1-2', orderIndex: 2 });
  });

  it('overview 带回 sectionId / code / kind，驾驶舱不再从条目上借编号', async () => {
    const chapterId = await createChapter();
    const sectionId = await createSection(chapterId);
    await createTask(
      request('/api/curriculum/design/tasks', 'POST', {
        sectionId,
        title: 'CTF概述与竞赛形式',
        kind: 'theory',
      }),
    );

    const response = await overview(
      request(`/api/curriculum/design/overview?seriesId=${encodeURIComponent(seriesId)}`, 'GET'),
    );
    expect(response.status).toBe(200);
    const body = await read<{
      rows: Array<{ sectionId: string | null; code: string; kind: string | null }>;
    }>(response);
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ sectionId, code: '1-1-1', kind: 'theory' });
  });

  it('目编号遵守 kind 枚举：别的值在路由层被拒', async () => {
    const chapterId = await createChapter();
    const sectionId = await createSection(chapterId);
    const response = await createTask(
      request('/api/curriculum/design/tasks', 'POST', {
        sectionId,
        title: '错类型',
        kind: 'lecture',
      }),
    );
    expect(response.status).toBe(400);
  });

  it('导入：预览不写库，提交一次建出章、节、目，并继承系列默认 brief', async () => {
    const preview = await importOutline(
      request(`/api/curriculum/series/${seriesId}/outline/import`, 'POST', {
        mode: 'preview',
        text: OUTLINE,
      }),
      seriesParams(seriesId),
    );
    expect(preview.status).toBe(200);
    const previewBody = await read<{
      preview: { stats: { chapters: number; sections: number; items: number }; issues: unknown[] };
    }>(preview);
    expect(previewBody.preview.stats).toEqual({ chapters: 1, sections: 2, items: 3 });
    expect(await listSeriesOutline(pool, OWNER, seriesId)).toHaveLength(0);

    const commit = await importOutline(
      request(`/api/curriculum/series/${seriesId}/outline/import`, 'POST', {
        mode: 'commit',
        text: OUTLINE,
      }),
      seriesParams(seriesId),
    );
    expect(commit.status).toBe(201);
    expect(await read<{ imported: unknown }>(commit)).toMatchObject({
      imported: { chapters: 1, sections: 2, items: 3 },
    });

    const nodes = await listSeriesOutline(pool, OWNER, seriesId);
    expect(nodes).toHaveLength(3);
    const tasks = await pool.query<{
      code: string | null;
      kind: string | null;
      audience: string | null;
      duration_hours: number | string | null;
      problem_statement: string | null;
      section_id: string | null;
    }>(
      `SELECT code, kind, audience, duration_hours, problem_statement, section_id
         FROM curriculum_task WHERE owner_id = $1 AND series_id = $2 ORDER BY code`,
      [OWNER, seriesId],
    );
    expect(tasks.rows.map((row) => row.code)).toEqual(['1-1-1', '1-1-2', '1-2-1']);
    expect(tasks.rows[0]).toMatchObject({
      kind: 'theory',
      audience: '零基础高校网络安全专业学生',
      problem_statement: '学完这一目，能说清并处理：CTF起源、flag格式',
    });
    expect(Number(tasks.rows[0]!.duration_hours)).toBe(1);
  });

  it('重复导入被拒绝，不会出现两套编号', async () => {
    await importOutline(
      request(`/api/curriculum/series/${seriesId}/outline/import`, 'POST', {
        mode: 'commit',
        text: OUTLINE,
      }),
      seriesParams(seriesId),
    );
    const again = await importOutline(
      request(`/api/curriculum/series/${seriesId}/outline/import`, 'POST', {
        mode: 'commit',
        text: OUTLINE,
      }),
      seriesParams(seriesId),
    );
    expect(again.status).toBe(409);
    const tasks = await pool.query<{ count: number | string }>(
      'SELECT count(*)::text AS count FROM curriculum_task WHERE owner_id = $1 AND series_id = $2',
      [OWNER, seriesId],
    );
    expect(Number(tasks.rows[0]!.count)).toBe(3);
  });

  it('导入文本有解析错误时整批拒绝，一行都不写', async () => {
    const response = await importOutline(
      request(`/api/curriculum/series/${seriesId}/outline/import`, 'POST', {
        mode: 'commit',
        text: '# 章\n- 孤立的目',
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(400);
    expect(await listSeriesOutline(pool, OWNER, seriesId)).toHaveLength(0);
  });

  it('改章节标题可以，编号不在可改字段里', async () => {
    const chapterId = await createChapter();
    const response = await patchNode(
      request(`/api/curriculum/series/${seriesId}/outline/${chapterId}`, 'PATCH', {
        title: '改过的章名',
      }),
      nodeParams(seriesId, chapterId),
    );
    expect(response.status).toBe(200);
    const body = await read<{ node: { title: string; code: string | null } }>(response);
    expect(body.node).toMatchObject({ title: '改过的章名', code: '1' });
  });

  it('删节不删目：目退回未归类，而不是跟着分类消失', async () => {
    const chapterId = await createChapter();
    const sectionId = await createSection(chapterId);
    await createTask(
      request('/api/curriculum/design/tasks', 'POST', {
        sectionId,
        title: 'CTF概述与竞赛形式',
        kind: 'theory',
      }),
    );

    const deleted = await deleteNode(
      request(`/api/curriculum/series/${seriesId}/outline/${sectionId}`, 'DELETE'),
      nodeParams(seriesId, sectionId),
    );
    expect(deleted.status).toBe(200);

    const tasks = await pool.query<{ section_id: string | null; code: string | null }>(
      'SELECT section_id, code FROM curriculum_task WHERE owner_id = $1 AND series_id = $2',
      [OWNER, seriesId],
    );
    expect(tasks.rows).toHaveLength(1);
    expect(tasks.rows[0]).toMatchObject({ section_id: null, code: '1-1-1' });
  });

  it('系列默认 brief 可以改，读回来就是新值', async () => {
    const response = await patchSeries(
      request(`/api/curriculum/series/${seriesId}`, 'PATCH', {
        audience: '社会人员',
        defaultHours: 2,
      }),
      seriesParams(seriesId),
    );
    expect(response.status).toBe(200);

    const outline = await getOutline(
      request(`/api/curriculum/series/${seriesId}/outline`, 'GET'),
      seriesParams(seriesId),
    );
    const body = await read<{
      series: { audience: string | null; defaultHours: number | null };
    }>(outline);
    expect(body.series).toMatchObject({ audience: '社会人员', defaultHours: 2 });
  });
});
