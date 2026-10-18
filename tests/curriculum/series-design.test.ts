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
  appendNodeCandidates,
  appendObjectiveCandidates,
  canonicalSeriesDesign,
  countDroppedNodePrerequisites,
  formatNodesText,
  formatObjectivesText,
  groupSeriesNodes,
  groupSeriesObjectives,
  inheritableDirection,
  isDerivedFromStaleDesign,
  mergeSeriesDesign,
  normalizeSeriesDesignDoc,
  objectiveTypeValue,
  parseNodesText,
  parseObjectivesText,
  parseSeriesDesignAnswer,
  parseSeriesDirectionAnswer,
  parseSeriesKnowledgeCandidatesAnswer,
  parseSeriesObjectiveCandidatesAnswer,
  screenNodeCandidates,
  screenObjectiveCandidates,
  SeriesDirectionInvalidError,
  seriesDesignComplete,
  seriesDesignGaps,
  seriesDesignPhase,
  SeriesDesignInvalidError,
  SeriesKnowledgeCandidatesInvalidError,
  SeriesObjectiveCandidatesInvalidError,
  seriesObjectiveTypeLabel,
  validateSeriesDesignPatch,
  type SeriesDesignDoc,
  type SeriesKnowledgeCandidate,
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
        type: 'competency',
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
    expect(text).toContain('类型：能力');
    expect(parsed.value).toEqual([
      {
        id: 'so_1',
        type: 'competency',
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

describe('series direction ai answer', () => {
  it('解析方向草稿：只收六个槽位，学时收成数字，未知键丢掉', () => {
    const direction = parseSeriesDirectionAnswer(
      JSON.stringify({
        direction: {
          audience: '零基础高校网络安全专业学生',
          learnerLevel: '会 Linux 基本命令',
          trainingScenario: '线下集中实训',
          applicationScene: '校内选拔赛',
          problemStatement: '覆盖 CTF 五个方向',
          durationHours: '54 学时',
          title: '模型自造的标题',
          notes: '模型自造的备注',
        },
      }),
    );
    expect(direction).toEqual({
      audience: '零基础高校网络安全专业学生',
      learnerLevel: '会 Linux 基本命令',
      trainingScenario: '线下集中实训',
      applicationScene: '校内选拔赛',
      problemStatement: '覆盖 CTF 五个方向',
      durationHours: 54,
    });
  });

  it('模型把对象摊平时也认，空字符串算未填写', () => {
    const direction = parseSeriesDirectionAnswer(
      JSON.stringify({
        audience: '校队成员',
        learnerLevel: '',
        problemStatement: null,
        durationHours: null,
      }),
    );
    expect(direction.audience).toBe('校队成员');
    expect(direction.learnerLevel).toBeNull();
    expect(direction.problemStatement).toBeNull();
    expect(direction.durationHours).toBeNull();
  });

  it('没有授课对象时拒绝：这份草稿没回答"谁学"', () => {
    expect(() =>
      parseSeriesDirectionAnswer(JSON.stringify({ direction: { audience: '' } })),
    ).toThrow(SeriesDirectionInvalidError);
  });

  it('回答不是 JSON 时给出可读错误', () => {
    expect(() => parseSeriesDirectionAnswer('好的，我来写。')).toThrow(/JSON/);
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

describe('课程目标的类型与候选清单', () => {
  it('类型两种写法都认：枚举与中文标签', () => {
    expect(objectiveTypeValue('knowledge')).toBe('knowledge');
    expect(objectiveTypeValue('技能')).toBe('skill');
    expect(objectiveTypeValue(' 能力 ')).toBe('competency');
    expect(objectiveTypeValue('任务')).toBe('task');
    expect(objectiveTypeValue('')).toBeNull();
    expect(objectiveTypeValue(undefined)).toBeNull();
    expect(objectiveTypeValue('玄学')).toBeNull();
    expect(seriesObjectiveTypeLabel(null)).toBe('未分类');
    expect(seriesObjectiveTypeLabel('competency')).toBe('能力');
  });

  it('按类型分组：知识 → 技能 → 能力 → 任务，未分类排最后，组内保持原顺序', () => {
    const objectives = [
      { id: 'so_1', type: 'task' as const, title: 'T1' },
      { id: 'so_2', type: 'knowledge' as const, title: 'K1' },
      { id: 'so_3', type: null, title: 'U1' },
      { id: 'so_4', type: 'skill' as const, title: 'S1' },
      { id: 'so_5', type: 'knowledge' as const, title: 'K2' },
    ];
    const groups = groupSeriesObjectives(objectives);
    expect(groups.map((group) => group.type)).toEqual(['knowledge', 'skill', 'task', null]);
    expect(groups[0].items.map((objective) => objective.title)).toEqual(['K1', 'K2']);
    expect(groups[3].items.map((objective) => objective.title)).toEqual(['U1']);
  });

  it('解析候选：中文类型、字符串达标线都认；残缺与重复被丢掉；结果按类型排序', () => {
    const valid = [
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
        type: 'knowledge',
        expectedBehavior: '说清触发条件',
        minCriteria: '三类成因说对',
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
      // 残缺候选：没有类型 / 没写行为 / 与已有候选重复（空白不同）。
      {
        title: '没有类型的目标',
        expectedBehavior: '行为',
        minCriteria: ['标准'],
        evidence: '证据',
      },
      {
        title: '没有可观察行为的目标',
        type: 'skill',
        minCriteria: ['标准'],
        evidence: '证据',
      },
      {
        title: '能解释 注入成因',
        type: 'knowledge',
        expectedBehavior: '说清触发条件',
        minCriteria: ['三类成因说对'],
        evidence: '理论题',
      },
    ];
    const parsed = parseSeriesObjectiveCandidatesAnswer(JSON.stringify({ objectives: valid }));
    expect(parsed).toHaveLength(8);
    expect(parsed.map((candidate) => candidate.type)).toEqual([
      'knowledge',
      'knowledge',
      'knowledge',
      'skill',
      'skill',
      'competency',
      'task',
      'task',
    ]);
    // 字符串达标线被拆开，不是整段丢掉。
    expect(parsed[0].minCriteria).toEqual(['三类成因说对']);
    expect(parsed[0].title).toBe('能解释注入成因');
  });

  it('可用候选太少时整份拒绝：挑不出东西和生成失败对用户是一回事', () => {
    expect(() =>
      parseSeriesObjectiveCandidatesAnswer(
        JSON.stringify({
          objectives: [
            {
              title: '能完成 Web 题',
              type: 'skill',
              expectedBehavior: '拿到 flag',
              minCriteria: ['flag 正确'],
              evidence: '靶场',
            },
          ],
        }),
      ),
    ).toThrow(SeriesObjectiveCandidatesInvalidError);
  });

  it('已有目标去重按"去空白"比较；追加只加新条目，不动已有目标', () => {
    const existing = doc().objectives;
    const candidates = [
      {
        title: '能独立完成入门级Web题',
        type: 'competency' as const,
        expectedBehavior: '行为',
        minCriteria: ['标准'],
        evidence: '证据',
      },
      {
        title: '能完成一套入门赛题',
        type: 'task' as const,
        expectedBehavior: '限时独立完成',
        minCriteria: ['拿到 3 个 flag'],
        evidence: '模拟赛',
      },
    ];
    expect(screenObjectiveCandidates(candidates, existing)).toHaveLength(1);
    const next = appendObjectiveCandidates(existing, candidates);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(existing[0]);
    expect(next[1]).toMatchObject({
      id: 'so_2',
      type: 'task',
      title: '能完成一套入门赛题',
      nodeIds: [],
    });
  });

  it('文本编辑：旧格式没有「类型」行，读成未分类；写错类型报错而不是静默丢弃', () => {
    const legacy = parseObjectivesText(
      '## 能完成 Web 题\n能做什么：拿到 flag\n最低达标：flag 正确\n怎么证明：靶场\n支撑知识点：SQL 注入原理',
      doc().nodes,
    );
    expect(legacy.errors).toEqual([]);
    expect(legacy.value[0].type).toBeNull();

    const bad = parseObjectivesText('## 能完成 Web 题\n类型：玄学\n能做什么：拿到 flag', []);
    expect(bad.errors.join()).toMatch(/类型/);
  });

  it('保存接口接受类型；读不懂的类型 400 而不是静默存成 null', () => {
    const patch = validateSeriesDesignPatch(
      {
        objectives: [
          {
            ...doc().objectives[0],
            type: '知识',
          },
        ],
      },
      doc(),
    );
    expect(patch.objectives?.[0].type).toBe('knowledge');

    expect(() =>
      validateSeriesDesignPatch({ objectives: [{ ...doc().objectives[0], type: '玄学' }] }, doc()),
    ).toThrow(/类型/);
  });

  it('指纹：类型有值才参与，旧设计的指纹不变', () => {
    const legacy = doc({ objectives: [{ ...doc().objectives[0], type: null }] });
    const expectedLegacy = [
      'v1',
      '零基础高校网络安全专业学生',
      '会 Linux 基本命令',
      '线下集中实训',
      '校内选拔赛',
      '覆盖 CTF 五个方向，不做内网渗透',
      '54',
      [
        'so_1',
        '能独立完成入门级 Web 题',
        '独立定位并利用题目漏洞拿到 flag',
        '提交的 flag 正确',
        'Web 方向综合靶场',
        'sn_1',
      ].join('\u0002'),
      ['sn_1', 'SQL 注入原理', 'knowledge', '注入成因与常见手法', 'intro', ''].join('\u0002'),
    ].join('\u0004');
    expect(canonicalSeriesDesign(legacy)).toBe(expectedLegacy);
    // 分类是设计的一部分：改了它，指纹跟着变。
    expect(canonicalSeriesDesign(doc())).not.toBe(canonicalSeriesDesign(legacy));
  });
});

/**
 * 第 3 步的候选池：生成、筛选、勾选采用。
 *
 * 这里钉的是"采用"这一步的正确性，不是模型质量：
 * - 类型 / 难度两种写法（枚举与中文）都收成枚举；
 * - 名字去重按折叠空白后的键，先修去掉自引用；
 * - 采用是追加，先修解析成 id，指向未勾选候选的引用被丢弃（而不是留下坏引用
 *   让保存接口 400）；
 * - 采用结果本身必须能通过保存校验（不会成环）。
 */
describe('AI 生成候选知识 / 技能点', () => {
  const ANSWER = JSON.stringify({
    nodes: [
      {
        name: '用 sqlmap 完成联合注入',
        type: '技能',
        summary: '跑通 sqlmap 并取出目标表数据',
        difficulty: '中等',
        prerequisites: ['SQL 注入原理'],
      },
      {
        name: 'SQL 注入原理',
        type: '知识点',
        summary: '注入成因与常见手法',
        difficulty: '基础',
        // 自引用：必须被丢掉，否则采用后会变成"自己先修自己"。
        prerequisites: ['SQL 注入原理'],
      },
      {
        name: 'HTTP 基础',
        type: 'knowledge',
        summary: '请求响应、状态码、Cookie',
        difficulty: '入门',
        prerequisites: [],
      },
      // 与上一条只差空白：按名字键去重。
      { name: 'HTTP基础', type: '知识', summary: '重复', difficulty: '入门' },
      {
        name: '信息收集',
        type: 'knowledge',
        summary: '目录扫描、指纹识别',
        difficulty: '基础',
        prerequisites: [],
      },
      {
        name: '联合注入',
        type: 'knowledge',
        summary: 'UNION 回显的构造',
        difficulty: '进阶',
        prerequisites: ['SQL 注入原理'],
      },
      {
        name: '目录扫描',
        type: 'skill',
        summary: '用 ffuf 扫出隐藏目录',
        difficulty: '基础',
        prerequisites: ['HTTP 基础'],
      },
      {
        name: '抓包分析',
        type: 'skill',
        summary: '用 Wireshark 过滤并提取文件',
        difficulty: '进阶',
        prerequisites: [],
      },
      {
        name: '编写 Writeup',
        type: 'skill',
        summary: '把解题过程写成别人能复现的文档',
        difficulty: '高级',
        prerequisites: [],
      },
      // 缺名字 / 缺类型：丢弃，但不会让整份回答不可用。
      { type: 'knowledge', summary: '没有名字' },
      { name: '没有类型', summary: '认不出类型' },
    ],
  });

  const candidate = (
    overrides: Partial<SeriesKnowledgeCandidate> = {},
  ): SeriesKnowledgeCandidate => ({
    name: '新知识点',
    type: 'knowledge',
    summary: '摘要',
    difficulty: 'basic',
    prerequisites: [],
    ...overrides,
  });

  it('解析：中文类型 / 难度收成枚举，去重、去自引用，按类型与难度排序', () => {
    const parsed = parseSeriesKnowledgeCandidatesAnswer(ANSWER);
    expect(parsed.map((entry) => entry.name)).toEqual([
      'HTTP 基础',
      'SQL 注入原理',
      '信息收集',
      '联合注入',
      '目录扫描',
      '用 sqlmap 完成联合注入',
      '抓包分析',
      '编写 Writeup',
    ]);
    expect(parsed[0]).toMatchObject({ type: 'knowledge', difficulty: 'intro' });
    // 自引用被丢掉。
    expect(parsed[1].prerequisites).toEqual([]);
    // 技能点可以引用知识。
    expect(parsed[5].prerequisites).toEqual(['SQL 注入原理']);
    expect(parsed[6].difficulty).toBe('intermediate');
    // 类型认不出的候选被丢弃，不参与排序。
    expect(parsed.some((entry) => entry.name === '没有类型')).toBe(false);
  });

  it('解析：可用候选少于下限时整份拒绝', () => {
    expect(() =>
      parseSeriesKnowledgeCandidatesAnswer(
        JSON.stringify({ nodes: [{ name: '只有一个', type: 'knowledge' }] }),
      ),
    ).toThrow(SeriesKnowledgeCandidatesInvalidError);
    expect(() =>
      parseSeriesKnowledgeCandidatesAnswer(
        JSON.stringify({ nodes: [{ name: '只有一个', type: 'knowledge' }] }),
      ),
    ).toThrow(/至少 8 个/);
  });

  it('筛选：与已有节点重名的候选不出现（折叠空白比较）', () => {
    const screened = screenNodeCandidates(parseSeriesKnowledgeCandidatesAnswer(ANSWER), [
      { ...doc().nodes[0], name: 'SQL 注入原理' },
    ]);
    expect(screened.some((entry) => entry.name === 'SQL 注入原理')).toBe(false);
  });

  it('采用：追加到已有节点之后，先修解析成 id，指向未勾选候选的引用被丢弃', () => {
    const existing = doc().nodes;
    const selected: SeriesKnowledgeCandidate[] = [
      candidate({ name: 'HTTP 基础', difficulty: 'intro' }),
      candidate({
        name: '联合注入',
        difficulty: 'intermediate',
        prerequisites: ['SQL 注入原理', 'HTTP 基础', '未勾选的点'],
      }),
      candidate({
        name: '用 sqlmap 完成联合注入',
        type: 'skill',
        difficulty: 'intermediate',
        prerequisites: ['联合注入'],
      }),
      // 已有节点重名：不追加第二次。
      candidate({ name: 'SQL 注入原理' }),
    ];
    const merged = appendNodeCandidates(existing, selected);

    expect(merged.map((node) => node.id)).toEqual(['sn_1', 'sn_2', 'sn_3', 'sn_4']);
    expect(merged.map((node) => node.name)).toEqual([
      'SQL 注入原理',
      'HTTP 基础',
      '联合注入',
      '用 sqlmap 完成联合注入',
    ]);
    // 已有节点原样不动。
    expect(merged[0]).toEqual(existing[0]);
    // 已有节点 / 前面已选候选 → id；未勾选的点 → 丢掉。
    expect(merged[2].prerequisites).toEqual(['sn_1', 'sn_2']);
    expect(merged[3].prerequisites).toEqual(['sn_3']);

    // 采用结果必须能通过保存校验：先修都有落点、不成环。
    expect(() =>
      validateSeriesDesignPatch({ nodes: merged }, { ...doc(), nodes: existing }),
    ).not.toThrow();
  });

  it('采用前先算清楚：有多少条先修引用会落不了地', () => {
    const existing = doc().nodes;
    const selected = [
      candidate({
        name: '联合注入',
        prerequisites: ['SQL 注入原理', 'HTTP 基础', '未勾选的点'],
      }),
    ];
    // 已有 SQL 注入原理；HTTP 基础与「未勾选的点」都没选 → 两条落不了地。
    expect(countDroppedNodePrerequisites(existing, selected)).toBe(2);
    expect(
      countDroppedNodePrerequisites(existing, [candidate({ prerequisites: ['SQL 注入原理'] })]),
    ).toBe(0);
  });

  it('分组：知识在前、技能在后，组内由浅入深', () => {
    const groups = groupSeriesNodes([
      candidate({ name: '高级技能', type: 'skill', difficulty: 'advanced' }),
      candidate({ name: '入门知识', type: 'knowledge', difficulty: 'intro' }),
      candidate({ name: '基础技能', type: 'skill', difficulty: 'basic' }),
      candidate({ name: '进阶知识', type: 'knowledge', difficulty: 'intermediate' }),
    ]);
    expect(groups.map((group) => group.type)).toEqual(['knowledge', 'skill']);
    expect(groups[0].items.map((item) => item.name)).toEqual(['入门知识', '进阶知识']);
    expect(groups[1].items.map((item) => item.name)).toEqual(['基础技能', '高级技能']);
  });
});
