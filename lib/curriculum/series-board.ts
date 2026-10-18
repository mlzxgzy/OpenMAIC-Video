/**
 * 驾驶舱的目录树：系列大纲（章 → 节）叠加每一目的进度。
 *
 * 这个模块是纯函数，输入是两张已经读到的表——`curriculum_series_outline_node`
 * 的行与 `/design/overview` 的行——输出一块可以直接渲染的看板。把它单独拿出来的
 * 原因与 `next-item.ts` 相同：目录怎么叠、空节怎么表示、未归类怎么排序，都是
 * 有争议的规则，写在组件里就只能靠肉眼保证，写在这里才能钉测试。
 *
 * 三条规则值得说明：
 *
 * 1. **空节要显示出来。** 先出章、再出节、最后出目——一节刚建、一目还没建是
 *    中间状态的常态，不显示它，用户就不知道自己删到了哪一步。
 * 2. **未归类的目进独立一组。** 老数据（导入之前创建的目）没有 `sectionId`，
 *    删节也会让目退回未归类。把它们塞进任何一章都是编造归属。
 * 3. **`outlineRank` 是"顺着大纲"的顺序**：章序 × 10000 + 节序 × 100 + 目序。
 *    推荐与待办共用它，所以"现在做哪一目"和看板上第一块未做的目不会打架。
 */
import type { CurriculumDesignPhase } from './design-types';
import type { CurriculumSeriesOutlineNodeRecord } from './types';

export type BoardKind = 'theory' | 'practice' | 'review' | null;

/** `/design/overview` 的一行里，这块看板需要的字段。 */
export interface BoardRow {
  taskId: string;
  code: string | null;
  title: string;
  phase: CurriculumDesignPhase;
  kind: BoardKind;
  produced: boolean;
  blockingCount: number;
  started: boolean;
  sectionId: string | null;
  orderIndex: number;
}

export interface BoardItem {
  taskId: string;
  code: string | null;
  title: string;
  phase: CurriculumDesignPhase;
  kind: BoardKind;
  produced: boolean;
  blockingCount: number;
  started: boolean;
  outlineRank: number | null;
}

export interface BoardSection {
  id: string;
  code: string | null;
  title: string;
  note: string | null;
  outlineRank: number;
  items: BoardItem[];
  produced: number;
  total: number;
}

export interface BoardChapter {
  id: string;
  code: string | null;
  title: string;
  note: string | null;
  outlineRank: number;
  sections: BoardSection[];
  produced: number;
  total: number;
}

export interface BoardUnassigned {
  items: BoardItem[];
  produced: number;
  total: number;
}

export interface SeriesBoard {
  chapters: BoardChapter[];
  unassigned: BoardUnassigned;
  totals: { chapters: number; sections: number; items: number; produced: number };
}

function toItem(row: BoardRow, outlineRank: number | null): BoardItem {
  return {
    taskId: row.taskId,
    code: row.code,
    title: row.title,
    phase: row.phase,
    kind: row.kind,
    produced: row.produced,
    blockingCount: row.blockingCount,
    started: row.started,
    outlineRank,
  };
}

function compareItems(a: BoardItem, b: BoardItem): number {
  if (a.outlineRank !== null && b.outlineRank !== null && a.outlineRank !== b.outlineRank) {
    return a.outlineRank - b.outlineRank;
  }
  // 未归类的目没有大纲位置，退回编号/标题——它们至少是可读的、稳定的。
  return (a.code ?? a.title).localeCompare(b.code ?? b.title, 'zh-CN');
}

function sectionStats(items: BoardItem[]): { produced: number; total: number } {
  return { produced: items.filter((item) => item.produced).length, total: items.length };
}

/** 章序 × 10000 + 节序 × 100 + 目序。三个序列都从 1 开始，所以不会重叠。 */
function rankOf(chapterOrder: number, sectionOrder: number, itemOrder: number): number {
  return chapterOrder * 10000 + sectionOrder * 100 + itemOrder;
}

export function buildSeriesBoard(
  nodes: readonly CurriculumSeriesOutlineNodeRecord[],
  rows: readonly BoardRow[],
): SeriesBoard {
  const chapters = nodes
    .filter((node) => node.nodeType === 'chapter')
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.title.localeCompare(b.title, 'zh-CN'));
  const sections = nodes
    .filter((node) => node.nodeType === 'section')
    .slice()
    .sort((a, b) => a.orderIndex - b.orderIndex || a.title.localeCompare(b.title, 'zh-CN'));

  const sectionById = new Map(sections.map((section) => [section.id, section]));
  const chapterById = new Map(chapters.map((chapter) => [chapter.id, chapter]));
  const grouped = new Map<string, BoardItem[]>();
  const unassigned: BoardItem[] = [];

  for (const row of rows) {
    const section = row.sectionId ? sectionById.get(row.sectionId) : undefined;
    const chapter = section?.parentId ? chapterById.get(section.parentId) : undefined;
    if (!section || !chapter) {
      unassigned.push(toItem(row, null));
      continue;
    }
    const rank = rankOf(chapter.orderIndex, section.orderIndex, row.orderIndex);
    const list = grouped.get(section.id) ?? [];
    list.push(toItem(row, rank));
    grouped.set(section.id, list);
  }

  const boardChapters: BoardChapter[] = chapters.map((chapter) => {
    const chapterSections: BoardSection[] = sections
      .filter((section) => section.parentId === chapter.id)
      .map((section) => {
        const items = (grouped.get(section.id) ?? []).sort(compareItems);
        return {
          id: section.id,
          code: section.code,
          title: section.title,
          note: section.note,
          outlineRank: rankOf(chapter.orderIndex, section.orderIndex, 0),
          items,
          ...sectionStats(items),
        };
      });
    const chapterItems = chapterSections.flatMap((section) => section.items);
    return {
      id: chapter.id,
      code: chapter.code,
      title: chapter.title,
      note: chapter.note,
      outlineRank: rankOf(chapter.orderIndex, 0, 0),
      sections: chapterSections,
      ...sectionStats(chapterItems),
    };
  });

  const sortedUnassigned = unassigned.sort(compareItems);
  const allItems = boardChapters.flatMap((chapter) => chapter.sections.flatMap((s) => s.items));
  return {
    chapters: boardChapters,
    unassigned: { items: sortedUnassigned, ...sectionStats(sortedUnassigned) },
    totals: {
      chapters: boardChapters.length,
      sections: sections.length,
      items: allItems.length + sortedUnassigned.length,
      produced:
        allItems.filter((item) => item.produced).length +
        sortedUnassigned.filter((item) => item.produced).length,
    },
  };
}
