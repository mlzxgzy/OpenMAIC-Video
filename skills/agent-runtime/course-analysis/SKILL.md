---
name: course-analysis
title: "课程分析"
description: Phase 1 of outcome-first course design. Turns a course request into a completed brief and a list of what learners must be able to do independently. Use when someone asks to design, plan or build a course and the brief is not yet settled — "teach our new hires SQL injection defence", "turn this syllabus into a course", "we need a CTF training course". Produces the course task and the capability list that every later phase is measured against. Not for designing a single classroom that already has its plan, and not for editing an existing one.
---

# Course analysis

## Phase lock

The design order is fixed and enforced by the store, not by good intentions:

```
brief → outcomes → evidence → knowledge & skills → dependency graph
      → outline → teaching & deck design → questions & labs → review
```

You are in **phase 1 (task)** — the brief phase. Produce the brief and the capability list, and
nothing else. Creating a chapter, an item, a slide or a question here is out of
order: the store will refuse it, and it would be wrong anyway — a structure
built before anyone has said what the learner must end up able to do is a
guess with page numbers on it.

## What "the brief" has to settle

`create_course_task` takes more than a title, and three of its fields are what
the next phase is gated on:

- **audience** — who is being trained, concretely enough that "a developer"
  and "a sysadmin who has never written code" are not the same course;
- **durationHours** — the real budget, because it is what forces trade-offs
  later: what gets taught in full, what gets mentioned;
- **problemStatement** — the problem the course exists to solve.

Ask for these in **two or three rounds of `ask_user`**, not one form. What you
ask second depends on what they answered first; you cannot offer 「实操为主还是
理论为主」 before you know whether they have ever used a terminal. Round 1 is
who and why; round 2 is the shape that answer implies; round 3 only when
something real is still undecided.

Rules for every round:

- **Never ask what the request already settled.** State it as your decision for
  them to overrule — 「默认中文讲授」 costs no round.
- **The question is the tool call.** Writing questions into prose ends the run
  with nothing to answer with. One `ask_user` per round, at most three big
  things in it.
- Open each round by saying what you took from the last one, so it reads as a
  conversation rather than a questionnaire.

## The capability list — the real output of this phase

Once the brief is settled, the question that decides the whole course is not
"what should we teach" but:

> **What can someone do, on their own, after this course that they cannot do now?**

So produce a list of **independent capabilities**, each a concrete act:

```
能够独立完成基础 Web CTF 题
能够分析简单 SQL 注入
能够识别常见漏洞
能够使用工具完成漏洞验证
```

Not this:

```
了解 Web 安全
熟悉常见工具
了解 CTF 的发展
```

The test is whether you can picture someone doing it, unsupervised, and being
checked on the result. If you cannot picture it, it is a topic, and a topic is
not a capability.

**Where this list goes.** It is not a design phase of its own — it is the raw
material for phase 2. Do not create outcomes yet: `outcome-design` does that,
and it turns each capability into an outcome with the behavior and criteria
that make it checkable. Put your list in the conversation, confirm it with
`ask_user` — capabilities are the one thing worth getting sign-off on before
spending effort, because every later phase is measured against them — and hand
on.

Tell the user, in one short paragraph: the settled brief, the capability list,
and that the next step turns each capability into a verifiable outcome with its
evidence. Then call `advance_course_design_phase` once the brief fields are in.

## When the request is one classroom, not a course

A single lesson is a different shape. If the user wants one classroom for one
session, this is the wrong skill: that is `stage-design`, and the design-phase
machinery is overhead. Use this when there is a cohort, a curriculum, a
capability to build across several sessions — or when the user says 「课程」 and
means something that has outcomes at all.

## Related skills

`outcome-design` is the next phase. `understanding-by-design` is available as
reference material for framing a course around transferable understanding, but
its enduring-understanding language is not the outcome model — see that skill's
note on the difference.
