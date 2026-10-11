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