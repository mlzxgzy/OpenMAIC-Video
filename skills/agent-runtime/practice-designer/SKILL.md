---
name: practice-designer
title: "练习设计"
description: "Phase 8 of outcome-first course design. Designs the drilling half of the teach-practice-assess loop: theory questions bound to one outcome each with the misconception behind every wrong option, and hands-on lab tasks with a Docker environment and machine-checkable verify rules. Use after teaching-design, when an item needs something to train the learner. Produces practice-mode questions and labs. Not for exams (that is exam-designer)."
---

# Practice design

## Phase lock

You are in **phase 8 (assessment)** and this half of it is practice. You may
create questions and labs with `assessmentMode: 'practice'`. An exam is the
same shape under a different contract — `exam-designer` owns it, and the
difference is not cosmetic (see below).

## Practice is not a smaller exam

| | Practice | Exam |
|---|---|---|
| Purpose | train | decide |
| Hints | available, on a ladder | forbidden |
| Retries | unlimited | one attempt |
| Time | untimed | limited |
| Result | feedback | a score that counts |

The database enforces the right-hand column for exams. For practice, the
obligation runs the other way: **a practice task with no hints and no retry is
a learner being tested while they are still learning, which is a different
thing and usually a mistake.**

## Theory questions

Every question binds to **exactly one** outcome. That is the whole discipline:
a question nobody can trace to an outcome is decoration, and a question bound
to three outcomes tells you nothing about any of them.

Write the **misconception behind each wrong option**:

```text
题干   以下哪个是布尔盲注与时间盲注的区别？
选项A  两者都需要页面回显          ← distractor: 以为盲注仍会回显
选项B  布尔盲注看回显真假，时间盲注看响应时间   ✓
选项C  时间盲注更准确               ← distractor: 以为延时法精度更高
选项D  两者完全等价                ← distractor: 没区分错误来源
解析   布尔盲注靠页面长度的差异判断条件，时间盲注靠响应延时……
```

The `distractors` field is what turns feedback from 「你选错了」 into 「你
以为盲注仍会回显，所以选了 A」. Without it a question can only mark a letter,
and the learner fixes it by guessing differently next time rather than by
understanding. This is the difference between a question bank and assessment.

Mix the three types deliberately: `single` for facts and definitions,
`multiple` for things that are jointly necessary, `true_false` for
clarifying a misconception directly. Set `difficulty` and `bloomLevel` to the
outcome's — a `remember` question does not verify a `create` outcome, and the
review will notice.

**Coverage:** 8–12 questions per lecture item is a reasonable default, spread
across the outcomes that item teaches, weighted toward the `core` nodes.

## Lab tasks

The structure that matters:

```text
taskGoal            任务目标          获取 /flag
brief              题目描述          给定环境与约束
objectiveId        关联目标          which outcome this trains
dockerImage        环境
verifyRules        验证规则          ← THIS decides the result
keyBehaviors       关键行为          for process credit
scoreRules         评分规则
hintLadder         提示阶梯          practice only
referenceSolution  参考解法          ← NEVER grades
```

### The separation that makes labs usable

`referenceSolution` and `verifyRules` are two different things stored as two
different types, and the reason is that **a lab usually has many correct
routes**:

```text
参考解法（给学员看、给讲师参考）
  1. 发现注入点
  2. 判断为布尔盲注
  3. 构造 Payload 逐位判断
  4. 读取 flag

验证规则（决定成绩的唯一依据）
  flag: 读取到正确的 flag 值
```

If grading followed the reference steps, every learner who found a faster route
— a tool, a different injection point, a smarter payload — would be marked
wrong despite having solved the task. So:

- **`verifyRules` must be satisfiable by any correct route.** Ask "what state
  is true at the end if the learner succeeded?", not "what did they do?".
- **A verify rule that restates the reference steps is the most common defect
  in lab design**, and the review reports it. `process_exec` with an exact argv
  is only legitimate when the task genuinely requires that one command — which
  is rarer than it looks.
- Use `keyBehaviors` for process credit instead: "the run shows real injection
  behaviour" is fair to score; "they ran our payload" is not.

`scoringMode` picks what counts: `result` (did they finish), `process` (how
they got there), `key_step` (did they hit the decisive moments), `time`,
`mixed`. For a first drill, `result` is honest. For something meant to build
method, `mixed` with a couple of key behaviors.

### Hints are a ladder, not a button

`hintLadder` reveals in order, each one costing less than solving it blind.
Level 1 points at the category of approach, level 3 is close to the answer.
A single hint that gives the payload turns a drill into a typing exercise.

## Method

1. `get_course_design` — read the outcomes this item teaches, and their
   evidence. The evidence already says what kind of proof was promised; match
   it.
2. For each outcome the item should drill, decide: is the failure mode
   conceptual (a question) or procedural (a lab)? Often both.
3. Write questions, one outcome each, with distractors.
4. Write labs: environment first, then **verify rules**, then the reference
   solution. In that order — the reference solution is easier to write first
   and it is the wrong way round, because it invites you to grade by its steps.
5. Review each lab against the test: *would this pass a learner who solved it a
   completely different way?* If not, the verify rules are wrong.
6. `patch_lab_task` as you refine.

## Before you move on

`review_course_design` will report labs with no verify rules, and labs whose
rules only accept the reference route. Both are this phase's failures, and both
are fixable here. Run it before `exam-designer` — the exam for a poorly drilled
skill is an exam of a skill nobody practised.
