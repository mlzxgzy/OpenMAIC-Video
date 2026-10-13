/**
 * 通用草稿引擎的纯规则，以及**它与真实写入路由的一致性**。
 *
 * 后者是这一层最要紧的测试。草稿的行会由引擎原样发成 HTTP 请求，所以"草稿里写的
 * 字段"和"路由认识的字段"如果对不上，表现是**采纳时才失败**——而作者看到的是一句
 * 与这条建议本身无关的"采纳失败"，界面上没有任何线索指向哪个字段错了。把这些字段钉在
 * 这里，等于让"这条建议能落库"在起草时刻就被证明过一次。
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  assertDraftRouteSafe,
  resolveStepLineWrite,
  stepLineAvailability,
  stepLineBlockedBy,
  substituteFreshId,
  FRESH_ID,
  type StepDraftLine,
} from '@/lib/curriculum/step-draft';
import {
  outcomesDraftConflicts,
  outcomesDraftOf,
  type OutcomesDraftBoard,
} from '@/lib/curriculum/outcomes-draft';
import type { CourseOutcomesResult } from '@/lib/server/curriculum/outcomes-step';
import type { EvidenceDraft } from '@/lib/curriculum/design-outcomes';

const line = (over: Partial<StepDraftLine> = {}): StepDraftLine => ({
  id: 'x',
  text: '写一行',
  ...over,
});

describe('草稿引擎：可否采纳', () => {
  it('没有依赖的行总是可按——失败留给路由自己报错', () => {
    expect(stepLineAvailability(line(), { statuses: {}, producedIds: {} }).availability).toBe(
      'ready',
    );
  });

  it('说明行不可按，且说清为什么', () => {
    const result = stepLineAvailability(line({ note: '这行没写进去' }), {
      statuses: {},
      producedIds: {},
    });
    expect(result.availability).toBe('done');
    expect(result.reason).toContain('不需要采纳');
  });

  it('依赖没落地时不可按，并点名要等哪一行', () => {
    const dependent = line({
      id: 'b',
      create: {
        route: '/api/curriculum/design/tasks/t/objectives',
        body: {},
        idKey: 'objective',
        needs: [{ lineId: 'a', key: 'objectiveId', label: '新建目标' }],
      },
    });
    const waiting = stepLineAvailability(dependent, { statuses: {}, producedIds: {} });
    expect(waiting.availability).toBe('waiting');
    expect(waiting.reason).toContain('新建目标');

    const ready = stepLineAvailability(dependent, {
      statuses: {},
      producedIds: { a: 'o-real' },
    });
    expect(ready.availability).toBe('ready');
  });

  it('依赖可以有多条，全部落地才可按', () => {
    const both = line({
      id: 'c',
      create: {
        route: '/api/curriculum/design/tasks/t/dependencies',
        body: {},
        idKey: 'edge',
        needs: [
          { lineId: 'a', key: 'sourceId', label: '前置知识点' },
          { lineId: 'b', key: 'targetId', label: '后继知识点' },
        ],
      },
    });
    expect(
      stepLineAvailability(both, { statuses: {}, producedIds: { a: 'n1' } }).availability,
    ).toBe('waiting');
    expect(
      stepLineAvailability(both, { statuses: {}, producedIds: { a: 'n1', b: 'n2' } }).availability,
    ).toBe('ready');
  });

  it('已采纳与已丢弃都不再可按', () => {
    for (const status of ['adopted', 'dropped'] as const) {
      expect(
        stepLineAvailability(line(), { statuses: { x: status }, producedIds: {} }).availability,
      ).toBe('done');
    }
  });

  it('依赖线只画存在于这份草稿里的依赖', () => {
    const a = line({ id: 'a' });
    const b = line({
      id: 'b',
      write: { method: 'POST', route: '/api/curriculum/design/tasks/t/evidence', body: {} },
      needs: [{ lineId: 'a', key: 'objectiveId', label: '目标' }],
    });
    expect(stepLineBlockedBy(b, [a, b])).toEqual(['a']);
    // 依赖一个不在草稿里的行（库里已有的东西）不该被画成"先采纳某行"。
    expect(stepLineBlockedBy(b, [b])).toEqual([]);
  });
});

describe('草稿引擎：采纳时发什么', () => {
  it('没有 write 也没有 create 的行不能按——错误要说清是引擎的不变量被破坏了', () => {
    expect(() => resolveStepLineWrite(line(), NO_EDITS, emptyLive())).toThrow(/没有需要采纳的写入/);
  });

  it('"改一改"只在作者真的改了名字时才进 body', () => {
    const target = line({
      name: '原名',
      nameKey: 'title',
      write: {
        method: 'PATCH',
        route: '/api/curriculum/design/tasks/t/o/1',
        body: { title: '原名' },
      },
    });
    expect(resolveStepLineWrite(target, NO_EDITS, emptyLive()).write.body).toEqual({
      title: '原名',
    });
    expect(
      resolveStepLineWrite(target, { edits: { x: '  新名  ' }, producedIds: {} }, emptyLive()).write
        .body,
    ).toEqual({ title: '新名' });
  });

  it('"改一改"对**新建**那类行同样生效——引擎通用化的第一版在这里丢过返回值', () => {
    // `renamed()` 返回新对象而不改入参；通用化时新建那条路写成了 `renamed(body);`，返回值被
    // 丢掉，于是"改一改"在界面上改得动、库里还是模型给的原名。单元测试当时只覆盖了 `write`
    // 那条路（用返回值的），所以全绿；是 e2e 读库读出来的。两条路都要钉。
    const target = line({
      name: '原名',
      nameKey: 'name',
      create: {
        route: '/api/curriculum/design/tasks/t/nodes',
        body: { name: '原名', nodeType: 'knowledge' },
        idKey: 'node',
      },
    });
    expect(resolveStepLineWrite(target, NO_EDITS, emptyLive()).write.body).toEqual({
      name: '原名',
      nodeType: 'knowledge',
    });
    expect(
      resolveStepLineWrite(target, { edits: { x: '新名' }, producedIds: {} }, emptyLive()).write
        .body,
    ).toEqual({ name: '新名', nodeType: 'knowledge' });
  });

  it('"改一改"与"依赖回填"同时存在时，两者都进 body', () => {
    // 名字的写入与依赖的写入先后顺序在这里是可见的：依赖回填发生在改名之后，所以它不会把
    // 改好的名字盖回去。
    const target = line({
      name: '原名',
      nameKey: 'name',
      create: {
        route: '/api/curriculum/design/tasks/t/nodes',
        body: { name: '原名' },
        idKey: 'node',
        needs: [{ lineId: 'a', key: 'parentId', label: '父级' }],
      },
    });
    expect(
      resolveStepLineWrite(target, { edits: { x: '新名' }, producedIds: { a: 'n-9' } }, emptyLive())
        .write.body,
    ).toEqual({ name: '新名', parentId: 'n-9' });
  });

  it('依赖的 id 在采纳那一刻填进 body', () => {
    const target = line({
      create: {
        route: '/api/curriculum/design/tasks/t/evidence',
        body: { evidenceType: 'quiz' },
        idKey: 'evidence',
        needs: [{ lineId: 'a', key: 'objectiveId', label: '目标' }],
      },
    });
    expect(
      resolveStepLineWrite(target, { edits: {}, producedIds: { a: 'o-1' } }, emptyLive()).write
        .body,
    ).toEqual({ evidenceType: 'quiz', objectiveId: 'o-1' });
  });

  it('依赖没落地就采纳，抛出的消息点名要等哪一行', () => {
    const target = line({
      create: {
        route: '/api/curriculum/design/tasks/t/evidence',
        body: {},
        idKey: 'evidence',
        needs: [{ lineId: 'a', key: 'objectiveId', label: '新建目标' }],
      },
    });
    expect(() => resolveStepLineWrite(target, NO_EDITS, emptyLive())).toThrow(/新建目标/);
  });

  it('后续跳的 #id 在第一跳之后才替换，且是递归替换', () => {
    expect(
      substituteFreshId({ objectiveId: FRESH_ID, nested: { list: [FRESH_ID] } }, 'o-9'),
    ).toEqual({ objectiveId: 'o-9', nested: { list: ['o-9'] } });
  });

  it('整表替换的行按采纳那一刻的库算 body：当前全集 + 并进去的那几条', () => {
    const target = line({
      mergeInto: {
        method: 'PUT',
        route: '/api/curriculum/design/tasks/t/node-objectives',
        rows: [{ nodeId: 'n2', objectiveId: 'o1', supportLevel: 'secondary' }],
        source: 'nodeObjectives',
        key: ['nodeId', 'objectiveId'],
        bodyKey: 'links',
      },
    });
    const live = {
      nodeObjectives: [
        { nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' },
        { nodeId: 'n3', objectiveId: 'o2', supportLevel: 'primary' },
      ],
      unitCoverage: [],
    };
    // 关键在于**别人没提到的行必须原样带过**：少带一条就删掉一条，而那不会报错。
    expect(resolveStepLineWrite(target, NO_EDITS, live).write.body).toEqual({
      links: [
        { nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' },
        { nodeId: 'n3', objectiveId: 'o2', supportLevel: 'primary' },
        { nodeId: 'n2', objectiveId: 'o1', supportLevel: 'secondary' },
      ],
    });
  });

  it('同 key 的以并进去的为准——作者重新挂了一次同一个端点对', () => {
    const target = line({
      mergeInto: {
        method: 'PUT',
        route: '/api/curriculum/design/tasks/t/node-objectives',
        rows: [{ nodeId: 'n1', objectiveId: 'o1', supportLevel: 'secondary' }],
        source: 'nodeObjectives',
        key: ['nodeId', 'objectiveId'],
        bodyKey: 'links',
      },
    });
    expect(
      resolveStepLineWrite(target, NO_EDITS, {
        nodeObjectives: [{ nodeId: 'n1', objectiveId: 'o1', supportLevel: 'primary' }],
        unitCoverage: [],
      }).write.body,
    ).toEqual({ links: [{ nodeId: 'n1', objectiveId: 'o1', supportLevel: 'secondary' }] });
  });

  it('body 键由服务端给出：`links` 与 `rows` 两个整表替换路由不同', () => {
    const target = line({
      mergeInto: {
        method: 'PUT',
        route: '/api/curriculum/design/tasks/t/unit-coverage',
        rows: [{ unitId: 'u1', objectiveId: 'o1', coverageKind: 'teach' }],
        source: 'unitCoverage',
        key: ['unitId', 'objectiveId'],
        bodyKey: 'rows',
      },
    });
    expect(
      resolveStepLineWrite(target, NO_EDITS, { nodeObjectives: [], unitCoverage: [] }).write.body,
    ).toEqual({ rows: [{ unitId: 'u1', objectiveId: 'o1', coverageKind: 'teach' }] });
  });

  it('草稿行里没有函数：它们要从服务端发到浏览器', () => {
    // 第一版这里是一个 `replaceFromLive(live)` 回调，它可以写出正确的合并逻辑，然后**过不了
    // JSON**——`JSON.stringify` 把函数变成 `undefined`，于是每一行都退化成"没有后续跳"，
    // 而当时所有测试都跑在服务端，全绿。只有真的过一遍 HTTP 的 e2e 看得到它。
    // 这条断言盯住的就是"行是纯数据"这条不变量。
    const target = line({
      mergeInto: {
        method: 'PUT',
        route: '/api/curriculum/design/tasks/t/node-objectives',
        rows: [{ nodeId: 'n1' }],
        source: 'nodeObjectives',
        key: ['nodeId', 'objectiveId'],
        bodyKey: 'links',
      },
    });
    const draft = { lines: [target], message: '', warnings: [], instruction: 'x' };
    expect(JSON.parse(JSON.stringify(draft))).toEqual(draft);
  });
});

describe('草稿引擎：路径必须在本设计的路由表下', () => {
  it('越界的路径被拒绝', () => {
    expect(() => assertDraftRouteSafe('/api/users')).toThrow(/越界/);
    expect(() => assertDraftRouteSafe('/api/curriculum/courses')).toThrow(/越界/);
    expect(assertDraftRouteSafe('/api/curriculum/design/tasks/t1/objectives')).toContain('tasks');
  });
});

describe('学习目标草稿：与写入路由一致', () => {
  const board: OutcomesDraftBoard = { objectives: [{ id: 'o1', title: '能独立完成一次信息收集' }] };

  const result = (over: Partial<CourseOutcomesResult> = {}): CourseOutcomesResult => ({
    message: '我加了 1 条目标。',
    added: [],
    patches: new Map(),
    removed: new Set(),
    evidence: [],
    confirmRequested: false,
    unmatchedRefs: [],
    rejectedRefs: [],
    gaps: [],
    userTurns: 2,
    ...over,
  });

  it('新建目标是一次 POST，不发 sortOrder——顺序不替作者决定', () => {
    const draft = outcomesDraftOf({
      turn: result({
        added: [
          {
            title: '能读懂 HTTP 响应',
            objectiveType: 'skill',
            expectedBehavior: '能指出响应头里各字段的作用',
            minCriteria: [],
            description: null,
            evidence: [],
          },
        ],
      }),
      before: board,
      taskId: 't1',
      instruction: '补一条目标',
    });
    const created = draft.lines[0];
    expect(created.create?.route).toMatch(/\/api\/curriculum\/design\/tasks\/[^/]+\/objectives$/);
    expect(created.create?.body).not.toHaveProperty('sortOrder');
    expect(created.create?.body).toMatchObject({ title: '能读懂 HTTP 响应' });
  });

  it('证据默认 assessmentMode=practice、hintPolicy=unlimited、independent=true，与写入端同一个缺省', () => {
    // 这三个值一旦与 `outcomes/turn` 路由那个 `evidenceInput` 不一致，就会出现"草稿里显示
    // 一种、库里落成另一种"，而界面上看不出差别。
    const route = readFileSync(
      'app/api/curriculum/design/tasks/[id]/outcomes/turn/route.ts',
      'utf8',
    );
    const helper = /function evidenceInput\([\s\S]*?\n}/.exec(route)?.[0] ?? '';
    for (const fallback of [
      `assessmentMode: binding.assessmentMode ?? 'practice'`,
      `hintPolicy: binding.hintPolicy ?? 'unlimited'`,
      `independent: binding.independent ?? true`,
    ]) {
      expect(helper).toContain(fallback);
    }
    const draft = outcomesDraftOf({
      turn: result({
        added: [
          {
            title: 'T',
            objectiveType: 'skill',
            expectedBehavior: 'B',
            minCriteria: [],
            description: null,
            evidence: [
              // 模型不写等级，`sanitizeEvidence` 补上缺省——所以这里**故意**给一份缺了三个
              // 字段的证据，正是"模型给了但什么都没写"的那种情况，也是这条测试要覆盖的。
              {
                evidenceType: 'quiz',
                verificationMethod: '提交答案自动比对',
                successCondition: '8 题对 6 题',
              } as EvidenceDraft,
            ],
          },
        ],
      }),
      before: board,
      taskId: 't1',
      instruction: 'x',
    });
    expect(draft.lines[0].create?.then?.[0].body).toMatchObject({
      evidenceType: 'quiz',
      assessmentMode: 'practice',
      hintPolicy: 'unlimited',
      independent: true,
      // 第二跳要填第一跳的 id，而它现在还不存在。
      objectiveId: FRESH_ID,
    });
  });

  it('ref 是给模型用的，不发给路由', () => {
    const draft = outcomesDraftOf({
      turn: result({ patches: new Map([['o1', { ref: 'o1', title: '新标题' }]]) }),
      before: board,
      taskId: 't1',
      instruction: 'x',
    });
    expect(draft.lines[0].write?.body).toEqual({ title: '新标题' });
  });

  it('删除与改写同一个目标时，改写那一行被挡住——先删后改不是靠行序保证的', () => {
    const draft = outcomesDraftOf({
      turn: result({
        removed: new Set(['o1']),
        patches: new Map([['o1', { ref: 'o1', title: '新标题' }]]),
      }),
      before: board,
      taskId: 't1',
      instruction: 'x',
    });
    // 行序确实把删除放在前面，但每一行是作者单独按的。
    expect(draft.lines.map((one) => one.id)).toEqual(['outcome:removed-o1', 'outcome:patch-o1']);
    expect(outcomesDraftConflicts(draft)).toEqual([
      { lineId: 'outcome:patch-o1', blockedBy: 'outcome:removed-o1' },
    ]);
  });

  it('删除与补证据冲突时同样挡住补证据', () => {
    const draft = outcomesDraftOf({
      turn: result({
        removed: new Set(['o1']),
        evidence: [
          {
            objectiveId: 'o1',
            binding: {
              ref: 'o1',
              evidenceType: 'lab',
              verificationMethod: '提交 flag',
              successCondition: '读出 flag',
            },
          },
        ],
      }),
      before: board,
      taskId: 't1',
      instruction: 'x',
    });
    expect(outcomesDraftConflicts(draft)).toEqual([
      { lineId: 'outcome:evidence-o1', blockedBy: 'outcome:removed-o1' },
    ]);
  });

  it('指不着的 ref 与被拒的条目是说明行，不可按', () => {
    const draft = outcomesDraftOf({
      turn: result({
        unmatchedRefs: ['不存在的目标'],
        rejectedRefs: ['某条证据缺少成功条件'],
      }),
      before: board,
      taskId: 't1',
      instruction: 'x',
    });
    expect(draft.lines).toHaveLength(2);
    for (const one of draft.lines) {
      expect(stepLineAvailability(one, { statuses: {}, producedIds: {} }).availability).toBe(
        'done',
      );
    }
  });

  it('缺口以人话出现，让模型知道还差什么', () => {
    const draft = outcomesDraftOf({
      turn: result({ gaps: [{ ref: 'o1', text: '目标还没有考核方式' }] }),
      before: board,
      taskId: 't1',
      instruction: 'x',
    });
    expect(draft.warnings).toEqual(['目标还没有考核方式']);
  });
});

/** `replaceFromLive` 那一类行的对照物。 */
function emptyLive(): { nodeObjectives: []; unitCoverage: [] } {
  return { nodeObjectives: [], unitCoverage: [] };
}

/** 作者什么都没改、也还没采纳过任何一行。 */
const NO_EDITS = { edits: {}, producedIds: {} } as const;
