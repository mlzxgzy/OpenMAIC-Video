import { redirect } from 'next/navigation';

export const dynamic = 'force-dynamic';

/**
 * `/curriculum` 不再是页面，是一个跳转。
 *
 * 它原来是"全部课程总览 + 六个平级 Tab"的台账，也是首页和侧栏的"进入课程"
 * 入口。用户在这个页面上看到的是六块并列的内容，没有一个地方说明"现在该做哪
 * 一步"——诊断见 `docs/curriculum-redesign/SERIES-UI-REDESIGN.md` §1.1。
 *
 * 现在主路径是 `/curriculum/series`（序列列表）→ 系列驾驶舱 → 这一目的工作台。
 * 旧台账整体挪到 `/curriculum/legacy`，不在这里出现。
 *
 * 保留这个路径而不直接删掉，是因为它在**浏览器书签、外部链接和旧文档**里都已经
 * 存在；删掉会得到一个 404，而重定向会让这些入口落到新的主路径上。
 */
export default function CurriculumPage() {
  redirect('/curriculum/series');
}
