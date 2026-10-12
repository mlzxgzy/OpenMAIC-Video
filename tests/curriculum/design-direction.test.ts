/**
 * 第一步「课程方向」的规则层，无模型、无数据库。
 *
 * 这一层是 AI 对话能不能安全地直接写库的全部依据：模型返回的东西在这里被削成
 * 七个已知槽位，"确认"在这里被确定性规则裁决，缺口在这里只有一份定义。所以这里
 * 的用例几乎都在测**拒绝**——模型多给的键、看不懂的时长、第一轮就自称确认——因为
 * 这些是静默失败：没有报错，只是库里多了一个没人数过的字段，或者门禁在用户还没
 * 看到卡片时就开了。
 */
import { describe, expect, it } from 'vitest';

import {
  CURRICULUM_DIRECTION_FIELDS,
  CURRICULUM_DIRECTION_KEYS,
  DirectionAnswerError,
  changedDirectionKeys,
  describeDirectionGaps,
  directionFieldLabel,
  directionGapLabels,
  directionGaps,
  directionValuesOf,
  formatDirectionCard,
  isDirectionComplete,
  parseDirectionAnswer,
  sanitizeDirectionFields,
  shouldConfirmDirection,
  type CurriculumDirectionValues,
} from '@/lib/curriculum/design-direction';

const FULL: CurriculumDirectionValues = {
  title: 'CTF 综合实战',
  audience: '大二信息安全专业学生',
  learnerLevel: '会 Linux 基本命令、懂 HTTP 请求',
  trainingScenario: '线下集中实训 + 线上自学',
  durationHours: 48,
  applicationScene: '校内选拔赛 / 校队集训',
  problemStatement: '6 方向 × 3 案例；只做 slide 理论与 Docker 实操',
};

const EMPTY: CurriculumDirectionValues = {
  title: null,
  audience: null,
  learnerLevel: null,
  trainingScenario: null,
  durationHours: null,
  applicationScene: null,
  problemStatement: null,
};

describe('the seven slots', () => {
  it('defines exactly the keys the store has columns for, each once', () => {
    expect(CURRICULUM_DIRECTION_FIELDS).toHaveLength(7);
    expect(CURRICULUM_DIRECTION_FIELDS.map((field) => field.key)).toEqual([
      ...CURRICULUM_DIRECTION_KEYS,
    ]);
    expect(new Set(CURRICULUM_DIRECTION_KEYS).size).toBe(7);
    expect(directionFieldLabel('problemStatement')).toBe('课程范围');
  });

  it('marks the four required slots, and the gaps are exactly those four', () => {
    const required = CURRICULUM_DIRECTION_FIELDS.filter((field) => field.required).map(
      (field) => field.key,
    );
    // The gate's own list: title, audience, scope, hours — no more, no fewer.
    expect(required).toEqual(['title', 'audience', 'problemStatement', 'durationHours']);

    const gaps = directionGaps(EMPTY);
    expect(gaps).toHaveLength(required.length);
    for (const label of directionGapLabels(EMPTY)) expect(gaps).toContain(`缺${label}`);
  });

  it('reads the seven values off a task row and reports a complete card as complete', () => {
    expect(directionValuesOf({ ...FULL })).toEqual(FULL);
    expect(isDirectionComplete(FULL)).toBe(true);
    expect(describeDirectionGaps(FULL)).toBeNull();
    expect(isDirectionComplete(EMPTY)).toBe(false);
    expect(describeDirectionGaps(EMPTY)).toContain('缺授课对象');
  });

  it('treats a blank string as an empty slot, not as an answer', () => {
    // A card with " " in a required slot is not filled in; the gate has to agree
    // with the label that says 未填.
    expect(directionGaps({ ...FULL, audience: '   ' })).toEqual(['缺授课对象']);
  });
});

describe('sanitizing what the model returns', () => {
  it('keeps the known slots and reports the invented ones instead of storing them', () => {
    const { fields, rejectedKeys } = sanitizeDirectionFields({
      audience: '大二学生',
      courseName: 'CTF',
      notes: '待定',
    });
    expect(fields).toEqual({ audience: '大二学生' });
    expect(rejectedKeys.sort()).toEqual(['courseName', 'notes']);
  });

  it('reads hours out of the ways a model actually writes them', () => {
    const cases: [unknown, number][] = [
      [48, 48],
      ['48', 48],
      ['48 学时', 48],
      ['约 48 小时', 48],
      [' 54 ', 54],
      ['3.5 天', 3.5],
    ];
    for (const [value, expected] of cases) {
      expect(sanitizeDirectionFields({ durationHours: value }).fields.durationHours).toBe(expected);
    }
  });

  it('drops hours it cannot parse, and clears them only on an explicit null', () => {
    for (const value of ['待定', '', [], -3, { hours: 48 }]) {
      expect(
        sanitizeDirectionFields({ durationHours: value }).fields.durationHours,
      ).toBeUndefined();
    }
    expect(sanitizeDirectionFields({ durationHours: null }).fields.durationHours).toBeNull();
  });

  it('turns an explicit blank into a cleared slot and passes null through', () => {
    const { fields } = sanitizeDirectionFields({ audience: '', learnerLevel: null });
    expect(fields).toEqual({ audience: null, learnerLevel: null });
  });

  it('refuses a non-string where a sentence belongs rather than stringifying it', () => {
    const { fields, rejectedKeys } = sanitizeDirectionFields({ audience: 42, title: ['CTF'] });
    expect(fields).toEqual({});
    expect(rejectedKeys.sort()).toEqual(['audience', 'title']);
  });

  it('returns nothing for a fields value that is not an object', () => {
    expect(sanitizeDirectionFields('audience')).toEqual({ fields: {}, rejectedKeys: [] });
    expect(sanitizeDirectionFields(null)).toEqual({ fields: {}, rejectedKeys: [] });
  });
});

describe('parsing the model answer', () => {
  it('reads a bare JSON object', () => {
    const answer = parseDirectionAnswer(
      JSON.stringify({ message: '改好了。', fields: { durationHours: 48 }, confirm: false }),
    );
    expect(answer.message).toBe('改好了。');
    expect(answer.fields).toEqual({ durationHours: 48 });
    expect(answer.confirmRequested).toBe(false);
  });

  it('tolerates a code fence and prose around the object', () => {
    const answer = parseDirectionAnswer(
      '好的，这是结果：\n```json\n{"message":"ok","fields":{"title":"CTF"},"confirm":true}\n```\n以上。',
    );
    expect(answer.fields.title).toBe('CTF');
    expect(answer.confirmRequested).toBe(true);
  });

  it('refuses an answer with no JSON object at all', () => {
    expect(() => parseDirectionAnswer('当然可以，我这就改。')).toThrow(DirectionAnswerError);
    expect(() => parseDirectionAnswer('{"message":')).toThrow(DirectionAnswerError);
  });

  it('treats a missing fields object as no change rather than an error', () => {
    const answer = parseDirectionAnswer('{"message":"你还没说要改哪一格"}');
    expect(answer.fields).toEqual({});
    expect(answer.confirmRequested).toBe(false);
  });

  it('ignores a confirm flag that is not exactly true', () => {
    expect(
      parseDirectionAnswer('{"message":"x","fields":{},"confirm":"yes"}').confirmRequested,
    ).toBe(false);
  });
});

describe('the confirmation guard', () => {
  it('never confirms on the user’s first message, however complete the card is', () => {
    // There is no card the user has seen yet, so there is nothing to agree to.
    expect(shouldConfirmDirection({ confirmRequested: true, values: FULL, userTurns: 1 })).toBe(
      false,
    );
  });

  it('never confirms an incomplete card', () => {
    expect(
      shouldConfirmDirection({
        confirmRequested: true,
        values: { ...FULL, problemStatement: null },
        userTurns: 3,
      }),
    ).toBe(false);
  });

  it('confirms a complete card from the second user message on', () => {
    expect(shouldConfirmDirection({ confirmRequested: true, values: FULL, userTurns: 2 })).toBe(
      true,
    );
    expect(shouldConfirmDirection({ confirmRequested: true, values: FULL, userTurns: 5 })).toBe(
      true,
    );
  });

  it('does not confirm when the model did not claim the user agreed', () => {
    expect(shouldConfirmDirection({ confirmRequested: false, values: FULL, userTurns: 5 })).toBe(
      false,
    );
  });
});

describe('spotting a real edit', () => {
  it('reports only the slots whose value changed', () => {
    expect(changedDirectionKeys(FULL, { ...FULL, durationHours: 54 })).toEqual(['durationHours']);
    expect(changedDirectionKeys(FULL, { ...FULL })).toEqual([]);
    expect(changedDirectionKeys(EMPTY, { ...FULL }).sort()).toEqual(
      [...CURRICULUM_DIRECTION_KEYS].sort(),
    );
  });
});

describe('rendering the card', () => {
  it('marks the required slots, shows empty ones, and states the sign-off', () => {
    const card = formatDirectionCard({ ...FULL, durationHours: null }, null);
    expect(card).toContain('* 培训时长：（未填）');
    expect(card).toContain('状态：未确认');
    expect(formatDirectionCard(FULL, 'user')).toContain('状态：已确认（用户点击确认）');
    expect(formatDirectionCard(FULL, 'assistant')).toContain('状态：已确认（对话中确认）');
  });
});
