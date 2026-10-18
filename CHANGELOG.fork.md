# Changelog（二开）

本文件只记录 **本仓库相对上游的差异**。上游 OpenMAIC 的变更请看 [`CHANGELOG.md`](./CHANGELOG.md)。

- **上游项目**：[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)
- **本仓库**：`git@github.com:mlzxgzy/OpenMAIC-Video.git`（fork，`upstream` = `git@github.com:THU-MAIC/OpenMAIC.git`）
- **二开方向**：视频化（视频导出 / 渲染服务 / 视频生成）
- **格式**：沿用上游的 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 约定，但**不写 PR 链接**（二开改动没有上游 PR）

---

## 为什么要单独一个文件

上游 `CHANGELOG.md` 按 release 记录全量变更，二开提交混进去会污染上游的版本叙事，
也会让日后 `rebase` / `cherry-pick` 时难以分辨哪条是上游的、哪条是自己的。

**约定**：

| 场景 | 写到哪 |
| --- | --- |
| 二开新增/修改/修复 | 本文件 |
| 同步上游后被动产生的内容 | 不写，由上游 `CHANGELOG.md` 负责 |
| 仅为适配上游新版本而做的补丁 | 本文件，标注「跟随上游」 |

---

## [Unreleased]

## [1.2.0-video.5] - 2026-10-18

基线是上游 `d725f191`（`v1.2.0-rc.2`）。本版由**两件独立的事**组成：

- **一次上游同步**：`cc41a9b3` 合并 `upstream/main`（36 个提交、338 个文件、
  `+27,498 / −1,661`）。四处冲突都记在 merge 提交里，其中两处是**有意偏离**：
  `docker-compose.yml` 的 render-service 内存上限保留本 fork 的 16g（本 fork 默认
  4 块并行渲染，沿用上游 8g 会在导出中途被 OOM kill），`package.json` 保留二开版本号
  而不是采用上游的 `1.2.0-rc.2`（rc 是上游自身状态号，与二开序列无语义关系）。
- **二开自己的 9 个提交**（`--first-parent` 口径，不含本次发布提交）：课程生产台
  UI 大修 **B1–B5**（系列驾驶舱 → 五步铺开 → 旧台账归档 → 首页「继续上次」→ 七步条）
  与**系列大纲层**（章、节先于目存在）。

**版本号说明**：沿用 `1.2.0-video.N` 版本线，本次递增到 `1.2.0-video.5`。
本版 `packages/@openmaic/` 下的文件**有改动，但全部来自上游同步**
（`git diff --name-only v1.2.0-video.4..HEAD -- packages/` 为 56 个文件），六个子包的
版本号由上游一并 bump 到 `dsl 0.11.3 / generation 0.3.18 / storage 0.37.3 /
renderer 0.1.13 / editor 0.0.11 / importer 0.3.1`，
`node scripts/check-package-version-bumps.mjs v1.2.0-video.4` 通过；二开自己没有改这
六个包。因此本版**会**命中 `publish-packages.yml` 的 `push: main` +
`packages/*/package.json` 路径条件（前几版因未同步上游而不命中）。

**读法**：本版主题可以概括成一句：**先把位置排出来，再谈每一格里写什么。**
B1–B5 解决"进去以后不知道干什么"，系列大纲层解决"还没进去的时候没有位置"。

- **B1/B2**：`/curriculum` 收敛成系列驾驶舱，只回答一个问题——"现在做哪一目，
  为什么是它，卡在第几步"；知识技能图一步先做两栏化试点（AI 出草稿、人逐行签字）。
- **B3/B4**：五步共用「AI 起草 → 逐行签字」的同一套骨架，草稿不落库从自觉升级为
  **类型不变量**；旧 6 Tab 台账整体归档为 `/curriculum/legacy`，只把「生成与导出」
  迁进目工作台——此前设计做完之后，页面上没有任何按钮能拿到视频；首页「继续上次」
  与驾驶舱同源同函数，没有待做一目时整块不渲染。
- **B5 七步条**：七步全显示、圆圈里写 1..7、已走完对勾、当前「你在这」；用户可见的
  每一次步骤引用都必须带序号，修掉"同一个第 3 步、一屏四个名字"。
- **系列大纲层**：章/节独立于目存在（migration 15），可以先建 6 章 18 节再逐节建目；
  看板与推荐顺序都改为顺着大纲走，而不是按创建时间挑"最早的"。

本版共 **451 个文件、+42,153 / −2,482 行**（`git diff --shortstat
v1.2.0-video.4..HEAD`，含上游同步的 338 个文件；不含本次发布提交自身）。

### Added

> 下列条目原样来自本次的 `[Unreleased]`，未作改写；B1、B5 与系列大纲层的落地已在
> 上面「读法」里概括，逐条细节见各自提交信息与
> `docs/curriculum-redesign/SERIES-UI-REDESIGN.md`。

- **系列大纲（章 / 节）：先出章、再出节、最后才出目**。用户打开新系列被要求直接"新建目"，
  原话是"现在直接让我写目，我怎么写啊？这一块需要修改一下"——不是文案问题，是**操作顺序被
  系统跳过了**：章、节在库里只存在于**每个目内部**的大纲（`curriculum_unit`），驾驶舱的"章
  分组"是拿目编号前缀猜的（`series-cockpit.tsx` 的旧注释自己写的"明确降级"）。现在：
  `curriculum_series_outline_node`（migration 15）存章、节两级，**可以在任何目之前存在**；
  `curriculum_task` 补 `section_id / code / kind / order_index`（目自己的编号不再从内部条目
  上借），`curriculum_series` 补 `audience / default_hours`（系列级默认 brief，目创建时继承）。
  驾驶舱主角卡按状态换：没有章 →「先把大纲搭出来」（建第一章 / 从大纲导入）；有章没目 →
  「建第一目」；有目 →「现在做这一目」，推荐顺序改为**顺着大纲走**（`NextItemRow.outlineRank`，
  章序×10000+节序×100+目序）而不是"最早建的先做"。看板由 `series-board.tsx` 取代按前缀猜章的
  `objective-matrix.tsx`，空节保留占位、未归类的目单独成组（删节不删目，`ON DELETE SET NULL`）。
  「从大纲导入」是纯文本解析（`lib/curriculum/outline-import.ts`：`#` 章、`##` 节、`-` 目，
  竖线分隔，可从右往左省略字段），`POST .../outline/import` 先 `preview` 再 `commit`，
  提交失败整批回滚、已存在大纲/目时 409 拒绝。`course-packages/ctf/outline-54.txt` 是
  《CTF 综合实战》6 章 × 3 节 × 3 目的导入种子。核对口径由界面去重：目内条目角色改称
  「讲授 / 练习 / 考核」，目的类型才叫「理论目 / 实操目 / 综合目」。数据库层由 CHECK +
  触发器保证"章在顶层、节只能挂在同一系列的一章下面、编号在系列内唯一"，
  `tests/persistence/curriculum-outline-schema.test.ts` 与
  `tests/curriculum/series-outline-route.test.ts` 钉住。取舍见
  `docs/curriculum-redesign/SERIES-UI-REDESIGN.md` §8.6。
- **七步条（B5）：1-7 每一步都标出来**。用户实看 B1–B4 之后的原话是"还是不够指引，把每一步
  都标出来，1-7 这种，更加明显一些"——上一版是一排没有序号的小徽章，只长在设计编辑器那一半
  的顶部。现在 `components/curriculum/step-rail.tsx` 一根组件两处复用：目工作台挂在 Tabs
  **之外**（矩阵、编辑器、生成与导出切到哪一块都看得见），系列驾驶舱放在"现在做这一目"卡里。
  七格全显示（设计稿 §5.3 折叠 5/6/7 的规则**否决**，`STEP_BAR_PHASES` 常量删除）、大圆圈里是
  1..7、已走完是对勾、当前步写「你在这」、空位是空心圆——状态不只靠颜色。编辑器每张卡片加
  「第 N 步」角标，滚动离开顶部之后仍读得出这张卡片是第几步。`ui-labels.ts` 把步骤拆成
  `STEP_NUMBER`（序号）+ `STEP_NAME`（名字），`STEP_LABEL` 由两者拼出，`tests/curriculum/
  step-labels.test.ts` 把"序号与阶段机同序、每张表恰好七键、名字唯一"钉住。取舍见
  `docs/curriculum-redesign/SERIES-UI-REDESIGN.md` §8.4。

- **课程生产台 UI 大修 B3/B4 落地（系列驾驶舱之后的收尾）**。五步共用一套「AI 起草 →
  逐行签字」的通用骨架（`lib/curriculum/step-draft.ts` 起草引擎 + `step-draft-route.ts`
  骨架路由 + `step-copilot.tsx` 副驾面板），"草稿不落库"从自觉升级为类型不变量（骨架交出的
  `DesignContext` 不含 `write`）。审查副驾那一步不做——它是确定性规则，没有可起草的东西。
  旧 6 Tab 台账整体归档为 `/curriculum/legacy`，`/curriculum` 变成重定向（书签与旧文档不死）；
  旧台账只迁「生成与导出」进目工作台第三个 Tab（`design-produce.tsx`）——原来设计做完之后
  这个页面上没有任何按钮能拿到视频；导出支持按 stage 入队（`POST /api/curriculum/export-jobs`
  收 `{stageIds}`，逐 stage 幂等，`batch_item_id` 为 NULL 的普通任务，不需要新表），浏览器侧
  认领/构建 ZIP/提交渲染/轮询抽成 `lib/curriculum/export-worker.ts` 两个页面共用（认领是按
  owner 取全局最旧，各写一份会出现只在某个入口复现的"导出永远卡住"）；首页新增「继续上次」
  （`continue-last-card.tsx`），与驾驶舱同源同函数（`/overview` + `chooseNextItem`），
  没有待做一目时整块不渲染。设计与取舍另见
  `docs/curriculum-redesign/SERIES-UI-REDESIGN.md` §8.3。

### Fixed

- **同一个第 3 步，一屏四个名字——其中一个是数据库里的 `outcomes`**。用户贴回的截图里，卡片
  标题写「知识技能与依赖」、空态写「先完成**依赖图**阶段…当前在**学习成果**阶段」、右栏红字写
  「当前处于『**outcomes**』阶段；推进到『**graph**』阶段」、确认按钮写「确认**知识技能图**」。
  四个都不是打字错误，是四份各自维护的文案，所以加一根七步条解决不了它。现在立一条规则并写成
  测试：**用户可见的每一次步骤引用都必须经过 `stepRef()`（序号 + 名字一起出现）**。
  具体落到：`ui-labels.ts` 新增 `STEP_WORK_NAME` / `stepRef()` / `stepLockReason()` /
  `stepLockMessage()`；五处 409（`step-draft-route`、三条 turn 路由、`store.assertPhase`
  ——最后这句还会经路由回给客户端）改走 `stepLockMessage`；六条阶段缺口文案改由
  `STEP_WORK_NAME` + `stepRef('next')` 拼；十一个 signoff/dialog 的按钮与提示语改用同一张表
  （「确认知识技能图」→「确认知识技能与依赖」，与卡片标题同词）；
  `tests/curriculum/step-labels.test.ts` 增加源码扫描用例，把三种形状（`进入X阶段`、旧名词 +
  `阶段`、`「${…phase…}」`）在 `components/`、`app/`、`lib/` 里钉成 0（注释行不算），另有正向
  用例点名八处拼步骤引用的文件必须真的调用 `stepRef`/`stepLockMessage`。设计与取舍见
  `docs/curriculum-redesign/SERIES-UI-REDESIGN.md` §8.5。

- **门禁的动词说错了用户要做的事**。`authoringAvailability` 统一拼「新建${label}」，于是界面上
  出现「才能**新建教/练/考覆盖**」「才能**新建条目顺序**」——覆盖与顺序是**关系**，不是新行，
  用户照着这句话去点会找不到"新建"按钮（实际动作是"勾上"和"排一条"）。现在每种门禁自带
  `action`，禁用按钮的悬浮说明是「先推进到第 4 步『课程大纲』，才能排一条条目顺序。课程任务
  现在停在第 2 步『学习目标与证据』。」。

- **同一句缺口在确认按钮的悬浮说明里念了两遍**。这一步的缺口与 error 级审核发现常常是同一句
  话（"还没有任何条目…"），`design-outline-signoff` 与 `design-teaching-signoff` 拼 `blockers`
  时没有去重（`design-assessment-signoff` 早就用了 `new Set`）。四处现在一致。

- **同屏三遍"第几步"，以及待办行读不出进度**。`chooseNextItem` 的理由原本是
  `卡在第 3 步 · ③ 需要哪些前置知识。`：序号出现两遍（"3"与"③"），且与旁边的七步条、
  标题角标说的是同一件事。现在理由只回答"为什么是这一目"（"这是最近动过、还没出片的一目"），
  步骤交给七步条结构化显示；`next-item.test.ts` 改为钉住"理由里不出现步骤名"。驾驶舱待办行
  以前在有阻塞时**整条换成**"N 处审核未处理"，于是一半的行读不出卡在哪一步——两件事并不互斥，
  现在同时显示。

- **窄屏下角标把卡片标题挤成一字一行**。标题那一行是 `flex items-center gap-2`，"第 3 步 / 共
  7 步 · 还没轮到"占掉宽度之后，"知识技能与依赖"只能一个字一行（390px 实测）。十处标题行加
  `flex-wrap`：放不下时角标与名字各占一行，不再压缩名字。

- **模型没标 Bloom 层级 / 难度时，那条建议永远采纳不了，且同类问题共有四处。**
  `POST /questions` 与 `PATCH /questions/<id>`、`POST /nodes`、`PATCH /nodes/<id>` 用同一个
  `oneOf` 读枚举字段，模型省略可选项时值为 `null`，界面报"只能是以下之一"而与建议无关。
  现在允许的键名名单从 `design-validation.ts` 源码读出（漏一个就红），起草引擎在发出前兜底
  剔除 null 值，被丢掉的"清空"变成一行看得见的 warnings。
- **副驾里"改一改"对新建类行不生效**：`renamed()` 返回新对象而调用处丢弃返回值，界面改得动、
  库里还是模型给的原名。单元测试只覆盖了返回值那条路所以全绿，e2e 读数据库才暴露。
- **少 `warnings` 字段的回包把整个设计编辑器打死**（五步面板同页挂载，一个字段缺失整页
  Runtime TypeError）；顺带修正"还有 N 行等你决定"的计数把无按钮的说明行也算进去，永远归零。
- 删除 `curriculum-knowledge-copilot.spec.ts`：它 mock 的是重构前的回包契约，编码了
  "面板是知识那步专用"这个刚被取消的前提；用例并入通用副驾 spec 并改为真实写入路由。

## [1.2.0-video.4] - 2026-10-13

基线是上游 `ccdc88a5`（**本版未同步上游**：`v1.2.0-video.3` 之后没有再做
`git merge upstream/main`）。本节收录自 `v1.2.0-video.3` 以来的 **11 个**二开提交，
它们全部落在同一个方向上：**成果导向课程设计**——把设计流程的八步全部接成闭环
（方向 → 学习目标 → 知识技能图 → 教学排序 → 课程大纲 → 授课脚本 → 题目与实操
→ 审核与导出）。视频链路本版**一行未动**。

**版本号说明**：沿用 `1.2.0-video.N` 版本线，本次递增到 `1.2.0-video.4`。
本版**未改动 `packages/@openmaic/` 下任何文件**（`git diff --name-only
v1.2.0-video.3..HEAD -- packages/` 为空），因此不发 `npm` 包、不消耗
`@openmaic/*` 版本号，也不触发 `publish-packages.yml`。

**读法**：11 个提交里 8 个是功能、3 个是「前面留下的洞」的修补。条目沿用提交里的
叙述（讲**为什么**这么改，而不是改了什么），按步骤顺序排列。**课程产品层的整体设计
与分阶段落地记录**另见 `docs/curriculum-redesign/COURSE-DESIGN-REFACTOR.md`。

本版的主题，可以概括成一句：**签收要能被推翻，而"接受一处缺陷"必须是一份决定。**

- **八步各自成形**：每一步的结论都是一个 AI 写进库、作者签收的**文档**，而不是一次
  模型调用。学习目标、知识技能图、课程大纲、授课脚本、题目与实操，各自有了
  「AI 对话 → 用户签收 → 门禁」的形态（设计工具注册表 24 → 27）。
- **第八步**：审核从纯函数变成**对齐**而不是替换，缺陷有了稳定地址（指纹），
  于是「我接受这个缺口」终于可以是一行**带决定**的记录——这行决定现在被导出闸门读。
- **签收不是不可撤销**：本版同时补上了多处「写入却不撤回签收」——确认大纲之后模型
  还能在确认背后加一章十条目、确认题目之后还能加十道题改判分规则，而这些路径现在都会
  撤回签收（并区分「什么都没改的重述」）。

本版共 **118 个文件、+31,072 / −304 行**（`git diff --shortstat v1.2.0-video.3..HEAD`）。

### Added

> 下列条目原样来自本次的 `[Unreleased]`，未作改写。

- **第八步「审核与导出」：审核是推导出来的，而"接受一处缺陷"必须是一份决定**。
  导出闸门（`assert_course_design_exportable`）与生成入口早就在了，`open`/`resolved`/
  `waived` 三种状态也早就在数据库里了——但**没有任何东西读 `waived`**，而且每次审核都会
  把同一个缺陷当成新行重写一遍，于是决定既没有落点、也没有读者：

  1. **决定没有地址。** 审核是纯函数，每次跑都重新推导 findings 并写新行
     （`replaceCurriculumAuditFindings` 删掉全部 `open` 行再插入）。作者接受的那条行留在
     原地，而同一个缺陷以新 id 重新变成 `open`：**同一个问题在库里有两行，一行已接受、
     一行待处理**，接受的那行永远匹配不上任何东西。
  2. **终态没有诚实的出口。** 门禁只重算快照，所以"我接受这个缺口"这个唯一的决定
     对导出**完全无效**——一门课只要有作者明知且愿意接受的缺陷，就永远不能生成，
     而界面上「接受」按钮是个只会改徽章的装饰。
  3. **同一个事实被算了两遍。** `exportable = quality.exportable && verdict.complete`：
     覆盖规则（`objective_untaught` / `-unpracticed` / `-uncovered`）已经把"哪个目标
     没被教/练/考"报成 error，覆盖统计又独立算了一遍。第二道否决唯一能带来的东西，
     就是**和第一道吵架**：某天闸门拒绝一门课，而解释那一行写着"13/13 个目标已经被教、
     被练、被考"。它真正拦住的其实是"这门课还没有任何学习目标"——那不是缺陷，
     是**前提**，没有东西可以接受。

  这一步的改动：

  - **finding 有了地址**（`fingerprint` = 规则 + 它涉及的行，排序去重；**不含 message**，
    措辞会改，地址不能跟着变）。migration 14 加列、回填、按指纹去重（把决定留下）、
    建 `(owner, task, fingerprint)` 唯一索引——"一个缺陷一行"从约定变成数据库保证。
  - **审核变成对齐而不是替换**（`syncCurriculumAuditFindings`）：按指纹 upsert，
    **不动 `status`**；推导不出来的缺陷连行一起退休（接受是针对那份设计里的那个缺陷，
    缺陷真修好时这次接受就花掉了；再犯就是新的、待处理的）。
  - **门禁读决定**：`evaluateCurriculumDesign` 把 findings 分成 `blocking`（待处理的
    error）与 `accepted`（已接受，附决定行），`exportable = 前提为空 && blocking 为空`。
    覆盖统计退回**摘要**，不再是第二道否决；"这门课还没有目标"改成前提
    （`designPreconditions`，不可 waive）。导出的成功路径会**点名**它带着哪些已接受的缺陷，
    不再沉默。
  - **`resolved` 拒收**（路由 400 + 文案）：审核是推导的，"我修好了"不是一个可以处于的
    状态——设计改好它就自己消失，没改好这句话就是假的。可以记录的唯一决定是 `waived`，
    并且可以撤销（`open`）。
  - **决定的作用范围是"能不能产出"，不是"这一步做完没有"**：阶段机与步骤签收
    **故意不读决定**。它们问的是活干完了没有，而接受一处缺陷不能把活干完；
    在那边也读决定，要么读了照样拒绝（决定有两半、互相矛盾），要么让一门课
    踩着一个还开着的缺口往下建。这条边界写在 `syncCurriculumAuditFindings` 的注释里，
    并有测试钉住（"waive 之后导出能过、阶段机仍然拒绝"）。
  - **新增 agent 工具 `set_course_finding_status`**（注册表 27 → 28）。理由与前一步
    补签收工具完全相同：门禁读决定，而没有工具能写下这个决定，就等于 agent 侧的课
    只要有一处被接受的缺陷就永远无法生成。
  - 界面：审核面板把「待处理（阻塞生成）」与「已接受（不阻塞，生成时会带着它们）」
    分开计数，「已修复」按钮删除（它改不了任何东西），「撤销接受」补上；出课面板
    在通过时列出已接受的缺陷。
  - 顺手修掉两个"声明了但没人做"的东西：审核规则表里的 `objective_unmeasurable`
    **没有任何规则会产出它**（新增一条真正扫描源码的测试，旧的注释写着"必须可达"
    而断言只数了数量）；`activeObjectives` 的注释写着 draft 与 archived 都不算，
    代码只排除 archived（代码是对的，注释错的——一门课是 draft-first 设计的，
    排除 draft 会让每门新课都"没有目标"）。

  文件：`lib/curriculum/design-review.ts`（新）、`lib/curriculum/audit.ts`、
  `lib/persistence/curriculum.ts`（phase 14）、`lib/server/curriculum/design-store.ts`、
  `outline-state.ts` / `teaching-state.ts` / `assessment-state.ts`、`design-validation.ts`、
  `app/api/curriculum/design/tasks/[id]/findings/[findingId]/route.ts`、
  `.../export-gate/route.ts`、`lib/server/agent-runtime/design-tools.ts`、
  `components/curriculum/design-heatmap.tsx`、`course-assembler-panel.tsx`、
  `skills/agent-runtime/course-auditor/SKILL.md`。

- **第七步「题目与实操」：题目与实操是挂在条目上的，而"挂在哪一条"是一个声明**。
  工作台「题目与实操」卡片里点「用 AI 出题与实操」即可对话；模型直接写
  `curriculum_question` 与 `curriculum_lab_task`。这一步要解决的问题不是"能不能出一道题"，
  而是**一道挂错条目的题在界面上完全正常**：有题干、有选项、有答案、有关系到的目标，
  审核的每一条题目规则都满意——只有覆盖闭环里没有它，因为讲这个目标的条目从头到尾
  没出现过它。

  三条判定合成一次实现（`assessmentGaps`），提示词、卡片、阶段门禁、审核四处共用：

  1. **产物必须挂在承诺了这件事的目上。** 挂在章/节上（章只归类，不讲课也不考试）、
     挂在没承担该目标的条目上、实操挂在只讲课的条目上，一律拒收并说明；`itemRef` 可以
     省略，只在**唯一**候选时推导，多个候选时要求指名——"考在哪一条"是作者的决定。
  2. **"考核在这里"必须兑现。** 一个条目写了 `assess` 覆盖却没有任何题目或实操挂在它
     身上，那句承诺是空的。**只查 `assess`**：`practice` 承诺由生成交付（大纲提示词写明
     练习条目生成幻灯片、测验与互动流程），把它也算成"必须有实操"会把正常的练习条目
     全报成缺口。
  3. **考试得是考试。** 证据写着 `exam`、交付它的实操却是 `practice`（有提示、可重做、
     不限时），学员拿到的是练习而成绩单上写着考试。实操的 `exam` 模式强制
     `hintPolicy: forbidden` + `allowRetry: false`（这两项只有一个合法取值），
     而**时限没有合理默认值，缺了就拒收**——替作者编一个"考试多长"不是这一步该做的决定。

  三个字段由规则层推导，模型写不了：`evidenceId`（第二步签过的证据，这一步不新增也不
  搬动；目标下恰好一条对口证据时自动绑定，多条时不猜只说）、`sortOrder`（题号是文档的
  属性，按条目已有最大题号往后排）、以及每个产物的落点。验证规则只收 `{kind, target}`，
  字段映射复用 S5 的 `labVerifyRuleFrom`——"存得下去、永远匹配不上"这个坑不再交给模型踩。

  产物是**独立的行**（同第三步的依赖边，不是第五步的覆盖表）：`ref` 指名改哪一道、
  只写它提到的字段（没提到 = 保持，`[]`/`null` = 清空），删除按 id 指名，没提到的
  一律不动。store 会拒的每一条都在规则层先拒——store 抛错回滚**整轮**，一道答案引用了
  不存在选项的题目不该带走同轮另外九道。

  - 规则层 `lib/curriculum/design-assessment.ts`、AI 步骤 `assessment-step.ts`、
    状态 `assessment-state.ts`、提示词 `course-assessment`、
    路由 `assessment/turn`（对话）与 `assessment`（状态/确认/撤回）、
    界面 `design-assessment-dialog.tsx` / `design-assessment-signoff.tsx` +
    工作台一张卡片。
  - 审核新增四条规则（`question_off_item` / `lab_off_item` /
    `coverage_without_artifact` / `exam_evidence_practice_lab`），全部读同一份判定；
    `assessment → review` 门禁读审核的 `assess_covers` 层加 `drill_no_objective`
    加这一步的签收。
  - **补上第四到第七步缺失的 agent 签收工具**：`confirm_course_outline` /
    `confirm_course_teaching` / `confirm_course_assessment`。第四步（大纲）从 S9 起
    就有门禁，第五、六步从 S10 起也有，但**只有第一到第三步有对应的工具**——于是
    agent 侧的流程从 S9 落地那天起就再也离不开 `outline`：
    `advance_course_design_phase` 被拒绝，理由是一个没有任何工具能记录的签收。
    三个新工具与工作台按钮读**同一个** `*Blockers` 函数（顺带把它从两个路由里提到
    状态模块，路由改成调用），所以按钮与模型不可能对"这一步做完了没有"各说各话。
    发现它的过程见下方 Fixed。

- **课程设计第一步「课程方向」改成 AI 对话 + 用户确认**：新建课程现在可以从
  「用 AI 新建课程」开始聊——模型把七个槽位（`title` / `audience` /
  `learnerLevel` / `applicationScene` / `problemStatement` / `durationHours` /
  `trainingScenario`）写进 `curriculum_task`，对话框旁边实时显示卡片和缺口，
  用户点「确认课程方向」才进入下一阶段。

  关键的一点是**「填好了」不再等于「用户同意了」**。新增
  `curriculum_design_confirmation` 表（migration 13，一行一步），
  `phaseCompletionGaps('outcomes')` 现在多检查一条：课程方向未确认则拒绝离开
  `task` 阶段（409 + 具体缺口）。确认有三个入口，都留痕：
  卡片按钮 / 对话里说「确认」（宽松模式，记 `confirmed_by='assistant'`）/
  agent 工具 `confirm_course_direction`。**改动卡片会撤回确认**（只比对七个字段
  的真实变化，重述同一张卡片不会撤销），因为它确认的是那一次的内容。

  - 规则层 `lib/curriculum/design-direction.ts`：七槽位只有一份定义（`as const`
    + 编译期穷尽检查）、缺口、模型回答的清洗（未知键丢弃并记日志、`"48 学时"`
    解析成 48、空串清空）、以及确认的确定性守卫（首轮不能确认、必填没齐不能
    确认）。
  - AI 步骤 `lib/server/curriculum/direction-step.ts` + 提示词
    `course-direction`：一次对话轮次 → 一次卡片写入；不做状态机改动，写库由路由做。
  - 路由：`POST /api/curriculum/design/direction`（对话轮次，直接入库）、
    `GET/POST/DELETE /api/curriculum/design/tasks/[id]/direction`（状态/确认/撤回）。
  - 界面：`DesignDirectionDialog`（对话 + 卡片 + 确认）、`DesignDirectionCard`
    （工作台里的七格编辑 + 确认/撤回 + 打开对话），列表页新增「用 AI 新建课程」。
    顺带补上一个真实的洞：**任务创建之后，七个字段此前在界面上根本改不了**。
  - skill：`skills/agent-runtime/course-analysis/SKILL.md` 增加「签收 brief」一节，
    明确「字段填完 ≠ 用户同意」，要求先 `confirm_course_direction` 再
    `advance_course_design_phase`。

  顺带修掉一个守卫测试的假阳性：`tests/agent-runtime/skills.test.ts` 的
  「退役工具名不得出现在 skill 里」用的是子串匹配，而 `patch_course_task` 是
  **现役**工具、恰好以退役名 `patch_course` 开头，于是 skill 一旦写出正确的新
  名字就会被判违规。改成整词匹配（`\b`）后，退役名单独出现仍然会被抓住，现役名
  不再误伤。

  验证：

  - 改动相关套件 **402 项全绿**（`tests/curriculum` 253 项含新增
    `design-direction` / `direction-route`，加上 store / 路由 / agent 工具 /
    skill 守卫）；`tsc --noEmit`、`eslint`、`prettier --check` 全绿。
  - 真 PostgreSQL 契约套件 `PG_CONTRACT_URL=… vitest run
    tests/persistence/curriculum-design-*.pg.test.ts` **10/10 通过**——新表与
    确认行在生产引擎上验过（含重复确认只留一行、跨 owner 撤回返回 false）。
  - 回归 `tests/curriculum + agent-runtime + generation`：**零新增失败**，前后
    同为 37 个失败且名称逐条相同。
  - 活体 walk `scripts/verification/design-api-walk.py` 在运行中的 dev server 上
    **113/113 通过**（含真实模型的一次「第一步」对话：模型产出七槽位卡片、
    按钮确认、该课程成功离开第一步），证据在
    `artifacts/regression/design-walk-step1.txt`。列表页入口 `/curriculum/design`
    在 SSR HTML 里能读到「用 AI 新建课程」。

  注意：migration 13 需要 dev server 重启（或按 bootstrap 应用）后才生效——长跑
  的 dev server 把 schema bootstrap 缓存在进程里，新的迁移不会自动补上，直接请求
  会 500（`relation "curriculum_design_confirmation" does not exist`）。本次已在
  开发库上按 app 自己的 `ensureCurriculumSchema` 应用了 migration 13。

  未做浏览器端驱动验证：仓库里 Playwright 期望的 chromium 版本是 1208，本机缓存
  的是 1148 且缺少可执行文件，`npx playwright install chromium` 在 7 分钟内没有
  下载成功。工作台卡片与对话框的验证来自 tsc / eslint / 代码评审与接口层活体
  walk，界面效果请在浏览器里确认。

### Added

- **第二步「学习目标与考核标准」同样是 AI 对话 + 用户签收**：工作台里点「用 AI
  修改学习目标」即可对话；模型直接把目标与考核方式写进 `curriculum_objective` /
  `curriculum_evidence`，改完点「确认学习目标」才允许进入知识技能图阶段。
  `phaseCompletionGaps('graph')` 多一条门禁，`outcomes` 的签收与第一步共用
  `curriculum_design_confirmation` 表。

  与第一步最关键的区别：**清单没有"只改这一格"的安全阀**。模型每次回答都会重述整条
  目标，而重述就是一次写入——用户看不出措辞变化，重述却可能顺手丢掉一条最低标准，
  让可考核的目标退回不可验证。所以清单的安全阀换成**指名道姓**：模型只能用 `ref`
  指明要改哪一条，规则三条全在 `mergeOutcomePatch()` 里：对不上的 `ref` 丢弃并记账
  （绝不按位置套用）、删除优先于修改、同一条只接受最后一次 patch。

  一处不对称的容忍度是这一层最难的决定：**目标缺最低标准时接受写入**（落库为
  "不可验证"，这是 UI 要显示、等人补一句的可见状态），而**证据缺检验方式或成功条件
  时拒绝**——空的证据行能满足 store 的"每个目标都有证据"门禁却什么都没证明，它会
  把门禁骗过去。

  确认比第一步多一条底线：**这一轮必须真的动过清单**。没有增删改的"确认"是对一句
  "看起来还行"的附和，不是签收这一轮的成果。

  改动即撤回签收，但**重述不算改动**：`updateCurriculumObjective` 比较合并后的整行，
  所以模型为改一条最低标准而重发标题不会撤销用户的确认；新增/删除目标、增删证据一律
  撤回。agent 侧新增 `confirm_course_outcomes` 工具，skill 与提示词补上对应规则。

  - 规则层 `lib/curriculum/design-outcomes.ts`，AI 步骤 `outcomes-step.ts` +
    `course-outcomes` 提示词，路由 `outcomes/turn`（对话）与 `outcomes`（状态/确认/
    撤回），界面 `design-outcomes-dialog.tsx` 与 `design-outcomes-signoff.tsx`
    （嵌在学习目标卡片头部，不另起一张卡——并排会让人以为多了一步）。
  - 顺带把第一步的 `parseDirectionTurnRequest` 改名 `parseConversationTurnRequest`
    并复用：两步的请求体和确认轮次计数相同，两份上限副本会让其中一步接受另一步拒绝的
    对话记录。

  验证：

  - 新增 `design-outcomes` 31 例、`outcomes-route` 14 例（**均为 0 模型 0 数据库的
    规则层与路由层**）；`tests/curriculum` 298 例全绿。
  - 真 PostgreSQL 契约套件 11 例全绿，新增一例专测「重述不撤回、真改动才撤回、
    新增目标也撤回」。
  - 回归 `tests/curriculum + agent-runtime + generation`：与 stash 基线**逐条相同**的
    37 个既有失败，**零新增**。
  - 活体 walk `design-api-walk.py` **142/142**（证据 `artifacts/regression/
    design-walk-step2.txt`），含**真实模型跑完的完整第二步**：一轮对话让模型写下
    6 条学习目标 + 14 条考核方式，全部可验证、每条证据都写明怎么验和什么算通过；
    模型还主动把两个待定问题（Writeup 是否只限 Web/Pwn、是否用统一评分量表）问回来
    而不是替用户决定。

  活体校验抓到一个只有跑 walk 才会发现的洞：`createCurriculumObjective` 没有调用撤回
  逻辑，所以**确认之后新增一条目标，清单已经不是用户读过的那一份，`graph` 门禁却仍
  然开着**。已修，并由 pg 契约测试锁住。

  未做浏览器端驱动验证（同第一步：Playwright 期望的 chromium 版本本机不具备）。

### Added

- **第三步「知识点与技能点拆解」同样是 AI 对话 + 用户签收**：工作台「知识技能与依赖」
  卡片里点「用 AI 拆解知识技能点」即可对话；模型直接写 `curriculum_learning_node` 与
  `curriculum_node_objective`。确认前 `graph → outline` 一律 409，且这个 409 写在
  store 里（直接 POST 阶段路由也推不动）。
  - 规则层 `lib/curriculum/design-knowledge.ts`：解析、缺口、确认判定。`ref` 指名
    节点、`objectiveRef` 指名目标，两个指向都对不上就丢弃并记账。
  - **连线按节点合并，绝不整表替换**：store 的 `setCurriculumNodeObjectives` 是
    「删掉本任务全部连线再重建」，那是工作台保存按钮的语义；模型一轮只提到它改的
    几个节点，照搬会**把它没提到的节点的连线连带删掉**，而且用户看不出。规则层按节点
    算意图，合并成这一轮之后的完整集合再交给 store。
  - **`objectiveRef: null` 可以清空一个节点的连线**：否则用户挂错一条支撑线只能删掉
    整个节点重来。
  - **这一步不排章节**：解析器不接受任何章节字段，模型擅自写的 `chapters` / `units`
    被丢弃并在 `rejectedRefs` 里说明。
  - agent 工具 `confirm_course_knowledge`，并同步
    `CURRICULUM_DESIGN_ALLOWLIST` / `CURRICULUM_DESIGN_TOOL_PHASES` /
    `CURRICULUM_DESIGN_TOOLS_PROMPT` 与 `course-analysis` skill。

- **第五步「生成课程大纲」是 AI 对话 + 用户签收**：工作台「课程大纲」卡片里点
  「用 AI 排大纲」即可对话。模型把已经签收的学习目标、知识技能图和先后关系组织成
  **章 → 节 → 目**，并写清每个目讲授/练习/考核了哪些目标。确认前
  `outline → teaching` 一律 409。
  - **章和节都是 `chapter`，目是 `item`**：用户的「章 / 节 / 目」是三级，库里的
    `unit_type` 只有两种，靠 `parent_id` 分层——章和节是归类（不承载覆盖），目是唯一
    会教东西的一层。`planUnitWrites` 支持同一轮里用模型自己起的 `ref` 互相指名父级，
    章、节、目一次写全，并且**父级必须先写**（向前引用会被拓扑排序调整，成环则丢掉并
    记账）。
  - **单元是独立的行，覆盖是整表替换**：`setCurriculumUnitCoverage` 会删掉全任务覆盖
    再重建，所以规则层算的是**这一轮之后的完整账本**（只替换被指名的条目，其余原样带
    过来）。只发被指名的那些，会静默把别的条目清空，然后在门禁那里报成"有目标没有
    被讲授"。
  - **凡是 store 会抛的，规则层先丢掉**：整轮对话在一个事务里写入，store 抛一次就回滚
    全部改动。章节带教学角色、条目没角色、父级不是章节、覆盖挂在章节上（数据库里还有
    触发器）——这些都在写入前过滤并进 `warnings`（用户看得见），而不是让整轮白干。
  - **顺序第一次变成真的**：`unit.orderIndex` 是提交顺序的地方，而审核的
    `dependency_out_of_order` 此前**只读 `objective → objective` 的边**——第三步签下的
    节点级先后关系没有任何读方，那句"顺序由边推导"是装饰。规则层的
    `outlineOrderConflicts` 现在同时走两种端点（节点经由"支撑哪些目标"折到条目上），
    审核那条规则改为调用同一个实现，两处不再可能各说各话。
  - **签收与写入在同一个事务里**：缺口在**写完之后**从库里重算（规则层缺口 + 审核自己的
    条目顺序发现），所以记录下来的确认一定覆盖磁盘上那一份文档；模型自称"用户已确认"
    但大纲还有缺口时，不记录确认并在 `warnings` 里说明原因。
  - 规则层 `lib/curriculum/design-outline.ts`、步骤层 `outline-step.ts`、状态层
    `outline-state.ts`、提示词 `course-outline`、路由
    `.../outline`（GET/POST/DELETE）与 `.../outline/turn`、界面
    `design-outline-dialog.tsx` + `design-outline-signoff.tsx`。

- **第六步「教学内容生产」：授课脚本 → 分镜，同样是 AI 对话 + 用户签收**：工作台新增
  「授课脚本与分镜」卡片，点「用 AI 写脚本与分镜」即可对话。每个条目写清**讲什么、讲到
  什么程度**（讲透 / 带过 / 点名 / 不讲），讲课条目再把这件事落成**分镜**——每页一句
  目标、一句核心信息、一种呈现方式。确认前 `teaching → assessment` 一律 409。
  - **脚本和分镜写在同一个 plan 对象里进出**，不是两个数组：分镜是脚本的逐页化身，拆成
    两处写，模型就会改了一处忘了另一处，而两者的矛盾在界面上看不出来——脚本一个表格、
    分镜一个列表，各自都完整——直到生成出一份与设计无关的课件。
  - **新增两条审核规则**（`teach_covers` 层）：`unit_lesson_undesigned`（条目没有教学
    设计、讲课条目没有分镜）与 `deck_script_conflict`（脚本说要讲透的节点没有任何一页
    担着，或分镜在讲脚本写明不讲的东西）。判定函数只有规则层那一个，面板、对话提示词、
    门禁三处都调它。
  - **节点引用存 id，入口和出口各有一次翻译**：`core`/`brief`/`mention` 与页面
    `teaches` 都收 id（写名称也认并解析成 id 存），因为"脚本说要讲透 X"和"第 3 页在讲 X"
    必须是同一种寻址才能互相比较——那是这一步唯一真正新增的检查。进生成提示词前由
    `deckDesignForGeneration` 换回**名称**（生成器不认识 `node_xxx`），并把解析不到的
    引用丢掉。
  - **`nodes` 与 `objectives` 由规则层推导**，解析器显式拒收模型给的版本：它们是同一件
    事的两种说法，让模型同时维护就是让它们漂移，而审核读的恰好是推导出来的那个。
    `omit` 是唯一收自由文本的档——最值得写进"不讲"的，恰恰是本条目不涉及的、读者可能
    以为会讲的东西。
  - **分镜只属于讲课条目**：练习和考试条目生成的是场景不是幻灯片，给它们写分镜是一次
    静默的空操作，所以规则层直接拒收并记账。
  - **签收与写入在同一个事务里**（同第五步）：缺口在**写完之后**重算，确认记录与它覆盖
    的那份文档一次提交落地；真正的改动撤回签收，重述不撤回。
  - 规则层 `lib/curriculum/design-teaching.ts`、步骤层 `teaching-step.ts`、状态层
    `teaching-state.ts`、提示词 `course-teaching`、路由
    `.../teaching`（GET/POST/DELETE）与 `.../teaching/turn`、界面
    `design-teaching-dialog.tsx` + `design-teaching-signoff.tsx` 与工作台卡片。
  - 分镜进生成：`lib/types/generation.ts` 的 `DeckDesignPage.teaches`、
    `deck-design-contract.ts` 把"这一页教什么"打印进提示词、生成路由把 id 换成名称。

### Changed

- **`phaseCompletionGaps('teaching')` 加上了大纲签收检查**：`outline` 签收此前对状态机
  毫无作用——一份从没被读回的大纲也能离开 `outline` 阶段，然后教学设计就建立在没人
  批准的顺序上。现在和其它三步一样：未确认则 409。
- **`phaseCompletionGaps('assessment')` 加上了教学内容检查**：每个条目都要有教学设计、
  每个讲课条目都要有分镜、分镜不得与脚本矛盾，并且 `teaching` 签收必须已记录。题目和
  实操任务是**对着**教学设计写的，所以在没人设计过的条目上写题目正是这道门禁拦的事。

- **`phaseCompletionGaps('outline')` 补上了缺失的那一半**：原来只检查「每个节点都要有
  目标」，**一个目标完全可以没有任何节点**——它照样通过检查，然后在大纲阶段变成
  「讲什么都不知道」。现在两端都查，并加上 `graph` 签收检查。

- **节点写入开始撤回签收**：`createCurriculumLearningNode` /
  `deleteCurriculumLearningNode` 之前不动签收，所以确认之后新增一个节点，
  `outline` 门禁却仍然开着（同第二步 `createCurriculumObjective` 那个洞）。

- **`setCurriculumNodeObjectives` 不再无条件删表重建**：它比较 pair、支撑强度、备注
  三项，也就是作者会读的那几项，一致就不写。否则工作台每点一次「保存」都会撤回
  签收，即使连线集合一个字节都没变。

  验证：

  - 新增 `design-knowledge` 28 例、`knowledge-step` 10 例、`knowledge-route` 15 例
    （后者为 PGlite 路由层，断言的是**数据库里的行**）；`tests/curriculum` **351 例
    全绿**。
  - 回归 `tests/curriculum + agent-runtime + generation + persistence`：与 stash
    基线**逐条相同**的 60 个既有失败，**零新增**（基线
    `artifacts/regression/step3-wide-before.txt` 与改动后 `…-after3.txt` 的 `diff`
    为空）。
  - 活体 walk `design-api-walk.py` **158/158**（证据
    `artifacts/regression/design-walk-step3.txt`），含**真实模型跑完的完整第三步**：
    一轮对话让模型从 9 条学习目标反推出 37 个知识/技能点 + 41 条支撑关系，并主动把
    三处推断（pwntools 脚本点同时挂两个目标、Crypto 拆细后可能支撑不足等）说出来请
    用户确认，而不是替用户决定。
  - walk 里新增一条断言专门钉住「连线按节点合并」：改一个节点的支撑之后，
    **其余节点的连线一条不少**。

  测试抓到三个真 bug（都已修）：① `create`/`delete` 不撤回签收；
  ② `setCurriculumNodeObjectives` 每次保存都撤回；③ 第一版把「这一轮提到过的节点」
  排除在缺口之外，结果模型刚清空一个节点的连线，这个节点就从「待挂目标」里消失了
  ——判据必须是**这一轮之后还有没有连线**，而不是「有没有被提到」。

  活体 walk 顺带证明了新门禁：一条目标没有任何节点支撑时，即使每个节点都挂了目标，
  推进仍然被拒（`1 个学习目标没有任何知识/技能点支撑`）。

  未做浏览器端驱动验证（同第一步）。

- **第四步「内容依赖分析与教学排序」并入第三步，落成同一张图上的有向边**：查消费方
  之后发现它不该是独立阶段——节点间依赖边当时只有路由与 schema 测试在读，而
  `node.sortOrder` 除列表显示外没有读方（审核的顺序规则读的是 `unit.orderIndex`）。
  并进第三步后交付三件事：
  - **先后关系是边，不是排序位**：模型提交 `dependencies`（`sourceRef` →
    `targetRef`），`teachingOrder()` 由这些边做拓扑排序**推导**讲授顺序，只用于展示与
    提示词，**不写回任何列**——存下来就是第二份真相，改一条边就会漂移。
    `supports` 不参与排序（它说明互相支撑，不说明谁先讲），这一区分收在
    `CURRICULUM_DIRECTED_EDGE_TYPES` / `CURRICULUM_ORDER_CLAIM_EDGE_TYPES` 两个常量里。
  - **边是独立行，所以只增删被指名的那些**：与连线相反，这里没有整表替换的风险；
    删除按 `dep_…` id 指名，同轮"删了又提"以删除为准。
  - **会成环的边在规则层丢掉并说出来**：store 的环检测会抛错并回滚**整轮**，一个写错的
    先修关系不该带走同轮几十个节点；丢掉之后进回包的 `warnings`（用户看得见）并拦掉
    模型自己声明的确认——一条没写进去的边在界面上没有任何痕迹。
  - **同名节点与"没进任何先后关系"只报告、不拦签收**；语义上的重复内容判定仍留给
    覆盖分析那一步（那时课程全文已在，判断有依据）。
  - 顺手修两个真 bug：① `create`/`deleteCurriculumDependency` 都不撤回 `graph` 签收
    （签完之后加一条先修关系，签的那份已经变了），并区分"完全相同的边重录不算改动"；
    ② `curriculum_dependency` 端点是 `(kind, id)` 而非外键，删节点/目标**什么都不级联**，
    悬空边会让孤儿节点"看起来还有依赖"——两个删除路径现在都会清边。

  验证：

  - 规则层新增 22 例、步骤层 4 例、路由层 5 例（PGlite，断言 `curriculum_dependency`
    的行）、存储层 2 例；`tests/curriculum` 全绿，相关套件合计 **442 例**。
  - 活体 walk `design-api-walk.py` **168/168**（证据
    `artifacts/regression/design-walk-step4.txt`），含**真实模型跑完的先后关系**：一轮
    对话在 37 个节点之间写下 **43 条先修边**，推导出的顺序覆盖全部 37 个节点；另有
    "写一条边撤回签收 / 重录不撤回 / 被拒的环什么也不改"三条针对新行为的断言。
  - 未做浏览器端驱动验证（同前两步）。

### Fixed

- **第四到第七步的签收门禁有，签收工具没有——agent 侧的课程设计流程从 S9 起就卡在
  `outline`**：`advance_course_design_phase` 拒绝离开大纲阶段，理由是"大纲还没有确认"，
  而 `CURRICULUM_DESIGN_ALLOWLIST` 里只有 `confirm_course_direction` /
  `_outcomes` / `_knowledge` 三个签收工具。第一、二、三步各拿到门禁时都配了工具，
  第四、五、六步只拿到了门禁。**发现方式是这一步的宽回归**：`tests/agent-runtime/
  design-tools.test.ts` 的两个 lab 测试自 S9 起一直是红的（它们的 `drillItem` 助手
  走不到 `teaching`），而此前几轮的"宽回归"实际只跑了 51 个文件的窄集，看不到它们——
  这正是前两步各修过一次的同一类问题（验收命令覆盖不到的地方，红多久都没人知道）。
  现在补上三个工具、允许清单、阶段映射与提示词指引，并给 `outline-designer` 技能补上
  "完整的大纲不是已批准的大纲"。`design-tools.test.ts` 现在能从工具侧一路走到
  `review`（含七个签收与六道门禁），注册表计数 24 → 27。

- **`updateCurriculumQuestion` 什么都不校验**：创建路径一直检查"答案必须在选项里"，
  更新路径一个都不查，所以一次 PATCH 可以换掉选项却让答案仍指向 `['C']`——行写进去了，
  审核也满意（有选项、有答案），唯一症状是判分永远判它错，而这与"学员没做对"无法区分。
  创建与更新现在共用同一个 `assertQuestionAnswerable`，并补上"单选/判断题只能有一个答案"。

- **题目与实操的六个写入口此前一个都不撤回 `assessment` 签收**：确认"题目与实操定稿"
  之后，模型还能在确认背后加十道题、改掉判分规则，而阶段机器仍然报告这一步是已签收的。
  现在六个入口都撤回，并区分重述——`updateCurriculumQuestion` /
  `updateCurriculumLabTask` 逐字段比较，重发同样内容不撤签收。

- **大纲写入此前一个都不撤回签收**：`createCurriculumUnit` / `updateCurriculumUnit` /
  `deleteCurriculumUnit` / `createCurriculumUnitCoverage` / `setCurriculumUnitCoverage` /
  `createCurriculumUnitDependency` / `deleteCurriculumUnitDependency` 都不动
  `outline` 签收，所以确认之后模型可以在确认背后加一章十条目，门禁却还开着。现在都会
  撤回，并区分「什么都没改的重述」——`setCurriculumUnitCoverage` 增加同集守卫，
  `updateCurriculumUnit` 比较九个字段，重述不撤签收。

- **审核的 `dependency_out_of_order` 不读节点级先后关系**：它只处理
  `objective → objective` 的边，于是第三步落地的「节点 A 必须先于节点 B」从来没被任何
  规则检查过。现在两种端点都走，节点经由它支撑的目标折到"最早讲授它的条目"上。

- **`schema-migration-checksums` 从 S6 起就是红的**：migration 13
  （`design_confirmation`）落地时没有补进那份 pin 住的清单，而这个文件在
  `tests/curriculum` 之外——常规命令看不到。补上该行后 2/2 通过。

- **`tests/persistence/curriculum-design-store.test.ts` 已红了一整轮**：它的 `advanceTo`
  助手没跟上第二、三步新增的 `outcomes` / `graph` 签收门禁，20 个用例从第二步落地起就
  一直失败——而常规命令只跑 `tests/curriculum`，没人看见。修好助手后 31/31 全绿。

## [1.2.0-video.3] - 2026-10-11

基线是上游 `ccdc88a5`（**本版未同步上游**：`v1.2.0-video.2` 之后没有再做
`git merge upstream/main`）。本节收录自 `v1.2.0-video.2` 以来的 **36 个**二开提交，
它们几乎全部落在同一个方向上：**课程产品层**——从「课程台账」长到「成果导向课程
设计」的一个完整子系统（约 2.8 万行、60 个 API 路由、27 张表）。视频链路本版只动
了一处（渲染分块并行）。

**版本号说明**：沿用 `1.2.0-video.N` 版本线，本次递增到 `1.2.0-video.3`。
本版**未改动 `packages/@openmaic/` 下任何文件**（`git diff --name-only
v1.2.0-video.2..HEAD -- packages/` 为空），因此不发 `npm` 包、不消耗
`@openmaic/*` 版本号，也不触发 `publish-packages.yml`。

**读法**：本次改动量大，条目按「数据层 → 审核与闸门 → 工具与 skill → HTTP 与界面
→ 可用性修补」的顺序排列，与提交顺序一致。**课程产品层的整体设计与分阶段落地记录**
另见 `docs/curriculum-redesign/COURSE-DESIGN-REFACTOR.md`。

### Added

- **独立课程序列页**：新增 `/curriculum/series`，用卡片展示每个系列的名称、描述、
  课程数、学时、知识点/绑定数、已生成课堂数、已导出视频数，以及“课程 → 知识点
  → 生成课堂 → 导出视频”四步进度。支持在页面内新建系列、行内重命名 / 改描述、
  删除系列，并可直接“进入系列”跳到 `/curriculum?tab=ledger&series=<id>`。同时
  为 `/curriculum` 增加 `series` 查询参数同步与当前系列提示条，从系列页进入后
  会自动过滤该系列。删除系列不会删除课程或知识点，`ON DELETE SET NULL` 会把它
  们变成未归属系列。

  配套新增 `PATCH/DELETE /api/curriculum/series/[id]` 与
  `updateCurriculumSeries` / `deleteCurriculumSeries`。

  验证：`pnpm build` 通过，`/curriculum/series` SSR 200；HTTP smoke 覆盖
  创建系列 → 建课程 → 重命名 → 删除系列 → 课程 `seriesId` 变为 `null`；
  重名 PATCH 返回 409，跨 owner PATCH 返回 404，空 PATCH 返回 400；Playwright
  验证系列卡片渲染、行内编辑保存、进入过滤后的课程体系页。
- **目级课程包与生成脚本**：新增 `course-packages/`（课程包格式与 `1-1-1` 样例）、
  `scripts/start-lesson-generation.mjs`，把《CTF 综合实战》的“目”转成一次
  OpenMAIC 生成运行。脚本固定传 `sceneTypes: ["slide"]`、`interactive: false`、
  `taskEngine: false`、`outlineReview: "auto"`，从源头保证每个目只生成 slide
  课程，不会混入 code / interactive / PBL 场景。首条链路已实跑：
  `1-1-1 CTF概述与竞赛形式` 生成完成，得到 14 个 slide scene 的
  `stage-jK0vsZSWXvws`。

  **这是课程生成功能，不是视频导出链路**：课程包是后续理论题、Docker 实操和
  考试模块的挂载点，先以最小 JSON + CLI 跑通“课程包 → generation run → stage”，
  等模板稳定后再进 L4 UI 和批量生产，避免过早把内容结构固化进数据库。

  验证：`node --check scripts/start-lesson-generation.mjs` 通过；
  `--dry-run` 能正确输出生成请求体；实跑 `POST /api/generation-runs` 得到
  `state=completed`，stage 内 14/14 个 scene 均为 `slide`。

- **生成脚本支持固定 owner 与课程库 folder**：`scripts/start-lesson-generation.mjs`
  新增 `--anonymous-id <uuid>`、`--folder <name>`、`--folder-id <id>`。正式批量
  生成时用同一个匿名 owner 和同一个 folder，54 个目的 stage 就不会散落到多个
  匿名空间；不传 `--anonymous-id` 时仍保持旧行为，由服务端每次新建匿名 owner。
  `--folder` 会先按名称查找、不存在才创建，运行完成后通过
  `POST /api/folders/members` 把 stage 归档；`--folder-id` 用于已有 folder。
  `--no-wait` 不知道最终 stageId，因此不自动归档。

  验证：`node --check scripts/start-lesson-generation.mjs` 通过；
  `--dry-run` 正确显示 owner 与 folder；已用稳定 owner
  `anon:2f17ee10-95b7-448b-bd7f-282476f91430` 创建 folder `CTF综合实战`
  （`folder-UIDtG6lf2eGE`），并把有声版 `1-1-1` 的
  `stage-q7WI2k4kHWte` 归档进去。
- **第一批目级课程包扩展与实跑**：新增 `course-packages/ctf/1-1-2.json`
  （《CTF常见赛事与竞赛平台》）和 `1-1-3.json`（《CTF学习路径与常用工具》），
  两包与 `1-1-1` 同结构，固定只生成 14 页 slide。已用稳定 owner
  `anon:2f17ee10-95b7-448b-bd7f-282476f91430` 和 folder `CTF综合实战`
  （`folder-UIDtG6lf2eGE`）完成生成并归档：

  | 目 | run | stage | 结果 |
  | --- | --- | --- | --- |
  | `1-1-2` | `run-Zprg4tm7aUgA2-zy` | `stage-BN1nGN0TLQKk` | `state=completed`，14/14 scene 全部有声 |
  | `1-1-3` | `run-T3UmWD7udyDARHsH` | `stage-n8VTErEDjf2t` | `state=completed`，14/14 scene 全部有声 |

  验证：`/api/stages` 返回 3 个 stage 且 `folderId` 全部为
  `folder-UIDtG6lf2eGE`；`1-1-2` 共 87 个 `audioId`、`1-1-3` 共 98 个
  `audioId`，两个 stage 每个 scene 都至少绑定一条 TTS 音频。

- **课程产品层第一版（课程台账 + 课程关系图）**：新增 `curriculum_*`
  PostgreSQL 表、owner 隔离的 REST API（`/api/curriculum`、`/api/curriculum/series`、
  `/api/curriculum/courses`、`/api/curriculum/relations`）和 `/curriculum`
  工作台页面。第一版把已经生成出来的 `stage` 作为“课程内容”挂到稳定课程实体
  上，支持系列、章/节/目、学时、学分、学期、状态、stage 关联，以及先修/
  后续/相关/支撑关系和 React Flow 关系图。课程 schema 走惰性 migration，
  并已注册到 `APP_SCHEMA_STORES` 参与启动校验。

  验证：`tsc --noEmit`、ESLint 通过；schema 迁移 checksum 测试通过；
  已用稳定 owner 建 `CTF综合实战` 系列，并把 3 个已生成 stage 写入课程台账
  （`course-2pl8JEmB7px4` / `course-o3nxnlmzEtcv` / `course-CWwV3UclqNQ2`），
  建立 `1-1-1 → 1-1-2 → 1-1-3` 的先修关系；`/api/curriculum` 返回 1 个系列、
  3 门课程、2 条关系，`/curriculum` 页面 SSR 200。

- **知识点层（知识点库 + 课程知识点绑定）**：新增 `curriculum_knowledge_point`
  与 `curriculum_course_knowledge_point` 表、`/api/curriculum/knowledge-points`
  CRUD API、`PUT /api/curriculum/courses/[id]/knowledge-points` 绑定接口，以及
  `/curriculum` 页面里的“知识点库与课程绑定”面板。知识点支持 owner/系列隔离、
  树形父子层级、知识/技能/素养类型、入门/基础/进阶/高级难度和排序；课程绑定
  支持引入/练习/掌握三个覆盖层级。父子关系会校验所属 owner 并通过递归查询
  拒绝成环。课程 schemas 新增 v2 migration，并已更新迁移 checksum 金标。

  验证：`tsc --noEmit`、ESLint 通过；迁移 checksum 测试通过；
  `POST/PATCH/DELETE /api/curriculum/knowledge-points` 冒烟通过；
  知识点成环的 PATCH 返回 400；已为 `CTF综合实战` 灌入 15 个知识点、
  为 3 门课程建立 13 条知识点覆盖关系，`/api/curriculum` 返回
  `knowledgePoints=15`、`courseKnowledgePoints=13`。


- **知识点关系 + 覆盖分析**：新增 `curriculum_knowledge_point_relation` 表、
  `/api/curriculum/knowledge-point-relations` POST/DELETE 接口、
  `GET /api/curriculum/coverage` 报告接口，以及 `/curriculum` 页面的“知识点关系与
  覆盖分析”面板。关系类型支持先修、后继、包含、相关；有向关系会通过递归查询
  拒绝成环。覆盖分析按知识点汇总课程绑定、最高覆盖层级和空缺知识点，并按课程
  汇总知识点覆盖数量；纯函数 `lib/curriculum/coverage.ts` 同时服务 API 与前端，
  保证两端使用同一套口径。课程 schemas 新增 v3 migration，并已更新迁移 checksum
  金标。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；迁移 checksum 测试和新增的
  `tests/curriculum/coverage.test.ts`（2 例）通过；
  `POST/DELETE /api/curriculum/knowledge-point-relations` 冒烟通过，反向成环关系
  返回 400；`GET /api/curriculum/coverage?seriesId=...` 返回 15 个知识点的覆盖
  报告；已为 `CTF综合实战` 写入 4 条先修/相关关系，`/curriculum` 页面 SSR 200。


- **课程组装器（知识点 → 课程包）**：新增纯函数 `lib/curriculum/assembly.ts`、
  `POST /api/curriculum/assemblies` 预览接口，以及 `/curriculum` 页面的
  “课程组装器”面板。组装器按 `parent_id`、`prerequisite`、`follow-up` 和
  `contains` 关系做稳定拓扑排序，生成课程目标、slide 页序、知识点覆盖备注、
  先修缺失警告，并输出可直接交给 `scripts/start-lesson-generation.mjs` 的
  course-package JSON。页面支持从已有课程带入知识点、下载课程包、复制启动
  命令，以及通过既有课程台账 API 保存为课程草稿并写入知识点覆盖关系。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；新增
  `tests/curriculum/assembly.test.ts`（3 例）通过；
  `POST /api/curriculum/assemblies` 冒烟通过，按先修关系正确排序并生成 7 页
  课程包；缺失先修返回 `MISSING_PREREQUISITE` 警告；课程草稿创建 +
  `PUT /api/curriculum/courses/[id]/knowledge-points` + 删除的冒烟通过；
  `/curriculum` 页面 SSR 200。


- **一键生成 + stage 自动回写**：新增 `curriculum_generation_job` 表（v4
  migration）与 `POST /api/curriculum/generation-jobs` 接口，把“课程组装器”
  和现有服务端 generation run 接死。接口在服务端重新组装课程包，创建/更新
  课程台账与课程知识点绑定，创建 owner 隔离的 generation job，然后通过
  `startGenerationRun` 启动服务端生成运行。`instrumentation.ts` 注册
  generation-run 的 `onRunEvent` 钩子：`outline-ready`、`scene-appended`、
  `paused`、`completed`、`ended` 等已提交事件会更新 job 状态；首个 scene 的
  `stageId` 会自动写回 `curriculum_course.stage_id`，并把草稿课程置为 active。
  课程组装器面板新增“一键生成”按钮，默认 `outlineReview=auto`，启动后显示
  run/job/stage 状态并轮询回写结果。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；新增
  `tests/curriculum/generation.test.ts`（4 例）覆盖请求解析和 run 事件映射；
  迁移 checksum 测试更新并通过；本地 PostgreSQL 已应用 v4 migration；
  `POST /api/curriculum/generation-jobs` 对无效知识点选择返回 400；
  `/api/curriculum` 已返回 `generationJobs` 字段；`/curriculum` 页面 SSR 200。


- **批量生成队列（多课程排队 + 限流 + 重试）**：新增 `curriculum_batch` 与
  `curriculum_batch_item` 表（v5 migration）、`POST /api/curriculum/batches`
  入队接口、`PATCH /api/curriculum/batches/[id]` 暂停/继续/取消/重试接口，
  以及 `/curriculum` 页面的“批量生成队列”面板。入队时按当前课程台账和知识点
  绑定在服务端组装并快照完整 `course-package`，之后知识点库编辑不会改变已排队
  任务。每个 owner 的队列通过 `FOR UPDATE SKIP LOCKED` 逐项认领，复用
  generation run 的 owner 并发上限；容量不足时把 item 放回 `queued`，运行
  `onRunEvent` 会同步 item 状态和 `stage_id`，并在完成/暂停后唤醒下一项。
  启动失败（课程已删除、组装无效等）不创建 run，直接标记 item `failed`，
  由重试动作重新入队。`instrumentation.ts` 启动独立的 batch-runner 定时器。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；curriculum 与迁移 tests
  16 例通过；`POST /api/curriculum/batches` 对空 items / 不存在的 course
  分别返回 400 / 404；`PATCH` 对非法 action 返回 400；本地 PostgreSQL 已应用
  v5 migration，`/api/curriculum` 返回 `batches` / `batchItems`，`/curriculum`
  页面 SSR 200。队列认领 SQL 和 drain 路径已用一个缺失课程 item 实测：
  item 从未启动 generation run 直接进入 `failed`。真实模型生成的批量成功路径
  留给验收时点击队列触发，避免在验证阶段消耗模型额度。


- **批量导出 MP4（持久队列 + 浏览器导出工作器）**：新增
  `curriculum_export_job` 表（v6 migration）、`POST /api/curriculum/export-jobs`
  入队接口、`POST /api/curriculum/export-jobs/claim` 原子认领接口和
  `PATCH /api/curriculum/export-jobs/[id]` 生命周期接口，以及 `/curriculum`
  页面的“批量导出 MP4”面板。已完成且有 stage 的 batch item 可以一键加入导出
  队列；服务端负责 owner 隔离的持久队列、15 分钟中断认领回收、重复入队幂等
  和 `FOR UPDATE SKIP LOCKED` 认领，网页端 worker 逐项：

  ```text
  claim export job
    → accessDocument(stageId) 读取服务端权威 stage/scenes
    → buildExportZip({ source }) 在浏览器构建 Hyperframes ZIP
    → POST /api/export-video/render 提交现有渲染服务
    → PATCH attach-render 记录 renderJobId
    → 轮询 /api/export-video/render/[jobId] 并回写进度
    → 成功 PATCH complete / 失败 PATCH fail
  ```

  `buildExportZip` 新增 `source` 快照入口，批量导出不再需要切换全局
  `useStageStore`，也不会覆盖用户未保存的编辑。为适配服务端生成的课堂（媒体以
  分配的 `ast_*` 资源 id 存在），ZIP 帧捕获沿用现有 `isMediaPlaceholder` 分支，
  由共享 pool-first 的 `resolveStoredBytes` / `resolveAudioBlob` 按 id 取回服务端
  资产字节。面板支持重试、取消、下载单个/全部已完成 MP4。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；curriculum + video-export +
  迁移 checksum tests 82 例通过；本地 PostgreSQL 已应用 v6 migration；
  `POST /api/curriculum/export-jobs` 对 `batchItemIds` 正确入队并幂等返回现有
  job；`claim` 返回 `building`；`attach-render` / `progress` / `complete` 分别把
  job 推进到 `rendering` 和 `succeeded`；非法入队体和非法 action 返回 400；
  `/api/curriculum` 返回 `exportJobs`；`/curriculum` SSR 200 且包含“批量导出
  MP4”。为避免验证阶段消耗真实渲染额度，未触发完整 MP4 渲染；浏览器 worker
  的真实构建/上传/轮询路径留给验收时点击“导出”触发。



- **培养方案与指标点矩阵**：新增 curriculum v7 migration（`curriculum_program`、
  `curriculum_program_version`、`curriculum_graduation_indicator`、
  `curriculum_program_course`、`curriculum_course_indicator_support`）、培养方案/
  版本/指标点/计划课程/支撑矩阵 REST API、`GET /api/curriculum/program-coverage`
  覆盖报告，以及 `/curriculum` 页面的“培养方案与指标点矩阵”面板。支持学分覆盖、
  指标点空缺/偏弱/已达标、未关联课程、知识点空缺和冗余、学期学分分布；纯函数
  `lib/curriculum/program.ts` 同时服务 API 与前端。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；curriculum + 迁移 tests
  26 例、PostgreSQL schema migration tests 23 例通过；本地 PostgreSQL 已应用
  v7 migration；真实 API 冒烟创建培养方案/版本/指标点/计划课程/支撑矩阵并返回
  覆盖率报告；非法请求返回 400、重复关联课程返回 409、未知版本返回 404；
  `/curriculum` SSR 200。


- **培养方案 JSON 导入/导出**：新增版本化 JSON 格式
  `openmaic.curriculum.program-plan`，纯函数
  `lib/curriculum/program-io.ts` 负责构建/解析导出文件，指标点和支撑关系以
  `indicatorCode` 引用，避免把 owner 本地 id 写进可分享文件。新增
  `GET /api/curriculum/program-versions/[id]/export` 下载接口和
  `POST /api/curriculum/program-versions/import` 导入接口，支持两种模式：
  `create` 在选中/同名的培养方案下新建版本，`replace` 原子覆盖选中版本的指标点、
  计划课程和支撑矩阵。导入时会先校验 JSON 结构、指标点代码引用和取值范围，
  再按 `courseId → courseCode → title` 顺序匹配或回退为计划占位课程；整个导入在
  owner write fence 的单事务中执行。`/curriculum` 培养方案面板新增导出当前版本、
  导入为新版本、覆盖当前版本和 JSON 文件选择控件。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；新增
  `tests/curriculum/program-io.test.ts`（3 例），curriculum + 迁移 checksum
  tests 29 例通过；真实 API 冒烟完成 创建方案/版本/指标点/课程/支撑 →
  导出 JSON → `create` 导入新版本 → `replace` 覆盖 → 删除方案的完整链路；
  非法导入体返回 400，`/curriculum` SSR 200 且包含“培养方案导入 / 导出”。


- **培养方案版本对比与同步**：新增纯函数 `lib/curriculum/program-diff.ts`，按
  `courseId → 课程编号 → 标题` 匹配计划课程、按指标点编号匹配毕业要求，返回
  指标点、计划课程、课程-指标点支撑和版本元数据的结构化差异（新增/删除/修改
  及字段级 before/after）。新增 `GET /api/curriculum/program-versions/compare`
  对比接口和 `POST /api/curriculum/program-versions/sync` 同步接口；同步复用
  JSON `replace` 写入器，在 owner write fence 单事务内把基准版指标点、计划课程
  和支撑矩阵重写到目标版，同时保留目标版自己的名称、版号、年级、状态和目标学分。
  `/curriculum` 新增“培养方案版本对比与同步”面板，可选择基准版/目标版、交换
  方向、查看差异并按基准版同步，也支持刷新快照。

  验证：`tsc --noEmit`、ESLint、Prettier 通过；新增
  `tests/curriculum/program-diff.test.ts`（4 例，含同步入参校验），
  program-diff、program-io、coverage 等 curriculum 测试通过；`/curriculum`
  SSR 200 且包含“培养方案版本对比与同步”。


- **课程体系入口与六步工作流导航**：主页左上角新增常驻「课程体系」按钮
  （`app/page.tsx`，`BookOpen` 图标）跳 `/curriculum`；工作台页头改为「返回首页 /
  去单课生成 / 刷新」，标题下加一条吸顶导航，把原来纯长滚动的页面按生产顺序串成
  六步：课程台账 → 知识体系 → 培养方案 → 课程组装 → 批量生成 → 视频导出
  （`WORKFLOW_STEPS`，点击用 `scrollToSection` 调 `scrollIntoView`）。同时把生成结果
  变成可点深链：批量队列里已有课堂的行、课程组装器的 `stageId`、课程台账与
  「已有 stage」列表都指向 `/classroom/<stageId>`
  （`components/curriculum/batch-queue-panel.tsx`、`course-assembler-panel.tsx`、
  `curriculum-workspace.tsx`）。

  验证：入口按钮与 `batch-queue-panel.tsx:329`、`course-assembler-panel.tsx` 的
  `/classroom/${stageId}` 链接可在源码核对；`tests/` 下没有任何文件引用
  `curriculum-workspace` / `batch-queue-panel` / `course-assembler-panel`（grep 无命中），
  本提交无配套测试。


- **课程产品独立详情页**：新增路由 `app/curriculum/courses/[id]/page.tsx`
  （`export const dynamic = 'force-dynamic'`）与 `components/curriculum/course-workspace.tsx`，
  把一门课的全部操作从台账页搬进五个页签「基本信息 / 知识点 / 课程关系 /
  组装与生成 / 课堂与视频」（`COURSE_TABS`）。台账页因此只保留新建：删掉
  `editingCourseId`、`editCourse` 与「编辑 / 取消编辑」按钮，课程标题与「打开课程」
  按钮都指向 `/curriculum/courses/<id>`，删除按钮改为图标按钮。配套给
  `CourseAssemblerPanel` 增加 `initialCourseId` / `targetCourseId`（`bootstrappedRef`
  保证只预填一次；保存走 PATCH，生成请求的 `courseId` 指向该课程，按钮文案区分
  「保存为课程草稿」与「保存课程信息与知识点」），给 `KnowledgePointsPanel` 增加
  `defaultCourseId` 以便挂载时选中该课程。

  验证：两个新文件均存在；`curriculum-workspace.tsx` 中已无 `editingCourseId` /
  `editCourse`；`course-assembler-panel.tsx:73-75,203`、`knowledge-points-panel.tsx:28,101,119`
  的新 prop 可在源码核对；`tests/` 无对应测试。


- **课程详情改读聚焦快照，页签同步到 URL**：新增 `GET /api/curriculum/courses/[id]`
  （`app/api/curriculum/courses/[id]/route.ts`）与 `getCurriculumCourseDetail()`
  （`lib/server/curriculum/store.ts`），返回与 `CurriculumSnapshot` 同形的聚焦快照：
  全量 `curriculum_series` 与 `curriculum_course`（供下拉与关系编辑）、该课程所属系列
  的知识点，以及**只属于该课程**的关系边、知识点绑定、`curriculum_generation_job`、
  `curriculum_batch_item`、`curriculum_export_job`；培养方案与批量层留空
  （`knowledgePointRelations: []`、`batches: []`、program* 为空）；课程不存在时抛
  `CurriculumNotFoundError` 走既有 404 映射。课程页此前拉全量 `/api/curriculum`，
  现改拉该端点。五个页签同时与 `?tab=` 双向同步（`parseCourseTab` / `currentCourseTab` /
  `handleTabChange` + `popstate` 监听 + `router.replace`，默认 `profile` 时删除参数），
  刷新与分享链接落在同一页签。

  验证：`app/api/curriculum/courses/[id]/route.ts:38` 的 `GET` 与
  `lib/server/curriculum/store.ts:904` 的 `getCurriculumCourseDetail` 在当前源码中存在；
  `tests/` 中没有任何测试引用 `getCurriculumCourseDetail`（grep 无命中），该 GET 路由
  没有专门的 HTTP 测试。


- **从入口到导出的课程生产引导**：新增展示型组件
  `components/curriculum/course-production-flow.tsx`（`CourseProductionStep` /
  `CourseProductionFlow`，`aria-label="课程生产流程"`），把一门课的生产拆成
  「设计课程 → 生成大纲 → 生成课堂 → 导出视频」四步，带完成态对勾与百分比进度条。
  课程详情页据此计算 `productionSteps`（知识点数、生成任务数、`stageId`、成功导出数）
  与 `activeProductionStep`，点击卡片按 `PRODUCTION_STEP_TABS` 切页签；各页签底部加
  「下一步」按钮（知识点为空时禁用），组装页提示进度看「课堂与视频」。首页 hero 下方
  给出两条互斥入口：快速生成单课（聚焦输入框）与「进入课程序列」（跳
  `/curriculum/series`，入口名由 `49e451ef` 再收敛）。工作台页签同步到 `?tab=` 短别名
  （`WORKFLOW_TAB_PARAM` / `WORKFLOW_TAB_ALIASES`：`ledger` / `knowledge` / `program` /
  `assembly` / `batch` / `export`），并在 `popstate` 回读；「新建课程产品」改为
  「创建并打开课程」，创建成功后 `router.push` 到新课程详情页。

  验证：`components/curriculum/course-production-flow.tsx` 存在并导出
  `CourseProductionStep` / `CourseProductionFlowProps`；`course-workspace.tsx:110-119,305-329,360`
  与 `curriculum-workspace.tsx:131-154` 的上述标识符可在源码核对；`tests/` 无对应测试。


- **成果导向课程设计数据层（S1）**：课程设计不再以「章 / 节大纲」为基底，而是从可验证
  的学习成果正向推进：成果 → 证据 → 知识 / 技能节点 → 依赖 DAG → 大纲 → 教 / 练 / 考。
  章、节降级为呈现与分类，教学内容落在目（`curriculum_unit`）上。

  新增 curriculum migration **v8–v12**（`design_foundation` / `design_graph` /
  `design_outline` / `design_assessment` / `design_audit`）与 12 张表：
  `curriculum_task`、`curriculum_objective`、`curriculum_evidence`、
  `curriculum_learning_node`、`curriculum_node_objective`、`curriculum_dependency`、
  `curriculum_unit`、`curriculum_unit_coverage`、`curriculum_unit_dependency`、
  `curriculum_question`、`curriculum_lab_task`、`curriculum_audit_finding`；旧的知识点 /
  课程账本表保留，两层并存。领域类型在 `lib/curriculum/design-types.ts`。两个决定写进
  类型：成果分四型（`knowledge` / `skill` / `competency` / `task`），`competency` 属于
  成果层而不是知识点类型；参考解 `LabReferenceStep` 与判分规则 `LabVerifyRule` 是两个
  独立类型，避免把「一种解法」当成「判分标准」，从类型上挡住照路径判分。

  数据库约束承担模型的硬边界：`verifiable` 的 CHECK 要求 `expected_behavior` 非空且
  `min_criteria` 至少一项，并用 `jsonb_typeof(...) = 'array'` 而不是会抛错的
  `jsonb_array_length()`（坏列被拒绝为一次写入，不会变成 500）；考试型证据被约束为
  无提示、独立完成；「章不得承载教学内容」用 plpgsql 触发器 `curriculum_coverage_item_only`
  实现，因为 CHECK 无法跨表查询 `curriculum_unit`。

  `lib/server/curriculum/design-store.ts` 提供 CRUD、阶段机、端点归属与环检测。阶段
  `task → outcomes → graph → outline → teaching → assessment → review` 只能逐级前进且
  每级有门槛，`advanceCurriculumTaskPhase` 借 `phaseCompletionGaps` 说明还缺什么；写入侧
  `assertPhase` 按阶段加锁，但**编辑不设门槛**——修订中的课程不该被冻结在它最初到达的
  阶段。顺带修掉继承来的环检测方向 bug：递归 CTE 从新边的 target 反向行走，导致在既有
  `base → injection` 之上再加 `injection → base` 被静默接受；方向已在
  `design-store.ts:1620` 修正。

  **行为改变**：`curriculum_unit_coverage` 的三条独立记录取代旧的单值
  `knowledge_point.coverage_level`（后者把教 / 练 / 考三个正交维度压成一个），并移除
  知识点的 `competency` 类型。

  验证：新增 `tests/persistence/curriculum-design-schema.test.ts`（14 项 PGlite 约束断言，
  含「标记 verifiable 但无预期行为 / 无最低标准被拒绝」）、
  `tests/persistence/curriculum-design-schema.pg.test.ts`（7 项真实 PostgreSQL）、
  `tests/persistence/curriculum-design-store.test.ts`（17 项 store 行为）；提交信息记录
  38 项通过（PGlite 31 + 真实 PostgreSQL 7）、typecheck / lint / prettier 干净，并更新
  `tests/persistence/schema-migration-checksums.test.ts` 中 v8–v12 的金标。


- **成果导向设计审核与生产闸门（S2）**：`lib/curriculum/audit.ts` 以 **21 条规则**、对一份
  `CurriculumDesignSnapshot` 做纯函数审核，因此同一套规则在测试、API 路由与编辑器里跑出
  同一结果，不会各写一份。规则表 `CURRICULUM_AUDIT_RULES` 从设计文档的 13 条扩到 21 条，
  补的都是原清单无法表达的缺陷：`evidence_no_artifact`（声明了 lab 证据却没有实操产物，
  闭环真正断掉的地方）、`dependency_out_of_order`（依赖图正确不等于教学顺序正确，属跨层
  缺陷）、`node_unsupported` / `chapter_with_content` / `unit_orphan` / `brief_incomplete`，
  以及 `lab_verify_grades_by_path`（判分规则照抄参考解，等于用错误的方式藏起「没有判分
  规则」）。

  `evaluateCurriculumQuality` 按九层链路顺序（`CURRICULUM_QUALITY_LAYERS`，从
  `outcomes_clear` 到 `traceable`）报告 `firstBrokenLayer`，而不是平铺问题列表：修好后层而
  前层仍断，覆盖报告会指向错误的东西。`assertCurriculumDesignExportable` **重新跑审核**
  而不是读取已存结论——审核通过后设计可能被改坏，陈旧的「通过」会把未闭合的闭环放进生产
  ——并且抛错而非返回布尔值，调用方无法忽略结果。

  `lib/curriculum/traceability.ts` 提供双向追踪 `traceFromObjective` / `traceFromUnit` 与
  `buildTraceabilityMatrix`；`lib/curriculum/design-coverage.ts` 的 `buildDesignCoverage`
  按目标给出教 / 练 / 考三态、闭环计数与「最不完整优先」的 `gaps`，`summariseCoverage`
  给出闭环判定。旧 `coverage.ts` 因知识关系页仍在调用而保留，由 design-coverage 取代。

  三处对设计文档的修正：`objective_missing_prereq` 改为检查教学设计是否点名该目标的
  primary 支撑节点（原定义与 `objective_untaught` 重复）；`lab_verify_grades_by_path` 收紧为
  精确匹配（子串匹配会把正确的 `file_read('/flag')` 判成按路径判分，误报会让规则被忽略）；
  父子成果去重的 `a.parentId && (...)` 短路 bug 修正为两个方向独立判断。

  另记一个坑：`CurriculumTeachingDesign` 里 `nodes` / `prerequisites` 是 ID 列表，而 `core` /
  `brief` / `mention` / `omit` 是自由文本主题；把后者当节点 ID 扫描会让先修规则在每个正确
  设计上误报，也会让 `traceFromUnit` 返回主题文本当节点 ID。

  验证：新增 `tests/curriculum/design-audit.test.ts`（43 项）与
  `tests/curriculum/design-traceability.test.ts`（19 项），
  `tests/persistence/curriculum-design-store.test.ts` 增至 24 项；提交信息记录 69 项新测试
  （43 审核 + 19 追踪 + 7 store），并说明 `asset-collector-schedule.test.ts` 的 2 项失败在改动
  stash 前后同样复现（先于本次工作存在）。


- **设计阶段驱动工具、技能与课件生成（S3）**：`lib/server/agent-runtime/design-tools.ts`
  新增 **21 个**设计工具，覆盖 S1 全部写入面：`get_course_design` 一次返回整张设计快照，
  其余为细粒度写（任务、成果、证据、节点、节点-成果关联、依赖、章 / 目、覆盖行、目级顺序、
  题目、实操任务、追踪、审核、导出断言）。每个工具按任务当前阶段加锁并限定单个 owner；
  阶段锁是重点——agent 在成果存在之前无法写章节，拒绝会点名当前阶段与还欠的简报字段。

  新增 **11 个单职责 skill**（`skills/agent-runtime/` 下 `course-analysis`、`outcome-design`、
  `knowledge-decomposition`、`dependency-builder`、`outline-designer`、`teaching-designer`、
  `deck-designer`、`practice-designer`、`exam-designer`、`content-producer`、`course-auditor`），
  每个 skill 首段即阶段锁。教学设计与课件设计刻意拆成两个 skill：合并会让一次调用同时决定
  「讲什么」与「分成哪几页」，而那正是讲课设计退化成标题列表的路径。

  `deck_design` 从自由文本 `requirement` 升级为教学意图与 slide 生成器之间的**类型化契约**：
  `lib/types/generation.ts` 新增 `DeckDesign` / `DeckDesignPage`，
  `lib/server/generation/steps/deck-design-contract.ts` 的 `buildDeckDesignBlock` 把页面计划
  渲染成 prompt 块，由 `lib/server/generation/steps/outline.ts` 追加到 system prompt（不改共享
  模板字节，ad-hoc 路径字节不变）。页序按 `order` 排；缺 `goal` / `coreInfo` 的页显式标
  `⚠ MISSING` 而不是静默透传，否则会产出看起来合理、却追溯不到任何教学决策的课件。

  `verifiable` 不再依赖调用方记得设置，而由工具层从 `expectedBehavior` 与 `minCriteria` 推导
  （`verifiabilityOf`，与 DB CHECK 同规则但计算而非仅校验）。此前每个由 AI 写出的成果都会
  永远停在「不可验证」，而工具还在反复要求补上已经填好的字段。

  **行为改变**：`understanding-by-design` 降级为
  `skills/agent-runtime/outcome-design/references/understanding-by-design.md`（「持久理解」
  没有通过 / 不通过条件，进不了证据链，因此是设计输入而非产物），4 个引用它的 skill 已重新
  指向。工具集在 `lib/server/agent-runtime/runner.ts` 无条件注册
  （`buildCurriculumDesignTools`、`CURRICULUM_DESIGN_ALLOWLIST`、`CURRICULUM_DESIGN_TOOLS_PROMPT`），
  provider 惰性解析，没有 curriculum schema 的部署仍能正常启动。

  验证：新增 `tests/agent-runtime/design-tools.test.ts`（12 项）、
  `tests/agent-runtime/design-skills.test.ts`（10 项）、
  `tests/generation/deck-design-contract.test.ts`（8 项）、
  `tests/agent-runtime/runner-skills-registration.test.ts`（6 项）与
  `tests/agent-runtime/runner-voice-registration.test.ts`（3 项）；前三个文件共 30 项断言
  （12 工具 + 10 skill + 8 契约）。提交信息未记录 tsc / lint 结果，故未据此断言。


- **设计 HTTP 接口与目标 × 目热力矩阵（S4）**：`app/api/curriculum/design/` 下 **25 个**路由
  文件覆盖 S1 整个写入面加派生报告——任务 CRUD 与阶段机（`GET .../phase` 返回当前阶段、
  下一阶段与阻塞推进的具体 `gaps`，`POST .../phase` 前进一级）、成果 / 证据 / 节点 /
  节点-成果关联 / 依赖图、章 / 目 / 覆盖行与教学顺序、题目与实操任务、审核（GET 只评估
  不写，POST 记录）、finding 状态、覆盖率、导出闸门与双向追踪。

  `lib/server/curriculum/design-validation.ts` 补回路由丢失的那份 schema：工具层有 TypeBox，
  路由什么都没有，而 store 把枚举直接交给 SQL，拼错会变成约束冲突即 500；更糟的是 JSONB
  内部的枚举（如 `verify_rules[].kind`）没有任何约束兜底，`{kind:'flg'}` 能存下却在判分时
  永远不匹配——现在这是 400。`lib/server/curriculum/design-http.ts` 把管道集中一处：持久化
  闸门、owner fence、阶段拒绝 409（带 `details{current, required}`），以及可达数据库约束到
  400 的映射（保留约束名以便诊断）。

  审核的 GET 是**纯读**：会写库的 GET 会让每个预取和重试都成为一次变更，答案取决于谁最后
  问的。`evaluateCurriculumDesign` 从持久化包装中拆出，`describeCurriculumExportBlockers`
  与导出断言共用，两者无法漂移。

  三个被工作逼出来的修复：`setCurriculumNodeObjectives` 按 `objective_id` 单独去重，而表主键
  是 `(node_id, objective_id)`，导致「多个知识节点支撑同一个成果」被静默压成一个；章带教学
  角色、依赖 `strength` 超出 0..1 只由 CHECK 兜底，普通编写错误返回 500，角色规则现在由
  store 的 `assertUnitRoleShape` 表述；`verifiable` 的调用方推导残留被移除，改由
  `deriveVerifiability` 在 store 的 create 与 patch（按合并后字段）统一推导，工具与路由两处
  的推导删除。

  页面 `components/curriculum/design-heatmap.tsx` 与
  `components/curriculum/design-task-list.tsx` 落在 `/curriculum/design` 与
  `/curriculum/design/[id]`：行是学习目标、列是目，单元格标 `教` / `练` / `考`，标题下统计
  闭环数量，`gaps` 最坏优先（从未被考核的成果排在只缺第二次练习的成果之前）；质量条是实时
  计算，findings 列表是上次审核记录，两者不一致正是设计已变动的信号。

  验证：新增 `tests/curriculum/design-routes.test.ts`（36 项，PGlite 上跑真实 store，只替换
  provider 接线与 owner 解析）；提交信息记录 36 项路由测试通过，并说明无关套件中 42 项既有
  失败（缺 provider key）在改动前后逐字节相同。


- **设计条目自己决定生成什么**：新增
  `POST /api/curriculum/design/tasks/[id]/units/[unitId]/generate`，把一个已设计的条目生产成
  一次生成运行。此前装配器对所有课程硬编码 `sceneTypes: ['slide']`，于是练习条目和考试条目
  都只出幻灯片；`deck_design` 契约只活在渲染器里，`GenerationRunInput` 没有该字段、
  `parseRunInput` 把它丢掉，设计好的课程实际仍按散文生成。新增
  `lib/server/curriculum/unit-role-run.ts`：`UNIT_ROLE_SCENE_TYPES` 让 `unit_role` 决定场景类型
  （`lecture` → `slide`；`practice` → `slide`/`quiz`/`interactive`；`exam` → `slide`/`quiz`，任何
  角色都不给 `pbl`），`unitRoleRunModes` 从同一来源推导 `interactive` 与 `taskEngine`，避免两者
  漂移；`deckDesignForRole` 只把计划交给 `lecture`，空计划视为没有计划；`describeDesignedItem`
  用条目所服务的 outcome 行为拼出 requirement。`GenerationRunInput` 新增 `deckDesign`、
  `curriculumTaskId`、`curriculumUnitId`，由 `runRequirements` 原样带给大纲步骤；
  `parseRunInput` 按 `MAX_DECK_PAGES`（60）与每页 4000 字符校验，缺 `goal`/`coreInfo`/`mode`
  的页面逐字段点名。路由先跑导出闸门再启动运行，拒绝时不会留下已计费的孤儿运行；`stage_id`
  仍由 `lib/server/curriculum/generation-hooks.ts` 在运行提交场景时写入。

  验证：`tests/curriculum/unit-role-run.test.ts` 断言角色→场景类型、`interactive`/`taskEngine`
  的组合、`pbl` 对任何角色都不出现、计划只随 `lecture` 传递、requirement 由 outcome 行为拼成
  而非条目标题；`tests/generation/deck-design-plumbing.test.ts` 断言计划经 `parseRunInput` →
  `runRequirements` 贯通、无计划的即席运行逐字节不变、缺字段 / 超长 / 空计划被拒；
  `tests/curriculum/design-routes.test.ts` 覆盖新路由的 404/400 与 owner 隔离。


- **按设计生产与按知识点组装在同一个面板里分岔**：新增
  `lib/curriculum/production-path.ts` 的 `chooseProductionPath` 作为分岔点。任务进入 `outline`
  及以后（`outline`/`teaching`/`assessment`/`review`）就走设计路径：先跑导出闸门、由
  `unit_role` 决定允许的场景类型、requirement 由条目所服务的 outcome 行为构造。`outline`
  之前没有可执行的目标闭环，于是提供装配器并明确标注为设计之前的路径。
  `ProductionPathChoice.blockedReason` 保证每条不可用的路径都带一句「该做什么」，不留没有
  理由的灰按钮。同一次改动补上两个让工作台可达的入口：任务列表新增建任务表单（没有 brief
  的任务无法离开 `task` 阶段，所以此前没有任何东西可点），热力矩阵改为读
  `GET /api/curriculum/design/tasks/[id]/phase`，把具体缺口显示在推进按钮旁。改动文件：
  `components/curriculum/course-assembler-panel.tsx`、`design-heatmap.tsx`、
  `design-task-list.tsx`。

  验证：`tests/curriculum/production-path.test.ts` 6 例，逐阶段断言走哪条路径、只有章节时
  不算「有可生产内容」、以及每条被拒路径都给出理由。


- **条目顺序审核规则**：`curriculum_unit_dependency` 此前有写入口、有删入口、**没有读者**
  ——作者声明「B 在 A 之后」会被记录然后忽略；路由注释声称「the audit compares the two」，
  而这是假的，正因文档断言了它，没人看出这里缺东西。`lib/curriculum/audit.ts` 新增两条规则：
  `unit_dependency_out_of_order`（声明的先修被排在需要它的条目之后，落在 `dependency_valid`
  层，因此会挡住导出）与 `unit_dependency_cycle`（声明的顺序成环，没有第一个条目）。只有
  `prerequisite` 边被当作顺序声明（`UNIT_ORDERING_EDGES`），`related` 与 `follow-up` 是标注、
  不施加顺序；检查的是作者自己那条边，与比较目标图和交付顺序的 `dependency_out_of_order`
  是两条独立规则码。环检测 DFS 抽成 `findCycles`，与目标图共用。`rule_code` 是无约束 TEXT，
  不需要迁移。

  验证：`tests/curriculum/design-audit.test.ts` 新增 12 例（正向 5、负向 7），覆盖错误顺序、
  相邻的正确顺序、忽略 `related`/`follow-up`/章节/悬空 id、成环与不重复报环，并断言错误顺序
  会破坏 `dependency_valid`、干净设计仍可导出；提交信息记录双向变异测试（注销规则失败 4 例、
  反转比较失败 5 例）与活体 26/26。


- **设计工作台可编辑 UI**：设计页面此前只能读、审、推进，什么都输入不了，每一行都得由 agent
  工具或手写 POST 产生。新增 `components/curriculum/design-workbench.tsx`、
  `design-workbench-forms.tsx`、`design-task-shell.tsx` 与 `lib/curriculum/design-editing.ts`。
  `DESIGN_AUTHORING_GATES` 用一张表登记每种记录受哪个阶段闸门约束（`outcomes`/`evidence`/
  `nodes`/`node-objectives`/`dependencies`/`units`/`coverage`/`unit-dependencies`/`questions`/
  `lab-tasks`），`authoringAvailability` 给出「能不能建 + 先做哪个阶段」的句子。规则与 store
  一致：只有创建受阶段闸门限制，`update*`/`delete*` 永不设闸，所以 `review` 阶段仍能删掉写错的
  目标。覆盖关系统一走 PUT（`setCurriculumUnitCoverage`）整体保存，因为 store 在一个事务里
  替换全量，写一半会让矩阵显示不存在的闭环。外键一律从真实行里选（题目选目标与条目、节点
  勾选目标、依赖选图里的行），不是手填 id。活体走查修了两处单测与类型检查都放过的缺陷：
  编辑器的刷新只重读快照不重读阶段，导致从编辑器之外推进的任务永久锁死；以及条目建出来后
  无法录入教学设计，使 `objective_missing_prereq` 在界面上无法修复。

  验证：`tests/curriculum/design-editing.test.ts` 用真实 store 函数在每个阶段逐一核对表：
  断言表与 `assertPhase` 一致、闸门是「到达或已过」（`review` 仍可修正）、被关闭的种类说出
  要到达的阶段、以及 coverage 的 PUT 有闸门而 POST 孪生没有；提交信息记录活体 28/28 与
  curriculum 套件 181 例通过。


- **实操任务可在工作台录入**：工作台能建其他所有评价记录，唯独没有实操任务的表单，于是
  「有实验证据却没有产物」这条 finding 在浏览器里无法清除。新增
  `lib/curriculum/lab-authoring.ts`，把两处「错了也不报错」的规则做成带测试的纯函数：
  `labVerifyFieldFor` / `labVerifyRuleFrom` 让验证规则只写进它的 kind 真正读取的字段
  （`file_read`/`file_write` → `path`，`env_state` → `key`，`process_exec` → `argv`，
  `flag`/`http_request` → `value`，`custom` → `expression`），表单只问一个目标而不是给七个
  字段的选择器；`examStrictGaps` / `examStrictRefusal` 把表约束 `curriculum_lab_exam_strict`
  的三项要求（`hintPolicy: 'forbidden'`、`allowRetry: false`、非空 `timeLimitSec`）说成 store
  自己的话，`createCurriculumLabTask` 与 `updateCurriculumLabTask` 按合并后的行检查，
  `EXAM_FORCED_VALUES` 给出表单选择 exam 时应提交的值。数据库约束仍是兜底，测试直接绕过
  store 写一行以确认它还在。活体走查还修了 shell 的共享刷新不重读编辑器快照的问题——在编辑器
  之外新建的单元或目标对需要选中它的表单一律不可见。

  验证：`tests/curriculum/lab-authoring.test.ts` 逐 kind 钉死字段映射、空目标返回 `null` 而不落
  一条什么都不验的规则、`note` 不作为条件、条件写进错字段后读回为空、practice 不受 exam 规则
  约束、exam 一次列出三项缺口、store 与数据库都拒绝「温室考试」；提交信息记录 24 例新增单测
  （三方向变异核对）与活体 36/36。


### Changed
- **将已配置的 Qwen TTS 从工作区设置持久化到部署层**：设置里的 TTS provider/slot 原本只写在 `workspace_model_config`（owner `anon:704cd355…`），服务端生成课程时看不到。现已把 provider `qwen-tts`、slot `tts: qwen-tts:qwen3-tts-instruct-flash` 写入本机 `openmaic.yml`，密钥引用 `.env.local` 新增的 `QWEN_TTS_API_KEY`；配置层解析已验证为 `status=assigned`。重启服务后生效。


- **导出改走分块并行渲染**：两份 Compose 栈（`docker-compose.yml` 生产、
  `docker-compose.db.yml` 本地开发）默认开启 `RENDER_CHUNK_EXECUTION=true`、
  `RENDER_CHUNK_COUNT=4`、`RENDER_MAX_PARALLEL_CHUNKS=4`，容器内存上限
  `8g` → `16g`。长视频导出的抓帧阶段由单进程串行改为 4 块并行。

  **加速来自进程级分块，而非 chunk 内多 worker**：`maxChunkWorkers` 被
  standard profile 硬钉为 1（写大于 1 会让[配置加载直接抛错]），每块由
  `fork` 出独立进程跑完整 producer 流程，因此并行度上限就是 profile 允许的
  4 块。每块独立拉起 Chromium，冷启动开销不参与并行、照付 4 份——工程越长，
  这部分占比越小。

  **实测（同机、同工程，串行对照容器 vs 4 块并行）**：6.4s/192 帧 26.5s → 22.1s
  （1.20×）；40s/1200 帧 114.0s → 80.6s（1.41×）。此前 536s 的实测基线按此比例
  约降至 380s 量级，不是 4 倍：4 块严格串行等长（`mapBounded` 一次派发 4 块，
  跑完再派下一批），慢的那块决定整体时长，加速天然低于块数。

  **正确性**：两份产物 ffprobe 均为 `h264 1920x1080 / 1200 帧 / 40.0s`，帧数零
  丢失；逐帧 SSIM 0.976，额外做 ±3 帧偏移探测，SSIM 峰值精确落在 offset 0，
  证明差异只是编码码率噪声（并行版 46.7MB、串行版 35.8MB）而非丢帧或错位；
  带音轨工程导出后 `aac /2ch / 12.0s` 正常 mux 进 MP4。

  **内存代价**：4 块并行时容器同时存活 4 个 Chromium+FFmpeg 渲染进程，因此
  内存上限必须显著高于 8 GiB 的 profile 下限（该下限是 `minimumMemoryBytes`
  门槛，不是容器上限本身）。内存吃紧时把 `RENDER_MAX_PARALLEL_CHUNKS` 降到 2
  即可回退，无需改动代码。

  **验证**：`docker compose config` 两份文件均通过；render-service 的
  `container-config` / `resource-profile` / `config` 共 24 例全绿——其中
  `container-config` 断言了 `mem_limit` 默认值，本次随改动更新，并新增一例覆盖
  两份 Compose 的分块默认值（此前只有生产栈被断言覆盖）。

- **课程工作台由长滚动改为六页签 + 进度**：把上一提交引入的吸顶锚点导航换成
  `Tabs`（`@/components/ui/tabs`），六个步骤各自成为 `TabsContent`（保留
  `id="curriculum-*"`），用 `activeTab` 与 `tabContentClass` 控制显隐；顶部新增
  「课程体系建设进度」卡片，`workflow` memo 按当前系列统计课程数、知识点与绑定数、
  培养方案版本 / 计划课程、已生成课堂、批次完成项、已导出视频，算出 `completedSteps` /
  `percent`，用 `Progress`（`@/components/ui/progress`）展示，已完成页签标 `CheckCircle2`
  并显示各自 meta。为支撑统计新增 `visibleCourseIds` 与 `scopedCourseKnowledgePoints` /
  `scopedKnowledgePoints` / `scopedGenerationJobs` / `scopedBatchItems` / `scopedBatches` /
  `scopedExportJobs` 一组按系列收敛的 memo。

  验证：`components/ui/tabs.tsx`、`components/ui/progress.tsx` 都是本仓库既有组件
  （对两者执行 `git log --diff-filter=A` 只返回仓库初始提交），本提交没有新增依赖或
  基础组件；`tests/` 不覆盖该工作台组件，故没有断言进度计算的测试。


- **课程序列成为课程体系主入口，工作台按系列收敛**：主页两处入口由 `/curriculum` 改指
  `/curriculum/series`，文案改为「课程序列 / 进入课程序列」；新增
  `app/curriculum/series/[id]/page.tsx` 渲染 `<CurriculumWorkspace seriesId={id} />`。
  `CurriculumWorkspace` 因此接受可选 `seriesId`：`isSeriesScoped` 为真时把
  `selectedSeriesId` 钉在该系列、`handleSeriesChange` 直接返回、不再渲染「课程系列」
  新建卡与「系列列表」，左栏换成只读的「当前系列」卡（描述、课程数、「切换 / 管理系列」、
  「查看全部课程」）；加载完成（`loaded`）后系列不存在则整页换成「没有找到这个课程序列」
  卡片。`series-workspace.tsx` 的「进入系列」由 `/curriculum?tab=ledger&series=<id>` 改为
  `/curriculum/series/<id>`，其返回按钮改指首页、原「课程体系」按钮改标「全部课程」；
  课程详情页的返回目标也改为所属系列（`backHref` / `backLabel`），删除课程后回到该系列。

  验证：`app/curriculum/series/[id]/page.tsx`、`series-workspace.tsx:469`
  （`href={`/curriculum/series/${series.id}`}`）、`app/page.tsx` 两处 `/curriculum/series`、
  `course-workspace.tsx:282-285` 的 `backHref` / `backLabel` 均可在当前源码核对；无自动化
  测试。


- **序列工作台只呈现本序列的数据**：上一提交只把页面钉在某个系列，面板仍收到全量
  `snapshot`；本次让可见集合成为唯一输入：新增 `visibleRelations`（两端都在可见课程内的
  关系）与 `scopedStages`（本序列课程关联的 stage，加上生成任务与导出任务涉及的 stage），
  `KnowledgePointsPanel`、`KnowledgeRelationsPanel`、`CourseAssemblerPanel`、
  `BatchQueuePanel`、`BatchExportPanel` 一律改用 `visibleCourses` / `scopedKnowledgePoints` /
  `scopedCourseKnowledgePoints` / `scopedGenerationJobs` / `scopedBatchItems` /
  `scopedExportJobs`，关系编辑的两个下拉也由 `snapshot.courses` 改为 `visibleCourses`。
  `ProgramPlanPanel` 新增 `seriesId` prop，内部派生 `scopedCourses` / `scopedKnowledgePoints`
  供计划课程与导出预览使用。左栏卡片改为「本序列进度」，列出课程 / 知识点 / 已生成课堂 /
  已导出视频四项计数；序列内去掉「全部系列」按钮与「当前系列」过滤条（仅在非 scoped 模式
  保留），「已有 stage」改为「本序列的课堂」并补空状态文案。

  验证：`curriculum-workspace.tsx:359`（`visibleRelations`）、`:376`（`scopedStages`）、
  `:753`（本序列进度）与 `program-plan-panel.tsx:37,100,138-161` 的 `seriesId` /
  `scopedCourses` / `scopedKnowledgePoints` 均可在当前源码核对；无自动化测试。


- **API 面向人的消息改为中文，面向调用方的标识符不变**：课程面上每条消息都会在工作台里
  原样渲染，英文拒绝是老师得到的唯一解释。本轮把审核规则、两个 store、两个验证器、路由层、
  program 导入导出与导出闸门共 **511 行**文案改成中文。机器读的那半保持原样：`error.code`、
  `rule` 码、`details` 键、阶段名、枚举值与 JSON payload 字段名。新增守卫测试
  `tests/curriculum/human-facing-messages.test.ts`，按位置形状（`message:`、`.push('...')`、
  `throw new ...Error('...')`、`curriculumJsonError(...)`）在源码里找人话，文件按
  `lib/curriculum`、`lib/server/curriculum`、`app/api/curriculum` 三个目录递归发现，任何
  读起来像英文散文的字面量都会失败，同时放行机器 token 与
  `lib/server/curriculum/unit-role-run.ts` 里给生成模型的提示词（单独列在 `PROMPT_MODULES`，
  因为那里的英文是内容生成输入而不是 UI 文案）。同时把质量层标签抽到
  `lib/curriculum/quality-labels.ts`（`CURRICULUM_QUALITY_LAYER_LABELS` 用 `satisfies` 保证
  新增层不写标签即类型错误），导出闸门原先打印原始标识符 `outcomes_verifiable`，现在打印
  「目标可验证」。

  验证：守卫测试断言扫描模块数 ≥30、位置字面量 ≥150、英文散文列表为空、
  `CURRICULUM_AUDIT_RULES` 仍是 `^[a-z_]+$`、每个质量层都有中文标签且键集合与
  `CURRICULUM_QUALITY_LAYERS` 完全一致；提交信息记录活体 24/24（真实 HTTP 的
  400/404/409/gaps/blockers 两半）与 `tsc`/`eslint`/`prettier` 干净。另有一个独立的
  「只改文本」核验脚本 `scripts/verification/prose-only-check.mjs`：把注释、字符串、正则
  剥掉后比对骨架，55 个文件中 52 个逐字节相同，3 个例外逐条写明。


- **活体校验脚本纳入版本库，产物不入库**：`scripts/verification/` 下 10 个脚本与 `README.md`
  进入版本库：`design-api-walk.py`、`design-workbench-walk.mjs`、`item-order-walk.py`、
  `lab-task-walk.mjs`、`message-language-walk.mjs`、`prose-only-check.mjs`、
  `s5-production-walk.py`、`ux-course-walk.mjs`、`ux-design-walk.mjs`、`ux-probe-gate.mjs`。
  README 逐个说明每个脚本回答什么问题、都需要运行中的 dev server、都不在 CI 里跑，并记录
  退出码约定：6 个（`design-api-walk.py`、`design-workbench-walk.mjs`、`item-order-walk.py`、
  `lab-task-walk.mjs`、`message-language-walk.mjs`、`prose-only-check.mjs`）会让自己的运行
  失败退出非零，4 个只报告并退出 0。`.gitignore` 新增 `/artifacts/`（截图、console 日志与
  完整 runner 输出，可由重跑再生），以及 3 个被后续走查或测试取代的一次性脚本，取代关系
  写在规则旁。脚本入库前实跑，修掉四个**都在检查自身**的缺陷：`design-api-walk.py` 断言了
  一条已被中文化改动改掉的 `audience` 列文案，却只打印 FAIL、退出 0（因此整整一个提交都在
  断言假的东西）；`item-order-walk.py` 仍引用两条英文 finding；`ux-probe-gate.mjs` 把
  `sourceId`/`targetId` 发给读 `sourceKnowledgePointId`/`targetKnowledgePointId` 的路由，从未
  走到它要测的自环规则；`prose-only-check.mjs` 硬编码了写下它那一轮的允许清单，改成
  `path=reason` 参数。

  验证：`scripts/verification/README.md` 逐个列出脚本、问题与退出码；`.gitignore` 中
  `/artifacts/` 与三个一次性脚本的忽略规则可见；`ux-probe-gate.mjs` 现在确实发送
  `sourceKnowledgePointId`/`targetKnowledgePointId`（`git show 7775833b --
  scripts/verification/ux-probe-gate.mjs`），`item-order-walk.py` 的中文 finding 与
  `tests/curriculum/design-audit.test.ts` 钉的短语一致（README 明写）。10 个脚本入库前逐个
  实跑，全部通过。

### Fixed

- **删除课程时学习者 runtime 的级联并入同一条删除事务**：此前浏览器端 `deleteStageData`
  在文档删除后单独调 `beginStageRuntimeDeletionSafely(stageId)` 级联清理学习者运行数据，
  而 runtime 的 HTTP 契约里 `DELETE /runtime/stages/:id` 是需要 `authorizeAdmin` 的管理员
  能力（本应用不授予任何人），所以这条客户端级联实际只会被 `403 FORBIDDEN_ADMIN` 拒绝，
  并在每次删课时留下警告；它还会为等这次级联而保留排他锁。现在级联放在服务端：
  `OwnerBoundDocumentStore.deleteDocument()` 在已对 `stage_meta` 行 `FOR UPDATE` 并确认
  owner 之后，用同一事务里的 `pinnedRuntimeStore` 调 `deleteStageRuntime(stageId)`，因此
  文档墓碑、资产回收与 runtime 清理在同一次提交里生效，任何一半回滚都不会留下「课程已删、
  资产 / runtime 仍在」的中间态。新增的接线是 `OwnerBoundDocumentStoreOptions.runtimeStoreIn`
  （`lib/persistence/owner-bound-document-store.ts`）与
  `ServerPersistenceProvider.runtimeStoreIn(queryable)`（`lib/persistence/server-provider.ts`，
  把 `PgRuntimeStore` 钉在传入的 `Queryable` 上、不挂 create hook），并由
  `app/api/persistence/[...path]/route.ts` 与 `lib/server/agent-runtime/owner-scoped-documents.ts`
  （请求侧与后台运行侧）透传。级联是 learner-agnostic 的（runtime 行只带 stageId），语义上
  正是「课程退役后不对任何学习者保留运行数据」，且只在服务端锁内可达，不会退化成跨 owner
  删除。`lib/utils/stage-storage.ts` 的 `performStageDeletion` 删除该客户端级联及为它保留的
  锁，仅留注释说明原因。

  验证：`tests/persistence/owner-runtime-assets.test.ts` 在 PGlite 内存库上跑真实 persistence
  路由——既有用例「reads as absent and refuses writes once the course is tombstoned」改为在
  `DELETE /documents/<stageId>` 后直接查库断言按 `stage_id` 的 `runtime_sessions` 与按
  `session_id` 的 `runtime_records` 均为空；新增用例「reclaims a deleted course's runtime for
  every learner, not just the deleter」让 alice / bob 各建一条 session，alice 删课后断言该
  stage 的 `runtime_sessions` 一行不剩（同文件另有既有用例改为直接 `UPDATE stage_meta SET
  deleted_at` 造墓碑，以保留「隐藏但仍在」的场景）。`tests/runtime/stage-delete-wiring.test.ts`
  移除了 `beginStageRuntimeDeletionSafely` 的 mock 与调用断言，保留
  `withRuntimeStorageExclusiveLockUntilSettled` 一次、`deleteDocument('stage-7')`、
  `clearCurrentScene`、`clearAllForScene` 的断言；`tests/playback/stage-delete.test.ts`、
  `tests/utils/stage-storage-deletion.test.ts` 同样移除该 mock。除
  `lib/persistence/runtime-tombstone-guard.ts` 的透传包装外，当前唯一调用 `deleteStageRuntime`
  的删除路径是 `lib/persistence/owner-bound-document-store.ts:475`；`deleteStageRuntimeSafely`
  仍作为导出保留（`tests/lib/whiteboard/runtime-store.test.ts` 等仍在用）。


- **工作流页签被基础样式压住、文字显示不全**：页签排版被 `components/ui/tabs.tsx` 的基础类
  顶住——`TabsList` 带 `group-data-horizontal/tabs:h-9`，`TabsTrigger` 带
  `h-[calc(100%-1px)]` 与 `whitespace-nowrap`，后写的普通 `h-auto` / `whitespace-normal` 在
  生成后的优先级里压不过它们，于是页签高度被锁在 36px 上下、第二行 meta 易被截、窗口一窄
  六列挤在一行。现在改用重要修饰符逐条覆盖（`grid! h-auto! min-h-0 w-full! justify-stretch!
  overflow-visible bg-transparent! p-0!`、`h-auto! min-h-20 min-w-0 flex-col items-start!
  justify-start! whitespace-normal!`），列数改为 `grid-cols-1 sm:grid-cols-2 xl:grid-cols-3
  2xl:grid-cols-6`，每个页签补上步骤序号徽章，meta 字号由 `text-[10px]` 提到 `text-xs`；
  `course-workspace.tsx` 的五个页签沿用同一套覆盖（`2xl:grid-cols-5`）。

  验证：`components/ui/tabs.tsx` 中基础类确为 `group-data-horizontal/tabs:h-9`、
  `h-[calc(100%-1px)]`、`whitespace-nowrap`；`curriculum-workspace.tsx:710-718` 与
  `course-workspace.tsx:595-603` 中即是上述覆盖类。仓库内没有针对页签布局宽度的自动化测试，
  布局结论无法用测试断言复核。


- **统一阶段拒绝形状，并让教学顺序可以撤回**：S4 路由的活体走查发现两处缺陷。

  其一，阶段机把「还没做完」与「还没到这一步」拒绝成了两种形状：写入超前阶段抛
  `CurriculumPhaseError` → 409 带 `details{current, required}`，而边界未满足时推进抛
  `CurriculumDesignValidationError` → 400 只带目标阶段。两者是同一种拒绝，`design-http.ts`
  的文档注释本来就把它们描述成一种。现在 `advanceCurriculumTaskPhase` 也抛
  `CurriculumPhaseError`，客户端处理一种即可；`design-tools` 的 `guarded` 本就按错误类型
  分支，因此会提示模型先完成当前阶段，而不再报成「请求格式错误」。测试从断言 400 改为断言
  错误类型、阶段对，以及消息仍然点名具体缺口。

  其二，`curriculum_unit_dependency` 能写不能撤：POST 是对 `(source, target, edge_type)` 的
  upsert，可以重述一条顺序主张却无法移除，而边是独立行而非字段，大纲阶段记错的教学顺序在
  此前只能删掉整个任务、连带丢掉设计。新增 `deleteCurriculumUnitDependency` 与
  `DELETE /api/curriculum/design/tasks/[id]/unit-dependencies/[unitDependencyId]`，与既有 5 条
  DELETE 路由一致：owner 限定，非本人 id 返回 404。

  需要说明这条修复「不是」什么：此时没有任何东西读取 `unitDependencies`。审核的
  `dependency_out_of_order` 从 `unit.order_index` 加 `teach` 覆盖推导交付顺序，再与**目标**
  依赖图比较，从不与这张表比较；因此边是记录性元数据，删除它不改变任何报告或闸门。也正因
  如此没有新增 agent 工具——现有设计工具都是写入，没有删除；是否要让该主张真正生效是另一个
  决定。这一点写在 store 的文档注释里，而不是留给下一个读者自己发现。（`5a9bda14` 之后这张
  表才真正有了读者，见上方「条目顺序审核规则」。）

  顺带记录了为什么 `assessment` 边界重复 `teaching` 的判定：不是复制粘贴。任务停在
  `teaching` 阶段时仍可继续编写成果，而那类成果还没有被任何目教过；在这里重新检查，才能
  阻止在没有教学支撑的成果之上开始出题。

  验证：`tests/persistence/curriculum-design-store.pg.test.ts` 新增 2 项真实 PostgreSQL 断言
  （`refuses an incomplete boundary with the phase pair, and does not move the task`、
  `withdraws a teaching order, upserts it, and fences it by owner`）；
  `tests/curriculum/design-routes.test.ts` 增至 38 项（新增「以 409 加两个阶段拒绝推进，而不是
  当作格式错误」与「记录并可撤回教学顺序」），`tests/persistence/curriculum-design-store.test.ts`
  为 25 项；提交信息记录 65 项测试通过（25 项 store PGlite + 38 项路由 + 2 项真实 PostgreSQL），
  `tests/curriculum`、`tests/agent-runtime`、`tests/generation` 零新增失败（前后同为按名相同的
  37 项 provider key 失败），tsc / eslint / prettier 干净。


- **被拒绝的运行启动按拒绝上报，不再是 500**：S5 的生产路由在设计的通用 catch 里调用
  `startGenerationRun`，而该 catch 只映射设计 store 的错误类型，于是启动器能抛的每一种拒绝
  （owner 的活跃运行上限、素材缺失、未知 agent、部署不可用的 workspace 端点）都变成 500
  `CURRICULUM_DESIGN_FAILED`。上限那条在正常使用中就会踩到：一门课有多个条目、每次生成启
  一个运行，生产整门课走到第三个条目就撞上 `maxActiveRunsPerOwner`（默认 2）——那是普通的
  临时状态，报成 500 会被读成服务器坏了，而正文里也没有「稍后再试」。改动后该路由复用
  `POST /api/generation-runs` 的 `startRefusal` 映射：上限类返回 429 并在消息里点名数字，其余
  映射为对应的 400；导出闸门仍先跑，未映射的错误仍然 500。

  验证：`tests/curriculum/design-routes.test.ts` 新增两例——mock 启动器抛真实的
  `ActiveRunLimitError(2)`，断言 429、`code` 为 `ACTIVE_RUN_LIMIT`（不是
  `CURRICULUM_DESIGN_FAILED`）且消息含 `2`；抛 `ClassroomMaterialsRejectedError` 断言 400
  `INVALID_REQUEST`。


- **课程流程从「能写入」改为「能操作」**：以人的身份在浏览器里走完一个系列、一门课、六个
  步骤各一条，发现四处记录了工作却无法操作的地方，以及一个承诺背后的真 bug。
  `parseCourseAssemblyInput` 拒绝 `hours: null`，而它自己返回的消息说 null 可接受——表单留空
  时发的正是这个值，占位文字写着「留空按知识点数量估算」，于是文档化的留空路径是 400。现在
  `null` 表示「未给出」、由装配器估算（`buildCourseAssembly` 对缺失键本来就这么做），零与负数
  仍被拒。「创建并开始设计」不再只把任务插进下方列表：创建后直接进入该设计
  （`useRouter().push('/curriculum/design/<id>')`），任务仍停在 `task` 阶段。阶段推进控件原来
  在矩阵页头，与表单所在的编辑器分处两个标签页，现在阶段状态与按钮上移到
  `components/curriculum/design-task-shell.tsx`、位于两个标签之上，矩阵里自己那份控件删除
  （`design-heatmap.tsx` 里的 `PhasePayload` 与 `/phase` 请求一并移除），只剩一个控件、一处
  读取。两处拒绝改为说出理由：知识点在两端选中同一个点时，按钮为什么关闭现在由
  `knowledge-relations-panel.tsx` 的 `relationRefusal` 点名那个知识点；
  `lib/curriculum/design-coverage.ts` 的 `summariseCoverage` 句子（矩阵页头第一行，也是导出
  闸门的 blocker）在中文界面里是英文，它是唯一解释为什么不能生产的一行，现在在产生它的地方
  措辞，两个界面因此一致。

  验证：提交信息记录六标签浏览器走查端到端无 console 错误、设计走查创建并授权一个设计、
  S5 工作台走查 28/28、探针在页面上显示同点句、curriculum 套件 207 例通过、宽回归失败集合
  与 stash 基线一致；`tests/curriculum/assembly.test.ts` 新增两例断言 `hours: null` 被接受且
  `value.hours` 为 `undefined`、`0` 与负数仍被拒并各自返回原消息。


- **未配置持久化的 404 也改为中文**：没有 `DATABASE_URL` 时每个课程路由在碰到 store 之前返回
  纯文本 404，那段正文是人能得到的全部解释，也是 API 里最后剩下的英文串：**35 个文件共
  43 处**（42 处内联守卫加 `lib/server/curriculum/design-http.ts` 的 `runDesignRoute` 里共享的
  一处），现在都返回 `未找到`。守卫测试新增 `new Response('<body>')` 这一位置形状，并改为按
  形状分别断言而不是只断言总数——某个标记悄悄失配后策略「什么都没检查」也算通过，正是要防
  的那种失败。

  验证：`tests/curriculum/persistence-gate-messages.test.ts` 走 `app/api/curriculum` 目录发现
  路由、删掉 `DATABASE_URL`（即 `isServerPersistenceConfigured()` 读的那个变量）后调用全部
  HTTP handler（61 个 route.ts / 80 个导出 handler），断言每个都返回 404 且正文为 `未找到`；
  `tests/curriculum/human-facing-messages.test.ts` 断言五种位置形状都被识别。提交信息记录
  两半都做了变异测试（还原单个站点会让测试点名文件与行号）。

### `1.2.0-video.5` 的验证状态

**通过**（本机，本次发布提交之前）：

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit` | exit 0 |
| `npx eslint .` | **0 error**，20 个 warning（均为既有编码风格告警；本次新增的一处未使用导入已修掉） |
| `npx prettier --check`（本次改动文件） | All matched files use Prettier code style |
| `node scripts/check-i18n-keys.mjs` | 12 语包通过 |
| `node scripts/check-node-engine-contract.mjs` | 通过 |
| `node scripts/check-package-version-bumps.mjs v1.2.0-video.4` | 通过（六个 `@openmaic/*` 版本由上游同步 bump） |
| `vitest run tests/curriculum` | **45 文件 766 例全绿** |
| `vitest run tests/persistence/{curriculum-outline-schema,curriculum-design-store,schema-migration-checksums}` | **3 文件 49 例全绿**（真 PostgreSQL） |

合计 **48 文件 815 例**。覆盖面：系列大纲（导入解析 12 例、看板叠加 6 例、大纲路由
契约 13 例）、migration 15 的数据库约束（8 例：章在顶层 / 节必须挂章 / 编号唯一 /
删节不删目）、`next-item` 的大纲排序（2 例）、七步条与步骤引用
（`step-labels.test.ts`：序号与阶段机同序、七键、名字唯一 + 源码扫描三种旧形状为 0），
以及 B1–B4 原有的驾驶舱、五步骨架、生成与导出的用例。

**未做 / 未跑**（逐条说明，避免与上面那份「全绿」读成同一件事）：

- **migration 15 是手工应用到真实库的**：运行中的 dev server 启动时已把 schema 缓存
  成「就绪」，不会再跑新迁移，所以按 `applySchemaMigrations` 的同一套算法算出 checksum
  并写入 `openmaic_schema_migrations`，与源码当前内容一致——重启 dev server 不会报
  checksum 不匹配。`schema-migration-checksums.test.ts` 的 pin 同版补上（该测试此前
  一直红着，因为它在 `tests/curriculum` 之外，从来不在发布前跑的那条命令里）。
- **未跑全量 `vitest`**：本仓库全量存在既有环境性失败（缺 `DEEPSEEK_API_KEY`、
  需浏览器上下文、5 秒超时）。
- **未做浏览器端点击验证**：本机没有 chromium，Playwright 无法启动；e2e 选择器与
  `curriculum-step-copilot.spec.ts` 已按新看板更新，但**没有执行**。界面上的实际点击
  效果未经人眼确认。
- **未跑 `scripts/verification/` 下的活体脚本**：本版新增的 `ux-step-labels.mjs`、
  `ux-produce-{walk,reconcile,export}.mjs` 只做过 lint 与语法检查。
- **未跑 `pnpm build`**，未跑真实课程生成与 MP4 渲染。视频链路本版**没有改动**
  （渲染服务与 TTS 是既有能力），本版也没有验证一次端到端导出。

### `1.2.0-video.4` 的验证状态

**通过**（本机，本次发布提交之前）：

| 命令 | 结果 |
| --- | --- |
| `tsc --noEmit --pretty false` | exit 0 |
| `pnpm exec eslint .` | **0 error**，18 个既有 warning（与上一版同数，非本次引入） |
| `prettier --check`（改动文件） | All matched files use Prettier code style |
| `pnpm check:i18n-keys` | 12 语包通过 |
| `pnpm check:node-engine` | 通过 |
| `vitest run tests/curriculum` + 设计存储 / migration 校验 / `design-tools` | **36 文件 696 例全绿** |

上表那 696 例的覆盖面：`tests/curriculum`（33 个文件，含本版新增的
`design-outcomes` / `design-knowledge` / `design-outline` / `design-teaching` /
`design-assessment` / `design-review` 及各自的 route 套件）、真 PostgreSQL 契约套件
`curriculum-design-schema.pg.test.ts`、`schema-migration-checksums.test.ts`、
`curriculum-design-store.test.ts`，以及 `tests/agent-runtime/design-tools.test.ts`
（本版修复了它自 S9 起一直红的两个 lab 用例，现已能从工具侧走到 `review`）。

**本版未改动 `packages/@openmaic/`**：`git diff --name-only v1.2.0-video.3..HEAD -- packages/`
为空，因此不发 `npm` 包、不提 `@openmaic/*` 版本号、不触发 `publish-packages.yml`。

**未做 / 未跑**（逐条说明，避免与上面那份「全绿」读成同一件事）：

- **未跑全量 `vitest`**：本仓库全量存在既有失败（缺 `DEEPSEEK_API_KEY`、需浏览器上下文、
  5 秒超时）。上一版做过「与同环境 stash 基线按失败集合逐条比对」的全量差集核对，
  **本次发布没有重跑这项**，所以本版**没有**「真实引入失败为 0」这一结论。
- **未跑活体校验脚本**：`scripts/verification/` 下 13 个脚本（含本版多次使用的
  `design-api-walk.py`，其步骤四证据在 `artifacts/regression/design-walk-step4.txt`
  达到 168/168）**未在本次发布时重跑**。条目里引用的各次 walk 结果来自对应提交时点。
- **未做浏览器端驱动验证**：Playwright 期望的 chromium 版本本机不具备（与前几版同一原因）。
- **未跑 `pnpm build`**、未发 `npm` 包、未跑整门课的真实生成与 MP4 渲染
  （视频链路本版一行未动）。

### `1.2.0-video.3` 的验证状态

**通过**（本机，本次发布提交之前）：`tsc --noEmit`（exit 0）、`eslint`（**0 error**，
18 个既有 warning）、`prettier --check`（改动文件，含 `CHANGELOG.fork.md` / `AGENT.md` /
本设计文档）、`pnpm check:i18n-keys`（12 语包）、`pnpm check:node-engine`、
`node scripts/check-package-version-bumps.mjs v1.2.0-video.2`、`pnpm build`（exit 0）。

**本版未改动 `packages/@openmaic/`**：`git diff --name-only v1.2.0-video.2..HEAD -- packages/`
为空，因此不发 `npm` 包、不提 `@openmaic/*` 版本号、不触发 `publish-packages.yml`。
这与 `1.2.0-video.2` 恰好相反（那一版改了 `@openmaic/generation`）。

**单元测试**（本版主体）：`tests/curriculum/` **16 个文件、213 例全绿**；S1–S3 另有
`tests/persistence/curriculum-design-*.test.ts`（PGlite 与真实 PostgreSQL 两套）、
`tests/agent-runtime/design-tools.test.ts`、`design-skills.test.ts`、
`tests/generation/deck-design-contract.test.ts`。

**活体校验**（10 个脚本，均需运行中的 dev server；本版起纳入版本库）：

| 脚本 | 结果 |
| --- | --- |
| `message-language-walk.mjs` | 24 passed / 0 failed |
| `design-api-walk.py` | TOTAL 88 · PASS 88 · FAIL 0 |
| `item-order-walk.py` | 26/26 |
| `design-workbench-walk.mjs` | 28 passed / 0 failed |
| `lab-task-walk.mjs` | 36 passed / 0 failed |
| `s5-production-walk.py` | TOTAL 33 · PASS 33 · FAIL 0 |
| `ux-course-walk.mjs` | 26 步全 ok |
| `ux-design-walk.mjs` | 8 步全 ok |
| `ux-probe-gate.mjs` | 4 情形（含绕过界面直接 POST 自环 → 400） |
| `prose-only-check.mjs` | 本次改动不含 `.ts`，报告 0 个文件（见下方说明） |

全部 **0 console 错误、0 FAIL**，10 个脚本退出码全为 0。`ux-probe-gate.mjs` 的关键一行：
两端选同一个知识点时按钮禁用，页面上给出「关系的两端现在都是「KP-01 · SQL 注入原理」…
先修、后继、包含、相关都描述两个知识点之间的关系，请把其中一端换成另一个知识点。」；
绕过界面直接 `POST` 自环得到 400 `CURRICULUM_INVALID` /「知识点不能与自身建立关系」。

> `prose-only-check.mjs` 比对的是**工作区相对 `HEAD` 的 `.ts/.tsx` 改动**，而本次发布提交
> 只改了文档、版本号与一个校验脚本，所以它这次什么也没检查到。它的实际战绩在
> `2673ef3e`（中文化）那次：55 个文件里 52 个骨架逐字节相同，3 个例外逐条声明。

**全量 `pnpm test` 的读法**：本机 `openmaic.yml` 仍缺 provider key，全量本身就是红的，
所以沿用**同环境基线对比**（`git stash` 后在改动前的 HEAD 上跑同一套，比对失败**集合**
而不是失败**数量**）：

| | 测试数 | 失败数 |
| --- | --- | --- |
| 基线 | 10894 | 324 |
| 本版 | 10895 | 325 |

关键在于差集：唯一「只在一边失败」的是 `round-trip/insert` 的远程图片用例（该用例注释
明写依赖网络），**单独跑 3/3 通过**，属并行负载下的抖动。**本版真实引入的失败为 0。**
（这次基线对比在本版开发期间完成；本次发布提交只动文档、版本号与一个校验脚本，不影响它。）

**未做**：E2E（`pnpm test:e2e`，需另起 3002 端口整套环境）；没有跑耗模型额度的整门课
真实生成与 MP4 渲染（按验收时点击触发）。

## [1.2.0-video.2] - 2026-10-06

基线是上游 `ccdc88a5`（`v1.2.0-video.1` 发布后以 merge 合入的 3 个提交，
见本节「同步上游」）。本节收录自 `v1.2.0-video.1` 以来的 4 个二开提交：
3 个 TTS 指令控制（新增）、1 个音频修复、1 个构建告警修复，并含一次上游同步。

**版本号说明**：沿用 `1.2.0-video.N` 版本线，本次递增到 `1.2.0-video.2`。

### Added

- **指令控制内容可自定义**：开关下方新增一个文本框，写什么就发什么
  （`qwenTtsInstructText`）。留空表示沿用内置指令，因此从未碰过这个框的课程
  发声与之前完全一致。文本框只在开关打开时出现——一条不会被发送的指令只是
  一张便签，用户会在以为它生效的情况下反复修改。

  **请求上传递的是指令文本本身，而不再是一个布尔标记**：此前 providerOptions
  只带 `qwenInstructionControl: true`，真正的指令硬编码在
  `tts-providers.ts`。标记与文本分两处时，「开没开」和「说什么」可能各说各话；
  现在文本的存在即开关的生效，二者无法再漂移。

  **指令随运行一起走**（`qwenInstructText`）：服务端读不到浏览器的 settings，
  因此文本作为启动请求体的一部分下发。服务端按同一个上限
  （`QWEN_INSTRUCT_MAX_CHARS = 1200`）校验，避免一个超长 body 被带进本次运行的
  每一次合成请求。厂商的官方上限是 1600 **token** 而非字符，本仓库按字符截断：
  中文约一字一 token，英文一个 token 能装下好几个字符，按字符设限偏保守，
  足以挡住整篇粘贴的作文，又不会让中文用户先撞到真实上限。

  **帮助卡片改为显示真正会发的那条**：用户写了就显示用户的，不支持该参数的
  模型则明说「当前模型不会发送任何指令」——卡片不该承诺一个请求不会带来的
  听感。写了自定义指令时另附内置默认值，避免文本框变成死路。

  **验证**：`tests/audio` + `tests/settings` 489 passed（指令控制相关 59 例，
  新增 15 例：默认/自定义/纯空白/超长截断/模型不支持各一条，以及文本框的出现
  时机、长度告警与帮助卡片的动态内容）；`tsc`、`eslint`、`check:i18n-keys`
  通过。`tests/audio/tts-invalid-response.test.ts`（2 例）仍为**改动前既有失败**，
  已用 `git stash` 对照确认。

- **指令控制的问号帮助**：在「启用指令控制」右侧加了一个问号，鼠标悬停弹出
  说明卡片（`components/settings/tts-instruct-control-field.tsx`），讲清楚三件事：
  指令控制是什么、当前**实际发送**的那条指令原文、以及怎么用下方的「测试 TTS」
  对比试听。卡片里的指令直接取自 `DEFAULT_QWEN_INSTRUCTIONS` 常量而非另写一份
  文案，因此不会与真实请求产生偏差；末尾附官方文档链接。

  **测试 TTS 现在真的会带上指令**：此前该按钮的 `providerOptions` 只在 VoxCPM
  分支构造，千问面板无论开关是否勾选都不传标记，于是「取消勾选再测一次听出差别」
  这句指导是假的。现已按面板解析出的测试模型补上
  （`components/settings/tts-settings.tsx`），并把「决定用哪个模型判定」收敛到一处
  `testModelId`，使开关旁的黄色警告与测试按钮的行为不会互相矛盾（此前警告看的是
  讲稿槽位模型，对一个尚未启用的服务而言并非该测试真正会用的模型）。

  **验证**：`tests/audio/qwen-instruct-test-preview.test.ts`（6 例）覆盖该标记在
  Instruct 模型、非 Instruct 模型、VC 克隆模型、非千问 provider、开关关闭与无
  模型六种情况下的取值；`tests/settings/tts-instruct-control-field.test.ts`
  （8 例）覆盖帮助入口存在、警告只在开关打开且模型不支持时出现、以及中文文案未被
  英文占位。`tests/audio` + `tests/settings` 共 470 passed，`tsc`、`eslint`、
  `check:i18n-keys` 均通过。12 语言文案已补齐（英文 / 简中 / 繁中 / 韩文为实际
  翻译，其余语言沿用英文，与该文件既有条目一致）。

- **千问 TTS 指令控制开关**：在「设置 → 语音合成 → Qwen TTS」面板新增一个
  开关，勾选后生成讲稿时按需带上千问的交付指令，合成请求附带 `instructions` +
  `optimize_instructions`，由模型控制每句台词的语调、语速与强调
  （`lib/audio/qwen-instruct-control.ts`、`lib/audio/tts-providers.ts`）。
  由于指令已经承载了语气与节奏，讲稿提示词会追加一段说明，要求**只写台词本身**、
  不要把「（微笑）」「*笑*」这类舞台提示写进文本（否则会被念出来）。该说明通过新增
  的可选变量 `narrationPromptSection` 注入 `slide-actions` / `quiz-actions` /
  `interactive-actions` / `pbl-actions` 四套提示词的语音段落。

  **该特性只覆盖 Instruct 系列模型，不含常用的 `qwen3-tts-flash`**：按官方文档
  `instructions` 仅 `qwen3-tts-instruct-flash` 系列接受。因此开关**不禁用**，
  而是与当前 TTS 模型对照：模型不支持时面板给出提示并指向「课程模型配置」，
  服务端则把该开关按模型降级为关闭——不会给不支持的模型发参数（DashScope 会
  拒绝而非忽略）。未知模型按「不支持」处理。

  **未实现情感与富语言标签**：该特性属于 Qwen-Audio-TTS 系列（`qwen-audio-3.x`），
  而**千问 TTS 的模型目录里没有任何该系列模型**（`TTS_PROVIDERS['qwen-tts'].models`
  只有 `qwen3-tts-flash`、`qwen3-tts-instruct-flash`、`qwen-tts`、VC 克隆），
  用户无法在「课程模型配置」中选到，槽位校验也只认目录内的模型——开关永远无法
  生效。与其提供一个形同虚设的选项，不如不提供；若日后目录中加入该系列模型，
  再据此实现（`lib/audio/qwen-instruct-control.ts` 顶部注释记录了这一点）。

  **提示词在关闭时逐字节不变**：`{{#if narrationPromptSection}}` 块整体位于
  条件内（含首尾换行），并由 `test/narration-section-parity.test.ts` 断言四个
  模板在关闭时与基线渲染结果完全一致，避免给不使用该功能的用户带来任何 prompt 漂移。

  **验证**：`tsc` 通过；`eslint` 0 errors；`check:i18n-keys` 通过（12 语言）；
  包内 `@openmaic/generation` 215 passed（含新增 12 个提示词等价用例）；
  `tests/server/generation-run/qwen-instruct-control.test.ts`、
  `tests/audio/qwen-instruct-control.test.ts`、
  `tests/audio/qwen-instruct-request.test.ts` 全通过。
  `tests/audio/tts-invalid-response.test.ts`（2 例）、
  `tests/server/generation-run/sse.test.ts`（1 例）、
  `tests/model-settings/adopt-newer-view.test.ts`（3 例）为**改动前既有失败**，
  已用 `git stash` 对照确认。

### Fixed

- **Instruct 系列 TTS 报「音频 URL 主机不被允许」**：`qwen3-tts-instruct-flash`
  合成成功后，DashScope 返回的音频 URL 主机是
  `dashscope-a717.oss-cn-beijing.aliyuncs.com`，而音频下载的白名单
  （`lib/audio/qwen-voice-clone.ts`）写死了声音复刻用的
  `dashscope-result-*` 桶前缀，于是这个**合法**的返回地址被判为不可信，
  报 `The generated Qwen audio URL host "..." is not allowed.`
  （`qwen3-tts-flash` 此前能用只是碰巧，它与声音复刻共用同一批桶。）

  白名单改为匹配 `dashscope-` 品牌前缀 + 阿里云 OSS 区域端点
  （`^dashscope-[a-z0-9-]+\.oss-[a-z]{2}-[a-z0-9-]+\.aliyuncs\.com$`），
  覆盖两个系列共用的桶名差异。**未放宽到任意 `*.aliyuncs.com`**：
  非 OSS 主机、伪造后缀（`...aliyuncs.com.evil.test`）、`notdashscope-` 前缀
  与非 80/443 端口均仍被拒绝，SSRF 防护与签名 URL 行为不变。
  该白名单是声音复刻引入时按实测响应写死的，而桶前缀并非厂商对外契约的一部分，
  因此按品牌前缀匹配而非继续枚举具体桶名——否则厂商换个桶就会再坏一次。

  **验证**：`tests/audio/qwen-voice-clone.test.ts` 43 passed（新增 5 例：1 例正向
  覆盖 `dashscope-a717` 真实地址，4 例反向守住边界）；`tests/audio` 全量
  364 passed；`tsc`、`eslint` 通过。

- **构建被 Edge Runtime 告警刷屏**：`pnpm build` 时每个 Node 内建模块刷一条
  `A Node.js module is loaded ... which is not supported in the Edge Runtime`，
  一次构建 33 条，把真正的告警淹没（改动前共 43 条）。

  **根因不是代码里的 `import`，而是 Next 会把 `instrumentation.ts` 编译两份**：
  Node 份（本应用实际运行的那份）与 Edge 份（`edge-instrumentation.js`）。Next
  本来会在「instrumentation 是唯一 Edge entry」时丢弃后者，但
  `middleware.ts` 是 Edge 代码，于是 entry 保留，`register()` 通过动态
  `import()` 触达的整棵依赖树被打包第二次。关键是
  `NEXT_RUNTIME` 守卫（`instrumentation.ts:16`）只挡**执行**、不挡**打包**——
  那些 specifier 是静态字符串字面量，打包器照样静态跟踪。

  **修法只压诊断输出**：在 `next.config.ts` 用 Turbopack 原生的
  `turbopack.ignoreIssue` 匹配这一类告警。`ignoreIssue` 只影响诊断，模块解析、
  打包产物与 Edge chunk 内容完全不变，因此不影响运行时行为——真正是 Edge 的
  路由上出现 Node 内建模块仍会让构建失败（规则限定在
  `{instrumentation.ts,lib/**,packages/**}` 且按告警文本匹配）。

  **改动后**：Edge 告警 33 → 0，构建总告警 43 → 10。构建 exit 0，
  `✓ Compiled successfully`。剩余 10 条与 Edge 无关，未处理：9 条
  `Dynamic filesystem access causes tracing of the whole project`
  （`lib/document/extractors/local-media.ts:202` 的可执行文件查找）+ 1 条
  `middleware` 文件约定弃用提示。

  **验证**：`pnpm build` exit 0、`✓ Compiled successfully in 18.4s`；
  `grep -c "not supported in the Edge Runtime"` 为 0。

  **走过的弯路**：第一版用 `webpack()` hook 实现，因为 Next 16 默认走 Turbopack
  而根本不生效，反而触发 `This build is using Turbopack, with a webpack config
  and no turbopack config` 把构建搞崩，已删除。第二版 `path` 写成
  `instrumentation\.ts$` 一条没压掉——这些告警的 `path` 是真正出问题的源文件，
  `Edge Instrumentation` 只是 import-trace 的段标题。

  **未根治**：重复打包本身仍在，本次只消除了它的日志噪音。若要根治需重构
  `instrumentation.ts` 的结构（让 Node-only 启动逻辑静态不可达于 Edge 侧），
  有回归风险，建议单独进行。

### 同步上游 `ccdc88a5`（2026-10-06）

`upstream/main` 新增 3 个提交，以 `git merge upstream/main` 合入，**无冲突**。
基线由 `636fab0d`（`v1.2.0-rc.1`）推进到 `ccdc88a5`，本 fork 的 9 个二开提交
及其 hash 全部保持不变（`v1.2.0-video.1` tag 不受影响）。

| 上游提交 | 内容 |
| --- | --- |
| `a3c17b61` | feat(generation): 服务端生成运行的 host hooks（#1807） |
| `7230053af` | test(boot): 防止 `register()` 真的拉起后台 worker（#1803） |
| `ccdc88a5` | fix(pi): 带 400 拒绝已确认的畸形 reference snapshot（#1752） |

**与二开改动的重叠面**：`lib/server/generation/run/engine.ts`、
`lib/server/generation/steps/outline.ts` 两个文件双方都改了，但区域不同，
Git 自动合并结果已逐处核对：

| 文件 | 本 fork 改的部分 | 上游改的部分 |
| --- | --- | --- |
| `run/engine.ts` | `runRequirements()` 透传 `sceneTypes`（:230） | `executeGenerationRun` 拆分 + hook 事件上报 + host 失败分类 |
| `steps/outline.ts` | 场景类型约束提示词 + 流式过滤（:299/:587/:737） | `isNonRetryableHostFailure` 守卫（:42/:761/:827） |

两处语义相关但可叠加：上游的 host 失败守卫抛出的错误会经过我们场景类型
过滤所在的循环（:737）——被丢弃的类型场景不进入 confirmed outline，所以它
也不会因 host 失败而重试，二者叠加无副作用。

**验证**：`tsc` 通过；`lint` 0 errors（18 warnings 全为上游既有）；上游新增的
hooks 测试（`tests/server/generation-run-hooks*`、`outline-host-failure`、
`schema-migration-checksums`）43 passed；二开相关套件
（`tests/audio` `tests/chat` `tests/generation` `tests/generation-run-client`
`tests/server/generation-run` `tests/server/generation-steps` `tests/config` `tests/i18n`）
952 passed。

**未做**：E2E（需另起 3002 端口整套环境）。

### `1.2.0-video.2` 的验证状态

**通过**：`tsc --noEmit`（exit 0）、`eslint`（**0 error**，18 个既有 warning，
与上一版同数）、`prettier --check`（本次改动文件）、`pnpm check:i18n-keys`
（12 语包）、`pnpm check:node-engine`、
`node scripts/check-package-version-bumps.mjs v1.2.0-video.1`、
`@openmaic/generation` 包内 `vitest` **215 passed**（30 个文件）、
`tests/audio` + `tests/settings` + `tests/server/generation-run/qwen-instruct-control`
**506 passed**（61 个文件，2 例失败见下）、`pnpm build` exit 0。

**关于 `@openmaic/generation` 的版本号**：本版**确实改动**了该可发布包
（`src/scene-generator.ts` 与 4 个 `templates/*/system.md`）——这是 `1.2.0-video.1`
所没有的情况。因此 `check-package-version-bumps.mjs` 的 diff 模式在 CI 上会以
`publishable package inputs changed but version did not increase` 失败，
本次随发布把版本从 `0.3.15` 提到 **`0.3.16`**。

> 该检查读的是 **git `HEAD` 里的** `package.json`，不是工作区文件——只改文件、
> 不提交，检查仍然报失败。提版本号必须与改动一起进入提交。

**未通过 / 已知失败**：`tests/audio/tts-invalid-response.test.ts` 2 例
（`status` 500）。已 `git stash` 对照确认：**在不含本次任何改动的干净 HEAD 上
同样失败 2 例**，属改动前既有问题，非本次引入。

**未做**：E2E（`pnpm test:e2e`，需另起 3002 端口整套环境）；未发 `npm` 包
（`publish-packages.yml` 未触发）。

## [1.2.0-video.1] - 2026-10-06

本 fork 的首个独立版本。基线是上游 `v1.2.0-rc.1`（`636fab0d`），
本节收录相对该基线的全部二开改动。

**版本号说明**：`1.2.0-video.N` 是本 fork 的视频化版本线，**不复用上游的版本号空间**。
它按 semver 排在 `1.2.0-rc.1` 之后（`semver.gt('1.2.0-video.1', '1.2.0-rc.1') === true`），
但仍是**预发布**：上游若发布正式版 `1.2.0`，本 fork 的版本号不会与之冲突。
后续同步上游时以 `1.2.0-video.2` 递增，不要跳到 `1.2.1`。

### Added

- **开发环境可一键起渲染服务**（`9b8d9b40`）：`docker-compose.db.yml` 的 compose
  项目名从 `openmaic-dev-db` 改为 `openmaic-dev`，并新增 `render-service` 服务
  （构建自 `./render-service`，映射到 `127.0.0.1:9000`），配套
  `pnpm render:up` / `pnpm render:down` 脚本。
  - 改项目名是因为**渲染服务必须和开发库同属一个 compose project**：`db:up` 与
    `render:up` 才能共享同一套网络与卷命名，且用 `docker compose stop` 停其中一个
    不会影响另一个（`docker-compose.db.yml:14`）。
  - 服务需要 `cap_add: NET_ADMIN` 才能让 entrypoint 装上 egress lockdown 的
    iptables 规则。**缺这个 cap 服务仍会启动，但只打一条警告、并不真正阻断
    Chromium 出网**——这是安全降级，不是无害警告。
  - 默认拓扑下应用直接暴露、**不设 `TRUST_PROXY_HEADERS`**，所有调用方塌缩为同一
    身份，按身份的限流会退化成「整站只能同时跑一个渲染」，故默认
    `RENDER_MAX_JOBS_PER_USER=0`（关闭），只靠 `RENDER_MAX_CONCURRENCY` 与全局
    `RENDER_MAX_QUEUE` 兜底。要开启必须先在可信代理后部署。
  - `render-service/` 本身与 `lib/video-export/`、`lib/video-export-app/` **都是上游
    自带的**（`git ls-tree 636fab0d` 确认），本 fork 未改动其源码。

- **首页「场景类型」多选筛选**：composer 工具栏新增 `场景类型 n/4` 按钮，
  可勾选大纲要创建的场景类型——幻灯片 / 测验 / 互动 / 项目式学习。默认四项全选，
  选择存 localStorage（key `sceneTypesEnabled`），下次打开沿用。
  - 取消勾选后该类型**不会被创建**，而不是仅在前端隐藏：服务端在流式解析循环里
    直接丢弃（`lib/server/generation/steps/outline.ts:736`），被丢的场景不会进入
    confirmed outline，因此下游 content / actions / narration 三个步骤不会为它生成任何内容。
  - 同时向大纲提示词尾部追加一段类型约束（`outline.ts:298` 的 `sceneTypeConstraint()`），
    让模型少规划注定被丢弃的场景，省 token 也降低越界概率。两道保险：
    提示词负责「少生成」，解析切点负责「兜住」。
  - **按模式置灰**：深度交互（`interactiveMode`）与职业任务引擎（`vocationalTestMode`）
    的大纲模板只产 `slide` + `interactive`，因此这两项模式下测验与项目式学习
    **置灰不可选**，并标注「不适用」+悬停说明。依据是模板本身
    （`lib/prompts/templates/interactive-outlines/system.md` 标注
    `AVOID: Plain multiple-choice quizzes`；`task-engine-outlines/system.md:106`
    明写 `do not output ... pbl, or ordinary quiz scenes`）。
  - 提交前与可用类型取交集，空则回退全量——防止 localStorage 里的旧选择
    在受限模式下全部不可用，导致大纲为空并白烧 3 次重试。
  - 最后一个勾选项不可取消：空选择会让大纲没有任何场景。

  改动落在 L4（`app/` `lib/` `components/`），详见下方「与上游的差异」。

- **大纲审阅页的「AI 修改大纲」对话**：`/generation-preview` 进入大纲审阅态后，
  编辑器标题栏新增「用 AI 修改」按钮，打开一个多轮对话框：用自然语言描述修改，
  服务端用**大纲阶段的同一个模型槽位**（`course.outline`）返回一版完整新大纲，
  直接套用到编辑器（`editedOutlines`），并提供「撤销本次修改」回到上一版；
  确认流程不变，仍走 `confirm-outline` 整体替换（revision+1）。
  - 新增路由 `POST /api/generation-runs/:id/revise-outline`：owner 鉴权 +
    **同源 JSON 校验**（该调用消耗 owner 的模型额度），run 不在
    `awaiting_outline_confirmation` 时返回 409 `RUN_STATE_CONFLICT`，
    未配置大纲模型返回 400 `MISSING_MODEL`，模型输出不可用返回 502
    `GENERATION_FAILED`（编辑器保持原样）。它是**只读调用**，不写 run 状态：
    修改先活在浏览器草稿里（见 Fixed），确认时才落库。
  - 新增 step `lib/server/generation/steps/outline-revision.ts`：新提示词模板
    `lib/prompts/templates/outline-revision/`，模型输出先补 `id`/`order`
    （`repairOutlineScenes`）再走既有 `normalizeSceneOutlines`，
    媒体元素 id 经 `uniquifyMediaElementIds` 重铸，`sceneTypes` 过滤沿用
    composer 的选择；坏输出抛 `OutlineRevisionError`。
  - 新增客户端纯逻辑 `lib/generation-run-client/outline-revision.ts`
    （历史截断、变更摘要）与组件
    `components/generation/outline-ai-dialog.tsx`；入口按钮是
    `OutlinesEditor` 的新可选 prop `onAiEdit`（该组件当前仅本页使用）。
  - 12 个语包新增 `generation.aiEdit*` 共 12 个键。

  改动落在 L4（`app/` `lib/` `components/`），详见下方「与上游的差异」。

- **课堂讲稿可逐句编辑 + 独立的「重新生成语音」面板**：老师在课堂里改一句话的
  措辞，不再需要先进 Pro 模式找到那条 clip。

  **① 笔记面板里逐句可编辑**：右侧**笔记**标签页的每一句讲解，悬停出现铅笔图标，
  点击进入 textarea 编辑。`Mod/⌘+Enter` 保存、失焦即存、`Esc` 放弃。
  - 组件：新增 `EditableSpeechLine`（`components/chat/lecture-notes-view.tsx:80`），
    叠加在原有的「点击跳转到该句」按钮之上——访客仍得到**完全一致的只读界面**。
  - 权限复用 Pro 开关的同一组事实：`components/stage.tsx:370`
    的 `canEditScript={canEditOwnedStage && !courseGenerating}`，经
    `PlaybackChromeRoot` → `ChatArea` → `LectureNotesView` 透传。
    `canEditScript` 与 `onCommitScriptText` **必须同时**具备才显示编辑入口
    （只给前者会让按钮只能丢弃用户输入）。
  - 保存走 `PlaybackChromeRoot.tsx:1549` 的 `handleCommitScriptText`，复用 Pro 模式
    已验证的 `setSpeechTextClearAudioById`（`components/edit/ActionsBar/actions-edit.ts:115`）
    + `discardSpeechAudio`（`lib/audio/regenerate-speech-tts.ts:87`）。
    **两次写入的顺序是全部要点**：先改文案（同时清掉 `audioId` 并置
    `audioInvalidated`），**再**删音频字节。反过来会留下「文档仍指名某个资产、
    而它的字节已经没了」的悬空引用——这正是 `audioInvalidated` 字段要防的事。
  - 提交按 **action id** 定位（不是下标）：重新生成与删音频都是按 id 寻址的，
    按下标提交会让并发重排把新文案写到别的句子上。
  - 两条易漏的边界，均有测试钉住：① **无变化不算编辑**——提交与原文相同的文本会
    白白清掉该句音频并逼用户重新付费；② 编辑中途到来的外部改写（agent 重新生成）
    不会被旧草稿在提交时覆盖（沿用 Pro 模式 `SpeechClip` 的 `dirtyRef` 规则，
    `components/edit/ActionsBar/ActionsBar.tsx:574`）。
  - 保存后主动 `flushStageSave()`：去抖落盘会让刷新恰好落在「文案已改、音频未清」
    的窗口里。

  **② 独立的重新生成语音面板**：课堂头部（语言/主题/设置那一排）新增 🔊 按钮，
  打开 `components/stage/narration-voice-panel.tsx`——显示当前音色与语速、
  「已配音/未配音」统计，可按**本页**或**整门课程**批量重新生成，也可单句重新生成。
  - **音色 / 语气 / 语速与之前一致**不是靠约定保证的，是结构性保证：
    重新生成调用的就是 Pro 模式时间轴调的**同一个** `regenerateSpeechAudio`
    （`lib/audio/regenerate-speech-tts.ts:104`）→ `generateAndStoreTTS`
    （`lib/audio/narration-tts.ts:82`），音色/语气/语速不可能分叉。
  - 面板上显示的音色与语速来自新增 `lib/audio/narration-voice-summary.ts`，
    它是**将要发出的那个请求的读数**，而不是对某个设置的复述：逐行镜像
    `generateAndStoreTTS` 第 98–155 行的解析链（讲师绑定音色优先 → 回落全局
    `ttsVoice`；语速取全局 `ttsSpeed`）。**若该函数开头改动，本文件必须同步改**，
    否则就会变成「显示一种音色、合成另一种」。
  - 这里有个刻意处理的坑：`generateAndStoreTTS` 发现音色不可用时会调用
    `markVoiceBindingUnavailable` **修改模块级回退状态**，影响之后所有 clip。
    展示函数复用同样的判断，但**不做任何标记、不弹 toast**——否则用户只是打开
    面板看一眼，就会让后续真正的合成换一个音色。已有专门测试锁住这一点。
  - 批量重新生成是**串行**而非并行：这些请求计的是运营方的 TTS 额度，一次涌进
    四十条只会换来一批限流拒绝，而用户重试要再付一次钱。单句失败也不会中断整批
    （与 Pro 模式 "Voice all" 同规则）。
  - 「是否已有配音」用 `audioExistsBulk` 真实探测存储，**不轮询定时器**；字节先落、
    引用后盖，落库后主动 flush，保证刷新回来不会显示成未配音。探测失败时保留上
    一次读数，而不是谎报「全部未配音」诱导用户重复付费。
  - 面板自身不做鉴权：触发按钮无条件可见（打开看看音色是免费的），但当
    `tts` 槽位没有受管 TTS（如 browser-native 语音）或本浏览器无生成权限时，
    面板直接返回 `null` 什么都不渲染——控件与 `regenerateSpeechAudio` 的拒绝
    回答同一个问题。
  - 12 个语包新增 `edit.narration.*` 共 20 个键、`chat.lectureNotes.edit*` 等 5 个键。

  改动落在 L4（`lib/` `components/`），详见下方「与上游的差异」。

  **测试**：`tests/chat/lecture-notes-editing.test.ts` 7 例、
  `tests/audio/narration-voice-summary.test.ts` 6 例。已做变异测试确认能抓 bug
  （按错误 id 提交、无变化也提交、对访客显示编辑按钮，三个变异分别被对应测试捕获）。
  `tsc` / `lint` / `prettier` / `check:i18n-keys` 全通过。**未做 E2E**（需另起
  3002 端口整套环境）。

### Changed

- `lib/types/generation.ts:145` 把 `SceneOutline.type` 的内联联合类型
  `'slide' | 'quiz' | 'interactive' | 'pbl'` 提取为具名 `SceneType`，
  并新增 `ALL_SCENE_TYPES` 常量。**纯类型重构，对外行为不变。**
- `UserRequirements` / `GenerationRunInput` 新增可选 `sceneTypes` 字段。
  缺省表示「全部类型」，与上游旧行为完全一致——上游调用方（含 headless API）
  不传该字段时走的还是原来的路径。

### Fixed

- **大纲审阅页里未确认的修改不再因离开页面而丢失**：此前 `editedOutlines` 只活在
  React 状态里，而 run 自己的大纲在确认前不会变——点「返回修改需求」回首页、再从
  run 卡片进来（或刷新页面）就又是 run 的原大纲，AI 改过的内容看起来像没生效。
  现在未确认的大纲（AI 修改与手改走的是同一个 `editedOutlines`）在本机留一份草稿：
  - 新增 `lib/generation-run-client/outline-draft.ts`：localStorage key
    `generationRunOutlineDraft:<runId>`，内容 `{ revision, outlines }`。
    **草稿绑定它基于的 outline revision**：run 重跑大纲（revision+1）或在别处被
    确认后，旧草稿直接丢弃，绝不会盖住 run 的真实大纲；读入时校验结构
    （localStorage 属于不可信输入）。
  - `app/generation-preview/page.tsx`：审阅页读到 run 的大纲时按同一 revision
    还原草稿；编辑（含 AI 套用）时写入；确认成功、或 run 不再是
    `awaiting_outline_confirmation` 时清除。
  - 边界说明：草稿是本机本浏览器的（换设备/清缓存不会同步），对话框的多轮上下文
    不随草稿保存——重新进入后仍可基于当前大纲继续让 AI 改，但看不到之前的对话。
  - 测试：`tests/generation-run-client/outline-draft.test.ts` 17 例；
    `tests/generation/preview-outline-review.test.ts` 新增 2 例
    （离开再进入保留、确认后清除）。

- **`tests/config/docker-compose.test.ts` 与 compose 改动脱节**（本版本修复）：
  `9b8d9b40` 把 compose project 从 `openmaic-dev-db` 改成 `openmaic-dev` 并新增
  `render-service` 服务，但**没有同步这个硬编码了旧值的测试**。该测试 3 例失败
  （项目名、services 列表、`db:up` 脚本串），在基线上是通过的——
  `git worktree add /tmp/omv-base 636fab0d` 复跑可确认。
  - 之所以此前一直没被发现：`pnpm test` 全量在本机有 400 个失败（环境问题，见
    下方「验证状态」），并行跑时该 spec 恰好落在失败的 16 条抖动集合里，
    一直表现为「已知噪声」。**是基线对比把它从噪声里捞出来的**——
    只有把同环境的基线失败集合与 HEAD 失败集合做差集，才能区分
    「本来就坏的」与「本次改坏的」。
  - 修复方式：更新断言到新契约，并**补上它的反面**——新增一例断言
    `render:up` / `render:down` 也只操作 `render-service`，与 `db:up` / `db:down`
    只操作 `postgres` 成对。两个脚本都**显式点名服务**，因此谁也起/停不了对方；
    这一点原来没有测试覆盖。

---

## 本版本的验证状态

（`1.2.0-video.1` 发版当时的记录，留档备查。**`1.2.0-video.2` 与 `1.2.0-video.3`
的验证记录各自在对应发布节的末尾**：前者见「`1.2.0-video.2` 的验证状态」，
后者见「`1.2.0-video.3` 的验证状态」。）

**通过**：`tsc --noEmit`、`eslint`（0 error，18 个既有 warning）、`prettier --check`、
`pnpm check:i18n-keys`（12 语包）、`pnpm check:node-engine`、
`node scripts/check-package-version-bumps.mjs 636fab0d`。
本 fork 相对基线**未改动 `packages/@openmaic/` 下任何文件**（`git diff --name-only
636fab0d..HEAD -- packages/@openmaic` 为空），因此不发版 `npm` 包、不产生
`@openmaic/*` 版本的消耗，也未触发 `publish-packages.yml`。

### `pnpm test` 全量的读法

**本机全量测试有大量失败，且基线同样失败——所以「全量红」本身不构成信息。**
成因是环境：本机 `openmaic.yml` 配的 provider 缺 API key
（`providers.deepseek.apiKey: environment variable DEEPSEEK_API_KEY is not set`），
以及大批 5s 超时。

因此本次发版的做法是**同环境基线对比**——`git worktree add /tmp/omv-base 636fab0d`
检出干净基线，两边各跑一次 `--reporter=json`，比对失败**集合的差集**：

| | 测试数 | 失败数 |
| --- | --- | --- |
| 基线 `636fab0d` | 10358 | 400 |
| 本 fork（修复前） | 10434 | 400（差集含 16 条**两边不同**的抖动项） |
| 本 fork（修复后） | 10435 | 326 |

关键在于**不能只看总数**：两次全量的失败数完全相同（400 = 400），但差集里有
16 条各自只在一边失败。总数相等会让人误判为「无变化」而放过去。

- **本 fork 真实引入的失败：1 条，已修复**——`tests/config/docker-compose.test.ts`
  3 例（见上方 Fixed）。它在基线上通过、在 HEAD 上失败。
- 剩下的「只在 HEAD 失败」1 条是 `mineru-cloud` 的
  `rejects a small lying entry`，**两边单跑 3 次都是 26/26 通过**，属并行负载下的抖动。
- 单跑复核：除 `docker-compose.test.ts` 外，先前差集里的 7 个 spec
  （`skill-edit-tools` / `host-asset-hooks` / `host-library-provider` /
  `owner-claims` / `owner-materials` / `agents-route` /
  `legacy-import-binding-route`）在 HEAD 上**单跑全绿**。
  `element-reference-route-l2` 单跑在**基线与 HEAD 上失败情况完全相同**（各 9 例），
  同样是环境问题。

**未做**：E2E（`pnpm test:e2e`，需另起 3002 端口整套环境）。



---

## 记录格式说明

条目按 Keep a Changelog 分类：

| 分类 | 用于 |
| --- | --- |
| `Added` | 新功能 |
| `Changed` | 已有行为的改变（对上游调用方有影响时必须写清） |
| `Deprecated` | 即将移除 |
| `Removed` | 移除 |
| `Fixed` | 修复 |
| `Security` | 安全相关 |

**每条尽量带上文件路径与行号**，方便日后同步上游时定位冲突。
写不确定的事实前先核对代码，**不要编造行号或 API**（沿用 `AGENT.md` §8 的要求）。

---

## 与上游的差异

### 已偏离 `AGENT.md` §1.1 的目录约定

`AGENT.md` §1.1 写的是「跟上游的差异**只允许集中在视频相关目录**」，
但「场景类型筛选」是课程生成功能，不属于视频链路，因此实际改动落在：

```
app/page.tsx
components/generation/scene-type-filter.tsx        （新增）
lib/types/generation.ts
lib/generation-run-client/start.ts
lib/server/generation/run/{input,types}.ts
lib/server/generation/run/engine.ts
lib/server/generation/steps/outline.ts
lib/i18n/locales/*.json                             （12 个语包）
```

**这是有意的偏离**，理由：

- 该功能属`AGENT.md` §3 的 **L4（应用代码）** 层——「改生成流水线、场景类型、UI」，
  正是 L4 的定义范围。宿主扩展钩子（§6，`lib/server/persistence-hooks/`）只覆盖
  鉴权 / 课程库 / 资产存储，无法承载生成流水线的类型过滤，所以 L4 是唯一落点。
- 视频链路的落点约定（L4 浏览器侧 + L5 渲染服务）不受影响。

**代价与后续动作**（同步上游 `1.2.x` 之后）：

1. 同步前先看 `lib/types/generation.ts` 与 `lib/server/generation/steps/outline.ts`
   的上游改动，这两处冲突概率最高。
2. 若上游将来把场景类型也提取成了共享类型（当前仍是内联联合类型），
   需把 `SceneType` 与 `ALL_SCENE_TYPES` 合并过去，避免两处定义漂移。
3. 上游若新增第五种场景类型，本 fork 的 `ALL_SCENE_TYPES` 与
   `outline-template-scene-types.test.ts` 的断言都要跟着扩，否则测试会红。

### 第二处非视频偏离：AI 修改大纲

同样是 L4 的课程生成功能（不属于视频链路），实际改动落在：

```
app/generation-preview/page.tsx
app/api/generation-runs/[id]/revise-outline/route.ts   （新增）
components/generation/outline-ai-dialog.tsx            （新增）
components/generation/outlines-editor.tsx              （新增可选 prop onAiEdit）
lib/generation-run-client/{api,outline-revision}.ts
lib/prompts/{index,types}.ts
lib/prompts/templates/outline-revision/                （新增模板）
lib/server/generation/run/input.ts
lib/server/generation/steps/outline-revision.ts        （新增）
lib/types/generation.ts                                （新增 OutlineRevisionTurn）
lib/i18n/locales/*.json                                （12 个语包，各 12 个键）
```

**代价与后续动作**（同步上游 `1.2.x` 之后）：

1. `lib/server/generation/run/input.ts`、`lib/generation-run-client/api.ts` 是上游
   改动频繁的文件，冲突概率最高；本功能只做**追加**，未改既有导出的语义。
2. `lib/prompts/types.ts` 的 `PromptId` 联合与 `lib/prompts/index.ts` 的
   `PROMPT_IDS` 必须成对维护（`satisfies` 已保证值存在）。
3. 上游若调整 `confirm-outline`（整体替换大纲）的契约，本功能「AI 结果只在浏览器
   生效、确认时才落库」的前提会失效，需一并复核。

### 第三处非视频偏离：讲稿逐句编辑 + 重新生成语音面板

同样是 L4 的课堂 UI 功能（不属于视频链路），实际改动落在：

```
components/chat/lecture-notes-view.tsx            （新增 EditableSpeechLine）
components/chat/chat-area.tsx                     （透传 canEditScript / onCommitScriptText）
components/edit/PlaybackChromeRoot.tsx            （新增 handleCommitScriptText）
components/stage/narration-voice-panel.tsx        （新增）
components/stage/header-controls.tsx              （头部 🔊 入口）
components/stage.tsx                             （canEditScript 取值）
lib/audio/narration-voice-summary.ts             （新增）
lib/audio/use-narration-lines.ts                 （新增）
lib/i18n/locales/*.json                           （12 个语包，各 25 个键）
```

**代价与后续动作**（同步上游 `1.2.x` 之后）：

1. `components/edit/PlaybackChromeRoot.tsx` 与 `components/chat/lecture-notes-view.tsx`
   是上游改动频繁的文件，冲突概率最高。本功能对两处都是**追加**（新增 prop 与
   新增组件），未改既有导出的语义。
2. **`narration-voice-summary.ts` 必须与 `lib/audio/narration-tts.ts` 的
   `generateAndStoreTTS` 手工保持同步**——这是一处**上游不会帮你维护的重复**。
   上游若改动语音解析链（新增回落分支、换绑定优先级），本文件不会自动跟随，
   症状是「面板显示一种音色、实际合成另一种」。同步上游后**必须逐行复核
   `generateAndStoreTTS` 开头到解析出 `ttsProviderId` 为止这一段**。
   这是本 fork 里唯一一处「有意的镜像式重复」，用测试与注释双保险，
   但注释挡不住上游改代码。
3. 上游若把 Pro 模式的 `SpeechClip` 抽成通用组件，本功能的 `EditableSpeechLine`
   可以直接合并过去；在此之前两者共用同一批纯函数
   （`setSpeechTextClearAudioById` / `setAudioIdById`）与同一条 TTS 链，
   不会产生两套语义。

### 第四处非视频偏离：课程产品层与成果导向课程设计

`1.2.0-video.3` 起，本 fork 在视频链路之外长出了第二个完整子系统——**课程产品层**
（系列 / 课程 / 章目 / 知识点台账 / 组装器 / 批量生成 / 批量导出 MP4 / 培养方案与
指标点矩阵）以及其上的**成果导向课程设计**（Brief → 目标 → 证据 → 知识技能节点 →
依赖图 → 章目讲练考）。落点：

```
lib/curriculum/                        纯函数（coverage / assembly / program* / audit / design-* / traceability）
lib/server/curriculum/                 服务端 store、阶段机、HTTP 中间件、批量 runner
lib/persistence/curriculum.ts          curriculum schema v1–v12，27 张 curriculum_* 表
lib/persistence/schema-stores.ts       APP_SCHEMA_STORES 启动校验（已登记）
app/api/curriculum/**                  60 个 API 路由
app/curriculum/**                      6 个页面（系列 / 课程 / 设计）
components/curriculum/**               15 个面板与工作台组件
tests/curriculum/**                    16 个测试文件
skills/agent-runtime/*                 新增 11 个设计 skill
instrumentation.ts                     generation-run 钩子 + 批量 runner + schema 校验
```

**这是有意的偏离**：它不是视频链路，也不属于 §6 宿主扩展钩子能覆盖的范围
（钩子只覆盖鉴权 / 课程库 / 资产存储），只能在 L4 落地。它与第一、二、三处偏离的
**性质不同**——前三处是在既有文件上追加，这一处是**新增一个子系统**。

**代价与后续动作**（同步上游 `1.2.x` 之后）：

1. 冲突热点是 `instrumentation.ts` 与 `lib/persistence/schema-stores.ts`：上游也
   常改这两处。合并时优先保住上游的注册顺序，本 fork 的 hook 注册是**追加**。
2. `lib/persistence/curriculum.ts` 的 migration 数组**只能追加、不能改动已发布
   的版本条目**——迁移 checksum 有金标测试（`tests/persistence/`），改老条目会
   直接红。
3. 上游若调整 `owner-bound-document-store.ts` 的写锁顺序或 `OwnerAuthMethodResult`
   语义，`lib/server/curriculum/*` 的所有写路径都要复核（§5.2）。
4. 本子系统**不复用上游任何 `packages/@openmaic/*` 导出**，因此 L3 层没有漂移风险；
   反过来它也**不会**随上游 SDK 升级自动受益，升级后要手测。

### 上游同步

`upstream` 远端已配置（`2026-10-06`），共两次同步：`ccdc88a5`（见
`[1.2.0-video.2]` 发布节）与 `d725f191` / `v1.2.0-rc.2`（`cc41a9b3`，见
`[1.2.0-video.5]` 发布节）；`1.2.0-video.3` 与 `1.2.0-video.4` **未同步上游**。日后同步：

```bash
git fetch upstream
git log --oneline main..upstream/main   # 上游新增
git log --oneline upstream/main..main   # 本 fork 独有（应始终非空）
git merge upstream/main
```

**不要用 `rebase` 同步**：二开已有 75 个提交、已发布 `v1.2.0-video.1`、
`v1.2.0-video.2`、`v1.2.0-video.3`、`v1.2.0-video.4`，rebase 会改写这些已发布提交的 hash，破坏 tag 与远端历史的对应关系。
`merge` 保留双方历史，上游 commit 原样出现在本仓库中，日后双向可查。

同步后至少要跑：`tsc`、`lint`、`vitest`。若上游改过 `packages/@openmaic`，
还需 `node scripts/check-package-version-bumps.mjs <新的基线 commit>`。

---

## 基线

| 项 | 值 |
| --- | --- |
| 上游基线 | `d725f191`（`v1.2.0-rc.2`，`2026-10-13` 经 `cc41a9b3` 同步；更早一次是 `ccdc88a5`） |
| 本 fork 版本线 | `1.2.0-video.N`（首个发布：`1.2.0-video.1`，见上方版本号说明） |
| 本仓库首个二开提交 | `939c9027` docs: 新增 AGENT.md 二开上下文文档 |
| 许可证 | MIT（例外：`packages/mathml2omml` 为 LGPL-3.0-or-later） |

### 二开提交一览

**这一节不再逐条抄 commit。** 它原来是一张 10 行的手抄表，随后就漂了：
`1.2.0-video.2` 发布时没有更新它，`1.2.0-video.3` 的 37 个提交也全部不在里面。
手抄 `git log` 没有信息增量，而且保证会再次失同步——要看列表直接跑：

```bash
git log --oneline ccdc88a5..HEAD                  # 新 → 旧
git log --oneline --reverse ccdc88a5..HEAD        # 旧 → 新
git log --oneline --first-parent ccdc88a5..HEAD   # 只看主干（上游 sync 的 merge 算一次）
```

按发布阶段数（`--first-parent` 口径，含本次发布提交）：

| 阶段 | 提交数 |
| --- | --- |
| 基线 `ccdc88a5` → 首个独立版本 `v1.2.0-video.1`（`fb94ab3c`） | 9 |
| `v1.2.0-video.1` → `v1.2.0-video.2`（`57a35712`，含一次上游 `git merge upstream/main`） | 7 |
| `v1.2.0-video.2` → `v1.2.0-video.3`（`b62c71f0`） | 37 |
| `v1.2.0-video.3` → `v1.2.0-video.4`（`19a83d8c`） | 12 |
| `v1.2.0-video.4` → `v1.2.0-video.5`（本提交） | 10 |
| **合计** | **75** |

> 这张表在 `1.2.0-video.5` 发布时**重算过**：旧表后两行各少 1（36/11 实为 37/12），
> 合计写 64，而它自己的四行加总只有 63。现在每一行都是
> `git rev-list --count --first-parent <上一发布 tag>..<本发布 tag>` 的实算值，
> 合计等于 `git rev-list --count --first-parent ccdc88a5..HEAD`。每行**含**该阶段的
> 发布提交。

本仓库第一个二开提交是 `939c9027`（docs: 新增 AGENT.md 二开上下文文档）。

> **发布提交的 hash 无法自引用**：提交无法预知自身 hash，`--amend` 也会改写它。
> 所以本文件提到本次发布提交时一律写「本提交」，核对时 `git log` 会比文字描述
> **多出这最后一条**，这是预期结果。下一个提交若只是想补记它的 hash，用 `--amend`
> 并入**它自己**而不是新开一个 docs 提交即可（但那样 hash 会再次改变）；对
> **发布提交**而言这个占位就是终点，下一个提交直接开始记自己的 hash 即可。


