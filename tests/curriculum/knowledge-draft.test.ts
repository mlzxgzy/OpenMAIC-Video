/**
 * 草稿的纯规则：成行、可否采纳、合并连线。
 *
 * 这一层的存在是为了让"AI 给我一份草稿"这件事**在写库之前**就是可判定的。右栏画什么、
 * 哪一行能按、按下去写什么，全部来自这里；如果这些判定散在组件里，那么"草稿不落库"
 * 这条承诺就只剩一个按钮的 onClick 顺序在维持。
 */
import { describe, expect, it } from 'vitest';

import {
  describeKnowledgeLine,
  edgeEndpointsOf,
  knowledgeDraftOf,
  knowledgeLineBlockedBy,
  knowledgeLineId,
  lineAvailability,
  mergedLinkSet,
  nodeDraftForAdoption,
  type KnowledgeTurnLike,
} from '@/lib/curriculum/knowledge-draft';

const nodeNames = new Map([
  ['n1', 'HTTP 基础'],
  ['n2', '目录扫描'],
]);
const objectiveTitles = new Map([['o1', '能独立完成一次信息收集']]);

const turn = (patch: Partial<KnowledgeTurnLike> = {}): KnowledgeTurnLike => ({
  message: '我拆了 2 个知识点。',
  warnings: [],
  added: [],
  patches: new Map(),
  removed: new Set(),
  links: [],
  dependencies: [],
  removedDependencies: [],
  unmatchedRefs: [],
  rejectedRefs: [],
  ...patch,
});

describe('knowledgeDraftOf', () => {
  it('新节点与它指向的目标合成一行，而不是拆成节点行加连线行', () => {
    const draft = knowledgeDraftOf({
      turn: turn({
        added: [
          {
            name: '目录扫描',
            nodeType: 'skill',
            summary: '用字典枚举路径',
            difficulty: null,
            objectiveRefs: [{ objectiveRef: 'o1', supportLevel: 'primary' }],
          },
        ],
      }),
      instruction: '补齐知识点',
      nodeNameById: nodeNames,
      objectiveTitleById: objectiveTitles,
      currentLinks: [],
    });
    // 连线跟着新节点走：`setCurriculumNodeObjectives` 是整表替换，没有"只写一条"这种
    // 粒度，摊成两行等于承诺一个界面做不出来的操作。
    expect(draft.lines).toHaveLength(1);
    expect(draft.lines[0]).toMatchObject({ kind: 'node', name: '目录扫描' });
    expect(describeKnowledgeLine(draft.lines[0]!)).toContain('能独立完成一次信息收集');
  });

  it('这一轮没动的连线不成行', () => {
    const draft = knowledgeDraftOf({
      turn: turn({
        links: [
          { nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' },
          { nodeId: 'n2', objectiveId: 'o1', supportLevel: 'primary' },
        ],
      }),
      instruction: '看看还缺什么',
      nodeNameById: nodeNames,
      objectiveTitleById: objectiveTitles,
      currentLinks: [
        { nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' },
        { nodeId: 'n2', objectiveId: 'o1', supportLevel: 'primary' },
      ],
    });
    // `turn.links` 是整份集合，模型没碰也要全量带回来。全画出来就是一屏假建议。
    expect(draft.lines.filter((line) => line.kind === 'link')).toHaveLength(0);
  });

  it('支撑等级被改掉也算一行：那条连线确实变了', () => {
    const draft = knowledgeDraftOf({
      turn: turn({ links: [{ nodeId: 'n1', objectiveId: 'o1', supportLevel: 'secondary' }] }),
      instruction: '把支持强度改一下',
      nodeNameById: nodeNames,
      objectiveTitleById: objectiveTitles,
      currentLinks: [{ nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' }],
    });
    const links = draft.lines.filter((line) => line.kind === 'link');
    expect(links).toHaveLength(1);
    expect(links[0]).toMatchObject({ supportLevel: 'secondary' });
  });

  it('指向草稿节点的边带着"这个新知识点"的说法，不显示裸下标', () => {
    const draft = knowledgeDraftOf({
      turn: turn({
        added: [
          {
            name: '目录扫描',
            nodeType: 'skill',
            summary: null,
            difficulty: null,
            objectiveRefs: [],
          },
          {
            name: '指纹识别',
            nodeType: 'knowledge',
            summary: null,
            difficulty: null,
            objectiveRefs: [],
          },
        ],
        dependencies: [
          {
            source: { kind: 'draft', index: 0 },
            target: { kind: 'draft', index: 1 },
            edgeType: 'prerequisite',
            note: null,
          },
        ],
      }),
      instruction: '排个顺序',
      nodeNameById: nodeNames,
      objectiveTitleById: objectiveTitles,
      currentLinks: [],
    });
    const edge = draft.lines.find((line) => line.kind === 'edge');
    expect(edge).toMatchObject({
      sourceKey: 'draft:0',
      sourceLabel: '新知识点「目录扫描」',
      targetLabel: '新知识点「指纹识别」',
    });
    expect(describeKnowledgeLine(edge!)).toBe('新知识点「目录扫描」 → 新知识点「指纹识别」');
  });

  it('跳过的 ref 与没照做的部分各成一行说明，作者看得见这一轮丢了什么', () => {
    const draft = knowledgeDraftOf({
      turn: turn({
        unmatchedRefs: ['nope'],
        rejectedRefs: ['chapters 不在这一步'],
        removed: new Set(['n9']),
        removedDependencies: ['dep-12345678'],
      }),
      instruction: '改一改',
      nodeNameById: nodeNames,
      objectiveTitleById: objectiveTitles,
      currentLinks: [],
    });
    const notes = draft.lines.filter((line) => line.kind === 'drop').map((line) => line.text);
    expect(notes).toHaveLength(4);
    expect(notes.join('\n')).toContain('nope');
    expect(notes.join('\n')).toContain('dep-1234');
  });

  it('警告原样带到草稿上：这是关于这一轮的事实，不是关于图的', () => {
    const draft = knowledgeDraftOf({
      turn: turn({ warnings: ['这一轮没能加上的先后关系：会闭环'] }),
      instruction: '排顺序',
      nodeNameById: nodeNames,
      objectiveTitleById: objectiveTitles,
      currentLinks: [],
    });
    expect(draft.warnings).toEqual(['这一轮没能加上的先后关系：会闭环']);
  });
});

describe('lineAvailability', () => {
  const state = { statuses: {}, adoptedNodeIds: [] as string[] };

  it('说明行不需要采纳', () => {
    expect(lineAvailability({ kind: 'drop', text: 'x' }, state, 'drop:0')).toMatchObject({
      availability: 'done',
    });
  });

  it('指向草稿节点的边在那个节点被采纳前按不了，并且说得出缺哪一个', () => {
    const line = {
      kind: 'edge' as const,
      sourceKey: 'node:n1',
      sourceLabel: 'HTTP 基础',
      targetKey: 'draft:1',
      targetLabel: '新知识点「指纹识别」',
      edgeType: 'prerequisite' as const,
      note: null,
      removedEndpointKeys: [],
    };
    const waiting = lineAvailability(line, state, 'edge:a');
    expect(waiting.availability).toBe('waiting');
    expect(waiting.reason).toContain('指纹识别');
    // 目标那个草稿节点落地之后才能按——`createCurriculumDependency` 会校验端点归属。
    // 下标 1 才是这条边的目标，所以只落地下标 0 是不够的。
    expect(
      lineAvailability(line, { statuses: {}, adoptedNodeIds: ['other'] }, 'edge:a').availability,
    ).toBe('waiting');
    expect(
      lineAvailability(line, { statuses: {}, adoptedNodeIds: ['other', 'nid-1'] }, 'edge:a')
        .availability,
    ).toBe('ready');
  });

  it('两个端点都是草稿节点时，两个名字都点名', () => {
    const line = {
      kind: 'edge' as const,
      sourceKey: 'draft:0',
      sourceLabel: '新知识点「A」',
      targetKey: 'draft:1',
      targetLabel: '新知识点「B」',
      edgeType: 'prerequisite' as const,
      note: null,
      removedEndpointKeys: [],
    };
    const { reason } = lineAvailability(line, state, 'edge:a');
    expect(reason).toContain('A');
    expect(reason).toContain('B');
  });

  it('已经采纳的行不能再按，且理由不是"按不了"而是"按过了"', () => {
    const line = {
      kind: 'link' as const,
      nodeId: 'n1',
      nodeName: 'HTTP 基础',
      objectiveId: 'o1',
      objectiveTitle: '能独立完成一次信息收集',
      supportLevel: 'primary' as const,
    };
    expect(
      lineAvailability(
        line,
        { statuses: { 'link:n1:o1': 'adopted' }, adoptedNodeIds: [] },
        'link:n1:o1',
      ),
    ).toMatchObject({ availability: 'done', reason: '已采纳' });
  });

  it('丢弃可以撤销：作者反悔时不该被逼着重开一份草稿', () => {
    const line = {
      kind: 'patch' as const,
      nodeId: 'n1',
      nodeName: 'HTTP 基础',
      changes: [],
      patch: {},
    };
    expect(
      lineAvailability(
        line,
        { statuses: { 'patch:n1': 'dropped' }, adoptedNodeIds: [] },
        'patch:n1',
      ).availability,
    ).toBe('done');
    expect(lineAvailability(line, state, 'patch:n1').availability).toBe('ready');
  });
});

describe('edgeEndpointsOf', () => {
  const line = {
    kind: 'edge' as const,
    sourceKey: 'node:n1',
    sourceLabel: 'HTTP 基础',
    targetKey: 'draft:0',
    targetLabel: '新知识点「目录扫描」',
    edgeType: 'prerequisite' as const,
    note: null,
    removedEndpointKeys: [],
  };

  it('草稿端点还没有真实 id 时返回 null，而不是一个猜出来的 id', () => {
    expect(edgeEndpointsOf(line, { adoptedNodeIds: [] })).toBeNull();
    expect(edgeEndpointsOf(line, { adoptedNodeIds: ['real-1'] })).toEqual({
      sourceId: 'n1',
      targetId: 'real-1',
    });
  });
});

describe('nodeDraftForAdoption', () => {
  const line = {
    kind: 'node' as const,
    draftIndex: 0,
    name: '目录扫描',
    nodeType: 'skill' as const,
    summary: '用字典枚举路径',
    difficulty: null,
    objectiveRefs: [],
    objectiveTitles: [],
  };

  it('空改动沿用模型的名字，而不是写出一个空名字', () => {
    expect(nodeDraftForAdoption(line).name).toBe('目录扫描');
    expect(nodeDraftForAdoption(line, '   ').name).toBe('目录扫描');
  });

  it('"改一改"只改名字，其余保持模型的判断', () => {
    expect(nodeDraftForAdoption({ ...line, difficulty: 'basic' }, '  目录枚举  ')).toEqual({
      name: '目录枚举',
      nodeType: 'skill',
      summary: '用字典枚举路径',
      difficulty: 'basic',
    });
  });

  it('空的摘要与难度不发这个键，而不是发 null', () => {
    // 实读路由才发现的：`POST /nodes` 把"给了 null"判成非法取值而 400，"没给"才是清空。
    // 发了 null 的话，每一条没写摘要的草稿都会以一个与建议本身无关的理由被拒。
    expect(nodeDraftForAdoption({ ...line, summary: null, difficulty: null })).toEqual({
      name: '目录扫描',
      nodeType: 'skill',
    });
    expect(nodeDraftForAdoption({ ...line, summary: null, difficulty: 'basic' })).toEqual({
      name: '目录扫描',
      nodeType: 'skill',
      difficulty: 'basic',
    });
  });
});

describe('mergedLinkSet', () => {
  it('采纳一个新节点不会删掉别的节点的支撑', () => {
    const merged = mergedLinkSet({
      current: [
        { nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' },
        { nodeId: 'n2', objectiveId: 'o1', supportLevel: 'secondary' },
      ],
      line: {
        kind: 'node',
        draftIndex: 0,
        name: '目录扫描',
        nodeType: 'skill',
        summary: null,
        difficulty: null,
        objectiveRefs: [{ objectiveId: 'o2', supportLevel: 'primary' }],
        objectiveTitles: [],
      },
      newNodeId: 'n3',
    });
    // 全表替换：少一条就是一次静默的删除，而它只会在后面某一步表现为"这个目标没东西可讲"。
    expect(merged).toHaveLength(3);
    expect(merged.filter((link) => link.nodeId !== 'n3')).toHaveLength(2);
  });
});

describe('knowledgeLineId 与依赖提示', () => {
  it('行 id 跨渲染不变', () => {
    const line = {
      kind: 'link' as const,
      nodeId: 'n1',
      nodeName: 'HTTP 基础',
      objectiveId: 'o1',
      objectiveTitle: 'x',
      supportLevel: 'primary' as const,
    };
    expect(knowledgeLineId(line, 0)).toBe(knowledgeLineId(line, 7));
  });

  it('说明行的 id 靠下标，因为它本身没有别的键', () => {
    expect(knowledgeLineId({ kind: 'drop', text: 'a' }, 0)).toBe('drop:0');
    expect(knowledgeLineId({ kind: 'drop', text: 'a' }, 1)).toBe('drop:1');
  });

  it('一条边依赖哪几个草稿节点，界面照它画', () => {
    const lines = [
      {
        kind: 'node' as const,
        draftIndex: 0,
        name: 'A',
        nodeType: 'skill' as const,
        summary: null,
        difficulty: null,
        objectiveRefs: [],
        objectiveTitles: [],
      },
      {
        kind: 'node' as const,
        draftIndex: 1,
        name: 'B',
        nodeType: 'skill' as const,
        summary: null,
        difficulty: null,
        objectiveRefs: [],
        objectiveTitles: [],
      },
      {
        kind: 'edge' as const,
        sourceKey: 'draft:0',
        sourceLabel: 'A',
        targetKey: 'draft:1',
        targetLabel: 'B',
        edgeType: 'prerequisite' as const,
        note: null,
        removedEndpointKeys: [],
      },
    ];
    expect(knowledgeLineBlockedBy(lines[2]!, lines, knowledgeLineId)).toEqual([
      'node:draft-0',
      'node:draft-1',
    ]);
  });
});
