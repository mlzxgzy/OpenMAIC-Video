---
name: exam-designer
title: "考试设计"
description: Phase 9 of outcome-first course design. Designs the assessing half of the loop — theory papers and hands-on exams that decide whether an outcome is actually met, with independent completion, no hints, time limits and scoring rules. Use after practice-designer, when a skill has been drilled and is ready to be judged. Produces exam-mode questions and labs. Not for drills (that is practice-designer) and not for content production.
---

# Exam design

## Phase lock

You are in **phase 8/9 (assessment)** and this half of it is examination. You
may create questions and labs with `assessmentMode: 'exam'`. The database
enforces the exam contract, so this skill is about **what is worth examining
and how it is scored**, not about policy flags.

## The data model is shared; the contract is not

A practice and an exam are the same record with different fields set. What
differs is what the learner is being asked to prove:

| | Practice | Exam |
|---|---|---|
| Proves | they are learning | they can do it |
| Hints | a ladder | forbidden |
| Retries | unlimited | none |
| Time | untimed | limited |
| Result | feedback | a verdict |

A database trigger refuses `hintPolicy: 'unlimited'` or `allowRetry: true` on
an exam, so the policy half cannot be got wrong by accident. What can still be
got wrong is everything below.

## What to examine

**Examine outcomes, not topics.** An exam item exists to answer a question
about a promise the course made. If you cannot name the outcome, you are
writing a revision quiz, which is a different artifact with a different
purpose.

**Examine the ones worth judging.** Not every outcome needs an exam:

- a capability the course exists to deliver — **yes**, always;
- a skill practised many times and worth certifying — yes;
- a fact stated once and never built on — no, a question is enough, and making
  it a timed exam item spends a scarce slot on something trivial.

Aim for the course-level competencies to be covered. A 54-hour course whose
exam only checks the first chapter is a course that cannot say whether it
worked.

## Theory exams

Same discipline as practice questions, with the stakes changed: one outcome
per question, `distractors` still required, and the mix should now be
**analysis and evaluate** rather than remember and understand. An exam that
only asks learners to recall what the slides said measures compliance with the
course, not capability.

Set `score` deliberately. Equal scores make a paper that is mostly recall look
identical to one that is mostly analysis.

## Practical exams

The structure is the lab task under exam conditions:

```text
assessmentMode  'exam'          forced
hintPolicy      'forbidden'     forced
allowRetry      false           forced
timeLimitSec    required        your decision
dockerImage     required        your decision
verifyRules     required        your decision
keyBehaviors    for process credit
scoreRules      how the marks divide
```

### Grading an open-ended hack

The hard problem in a security course is that the task has many routes. The
answer is to grade the **end state**, and to use process credit only for
behaviours that are genuinely part of the skill:

```text
verifyRules   flag: 读取到正确 flag
              env_state: 数据库权限已提升        ← only if that IS the skill
keyBehaviors  存在真实的注入尝试                 ← for process credit
              使用了工具而非手工猜测              ← a real distinction
scoreRules    result 60 / process 40
```

The distinction worth making: **process credit is for thinking, not for
typing.** 「他们真的在尝试注入，而不是在猜」 is fair. 「他们用了我们那条
payload」 is not — it measures recall of a course, not capability.

And keep `referenceSolution` for the writeup. It is what a reviewer reads to
understand the task, not what a learner's result is compared against.

### Time limits

Set them from the task, not from habit. A reasonable exam lab is 1.5–2× the
median time a practised learner would need, not 1.5× the reference solution's
time — a reference solution written by someone who already knows the answer is
systematically faster than a first-time solver, and grading against it fails
learners who did the work.

## The result must be readable back to the outcome

This is the property that makes the whole system coherent: a learner's exam
result should tell you **which outcomes were met and which were not**, with no
interpretation. That falls out of the structure if every item is bound to one
outcome and scoring is per-item:

```text
能够利用 SQL 注入获取指定数据   ✓  met
能够解释注入成因               ✗  not met   ← 二选一 20 分中错 8 分
能够识别常见编码绕过           ✓  met
```

If you cannot produce that table from your design, the exam is not measuring
the outcomes it claims to.

## Method

1. `get_course_design` — read which outcomes are already `teach`-ed and
   `practice`-d, and their evidence. **An exam for an undrilled skill is a
   mistake** — practise first, then assess.
2. For each outcome worth examining, create the item(s) with
   `assessmentMode: 'exam'`.
3. Set time limits, scoring modes and process credit.
4. `assert_course_design_exportable` — the gate. It re-runs the whole review,
   so it catches anything left open, and it is the same check production must
   pass.
5. Fix every `error`-severity finding. Not the warnings — the errors. A design
   that breaks the quality gate cannot be produced, and that refusal is
   deliberate.

## Then

`content-producer` builds the stage from the deck design and runs generation.
`course-auditor` can be run at any point — but its job is to tell you the
design is broken, so run it before you spend anything on content, not after.
