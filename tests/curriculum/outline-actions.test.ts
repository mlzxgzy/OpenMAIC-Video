/**
 * 系列大纲（章 / 节 / 目）的删除后果与编辑差异补丁。
 *
 * 被测的两组规则都只有靠测试才守得住：
 *
 * 1. **删除后果必须和库里的真实行为一致。** 章级联删节（`parent_id ON DELETE
 *    CASCADE`）、节和目被删后目退回「未归类」（`curriculum_task.section_id ON
 *    DELETE SET NULL`）、目删除会连设计一起删而已出片的课程不挂在目下面。这些
 *    数字来自看板，文案写在纯函数里，所以比对的是返回值而不是渲染结果。
 * 2. **编辑只发改过的字段。** 原样提交一遍会被接口当成「这一行我核过了」，把
 *    「旧版设计」的指纹清掉。补丁里多一个键就是替用户做了他没做的表态。
 *
 * 函数全是纯函数，这里不碰数据库、不 mock，直接构造入参比对返回值。
 */
import { describe, expect, it } from 'vitest';

import {
  describeOutlineDelete,
  nodeEditPatch,
  parseTaskEditDraft,
  taskEditPatch,
  type OutlineDeleteTarget,
  type TaskEditDraft,
  type TaskEditValues,
} from '@/lib/curriculum/outline-actions';

/** 删除确认的现状：默认「没有编号、没有牵连内容」。 */
function deleteTarget(
  overrides: Partial<OutlineDeleteTarget> & Pick<OutlineDeleteTarget, 'level'>,
): OutlineDeleteTarget {
  return {
    code: null,
    title: '示例',
    sectionCount: 0,
    itemCount: 0,
    producedCount: 0,
    ...overrides,
  };
}

/** 目的编辑前的现状。 */
function taskValues(overrides: Partial<TaskEditValues> = {}): TaskEditValues {
  return {
    title: '端口扫描',
    code: '1-1-1',
    kind: 'theory',
    durationHours: 2,
    ...overrides,
  };
}

/** 编辑框里的原样字符串。 */
function taskDraft(overrides: Partial<TaskEditDraft> = {}): TaskEditDraft {
  return {
    title: '端口扫描',
    code: '1-1-1',
    kind: 'theory',
    hours: '2',
    ...overrides,
  };
}

describe('describeOutlineDelete：删除章', () => {
  it('有节有目：说清几节一起删，并说明目只是退回未归类', () => {
    expect(
      describeOutlineDelete(
        deleteTarget({
          level: 'chapter',
          code: '1',
          title: 'Web 安全',
          sectionCount: 2,
          itemCount: 5,
        }),
      ),
    ).toEqual({
      level: 'chapter',
      title: '删除第 1 章「Web 安全」？',
      consequence: '这一章和它下面的 2 节会一起删除。',
      keep: '这 5 个目不会被删除，会退回「未归类」——可以再挂到别的节下面。',
      confirmLabel: '删除章',
    });
  });

  it('没有编号时标题写成「删除章「…」？」，无牵连内容时不画 keep', () => {
    const spec = describeOutlineDelete(deleteTarget({ level: 'chapter', title: 'Web 安全' }));
    expect(spec.title).toBe('删除章「Web 安全」？');
    expect(spec.consequence).toBe('这一章会被删除。');
    expect(spec.keep).toBeNull();
    expect(spec.confirmLabel).toBe('删除章');
  });

  it('有节无目：只说节，不出现「目不会被删」那一行', () => {
    const spec = describeOutlineDelete(
      deleteTarget({ level: 'chapter', code: '2', title: '密码学', sectionCount: 1 }),
    );
    expect(spec.consequence).toBe('这一章和它下面的 1 节会一起删除。');
    expect(spec.keep).toBeNull();
  });

  it('无节有目：章自己删，目退回未归类', () => {
    const spec = describeOutlineDelete(
      deleteTarget({ level: 'chapter', code: '3', title: '实验', itemCount: 4 }),
    );
    expect(spec.consequence).toBe('这一章会被删除。');
    expect(spec.keep).toBe('这 4 个目不会被删除，会退回「未归类」——可以再挂到别的节下面。');
  });
});

describe('describeOutlineDelete：删除节', () => {
  it('有目：目退回「未归类」，不是被删', () => {
    expect(
      describeOutlineDelete(
        deleteTarget({ level: 'section', code: '1-1', title: '信息收集', itemCount: 4 }),
      ),
    ).toEqual({
      level: 'section',
      title: '删除第 1-1 节「信息收集」？',
      consequence: '这一节会被删除。',
      keep: '这一节下面的 4 个目不会被删除，会退回「未归类」。',
      confirmLabel: '删除节',
    });
  });

  it('无目：不画 keep；编号为空时标题也成立', () => {
    const spec = describeOutlineDelete(deleteTarget({ level: 'section', title: '信息收集' }));
    expect(spec.title).toBe('删除节「信息收集」？');
    expect(spec.consequence).toBe('这一节会被删除。');
    expect(spec.keep).toBeNull();
    expect(spec.confirmLabel).toBe('删除节');
  });
});

describe('describeOutlineDelete：删除目', () => {
  it('已出片：说清课程和视频不挂在目下面、不会被删', () => {
    expect(
      describeOutlineDelete(
        deleteTarget({
          level: 'item',
          code: '1-1-1',
          title: '端口扫描',
          producedCount: 2,
        }),
      ),
    ).toEqual({
      level: 'item',
      title: '删除目「1-1-1 端口扫描」？',
      consequence:
        '这一目的设计会一起删除，不能恢复：学习目标、知识点、本目大纲、题目与实操都在它下面。',
      keep: '已经生成的课程和导出视频不挂在目下面，不会被删；但系列里不再有这一目的位置。',
      confirmLabel: '删除目',
    });
  });

  it('未出片：不画 keep；编号为空时标题也成立', () => {
    const spec = describeOutlineDelete(deleteTarget({ level: 'item', title: '端口扫描' }));
    expect(spec.title).toBe('删除目「端口扫描」？');
    expect(spec.keep).toBeNull();
    expect(spec.confirmLabel).toBe('删除目');
  });
});

describe('nodeEditPatch：章 / 节的编辑补丁', () => {
  it('完全没改返回 null（调用方据此直接关框，不发 PATCH）', () => {
    expect(
      nodeEditPatch({ title: '章一', note: '说明' }, { title: '章一', note: '说明' }),
    ).toBeNull();
  });

  it('标题只差首尾空白算没改', () => {
    expect(
      nodeEditPatch({ title: '章一', note: null }, { title: '  章一  ', note: null }),
    ).toBeNull();
  });

  it('说明从有内容清空：发 null，而不是空串', () => {
    expect(nodeEditPatch({ title: '章一', note: '旧说明' }, { title: '章一', note: '' })).toEqual({
      note: null,
    });
    expect(
      nodeEditPatch({ title: '章一', note: '旧说明' }, { title: '章一', note: '   ' }),
    ).toEqual({
      note: null,
    });
  });

  it('说明本来就是 null、又留空：算没改', () => {
    expect(nodeEditPatch({ title: '章一', note: null }, { title: '章一', note: '  ' })).toBeNull();
  });

  it('标题与说明同时改：两个键都发', () => {
    expect(
      nodeEditPatch({ title: '章一', note: '旧说明' }, { title: '章二', note: '新说明' }),
    ).toEqual({ title: '章二', note: '新说明' });
  });

  it('只改标题时补丁只含 title，一个多余的键都不发', () => {
    const patch = nodeEditPatch({ title: '章一', note: '说明' }, { title: '章二', note: '说明' });
    expect(patch).toEqual({ title: '章二' });
    expect(Object.keys(patch!)).toEqual(['title']);
  });

  it('只改说明时补丁只含 note', () => {
    const patch = nodeEditPatch(
      { title: '章一', note: '旧说明' },
      { title: '章一', note: '新说明' },
    );
    expect(patch).toEqual({ note: '新说明' });
    expect(Object.keys(patch!)).toEqual(['note']);
  });

  it('说明从 null 改成文字：发文字', () => {
    expect(nodeEditPatch({ title: '章一', note: null }, { title: '章一', note: '新说明' })).toEqual(
      {
        note: '新说明',
      },
    );
  });

  it('标题改的是 trim 后的值（内部空格保留）', () => {
    expect(
      nodeEditPatch({ title: '章一', note: null }, { title: '  章二 讲  义 ', note: null }),
    ).toEqual({ title: '章二 讲  义' });
  });
});

describe('parseTaskEditDraft：把表单读成可提交的值', () => {
  it('标题为空（含纯空白）报错', () => {
    expect(parseTaskEditDraft(taskDraft({ title: '' }))).toEqual({
      ok: false,
      message: '标题不能为空',
    });
    expect(parseTaskEditDraft(taskDraft({ title: '   ' }))).toEqual({
      ok: false,
      message: '标题不能为空',
    });
  });

  it('标题存 trim 后的值', () => {
    expect(parseTaskEditDraft(taskDraft({ title: '  端口扫描 ' }))).toEqual({
      ok: true,
      value: { title: '端口扫描', code: '1-1-1', kind: 'theory', durationHours: 2 },
    });
  });

  it('学时留空存 null 而不是 0（Number("") 是 0 的坑）', () => {
    expect(parseTaskEditDraft(taskDraft({ hours: '' }))).toEqual({
      ok: true,
      value: { title: '端口扫描', code: '1-1-1', kind: 'theory', durationHours: null },
    });
    expect(parseTaskEditDraft(taskDraft({ hours: '   ' }))).toEqual({
      ok: true,
      value: { title: '端口扫描', code: '1-1-1', kind: 'theory', durationHours: null },
    });
  });

  it('学时 1.5 存 1.5（小数合法）', () => {
    expect(parseTaskEditDraft(taskDraft({ hours: '1.5' }))).toMatchObject({
      ok: true,
      value: { durationHours: 1.5 },
    });
  });

  it('学时 0 合法（不能把「0 学时」当成没填）', () => {
    expect(parseTaskEditDraft(taskDraft({ hours: '0' }))).toMatchObject({
      ok: true,
      value: { durationHours: 0 },
    });
  });

  it('学时不是数字报错', () => {
    expect(parseTaskEditDraft(taskDraft({ hours: 'abc' }))).toEqual({
      ok: false,
      message: '学时只能是不小于 0 的数字',
    });
  });

  it('学时是负数报错', () => {
    expect(parseTaskEditDraft(taskDraft({ hours: '-1' }))).toEqual({
      ok: false,
      message: '学时只能是不小于 0 的数字',
    });
  });

  it('编号留空 → null（退回没有编号，不编一个）', () => {
    expect(parseTaskEditDraft(taskDraft({ code: '' }))).toMatchObject({
      ok: true,
      value: { code: null },
    });
    expect(parseTaskEditDraft(taskDraft({ code: '   ' }))).toMatchObject({
      ok: true,
      value: { code: null },
    });
  });

  it('编号有值时 trim 后保留', () => {
    expect(parseTaskEditDraft(taskDraft({ code: '  1-1-2  ' }))).toMatchObject({
      ok: true,
      value: { code: '1-1-2' },
    });
  });

  it('类型留空 → null', () => {
    expect(parseTaskEditDraft(taskDraft({ kind: '' }))).toMatchObject({
      ok: true,
      value: { kind: null },
    });
    expect(parseTaskEditDraft(taskDraft({ kind: '   ' }))).toMatchObject({
      ok: true,
      value: { kind: null },
    });
  });

  it('类型 theory / practice / review 都通过', () => {
    for (const kind of ['theory', 'practice', 'review'] as const) {
      expect(parseTaskEditDraft(taskDraft({ kind }))).toMatchObject({ ok: true, value: { kind } });
    }
  });

  it('类型乱写报错', () => {
    expect(parseTaskEditDraft(taskDraft({ kind: 'x' }))).toEqual({
      ok: false,
      message: '类型只能是理论、实操或综合',
    });
  });
});

describe('taskEditPatch：目的编辑补丁', () => {
  it('完全没改返回 null', () => {
    expect(taskEditPatch(taskValues(), taskValues())).toBeNull();
  });

  it('只改标题：补丁只含 title', () => {
    const patch = taskEditPatch(taskValues(), taskValues({ title: '端口扫描进阶' }));
    expect(patch).toEqual({ title: '端口扫描进阶' });
    expect(Object.keys(patch!)).toEqual(['title']);
  });

  it('只改编号：补丁只含 code', () => {
    const patch = taskEditPatch(taskValues(), taskValues({ code: '1-1-2' }));
    expect(patch).toEqual({ code: '1-1-2' });
    expect(Object.keys(patch!)).toEqual(['code']);
  });

  it('只改学时：补丁只含 durationHours', () => {
    const patch = taskEditPatch(taskValues(), taskValues({ durationHours: 3 }));
    expect(patch).toEqual({ durationHours: 3 });
    expect(Object.keys(patch!)).toEqual(['durationHours']);
  });

  it('编号从有到无：会发 null（清空编号是有效改动）', () => {
    const patch = taskEditPatch(taskValues(), taskValues({ code: null }));
    expect(patch).toEqual({ code: null });
    expect(Object.keys(patch!)).toEqual(['code']);
  });

  it('编号从无到有：会发新值', () => {
    expect(taskEditPatch(taskValues({ code: null }), taskValues({ code: '2-1-1' }))).toEqual({
      code: '2-1-1',
    });
  });

  it('类型从未标注到 theory：会发', () => {
    expect(taskEditPatch(taskValues({ kind: null }), taskValues({ kind: 'theory' }))).toEqual({
      kind: 'theory',
    });
  });

  it('类型从 theory 改回未标注：不发（接口不接受 null，界面把未标注画成不可选）', () => {
    expect(taskEditPatch(taskValues({ kind: 'theory' }), taskValues({ kind: null }))).toBeNull();
  });

  it('类型在两种已标注值之间改：会发', () => {
    expect(taskEditPatch(taskValues({ kind: 'theory' }), taskValues({ kind: 'practice' }))).toEqual(
      {
        kind: 'practice',
      },
    );
  });

  it('学时从数字到 null：会发 null（清空学时是有效改动）', () => {
    const patch = taskEditPatch(taskValues(), taskValues({ durationHours: null }));
    expect(patch).toEqual({ durationHours: null });
    expect(Object.keys(patch!)).toEqual(['durationHours']);
  });
});
