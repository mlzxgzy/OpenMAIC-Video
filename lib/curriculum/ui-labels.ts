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

/**
 * 七步的序号（1 起）。
 *
 * 与 `CURRICULUM_DESIGN_PHASES` 的下标同义，但显式写出来：界面上到处要显示
 * "第 3 步"，而从数组下标现算，一旦有人往阶段机里插一步，界面上的序号与用户
 * 已经在用的说法（"卡在第 3 步"）会同时变，且没有任何测试会发现。
 */
export const STEP_NUMBER: Record<CurriculumDesignPhase, number> = {
  task: 1,
  outcomes: 2,
  graph: 3,
  outline: 4,
  teaching: 5,
  assessment: 6,
  review: 7,
};

/**
 * 步骤名 —— 疑问句，因为它就是用户要回答的问题。
 *
 * 不带序号：序号由 {@link STEP_NUMBER} 给，步骤条上那个大圆圈里的数字和这里
 * 的名字是两件事（圆圈要大，名字要完整），拼在一起就没法分别排版。
 */
export const STEP_NAME: Record<CurriculumDesignPhase, string> = {
  task: '这门课是什么',
  outcomes: '学完能做到什么',
  graph: '需要哪些前置知识',
  outline: '讲几段，怎么排',
  teaching: '每段讲什么',
  assessment: '怎么练、怎么考',
  review: '检查一遍',
};

/**
 * 带序号的步骤名（`① 这门课是什么`），给不适合放大圆圈的地方用（副驾的说明、
 * 无障碍标签、日志）。
 *
 * 由 {@link STEP_NAME} 拼出来而不是另写一份表：同一个名字写两遍，迟早只改一处，
 * 而"改了名字这里没改"不会报错，只会在某一个界面上显示旧文案。
 */
export const STEP_LABEL: Record<CurriculumDesignPhase, string> = {
  task: `① ${STEP_NAME.task}`,
  outcomes: `② ${STEP_NAME.outcomes}`,
  graph: `③ ${STEP_NAME.graph}`,
  outline: `④ ${STEP_NAME.outline}`,
  teaching: `⑤ ${STEP_NAME.teaching}`,
  assessment: `⑥ ${STEP_NAME.assessment}`,
  review: `⑦ ${STEP_NAME.review}`,
};

/**
 * 每一步**在卡片标题、门禁提示、服务器报错里**的名字。
 *
 * 与 {@link STEP_NAME} 是两个用途，不是同一份文案抄两遍：`STEP_NAME` 是步骤条上的
 * 问句（"这一步要回答什么"），这里是**工作对象的名字**（"这一步在改什么"）。卡片标题
 * 用名词、步骤条用问句，各自都更准确；错的是**不写序号**——用户没有别的办法知道
 * "知识技能与依赖"和"需要哪些前置知识"是同一件事。
 *
 * 这张表是一次真实事故的产物。截图里的卡片：标题写「第 3 步 知识技能与依赖」，正文写
 * 「先完成**依赖图**阶段，当前在**学习成果**阶段」，右栏红字写「当前处于 **outcomes**
 * 阶段；推进到 **graph** 阶段」——同一个第 3 步，四个名字，其中一个还是内部 id。所以：
 * **用户可见的每一次步骤引用都必须经过 {@link stepRef}**，序号和名字一起出现。
 */
export const STEP_WORK_NAME: Record<CurriculumDesignPhase, string> = {
  task: '课程方向',
  outcomes: '学习目标与证据',
  graph: '知识技能与依赖',
  outline: '课程大纲',
  teaching: '授课脚本与分镜',
  assessment: '题目与实操',
  review: '课程审核',
};

/**
 * 引用某一步的唯一写法：`第 3 步「知识技能与依赖」`。
 *
 * 只在这里拼字符串，是为了让"某处又出现了 `graph` 或 `依赖图`"变成一个能测出来的事
 * （见 `tests/curriculum/step-labels.test.ts` 的守卫用例），而不是靠 review 时有人想起来。
 */
export function stepRef(phase: CurriculumDesignPhase): string {
  return `第 ${STEP_NUMBER[phase]} 步「${STEP_WORK_NAME[phase]}」`;
}

/**
 * 被门禁挡住时给用户看的话（按钮的悬浮说明、空态下面那一行小字）。
 *
 * 三件事缺一不可：**用户想做的那件事**（"新建知识点"）、**它属于哪一步**、**现在停在
 * 哪一步**。旧文案写的是"先完成依赖图阶段"——"依赖图"是它自己要做的第 3 步，等于让人
 * "先做完这一件事才能开始做这一件事"；后半句又把当前阶段叫成"学习成果"，用户对不上号。
 */
export function stepLockReason(
  action: string,
  current: CurriculumDesignPhase,
  required: CurriculumDesignPhase,
): string {
  return `先推进到${stepRef(required)}，才能${action}。` + `课程任务现在停在${stepRef(current)}。`;
}

/**
 * 服务器拒绝写入时的那句 409 文案，与 {@link stepLockReason} 同一套词汇。
 *
 * 服务端本来也拼过这句话，拼法是 `` `课程任务当前处于「${task.designPhase}」阶段` ``
 * ——把数据库里的阶段字面量直接倒进中文句子，界面上就出现了 `outcomes`、`graph`。
 * `subject` 可以省略（门禁本身与"做什么"无关时，比如存储层的 `assertPhase`）。
 */
export function stepLockMessage(
  current: CurriculumDesignPhase,
  required: CurriculumDesignPhase,
  subject?: string,
): string {
  const head = subject
    ? `「${subject}」属于${stepRef(required)}。`
    : `${stepRef(required)}还没轮到。`;
  // 不写"先完成第 N 步并确认"：前半句刚说过现在停在哪一步，再重复一次序号只会让这句
  // 话更长（界面上它换行成三行）。"这一步"指的就是它。
  return `${head}课程任务现在停在${stepRef(current)}，先确认这一步再回来。`;
}

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

/**
 * 条目的三种角色。
 *
 * 曾经写的是「理论目 / 实操目 / 考核目」——那是把**目**的类型借给了条目，于是
 * 同一个词在驾驶舱指一节课、在目内部指一段内容。现在条目只说它在那节课里干
 * 什么：讲授、练习、考核；目的类型见 {@link ITEM_KIND_LABEL}。
 */
export const UNIT_ROLE_LABEL: Record<CurriculumUnitRole, string> = {
  lecture: '讲授',
  practice: '练习',
  exam: '考核',
};

/**
 * 目（= 一节课）的三种类型，与系列大纲里「理论 / 实操 / 综合」对应。
 *
 * 命名成 `ITEM_KIND_LABEL` 而不是 `TASK_KIND_LABEL`：界面上用户认的是"目"，
 * 代码里的 `task` 是实现细节，不该出现在标签名里。
 */
export const ITEM_KIND_LABEL = {
  theory: '理论目',
  practice: '实操目',
  review: '综合目',
} as const;
export type ItemKindLabel = keyof typeof ITEM_KIND_LABEL;

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
