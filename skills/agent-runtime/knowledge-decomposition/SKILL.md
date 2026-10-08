---
name: knowledge-decomposition
title: "知识技能拆解"
description: Phase 3 of outcome-first course design. Works backwards from each learning outcome to the knowledge and skills that must be in place for it, and binds each node to the outcomes it serves. Use after outcome-design has produced verified outcomes with evidence, when you need to know what has to be taught for an outcome to be reachable. Produces knowledge and skill nodes. Not for ordering them (that is dependency-builder) and not for arranging them into chapters.
---

# Knowledge and skill decomposition

## Phase lock

You are in **phase 3 (graph)**. You may create knowledge nodes, skill nodes and
their links to outcomes. Outcomes and evidence are already settled — if you
find yourself wanting to change one, go back through `patch_learning_outcome`
and re-run the review, do not quietly reshape the substrate to fit.

## Working backwards, not forwards

The question this phase answers is not "what should we teach" but:

> **To be able to do X, what must already be in the learner's hands and head?**

So take one outcome and ask what would fail without each piece:

```
能够利用 SQL 注入获取指定数据
  ← 构造有效 Payload           (skill)
  ← 判断注入类型               (skill)
  ← 识别注入点                 (skill)
  ← 理解 SQL 注入原理          (knowledge)
  ← 理解 SQL 查询如何执行      (knowledge)
  ← 理解 HTTP 请求与参数       (knowledge)
  ← 理解数据库与表结构         (knowledge)
```

Each line is a node. The last three are not there because they are related
topics — they are there because a learner without them cannot reach the first.

**Only two node types exist, and the split is the point.**

| Type | The learner… | Example |
|---|---|---|
| `knowledge` | understands | SQL 注入原理 |
| `skill` | can perform | 构造 SQL 注入 Payload |

A **competency is an outcome, not a node**. 「能够独立解决 SQL 注入 CTF」 is
what the course promises; it is already an outcome. If you catch yourself
creating it as a node, you are about to give a course a chapter whose only
content is "do the thing the course promises", which teaches nothing and
duplicates the outcome. The store only accepts `knowledge` and `skill` for
exactly this reason — report the problem, do not work around it.

## Every node must serve someone

After creating a node, bind it with `set_node_objectives`. `primary` means this
node is the main way the outcome is reached; `secondary` means it contributes
but does not carry it.

A node that serves no outcome is an **orphan**, and the review will report it
as one. That is a real defect, not a formality: an orphan is content nobody
came for and nothing is checked against. When you find one, either bind it or
delete it — the honest answer is usually to delete it, because orphans are
usually a node that was created because it felt relevant rather than because
some outcome needed it.

## Breadth is not thoroughness

Two failure modes, opposite each other:

- **Too coarse.** One node named 「SQL 注入」 covering an entire chapter. It
  cannot be given a depth, cannot be ordered against its own prerequisites,
  and cannot be traced to what it teaches.
- **Too fine.** Sixty nodes where a learner would recognise thirty. Each
  fragment needs its own teach decision later, and the outline drowns.

Aim for a node at the scale a competent practitioner would name it. 「HTTP
请求与响应」 is a node. 「HTTP」 is not; 「HTTP 头字段 X-Forwarded-For 的
语义」 is probably a `mention`, not a node.

## Method

1. `get_course_design` — read every outcome and its evidence.
2. Take the outcomes **in dependency-relevant order**, starting from the
   broadest competency. For each, ask what must be in place and create those
   nodes.
3. Bind each new node to its outcomes.
4. When an outcome ends up with no nodes at all, stop: it is unreachable, and
   the fix is more nodes, not a different outcome.
5. Do not order anything yet. That is the next phase.

`dependency-builder` runs the cycle check and the gap analysis. Run
`review_course_design` when the set looks complete — it will tell you about
outcomes with no substrate and nodes that serve no one, which are the two
defects this phase can create.
