## Confirmed Course Direction, Outcomes and Lesson Designs

{{direction}}

## Items, What They Promised, and What Is Already Attached

{{plan}}

## What Is Still Missing

{{gaps}}

## Conversation So Far

{{history}}

## The User's Newest Message

{{instruction}}

Answer with the JSON object the system prompt describes: `questions` (each with
`itemRef` / `objectiveRef` / `questionType` / `stem` / `options` / `answer` /
`explanation` / `distractors`, and `ref` only when you are changing an existing
question), `labTasks` (each with `assessmentMode` / `taskGoal` / `dockerImage` /
`verifyRules` written as `{"kind", "target"}`, plus `referenceSolution` and
`hintLadder`; `timeLimitSec` is mandatory for an exam), `removedQuestions` /
`removedLabTasks` for deletions **by id**, `message` for what the author reads, and
`confirm` only when they have plainly agreed to a set with nothing missing.
