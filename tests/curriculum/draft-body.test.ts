/**
 * 「草稿的 body 里不能有这条路由读不了的 `null`」这条不变量的三层证据。
 *
 * 为什么这条值得一个自己的文件：它的失败模式**静默**——采纳时 400，而那句话里没有一个字与
 * 这条建议有关（"bloomLevel 只能是以下之一：…"）。作者看到的是"采纳失败"，于是会去怀疑草稿
 * 本身。B2 试点在 `POST /nodes` 上踩过一次（新建知识点时难度发 `null`），修的时候只修了
 * 新建那条路，**改写那条路留着同样的问题**；这一批又在 `POST /questions` 上踩到同一处
 * （`QuestionWrite.bloomLevel` 在模型没标 Bloom 层级时就是 `null`，而那是多数情况）。
 *
 * 所以这里钉三件事，每一件对应一种"会重新长回来"的方式：
 *
 * 1. **名单的来源。** `draft-body.ts` 那份名单是从 `design-validation.ts` 的源码里读出来的
 *    全部 `r.oneOf(...)` 键。将来新增一个枚举字段、忘了加进名单，这条会红。
 * 2. **前提本身是真的。** 直接调 `parseQuestionInput` 证明"显式 `null` 被拒、缺键通过"——
 *    不然那份名单就是一条没有依据的迷信，而哪天 `oneOf` 改了语义，它还会继续绿。
 * 3. **引擎是兜底的那一层。** 四种 body 形状（新建、独立写入、后续跳、整表替换）全部要过
 *    掉枚举 `null`，而且**别的 `null` 一个都不许动**——`explanation: null` 是"清空解析"，
 *    去掉它才是真 bug。
 */
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  dropNullEnums,
  ENUM_KEYS_REJECTING_NULL,
  nullEnumDroppedWarning,
  uniqueMessages,
} from '@/lib/curriculum/draft-body';
import { resolveStepLineWrite, type StepDraftLine } from '@/lib/curriculum/step-draft';
import { parseQuestionInput } from '@/lib/server/curriculum/design-validation';

function readValidationSource(): string {
  return readFileSync(
    new URL('../../lib/server/curriculum/design-validation.ts', import.meta.url),
    'utf8',
  );
}

const EMPTY_LIVE = { nodeObjectives: [], unitCoverage: [] } as const;
const NO_EDITS = { edits: {}, producedIds: {} } as const;

const line = (over: Partial<StepDraftLine> = {}): StepDraftLine => ({
  id: 'l',
  text: '一行',
  ...over,
});

describe('名单：HTTP 读不了显式 null 的那些键', () => {
  it('覆盖 design-validation.ts 里每一个 oneOf 读的键', () => {
    const source = readValidationSource();
    const keys = new Set(
      [...source.matchAll(/r\.oneOf\(\s*'([A-Za-z]+)'/g)].map((match) => match[1] as string),
    );
    // 前提：这条测试真的扫到了东西。扫不到时它会因为"全都覆盖"而变绿，那是最坏的一种绿。
    expect(keys.size).toBeGreaterThan(10);
    const missing = [...keys].filter((key) => !ENUM_KEYS_REJECTING_NULL.includes(key));
    expect(missing, `这些 oneOf 键不在名单里：${missing.join(', ')}`).toEqual([]);
  });

  it('前提是真的：做题目的 body 里显式 bloomLevel=null 被拒，缺这个键通过', () => {
    const base = {
      unitId: 'u1',
      objectiveId: 'o1',
      questionType: 'single',
      stem: 'SQL 注入的成因是什么？',
      options: [
        { key: 'A', text: '输入未与语句分离' },
        { key: 'B', text: '网络延迟' },
      ],
      answer: ['A'],
    };
    expect(parseQuestionInput(base).ok).toBe(true);
    expect(parseQuestionInput({ ...base, bloomLevel: null }).ok).toBe(false);
    // 而"给了合法值"仍然照常通过——名单挡的是 null，不是这个字段本身。
    expect(parseQuestionInput({ ...base, bloomLevel: 'remember' }).ok).toBe(true);
  });
});

describe('dropNullEnums：只动枚举，绝不动有意义的空', () => {
  it('丢掉枚举 null，保留 nullableText / nullableNumber 的 null', () => {
    const { body, dropped } = dropNullEnums(
      {
        stem: '题干',
        bloomLevel: null,
        difficulty: null,
        explanation: null,
        evidenceId: null,
        timeLimitSec: null,
        options: [],
        score: 0,
      },
      { bloomLevel: 'Bloom 层级', difficulty: '难度' },
    );
    expect(body).toEqual({
      stem: '题干',
      explanation: null,
      evidenceId: null,
      timeLimitSec: null,
      options: [],
      score: 0,
    });
    expect(dropped.map((one) => one.label)).toEqual(['Bloom 层级', '难度']);
  });

  it('值为 undefined 的键不会变成 null，别的假值也不动', () => {
    const { body, dropped } = dropNullEnums({ a: false, b: 0, c: '', d: undefined });
    expect(body).toEqual({ a: false, b: 0, c: '', d: undefined });
    expect(dropped).toEqual([]);
  });
});

describe('引擎：四种 body 形状都过一遍，而且只过枚举', () => {
  it('新建：主 body 与后续跳的 body 都干净', () => {
    const { write } = resolveStepLineWrite(
      line({
        create: {
          route: '/api/curriculum/design/tasks/t/questions',
          body: { stem: 'S', bloomLevel: null, explanation: null },
          idKey: 'question',
          then: [
            {
              method: 'POST',
              route: '/api/curriculum/design/tasks/t/evidence',
              body: { objectiveId: '#id', bloomLevel: null, successCondition: 'C' },
            },
          ],
        },
      }),
      NO_EDITS,
      EMPTY_LIVE,
    );
    expect(write.body).toEqual({ stem: 'S', explanation: null });
    expect(write.then?.[0].body).toEqual({
      objectiveId: '#id',
      successCondition: 'C',
    });
  });

  it('独立写入：body 里只去掉枚举 null', () => {
    const { write } = resolveStepLineWrite(
      line({
        write: {
          method: 'PATCH',
          route: '/api/curriculum/design/tasks/t/units/u1',
          body: { title: 'T', unitRole: null, hours: null },
        },
      }),
      NO_EDITS,
      EMPTY_LIVE,
    );
    expect(write.body).toEqual({ title: 'T', hours: null });
  });

  it('整表替换：并进去的行里的枚举 null 也过掉', () => {
    const { write } = resolveStepLineWrite(
      line({
        mergeInto: {
          method: 'PUT',
          route: '/api/curriculum/design/tasks/t/node-objectives',
          rows: [{ nodeId: 'n2', objectiveId: 'o1', supportLevel: null }],
          source: 'nodeObjectives',
          key: ['nodeId', 'objectiveId'],
          bodyKey: 'links',
        },
      }),
      NO_EDITS,
      EMPTY_LIVE,
    );
    expect(write.body).toEqual({ links: [{ nodeId: 'n2', objectiveId: 'o1' }] });
  });

  it('新建 + 整表替换：后续跳（thenAfter）的 body 也干净', () => {
    const { write } = resolveStepLineWrite(
      line({
        create: {
          route: '/api/curriculum/design/tasks/t/nodes',
          body: { name: 'N', nodeType: null },
          idKey: 'node',
          mergeInto: {
            method: 'PUT',
            route: '/api/curriculum/design/tasks/t/node-objectives',
            rows: [{ nodeId: '#id', objectiveId: 'o1', supportLevel: null }],
            source: 'nodeObjectives',
            key: ['nodeId', 'objectiveId'],
            bodyKey: 'links',
          },
        },
      }),
      NO_EDITS,
      EMPTY_LIVE,
    );
    expect(write.body).toEqual({ name: 'N' });
    expect(write.thenAfter?.[0].body).toEqual({
      links: [{ nodeId: '#id', objectiveId: 'o1' }],
    });
  });
});

describe('被丢掉的"清空"必须说出来', () => {
  it('一个人话句子，且同一个键不重复出现', () => {
    const warnings = nullEnumDroppedWarning([
      { key: 'difficulty', label: '难度' },
      { key: 'bloomLevel', label: 'Bloom 层级' },
    ]);
    expect(warnings).toEqual([
      '想清空「难度」，但改写接口不接受空值，这一项保持原样。',
      '想清空「Bloom 层级」，但改写接口不接受空值，这一项保持原样。',
    ]);
    // 两条改写都要求清空同一个键时，面板里那两句一模一样——而面板按文本做 React key。
    expect(uniqueMessages([...warnings, ...warnings])).toEqual(warnings);
  });
});
