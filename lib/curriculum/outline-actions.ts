/**
 * 系列大纲（章 / 节 / 目）的**改名与删除**规则 —— 纯函数。
 *
 * 这三层东西原来只能新建：接口有 PATCH / DELETE（`series/[id]/outline/[nodeId]`、
 * `design/tasks/[id]`），但驾驶舱的看板只画了「新建节 / 新建目」。用户写错一个字、
 * 少建一目、多建一节，只能去数据库里改——所以这一层把界面上要说的两件事收进
 * 一个可测的模块：
 *
 * 1. **删除前必须说清后果。** 三层删除的牵连面完全不同：删章会级联删节、删节目
 *    退回「未归类」而不是被删（`ON DELETE SET NULL`）、删目会连设计一起删但已生成
 *    的课堂与视频不在目下面。这三句话如果写在组件里，就只能靠肉眼保证它和库的
 *    真实行为一致；写成纯函数才能钉住。
 * 2. **编辑只发改过的字段。** 保存章 / 节时，接口把「标题或说明被写过」当成一次
 *    人改过的表态（清掉「旧版设计」指纹）。原样提交一遍等于替用户宣布"这一行我
 *    核过了"，会把一个真正过期的章节悄悄洗白。所以补丁按差异构造，没有差异就不发
 *    请求。
 *
 * 编号（`code`）不在编辑范围内：它是目编号（`1-1-1`）的前缀，章 / 节的 PATCH 接口
 * 也不接受它。要换编号就删掉重建——界面上写清楚，而不是让用户改半天发现没生效。
 */
import type { CurriculumTaskKind } from './design-types';

// ── 删除 ────────────────────────────────────────────────────────────────────

export type OutlineDeleteLevel = 'chapter' | 'section' | 'item';

/** 删除确认要用的现状。数都来自看板，不再单独请求一次。 */
export interface OutlineDeleteTarget {
  level: OutlineDeleteLevel;
  code: string | null;
  title: string;
  /** 章：这一章下面有几节。节 / 目：0。 */
  sectionCount: number;
  /** 章：这一章下面有几目（含所有节）。节：这一节下面有几目。目：0。 */
  itemCount: number;
  /** 目：这一目已经出过片的条目数（条目上有 `stage_id`）。章 / 节：0。 */
  producedCount: number;
}

export interface OutlineDeleteSpec {
  level: OutlineDeleteLevel;
  /** 问句形式的标题，带着编号和名字——确认框里不能只有一个「确定吗」。 */
  title: string;
  /** 删掉的是什么。 */
  consequence: string;
  /** 不会被删、但会被牵连的东西；没有就 null，界面不画这一行。 */
  keep: string | null;
  confirmLabel: string;
}

function outlineLevelName(level: OutlineDeleteLevel): string {
  if (level === 'chapter') return '章';
  if (level === 'section') return '节';
  return '目';
}

/**
 * 删除确认框的三句话。
 *
 * 章和节都不删目：库里 `curriculum_task.section_id` 是 `ON DELETE SET NULL`，删掉
 * 分类只会让目退回「未归类」。这是"分类可以改、教学单元不能因为改分类而消失"的
 * 实现，界面上必须说出来——否则用户会以为删章等于删了整章的内容，不敢动。
 */
export function describeOutlineDelete(target: OutlineDeleteTarget): OutlineDeleteSpec {
  const { level, code, title } = target;
  const label = outlineLevelName(level);

  if (level === 'item') {
    return {
      level,
      title: code ? `删除目「${code} ${title}」？` : `删除目「${title}」？`,
      consequence:
        '这一目的设计会一起删除，不能恢复：学习目标、知识点、本目大纲、题目与实操都在它下面。',
      keep:
        target.producedCount > 0
          ? '已经生成的课程和导出视频不挂在目下面，不会被删；但系列里不再有这一目的位置。'
          : null,
      confirmLabel: '删除目',
    };
  }

  const head = code ? `删除第 ${code} ${label}「${title}」？` : `删除${label}「${title}」？`;

  if (level === 'chapter') {
    return {
      level,
      title: head,
      consequence:
        target.sectionCount > 0
          ? `这一章和它下面的 ${target.sectionCount} 节会一起删除。`
          : '这一章会被删除。',
      keep:
        target.itemCount > 0
          ? `这 ${target.itemCount} 个目不会被删除，会退回「未归类」——可以再挂到别的节下面。`
          : null,
      confirmLabel: '删除章',
    };
  }

  return {
    level,
    title: head,
    consequence: '这一节会被删除。',
    keep:
      target.itemCount > 0
        ? `这一节下面的 ${target.itemCount} 个目不会被删除，会退回「未归类」。`
        : null,
    confirmLabel: '删除节',
  };
}

// ── 章 / 节的编辑 ───────────────────────────────────────────────────────────

export interface OutlineNodeEditValues {
  title: string;
  note: string | null;
}

/**
 * 章 / 节的差异补丁。返回 `null` 表示"没改"，调用方应该直接关框而不是发 PATCH。
 *
 * 说明改成空串等于清空（`null`），与接口的 `nullableText` 对齐；标题只 trim，
 * 不把内部空格吞掉。
 *
 * **前提：调用方已经保证标题非空。** 这里不返回错误，因为"空标题该报什么"是界面
 * 的事（对话框在标题为空时禁用保存）；补丁函数替它决定只会得到两种更差的结果：
 * 返回 `null` = 用户点了保存却静默关框；返回 `{ title: '' }` = 服务端的 `Reader`
 * 丢掉空串后回一句「至少需要一个字段」，用户看不出是自己清空了标题。
 */
export function nodeEditPatch(
  before: OutlineNodeEditValues,
  after: OutlineNodeEditValues,
): { title?: string; note?: string | null } | null {
  const patch: { title?: string; note?: string | null } = {};
  const nextTitle = after.title.trim();
  if (nextTitle !== before.title) patch.title = nextTitle;
  const nextNote = after.note === null ? null : after.note.trim() === '' ? null : after.note.trim();
  if (nextNote !== before.note) patch.note = nextNote;
  return Object.keys(patch).length === 0 ? null : patch;
}

// ── 目的编辑 ────────────────────────────────────────────────────────────────

export interface TaskEditValues {
  title: string;
  code: string | null;
  kind: CurriculumTaskKind | null;
  durationHours: number | null;
}

/** 表单里的原样字符串。`kind` 用空串表示"没标"。 */
export interface TaskEditDraft {
  title: string;
  code: string;
  kind: string;
  hours: string;
}

const TASK_KINDS: readonly CurriculumTaskKind[] = ['theory', 'practice', 'review'];

export type TaskEditParse = { ok: true; value: TaskEditValues } | { ok: false; message: string };

/**
 * 把表单读成可提交的值。
 *
 * 三条必须给具体说法：标题为空（接口会 400，但用户该在框里看到）、学时不是数字
 * （`Number('')` 是 0，不拦就会把"没填"存成"0 学时"）、类型乱写。编号留空即清空
 * ——这一目退回"没有编号"，而不是编一个出来；编号的唯一性是库里的索引，冲突由
 * 接口回「该值已被占用」。
 */
export function parseTaskEditDraft(draft: TaskEditDraft): TaskEditParse {
  const title = draft.title.trim();
  if (title === '') return { ok: false, message: '标题不能为空' };

  const codeText = draft.code.trim();
  const code = codeText === '' ? null : codeText;

  const kindText = draft.kind.trim();
  if (kindText !== '' && !TASK_KINDS.includes(kindText as CurriculumTaskKind)) {
    return { ok: false, message: '类型只能是理论、实操或综合' };
  }
  const kind = kindText === '' ? null : (kindText as CurriculumTaskKind);

  const hoursText = draft.hours.trim();
  let durationHours: number | null = null;
  if (hoursText !== '') {
    const hours = Number(hoursText);
    if (!Number.isFinite(hours) || hours < 0) {
      return { ok: false, message: '学时只能是不小于 0 的数字' };
    }
    durationHours = hours;
  }

  return { ok: true, value: { title, code, kind, durationHours } };
}

/**
 * 目的差异补丁。返回 `null` 表示没改。
 *
 * 两个入参都应该是 {@link parseTaskEditDraft} 的输出（标题与编号已经 trim 过），
 * 所以这里按字面比较就够——不要拿原始表单字符串直接喂进来，否则"标题后面多了个
 * 空格"会被当成一次真实改动。
 *
 * `kind` 只发**变过**的值，而且不能发 `null`：接口的 `oneOf` 不接受 null，类型本来
 * 也不能"改回没标"。所以从"未标注"选一个类型可以，反向不行——界面把"未标注"画成
 * 不可选项，而不是让用户点了一下、请求回来 400。
 */
export function taskEditPatch(
  before: TaskEditValues,
  after: TaskEditValues,
): {
  title?: string;
  code?: string | null;
  kind?: CurriculumTaskKind;
  durationHours?: number | null;
} | null {
  const patch: {
    title?: string;
    code?: string | null;
    kind?: CurriculumTaskKind;
    durationHours?: number | null;
  } = {};
  if (after.title !== before.title) patch.title = after.title;
  if (after.code !== before.code) patch.code = after.code;
  if (after.kind !== before.kind && after.kind !== null) patch.kind = after.kind;
  if (after.durationHours !== before.durationHours) patch.durationHours = after.durationHours;
  return Object.keys(patch).length === 0 ? null : patch;
}
