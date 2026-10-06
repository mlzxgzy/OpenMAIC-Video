# Changelog（二开）

本文件只记录 **本仓库相对上游的差异**。上游 OpenMAIC 的变更请看 [`CHANGELOG.md`](./CHANGELOG.md)。

- **上游项目**：[THU-MAIC/OpenMAIC](https://github.com/THU-MAIC/OpenMAIC)
- **本仓库**：`git@github.com:mlzxgzy/OpenMAIC-Video.git`（fork，无 `upstream` 远端）
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

### Added

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

### 尚未配置 upstream 远端

本仓库只有 `origin`。要同步上游需先自行添加：

```bash
git remote add upstream https://github.com/THU-MAIC/OpenMAIC.git
git fetch upstream
```

---

## 基线

| 项 | 值 |
| --- | --- |
| 上游基线 | `v1.2.0-rc.1`，commit `636fab0d` |
| 本仓库首个二开提交 | `939c9027` docs: 新增 AGENT.md 二开上下文文档 |
| 许可证 | MIT（例外：`packages/mathml2omml` 为 LGPL-3.0-or-later） |

### 二开提交一览

| commit | 说明 |
| --- | --- |
| `939c9027` | docs: 新增 AGENT.md 二开上下文文档 |
| `98e2f06c` | docs: 新增 CHANGELOG.fork.md 记录二开变更 |
| `0ce27191` | feat(generation): 首页可筛选大纲的场景类型 |
| `6e893061` | docs: 在二开 changelog 补记已提交的 commit 列表 |
| `3b73ab23` | feat(generation): 大纲审阅页可用 AI 对话修改大纲 |
| `879f99c6` | docs: 二开 changelog 补记 AI 修改大纲提交 |
| `9b8d9b40` | build(docker): 添加 render-service 服务 |
| （本提交） | feat(classroom): 讲稿逐句编辑 + 独立重新生成语音面板 |

用 `git log --oneline 636fab0d..HEAD` 可随时核对这份列表是否与历史同步。
表里用 `（本提交）` 占位的那一条无法登记自身 hash：核对时 `git log` 会比本表
多出这**最后一条**，这是预期结果，不是表失同步。下一条提交若只是补记它的 hash，
请用 `--amend` 并入本提交，不要新开一个 docs 提交——否则「比本表多一条」会变成
「多两条」，本表的核对约定就不成立了。

