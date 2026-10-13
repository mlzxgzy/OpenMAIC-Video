# 课程设计系统重构方案

> 目标：把现有「知识点台账 + 组装器」改造为
> **Learning Outcome → Evidence → Knowledge & Skill → Dependency → Curriculum → Teach → Practice → Assess**
> 的完整逆向设计系统。
>
> **落地状态（2026-10-11 补记）**：本文件记录的是**方案**与 **S1–S3 的落地记录**
> （含相对方案的修正、测试抓到的真实 bug、当时「尚未做」的清单）。
> **S4 / S5 已在 `1.2.0-video.3` 落地**——设计 HTTP 面（`app/api/curriculum/design/`，
> 25 个路由）、目标 × 目热力矩阵与设计工作台、阶段推进控件的归位、实操任务的录入、
> 以及 API 面向人的文案中文化。因此下文「尚未做（S4 起）」「尚未做（S5 起）」一类
> 小节**已过时**，请以 [`CHANGELOG.fork.md`](../../CHANGELOG.fork.md) 的
> `[1.2.0-video.3]` 发布节为准。
>
> **S6 / S7 / S8 / S9 / S10 / S11 已落地**，落地记录见
> [第十二节](#十二s6-落地记录已完成第一步改成-ai-对话--用户签收)、
> [第十三节](#十三s7-落地记录已完成第二步学习目标与考核标准)、
> [S8](#s8-第四步并进第三步先后关系即为边)、
> [S9](#s9-第五步生成课程大纲)、[S10](#s10-第六步教学内容生产) 与
> [S11](#s11-第七步题目与实操)：新建课程、学习目标、知识技能图、课程大纲、逐条教学内容
> 与题目实操六步都改为「AI 对话填写 + 用户签收」，共用 `curriculum_design_confirmation`
> 表，`task → outcomes`、`outcomes → graph`、`graph → outline`、`outline → teaching`、
> `teaching → assessment`、`assessment → review` 六道门禁都读它；第四步「依赖与排序」
> 并入第三步，写成同一张图上的有向边，不再单独成阶段。
>
> 本文件在上游忽略的 `/docs` 目录下，本 fork 用 `git add -f` 将它纳入版本库。

---

## 零、审查结论摘要

我完整审查了现有实现（`lib/curriculum/`、`lib/persistence/curriculum.ts`、`lib/server/curriculum/`、`components/curriculum/`、`skills/agent-runtime/`、`lib/server/generation/`）。

现有系统**不是一个课程设计系统，是一个"知识点驱动的课件批量生产流水线"**。核心问题集中在四点：

| # | 现状 | 根本问题 |
|---|---|---|
| 1 | `curriculum_knowledge_point.type IN ('knowledge','skill','competency')` | **没有学习目标实体**。知识点自己充当目标，导致目标不可验证、无成功标准、无证据 |
| 2 | `curriculum_course_knowledge_point.coverage_level IN ('introduced','practiced','mastered')` | 覆盖度是**课程→知识点**的单向绑定，讲课/练习/考试**全部塌缩成一门课** |
| 3 | `buildCourseAssembly()` 从选中知识点直接生成 slide 大纲 | 顺序倒置：**知识点 → 大纲**，而应该是 **目标 → 依赖 → 大纲** |
| 4 | 全库无 `objective` / `assessment` / `task` / `verify_rule` / `score_rule` 任何表 | 「教什么/练什么/考什么/怎么判分」**完全没有数据结构** |

现有的 [coverage.ts](lib/curriculum/coverage.ts) 只回答「知识点有没有被某门课提到」，**回答不了「这个目标有没有被教、被练、被考」**——而后者才是你要求的核心质量指标。

---

# 一、产品结构重构

## 现有设计

```
app/curriculum/
  page.tsx                 → 重定向
  series/[id]/page.tsx     → 系列工作台（1321 行）
  courses/[id]/page.tsx    → 课程工作台（1018 行）

课程工作台 5 个 Tab：
  基本信息 | 知识点 | 课程关系 | 组装与生成 | 课堂与视频
```

## 存在的问题

1. **Tab 顺序就是设计逻辑**：从「基本信息」开始，说明系统认为课程 = 一条台账记录。
2. **没有「目标」入口**：用户打开系统，第一眼看到的是 title/code/credits，不是「学完能干什么」。
3. **组装器吃掉了一切**：`组装与生成` 一个 Tab 承担了「选知识点 → 排序 → 生成 slide 大纲 → 一键生成」四件事，而**教学设计、练习设计、考试设计根本不存在**。
4. **课程 = 一门课 = 一个 stage = 一个视频**：`curriculum_course.stage_id` 1:1 绑定，`UNIQUE (owner_id, stage_id)`。**目、讲练考无法存在**。

## 修改建议：三级页面 + 六个设计阶段

### 页面信息架构

```text
/curriculum                                   → 系列列表（课程设计入口）
/curriculum/design/[seriesId]                ★ 新增：课程设计工作台（6 阶段主界面）
/curriculum/design/[seriesId]?stage=tasks    阶段1  课程任务（Brief）
                                  ?stage=outcomes  阶段2  学习成果（目标 + 证据）
                                  ?stage=graph      阶段3  知识/技能依赖图
                                  ?stage=outline    阶段4  课程大纲（章/目）
                                  ?stage=teaching   阶段5  教学设计（讲课目）
                                  ?stage=assessment 阶段6  练习与考试设计
/curriculum/courses/[courseId]               → 改为"目"的详情页（讲/练/考三态）
/curriculum/program/[programVersionId]       → 保留（培养方案层，已存在）
/classroom/[stageId]                          → 保留（课件生成与视频导出）
```

### 课程工作台（左→右 = 设计顺序，右→左 = 可追溯）

```text
┌────────────────────────────────────────────────────────────────────┐
│ ①课程任务  ②学习成果  ③依赖图  ④大纲  ⑤教学设计  ⑥练习考试  [审核] │
├──────────────┬─────────────────────────────────────────────────────┤
│ 左：对象树    │  中：主编辑区（随阶段切换）                          │
│              │                                                     │
│ ▸ 课程任务    │  阶段2 示例：                                       │
│ ▸ 学习目标 ×N │  ┌─────────────────────────────────────────────┐   │
│   ○ 知识目标  │  │ 目标：能够利用 SQL 注入获取数据库指定内容    │   │
│   ○ 技能目标  │  │ 证据：实操验证 · 题库：实操考试 #A            │   │
│   ○ 能力目标  │  │ 成功标准：4条 / 难度：中 / 前置：3项           │   │
│ ▸ 知识点 ×N   │  │ 覆盖：讲 ✓ 练 ✓ 考 ✓   ← 闭环徽章            │   │
│ ▸ 技能点 ×N   │  └─────────────────────────────────────────────┘   │
│ ▸ 依赖图      │                                                     │
│ ▸ 章 / 目     │                                                     │
├──────────────┴─────────────────────────────────────────────────────┤
│ 底部：审核面板（漏教/漏练/漏考/环/孤儿/不可验证目标/重复目标）      │
└────────────────────────────────────────────────────────────────────┘
```

**双视角切换**（你要求的「从目标看课程 / 从课程看目标」）：

- 顶部视角开关：`目标视角` ⇄ `课程视角`
- **目标视角**：选中一个目标 → 右侧显示「证据 → 依赖知识 → 教授它的讲课 → 训练它的练习 → 验证它的考试」，全链路高亮
- **课程视角**：选中一个目 → 右侧显示「本目教授哪些目标 / 训练哪些 / 验证哪些 / 依赖哪些先修」

---

# 二、数据模型重构（核心）

## 现有设计

```sql
curriculum_course                      -- 课程台账，1:1 绑定 stage
curriculum_knowledge_point             -- type: knowledge|skill|competency
curriculum_course_knowledge_point      -- coverage: introduced|practiced|mastered
curriculum_knowledge_point_relation    -- prerequisite|follow-up|contains|related
```

7 张 curriculum 表 + 8 张 program 表 = 15 张，**全部围绕"课程"和"知识点"两个中心**。

## 存在的问题

| 问题 | 具体 |
|---|---|
| **无目标实体** | `type='competency'` 是知识点的一个枚举值，不是独立的一等实体。它无法承载「预期行为/成功标准/验证方式/难度/前置要求」 |
| **目标不可验证** | 没有任何字段表达「什么行为出现算学会」 |
| **讲练考不分** | 一门课 = 一个 stage，覆盖度三值表达不了「这一目是讲课、那一目是考试」 |
| **无证据层** | 目标与评价方式之间没有绑定，无法回答「这门课靠什么证明学生学会了」 |
| **无实操结构** | 全库无 `docker_image` / `verify_rule` / `score_rule` / `hint`。CTF 实操题无处存放 |
| **知识点被压扁** | 知识/技能/能力/任务/目标/评价被塞进一个 `type` 枚举 + `summary` 文本 |
| **依赖图无校验** | `curriculum_knowledge_point_relation` 允许成环，无环检测 |

## 修改建议：新增 9 张表，扩展 3 张

```
课程任务 (course_task)
    ↓ 1:N
学习目标 (objective)  ← ★ 全新，一等实体
    ↓ ↑
评价证据 (evidence)   ← ★ 全新
    ↓ ↓
知识技能节点 (learning_node)  ← 改造 curriculum_knowledge_point
    ↓  N:M 依赖
依赖边 (dependency_edge)      ← ★ 新增，带类型
    ↓
课程单元 (course_unit: 章/目)  ← ★ 全新，讲课|练习|考试
    ↓ N:M
讲练考覆盖 (unit_coverage)     ← ★ 新增
    ↓
题目 (assessment_item)        ← ★ 全新，理论题
实操环境 (lab_task)            ← ★ 全新，Docker + 验证规则 + 评分规则
```

### 2.1 `curriculum_task` — 课程任务

```sql
CREATE TABLE curriculum_task (
  id                 TEXT PRIMARY KEY,
  owner_id           TEXT NOT NULL,
  series_id          TEXT REFERENCES curriculum_series(id) ON DELETE CASCADE,
  title              TEXT NOT NULL,              -- 《CTF 综合实战》
  audience           TEXT,                       -- 培训对象
  learner_level      TEXT,                       -- 零基础 / 有基础 / 混合
  training_scenario  TEXT,                       -- 培训场景
  duration_hours     DOUBLE PRECISION,           -- 培训时长
  application_scene  TEXT,                       -- 最终应用场景
  problem_statement  TEXT,                       -- 课程要解决什么问题
  status             TEXT NOT NULL DEFAULT 'draft',
  design_phase       TEXT NOT NULL DEFAULT 'task',  -- ★ 阶段机
  -- task|outcomes|graph|outline|teaching|assessment|review
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`design_phase` 是**强制状态机**：未完成上一阶段不允许进入下一阶段，杜绝「先建章节再塞知识点」。

### 2.2 `curriculum_objective` — 学习目标（★ 核心）

```sql
CREATE TABLE curriculum_objective (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL,
  task_id           TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  parent_id         TEXT REFERENCES curriculum_objective(id) ON DELETE SET NULL,
  code              TEXT,                       -- OBJ-WEB-01
  title             TEXT NOT NULL,              -- 能够利用 SQL 注入获取指定数据
  description       TEXT,
  -- ★ 目标类型：绝不与知识点混为一谈
  objective_type    TEXT NOT NULL,
  -- knowledge | skill | competency | task
  --  knowledge : 理解 HTTP 请求和响应
  --  skill     : 能够抓取 HTTP 请求
  --  competency: 能够独立完成一个基础 Web CTF
  --  task      : 获得 /flag
  bloom_level       TEXT,                       -- remember|understand|apply|analyze|evaluate|create
  level             TEXT NOT NULL DEFAULT 'component',
  -- course | component   （课程级目标 / 单元级目标）
  expected_behavior TEXT NOT NULL,              -- ★ 预期行为（可观察）
  -- "学员在给定靶场中，于 20 分钟内定位注入点并构造 payload 读取 flag"
  min_criteria       JSONB NOT NULL DEFAULT '[]',  -- ★ 最低通过标准
  proficient_criteria JSONB NOT NULL DEFAULT '[]',
  excellent_criteria   JSONB NOT NULL DEFAULT '[]',
  difficulty         TEXT NOT NULL DEFAULT 'basic',  -- intro|basic|intermediate|advanced
  verifiable         BOOLEAN NOT NULL DEFAULT false, -- ★ AI 审核标记
  unverifiable_reason TEXT,                     -- "了解 SQL 注入" → 原因
  status             TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|archived
  sort_order         INTEGER NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_objective_type_known CHECK
    (objective_type IN ('knowledge','skill','competency','task')),
  -- ★ 不可验证目标在应用层与审核层双重拦截
  CONSTRAINT curriculum_objective_verifiable_shape CHECK (
    verifiable = false OR (expected_behavior <> '' AND jsonb_array_length(min_criteria) > 0)
  )
);
```

**关键点**：你在第 24 节强调的区分，在这里落成**独立表 + 独立字段**：

```text
"理解 SQL 注入原理"    → objective_type='knowledge',   level='component'
"能够构造 SQL Payload" → objective_type='skill',      level='component'
"能够独立解决 Web CTF" → objective_type='competency', level='course'
"获得 /flag"           → objective_type='task',       level='component'
```

`verifiable` 约束在数据库层：没有 `expected_behavior` + `min_criteria` 的目标**无法被标记为可验证**。

### 2.3 `curriculum_evidence` — 评价证据（★ 核心，第五层）

```sql
CREATE TABLE curriculum_evidence (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  objective_id    TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  evidence_type   TEXT NOT NULL,
  -- quiz          理论题
  -- lab           实操
  -- performance   表现性任务
  -- dialogue      对话/答辩
  -- artifact      作品/报告
  verification_method TEXT NOT NULL,        -- 单选|多选|判断|实操验证|环境终态|人工
  success_condition   TEXT NOT NULL,        -- ★ "学生成功获取指定数据"
  condition_expression TEXT,                -- 机器可判定表达式（实操用）
  -- "readFile('/flag') == true"
  auxiliary_condition  TEXT,                -- 辅助验证："过程包含有效注入行为"
  assessment_mode TEXT NOT NULL DEFAULT 'practice',
  -- practice | exam      ★ 练习 vs 考试，同一结构不同语义
  threshold_pass  DOUBLE PRECISION DEFAULT 0.6,
  threshold_proficient DOUBLE PRECISION DEFAULT 0.8,
  threshold_excellent  DOUBLE PRECISION DEFAULT 0.95,
  time_limit_sec  INTEGER,
  hint_policy     TEXT NOT NULL DEFAULT 'allowed',
  -- unlimited | limited | forbidden    ★ 考试禁止提示
  independent     BOOLEAN NOT NULL DEFAULT true,  -- ★ 是否独立完成
  process_record  BOOLEAN NOT NULL DEFAULT true,  -- ★ 过程记录
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_evidence_type_known CHECK
    (evidence_type IN ('quiz','lab','performance','dialogue','artifact')),
  CONSTRAINT curriculum_evidence_mode_known  CHECK (assessment_mode IN ('practice','exam')),
  CONSTRAINT curriculum_evidence_hint_known  CHECK
    (hint_policy IN ('unlimited','limited','forbidden')),
  -- ★ 考试必须禁止提示且强制过程记录
  CONSTRAINT curriculum_evidence_exam_strict CHECK (
    assessment_mode <> 'exam' OR (hint_policy = 'forbidden' AND independent = true)
  )
);
```

**这一张表就是「目标 → 证据 → 评价」的落点**。目标先有证据，才允许进入大纲设计。

### 2.4 `curriculum_learning_node` — 知识/技能节点（替代 `curriculum_knowledge_point`）

```sql
CREATE TABLE curriculum_learning_node (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES curriculum_learning_node(id) ON DELETE SET NULL,
  code          TEXT,
  name          TEXT NOT NULL,
  node_type     TEXT NOT NULL,       -- knowledge | skill        ★ 只剩两类
  -- 能力归 objective_type='competency'，任务归 objective_type='task'
  -- 不再把 competency/task 塞进知识点
  summary       TEXT,
  difficulty    TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_node_type_known CHECK (node_type IN ('knowledge','skill'))
);

-- ★ 支撑关系：知识/技能 → 目标。多对多，可标注支撑强度
CREATE TABLE curriculum_node_objective (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  node_id       TEXT NOT NULL REFERENCES curriculum_learning_node(id) ON DELETE CASCADE,
  objective_id  TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  support_level TEXT NOT NULL DEFAULT 'primary',  -- primary|secondary
  -- ★ 不再用 introduced/practiced/mastered —— 那是「讲练考」，由 unit_coverage 表达
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (node_id, objective_id)
);
```

**核心修复**：`coverage_level IN ('introduced','practiced','mastered')` 从知识点绑定上**删除**。它描述的是"课讲到什么程度"，属于**目 → 知识点**的关系（`unit_coverage`），而不是"课程 → 知识点"。

### 2.5 `curriculum_dependency` — 依赖图（★ 核心）

```sql
CREATE TABLE curriculum_dependency (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  source_id   TEXT NOT NULL,     -- 泛型引用
  target_id   TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN ('objective','node')),
  target_kind TEXT NOT NULL CHECK (target_kind IN ('objective','node')),
  edge_type   TEXT NOT NULL,
  -- prerequisite  前置知识 / 前置技能
  -- derives      目标反推自（节点 → 目标）
  -- supports     支撑
  -- practices    实践依赖（技能 → 综合任务）
  -- composes     组合关系（多个知识点共同支撑一个技能）
  -- progresses   递进关系
  strength     DOUBLE PRECISION NOT NULL DEFAULT 1.0,  -- 边权重
  note         TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_dependency_distinct CHECK (source_id <> target_id),
  CONSTRAINT curriculum_dependency_edge_known CHECK
    (edge_type IN ('prerequisite','derives','supports',
                   'practices','composes','progresses'))
);

CREATE INDEX curriculum_dependency_source_idx
  ON curriculum_dependency (owner_id, task_id, source_kind, source_id);
CREATE INDEX curriculum_dependency_target_idx
  ON curriculum_dependency (owner_id, task_id, target_kind, target_id);
```

**泛型引用**（`source_kind` + `source_id`）让你在**一张表**里表达目标和知识节点的混合 DAG，而不是拆成两张关系表。项目已有先例（[stages.ts:9](lib/server/curriculum/validation.ts#L9) 的分阶段 schema），这是最小改动获得最大表达力的方式。代价是**无法用外键强制引用完整性**——由 `validation.ts` 的写入校验 + 定期孤儿扫描补偿。

> 迁移期兼容：旧 `curriculum_knowledge_point_relation` 通过一个迁移视图映射为 `edge_type='prerequisite'` 的 `curriculum_dependency` 行，旧数据不丢。

### 2.6 `curriculum_unit` — 章/目（★ 全新，替代 course 的组织职能）

```sql
CREATE TABLE curriculum_unit (
  id            TEXT PRIMARY KEY,
  owner_id      TEXT NOT NULL,
  task_id       TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  parent_id     TEXT REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  unit_type     TEXT NOT NULL CHECK (unit_type IN ('chapter','item')),
  -- ★ 章 = 纯分类（表达主题/阶段/能力领域），不承载具体知识
  -- 目 = 真正教学单元
  title         TEXT NOT NULL,
  code          TEXT,             -- 1-2-1
  unit_role     TEXT CHECK (unit_role IN ('lecture','practice','exam')),
  -- ★ 只在 unit_type='item' 时有值：讲课 | 练习 | 考试
  hours         DOUBLE PRECISION,
  order_index   INTEGER NOT NULL DEFAULT 0,
  -- ★ 教学设计字段（讲课目）
  teaching_design JSONB NOT NULL DEFAULT '{}',
  -- {
  --   objectives: [...], nodes: [...], prerequisites: [...],
  --   core: [...],          -- 必须详细讲
  --   brief: [...],         -- 快速讲
  --   mention: [...],       -- 只提到
  --   omit: [...],          -- 不讲
  --   sequence: [...],
  --   cases: [...], demos: [...], operations: [...],
  --   drills: [...], summary: [...]
  -- }
  -- ★ PPT 设计字段
  deck_design    JSONB NOT NULL DEFAULT '{}',
  -- { pages: [{order,title,goal,coreInfo,mode,emphasis,visual,code}], estPages }
  stage_id       TEXT,           -- 生成的课件（讲课目才有）
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_unit_role_known CHECK
    (unit_role IS NULL OR unit_role IN ('lecture','practice','exam'))
);
```

`deck_design` 是**你第 11 节明确要求的产物**：

```json
{
  "estPages": 16,
  "pages": [
    { "order": 1, "title": "登录接口长什么样",
      "goal": "建立问题场景", "coreInfo": "展示登录接口与请求示例",
      "mode": "case", "emphasis": ["username 参数"],
      "visual": "HTTP 请求结构图", "code": "POST /login" },
    { "order": 2, "title": "查询是怎么执行的",
      "goal": "解释 SQL 执行流程", "coreInfo": "解析→执行→返回",
      "mode": "explain", "visual": "流程图" }
  ]
}
```

这个结构**直接喂给 `deck_design → stage 生成器**，`lib/server/generation/steps/outline.ts` 不再自由发挥。

### 2.7 `curriculum_unit_coverage` — 讲/练/考闭环（★ 核心）

```sql
CREATE TABLE curriculum_unit_coverage (
  id              TEXT PRIMARY KEY,
  owner_id        TEXT NOT NULL,
  unit_id         TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  objective_id    TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  coverage_kind   TEXT NOT NULL CHECK (coverage_kind IN ('teach','practice','assess')),
  -- ★ Teach | Practice | Assess 三值独立存在，不再是单一 coverage_level
  depth           TEXT DEFAULT 'standard',   -- brief|standard|deep
  order_index     INTEGER NOT NULL DEFAULT 0,
  note            TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (unit_id, objective_id, coverage_kind)   -- ★ 三值互不覆盖
);
```

**这一张表就是 Teach→Practice→Assess 闭环的全部**。审核器只需一次 GROUP BY：

```sql
-- 漏练 / 漏考检测
SELECT o.id, o.title
FROM curriculum_objective o
LEFT JOIN curriculum_unit_coverage uc
  ON uc.objective_id = o.id AND uc.coverage_kind = 'practice'
WHERE o.task_id = $1 AND o.level = 'component'
  AND uc.id IS NULL;
```

### 2.8 `curriculum_question` — 理论题

```sql
CREATE TABLE curriculum_question (
  id             TEXT PRIMARY KEY,
  owner_id       TEXT NOT NULL,
  unit_id        TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  evidence_id    TEXT REFERENCES curriculum_evidence(id) ON DELETE SET NULL,
  objective_id   TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  question_type  TEXT NOT NULL CHECK (question_type IN ('single','multiple','true_false')),
  stem           TEXT NOT NULL,
  options        JSONB NOT NULL DEFAULT '[]',   -- [{key,text}]
  answer         JSONB NOT NULL,                 -- ["A"] / ["A","C"] / [true]
  explanation    TEXT,
  -- ★ 错误原因（你第 13 节要求）
  distractors    JSONB NOT NULL DEFAULT '[]',
  -- [{optionKey, misconception}]  每个错误选项对应的典型误解
  difficulty     TEXT NOT NULL DEFAULT 'basic',
  bloom_level    TEXT,
  score          DOUBLE PRECISION NOT NULL DEFAULT 1,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX curriculum_question_objective_idx
  ON curriculum_question (owner_id, objective_id);
```

`distractors` 是理论题的关键增量：它把"为什么选错"变成数据，而不只是解析文字。

### 2.9 `curriculum_lab_task` — 实操练习/考试（★ 核心）

```sql
CREATE TABLE curriculum_lab_task (
  id               TEXT PRIMARY KEY,
  owner_id         TEXT NOT NULL,
  unit_id          TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  evidence_id      TEXT REFERENCES curriculum_evidence(id) ON DELETE CASCADE,
  objective_id     TEXT NOT NULL REFERENCES curriculum_objective(id) ON DELETE CASCADE,
  assessment_mode  TEXT NOT NULL CHECK (assessment_mode IN ('practice','exam')),
  -- ── 任务 ──
  task_goal        TEXT NOT NULL,      -- 获取 /flag
  brief            TEXT NOT NULL,      -- 题目描述
  expected_result  TEXT,               -- 预期结果
  -- ── 环境 ──
  docker_image     TEXT NOT NULL,      -- "vuln/sql-injection:latest"
  container_config JSONB NOT NULL DEFAULT '{}',   -- {network, ports:[...], memLimit, ...}
  init_state       JSONB NOT NULL DEFAULT '{}',   -- 初始化脚本/状态
  reset_policy     TEXT NOT NULL DEFAULT 'on-demand',
  -- ── ★ 参考解法 与 验证规则 严格分离（你第 14 节核心要求）──
  reference_solution JSONB,            -- 参考操作流程（仅供讲评/提示，绝不用于判分）
  -- [{step:1, action:"...", detail:"..."}]
  verify_rules     JSONB NOT NULL DEFAULT '[]',
  -- ★ 判分依据，与 reference_solution 完全解耦
  -- [{kind:"flag", value:"flag{...}"},
  --  {kind:"file_read", path:"/flag"},
  --  {kind:"env_state", key:"db.user", value:"admin"},
  --  {kind:"http_request", method:"GET", path:"/admin"},
  --  {kind:"process_exec", argv:["whoami"]}]
  key_behaviors    JSONB NOT NULL DEFAULT '[]',    -- 关键行为（可选加分）
  final_state_rule TEXT,                          -- 环境最终状态判定
  -- ── 评分 ──
  score_rules      JSONB NOT NULL DEFAULT '[]',
  -- [{kind:"result", weight:60}, {kind:"process", weight:20},
  --  {kind:"key_step", stepId:"s2", weight:10}, {kind:"time", weight:10}]
  scoring_mode     TEXT NOT NULL DEFAULT 'result',
  -- result | process | key_step | time | mixed
  time_limit_sec   INTEGER,
  hint_policy      TEXT NOT NULL DEFAULT 'unlimited',
  -- ★ 练习允许提示，考试禁止
  allow_retry      BOOLEAN NOT NULL DEFAULT true,
  hint_ladder      JSONB NOT NULL DEFAULT '[]',   -- 分级提示
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT curriculum_lab_exam_strict CHECK
    (assessment_mode <> 'exam'
      OR (hint_policy = 'forbidden' AND allow_retry = false AND time_limit_sec IS NOT NULL))
);
```

**`reference_solution` 与 `verify_rules` 分离** 是这一节最重要的设计。CTF 一题多解，如果拿参考流程判分，学生的正确解法会被误判为失败。这两列物理隔离，且 `verify_rules` 有独立的校验器保证"可机器判定"。

### 2.10 `curriculum_unit_dependency` — 目级先修

```sql
CREATE TABLE curriculum_unit_dependency (
  id         TEXT PRIMARY KEY,
  owner_id   TEXT NOT NULL,
  task_id    TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  source_unit_id TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  target_unit_id TEXT NOT NULL REFERENCES curriculum_unit(id) ON DELETE CASCADE,
  edge_type  TEXT NOT NULL DEFAULT 'prerequisite'
  -- prerequisite | follow-up | related
);
```

### 2.11 `curriculum_audit_finding` — 审核结果持久化

```sql
CREATE TABLE curriculum_audit_finding (
  id          TEXT PRIMARY KEY,
  owner_id    TEXT NOT NULL,
  task_id     TEXT NOT NULL REFERENCES curriculum_task(id) ON DELETE CASCADE,
  rule_code   TEXT NOT NULL,
  -- objective_unverifiable        目标不可验证
  -- objective_no_evidence         目标无评价证据
  -- objective_missing_prereq      目标缺少前置知识
  -- node_orphan                   孤儿知识点
  -- node_untaught                 有内容无教学
  -- evidence_untaught             有考试无教学
  -- drill_no_objective            练习无对应目标
  -- objective_duplicate           目标重复
  -- dependency_cycle              依赖成环
  -- objective_uncovered          目标未考
  -- objective_unpracticed         目标未练
  -- unit_without_role            目未定义讲课/练习/考试类型
  severity    TEXT NOT NULL DEFAULT 'warning',   -- error|warning|info
  message     TEXT NOT NULL,
  ref_kind    TEXT, ref_id TEXT,
  ref_ids     JSONB NOT NULL DEFAULT '[]',
  status      TEXT NOT NULL DEFAULT 'open',      -- open|resolved|waived
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

---

## 迁移期策略

**不删除任何旧表**，双写过渡：

```text
curriculum_knowledge_point        → 保留，标记 deprecated
  ↓ 一次性迁移脚本
curriculum_learning_node          → 新写
  type='competency' → curriculum_objective(objective_type='competency')
  type='knowledge'/'skill' → curriculum_learning_node

curriculum_knowledge_point_relation → curriculum_dependency(edge_type='prerequisite')

curriculum_course                  → 保留（台账），stage_id 解绑 1:1
  ↓
curriculum_unit(item)              → 新写，每个目 = 1 门课 = 1 个 stage
```

**`curriculum_course.stage_id` 的 1:1 约束需要放开**：`curriculum_unit.stage_id` 取代它。一门"目"课对应一个 stage，而 `curriculum_unit` 可以有多个 item。所以是 `course → unit` 的 1:N 拆分，`stage_id` 下沉到 unit 层。

---

# 三、AI Agent / Skill 重构

## 现有设计

```
skills/agent-runtime/
  curriculum-planner        系列课规划：clarify → 签核 → 逐个建 stage
  stage-design              单个 stage 设计
  understanding-by-design   UbD：持久理解/基本问题/GRASPS/WHERETO
  vocational                任务引擎
  spiral-curriculum         螺旋课程
  k12-core-literacy-planning
  lecture-style / workshop-style / teacher-style-clone ...
```

## 存在的问题

1. **职责重叠**：`curriculum-planner` 和 `stage-design` 都在做"设计一门课"，只是粒度不同；`vocational` 和 `understanding-by-design` 都定义了场景节奏规则。
2. **没有阶段锁**：`curriculum-planner` 的 Gate 1 只澄清 brief，之后直接建 stage，**中间没有目标设计和证据设计**。
3. **UbD 只是一段提示词**：[understanding-by-design/SKILL.md](skills/agent-runtime/understanding-by-design/SKILL.md) 用「持久理解/基本问题」表达结果，这是**艺术化教学语言，不是可判定的学习成果**。系统要的是「能够独立完成 X，验证方式是 Y」——两者无法互相映射。
4. **没有依赖图构建者**：没有任何 agent 负责从目标反推知识技能并建边。
5. **没有审核 agent**：漏教/漏练/漏考无人负责。

## 修改建议：11 个单职责 Skill + 阶段锁

```
阶段1 course-analysis        课程分析：把 Brief 转成「学完能独立做什么」
阶段2 outcome-design        目标设计：产出可验证 objective + evidence
阶段3 knowledge-decomposition 知识技能拆解：目标 → node
阶段4 dependency-builder     依赖图构建：建边 + 环检测 + 补齐缺失先修
阶段5 outline-designer       大纲设计：依赖图 → 章/目 + 讲练考分配
阶段6 teaching-designer      教学设计：讲什么/多深 → teaching_design
阶段7 deck-designer          PPT 设计：teaching_design → deck_design 页级结构
阶段8 practice-designer      练习设计：理论题 + 实操题（含干扰项、验证规则）
阶段9 exam-designer          考试设计：独立完成/禁提示/时间限制/评分规则
阶段10 content-producer     内容生产：deck_design → stage → TTS → MP4
阶段11 course-auditor       课程审核：11 类规则扫描 + 修复建议
```

### 阶段锁机制

`curriculum_task.design_phase` 是权威状态。每个 skill 的 system prompt 首段：

```markdown
## 阶段锁

当前 `design_phase = <X>`。
你只能产出 X 阶段的产物，不能提前写下一阶段的内容。

- 若 X = outcomes 而尚无通过审核的 evidence，**禁止**创建任何 stage 或章节。
- 若检测到你在上一阶段未完成时试图跳阶段，立即停止并报告缺失项。
```

### 各 Skill 职责重划

| Skill | 取代/整合自 | 核心产出 | 关键约束 |
|---|---|---|---|
| `course-analysis` | `curriculum-planner` Gate 1 | `curriculum_task` 补全 + 候选能力清单 | 必须产出「学员完成课程后能独立完成什么」清单 |
| `outcome-design` | `understanding-by-design` 阶段一+二 | `objective` + `evidence` | **每个目标必须带 expected_behavior + min_criteria + evidence**，否则拒绝创建 |
| `knowledge-decomposition` | 新增 | `learning_node` + `node_objective` | 只产出 knowledge/skill；能力归 objective |
| `dependency-builder` | 新增 | `curriculum_dependency` | 必须跑环检测；发现目标缺先修要**自动补节点**而非仅告警 |
| `outline-designer` | `curriculum-planner` 后半 | `curriculum_unit` 章/目 | **章不得挂节点**；目必须声明 unit_role；每个 component 目标至少一个 `teach` |
| `teaching-designer` | `stage-design` 教学内容部分 | `teaching_design` | 必须区分 core/brief/mention/omit 四档深度 |
| `deck-designer` | 新增 | `deck_design` | 页级必须含 goal + coreInfo + mode；**不得输出纯目录** |
| `practice-designer` | `vocational` 题目部分 | `curriculum_question` + `curriculum_lab_task` | 实操必须写 `verify_rules`（可机器判定），**参考解法不得作为判分依据** |
| `exam-designer` | 新增 | 同上但 `assessment_mode='exam'` | 数据库 CHECK 已强制禁提示/禁重试/必计时，skill 只能遵守 |
| `content-producer` | `stage-design` 生产部分 | stage + TTS + MP4 | 消费 `deck_design`，不得自由发挥页结构 |
| `course-auditor` | 新增 | `curriculum_audit_finding` | 11 类规则全扫；**`error` 级不通过不允许导出视频** |

### Skill 保留 / 降级

- `understanding-by-design` → **降级为 `outcome-design` 的参考文档**，不再是独立 skill。其"持久理解/基本问题"可作为 `teaching_design` 的输入增强，但不作为目标载体。
- `vocational` → 保留，但其任务引擎结构映射到 `lab_task.verify_rules`，不再自成体系。
- `spiral-curriculum`、`k12-core-literacy-planning` → 保留为**领域参考**（references），不作为流程 skill。
- `lecture-style` / `workshop-style` / `teacher-style-clone` / `style-clone` / `page-clone` → **保留不动**，它们是课件风格层，与课程设计正交。
- `stage-design` → 拆分为 `teaching-designer` + `deck-designer` + `content-producer`。

---

# 四、生成流程重构

## 现有流程

```
选知识点 → buildCourseAssembly() → 拓扑排序 → 模板化 slide 大纲
  → coursePackage JSON → start-lesson-generation.mjs → generation run
  → outline step → scene-content step → TTS → MP4
```

## 存在的问题

[assembly.ts:460-543](lib/curriculum/assembly.ts#L460-L543) 的 `contentSlides` 是**纯机械映射**：

```typescript
const contentSlides = orderedPoints.map((point) => ({
  title: point.name,
  points: splitSummaryPoints(point.summary),        // summary 按标点切一下
  narration: buildKnowledgePointNarration(point),  // `本节我们学习${name}。${summary}`
}));
```

`buildKnowledgePointNarration` 生成的是 `本节我们学习X。Y。` —— **这是内容占位符，不是教学设计**。整个"课程设计"在 [assembly.ts:256-274](lib/curriculum/assembly.ts#L256-L274) 被压缩成一句 `objectiveForGroup`：`能理解"${top.name}"的核心概念` —— **正是你在第 4 节点名禁止的不可验证目标**。

## 修改建议：新流程

```text
① 课程任务     Brief 澄清                → curriculum_task
② 学习成果     能力反推 + 证据绑定       → objective + evidence   ★新
③ 知识技能拆解 目标 → 节点                → learning_node          ★新
④ 依赖图       建边 + 环检测 + 补齐       → dependency             ★新
⑤ 大纲         依赖图 → 章/目            → unit + unit_coverage  ★新
⑥ 教学设计     讲什么/多深/怎么讲        → teaching_design        ★新
⑦ PPT 设计     页级结构                  → deck_design            ★新
⑧ 练习设计     理论题 + 实操题            → question + lab_task   ★新
⑨ 考试设计     独立/限时/禁提示          → 同上 exam 模式        ★新
⑩ 内容生产     deck_design → stage        → stage + MP4
⑪ 审核         11 类规则                 → audit_finding
```

**关键变化**：PPT 生成不再是"给定知识点生成大纲"，而是**消费 `deck_design`**：

```typescript
// lib/server/generation/steps/outline.ts 的输入契约变更
// 旧：UserRequirements.requirement (自由文本)
// 新：UserRequirements.deckDesign (结构化页计划)
interface UserRequirements {
  // ...
  deckDesign?: {
    estPages: number;
    pages: Array<{
      order: number; title: string; goal: string;
      coreInfo: string; mode: 'case'|'explain'|'demo'|'compare'|'summary';
      emphasis?: string[]; visual?: string; code?: string;
    }>;
  };
}
```

这让 `deck_design` 成为**教学意图与课件生成之间的强类型契约**——正是你在第 11 节说的「讲课设计应该输出给后续课件生成模型使用」。

---

# 五、页面调整汇总

| 页面 | 现状 | 调整 |
|---|---|---|
| `/curriculum` | 重定向到 series | 保留，改为**设计工作台入口**，显示各任务的设计阶段进度 |
| `/curriculum/series/[id]` | 1321 行系列工作台，Tab: 概览/课程/知识点/关系 | **拆出设计工作台**。系列页退回"课程台账"角色，只管课程实体与关系 |
| `/curriculum/courses/[id]` | 5 Tab：基本信息/知识点/课程关系/组装与生成/课堂与视频 | 改为**目标详情页**。Tab 改为：目标与证据/知识技能/依赖/覆盖闭环/讲练考/生产 |
| `components/curriculum/course-assembler-panel.tsx` | 651 行，选知识点 → 生成 | **删除**。被 `deck-designer` + `content-producer` 替代 |
| **新增** `objective-panel.tsx` | — | 目标列表 + 预期行为 + 成功标准三档 + 证据绑定 |
| **新增** `evidence-panel.tsx` | — | 目标→证据矩阵，practice/exam 双列 |
| **新增** `dependency-graph-panel.tsx` | — | React Flow DAG，环检测高亮，双击建边 |
| **新增** `unit-outline-panel.tsx` | — | 章/目树 + unit_role 徽章 + 讲练考分配 |
| **新增** `teaching-design-panel.tsx` | — | 四档深度编辑器 + 课件页预览 |
| **新增** `lab-task-panel.tsx` | — | Docker 配置 + **验证规则编辑器** + 参考解法（折叠）+ 评分规则 |
| **新增** `audit-panel.tsx` | — | 11 类规则结果，error 级阻断导出 |
| **新增** `traceability-matrix.tsx` | — | 目标 × 目 的讲/练/考热力矩阵 |

技术选型沿用现有依赖：图用 `@xyflow/react`，统计用 `echarts`（两者都已在 `package.json` 中）。

---

# 六、审核规则（第 7、22 节要求）

```typescript
// lib/curriculum/audit.ts —— 纯函数，可测试
export const CURRICULUM_AUDIT_RULES = [
  'objective_unverifiable',    // 目标无 expected_behavior 或 min_criteria
  'objective_no_evidence',     // 目标无任何 evidence
  'objective_untaught',        // 目标无 teach 覆盖
  'objective_unpracticed',     // 目标无 practice 覆盖
  'objective_uncovered',      // 目标无 assess 覆盖
  'objective_missing_prereq',  // 目标的先修节点未被任何 teach 覆盖
  'node_orphan',               // 节点无支撑目标，且无依赖边
  'evidence_untaught',         // 考题存在但无对应 teach
  'drill_no_objective',        // 题目无 objective_id
  'objective_duplicate',       // 目标描述高度相似
  'dependency_cycle',          // DAG 有环
  'unit_without_role',         // 目未定义 unit_role
  'lab_no_verify_rule',        // 实操无 verify_rules
] as const;
```

**核心质量门**（你的第 22 节）实现为一个函数：

```typescript
export function evaluateCurriculumQuality(snapshot): {
  outcomesClear: boolean;        // 最终目标是否清楚
  outcomesVerifiable: boolean;   // 目标是否可验证
  supportComplete: boolean;      // 支撑知识/技能是否完整
  dependencyValid: boolean;      // 依赖关系是否正确
  curriculumCovers: boolean;     // 课程是否覆盖依赖
  teachCovers: boolean;          // 教学覆盖
  practiceCovers: boolean;       // 练习覆盖
  assessCovers: boolean;         // 考试验证
  traceable: boolean;            // 能否由考试反推掌握情况
  broken: Array<{ layer: string; findings: Finding[] }>;
};
```

**任一层断掉即 `broken` 非空**，`assessCovers=false` 时禁止 `export-jobs` 提交。

---

# 七、对后续自动出课的影响

## 可以保留并受益的部分

- **生成流水线本体完全复用**：[outlines](lib/server/generation/steps/outline.ts) → `scene-content` → `narration` → `video-export` 一行不改。
- **批量与导出队列完全复用**：`curriculum_batch` / `curriculum_batch_item` / `curriculum_export_job` 的队列语义正确，只是 `course_id` 改指 `unit_id`。
- **TTS / render-service / MP4 链路不动**。
- **培养方案层（program/indicator）完全复用**——它本来就在做"目标→课程支撑矩阵"，只是**下层缺了学习目标**，导致 `curriculum_course_indicator_support` 支撑的是"课程"而非"学习成果"。补上 objective 层后，它自然变成 `objective → indicator` 的直接支撑。

## 必须改变的部分

| 方面 | 变化 |
|---|---|
| **课程单位** | 从 `course`（1 stage）变成 `unit(item)`。54 个目 = 54 个 unit，每个可选挂 stage |
| **生成触发** | 从"组装完成即生成"改为**审核通过后生成**（`audit.error_count = 0`） |
| **PPT 来源** | 从自由文本 requirement 变为 `deck_design` 结构化输入 |
| **默认课程类型** | 现有 assembler 强制 `sceneTypes: ['slide']`（[assembly.ts:313](lib/curriculum/assembly.ts#L313)）。新系统**必须放开**：练习目要 `quiz` + `interactive`（`procedural-skill`），考试目要 `quiz` + 实操环境 |
| **新增产出** | 每门课额外产出理论题表、实操任务表、验证规则 —— 这些是"一门完整课"的新定义 |
| **导出前置** | 新增质量门：目标未考 / 有考无教 / 实操无验证规则 → 阻断导出 |

## 落地顺序建议

```text
S1  数据层    objective / evidence / learning_node / dependency /
              unit / unit_coverage / question / lab_task  + 迁移脚本
S2  逻辑层    audit.ts（11 类规则）+ traceability.ts（正反向追踪）+ coverage 重写
S3  AI 层     11 个 skill 的 SKILL.md + 阶段锁 + 工具集
S4  页面层    设计工作台 6 阶段 + 双视角 + 审核面板
S5  流程层    deck_design → outline 输入契约 + 实操目生成 + 质量门
S6  流程层    第一步课程方向 = AI 对话填写 + 用户签收门禁
S7  流程层    第二步学习目标与考核标准 = AI 对话 + 签收；清单用 ref 指名改动
S8  流程层    第三步知识点拆解 + 先后关系；第四步并入此步，顺序由边推导
```

**S1→S2 可以立刻产生价值**：即使 UI 全不动，`audit.ts` 跑一遍现有 CTF 数据就能立刻告出"哪些目标没考、哪些知识点是孤儿"。

---

# 九、S1 落地记录（已完成）

## 交付内容

| 文件 | 内容 |
|---|---|
| [lib/persistence/curriculum.ts](lib/persistence/curriculum.ts) | migration v8–v12：12 张表 + 1 个 `plpgsql` 触发器 |
| [lib/curriculum/design-types.ts](lib/curriculum/design-types.ts) | 领域类型；`referenceSolution` 与 `verifyRules` 是**两个独立类型** |
| [lib/server/curriculum/design-store.ts](lib/server/curriculum/design-store.ts) | CRUD + 阶段机 + 端点归属校验 + 环检测 |
| [tests/persistence/curriculum-design-schema.test.ts](tests/persistence/curriculum-design-schema.test.ts) | PGlite 约束测试 14 项 |
| [tests/persistence/curriculum-design-schema.pg.test.ts](tests/persistence/curriculum-design-schema.pg.test.ts) | 真实 PostgreSQL 约束测试 7 项 |
| [tests/persistence/curriculum-design-store.test.ts](tests/persistence/curriculum-design-store.test.ts) | store 行为测试 17 项 |

## 相对方案的三处修正

1. **"章不得挂知识点"改用触发器实现**。方案里写的是"用 CHECK 约束或触发器强制"，但 `curriculum_unit_coverage` 的 CHECK 无法跨表查询 `curriculum_unit`，所以实际用 `BEFORE INSERT OR UPDATE` 触发器。理由是这条规则必须对任何写入方生效，而章悄悄堆积教学内容正是本模型要防的回归。

2. **`verifiable` 的 CHECK 不用 `jsonb_array_length()`**。该函数对非数组输入会抛错而非返回 false，会把"列写坏了"变成 500 而不是被拒绝的写入。改为 `jsonb_typeof(...) = 'array' AND min_criteria <> '[]'::jsonb`，并额外加一条 `criteria_shape` CHECK 守住三档标准的数组类型。

3. **新增 `task_id` 冗余列**。方案里 `curriculum_evidence` / `unit_coverage` / `question` / `lab_task` 只靠外键链定位任务。实际实现冗余 `task_id NOT NULL REFERENCES curriculum_task(id)`，理由是审核查询全部是"某任务的漏教/漏练/漏考"，冗余列让它变成单表扫描，且有外键保证一致性。

## 阶段机（`curriculum_task.design_phase`）

```text
task → outcomes → graph → outline → teaching → assessment → review
```

只能**逐级前进**，且每级有完成门槛：

| 进入 | 门槛 |
|---|---|
| `outcomes` | brief 填了培训对象 / 待解决问题 / 培训时长 |
| `graph` | 至少一个目标，**且每个目标都已有证据** |
| `outline` | 没有孤儿节点（每个节点都支撑至少一个目标） |
| `teaching` | 每个目标至少被一个目 `teach` |
| `assessment` | 每个目标至少被一个目 `teach` |

写入侧用 `assertPhase` 双重把关：`createObjective` 要求 ≥ `outcomes`，`createLearningNode` 要求 ≥ `graph`，`createUnit` 要求 ≥ `outline`，`createQuestion` / `createLabTask` 要求 ≥ `assessment`。**编辑不设门槛**——正在修订的课程不该被冻结在它最初到达的阶段。

## 测试抓到的真实 bug

`assertDependencyAcyclic` 的递归 CTE **行走方向写反了**：原实现从新边的 `target_id` 反向匹配 `source_id`，导致"base → injection 已存在，再加 injection → base"这种明显成环的写法**被放行**。

修正为从新边 target 出发、沿 `source → target` 正向行走，判断是否走回新边 source。`composes` / `related` 仍不参与环检测（它们是相互支撑关系，不是顺序主张）。

这个 bug 是 store 测试第 9 项暴露的——PGlite 与真实 PostgreSQL 都无法自行发现它。

## 尚未做（S2 起）

- `lib/curriculum/audit.ts`：11 类审核规则 + `evaluateCurriculumQuality`
- `lib/curriculum/traceability.ts`：正反向追踪
- 旧 `curriculum_knowledge_point` → 新 `curriculum_learning_node` 的一次性迁移脚本
- API 路由、页面、AI skill

---

# 十、S2 落地记录（已完成）

## 交付内容

| 文件 | 内容 |
|---|---|
| [lib/curriculum/audit.ts](lib/curriculum/audit.ts) | 21 条审核规则 + `evaluateCurriculumQuality` 九层质量门。纯函数，输入 `CurriculumDesignSnapshot` |
| [lib/curriculum/traceability.ts](lib/curriculum/traceability.ts) | 正反向追踪 + `buildTraceabilityMatrix`（目标 × 目 热力矩阵） |
| [lib/curriculum/design-coverage.ts](lib/curriculum/design-coverage.ts) | 目标维度覆盖率报告 + `summariseCoverage` 判定 |
| [lib/server/curriculum/design-store.ts](lib/server/curriculum/design-store.ts) | 新增 `reviewCurriculumTaskDesign` / `assertCurriculumDesignExportable` |
| [tests/curriculum/design-audit.test.ts](tests/curriculum/design-audit.test.ts) | 43 项 |
| [tests/curriculum/design-traceability.test.ts](tests/curriculum/design-traceability.test.ts) | 19 项 |
| [tests/persistence/curriculum-design-store.test.ts](tests/persistence/curriculum-design-store.test.ts) | 新增 7 项审核/导出门禁测试 |

## 规则从 13 条扩到 21 条

原方案的 13 条里缺少几类**真实存在但无法表达**的缺陷，补充如下：

| 规则 | 补充理由 |
|---|---|
| `node_unsupported` | 课程级目标没有任何 `primary` 支撑节点——支撑存在但不可见 |
| `evidence_no_artifact` | 声明了 `lab` 证据却没有实操任务、`quiz` 证据没有题目。**这是闭环在工程上真正闭合的关键**：原方案只检查"目标有没有证据"，但"有证据声明、无实体产物"是更高频的失败 |
| `lab_verify_grades_by_path` | 验证规则照抄参考解法。用错误方式藏起来的"没有验证规则" |
| `dependency_out_of_order` | 「高级技能出现在基础技能之前」。依赖图正确**不等于**教学顺序正确，这是跨层检查 |
| `chapter_with_content` | 章承载教学内容。数据库触发器已拦写入，此规则兜住历史数据与导入 |
| `unit_orphan` | 目不教、不练、不考任何目标 |
| `objective_unmeasurable` / `brief_incomplete` | 简报不完整（无对象/无问题/无时长）时，后续层的"完整"没有意义 |

## 质量门按**链路顺序**报告，不按发现顺序

`evaluateCurriculumQuality` 返回 `firstBrokenLayer`。这一点是刻意设计的：

> 修好后面的层而前面的层还断着，产出的覆盖率会指向错误的东西。

所以错误消息固定指向**第一个**断点层，而不是最后发现的那个。store 测试第 5 项专门锁定这个行为。

## 导出闸门重新读取，不信任上一次的审核结果

`assertCurriculumDesignExportable` 不读取已存的 `curriculum_audit_finding`，而是**重新跑一遍**。理由：审核通过后设计可能被改坏，存下来的"通过"会让未闭合的闭环进入生产。这条有专门的回归测试。

## 相对方案的三处修正

1. **`objective_missing_prereq` 的含义调整**。方案里它指"目标的先修节点未被 teach"，但那与 `objective_untaught` 重叠。改为检查**教学设计是否点名了该目标的 primary 支撑节点**——这是更晚发生的回归：节点已连上目标，随后写教学设计时没提到它。后者只有跨 `node_objective` 与 `teachingDesign` 才能发现。

2. **`lab_verify_grades_by_path` 只做**精确**匹配**。最初用子串匹配，结果把正确的 `file_read('/flag')` + 步骤"read /flag"判为按路径判分——**每个设计良好的 lab 都会误报**。收紧为"验证字段逐字等于某个步骤"。这是"宁可不报，不可误报"：误报会让人开始忽略这个规则。

3. **父/子目标去重的方向性 bug**。守卫写成 `a.parentId && (a.parentId === b.id || b.parentId === a.id)`，当父目标排在比较序列前面时它的 `parentId` 为 `null`，`&&` 短路导致**该对目标从不跳过**，父子分解被误报为"重复目标"。改为两个方向独立判断。

## `core` / `brief` / `mention` 不是节点 ID

`CurriculumTeachingDesign` 里 `nodes` 和 `prerequisites` 是 ID 列表，而 `core` / `brief` / `mention` / `omit` 是**自由文本主题**。审核和追踪都曾把前者当 ID 扫描，结果：

- 审核：baseline 设计（教学设计为空）报 `objective_missing_prereq`——规则在任何正确设计上都会触发
- 追踪：`traceFromUnit` 把 `core` 里的 "payload construction" 当成节点 ID 返回

两处都已修正，并加测试锁定。

## 尚未做（S3 起）

- 旧 `curriculum_knowledge_point` → 新 `curriculum_learning_node` 的一次性迁移脚本
- `app/api/curriculum/design/*` 路由（快照 / 审核 / 阶段推进）
- 审核面板与热力矩阵页面（S4）
- 11 个 skill 的 SKILL.md（S3）
- `buildCourseAssembly` 废弃与 `deck_design` 契约接入（S5）

---

# 十一、S3 落地记录（已完成）

## 交付内容

| 文件 | 内容 |
|---|---|
| `lib/server/agent-runtime/design-tools.ts` | **21 个工具**，覆盖 S1 全部写入面；阶段锁、owner 隔离、可执行的拒绝文案 |
| `lib/server/generation/steps/deck-design-contract.ts` | `deck_design` → outline 提示块 |
| `lib/types/generation.ts` | `DeckDesign` / `DeckDesignPage` + `UserRequirements.deckDesign` |
| `lib/server/generation/steps/outline.ts` | 消费 deck design（追加到 system prompt，不改共享模板） |
| `skills/agent-runtime/{11 个新 skill}` | 每阶段一个单职责 skill，全部带阶段锁 |
| `outcome-design/references/understanding-by-design.md` | UbD 降级为参考文档 |
| 3 个测试文件 | 30 项新断言（12 工具 + 10 skill + 8 契约） |

## 工具集按**阶段**而不是按表组织

21 个工具的分组就是设计顺序：`create_course_task` → `create_learning_outcome`
/ `create_outcome_evidence` → `create_learning_node` / `set_node_objectives` /
`create_dependency` → `create_curriculum_unit` / `create_unit_coverage` →
`create_question` / `create_lab_task` → `review_course_design`。

**读是快照，写是细粒度**：一次 `get_course_design` 返回整个设计（目标+
证据+教/练/考覆盖+节点+依赖+大纲+题目+实操+审核），因为推理依赖图和闭环
缺口需要整张图，而不是一页。

## 拒绝必须可执行

工具的价值一半在它怎么拒绝。`guarded()` 把三类错误映射成三种**可行动**的
文案：

```text
阶段锁      → 告诉你现在在哪个阶段、去看 get_course_design
校验失败    → 直接给出 store 的具体原因
owner 隔离  → 与「不存在」逐字相同，不泄露存在性
```

S2 的 `lab_verify_grades_by_path` 那类规则在工具层被前置成 store 硬拒绝：
空 `verifyRules` 直接抛错，**根本进不了库**，所以工具里那段「无验证规则」
的警告分支是死代码，已删除。

## 测试抓到的真 bug：目标永远不会变成可验证

`createCurriculumObjective` 里是 `input.verifiable ?? false`——**数据库 CHECK
只校验这个声明，没有任何地方根据 behavior/criteria 推导它**。

后果是致命的：模型永远想不到要主动设 `verifiable: true`，所以**每一个由
AI 写的目标都停在「不可验证」**，而工具还在苦口婆心地提示「请添加
expectedBehavior 和 minCriteria」——加了十次也没用。

修在工具层（`verifiabilityOf()`），与 DB CHECK 规则一致但**计算**而非仅
校验。`patch_learning_outcome` 必须按**合并后**的值重新推导：这个 patch
正是「给一个只有标题的目标补上 behavior」的标准路径。

## `deck_design` 契约：追加，不替换

共享的 `@openmaic/generation` 提示模板是 checksum 锁定的，所以契约渲染放在
**应用层**，在 outline step 里追加到 system prompt。ad-hoc 路径（没有
deck design）的字节完全不变。

契约渲染的三条硬规则：

- **页序按 `order` 排**，不按数组位置——存储乱序也要按教学顺序输出；
- **缺 `goal`/`coreInfo` 的页显式标 ⚠ MISSING**，而不是静默透传。静默透传
  会产出一份看起来合理、却追溯不到任何教学决策的课件；
- **只统计真正不完整的页数**。把整个计划报成「不完整」会让模型放弃一份
  几乎可用的计划。

## 11 个 skill 与 UbD 降级

每个 skill 首段是**阶段锁**，正文是该阶段唯一该做的决定。`course-analysis`
给出「学员结束后能独立完成什么」的能力清单——那才是第一阶段的真正产出，
课程介绍不是。

`understanding-by-design` 降级为
`outcome-design/references/understanding-by-design.md`（**无 frontmatter**，
所以不会被当成 skill 发现）。理由写在文档开头：**持久理解没有通过/不通过
条件**，无法进入证据链，所以它是设计的*输入*（交给 `teaching-designer` 的
sequence 和 `deck-designer` 的 mode），不是*产物*。

连带修正了 4 个 skill 里指向 `/understanding-by-design` 的失效句柄。

`stage-design` 保留（一节课、无法验证承诺的场景是真实存在的），但新增
「When NOT to use this skill」并指向课程路径。

## 相对方案的一处修正

方案里 11 个阶段对应 11 个 skill；实际是 **10 个阶段名 + 11 个 skill**：
store 的 `teaching` 阶段同时包含教学设计和 PPT 设计，所以
`teaching-designer` 和 `deck-designer` 共用阶段锁。写成一个 skill 会让模型
在同一次调用里既写教学设计又写页面结构——那正是「讲课设计退化成标题列表」
的第一步。

## 尚未做（S4 起）

- `app/api/curriculum/design/*` 路由
- 审核面板与目标×目热力矩阵页面（S4）
- `buildCourseAssembly` 废弃（S5）
- 旧 `curriculum_knowledge_point` 迁移脚本

---

# 十二、S6 落地记录（已完成）：第一步改成 AI 对话 + 用户签收

S1–S5 把设计系统做出来了，但**第一步没法用**：七个 brief 字段（`title` /
`audience` / `learnerLevel` / `trainingScenario` / `durationHours` /
`applicationScene` / `problemStatement`）只有两个入口——列表页那个一次性静态表单，
和 agent 工具——**创建之后就再也改不了**。`design-task-list.tsx` 的注释写着"创建后
在任务本身上编辑"，而那个编辑界面并不存在。

## 交付内容

| 文件 | 内容 |
|---|---|
| [lib/curriculum/design-direction.ts](../../lib/curriculum/design-direction.ts) | 七槽位的唯一定义、缺口、模型回答清洗、确认的确定性守卫 |
| [lib/server/curriculum/direction-step.ts](../../lib/server/curriculum/direction-step.ts) + [course-direction](../../lib/prompts/templates/course-direction/system.md) | 一次对话轮次 → 一次卡片写入 |
| [app/api/curriculum/design/direction/route.ts](../../app/api/curriculum/design/direction/route.ts) | 对话轮次，直接入库 |
| [app/api/curriculum/design/tasks/[id]/direction/route.ts](../../app/api/curriculum/design/tasks/[id]/direction/route.ts) | 状态 / 确认 / 撤回 |
| [design-direction-dialog.tsx](../../components/curriculum/design-direction-dialog.tsx) · [design-direction-card.tsx](../../components/curriculum/design-direction-card.tsx) | 新建对话框；工作台里的七格编辑 |
| [lib/persistence/curriculum.ts](../../lib/persistence/curriculum.ts) | migration v13：`curriculum_design_confirmation` |
| [lib/server/curriculum/design-store.ts](../../lib/server/curriculum/design-store.ts) | 确认 / 撤回 / 读取；`phaseCompletionGaps` 增加一条门禁 |

## 「填好了」不等于「用户同意了」

这是本次唯一真正新的设计事实。此前阶段机只能看到"brief 填了没有"，看不到
"作者认没认"——而在 AI 流程里这两件事必然分开：模型一轮就把卡片写完了，作者
还没读过，于是这门课是**模型的计划**而不是**作者的计划**，而后面六个阶段全都
建在这张卡片上。

所以新增 `curriculum_design_confirmation`（一行一步，`step` 复用阶段词表：要确认
的正是要离开的那个阶段），`phaseCompletionGaps('outcomes')` 多一条：课程方向未
确认则拒绝离开 `task` 阶段，409 + 具体缺口。**门禁在 store 里而不是在 UI 里**，
所以直接 POST 阶段路由的客户端会遇到同一道门。

作者选了**宽松确认**：对话里说"确认"也算数，卡片按钮是另一个入口。宽松不等于
没有底线，两条确定性底线写在 `shouldConfirmDirection()` 里：

1. **用户的第一句话不能确认**——那时还没有可确认的对象。数的是**用户轮次**而不是
   总轮次：对话框开场那条助手寒暄不是模型对卡片的回答，把它算成一轮会让这条
   底线失效。
2. **必填项没齐不能确认**——确认一张门禁仍然会拒绝的卡片，会让作者以为已经越过
   了这一步。

两条都不依赖模型自述，所以模型"过于自信"时也越不过去。

## 改动卡片会撤回确认，但重述不会

`updateCurriculumTask` 比较七个槽位的**真实变化**再决定是否撤回确认行。这条
规则来自一句具体的抱怨——"用户对某个或对所有有意见就分析具体的"：模型每次写入
都会重述五格只为改一格，按"写入次数"撤回确认的话，作者点完确认后模型再说一次话
就被撤销了。比较值而不是计数，才让"确认"有确定的对象。

## 七槽位只有一份定义

`as const satisfies` + 编译期穷尽检查：`CurriculumDirectionKey` 里加一个槽位而
不在下面的表里定义，**构建就失败**，而不是等到运行时在某个先读到定义的界面上
崩。同一条规则被抄三份，漂移的那份不会报错——它只会让某个入口悄悄放行，所以
提示词、校验、卡片渲染、门禁都从同一份定义读。

## 模型输出是不可信输入

`sanitizeDirectionFields` 做三件事，各对应一种真实的坏输入：**未知键丢弃并记日志**
（模型爱加 `notes` / `courseName` 这类自造键，拦在写库之前比事后发现便宜）；
**时长接受 `"48 学时"`**（中文对话里模型经常带单位，把整条丢掉会让作者看到"AI 说
改了但卡片没变"）；**空串算 null**（模型用 `""` 表示"这格我不知道"，那就该留空
让门禁继续拦着，而不是存一个看起来填过的空格子）。

## 尚未做（S7 起）

- 第三步起的五个步骤
- 浏览器端驱动验证（Playwright 的 chromium 版本期望 1208，本机是 1148 且缺可执行文件）

---

# 十三、S7 落地记录（已完成）：第二步，学习目标与考核标准

S6 交付的是"七格卡片"的骨架。第二步的对象换成了**一份会增长、有序、可增删的
清单**，于是骨架里最关键的那条保证必须重新证明一次：**当 AI 直接改一份清单，
什么是安全的写**。

## 交付内容

| 文件 | 内容 |
|---|---|
| [lib/curriculum/design-outcomes.ts](../../lib/curriculum/design-outcomes.ts) | 引用解析、模型输出清洗、缺口、确认的确定性裁决 |
| [lib/server/curriculum/outcomes-step.ts](../../lib/server/curriculum/outcomes-step.ts) + [course-outcomes](../../lib/prompts/templates/course-outcomes/system.md) | 一次对话轮次 → 一次清单写入 |
| [outcomes/turn/route.ts](../../app/api/curriculum/design/tasks/%5Bid%5D/outcomes/turn/route.ts) | 对话轮次；[outcomes/route.ts](../../app/api/curriculum/design/tasks/%5Bid%5D/outcomes/route.ts) 状态 / 确认 / 撤回 |
| [design-outcomes-dialog.tsx](../../components/curriculum/design-outcomes-dialog.tsx) · [design-outcomes-signoff.tsx](../../components/curriculum/design-outcomes-signoff.tsx) | 对话面板；工作台里的签收条 |
| [design-store.ts](../../lib/server/curriculum/design-store.ts) | `listCurriculumOutcomes`；新增/修改/删除目标与证据时撤回 `outcomes` 签收；`graph` 门禁加一条 |

## 清单没有"只改这一格"的安全阀，所以 `ref` 就是安全阀

第一步的安全阀是"模型只回传它改动的那几格，其余不动"。清单没有这个结构：模型每次
回答都会重述整条目标，而**重述就是一次写入**。用户在清单里看不出"这条措辞变了"，
而重述可能顺手丢掉一条最低标准，让一个本来可考核的目标退回不可验证。

所以清单的安全阀换成**指名道姓**：模型只能用 `ref` 指明要改哪一条（`ref` 就是
`curriculum_objective.id`，每轮随清单一起打印给它）。规则有三条，全部在
`mergeOutcomePatch()` 里：

1. **对不上的 `ref` 一律丢弃并记账**，绝不按位置或按顺序套用。按位置套用就是"AI 悄悄
   改了用户读过的东西"，而且不可见。
2. **删除优先于修改**：同一轮里删掉又改的那条，删赢——否则一个已被判定"删掉"的条目
   又被 patch 写回来。
3. **同一条只接受最后一次 patch**：模型在一次回答里给两版改法时，后者是它真正的想法。

## 两条不对称的容忍度

这一层最需要记住的判断是**哪些坏输入该拒绝、哪些该显示出来**：

| 输入 | 处理 | 理由 |
|---|---|---|
| 目标缺最低标准 | **接受**，落库为"不可验证" | 这是 UI 要显示、等人补一句的**可见状态**。拒绝写入等于把这个缺口藏起来 |
| 证据缺检验方式或成功条件 | **拒绝** | 空的证据行能满足 store 的"每个目标都有证据"门禁，却什么都没证明——**它会把门禁骗过去** |

同一步里，一个缺可观察行为的目标是可见的待办，一条空的证据却是一个假保证。这个
不对称是这一层唯一真正难的决定，写在 `sanitizeEvidence` 的注释里。

## 确认比第一步多一条底线：这一轮必须真的动过清单

`shouldConfirmOutcomes()` 在第一步两条底线（用户首句不能确认、必填没齐不能确认）之外
加了第三条：**没有新增、没有修改、没有删除、没有加证据的"确认"不是签收**。它是对一句
"看起来还行"的附和，而签收的对象是这一轮的成果。

## 改动即撤回，但重述不算改动

`updateCurriculumObjective` 比较的是**合并后整行**与原行（`sameObjectiveShape`），
所以模型为了改一条最低标准而把标题重发一遍，不会撤回用户的确认。活体 walk 里这条是被
真实模型打出来的：它每轮都会重写目标，若按"写入次数"撤回，确认会在每一轮之后消失。

新增目标、删除目标、新增/删除证据一律撤回——这些没有"无变化的写法"。

## 测试与活体校验抓到的真 bug

活体 walk 的 `adding an outcome withdraws the sign-off` 抓到一个**只有写了 walk 才会
发现**的洞：`createCurriculumObjective` 没有调用撤回逻辑，所以确认之后新增一条目标，
清单已经不是用户读过的那一份，`graph` 门禁却仍然开着。补上之后由真 PostgreSQL 契约
测试锁住（`tests/persistence/curriculum-design-store.pg.test.ts`）。

## 尚未做（S8 起）

- 第四步「大纲」起的四个步骤
- 浏览器端驱动验证（同 S6：Playwright 的 chromium 版本期望 1208，本机是 1148）

---

# S7 第三步：知识点与技能点拆解

## 这一步在做什么

从已确认的学习目标反推：**为了做到那些目标，学生得先掌握哪些知识、哪些操作**。产出
`curriculum_learning_node`（知识点/技能点）和 `curriculum_node_objective`（哪个节点
支撑哪个目标）。**不排章节、不排讲授顺序**：你明确要求"暂不强制安排章节"，所以解析器
**不接受**任何章节字段——模型擅自写了 `chapters` / `units` 会被丢弃，并在
`rejectedRefs` 里说明。少一个字段比多一个被静默忽略的字段安全。

## 这一步最关键的一条：连线按节点合并，绝不整表替换

store 的 `setCurriculumNodeObjectives` 是"删掉本任务全部连线再按传入重建"，那是工作台
"保存"按钮的语义。模型一轮只提到它改的那几个节点；若照搬，**它没提到的节点的连线会
被连带删掉**，而且用户完全看不出——图少一条边不会变红，只会在进入大纲阶段、某个目标
突然没有可讲的内容时才炸。

所以 `mergeNodeLinks` 按节点算意图，返回"这些节点要重写成什么样"，其余节点的连线原封
不动；`resolveKnowledgeTurn` 再合并成**这一轮之后的完整连线集合**交给 store。路线测试
里 `keeps the links of every node the turn did not name` 就是为这件事存在的：它断言的是
**数据库里的行**，不是响应体。

## 又一处不对称

| 输入 | 处理 | 理由 |
|---|---|---|
| 节点没有挂任何目标 | **接受**，落库为孤儿节点 | 这正是 store `phaseCompletionGaps` 和审核 `node_orphan` 会报的状态，也是界面显示"待挂目标"的那一行；拒写等于把它藏起来 |
| 连线指向一个不存在的目标 | **拒绝**并记账 | 外键根本存不进去，模型写下它多半是把 id 打错了；丢掉并记账，用户至少看得到"这一条没接上" |
| 节点自己声明的某条连线写错了 | **丢掉这条线，保留节点** | 与第二步"丢证据留目标"同源：内容是作者要的，一条坏连线不该连内容一起删 |

## "清空一个节点的连线"必须能表达

`links` 里 `objectiveRef: null` 表示"这个节点不支撑任何目标"。这不是可选的润色：如果
模型只能增不能减，用户挂错一条支撑线就只能删掉整个节点重来——而"删节点"和"摘掉一条
线"是两件事，前者会连带丢掉这个节点上的其他连线和摘要。

清空在 `mergeNodeLinks` 里表现为"键存在、值为空数组"，与"键不存在（未提及）"严格
区分：前者是这一轮真的改了，后者是这一轮没碰。

## 门禁补上了缺失的那一半

原来 `phaseCompletionGaps('outline')` 只检查"每个节点都要有目标"。**另一半没有**：一个
目标可以完全没有节点——它照样通过检查，然后在大纲阶段变成"讲什么都不知道"。现在两边
都查，并加上 `graph` 签收检查。`confirm_course_knowledge` 的"完整"因此比第二步更强：
图必须**两头都连上**。

## 测试抓到的三个真 bug

1. **`createCurriculumLearningNode` / `deleteCurriculumLearningNode` 没有撤回签收**：
   与第二步同一个洞——确认之后新增一个节点，`outline` 门禁却仍然开着。补上。
2. **`setCurriculumNodeObjectives` 无条件删表重建**，所以工作台每点一次"保存"都会撤回
   签收，即使连线集合一个字节都没变。加了 `sameLinkSet` 比较（比 pair、支撑强度、
   备注三项，也就是作者会读的那几项）。
3. **清空连线后节点不再报缺口**：第一版把"这一轮提到过的节点"直接排除在缺口之外，结果
   模型刚清空一个节点的连线，这个节点就从"待挂目标"里消失了。判据必须是**这一轮之后
   还有没有连线**，而不是"有没有被提到"。由 `empties a node on an explicit clear` 锁住。

## 尚未做（S8 起）

- 第四步「大纲」起的四个步骤
- 浏览器端驱动验证（同 S6：Playwright 的 chromium 版本期望 1208，本机是 1148）

---

# 八、必须回答的设计判断

以下是我基于代码得出的结论，不是待办：

1. **`coverage_level` 必须从知识点绑定上删除**。它把"教/练/考"三个正交维度压成一个枚举，而 `unit_coverage` 用三行独立记录表达同样的信息且可分别查询。这是**当前数据模型最需要修正的一处**。

2. **`competency` 必须从知识点类型里移出**。能力是目标，不是知识点。混在一起导致"能力目标不可验证"这个问题在数据层无处表达。

3. **参考解法绝不能用于判分**。[lab_task](lib/persistence/curriculum.ts) 必须把 `reference_solution` 与 `verify_rules` 物理分列，且数据库 CHECK 保证实操题至少有一条 `verify_rule`。

4. **章不得挂知识点**。`curriculum_unit` 的章只承载 `title/order`，`unit_coverage` 只允许 `unit_type='item'` 写入 —— 用 CHECK 约束或触发器强制，否则"章承载大量知识"的问题会立刻回归。

5. **`buildCourseAssembly` 应整体废弃**，它的模板化 slide 生成（`本节我们学习X`）是有害的：它让系统**看起来能出课，实际产出的是占位内容**。这是"AI 自动写课程目录 + PPT"路径的根源，也是你要摆脱的东西。

---

## 附：现状与目标的对照

```text
现状（知识点驱动）              目标（逆向设计）
─────────────────────────────────────────────────────────────
Brief ──▶ 知识点 ──▶ 大纲     Brief ──▶ 能力目标 ──▶ 证据
           （手选）                （AI 反推）
              │                        │
              ▼                        ▼
           依赖图                 知识/技能节点
                                    （反推）
              │                        │
              ▼                        ▼
           一门课 = 一门          依赖图（补齐先修）
           = 一个 stage                 │
                                       ▼
                                   章 / 目
                                   （讲|练|考）
                                       │
        ┌──────────────┬───────────────┼──────────────┐
        ▼              ▼               ▼              ▼
      slide        （无）          （无）          （无）
     占位内容
                                        │
                                        ▼
                              教学设计 → deck_design
                                        │
                                        ▼
                              stage → TTS → MP4
                                        │
                    ┌───────────────────┴───────────────────┐
                    ▼                                       ▼
              理论题(带目标)                         实操(带验证规则)
                    └───────────────────┬───────────────────┘
                                        ▼
                                    闭环审核
```

相关文件：[types.ts](lib/curriculum/types.ts)、[curriculum.ts](lib/persistence/curriculum.ts)、[assembly.ts](lib/curriculum/assembly.ts)、[coverage.ts](lib/curriculum/coverage.ts)、[course-workspace.tsx](components/curriculum/course-workspace.tsx)、[course-assembler-panel.tsx](components/curriculum/course-assembler-panel.tsx)、[stage-writer-tools.ts](lib/agent-runtime/stage-writer-tools.ts)、[understanding-by-design/SKILL.md](skills/agent-runtime/understanding-by-design/SKILL.md)、[vocational/SKILL.md](skills/agent-runtime/vocational/SKILL.md)、[generation.ts](lib/types/generation.ts)
---

# S8 第四步并进第三步：先后关系即为边

## 先回答"这一步要不要做"

原计划的第四步是「内容依赖分析与教学排序」，四件事：前置知识、先后顺序、重复内容、
缺失环节。查了一遍消费方，结论是**它不该是一个独立阶段**：

| 这一步想写的东西 | 谁在读 | 结论 |
|---|---|---|
| 节点间依赖边 `curriculum_dependency`（node→node） | 除路由与 schema 测试外**没有业务读方** | 需要在这一步写，否则永远是死数据 |
| 节点排序位 `node.sortOrder` | 只影响列表显示；审核的顺序规则读的是 **`unit.orderIndex`** | **不写**：它是先后关系的函数，存下来就是第二份真相 |

于是把它并进第三步，落成三件事。

## 1. 顺序是**边**推导出来的，不是一个字段

模型提交 `dependencies`（`sourceRef` → `targetRef`），只增删被指名的边。讲授顺序由
`teachingOrder()` 做拓扑排序**推导**出来，只用于展示与提示词，**不写回任何列**：
大纲阶段真正排顺序的是 `unit.orderIndex`，在节点上再存一份，改一条边就会漂移。

同一层里 `supports` 不参与排序——它说明两个节点互相支撑，不说明谁先讲。这个区分现在
收在 [design-types.ts](lib/curriculum/design-types.ts) 的两个常量里
（`CURRICULUM_DIRECTED_EDGE_TYPES` 是 store 保持无环的那一组，
`CURRICULUM_ORDER_CLAIM_EDGE_TYPES` 是审核读作"先学谁"的那一组），免得 store 与规则层
各写一份、各写各的。

## 2. 会成环的边在**规则层**丢掉，因为 store 会回滚整轮

`createCurriculumDependency` 的环检测抛的是 `CurriculumDesignValidationError`：一轮里
几十个节点 + 一条写错的先修关系，结果整轮回滚。所以 `mergeNodeDependencies` 用**同一组
边类型**先走一遍可达性，把成环的那条丢掉。

丢掉之后必须**说出来**：一条没写进去的边在界面上没有任何痕迹——不像"节点没挂目标"会
显示成待挂状态。所以它进两处：回包里的 `warnings`（用户看得见），以及这一轮的 `gaps`
（拦掉模型自己声明的确认）。重述同一批边不算改动，不会撤回签收。

## 3. 三类发现分开，别混成一个"缺口"

| 发现 | 处理 | 理由 |
|---|---|---|
| 边成环、指向不存在的节点、删一条不存在的边 | **拒写 + 记账 + 警告** | 用户的指令没被执行，必须看见 |
| 两个节点同名 | **只报告** | 合并要的是语义判断；只按同名报，别假装判得了重复内容 |
| 节点没参与任何先后关系 | **只报告** | 独立内容不排顺序是合法的，报出来让人决定 |

**语义上的重复内容判定仍然留给覆盖分析那一步**：那时课程全文已经在了，模型说"这两处
真的重复"有依据，而在这里只有名字可比。

## 顺手修掉的两个真 bug

1. **依赖边写完后不撤回 `graph` 签收**：`createCurriculumDependency` /
   `deleteCurriculumDependency` 都不调用撤回逻辑（此前只有工作台写边，没人注意）。
   一条先修关系是作者签字认可的图的一部分，签完之后加一条就是"签的那份已经变了"。
   同时加了"完全相同的边重录不算改动"，否则一轮把整份依赖集重述一遍就会撤回签收。
2. **删除节点/目标留下悬空边**：`curriculum_dependency` 的端点是 `(kind, id)` 而非外键
   （多态表换来"一张图一次递归遍历"），所以**什么都不级联**。删掉一个节点，指向它的边
   还在：`dependency_cycle` 会报一条经过不存在 id 的环，而一个孤儿节点会因为一条悬空边
   而"看起来还有依赖"。现在两个删除路径都会清掉相关边。

## 测试抓到的第三件事：这个文件已经红了一整轮

`tests/persistence/curriculum-design-store.test.ts` 的 `advanceTo` 助手**没有跟上第二、
三步新增的签收门禁**（`outcomes` 与 `graph`），所以它有 20 个用例从第二步落地起就一直
失败——而常规命令只跑 `tests/curriculum`，没人看见。修好助手（并让"证据门禁"那个用例
先满足签收、再断言它真正要测的东西）之后 31 例全绿。

## 验证

| 项 | 结果 |
|---|---|
| 规则层新增 | `sanitizeDependency` / 解析 / `mergeNodeDependencies` / `teachingOrder` / `knowledgeFindings` / 列表渲染，共 22 例 |
| 步骤层新增 | 4 例（草稿端点、成环成缺口、只加边也能确认、不写排序位） |
| 路由层新增 | 5 例（PGlite，断言库里 `curriculum_dependency` 的行） |
| 存储层新增 | 2 例（边写删撤回签收、删节点带走边） |
| `tests/curriculum` | 全绿 |
| `tests/persistence/curriculum-design-store.test.ts` | 31/31（修好陈旧的助手之后） |
| tsc / eslint / prettier | 全绿 |
| 活体 walk | 见 [artifacts/regression/design-walk-step4.txt](artifacts/regression/design-walk-step4.txt) |
| 界面 | 仍**未做浏览器端驱动验证**（同 S6/S7：Playwright 期望的 chromium 版本本机不具备） |

## 尚未做（继续往后）

- 第五步「大纲 / 教学条目」：`unit.orderIndex` 才是提交顺序的地方；`dependency_out_of_order`
  那时才有意义（它比的是目标图与交付顺序）
- 覆盖分析那一步的语义重复检测
- 浏览器端驱动验证

---

# S9 第五步：生成课程大纲

第五步把**已经签收的**三样东西——学习目标、知识技能图、图上的先后关系——组织成
章、节与条目（目）。它是第一个"往已有承诺上落内容"的步骤，所以规则的重心和前几步都
不同：前面几步的产物是**新的**承诺（方向、目标、图），这一步的产物是**兑现**它们的
计划。

## 1. 章和节都是 `chapter`，目是 `item`

用户的课程结构是三级（章 → 节 → 目），而库里只有两种 `unit_type`。这里没有加字段，
也没有加表：`parent_id` 本来就允许章节套章节，**章和节都是 `chapter`，目是 `item`**。
区分它们的不是层级，而是职责——章节只归类（不承载覆盖，数据库还有触发器挡着），条目
是唯一会教东西的一层。

代价是"父级必须是章节"这条约束库里没有，所以它是规则层的责任。`planUnitWrites` 还负责
另一件事：章、节、目往往是**同一次回答里一起给**的，不像知识点那样一条一条长出来，所以
draft 可以带一个模型自己起的 `ref` 供同一轮的其他 draft 指名父级。指向数组**后面**的
draft 是合法的（"目在前、节在后"是很自然的写法），拓扑排序会把父级提到子级之前；两个
draft 互相指父级则是一个环，环上的丢掉并记账——谁会先存在？环外的照写。

## 2. 单元是独立的行，覆盖是整表替换

store 里这两件事的语义正好相反，这是这一步最容易写错的地方：

| | 写法 | 语义 | 模型的义务 |
|---|---|---|---|
| 单元 | `create` / `update` / `deleteCurriculumUnit` | 一次一行 | 只报它动过的 |
| 覆盖 | `setCurriculumUnitCoverage` | 删掉全任务再重建 | 报**这一轮之后的完整账本** |

所以 `mergeUnitCoverage` 按**条目**算意图：模型提到哪个条目，就只替换哪个条目的覆盖，
其余原样带过来（与第三步的 `mergeNodeLinks` 同一副骨架）。少带一条的表现是沉默的——
响应体完全正常，只有门禁在 `outline → teaching` 说"有目标没有被任何条目讲授"，而作者
盯着大纲看，那里什么都没变。

## 3. 凡是 store 会抛的，规则层先丢掉

整轮对话在**一个事务**里写入，store 抛一次异常就回滚全部改动——包括模型写对的那几十条。
这和 S8 丢环边是同一条理由，所以同样处理：章节带教学角色、条目没角色、父级不是章节、
覆盖挂在章节上（数据库里有触发器），全部在写入前过滤并记账，进回包的 `warnings`，让
作者看到"这一条没写进去"，而不是让整轮白干。

## 4. 顺序第一次变成真的——而它此前没有读方

`unit.orderIndex` 才是提交交付顺序的地方，第三步的 `teachingOrder()` 只是把边推导出来
给作者看。所以这一步要回答：**最早讲授 A 的条目，是否早于最早讲授 B 的条目**。

写这条检查时发现了一件更严重的事：审核的 `dependency_out_of_order`
**只处理 `objective → objective` 的边**。而 S8 把先后关系落成的是 **node → node** 的边。
也就是说，第三步里那句"顺序由边推导"在交付侧从来没有被任何规则检查过——承诺是真的，
检查是空的。

修法是让两处读同一份实现：规则层的 `outlineOrderConflicts`（节点经由"支撑哪些目标"
折到条目上）成为唯一定义，审核那条规则改为调用它。消息文案沿用审核原来的措辞，因为
同一个问题两种说法会让作者以为是两个问题。

## 5. 签收与写入在同一个事务里

前几步的确认是**第二个事务**：先写，再决定确认，中间有一个"图已经变了、签收还没落"的
窗口。这一步不需要那个窗口——缺口在**写完之后**从库里重算（规则层缺口 + 审核自己的
条目顺序发现），确认记录与它覆盖的那份文档在同一次提交里落地。模型自称"用户已确认"但
大纲还有缺口时，不记录确认，并在 `warnings` 里说明还差什么。

## 6. 一个装饰性的签收

`outline` 签收此前对状态机毫无作用：`phaseCompletionGaps('teaching')` 只检查"每个目标
都被讲授"，**不检查大纲有没有被确认**。一份作者从没读回的大纲也能离开 `outline` 阶段。
现在和其它三步一致：未确认则 409。这条是被测试逼出来的——断言"GET 的 phaseGaps 里应该
提到确认"时，它是空的。

## 验证

| 项 | 结果 |
|---|---|
| 规则层新增 | `design-outline` **44 例**（解析、放置、覆盖合并、缺口、顺序冲突、确认底线） |
| 步骤层新增 | `outline-step` **10 例**（覆盖账本、draft 树、模板渲染） |
| 路由层新增 | `outline-route` **15 例**（PGlite，断言 `curriculum_unit` / `curriculum_unit_coverage` 的行与 `outline` 签收行） |
| 审核 | `design-audit` 55 例全绿（节点级顺序关系的新行为在其覆盖范围内） |
| 陈旧助手 | `advanceTo` / `taskAtPhase` 四个文件补上 `outline` 签收（新门禁之下它们本来推不动）；受影响的 5 个套件合计 **128/128** |
| 宽回归 | `tests/curriculum` + `tests/persistence`：**729 通过 / 2 失败 / 82 跳过**。两例失败是 `asset-collector-schedule` 的环境问题，用 `git stash` 在未改动代码上复现，**与本次无关**；证据 [step5-after.txt](artifacts/regression/step5-after.txt) |
| 顺带修好 | `schema-migration-checksums` 缺 migration 13 那一行——它从 S6 起就红着，而这个文件在 `tests/curriculum` 之外 |
| tsc / eslint / prettier | 全绿 |
| 活体 walk | **未跑**：`design-api-walk.py` 需要一个跑着当前模块的 dev server，本轮没重启它（同 S5 的教训：跑旧模块只会得到假失败） |
| 界面 | 新增对话框与签收条，**未做浏览器端驱动验证**（同 S6–S8） |

## 尚未做（继续往后）

- 第六步「逐条教学设计」：`unit.teachingDesign` 与 `deckDesign`（页面规划）留在这个阶段，
  解析器现在明确拒收 `pages` / `teachingDesign` / `deckDesign`
- 覆盖分析那一步的语义重复检测
- 浏览器端驱动验证

---

# S10 第六步：教学内容生产

第六步把条目写成可以生产的东西：**授课脚本 → 分镜**。前五步定的是"教什么、按什么顺序
教"，这一步定的是**怎么教**——而且它必须落到页面上，因为"怎么教"如果不落到页面，它只是
一段好听的散文：真正生成课件的模型读不到散文里的犹豫，它只读得到页结构。

## 1. 两份产物，一份决定

| 产物 | 列 | 内容 | 谁读 |
|---|---|---|---|
| 授课脚本 | `teaching_design` | 讲什么、讲到什么程度（讲透/带过/点名/不讲）、什么顺序、什么例子 | 审核、追踪、面板 |
| 分镜 | `deck_design` | 页级计划：每页一句目标、一句核心信息、一种呈现方式 | **生成提示词**（`deck-design-contract.ts`） |

两者写在**同一个 plan 对象**里进出，而不是两个数组：分镜是脚本的逐页化身。分成两处写，
模型就会改了脚本忘了改分镜，而两者的矛盾在界面上看不出来——直到生成出一份与设计无关的
课件。

## 2. 寻址：存 id，进出一律翻译

这一步唯一真正新增的检查是"**脚本说要讲透的节点，分镜里必须至少有一页担着**"。要能比较
这两句话，它们必须用同一种寻址。

第一版写成"桶里装 id、页面里装名称"，理由是名称要打印进生成提示词。结果是：页面写 id
时被当成名称存了进去，两边永远对不上——测试同时钉住两种写法才把它逼出来。**现在是：存
下来的永远是 id；入口写名称也认（名称在一个条目自己的节点集里是无歧义的，为格式差异丢掉
一条真实取舍是本项目在别处一律拒绝的失败方式）；出口换回名称**（`deckDesignForGeneration`
把 id 翻成名称再交给生成器，生成器不认识 `node_xxx`）。

## 3. `nodes` 与 `objectives` 是推导的，不是接的

`teaching_design.nodes` 是 core/brief/mention 三档的并集，`objectives` 来自大纲签过的覆盖
关系。让模型同时维护同一件事的两种说法，就是让它们漂移——而审核读的恰好是推导出来的那个。
解析器显式拒收这两个字段并说明原因。

`omit` 是唯一收自由文本的档：最值得写进"不讲"的，恰恰是本条目不涉及的、读者可能以为会讲
的东西，用 id 表达反而写不出来。散文条目按散文处理，不参与比对——机器判不出"不讲 SQLMap
的安装"和页面上"SQLMap 常用参数"是不是同一件事，假装判得出比不判更糟。

## 4. 分镜只属于讲课条目

练习和考试条目生成的是场景不是幻灯片（`deckDesignForRole` 会忽略它们的分镜）。给它们写
分镜是一次**静默的空操作**，所以规则层直接拒收并记账，而不是存一份永远不被读到的计划。

## 5. 审计里那两条规则读的是同一份判定

`unit_lesson_undesigned`（条目没有教学设计、讲课条目没有分镜）与 `deck_script_conflict`
（分镜与脚本矛盾）属于 `teach_covers` 层，判定函数是规则层那一个；面板、对话提示词、门禁
三处都调它。这也是为什么这一步的缺口不能由客户端自己算。

## 6. 签收在同一个事务里，对着**写完之后**的稿子判

同 S9：缺口在写入之后从库里重算，确认记录与它覆盖的那份文档一次提交落地。第二次跟进的
一处修正：`curriculum-design-store.test.ts` 的 `advanceTo` 助手和 `buildClosedCourse` 都把
教学设计的 `nodes` 单独覆盖过一次，新规则下那会把深度档擦掉——**这个助手已经是第三次落后
一步**（S8 缺 outcomes/graph 签收、S9 缺 outline 签收、S10 缺 teaching 签收），现在它把每道
门禁都走完。

## 验证

| 项 | 结果 |
|---|---|
| 规则层新增 | `design-teaching` **47 例**（解析、桶深度、名称→id、分镜、矛盾、缺口、确认底线、渲染） |
| 步骤层新增 | `teaching-step` **9 例**（写完之后算缺口、只写被指名的条目、建议与缺口分开） |
| 路由层新增 | `teaching-route` **14 例**（PGlite，断言 `curriculum_unit` 两列与 `teaching` 签收行；含 409 在模型调用之前） |
| 生成侧新增 | `unit-role-run` **4 例**（id→名称的边界翻译、不存在的节点被丢掉、非讲课条目不接分镜） |
| 测试抓到的真 bug | `pages[].teaches` 的 id/名称解析**写反了**（`nameById.get(entry)` 把 id 又当成名称存回去），两种写法现在都有断言 |
| 陈旧助手 | `design-editing` / `lab-authoring` / `design-routes` / `curriculum-design-store` 四个文件的 walk 补上第六步门禁 |
| 套件 | `tests/curriculum` **521/521**（29 文件）；`tests/persistence` **278 通过 / 2 失败 / 82 跳过** |
| 那 2 例失败 | `asset-collector-schedule` 的环境问题（本机 `openmaic.yml` 指向未配置的 provider）。`tests/generation` 另有 3 例，**用 `git stash` 在未改动代码上得到完全相同的 3 例**，与本次无关 |
| tsc / eslint / prettier | 全绿 |
| 界面 | 新增 `design-teaching-dialog` + `design-teaching-signoff` + 工作台一张卡片，**未做浏览器端驱动验证**（同 S6–S9） |
| 活体 walk | **未跑**：需要一个跑着当前模块的 dev server |

## 尚未做（继续往后）

- PPT / 配音 / 视频这一段：分镜已经进生成提示词（`deckDesign`），但"页面计划 → 实际页数"
  的偏差回写、配音与导出的整链验证还没有做
- 分镜的**逐页编辑界面**（当前只有对话写、卡片读；`UnitBlock` 编辑的是脚本的深度档）
- 覆盖分析那一步的语义重复检测
- 三个新签收工具的**技能文档**只补了 `outline-designer` 一处；`teaching-designer` /
  `deck-designer` / `practice-designer` / `exam-designer` 的技能文件仍然只描述"写什么"，
  没写"写完要签收"
- 浏览器端驱动验证与活体 walk

---

# S11 第七步：题目与实操

第七步把已经签收的教学设计变成**可以判分的考核**：理论题（`curriculum_question`）与
实操任务（`curriculum_lab_task`）。这一步要解决的不是"能不能出一道题"——那是表单的事——
而是**一道挂错条目的题在界面上完全正常**：有题干、有选项、有答案、有关系到的学习目标，
审核的每一条题目规则都满意，而覆盖闭环里没有它。讲这个目标的条目从头到尾没有出现过它，
学员也没在那个条目里见过它。**这类错误在本项目里属于最贵的一类：它在任何列表里都看不出来。**

## 1. "挂在哪一条"是一个声明，不是外键

题目与实操各挂在**一个条目**上（`curriculum_question.unit_id`），这不是存储细节，而是
"哪一个条目交付这次考核"的声明。所以落点由规则层判定，而不是接模型给的值：

| 情况 | 处置 |
|---|---|
| 挂在章/节上 | 拒收并指名那是章：章只归类，不讲课也不考试 |
| 挂在没有承担该目标的条目上 | 拒收并列出真正承担它的条目 |
| 实操挂在只讲课的条目上 | 拒收并说明实操要挂在"练或考"它的条目上 |
| 没给 `itemRef`，恰好一个条目承担 | 推导 |
| 没给 `itemRef`，多个条目承担 | 拒收并要求指名——"考在哪一条"是作者的决定 |

最后一行是这一步最像"设计"的地方：**能推导的推导，推导不出来的时候问，而不是猜。**
猜一个条目会把题放进一个作者没想到的地方，而它在界面上依旧完全正常。

store 两条都不检查（`createCurriculumQuestion` 只查单元存在、目标存在、同一任务），
所以这两个洞以前是敞开的：把题目挂到章上完全能写进去。

## 2. 只查 `assess`，不查 `practice`

"条目承诺了考核却什么都没有"是空承诺，必须报。但**练习承诺不是这样兑现的**：大纲提示词
写明练习条目生成幻灯片、测验和互动流程，它的交付物是生成结果而不是练习题或实操任务。
把 `practice` 也要求成"必须有题目或实操"，会把每一个正常的练习条目都报成缺口——一条会
误报的规则比没有规则更糟，因为它训练作者忽略整条缺口列表。

同一层还有一条：**考试证据必须由考试的实操交付**。证据写着 `exam`、实操却是 `practice`，
学员拿到的是有提示、可重做、不限时的东西，而成绩单上它是考试。

## 3. 三个字段由规则层推导

- **`evidenceId`**：证据是第二步签过的文件，这一步不新增、不搬动（那会撤回第二步的签收）。
  目标下恰好一条对口证据时自动绑定；有多条时**不猜**，只提示。
- **`sortOrder`**：题号是文档的属性，不是模型答案的属性：按条目已有的最大题号往后排。
- **落点**：见第 1 节。

验证规则只收 `{kind, target}`，字段映射复用 S5 的 `labVerifyRuleFrom`。理由是 S5 已经为
"七选一的字段写错就永远匹配不上、而且存得下去"写过一版；让模型自己挑字段就是把那个坑
重新交给它。

## 4. 产物是独立的行，不是一份文档

模型改一道题、删一道题都要**指名**（`ref` / `removedQuestions`），没提到的一律不动。
这是第三步依赖边的那条约定，不是第五步覆盖表那条——第五步的覆盖是整表替换，因为
"这个条目覆盖哪些目标"本来就是一份集合；而"课程里有哪些题"不是一份集合，它是一组行。

改一道题只写它提到的字段：**没提到 = 保持原值**，`[]` / `null` = 清空。这个三态约定是
"改题干"能成立的前提，也是我在这一层改掉的第一版错误（初始实现把所有列表字段的缺省
当成空列表，于是"只改题干"会顺手清空选项）。

## 5. store 会拒的，这里先拒

store 抛错回滚**整轮**（同 S8 的教训）。所以规则层把 store 的每一条硬规则都先走一遍：
选项 ≥ 2、答案 ⊆ 选项、单选/判断题只有一个答案、实操至少一条验证规则、考试三项严格性。
一道答案引用了不存在选项的题目会带着"为什么没写"回来，而不是带走同轮另外九道题。

## 6. 顺手修掉的两个真 bug

| bug | 后果 |
|---|---|
| `updateCurriculumQuestion` 不校验任何东西 | 一次 PATCH 可以换掉选项却让答案仍指向不存在的选项：行写进去了，审核满意，判分永远判错——与"学员没做对"无法区分。创建与更新现在共用 `assertQuestionAnswerable` |
| 六个写入口都不撤回 `assessment` 签收 | 确认"题目与实操定稿"之后，模型能在确认背后加十道题、改掉判分规则，而阶段机器仍报告这一步已签收。现在都撤回，并区分重述（逐字段比较） |

## 7. 一处顺带的清理

阶段门禁 `assessment → review` 读审核的 `assess_covers` 层加 `drill_no_objective`，
而不是自己写五条 SQL。理由同 S10：门禁自己判的那一份，会在某天和卡片显示的那一份不一致，
而不一致是看不见的——缺口条说"可以推进"，导出闸门说不行，或者反过来。

## 验证

| 项 | 结果 |
|---|---|
| 规则层新增 | `design-assessment` **59 例**（解析、验证规则按 kind 映射、落点、证据推导、题号、三态改/删、缺口、确认底线、渲染） |
| 步骤层新增 | `assessment-step` **12 例**（写完之后算缺口、只改被指名的、重述不算改动、确认底线、提示词契约） |
| 路由层新增 | `assessment-route` **16 例**（PGlite，断言 `curriculum_question` / `curriculum_lab_task` 的行与签收行；含"挂在章上不写入""按 id 删除""真改动撤回签收""重述不撤回""`assessment → review` 真的推得动"） |
| 存储契约新增 | `curriculum-design-store` **+2 例**（更新路径的选项/答案校验、签收撤回与重述） |
| 测试抓到的真 bug | 第一版把"没提到的列表字段"当成空列表（改题干会清空选项）；`describeVerifyRule` 最初会回退着读别的字段，把评分器根本不看的 `value` 显示出来 |
| 陈旧夹具 | `design-audit` 的两处"健全设计"夹具、`design-editing` / `design-routes` / `curriculum-design-store` 的 walk 补上第七步门禁 |
| agent 侧新增 | `design-tools` 的 `the step sign-offs below the graph` **7 例**（三个工具的拒收与记录，以及**从工具侧一路走到 `review`**） |
| 工具与路由 | 注册表 24 → 27；`runner-voice-registration` 的两份工具清单同步；三个 `*Blockers` 由路由与工具共用 |
| 套件 | `tests/curriculum` **613/613**（31 文件）；`tests/curriculum + tests/persistence` 串行 **893 通过 / 2 失败 / 82 跳过** |
| 那 2 例失败 | `asset-collector-schedule` 的环境问题（本机 `openmaic.yml` 指向未配置的 provider），与本次无关 |
| tsc / eslint / prettier | 全绿 |
| 界面 | 新增 `design-assessment-dialog` + `design-assessment-signoff` + 工作台一张卡片，**未做浏览器端驱动验证**（同 S6–S10：本机 Playwright 期望的 chromium 版本不具备） |
| 活体 walk | **未跑**：需要一个跑着当前模块的 dev server |

## 8. 一个只有宽回归才会发现的洞：门禁有了，工具没有

第四到第六步（大纲、教学内容、评价设计）落地时，每一步都给阶段门禁加了"这一步必须被
签收"，但**agent 侧只有第一到第三步拿到了对应的签收工具**。于是
`advance_course_design_phase` 从 S9 起就拒绝离开 `outline`，理由是一个没有任何工具能
记录的确认——技能文档还写着"每个目标都被讲授就可以推进"。

证据一直是红的：`tests/agent-runtime/design-tools.test.ts` 的两个 lab 测试（它们的
`drillItem` 助手走不到 `teaching`）从 S9 落地那天起就失败。之所以没人看见，是因为
此前几轮的"宽回归"实际只跑了 51 个文件的窄集，而那个文件不在里面——**这与前两步各修过
一次的陈旧助手是同一类问题**：验收命令覆盖不到的地方，红多久都没人知道。

这一步补上 `confirm_course_outline` / `confirm_course_teaching` /
`confirm_course_assessment`，并把两个确认路由里的缺口列表提到状态模块
（`outlineBlockers` / `teachingBlockers`），让**按钮、路由与工具读同一份判定**：
两份判定分歧的那天，按钮说可以确认、工具说不行，而两边看起来都正常。

## 尚未做（继续往后）

- **审核与导出**（第八步）：`review` 阶段目前只有 `/review` 路由与导出闸门，
  "逐条处理 finding"的界面还没有
- `assessment → review` 只要求审核的 `assess_covers` 层干净；**证据行自身的考试严格性**
  （`independent` / `timeLimitSec` / `hintPolicy` 在 `curriculum_evidence` 上）没有查——
  那是第二步的文件，改它要撤回第二步的签收
- 题目与实操的**逐条手工编辑界面**：现在是对话说、卡片读，加上 S5 已有的手工表单
- 覆盖分析那一步的语义重复检测（同 S10）
- 浏览器端驱动验证与活体 walk
