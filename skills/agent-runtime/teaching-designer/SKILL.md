---
name: teaching-designer
title: "教学设计"
description: "Phase 6 of outcome-first course design. Decides what a lecture item actually teaches and how deep: which knowledge is core, which is a mention, which is deliberately out of scope, in what order, with which cases, demos and drills. Use after outline-designer, when items exist and their content has to be planned rather than improvised. Produces the teaching design consumed by deck-designer. Not for the slide plan itself (that is deck-designer) and not for questions or labs."
---

# Teaching design

## Phase lock

You are in **phase 6 (teaching)**. Items exist and their outcomes are bound.
You may write an item's `teachingDesign`. You may not write its pages yet, and
you may not write questions or labs — those are phase 8 and 9, and a question
written before the teaching plan is a question about content nobody decided on.

## The four buckets are the work

Most of the value here is in what you **exclude**. A lecture plan that says
「teach everything relevant」 has not been designed; it is a topic list with
scaffolding. So each item's teaching design sorts its nodes into four buckets:

| Bucket | Meaning | In the deck |
|---|---|---|
| `core` | must be taught in full | most pages |
| `brief` | covered quickly | one page, no depth |
| `mention` | named once, not developed | a clause in the summary |
| `omit` | deliberately out of scope | **not in the deck at all** |

`omit` is the one people skip, and it is the one that makes this a design
rather than a list. Recording what is deliberately left out turns an omission
into a decision: a reviewer can see the course chose not to cover it, rather
than discovering it is missing later. When the graph does not fit the duration
budget, `omit` is where the overflow goes — not a promise of everything at
`brief` depth.

## Sequence, not a list of points

`sequence` is the order things are taught, and the order is an argument:

- **problem before solution.** Open with the situation that makes the thing
  necessary — the login form that is about to be attacked — not the
  definition.
- **concrete before abstract.** A real request, a real error, a real capture;
  then the principle that explains it.
- **mechanism before payload.** They need to know *why* `' OR 1=1 --` works
  before they are told to type it.
- **each section closes what the next one opens.** The comparison table needs
  the two cases already seen.

`cases`, `demos`, `operations` and `drills` are the concrete material the
sequence hangs on:

- `cases` — worked examples, each making one point;
- `demos` — things shown rather than explained (a capture, a failing request);
- `operations` — commands the learner will run;
- `drills` — short practice woven into the lecture, so the item is not a
  monologue. A lecture that runs forty minutes without a single thing to try
  loses the room at minute twelve.

## Scope: node ids, not free text

Every bucket takes **node ids**, not sentences. That is what keeps the teaching
design connected to the graph: when the deck is built from this, the pages are
built from nodes, and a node is either taught somewhere or it is not taught at
all — a property a reviewer can check. Writing 「讲清楚 HTTP 协议的基础」
instead of a node id produces a plan no one can verify.

`prerequisites` lists the node ids assumed known on arrival. It is how a
reviewer spots an item that opens by assuming something no earlier item taught.

## Method

1. `get_course_design` — read the item, the outcomes it teaches, and its nodes.
2. Check the prerequisites against what earlier items actually teach. If this
   item assumes a node nothing teaches, fix the outline, not the wording.
3. Sort nodes into `core` / `brief` / `mention` / `omit`. Most items should
   have a real `omit`. An item with an empty `omit` on a course under time
   pressure is over-scoped.
4. Write `sequence` as an argument, not a list of the node names again.
5. Choose cases, demos, operations and drills that carry that sequence. At
   least one drill in a lecture that is longer than a few pages.
6. `patch_curriculum_unit` with the design.

## Judging the result

Read the four buckets and ask what a learner could do afterwards that they
could not do before, in the item's own terms. If the honest answer is 「they
will have heard of several things」, the item is a `brief` list wearing a
`core` label — move content down until the `core` is what the outcome actually
needs.

Then hand off: `deck-designer` turns this into the page plan, and the page plan
is what the slide generator consumes. Do not write the page plan here — the
step between "what this lesson teaches" and "what each page carries" is where
a lesson turns into a list of titles, and it is worth doing on purpose.

## Related skills

`deck-designer` is next. `understanding-by-design` is worth reading for the
WHERETO framing when you are deciding sequence — where a piece of learning
sits relative to the rest — but keep its enduring-understanding language out of
the outcome records, which have to stay checkable.
