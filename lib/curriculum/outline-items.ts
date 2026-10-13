import type { CurriculumUnitRecord } from '@/lib/curriculum/design-types';

/**
 * Items in outline order, each with its chapter as a grouping prefix.
 *
 * Chapters are units too (`unitType === 'chapter'`), and the item tree is only
 * one level deep today: an item's `parentId` is its chapter. This is read from
 * the snapshot rather than from `orderIndex` alone because an item that was
 * moved between chapters keeps a stale index relative to its new siblings, and
 * "属于第三章" would then be wrong in a way nobody would notice.
 *
 * Shared by the 目工作台's 出片面板 and the 旧台账's 课程组装面板 so the two
 * cannot disagree about what "the items of this design, in order" means.
 */
export function outlineItems(units: readonly CurriculumUnitRecord[]): {
  chapterTitle: string | null;
  unit: CurriculumUnitRecord;
}[] {
  const chapters = new Map(
    units
      .filter((unit) => unit.unitType === 'chapter')
      .map((chapter) => [chapter.id, chapter.title]),
  );
  return units
    .filter((unit) => unit.unitType === 'item')
    .sort((a, b) => a.orderIndex - b.orderIndex)
    .map((unit) => ({
      chapterTitle: unit.parentId ? (chapters.get(unit.parentId) ?? null) : null,
      unit,
    }));
}
