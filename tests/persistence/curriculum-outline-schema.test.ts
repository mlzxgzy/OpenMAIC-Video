/**
 * 系列大纲的数据库约束（PGlite）。
 *
 * 这些断言检查的是**约束**，不是 DDL：大纲的层级形状如果只靠调用方自觉，迟早
 * 会出现"一节挂在另一节下面"，而那时"第几章"就没有唯一答案了。所以章在顶层、
 * 节必须有父级、编号在系列内唯一、目的 type 只能是三种，全部由数据库拒绝。
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';

const OWNER = 'owner:outline-schema';

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

describe('series outline schema (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    await pool.query(
      `INSERT INTO curriculum_series (id, owner_id, name, audience, default_hours)
                      VALUES ('s1', $1, 'CTF', '零基础学生', 1)`,
      [OWNER],
    );
    await pool.query(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, parent_id, node_type, code, title, order_index)
       VALUES ('c1', $1, 's1', NULL, 'chapter', '1', '第一章', 1),
              ('sec1', $1, 's1', 'c1', 'section', '1-1', '第一节', 1)`,
      [OWNER],
    );
    await pool.query(
      `INSERT INTO curriculum_task (id, owner_id, series_id, section_id, code, kind, order_index, title)
       VALUES ('t1', $1, 's1', 'sec1', '1-1-1', 'theory', 1, '目一')`,
      [OWNER],
    );
  });

  afterEach(async () => {
    await db.close();
  });

  const expectRejected = async (sql: string, params: unknown[] = []): Promise<void> => {
    await expect(pool.query(sql, params)).rejects.toThrow();
  };

  it('章必须挂在顶层：带 parent_id 的章被拒绝', async () => {
    await expectRejected(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, parent_id, node_type, title)
       VALUES ('c2', $1, 's1', 'c1', 'chapter', '伪章')`,
      [OWNER],
    );
  });

  it('节必须有父级，且父级必须是章（不是另一节）', async () => {
    await expectRejected(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, parent_id, node_type, title)
       VALUES ('sec2', $1, 's1', NULL, 'section', '无主节')`,
      [OWNER],
    );
    await expectRejected(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, parent_id, node_type, title)
       VALUES ('sec3', $1, 's1', 'sec1', 'section', '套节')`,
      [OWNER],
    );
  });

  it('节点类型只有章和节两种', async () => {
    await expectRejected(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, node_type, title)
       VALUES ('x', $1, 's1', 'item', '第三种')`,
      [OWNER],
    );
  });

  it('编号在系列内唯一（空编号不参与）', async () => {
    await expectRejected(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, node_type, code, title)
       VALUES ('c9', $1, 's1', 'chapter', '1', '重复编号')`,
      [OWNER],
    );
    // 编号为空的两行可以并存：手工建的章可以后补编号。
    await pool.query(
      `INSERT INTO curriculum_series_outline_node
         (id, owner_id, series_id, node_type, title)
       VALUES ('c8', $1, 's1', 'chapter', '无编号一'), ('c7', $1, 's1', 'chapter', '无编号二')`,
      [OWNER],
    );
  });

  it('目的 kind 只能是 theory/practice/review', async () => {
    await expectRejected(
      `INSERT INTO curriculum_task (id, owner_id, series_id, code, kind, title)
       VALUES ('t9', $1, 's1', '9-9-9', 'lecture', '错类型')`,
      [OWNER],
    );
  });

  it('目编号在系列内唯一', async () => {
    await expectRejected(
      `INSERT INTO curriculum_task (id, owner_id, series_id, code, title)
       VALUES ('t2', $1, 's1', '1-1-1', '重复编号')`,
      [OWNER],
    );
  });

  it('删节不删目：section_id 置空，目还在', async () => {
    await pool.query('DELETE FROM curriculum_series_outline_node WHERE id = $1', ['sec1']);
    const tasks = await pool.query<{ id: string; section_id: string | null }>(
      'SELECT id, section_id FROM curriculum_task WHERE id = $1',
      ['t1'],
    );
    expect(tasks.rows).toEqual([{ id: 't1', section_id: null }]);
  });

  it('删系列会级联删掉大纲节点（系列没了，分类无从谈起）', async () => {
    await pool.query('DELETE FROM curriculum_series WHERE id = $1', ['s1']);
    const nodes = await pool.query<{ count: number | string }>(
      'SELECT count(*)::text AS count FROM curriculum_series_outline_node',
    );
    expect(Number(nodes.rows[0]!.count)).toBe(0);
  });
});
