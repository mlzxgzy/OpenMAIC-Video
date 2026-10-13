/**
 * 草稿的 body 里**不能出现的 `null`**：HTTP 校验层用 `oneOf` 读的那些键。
 *
 * 为什么需要这一层：草稿的行最终是**过 HTTP** 落库的，而各步的 turn 路由是直接调 store 的。
 * 两条路的宽容度不同——store 的 `optionalText(null)` 与"没给"写的是同一个值，而
 * `Reader.oneOf` 看见显式 `null` 时 `has(key)` 为真、取值又不是字符串，于是报
 * 「只能是以下之一：…」。同一句模型的话，走 turn 路由能落库，走草稿采纳就 400，而那句错误
 * 信息里没有一个字和这条建议有关——作者只看见"采纳失败"。
 *
 * B2 试点踩过一次：`POST /nodes` 用 `oneOf` 读难度，发 `null` 会 400，于是每一条"模型没写
 * 难度"的草稿都会以一个与建议毫无关系的理由被拒。当时只在**新建**那条路上加了判断，而
 * **改写**那条路留着同样的问题（`PATCH /nodes/<id>` 用同一个 `oneOf` 读难度），
 * `PATCH /questions/<id>` 也一样。所以这一条现在是一个共用函数，而不是每处各写一遍的判断；
 * 而且有一条测试从 `design-validation.ts` 的源码里读出全部 `oneOf` 键，漏一个就红。
 *
 * 三种情形，判据只有一条「这条 HTTP 路由读不了显式 `null`」：
 *
 * 1. **新建时把 `null` 去掉，与发 `null` 完全等价**：store 对两者写同一个值。
 * 2. **改写时把 `null` 去掉，语义会变**：不发是"这一项不动"，而发 `null` 本来是"清空"。
 *    但"清空"这条路由本来就不接受——手工编辑也做不到——所以这不是草稿造成的偏差，是接口
 *    本来没有这个能力。丢掉之后**必须让人知道**（{@link nullEnumDroppedWarning}），否则
 *    作者会以为这一项改过了。
 * 3. **绝不碰别的 `null`**：`evidenceId: null`、`explanation: null`、`timeLimitSec: null`
 *    是**有意义的清空**，由 `nullableText` / `nullableNumber` 读。去掉它们才是真 bug——这
 *    正是为什么这里是一个名单，而不是"去掉所有 null"。
 */

/**
 * 这些键在 `lib/server/curriculum/design-validation.ts` 里由 `r.oneOf(...)` 读。
 *
 * 名单比实际用到的键宽：这是"HTTP 读不了显式 null"这件事的完整清单，而不是"这个月哪几个
 * 转换函数会发出 null"。宁可多列一个用不上的，也不要在新增一个步骤时漏掉一个——漏掉的表现
 * 是那条建议静默地采纳不了。
 */
export const ENUM_KEYS_REJECTING_NULL: readonly string[] = [
  'assessmentMode',
  'bloomLevel',
  'coverageKind',
  'depth',
  'difficulty',
  'edgeType',
  'evidenceType',
  'hintPolicy',
  'kind',
  'level',
  'mode',
  'nodeType',
  'objectiveType',
  'questionType',
  'resetPolicy',
  'role',
  'scoringMode',
  'sourceKind',
  'status',
  'supportLevel',
  'targetKind',
  'unitRole',
  'unitType',
];

/** 被丢掉的键，以及它在界面上的说法。 */
export interface DroppedNullEnum {
  key: string;
  /** 人话的名字，例如「难度」；查找不到时就是键名本身。 */
  label: string;
}

export interface DroppedNullEnums {
  body: Record<string, unknown>;
  dropped: DroppedNullEnum[];
}

/**
 * 去掉 body 里值为 `null` 的枚举键，返回新 body 与被丢掉的键。
 *
 * **递归到任意深度**，因为枚举键不只在顶层：`PUT /node-objectives` 的 body 是一行
 * `{ links: [...] }`，而 `supportLevel` 在数组元素里，由 `entry.oneOf('supportLevel', …)`
 * 读——顶层过一遍而元素不过，等于这道门只关了一半。`PUT /unit-coverage` 的 `coverageKind`
 * 与分镜的 `pages[].mode` 同理。
 *
 * **只有值为 `null` 的才动**：`undefined` 本来就不会被 `JSON.stringify` 发出去，而别的值
 * （包括空数组、`false`、`0`）都是真实取值。`explanation: null`、`evidenceId: null` 这类
 * "有意义的清空"不在名单里，因此原样保留。
 */
export function dropNullEnums(
  body: Record<string, unknown>,
  labels: Record<string, string> = {},
): DroppedNullEnums {
  const dropped: DroppedNullEnum[] = [];

  const walk = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value !== 'object' || value === null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (entry === null && ENUM_KEYS_REJECTING_NULL.includes(key)) {
        dropped.push({ key, label: labels[key] ?? key });
        continue;
      }
      out[key] = walk(entry);
    }
    return out;
  };

  return { body: walk(body) as Record<string, unknown>, dropped };
}

/**
 * 被丢掉的"清空"要变成一句话，进草稿的 `warnings`。
 *
 * 为什么改写路径非要这句话：那一行仍然会成功（其余字段照写），所以界面上是"已采纳"，
 * 而作者要求清空的那一项没有变。不说的后果是一个**看不出来的**半执行——正是这套交互里最
 * 不该有的东西。
 */
export function nullEnumDroppedWarning(dropped: readonly DroppedNullEnum[]): string[] {
  return dropped.map((one) => `想清空「${one.label}」，但改写接口不接受空值，这一项保持原样。`);
}

/**
 * 去掉重复的提醒。
 *
 * 两条改写都要求清空「难度」时，上面那句会被拼出两遍，而**面板是按文本做 React key 的**：
 * 两条一模一样的提醒会让 React 报重复 key，而那句话本身也不因为重复两遍而更有用。
 */
export function uniqueMessages(messages: readonly string[]): string[] {
  return [...new Set(messages)];
}
