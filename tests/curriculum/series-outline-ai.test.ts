/**
 * 系列大纲 AI 生成：把"模型说了什么"合成为"库里写什么"的规则层。
 *
 * 这里钉的四件事，都是"看起来能跑、事后才发现错了"的那一类：
 *
 * 1. **只补空位 vs 覆盖**：默认不动已有内容；覆盖只在不会让人丢工作时允许。
 * 2. **目标的引用是编号**：模型返回 `2` / `2-1`，找不到或不符时——预览给警告，
 *    提交直接拒绝，绝不"写一半"。
 * 3. **已经开始的目不是 AI 的删除对象**：只有 `untouched` 的目可以被覆盖。
 * 4. **上限是拒绝线**：超了说明模型没按提示词作答，截断会让人以为生成得更多。
 */
import { describe, expect, it } from 'vitest';

import {
  SeriesOutlineAiAnswerError,
  SeriesOutlineAiConflictError,
  formatSeriesOutlineAiContext,
  parseSeriesOutlineAiPlan,
  planSeriesOutlineAiApply,
  seriesOutlineAiBlockedSummary,
  seriesOutlineAiPreflight,
  type SeriesOutlineAiChapter,
  type SeriesOutlineAiContext,
  type SeriesOutlineAiItem,
  type SeriesOutlineAiPlan,
  type SeriesOutlineAiSection,
} from '@/lib/curriculum/series-outline-ai';

function makeContext(partial: Partial<SeriesOutlineAiContext> = {}): SeriesOutlineAiContext {
  return {
    series: {
      id: 'series-1',
      name: 'CTF 综合实战',
      description: '6 个方向各 3 个案例，理论用 slide 视频，实操用 Docker 靶场',
      audience: '零基础高校网络安全专业学生',
      defaultHours: 1,
    },
    design: null,
    chapters: [],
    sections: [],
    items: [],
    ...partial,
  };
}

function chapter(
  id: string,
  code: string,
  title: string,
  sectionCount = 0,
  note: string | null = null,
): SeriesOutlineAiChapter {
  return { id, code, title, note, sectionCount };
}

function section(
  id: string,
  code: string,
  title: string,
  chapterId: string,
  itemCount = 0,
  untouchedItemCount = itemCount,
  note: string | null = null,
): SeriesOutlineAiSection {
  return { id, code, title, note, chapterId, itemCount, untouchedItemCount };
}

function item(
  id: string,
  code: string,
  title: string,
  sectionId: string | null,
  untouched = true,
): SeriesOutlineAiItem {
  return { id, code, title, sectionId, kind: 'theory', untouched };
}

describe('parseSeriesOutlineAiPlan', () => {
  it('章：容忍 markdown 围栏与前后废话，按标题去重', () => {
    const plan = parseSeriesOutlineAiPlan(
      'chapter',
      '好的，这是结果：\n```json\n{"chapters":[{"title":"CTF 基础","note":"入门"},{"title":"CTF 基础","note":"重复"},{"title":"Web 安全"}]}\n```\n希望有帮助。',
    );
    expect(plan.level).toBe('chapter');
    if (plan.level !== 'chapter') throw new Error('unreachable');
    expect(plan.chapters.map((entry) => entry.title)).toEqual(['CTF 基础', 'Web 安全']);
  });

  it('章：不是 JSON / 没有数组时给出可读的拒绝', () => {
    expect(() => parseSeriesOutlineAiPlan('chapter', '我不知道')).toThrow(
      SeriesOutlineAiAnswerError,
    );
    expect(() => parseSeriesOutlineAiPlan('chapter', '{"items":[]}')).toThrow(/chapters 数组/);
  });

  it('节：按章编号分组，章的引用原样保留', () => {
    const plan = parseSeriesOutlineAiPlan(
      'section',
      '{"chapters":[{"chapter":"2","sections":[{"title":"SQL 注入实战","note":"注入"}]}]}',
    );
    if (plan.level !== 'section') throw new Error('unreachable');
    expect(plan.chapters).toEqual([
      { chapterCode: '2', sections: [{ title: 'SQL 注入实战', note: '注入' }] },
    ]);
  });

  it('目：类型中英文都认，学时容忍 "1 学时"，认不出的类型留空而不是猜', () => {
    const plan = parseSeriesOutlineAiPlan(
      'item',
      JSON.stringify({
        sections: [
          {
            section: '2-2',
            items: [
              { title: 'SQL 注入原理', kind: '理论', hours: '1 学时' },
              { title: '手工注入', kind: 'practice', hours: 2 },
              { title: '复盘', kind: '随堂练习', hours: -1 },
            ],
          },
        ],
      }),
    );
    if (plan.level !== 'item') throw new Error('unreachable');
    expect(plan.sections[0]?.items).toEqual([
      { title: 'SQL 注入原理', kind: 'theory', hours: 1, note: null },
      { title: '手工注入', kind: 'practice', hours: 2, note: null },
      { title: '复盘', kind: null, hours: null, note: null },
    ]);
  });

  it('超过每节目数上限时整份回答被拒绝，而不是悄悄截断', () => {
    const items = Array.from({ length: 9 }, (_, index) => ({ title: `目 ${index}` }));
    expect(() =>
      parseSeriesOutlineAiPlan('item', JSON.stringify({ sections: [{ section: '1-1', items }] })),
    ).toThrow(/超过每节上限/);
  });
});

describe('preflight：先于模型调用判断"根本没得生成"', () => {
  it('章：空系列和已有章都允许补充新章', () => {
    expect(
      seriesOutlineAiPreflight({ level: 'chapter', mode: 'fill', context: makeContext() })
        .blockedReason,
    ).toBeNull();
    const withChapters = makeContext({ chapters: [chapter('c1', '1', 'CTF 基础', 2)] });
    expect(
      seriesOutlineAiPreflight({ level: 'chapter', mode: 'fill', context: withChapters })
        .blockedReason,
    ).toBeNull();
  });

  it('节：每一章都有节时，fill 不调模型就拒绝', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', 'CTF 基础', 2)],
      sections: [section('s1', '1-1', '入门', 'c1')],
    });
    const preflight = seriesOutlineAiPreflight({ level: 'section', mode: 'fill', context });
    expect(preflight.blockedReason).toContain('每一章都已经有节');
    expect(preflight.replace.allowed).toBe(true);
  });

  it('节：系列里有目时不允许覆盖重建', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', 'CTF 基础', 1)],
      sections: [section('s1', '1-1', '入门', 'c1', 1)],
      items: [item('t1', '1-1-1', 'CTF 概述', 's1')],
    });
    const preflight = seriesOutlineAiPreflight({ level: 'section', mode: 'replace', context });
    expect(preflight.replace.allowed).toBe(false);
    expect(preflight.replace.reason).toContain('已经有 1 个目');
    expect(preflight.blockedReason).toContain('重建节');

    // 章这一层的覆盖同样被拒绝；预检要把它变成"不用调模型"的阻断，
    // 否则界面上会先花钱生成一次、再告诉用户不能写。
    const chapterPreflight = seriesOutlineAiPreflight({
      level: 'chapter',
      mode: 'replace',
      context,
    });
    expect(chapterPreflight.blockedReason).toContain('重建章');
  });

  it('目：只把"还没开始设计"的节当作覆盖目标', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', 'CTF 基础', 2)],
      sections: [
        section('s1', '1-1', '入门', 'c1', 1, 1),
        section('s2', '1-2', '进阶', 'c1', 1, 0),
      ],
      items: [
        item('t1', '1-1-1', 'CTF 概述', 's1', true),
        item('t2', '1-2-1', '写了一半的目', 's2', false),
      ],
    });
    const preflight = seriesOutlineAiPreflight({ level: 'item', mode: 'replace', context });
    expect(preflight.blockedReason).toBeNull();
    expect(preflight.targetSectionCodes).toEqual(['1-1']);
  });

  it('目：没有空节时 fill 被预检拒绝，覆盖仍可选', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', 'CTF 基础', 1)],
      sections: [section('s1', '1-1', '入门', 'c1', 1)],
      items: [item('t1', '1-1-1', 'CTF 概述', 's1')],
    });
    const preflight = seriesOutlineAiPreflight({ level: 'item', mode: 'fill', context });
    expect(preflight.blockedReason).toContain('每一节都已经有目');
    expect(
      seriesOutlineAiPreflight({ level: 'item', mode: 'replace', context }).blockedReason,
    ).toBeNull();
  });
});

describe('planSeriesOutlineAiApply', () => {
  const chapterPlan = {
    level: 'chapter' as const,
    chapters: [
      { title: 'CTF 基础', note: '和老章重名' },
      { title: 'Web 安全', note: '新的方向' },
    ],
  };

  it('章 fill：跳过与已有章重名的条目，只新建新的', () => {
    const context = makeContext({ chapters: [chapter('c1', '1', 'CTF 基础', 0)] });
    const summary = planSeriesOutlineAiApply({
      level: 'chapter',
      mode: 'fill',
      plan: chapterPlan,
      context,
    });
    expect(summary.canCommit).toBe(true);
    expect(summary.chapters.map((entry) => entry.title)).toEqual(['Web 安全']);
    expect(summary.skipped).toHaveLength(1);
    expect(summary.removeChapterIds).toEqual([]);
  });

  it('章 replace：没有目时删掉旧章再建，有目时整批拒绝', () => {
    const empty = makeContext({ chapters: [chapter('c1', '1', '旧章', 0)] });
    const replaced = planSeriesOutlineAiApply({
      level: 'chapter',
      mode: 'replace',
      plan: chapterPlan,
      context: empty,
    });
    expect(replaced.canCommit).toBe(true);
    expect(replaced.removeChapterIds).toEqual(['c1']);

    const withItems = makeContext({
      chapters: [chapter('c1', '1', '旧章', 1)],
      sections: [section('s1', '1-1', '入门', 'c1', 1)],
      items: [item('t1', '1-1-1', 'CTF 概述', 's1')],
    });
    const blocked = planSeriesOutlineAiApply({
      level: 'chapter',
      mode: 'replace',
      plan: chapterPlan,
      context: withItems,
    });
    expect(blocked.canCommit).toBe(false);
    expect(blocked.blockedReason).toContain('未归类');
  });

  it('节 fill：只写目标章；提交阶段遇到非目标章直接拒绝', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', '已有节', 1), chapter('c2', '2', '空章', 0)],
      sections: [section('s1', '1-1', '已有节', 'c1')],
    });
    const plan = {
      level: 'section' as const,
      chapters: [
        { chapterCode: '1', sections: [{ title: '不该写', note: null }] },
        { chapterCode: '2', sections: [{ title: 'SQL 注入实战', note: null }] },
      ],
    };
    const summary = planSeriesOutlineAiApply({ level: 'section', mode: 'fill', plan, context });
    expect(summary.sections.map((entry) => entry.title)).toEqual(['SQL 注入实战']);
    expect(summary.skipped[0]?.reason).toContain('已经有节');

    expect(() =>
      planSeriesOutlineAiApply({ level: 'section', mode: 'fill', plan, context, strict: true }),
    ).toThrow(SeriesOutlineAiConflictError);
  });

  it('节 replace：没有目时删除全部旧节，有目时拒绝', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', '章', 1)],
      sections: [section('s1', '1-1', '旧节', 'c1')],
    });
    const plan = {
      level: 'section' as const,
      chapters: [{ chapterCode: '1', sections: [{ title: '新节', note: null }] }],
    };
    const summary = planSeriesOutlineAiApply({
      level: 'section',
      mode: 'replace',
      plan,
      context,
    });
    expect(summary.canCommit).toBe(true);
    expect(summary.removeSectionIds).toEqual(['s1']);

    const withItems = makeContext({
      ...context,
      sections: [section('s1', '1-1', '旧节', 'c1', 1)],
      items: [item('t1', '1-1-1', '目', 's1')],
    });
    const blocked = planSeriesOutlineAiApply({
      level: 'section',
      mode: 'replace',
      plan,
      context: withItems,
    });
    expect(blocked.canCommit).toBe(false);
  });

  it('目 fill：只为空节建目，已有目的节被跳过；strict 下拒绝', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', '章', 2)],
      sections: [section('s1', '1-1', '已有目', 'c1', 2), section('s2', '1-2', '空节', 'c1', 0)],
      items: [item('t1', '1-1-1', '目一', 's1')],
    });
    const plan: SeriesOutlineAiPlan = {
      level: 'item',
      sections: [
        { sectionCode: '1-1', items: [{ title: '不该写', kind: 'theory', hours: 1, note: null }] },
        { sectionCode: '1-2', items: [{ title: '新目', kind: 'practice', hours: 1, note: null }] },
      ],
    };
    const summary = planSeriesOutlineAiApply({ level: 'item', mode: 'fill', plan, context });
    expect(summary.items.map((entry) => entry.title)).toEqual(['新目']);
    expect(summary.skipped[0]?.reason).toContain('已经有目');

    expect(() =>
      planSeriesOutlineAiApply({ level: 'item', mode: 'fill', plan, context, strict: true }),
    ).toThrow(SeriesOutlineAiConflictError);
  });

  it('目 replace：删除未开始的目，跳过已开始设计的节', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', '章', 2)],
      sections: [
        section('s1', '1-1', '可覆盖', 'c1', 1, 1),
        section('s2', '1-2', '进行中', 'c1', 1, 0),
      ],
      items: [
        item('t1', '1-1-1', '旧目', 's1', true),
        item('t2', '1-2-1', '进行中的目', 's2', false),
      ],
    });
    const plan: SeriesOutlineAiPlan = {
      level: 'item',
      sections: [
        { sectionCode: '1-1', items: [{ title: '新目', kind: 'theory', hours: 1, note: null }] },
      ],
    };
    const summary = planSeriesOutlineAiApply({
      level: 'item',
      mode: 'replace',
      plan,
      context,
    });
    expect(summary.canCommit).toBe(true);
    expect(summary.removeItemIds).toEqual(['t1']);
    expect(summary.skipped).toEqual([]);
    expect(summary.items).toHaveLength(1);
  });

  it('找不到引用的章/节：预览给警告，提交拒绝', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', '章', 0)],
      sections: [],
    });
    const plan: SeriesOutlineAiPlan = {
      level: 'section',
      chapters: [{ chapterCode: '9', sections: [{ title: '新节', note: null }] }],
    };
    const summary = planSeriesOutlineAiApply({ level: 'section', mode: 'fill', plan, context });
    expect(summary.canCommit).toBe(false);
    expect(summary.warnings[0]).toContain('第 9 章不存在');
    expect(() =>
      planSeriesOutlineAiApply({ level: 'section', mode: 'fill', plan, context, strict: true }),
    ).toThrow(/已经不存在/);
  });
});

describe('formatSeriesOutlineAiContext', () => {
  it('把系列说明、现有大纲与生成目标写进提示词变量', () => {
    const context = makeContext({
      chapters: [chapter('c1', '1', 'CTF 基础', 1), chapter('c2', '2', 'Web 安全', 0)],
      sections: [section('s1', '1-1', '入门与赛制', 'c1', 1)],
      items: [item('t1', '1-1-1', 'CTF 概述', 's1')],
    });
    const variables = formatSeriesOutlineAiContext({
      level: 'section',
      mode: 'fill',
      context,
    });
    expect(variables.seriesInfo).toContain('CTF 综合实战');
    expect(variables.seriesInfo).toContain('6 个方向各 3 个案例');
    expect(variables.outlineTree).toContain('第 1 章 CTF 基础');
    expect(variables.outlineTree).toContain('1-1-1 CTF 概述');
    expect(variables.targets).toContain('第 2 章 Web 安全');
    expect(variables.modeNote).toContain('只补空章');
  });

  it('交底：章备注原样进入生成节的提示词，节备注原样进入生成目的提示词', () => {
    const context = makeContext({
      chapters: [
        chapter(
          'c1',
          '1',
          'CTF 基础与工具环境',
          1,
          '覆盖赛制、工具与提交流程；不涉及漏洞利用。建议 3 节。',
        ),
        chapter('c2', '2', 'Web 安全', 0, '覆盖 Web 常见漏洞；不涉及内网。建议 3 节。'),
      ],
      sections: [
        section(
          's1',
          '1-1',
          '入门与赛制',
          'c1',
          0,
          0,
          '以一道入门题为例：理论讲赛制，实操走提交流程，复盘讲常见坑。',
        ),
      ],
    });

    const sectionVariables = formatSeriesOutlineAiContext({
      level: 'section',
      mode: 'fill',
      context,
    });
    expect(sectionVariables.targets).toContain('章交底：覆盖 Web 常见漏洞');
    expect(sectionVariables.outlineTree).toContain('章交底：覆盖赛制、工具与提交流程');

    const itemVariables = formatSeriesOutlineAiContext({ level: 'item', mode: 'fill', context });
    expect(itemVariables.targets).toContain('节交底：以一道入门题为例');
    expect(itemVariables.targets).toContain('章交底：覆盖赛制、工具与提交流程');
  });

  it('系列设计定稿后进提示词：方向、课程目标（含达标线）、知识体系（含先修）', () => {
    const variables = formatSeriesOutlineAiContext({
      level: 'chapter',
      mode: 'fill',
      context: makeContext({
        design: {
          complete: true,
          gaps: [],
          direction: {
            learnerLevel: '会 Linux 基本命令',
            trainingScenario: '线下集中实训',
            applicationScene: '校内选拔赛',
            problemStatement: '覆盖 CTF 五个方向，不做内网渗透',
          },
          objectives: [
            {
              title: '能独立完成入门级 Web 题',
              expectedBehavior: '独立定位并利用漏洞拿到 flag',
              minCriteria: ['提交的 flag 正确'],
              evidence: 'Web 方向综合靶场',
            },
          ],
          nodes: [
            {
              name: 'SQL 注入原理',
              summary: '注入成因与常见手法',
              difficulty: 'intro',
              prerequisites: [],
            },
          ],
        },
      }),
    });
    expect(variables.seriesDesign).toContain('系列设计已定稿');
    expect(variables.seriesDesign).toContain('学员基础：会 Linux 基本命令');
    expect(variables.seriesDesign).toContain('能独立完成入门级 Web 题');
    expect(variables.seriesDesign).toContain('最低达标线：提交的 flag 正确');
    expect(variables.seriesDesign).toContain('SQL 注入原理（入门）');
  });

  it('系列设计没定完时明说缺什么，并允许携带已有部分', () => {
    const variables = formatSeriesOutlineAiContext({
      level: 'section',
      mode: 'fill',
      context: makeContext({
        design: {
          complete: false,
          gaps: ['还没有课程目标', '还没有系列总学时'],
          direction: {
            learnerLevel: null,
            trainingScenario: null,
            applicationScene: null,
            problemStatement: null,
          },
          objectives: [],
          nodes: [],
        },
      }),
    });
    expect(variables.seriesDesign).toContain('系列设计还没定完');
    expect(variables.seriesDesign).toContain('还没有课程目标');
  });

  it('没有备注时给出明确占位，而不是留空让模型自由发挥', () => {
    const variables = formatSeriesOutlineAiContext({
      level: 'section',
      mode: 'fill',
      context: makeContext({ chapters: [chapter('c1', '1', 'Web 安全', 0)] }),
    });
    expect(variables.targets).toContain('章交底：（还没有备注，按标题与系列说明判断）');
  });

  it('预检拒绝的空计划带上原因，且不可写入', () => {
    const context = makeContext();
    const preflight = seriesOutlineAiPreflight({ level: 'item', mode: 'fill', context });
    const summary = seriesOutlineAiBlockedSummary('item', 'fill', preflight);
    expect(summary.canCommit).toBe(false);
    expect(summary.blockedReason).toContain('还没有节');
    expect(summary.writes).toEqual({ chapters: 0, sections: 0, items: 0 });
  });
});
