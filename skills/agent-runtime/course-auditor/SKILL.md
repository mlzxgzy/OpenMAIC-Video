---
name: course-auditor
title: "课程审核"
description: Phase 11 of outcome-first course design. Runs the full design review — missing prerequisites, unevidenced outcomes, outcomes nobody examines, orphan knowledge nodes, teaching out of dependency order, labs graded only by the reference route, duplicate outcomes, unverifiable goals — and the nine-layer quality gate that decides whether a course may be produced. Use before producing content, after editing a design, or when a course needs a second opinion. Produces audit findings and an export verdict.
---

# Course auditing

## Phase lock

You are in **phase 11 (review)**. You may run the review and record the user's
decision about a finding. You may not author design rows to silence a finding:
a finding that is correct must be fixed in the phase that owns it.

There is no "mark as fixed". A review is *derived* — it is recomputed from the
design every time — so a finding disappears on its own once the design is
repaired, and `resolved` is refused for that reason: a live defect is not fixed
no matter who says so. The only decision you can record is `waived`, and it
means the user has accepted this defect and production may proceed carrying it.

## Run it before spending, not after

The whole point of auditing a design is that fixing it is cheaper than
producing it. A course that fails at 「目标缺少先修」 costs one node and a
dependency edge. The same course produced first costs a video, a set of
questions and a lab nobody can grade.

```text
review_course_design                    full findings + quality gate
assert_course_design_exportable         the gate production must pass
set_course_finding_status               accept a finding, or take it back
get_course_design                       see the current state
trace_outcome                           one outcome, both directions
```

Run `review_course_design` after each phase, not only at the end. Most findings
are created by the phase you just finished, and they are trivial to fix there
and expensive to fix later.

## The nine-layer gate

Quality is not a score. It is a chain, and the first break is the one that
matters:

```text
最终目标是否清楚        outcomes exist and are distinct
  ↓
目标是否可验证          expected behavior + criteria + evidence
  ↓
支撑目标的知识/技能是否完整    every outcome has substrate
  ↓
依赖关系是否正确        no cycles, no floating chains
  ↓
课程是否覆盖这些依赖     every outcome is taught
  ↓
教学是否覆盖             teaching designs are real
  ↓
练习是否覆盖             practice exists where it should
  ↓
考试是否验证             every outcome is examined
  ↓
能否从考试结果反推掌握情况   results read back to outcomes
```

A design that breaks at layer 4 has not "mostly passed" because layers 5–9
look fine. Later layers were built on a broken foundation, and their apparent
coverage is meaningless. The review reports **the first broken layer** for
exactly this reason — fixing a later layer while an earlier one is broken
produces coverage numbers that point at the wrong thing.

## The findings, grouped by who can fix them

**Structure of the design**
- `objective_missing_prereq` — an outcome needs knowledge nobody has written
  down. Fix: add the node, wire the edge.
- `orphan_node` — a node serving no outcome. Fix: bind it or delete it;
  usually delete.
- `duplicate_objective` — two outcomes a grader could not tell apart. Fix:
  merge them, or make the boundary real.
- `dependency_cycle` — cannot occur, the store refuses it. Listed for
  completeness.
- `objective_unverifiable` — a promise nobody can check. Fix: add the
  behavior and criteria, or archive it.

**The loop**
- `objective_no_evidence` — promised, never evaluated.
- `objective_not_taught` / `not_practiced` / `not_assessed` — the loop is open
  at that point. This trio is the core metric of the system.
- `evidence_no_artifact` — evidence promised, no question or lab behind it.
  This is what breaks the loop in practice: an outcome can declare lab
  evidence and still have nothing that can be graded.

**Content integrity**
- `lab_no_verify_rules` — nothing can be scored automatically.
- `lab_verify_grades_by_path` — only the reference route passes. The subtler
  version of "no verify rules": a rule that restates the solution steps.
- `dependency_out_of_order` — an advanced item taught before its foundation.
  A correct graph can still be taught in the wrong order.

## Reading the result honestly

Two habits that make audits worthless, and what to do instead:

**Do not waive a finding because it is inconvenient.** `waived` exists for a
decision someone has actually made — 「本题只讲原理，不上机」 is a legitimate
scope decision, and the user is the one who makes it. An audit that waves away
the findings it dislikes is an audit that reports nothing. If you waive one, say
so in the conversation and say why, and remember that every export reports what
it is shipping with: an accepted defect is named on the way out, so accepting one
is never a way to make it invisible.

**Do not treat warnings as errors, or errors as warnings.** `error` blocks
production. `warning` is a real defect that will not stop the build. `info` is
a note. Sorting them into one pile is how a course ships with an unexamined
outcome and a comment saying the reviewer was busy.

## Reporting

Give the user the state of the loop, in outcome terms, not rule codes:

```text
「能够利用 SQL 注入获取指定数据」
   教 ✓ (2.3 原理, 2.4 实操)   练 ✓ (2.4)   考 ✗  ← 无人考核
   支撑：SQL 执行原理 / 注入识别 / Payload 构造
   问题：没有实操考试，这条承诺无法验证
```

That is the artefact worth having. "7 open findings" is a queue; this is a
statement about the course.

## When the review passes

Say what is now guaranteed, in the same terms: every outcome is taught,
drilled and examined; every exam result reads back to a named outcome; no
learner is asked to do something the course never taught. Then production may
begin — `content-producer`, after `assert_course_design_exportable`.
