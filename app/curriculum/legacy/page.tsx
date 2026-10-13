import { CurriculumWorkspace } from '@/components/curriculum/curriculum-workspace';

export const dynamic = 'force-dynamic';

/**
 * 旧台账的存档页。
 *
 * 这里放的是原来挂在 `/curriculum` 上的六个平级 Tab（课程台账 / 知识体系 /
 * 培养方案 / 课程组装 / 批量生成 / 视频导出）。它们没有被删，因为里面有**没有
 * 等价替代**的操作——跨系列的课程台账、知识点与先修关系、培养方案矩阵、批量
 * 生成队列。但它们也不再是主路径：`/curriculum` 现在直接跳到课程序列，用户
 * 从系列驾驶舱进"这一目"，在那里完成设计、生成与导出。
 *
 * 之所以是独立路由而不是 `/curriculum` 本身：`/curriculum` 被首页、侧栏和
 * `series-workspace` 引用过，把它留成一个重定向，旧书签与旧链接会落到新的
 * 主路径上，而不是落进一个"看起来像首页但其实全是废弃功能"的页面。
 */
export default function CurriculumLegacyPage() {
  return <CurriculumWorkspace />;
}
