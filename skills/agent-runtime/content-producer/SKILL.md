---
name: content-producer
title: "内容生产"
description: Phase 10 of outcome-first course design. Builds the actual classroom from a lecture item's deck design — creates the stage, generates each page in order, writes narration, syncs audio, and renders the video. Use after the design passes its export gate and a course or item needs to exist as a playable classroom. Produces stages, audio and MP4. Not for designing anything.
---

# Content production

## Phase lock

You are in **phase 10, content production**, past the store's final `review` phase. You may create stages, generate pages,
generate audio and render video. You may **not** author outcomes, nodes,
chapters, items, questions or labs. If production reveals that the design is
wrong — a page plan that will not build, an item with no content — go back to
the phase that owns it. Do not patch the content to compensate for a design
defect: a video that works but traces to nothing is exactly the failure this
system exists to prevent.

## The gate comes first

```text
assert_course_design_exportable
```

Not optional, and not "afterwards". It re-runs the review rather than trusting
the last one, because an edit since the last review can reopen a gap. If it
refuses, stop and report what is missing — the design is not ready for
production, and no amount of generation makes it so.

## The deck design is the contract

A lecture item's `deckDesign` is what you consume to build the stage. Each page
becomes a scene, in order, and each page's `goal` / `coreInfo` / `mode` shape
what the page says and how it looks:

| Page field | What it decides |
|---|---|
| `order` | the position, and the order you generate in |
| `title` | the page heading |
| `goal` | what the narration has to accomplish on this page |
| `coreInfo` | the one thing the page carries |
| `mode` | how to present it — `case` opens with a situation, `demo` shows rather than tells, `compare` sets two things side by side |
| `visual` | the diagram to draw |
| `code` | the snippet to show, verbatim |
| `emphasis` | the words or steps that must land |

**Do not reimagine the page structure.** The teaching design decided the
sequence and this plan carries it; a page that is not in the plan is a page
someone decided not to include, and adding it back because it seemed
interesting discards that decision. If a page will not build, fix the plan
with `patch_curriculum_unit` and regenerate — the plan is the editable
artifact, the video is downstream of it.

## The build sequence

Follow the same order every time, so a failure has an obvious place to be:

1. `create_stage` for the item, passing the series `folderId` in the same call
   so it is filed immediately. Keep the returned `stageId` and pass it
   explicitly to every later call — there is no active stage.
2. **Roster.** Who is in the classroom. Do this before pages, not after: the
   voice assignment is per page, and retrofitting it means regenerating audio.
3. `generate_scene` **once per page, in `order`**, never in parallel. Each call
   writes one page; parallel writes to one stage interleave and produce a deck
   in the wrong order.
4. `list_scenes` to verify the page count and order match the plan.
5. `generate_tts` per page, and **check the audio before counting it as done.**
   A page that rendered silently is a page that will export silent.
6. Render the video. `render_scene_preview` for a single page when you only
   need to see whether one page works.

## Before you call it done

- every planned page exists, in order, with content;
- every page has audio — verify, do not assume;
- the page count matches the plan, and no page is a placeholder;
- the stage is filed in the right folder (`list_folder_stages` confirms; if the
  `folderId` was dropped, `move_to_folder` it right away rather than at the end
  of a whole series).

## Reporting

One short paragraph per item: what it now covers, and what the next item starts
from. Then, for the whole run, the links and anything that failed or that you
would do differently. Keep it about the lessons — not tool calls, not ids, not
page counts per call. That recap is the series' memory, and a memory full of
tool detail is a memory that crowds out the content.

## Scaling to a whole course

A 54-item course is 54 of these, and the thing that breaks at that size is not
the generation — it is losing the thread between items. So:

- **`read_stage_outline` on the previous item before starting the next one.**
  Read what was actually built, not what the plan said. The generator's output
  is never exactly the plan, and continuity has to be against reality.
- Produce **one item at a time, to completion**, rather than creating all
  stages first. A run that creates 54 empty stages and then dies has left 54
  half-built classrooms.
- After each item, `list_folder_stages` to confirm it landed in the right
  place. Doing this once at the end of 54 items is how an ungrouped stage goes
  unnoticed for a week.

## Related skills

`course-auditor` if the design needs a check after edits. `stage-design` for a
classroom built outside the course-design flow — a one-off lesson with no
outcomes, where the design machinery would be overhead.
