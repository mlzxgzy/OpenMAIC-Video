---
name: outcome-design
title: "目标设计"
description: Phase 2 of outcome-first course design. Turns each capability into a learning outcome that can be verified, and binds the evidence that would prove it. Use after course-analysis has settled a brief, when you need to write outcomes that say what a learner will be able to DO and how you will know — not a list of topics. Produces learning outcomes and their evidence. Not for breaking outcomes into knowledge and skills (that is knowledge-decomposition), and not for writing chapters.
---

# Outcome and evidence design

## Phase lock

You are in **phase 2 (outcomes)**. You may create learning outcomes and their
evidence. You may not create knowledge nodes, chapters or items — the store
refuses them, and they are downstream of decisions that are not made yet.

## The rule the whole system rests on

> **An outcome is not a topic. It is a promise plus the evidence that settles it.**

Two halves, and neither is optional:

```text
outcome  →  what the learner can DO   (expectedBehavior + criteria)
evidence →  how you will know they did (verificationMethod + successCondition)
```

An outcome without evidence is a wish. Evidence without an outcome is a quiz
about nothing. Design them together or you will discover at phase 9 that a
third of the course cannot be examined.

## Writing an outcome that can be verified

**The banned form** is a topic wearing an outcome's clothes:

```
了解 SQL 注入          ✗  了解什么？掌握到什么程度？谁能判断？
掌握 Web 安全          ✗  范围无边，无法判定达成
熟悉 GDB               ✗  熟悉是感觉，不是行为
```

**The working form** names a behaviour you could watch happen:

```
能够利用 SQL 注入完成指定任务
  预期行为  能识别注入点、判断注入类型、构造有效 Payload、获取指定数据、解释成因
  最低标准  能构造 Payload 并取回指定数据
  熟练标准  能判断注入类型并在报错环境下完成提取
  优秀标准  能解释成因，并对参数做最小化处理
```

The store enforces the minimum of this: an outcome cannot be marked verifiable
without an `expectedBehavior` and at least one `minCriteria`. It will tell you
so, and it will keep saying it belongs to a course that nobody can examine.
Write the behavior first; the criteria are just the bands of a rubric.

### Three tiers, and the third is not optional

`minCriteria` / `proficientCriteria` / `excellentCriteria` are the difference
between a pass and a grade. With only a minimum you can answer "did they get
there", which is enough to pass and not enough to teach. Fill all three unless
the outcome is genuinely binary.

### Choose the right type

| Type | Means | Example |
|---|---|---|
| `knowledge` | must understand | 理解 SQL 注入为何发生 |
| `skill` | must be able to perform | 能够构造 SQL 注入 Payload |
| `competency` | must complete independently | 能够独立解决一个 SQL 注入 CTF |
| `task` | produces an external result | 成功读取 `/flag` |

A competency is an **outcome**, never a knowledge node. Getting this backwards
is the single most common structural error in this model, and the node tools
only accept `knowledge` and `skill` precisely so it cannot happen silently.

## Evidence: decide it before designing any content

For each outcome, ask: **what would I accept as proof?** Then bind it with
`create_outcome_evidence`.

- **A lab** for anything performed — `evidenceType: 'lab'`, with a
  `successCondition` in terms of an outcome in the environment, not a step
  sequence. 「成功读取 /flag」 is a condition; 「执行第 1 到 4 步」 is not, and
  it would fail every learner who found a different route.
- **A quiz** for anything explained — `evidenceType: 'quiz'`.
- **Practice or exam** decides the contract, not the topic: `assessmentMode:
  'practice'` trains and may hint; `'exam'` is independent, hint-free and
  scored. The database refuses hints or retries on an exam.

Every outcome needs at least one piece of evidence before the graph phase
opens. If an outcome has none, that is the signal it is not yet really an
outcome — either make it checkable or archive it.

## Method

1. `get_course_design` to see the brief and what exists.
2. For each capability from `course-analysis`, write **one** outcome. Resist
   splitting one capability into four: if two outcomes cannot be told apart by
   a grader, they are one outcome, and the review will report them as duplicates.
3. Decompose a broad competency with `parentId` rather than by inventing a
   flat list — a course-level outcome with component outcomes under it is a
   structure a reader can follow, and the review checks that a parent is not
   an untaught leaf of its own.
4. Write `expectedBehavior` and all three criteria bands.
5. Bind evidence to every outcome.
6. `advance_course_design_phase` when each outcome has evidence.

## Before you advance

Read back the outcome list in the conversation and check it against the
capability list from phase 1. Two questions decide whether phase 2 is done:

- Is every capability from the brief an outcome, or absorbed into one?
- Can a grader tell, for each outcome, what passing looks like?

If either answer is no, the fix is here — not later, and not by adding content.

## Related skills

`knowledge-decomposition` is next. `understanding-by-design` is reference
material: its 「持久理解 / 基本问题」 framing is useful for a course's
underlying ideas, but an enduring understanding has no pass/fail condition, so
it cannot be the objective record — keep it as input to `teaching-designer`.
