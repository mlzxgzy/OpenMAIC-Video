---
name: deck-designer
title: "课件设计"
description: Phase 7 of outcome-first course design. Turns an item's teaching design into a page-level plan — what each slide must achieve, what it carries, and how it should be presented — which the slide generator consumes as a structured contract. Use after teaching-designer, when a lecture item knows what it teaches but its pages are not planned. Produces deck design. Not for generating the slides themselves (that is content-producer).
---

# Deck design

## Phase lock

You are in **phase 7, the deck design step** of phase 6 (teaching) — the store's `teaching` phase covers both. You may write a lecture item's
`deckDesign`. You may not generate slides, and you may not write questions or
labs.

## A list of titles is not a deck design

This is the step where a lesson most easily degrades into a table of contents.
The difference between the two is whether each page says **what it must
achieve**:

```text
✗  a list of titles
   1. 什么是 SQL 注入
   2. SQL 注入原理
   3. SQL 注入案例

✓  a page plan
   第 1 页  目标：建立问题场景
           内容：一个正常登录的 HTTP 请求，以及它被改写后的样子
           方式：case
   第 2 页  目标：解释参数如何进入 SQL
           内容：username 参数的流转路径
           重点：值从哪来、进到哪去
           方式：diagram
   第 3 页  目标：说明注入为何成立
           内容：正常查询 vs 恶意输入的对照
           方式：compare
   第 4 页  目标：能自己构造一个载荷
           内容：' OR 1=1 -- 的逐段拆解
           方式：explain
```

The second form is a **contract**. `goal`, `coreInfo` and `mode` are what the
slide generator receives instead of a paragraph of intent, which is the
difference between generating a deck that teaches the item and generating a
deck that paraphrases the title.

## The four fields that make a page a page

Every page needs all four. A page missing `goal` is a title; a page missing
`coreInfo` is a topic.

- **`goal`** — what the learner must understand or be able to do when this
  page is done. Write the outcome, not the subject: 「能说出为什么这个载荷
  绕过了认证」, not 「载荷讲解」.
- **`coreInfo`** — the **one** thing this page carries. A page that carries
  two things carries neither; split it. This is the field that keeps a deck
  from becoming a wall of text.
- **`mode`** — how the page should present it:

  | Mode | Use for |
  |---|---|
  | `case` | a concrete situation that makes the problem real |
  | `explain` | the mechanism, stated plainly |
  | `demo` | something shown, not described |
  | `compare` | two things that differ in one decisive way |
  | `diagram` | a process, an architecture, a flow |
  | `summary` | consolidating what came before |

- **`order`** — the sequence, which `teaching-designer` decided. Do not
  re-order here.

Optional, and worth using when they apply: `emphasis` (the specific words or
steps that must land), `visual` (what diagram the page needs, described so a
generator can draw it), `code` (the snippet the page must show — real code, not
a description of code).

## Budgeting pages

`estPages` is an estimate; the plan is the commitment. Two rules:

- **The `core` bucket sets the floor.** Each core node needs at least a page
  and usually two: one to set it up, one to work an example. A lecture with
  four core nodes and six pages is not a fast lecture, it is an outline.
- **The duration sets the ceiling.** Roughly one page per 1.5–2 minutes of
  speaking. A 45-minute lecture is 22–30 pages, not 12 and not 60. When the
  teaching design does not fit the budget, take content out of the deck —
  the buckets in `teachingDesign` are where that decision already lives.

## Structure that works

- **Open with a case, not a definition.** Page 1 is nearly always a
  situation: the request that will be attacked, the error that will be debugged.
- **One page, one point, and check the `coreInfo` is one sentence.** If it needs
  a semicolon, it is two pages.
- **Cases and demos carry the middle.** Abstract explanation of a mechanism
  loses people; the same mechanism shown in a real capture does not.
- **A comparison page earns its place** whenever two things are confused —
  blind vs error-based, GET vs POST, practice vs exam.
- **Close with a summary page** that consolidates, and a page that points at
  what comes next. The next page should set up the next item.

## Method

1. `get_course_design` — read the item's `teachingDesign`: its `core`,
   `brief`, `mention`, `omit`, `sequence`, cases and demos.
2. Draft the page list on that basis. `core` drives the bulk; `brief` gets a
   page each; `mention` is a clause, never a page; **`omit` produces no pages
   at all**.
3. Write every page's `goal` and `coreInfo`. If a page resists having a
   `coreInfo` in one sentence, it is two pages.
4. Set `mode` per page, and add `visual`/`code` where the page needs one.
5. `patch_curriculum_unit` with the `deckDesign`.

## Handing off

`content-producer` consumes this plan to build the stage. Hand it over
unchanged: the plan is the contract, and a generator that is allowed to
reimagine the page structure has thrown away the teaching design that produced
it. If the plan is wrong, fix it here — that is cheaper than regenerating
slides that were built from a page plan you already knew was wrong.
