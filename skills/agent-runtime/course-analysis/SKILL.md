---
name: course-analysis
title: "课程分析"
description: Phase 1 of outcome-first course design. Turns a course request into a brief the user has confirmed and a list of what learners must be able to do independently. Use when someone asks to design, plan or build a course and the brief is not yet settled — "teach our new hires SQL injection defence", "turn this syllabus into a course", "we need a CTF training course". Produces the course task and the capability list that every later phase is measured against. Not for designing a single classroom that already has its plan, and not for editing an existing one.
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
evidence.

## Signing the brief off — the phase is not over when the fields are filled

The brief is seven slots, and they are what the user reads back before anything
is built on them: `title`, `audience`, `learnerLevel`, `applicationScene`,
`problemStatement`, `durationHours`, `trainingScenario`. `learnerLevel`,
`applicationScene` and `trainingScenario` are not gated but they are exactly the
slots a learner would notice are wrong — propose them, say that you proposed
them, and let one sentence correct them.

**A filled-in brief is not an agreed one.** The phase machine refuses to leave
phase 1 until the user has confirmed the card, so the sequence is:

1. write every fact the user states with `patch_course_task` as it arrives, and
   read the card back in your reply;
2. when the user agrees — 「确认」「可以」「就这个」 — call
   `confirm_course_direction`;
3. only then call `advance_course_design_phase`.

Never call `confirm_course_direction` because the fields are complete, or
because you judge the card good: it records *the user's* agreement, and a
confirmation they did not give turns the rest of the design into your plan
rather than theirs. Editing the brief afterwards re-opens the step, so a
correction after the sign-off needs one more confirmation — say so rather than
leaving them to discover the gate.

## Signing the outcome list off — the same rule, on a list

Phase 2 obeys the same rule with one extra hazard. A complete outcome list — every
outcome has a behavior, a minimum criterion and evidence — is still not agreed
until the user confirms it, and the sequence is the same: write with
`create_learning_outcome` / `patch_learning_outcome` / `create_outcome_evidence`,
read the list back, and call `confirm_course_outcomes` only when the user plainly
agrees to it.

The extra hazard is that **the subject is a list, not a fixed card.** A model that
rewrites five outcomes to change one has no field-wise safety valve: every
restatement is a change the user cannot see, and one of them can quietly drop a
minimum criterion and leave the outcome unverifiable. So:

- change only the outcome the request names, and say which one you changed;
- never restate an outcome you are not changing;
- keep each outcome's minimum criteria intact unless the request changes them —
  they are what makes it assessable, not decoration;
- if the user says 「第二条」 and you cannot tell which is the second, ask rather
  than guess: a change on the wrong row is invisible until someone audits the
  whole course.

Editing an outcome or adding evidence re-opens the step, so a correction after
the sign-off needs one more `confirm_course_outcomes` — say so.

## Signing the knowledge graph off — the same rule, on a graph

Phase 3 obeys the same rule again, with one more condition: **the graph must be
connected at both ends.** Every node has to support an outcome *and* every outcome
has to have a node behind it. Work back from each outcome to what it takes to
reach it, create the nodes with `create_learning_node`, wire them with
`set_node_objectives`, read the graph back, and call `confirm_course_knowledge`
only when the user plainly agrees.

Two hazards are specific to this phase:

- **`set_node_objectives` replaces the whole task's link set.** Send every link
  every time, not only the ones you changed. Sending a subset silently deletes the
  rest of the graph, and a graph that lost an edge looks fine until the outline
  stage finds an outcome with nothing to teach.
- **Do not arrange anything here.** No chapters, no items, no teaching order: the
  outline is phase 4. A node is one teachable, checkable thing — 「Web 安全」 is a
  chapter, 「联合查询读数据」 is a node.

Editing a node or a link re-opens the step, so a correction after the sign-off
needs one more `confirm_course_knowledge` — say so.

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
