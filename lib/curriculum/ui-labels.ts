/**
 * 用户语言的标签表。
 *
 * 后端的七阶段、四种审核状态、六个旧 Tab 全是内部命名。界面直接显示它们时，
 * 用户看到的是 `graph`、`assessment`、`curriculum-program` 这种他没有任何办法
 * 理解的词——这不是文案问题，是**把数据模型名当成了任务名**。
 *
 * 这个模块是唯一的翻译层：只做字符串映射，不含逻辑、不 import 服务端。逻辑
 * 留在各自的领域模块里（`production-path.ts`、`design-review.ts`），标签留在
 * 这里，两者分开是为了以后换文案不必碰判断逻辑。
 *
 * 为什么不写 `STEP_LABEL` 这种"给人看的"之外的英文键：键必须与后端阶段字面量
 * 完全一致，否则拼错不会报错、只会静默显示空白。
 */

import type {
  CurriculumAuditFindingStatus,
  CurriculumDesignPhase,
  CurriculumUnitRole,
} from '@/lib/curriculum/design-types';

/** 七个阶段各是什么问题 —— 动词开头，因为它是用户要回答的问题。 */
export const STEP_LABEL: Record<CurriculumDesignPhase, string> = {
  task: '① 这门课是什么',
  outcomes: '② 学完能做到什么',
  graph: '③ 需要哪些前置知识',
  outline: '④ 讲几段，怎么排',
  teaching: '⑤ 每段讲什么',
  assessment: '⑥ 怎么练、怎么考',
  review: '⑦ 检查一遍',
};

/** 步骤条上直接显示的只有前四步；第五、六、七步另走"生成与导出"入口。 */
export const STEP_BAR_PHASES = [
  'task',
  'outcomes',
  'graph',
  'outline',
] as const satisfies readonly CurriculumDesignPhase[];

/** 每个阶段完成后用一句话说清"这一步做完意味着什么"。 */
export const STEP_DONE_LABEL: Record<CurriculumDesignPhase, string> = {
  task: '这门课的定位、面向谁、要解决什么问题已经写下来了。',
  outcomes: '学完这门课要做到的事已经列出来了，而且可被检验。',
  graph: '这门课要用到的知识技能，以及它们之间的先后关系已经定了。',
  outline: '这门课分几段、每段讲什么、按什么顺序讲已经定了。',
  teaching: '每一段的 slide 页面和讲稿都已经写好。',
  assessment: '理论题和实操任务都已经配好，且都能判分。',
  review: '审核结论已经读到，可以带着已知缺陷出片或先修掉。',
};

/** 未开始时显示的阶段名，与 STEP_LABEL 的问句形式保持一致。 */
export const PHASE_STATE_LABEL: Record<CurriculumDesignPhase, string> = {
  task: '还没定这门课是什么',
  outcomes: '还没定学完要做到什么',
  graph: '还没定需要哪些前置知识',
  outline: '还没定讲几段、怎么排',
  teaching: '还没写每段讲什么',
  assessment: '还没配怎么练、怎么考',
  review: '还没检查',
};

/** 条的三个点位：已确认、进行中、没开始。 */
export const PHASE_DOT_STATE = {
  done: '已确认',
  current: '进行中',
  todo: '没开始',
} as const;
export type PhaseDotState = (typeof PHASE_DOT_STATE)[keyof typeof PHASE_DOT_STATE];

/** 三种条目的角色 —— 用户认的是"理论目/实操目/考核目"。 */
export const UNIT_ROLE_LABEL: Record<CurriculumUnitRole, string> = {
  lecture: '理论目',
  practice: '实操目',
  exam: '考核目',
};

/**
 * 审核发现的三种状态。
 *
 * 这里刻意不叫"已接受"——`waived` 才是决定（见 `design-review.ts`：唯一能记录
 * 的决定是 `waived`，`resolved` 会被拒收，因为审核是推导出来的，"我修好了"不是
 * 一个能处于的状态）。若这里图省事写成"已修复/已接受"，界面就会把一个不存在的
 * 状态展示给用户，而用户点下去找不到能改变它的按钮。
 */
export const FINDING_STATUS_LABEL: Record<CurriculumAuditFindingStatus, string> = {
  open: '待处理',
  resolved: '待处理',
  waived: '已接受',
};

export const FINDING_STATUS_HINT: Record<CurriculumAuditFindingStatus, string> = {
  open: '这一处会挡住出片，必须处理或接受它。',
  resolved: '这一处会挡住出片，必须处理或接受它。',
  waived: '你决定带着它出片。导出时会点名，不会拦。',
};

/**
 * 旧台账六个 Tab 的用户语言。
 *
 * 这六个名字是**数据模型名**，不是任务名：用户不会因为看到"课程组装"就想到
 * 自己要做的事。改名不是为了好听，是因为界面上出现"知识体系"时，用户会去找
 * 一个叫"知识体系"的东西，而系统里没有。
 */
export const OLD_PANEL_LABEL = {
  'curriculum-ledger': '我的课程',
  'curriculum-knowledge': '要教什么',
  'curriculum-program': '考核要求',
  'curriculum-assembly': '拼成一门课',
  'curriculum-batch': '批量出片',
  'curriculum-export': '下载视频',
} as const;

export type OldPanelKey = keyof typeof OLD_PANEL_LABEL;
