/**
 * 「目的类型」的写法归一：中文（理论 / 实操 / 综合 / 复盘）与英文枚举值都认。
 *
 * 抽成独立模块而不是留在 `outline-import.ts` 里，是因为它现在有两个消费者：
 * 文本大纲导入（人写的 `理论`）和系列大纲 AI 生成（模型可能写 `theory` 或
 * `理论`）。两处各写一份别名表，必然一边加了 `复盘`、另一边不认，而失败方式
 * 是"模型给的类型被静默丢掉"——目建出来了，类型为空，没人报错。
 */
import type { CurriculumTaskKind } from './design-types';

/** 中文是给作者用的，英文是给脚本与模型用的。 */
const KIND_ALIASES: Record<string, CurriculumTaskKind> = {
  理论: 'theory',
  theory: 'theory',
  实操: 'practice',
  practice: 'practice',
  综合: 'review',
  review: 'review',
  复盘: 'review',
};

/** 认不出返回 null：目的类型本来就可空，这里不猜。 */
export function parseOutlineKind(value: unknown): CurriculumTaskKind | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '') return null;
  return KIND_ALIASES[text.toLowerCase()] ?? KIND_ALIASES[text] ?? null;
}
