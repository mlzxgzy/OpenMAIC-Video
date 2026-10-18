/**
 * 系列级设计的规则层：方向 / 课程目标 / 知识体系。
 *
 * 这一层的存在只为一句话：**第 1–3 步的目标是系列，不是目**。所以测试盯的不是
 * "能存能取"，而是那条边界：
 *
 * - 系列没写授课对象时，目不能假装自己有（继承只在系列真有值时生效）；
 * - 课程目标没有可观察行为、没有最低达标线、引用了不存在的知识点时，写入被拒；
 * - 先修关系成环被拒——它会让"net 讲授顺序"失去拓扑序；
 * - 文本编辑与结构化编辑是同一份数据：`format → parse` 必须回到原值。
 */
import { describe, expect, it } from 'vitest';

import { directionValuesOf, effectiveDirectionValues } from '@/lib/curriculum/design-direction';
import {
  canonicalSeriesDesign,
  formatNodesText,
  formatObjectivesText,
  inheritableDirection,
  isDerivedFromStaleDesign,
  mergeSeriesDesign,
  normalizeSeriesDesignDoc,
  parseNodesText,
  parseObjectivesText,
  parseSeriesDesignAnswer,
  seriesDesignComplete,
  seriesDesignGaps,
  seriesDesignPhase,
  SeriesDesignInvalidError,
  validateSeriesDesignPatch,
  type SeriesDesignDoc,
} from '@/lib/curriculum/series-design';

function doc(overrides: Partial<SeriesDesignDoc> = {}): SeriesDesignDoc {
  const base: SeriesDesignDoc = {
    direction: {
      audience: '零基础高校网络安全专业学生',
      learnerLevel: '会 Linux 基本命令',
      trainingScenario: '线下集中实训',
      applicationScene: '校内选拔赛',
      problemStatement: '覆盖 CTF 五个方向，不做内网渗透',
      durationHours: 54,
    },
    objectives: [
      {
        id: 'so_1',
        title: '能独立完成入门级 Web 题',
        expectedBehavior: '独立定位并利用题目漏洞拿到 flag',
        minCriteria: ['提交的 flag 正确'],
        evidence: 'Web 方向综合靶场',
        nodeIds: ['sn_1'],
      },
    ],
    nodes: [
      {
        id: 'sn_1',
        name: 'SQL 注入原理',
        type: 'knowledge',
        summary: '注入成因与常见手法',
        difficulty: 'intro',
        prerequisites: [],
      },
    ],
  };
  return { ...base, ...overrides };
}

describe('series design normalization', () => {
  it('把名字引用解析成 id，并丢掉没有名字的条目', () => {
    const { design, dropped } = normalizeSeriesDesignDoc({
      audience: ' 学生 ',
      defaultHours: 54,
      learnerLevel: null,
      trainingScenario: null,
      applicationScene: null,
      problemStatement: null,
      courseObjectives: [
        {
          title: '能完成 Web 题',
          expectedBehavior: '拿到 flag',
          minCriteria: ['flag 正确'],
          evidence: '靶场',
          nodeIds: ['SQL 注入原理'],
        },
      ],
      knowledgeSystem: {
        nodes: [
          { name: 'SQL 注入原理', type: 'knowledge', difficulty: 'intro', prerequisites: [] },
          { name: '', type: 'skill' },
        ],
      },
    });
    expect(design.direction.audience).toBe('学生');
    expect(design.direction.durationHours).toBe(54);
    expect(design.nodes).toHaveLength(1);
    expect(design.objectives[0].nodeIds).toEqual(['sn_1']);
    expect(dropped).toEqual(['第 2 个知识点没有名字']);
  });

  it('库里存着坏数据时不抛，读成能用的最小文档', () => {
    const { design } = normalizeSeriesDesignDoc({
      audience: null,
      defaultHours: null,
      learnerLevel: null,
      trainingScenario: null,
      applicationScene: null,
      problemStatement: null,
      courseObjectives: 'not-an-array',
      knowledgeSystem: 42,
    });
    expect(design.objectives).toEqual([]);
    expect(design.nodes).toEqual([]);
  });
});

describe('series design validation', () => {
  it('课程目标没有最低达标线时拒绝写入', () => {
    expect(() =>
      validateSeriesDesignPatch(
        {
          objectives: [
            {
              title: '能完成 Web 题',
              expectedBehavior: '拿到 flag',
              minCriteria: [],
              evidence: '靶场',
            },
          ],
        },
        doc(),
      ),
    ).toThrow(/最低达标标准/);
  });

  it('课程目标没有可观察行为时拒绝写入', () => {
    expect(() =>
      validateSeriesDesignPatch(
        {
          objectives: [
            {
              title: '了解 SQL 注入',
              expectedBehavior: '',
              minCriteria: ['能说清注入成因'],
              evidence: '测验',
            },
          ],
        },
        doc(),
      ),
    ).toThrow(/可观察行为/);
  });

  it('目标引用不存在的知识点时拒绝写入', () => {
    expect(() =>
      validateSeriesDesignPatch(
        {
          objectives: [
            {
              title: '能完成 Web 题',
              expectedBehavior: '拿到 flag',
              minCriteria: ['flag 正确'],
              evidence: '靶场',
              nodeIds: ['不存在的点'],
            },
          ],
        },
        doc(),
      ),
    ).toThrow(/引用的知识点/);
  });

  it('先修关系成环时拒绝写入', () => {
    expect(() =>
      validateSeriesDesignPatch(
        {
          nodes: [
            { name: 'A', type: 'knowledge', difficulty: 'basic', prerequisites: ['B'] },
            { name: 'B', type: 'knowledge', difficulty: 'basic', prerequisites: ['A'] },
          ],
        },
        doc(),
      ),
    ).toThrow(/成环/);
  });

  it('节点不能把自己列为先修', () => {
    expect(() =>
      validateSeriesDesignPatch(
        { nodes: [{ name: 'A', type: 'knowledge', difficulty: 'basic', prerequisites: ['A'] }] },
        doc(),
      ),
    ).toThrow(/不能把自己/);
  });

  it('空数组是"清空"，缺省键是"这次不改"', () => {
    const cleared = mergeSeriesDesign(doc(), { objectives: [] });
    expect(cleared.objectives).toEqual([]);
    expect(cleared.nodes).toHaveLength(1);
    const untouched = mergeSeriesDesign(doc(), { direction: { audience: '新对象' } });
    expect(untouched.objectives).toHaveLength(1);
    expect(untouched.direction.audience).toBe('新对象');
  });

  it('替换节点时，旧目标指向已消失节点的引用被丢掉，而不是悬空', () => {
    const next = mergeSeriesDesign(doc(), {
      nodes: [
        {
          id: 'sn_9',
          name: '新节点',
          type: 'skill',
          summary: '',
          difficulty: 'basic',
          prerequisites: [],
        },
      ],
    });
    expect(next.objectives[0].nodeIds).toEqual([]);
  });
});

describe('series design phase and gaps', () => {
  it('没有目标时停在方向；有目标没节点时停在目标；两者都有才是知识体系', () => {
    expect(seriesDesignPhase(doc({ objectives: [] }))).toBe('direction');
    expect(seriesDesignPhase(doc({ nodes: [] }))).toBe('objectives');
    const orphanObjective = doc({
      objectives: [{ ...doc().objectives[0], nodeIds: [] }],
    });
    expect(seriesDesignPhase(orphanObjective)).toBe('objectives');
    expect(seriesDesignPhase(doc())).toBe('knowledge');
  });

  it('前三步是否定完看缺口，不看相位：方向为空时相位也会停在 knowledge', () => {
    expect(seriesDesignComplete(doc())).toBe(true);
    // 相位仍是 knowledge——这就是不能拿相位当门禁的原因。
    const missingDirection = doc({
      direction: {
        audience: null,
        learnerLevel: null,
        trainingScenario: null,
        applicationScene: null,
        problemStatement: null,
        durationHours: null,
      },
    });
    expect(seriesDesignPhase(missingDirection)).toBe('knowledge');
    expect(seriesDesignComplete(missingDirection)).toBe(false);
    // 目标没有证据 / 没有达标线都不能算定完。
    expect(
      seriesDesignComplete(doc({ objectives: [{ ...doc().objectives[0], evidence: '' }] })),
    ).toBe(false);
    expect(seriesDesignComplete(doc({ objectives: [] }))).toBe(false);
  });

  it('缺口点名具体的东西，而不是只说"不完整"', () => {
    const gaps = seriesDesignGaps(
      doc({
        direction: { ...doc().direction, audience: null },
        objectives: [{ ...doc().objectives[0], expectedBehavior: '', nodeIds: [] }],
        nodes: [],
      }),
    );
    expect(gaps.direction.join()).toMatch(/授课对象/);
    expect(gaps.objectives.join()).toMatch(/可观察行为/);
    expect(gaps.knowledge.join()).toMatch(/知识/);
  });
});

describe('series design text round-trip', () => {
  it('目标的格式化与解析回到同一份数据', () => {
    const base = doc();
    const text = formatObjectivesText(base.objectives, base);
    const parsed = parseObjectivesText(text, base.nodes);
    expect(parsed.errors).toEqual([]);
    expect(parsed.value).toEqual([
      {
        id: 'so_1',
        title: '能独立完成入门级 Web 题',
        expectedBehavior: '独立定位并利用题目漏洞拿到 flag',
        minCriteria: ['提交的 flag 正确'],
        evidence: 'Web 方向综合靶场',
        nodeIds: ['sn_1'],
      },
    ]);
  });

  it('知识点的格式化与解析回到同一份数据（含先修）', () => {
    const base = doc({
      nodes: [
        {
          id: 'sn_1',
          name: 'HTTP 基础',
          type: 'knowledge',
          summary: '请求与响应',
          difficulty: 'intro',
          prerequisites: [],
        },
        {
          id: 'sn_2',
          name: 'SQL 注入',
          type: 'skill',
          summary: '联合查询',
          difficulty: 'basic',
          prerequisites: ['sn_1'],
        },
      ],
      objectives: [{ ...doc().objectives[0], nodeIds: ['sn_1', 'sn_2'] }],
    });
    const parsed = parseNodesText(formatNodesText(base.nodes));
    expect(parsed.errors).toEqual([]);
    expect(parsed.value.map((node) => ({ ...node, id: undefined }))).toEqual(
      base.nodes.map((node) => ({ ...node, id: undefined })),
    );
  });

  it('解析失败时报告第几块、哪个引用不存在', () => {
    const parsed = parseObjectivesText(
      '## 能完成 Web 题\n能做什么：拿到 flag\n最低达标：flag 正确\n怎么证明：靶场\n支撑知识点：不存在的点',
      doc().nodes,
    );
    expect(parsed.errors.join()).toMatch(/不存在的点/);
  });
});

describe('series design ai answer', () => {
  it('解析带围栏的 JSON，并把名字引用接上', () => {
    const parsed = parseSeriesDesignAnswer(
      [
        '```json',
        JSON.stringify({
          objectives: [
            {
              title: '能完成 Web 题',
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
              summary: '',
              difficulty: 'intro',
              prerequisites: [],
            },
          ],
        }),
        '```',
      ].join('\n'),
    );
    expect(parsed.objectives[0].nodeIds).toEqual(['sn_1']);
  });

  it('只有目标没有节点时拒绝，因为目标会悬空', () => {
    expect(() =>
      parseSeriesDesignAnswer(JSON.stringify({ objectives: [{ title: 'A' }], nodes: [] })),
    ).toThrow(SeriesDesignInvalidError);
  });

  it('回答不是 JSON 时给出可读错误', () => {
    expect(() => parseSeriesDesignAnswer('抱歉，我无法完成')).toThrow(/JSON/);
  });
});

describe('series direction inheritance', () => {
  it('目留空的字段用系列方向回退，目自己写的不被覆盖', () => {
    const taskValues = directionValuesOf({
      title: 'CTF 概述',
      audience: null,
      learnerLevel: '目自己的基础',
      trainingScenario: null,
      applicationScene: null,
      durationHours: null,
      problemStatement: '这一目的范围',
    });
    const effective = effectiveDirectionValues(taskValues, {
      audience: '零基础学生',
      learnerLevel: '系列的基础',
      trainingScenario: '线下实训',
      applicationScene: '校内选拔赛',
      problemStatement: '系列的范围',
      durationHours: 54,
    });
    expect(effective.audience).toBe('零基础学生');
    expect(effective.learnerLevel).toBe('目自己的基础');
    expect(effective.durationHours).toBe(54);
    // 只有标题属于目：它是这一目的名字。范围与其它方向字段一样，目写了就用自己的。
    expect(effective.title).toBe('CTF 概述');
    expect(effective.problemStatement).toBe('这一目的范围');
  });

  it('目留空课程范围时也用系列范围，不再要求每一目重填一遍', () => {
    // 这条规则改过一次：原来说「范围属于目」，于是六十多个目各填一遍同一个范围。
    const effective = effectiveDirectionValues(
      directionValuesOf({
        title: 'CTF 概述',
        audience: null,
        learnerLevel: null,
        trainingScenario: null,
        applicationScene: null,
        durationHours: null,
        problemStatement: null,
      }),
      {
        audience: '零基础学生',
        learnerLevel: null,
        trainingScenario: null,
        applicationScene: null,
        problemStatement: '整个系列要解决的问题',
        durationHours: 54,
      },
    );
    expect(effective.problemStatement).toBe('整个系列要解决的问题');
    expect(effective.durationHours).toBe(54);
  });

  it('没有系列方向时原样返回', () => {
    const taskValues = directionValuesOf({ audience: null });
    expect(effectiveDirectionValues(taskValues, null)).toBe(taskValues);
  });

  it('只继承系列真正填了的字段，没填的留给目自己写', () => {
    expect(
      inheritableDirection({
        audience: '学生',
        learnerLevel: null,
        trainingScenario: null,
        applicationScene: null,
        problemStatement: null,
        durationHours: 54,
      }),
    ).toEqual({ audience: '学生', durationHours: 54 });
  });
});

describe('设计指纹与派生层过期判断', () => {
  it('同一份设计写两遍得到同一个指纹：集合顺序不影响', () => {
    const a = doc({
      nodes: [
        {
          id: 'sn_1',
          name: 'HTTP',
          type: 'knowledge',
          summary: '',
          difficulty: 'intro',
          prerequisites: ['sn_2', 'sn_3'],
        },
      ],
    });
    const b = doc({
      nodes: [
        {
          id: 'sn_1',
          name: 'HTTP',
          type: 'knowledge',
          summary: '',
          difficulty: 'intro',
          prerequisites: ['sn_3', 'sn_2'],
        },
      ],
    });
    expect(canonicalSeriesDesign(a)).toBe(canonicalSeriesDesign(b));
  });

  it('内容变了指纹就变：受众、目标、节点任一字段', () => {
    const base = canonicalSeriesDesign(doc());
    expect(
      canonicalSeriesDesign(
        doc({ direction: { ...doc().direction, audience: '换了一个授课对象' } }),
      ),
    ).not.toBe(base);
    expect(canonicalSeriesDesign(doc({ objectives: [] }))).not.toBe(base);
    expect(canonicalSeriesDesign(doc({ nodes: [] }))).not.toBe(base);
  });

  it('没有指纹的行不算过期：手写 / 导入的内容不该被喊旧版', () => {
    expect(isDerivedFromStaleDesign(null, 'fp')).toBe(false);
    expect(isDerivedFromStaleDesign(undefined, 'fp')).toBe(false);
    expect(isDerivedFromStaleDesign('fp', 'fp')).toBe(false);
    expect(isDerivedFromStaleDesign('old', 'fp')).toBe(true);
  });
});
