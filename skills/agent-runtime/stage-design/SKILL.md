---
name: stage-design
title: "课堂设计"
description: The baseline method for building ONE stage — a single classroom — with this runtime, outside any course-design plan. Covers how the plan is settled in conversation, the order the generation tools are called in, how the classroom roster is written, when narration has to be re-synthesized, and what must be true before a stage is called done. Load this before generating or rebuilding any stage from scratch, whatever its subject; it is the floor the topic skills build on, not an alternative to them. Do NOT use it to build a course that has learning outcomes to verify — that path is outcome-first (course-analysis onward).
---

# Building one stage

A stage is one classroom: one settled plan, one roster, one deck of pages. This
is how a stage is built here, whatever its subject.

A topic skill (`deep-interactive`, `vocational`, `deep-research`,
`teacher-style-clone`, …) may shape what the stage contains — its structure, its
page types, how scenes are named — and where one is active its instructions win
on those questions. The sequence below is not one of those questions: it is the
same under every topic skill. Read this one first, then the topic skill.

Nothing here applies to a stage that already has pages. A stage with persisted
pages is edited, not built (see `pro-editing`).

## When NOT to use this skill

This skill builds a classroom from a plan the conversation settles. It does not
design a course.

**If the request involves a course that has to prove anything** — a cohort, a
curriculum, an outcome that has to be examined, a syllabus to turn into
lessons, "we need a training course" — that is the outcome-first path:

```text
course-analysis → outcome-design → knowledge-decomposition → dependency-builder
  → outline-designer → teaching-designer → deck-designer
  → practice-designer → exam-designer → content-producer → course-auditor
```

Start at `course-analysis`. `content-producer` then builds each stage from a
deck design whose pages already say what they must achieve, and
`assert_course_design_exportable` gates the whole thing on the teach–practice–
assess loop actually closing.

The tell that you are in the wrong skill: the deliverable is a **promise about
what someone can do afterwards**. A promise needs evidence, and evidence is
what this skill has no way to produce. If the user just wants a lesson that
explains something, stay here.

## The build sequence

Build a NEW stage only when there are no persisted pages yet. Then, in this
order:

1. **Plan the stage in the conversation.** Propose the page plan yourself —
   each page with its `title`, `type` (`slide` / `quiz` / `interactive` /
   `pbl`) and `brief` (this page's teaching intent and content outline, the
   same information a planned outline slot used to carry) — in page order.
   Settle the plan with the user through `ask_user` before creating anything:
   there is no outline tool to plan with, so the plan is your words and their
   sign-off. A topic skill's structural constraints are a diagnostic the
   runtime checks against the real stage after each page; you decide how to
   act on it.
2. **`create_stage`** with the settled course title (pass the series folder's
   `folderId` when the stage is part of a series, so it is filed in the same
   call). From here on, pass the returned stageId to every stage tool.
3. **`set_roster`**, before any page is generated. Write the classroom the
   user settled: exactly one teacher, at least two agents in total, each with
   a concrete persona (2-3 sentences on personality and teaching/learning
   style, in the stage language) and a voice — call `list_voices` first and
   bind one of the returned `providerId::voiceId` pairs, or the exact pair
   `register_voice` returned for a cloned voice; omit the binding when no
   usable voice exists. Every page's content
   and narration is written for the roster that exists when the page is
   generated, so a roster settled late is a roster half the stage never saw.
4. **`generate_scene` for EACH settled page, in ascending order** — one
   page per call, never more. Pass the page's settled `title`, `type` and
   `brief` (plus `materialFacts` when the page's content comes from attached
   material); no planned outline is needed. A `pbl` page is generated the same
   way and lands as a full PBL project (`projectV2`) from its brief; a failed
   generation reports an error and writes nothing. Each call is the durable
   checkpoint for its page: the page survives an interruption only once the
   call has returned.
5. **`list_scenes`** to verify every page you settled is actually persisted.

None of the planning steps is a place to stop: a turn ends when a page actually
landed, when `ask_user` is waiting on the user, or when the stage is done by the
check below. Reporting what you have planned, imported or confirmed leaves the
user holding an empty deck.

## When `generate_scene` fails

Track generation attempts by `stageId + order`. Changing the title or brief,
or generating another page in between, does not reset the attempt.

- For `prompt-unavailable` or another deterministic failure, do not repeat the
  same call.
- For `invalid-model-output`, change the brief without changing the settled
  teaching intent, then retry once. Retry once for a clearly transient provider
  failure too.
- If that retry fails, do not call `generate_scene` again for that target during
  this run. Leave the page unwritten, continue with later pages in the same
  stage, and name the gap when wrapping up. Do not call `ask_user` after every
  failed page or silently drop the page from the settled plan.

Use `list_scenes` to reconcile persisted pages with the settled plan. A stage
with a missing page can be wrapped up after later pages are built, but it is not
done; name each gap and its latest failure instead of claiming completion.

## Narration audio follows narration text

When a page's narration is written or reworded with `patch_stage` on an
`/actions/...` JSON Pointer, call `generate_tts` on that page. A reworded speech line has
no audio until the page is re-synthesized, so narration text that was changed
and not re-synthesized ships as a silent page.

## Before you call the stage done

Every settled page has to be persisted — a stage is done when the deck is
complete, not when it is planned or half built.

Every speech action must have audio. `read_stage` each page at
`path:/scenes/<order|id>` with `detail:"source"`, check the
`audioId` field on its speech actions, and call `generate_tts` on any page that
is missing it. Read what those actions say while you are there: narration that
talks about material this stage does not teach is a defect, whatever its audio
status. Only then is the stage finished.

When every settled page is persisted, say so to the user in one or two
sentences.

## Related skills

`course-analysis` … `course-auditor` — the outcome-first path, for a course
whose outcomes have to be evidenced and examined. `content-producer` is its
build half, and it consumes a `deckDesign` rather than planning pages in
conversation.
