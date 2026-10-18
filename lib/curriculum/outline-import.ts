/**
 * 把一份纯文本大纲解析成「章 → 节 → 目」。
 *
 * 为什么是文本而不是 JSON：大纲是人在 Word / 飞书 / Markdown 里写的，用户手里
 * 那一份从来不是 JSON。要求他们先转格式，等于把"先出章再出节"的入口藏进一个
 * 他们不会用的工具里。
 *
 * 格式刻意只有三种行——章、节、目：
 *
 * ```text
 * # CTF 基础与工具环境
 * ## CTF 入门与赛制
 * - 1-1-1 | CTF概述与竞赛形式 | 理论 | 1 | CTF起源、Jeopardy/AWD、flag格式
 * ```
 *
 * 规则只有四条，因为每多一条都会变成用户要背的东西：
 * 1. `#` 是章，`##` 是节，`-` 是目；目必须跟在某一节后面。
 * 2. 目用竖线分隔：`编号 | 标题 | 类型 | 学时 | 内容要点`。编号、类型、学时、
 *    要点都可以省略，但省略时**只能从右往左**省——这样"只写标题"永远合法。
 * 3. 编号不是必需的：章按出现顺序编号（`1`、`2`…），节是 `父编号-序号`，
 *    目是 `节编号-序号`。写了大纲里现成的编号就用写的。
 * 4. 以 `//` 或 `<!--` 开头的行是注释；空行随便加。
 *
 * 解析器不写库、不看 owner，是一棵可以单测的纯函数；导入路由负责把结果落库。
 */
import { CURRICULUM_TASK_KINDS, type CurriculumTaskKind } from '@/lib/curriculum/design-types';
import { parseOutlineKind } from '@/lib/curriculum/outline-kind';

export const OUTLINE_IMPORT_KIND_LABELS: Record<CurriculumTaskKind, string> = {
  theory: '理论目',
  practice: '实操目',
  review: '综合目',
};

export interface OutlineImportItem {
  code: string | null;
  title: string;
  kind: CurriculumTaskKind | null;
  hours: number | null;
  note: string | null;
}

export interface OutlineImportSection {
  code: string | null;
  title: string;
  note: string | null;
  items: OutlineImportItem[];
}

export interface OutlineImportChapter {
  code: string | null;
  title: string;
  note: string | null;
  sections: OutlineImportSection[];
}

export interface OutlineImportIssue {
  /** 1 起的行号，用于把错误指回作者手里那份文本。 */
  line: number;
  message: string;
}

export interface OutlineImportResult {
  chapters: OutlineImportChapter[];
  issues: OutlineImportIssue[];
  stats: { chapters: number; sections: number; items: number };
}

/** 竖线的全角写法也接受：中文输入法下 `|` 与 `｜` 都是常见手滑。 */
const FIELD_SEPARATOR = /\s*[|｜]\s*/;

/**
 * 解析一份大纲文本。
 *
 * 不抛异常：一行坏掉不应该让整份大纲拒绝导入，作者要的是"哪一行错、错在哪"。
 * `issues` 非空时导入按钮会被禁用，但预览仍然把已经解析出来的树显示出来——
 * 让用户对着自己那份文本改，比对着一个空白错误框有用。
 */
export function parseOutlineText(text: string): OutlineImportResult {
  const chapters: OutlineImportChapter[] = [];
  const issues: OutlineImportIssue[] = [];
  const usedCodes = new Map<string, number>();

  let chapter: OutlineImportChapter | null = null;
  let section: OutlineImportSection | null = null;
  let chapterIndex = 0;
  let sectionIndex = 0;

  const registerCode = (code: string | null, line: number): boolean => {
    if (!code) return true;
    const previous = usedCodes.get(code);
    if (previous !== undefined) {
      issues.push({ line, message: `编号「${code}」重复（第 ${previous} 行已经用过）` });
      return false;
    }
    usedCodes.set(code, line);
    return true;
  };

  text.split(/\r?\n/).forEach((rawLine, index) => {
    const lineNumber = index + 1;
    const line = rawLine.trim();
    if (line === '' || line.startsWith('//') || line.startsWith('<!--')) return;
    // Markdown 的分隔行（表格或水平线）在大纲里没有意义，静默跳过。
    if (/^[-*_]{3,}$/.test(line)) return;

    if (line.startsWith('## ')) {
      if (!chapter) {
        issues.push({ line: lineNumber, message: '节前面还没有章：先用 `# 章名` 写一行' });
        return;
      }
      const title = line.slice(3).trim();
      if (!title) {
        issues.push({ line: lineNumber, message: '节标题为空' });
        return;
      }
      sectionIndex += 1;
      const code = chapter.code ? `${chapter.code}-${sectionIndex}` : null;
      section = { code, title, note: null, items: [] };
      if (!registerCode(code, lineNumber)) return;
      chapter.sections.push(section);
      return;
    }

    if (line.startsWith('# ')) {
      const title = line.slice(2).trim();
      if (!title) {
        issues.push({ line: lineNumber, message: '章标题为空' });
        return;
      }
      chapterIndex += 1;
      sectionIndex = 0;
      const code = String(chapterIndex);
      chapter = { code, title, note: null, sections: [] };
      section = null;
      if (!registerCode(code, lineNumber)) return;
      chapters.push(chapter);
      return;
    }

    if (line.startsWith('- ')) {
      if (!chapter || !section) {
        issues.push({ line: lineNumber, message: '目前面还没有节：先用 `## 节名` 写一行' });
        return;
      }
      const fields = line
        .slice(2)
        .split(FIELD_SEPARATOR)
        .map((field) => field.trim());
      // 从右往左认字段：标题永远在；编号、类型、学时、要点按出现顺序补齐。
      // 这样「只写标题」「标题 + 类型」都合法，而不会把标题误认成编号。
      const [first, second, third, fourth, fifth] = fields;
      if (!first) {
        issues.push({ line: lineNumber, message: '目标题为空' });
        return;
      }
      const looksLikeCode = /^[0-9]+(-[0-9]+)*$/.test(first);
      const code = looksLikeCode ? first : null;
      const title = looksLikeCode ? (second ?? '') : first;
      if (!title) {
        issues.push({ line: lineNumber, message: '目标题为空' });
        return;
      }
      const kindField = looksLikeCode ? third : second;
      const hoursField = looksLikeCode ? fourth : third;
      const noteField = looksLikeCode ? fifth : fourth;

      let kind: CurriculumTaskKind | null = null;
      if (kindField) {
        const mapped = parseOutlineKind(kindField);
        if (!mapped) {
          issues.push({
            line: lineNumber,
            message: `类型「${kindField}」认不出：只能是理论、实操、综合之一`,
          });
          return;
        }
        kind = mapped;
      }

      let hours: number | null = null;
      if (hoursField) {
        const parsed = Number(hoursField);
        if (!Number.isFinite(parsed) || parsed < 0) {
          issues.push({ line: lineNumber, message: `学时「${hoursField}」不是非负数字` });
          return;
        }
        hours = parsed;
      }

      const resolvedCode =
        code ?? (section.code ? `${section.code}-${section.items.length + 1}` : null);
      if (!registerCode(resolvedCode, lineNumber)) return;
      section.items.push({
        code: resolvedCode,
        title,
        kind,
        hours,
        note: noteField && noteField !== '' ? noteField : null,
      });
      return;
    }

    issues.push({
      line: lineNumber,
      message: '认不出这一行：章用 `#`、节用 `##`、目用 `-` 开头',
    });
  });

  const stats = {
    chapters: chapters.length,
    sections: chapters.reduce((sum, entry) => sum + entry.sections.length, 0),
    items: chapters.reduce(
      (sum, entry) => sum + entry.sections.reduce((inner, item) => inner + item.items.length, 0),
      0,
    ),
  };
  return { chapters, issues, stats };
}

/** 目能不能被当成一次合法的创建输入：类型必须在已知集合里。 */
export function isKnownOutlineKind(value: string | null): value is CurriculumTaskKind {
  return value !== null && (CURRICULUM_TASK_KINDS as readonly string[]).includes(value);
}
