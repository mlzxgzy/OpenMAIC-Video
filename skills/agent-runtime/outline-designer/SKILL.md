---
name: outline-designer
title: "大纲设计"
description: Phase 5 of outcome-first course design. Converts the learning dependency graph into chapters and items, decides for each outcome what gets taught, drilled and examined, and records the teach/practice/assess links that close the loop. Use after dependency-builder, when the graph is correct and the question becomes how to teach it. Produces chapters, items and coverage links. Not for filling an item's content (that is teaching-designer).
---

# Outline design

## Phase lock

You are in **phase 5 (outline)**. The dependency graph is settled. You may
create chapters, items and their coverage links. You may not write teaching
content or questions yet.

## The outline is a rendering, not the source

> **The dependency graph is the course's real structure. Chapters and items are
> how it is shown to a learner.**

Deriving the outline *from* the graph is what makes the course's logic
checkable. Building the outline first and asking the graph to justify it
afterwards is the failure this whole system exists to prevent — it produces a
table of contents with knowledge poured into it afterwards, and nothing in it
can be traced back to a promise.

So: read the graph, and ask what the teacher has to put in front of a learner
for the graph to be walkable.

## Chapters classify. Items teach.

A **chapter** groups related content and carries **none of its own**. A
trigger in the database refuses content on a chapter, because a chapter that
also teaches is a chapter whose boundaries will drift — some of it ends up in
the neighbouring chapter, and then the outcome it serves is taught in two
places, half of each.

```text
第二章 Web 安全                 ← chapter: 主题、阶段、能力领域
  2.1 HTTP 与请求解析            ← item [lecture]   teaches 理解 HTTP 请求
  2.2 目录与源码信息收集          ← item [practice]  drills  信息收集技能
  2.3 SQL 注入原理              ← item [lecture]   teaches 注入原理
  2.4 SQL 注入实操              ← item [practice]  drills  注入利用
  2.5 SQL 注入考核              ← item [exam]      assesses 独立完成注入任务
```

## Do not mechanically alternate lecture/practice/exam

The tempting pattern is one lecture, one drill, one exam per topic. Resist it.
A learner does not need an exam after every lecture, and a course built that
way is padded to its own structure rather than to its outcomes.

Decide from the outcome and its evidence:

- **Teach** it when the learner could not attempt the task at all without it.
  Every outcome needs at least one `teach` — this is the gate for the next
  phase, and an untaught outcome is a promise the course never keeps.
- **Drill** it when the skill is performed and the failure is recoverable.
  Practise where errors are cheap and repetition helps.
- **Examine** it when the point is whether the learner can do it **unaided**,
  and the result can be checked without a human. This is the one that is easy
  to skip and hardest to retrofit.

An outcome can be taught across several items (a principle in one, its
application in another) and can be assessed once at the end. What it cannot do
is reach `review` with any of the three missing.

**Bind every coverage link with `create_unit_coverage`.** This is the traceable
link from a promise to the moment a learner meets it, and it is what
`trace_outcome` and the heat matrix read. An item that exists without a
coverage link teaches nothing as far as the system is concerned.

## Making the graph teachable

Topologically, the graph is correct. Now the human constraint: the whole graph
in order is often longer than the course allows. Two things to decide.

**Clustering.** Nodes that share a stage of understanding become a chapter.
The test: could you title the chapter 「X 之后，学员应该能 Y」? If not, the
clustering is topical rather than developmental, and it will produce a course
that interleaves two progressions and confuses everyone.

**Duration is a real budget.** `durationHours` from the brief is the constraint
that forces decisions. When the graph does not fit, the answer is to move
something into a later item and record it in the item's `omit` — not to
promise everything at `brief` depth, which produces a course where every topic
is announced and none is taught.

**Order the items with `create_unit_dependency`.** A correct graph can still be
taught in the wrong order, and the review checks for it: an advanced item
before its foundation is a real defect that a cycle check cannot see.

## Method

1. `get_course_design` — read the graph and the outcomes.
2. Decide the chapters. Title each for a stage of understanding.
3. Create items, one teaching unit each, with `unitRole`.
4. For every outcome, create the `teach` links first, then `practice`, then
   `assess`. Read the outcome list as you go — the point at which you cannot
   say "how is this examined" is the point where the course design is not done.
5. Add `create_unit_dependency` edges for the item order.
6. `advance_course_design_phase` when every outcome is taught somewhere.

## A worked example of the decision

Outcome: 「能够独立完成一个基础 Web CTF」, evidence: lab, 「取得 flag 且过程包含信息收集」.

- **taught** — HTTP 与请求解析 (lecture), 信息收集方法 (lecture): without
  these the learner cannot even start.
- **drilled** — 目录扫描实操 (practice), 抓包练习 (practice): repeatable,
  cheap to retry, and the failures are instructive.
- **assessed** — 基础 Web CTF 靶场 (exam): a lab, unaided, graded by whether
  the flag is obtained — **not** by whether they took the same route the
  reference solution takes.

Three links, three different items, and the exam is not a smaller copy of the
practice: it has no hints and no retry.
