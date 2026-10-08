/**
 * Outcome-first curriculum design tools — the backend half of "the agent
 * designs a course, not just its slides".
 *
 * The multi-stage tools next door (curriculum-tools.ts) build classrooms:
 * folders, stages, page outlines. Those are the presentation layer. These
 * tools are the layer underneath it, and they exist because the model that
 * runs a course is the only one positioned to make the design decisions —
 * which outcomes the course promises, what evidence proves each one, which
 * knowledge and skills back them, in what order, and how each is taught,
 * drilled and examined.
 *
 * Four properties are deliberate and load-bearing:
 *
 * **Tools are phase-shaped, not table-shaped.** The store refuses to author a
 * later phase's rows while the task sits in an earlier one. That is what
 * stops "create the chapters first, fill in the knowledge points later" — the
 * failure mode the whole redesign exists to remove. Each tool therefore names
 * the phase it writes, and the phase tools report what is still missing rather
 * than letting an agent discover it by hitting a wall.
 *
 * **Writes are granular, reads are snapshots.** An agent designing 54
 * outcomes, 200 nodes and 80 items makes hundreds of narrow calls; each one
 * returns the id it minted. `get_design_snapshot` is the single read that
 * returns the whole model, because an agent reasoning about a dependency graph
 * or a teach/practice/assess gap needs the whole graph, not a page of it.
 *
 * **The audit is a tool, not a background job.** `review_course_design` is how
 * an agent learns its design is broken before a user finds out — it returns the
 * same 21 rules and the same nine-layer quality gate the S2 logic layer defines.
 * `assert_course_design_exportable` is the gate generation must pass.
 *
 * **Every id is owner-scoped and fail-closed.** A task belonging to another
 * tenant, or one that does not exist, produces one indistinguishable refusal:
 * the text never reveals which.
 */
import { Type, type Static } from 'typebox';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import type { Queryable } from '@openmaic/storage/document/pg';

import {
  CURRICULUM_DESIGN_PHASES,
  type CurriculumDesignPhase,
  type CurriculumDesignSnapshot,
  type LabKeyBehavior,
  type LabScoreRule,
  type LabVerifyRule,
} from '@/lib/curriculum/design-types';
import { CURRICULUM_QUALITY_LAYERS } from '@/lib/curriculum/audit';
import { traceFromObjective } from '@/lib/curriculum/traceability';
import {
  CurriculumDesignNotFoundError,
  CurriculumDesignValidationError,
  CurriculumPhaseError,
  advanceCurriculumTaskPhase,
  createCurriculumDependency,
  createCurriculumEvidence,
  createCurriculumLabTask,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumQuestion,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  createCurriculumUnitDependency,
  getCurriculumDesignProvider,
  getCurriculumDesignSnapshot,
  listCurriculumTasks,
  phaseCompletionGaps,
  assertCurriculumDesignExportable,
  reviewCurriculumTaskDesign,
  setCurriculumNodeObjectives,
  updateCurriculumLabTask,
  updateCurriculumObjective,
  updateCurriculumTask,
  updateCurriculumUnit,
} from '@/lib/server/curriculum/design-store';

// ── Tool deps ─────────────────────────────────────────────────────────────────

export interface CurriculumDesignToolDeps {
  /**
   * The design store's queryable. Defaults to the server persistence pool, so
   * a caller that has no pool of its own can omit it — the toolset resolves
   * the same S1 entry point the rest of the curriculum server code uses.
   */
  queryable?: Queryable;
  /** The session owner; every task access is scoped to it. */
  ownerId: string;
}

// ── Params ────────────────────────────────────────────────────────────────────

const TaskIdParams = Type.Object({
  taskId: Type.String({
    description: 'A course task id from create_course_task or list_course_tasks.',
  }),
});

const ObjectiveIdParams = Type.Object({
  objectiveId: Type.String({ description: 'A learning outcome id from the design snapshot.' }),
});

const CreateTaskParams = Type.Object({
  title: Type.String({ description: 'Course title, e.g. "CTF 综合实战".' }),
  audience: Type.Optional(Type.String({ description: 'Who is being trained, concretely.' })),
  learnerLevel: Type.Optional(Type.String({ description: 'Their starting level.' })),
  trainingScenario: Type.Optional(
    Type.String({ description: 'The setting the training runs in.' }),
  ),
  durationHours: Type.Optional(Type.Number({ description: 'Total training hours.' })),
  applicationScene: Type.Optional(
    Type.String({ description: 'Where the capability gets used afterwards.' }),
  ),
  problemStatement: Type.Optional(
    Type.String({
      description: 'The problem the course exists to solve. Required before outcomes.',
    }),
  ),
});

const PatchTaskParams = Type.Object({
  ...TaskIdParams.properties,
});

const CreateObjectiveParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  parentId: Type.Optional(
    Type.String({ description: 'Parent course-level outcome id, for decomposing a capability.' }),
  ),
  code: Type.Optional(Type.String({ description: 'Stable human code, e.g. "O-2-1".' })),
  title: Type.String({ description: 'Short outcome title.' }),
  description: Type.Optional(Type.String({ description: 'What this outcome covers.' })),
  objectiveType: Type.Union(
    [
      Type.Literal('knowledge'),
      Type.Literal('skill'),
      Type.Literal('competency'),
      Type.Literal('task'),
    ],
    {
      description:
        'knowledge = understands X; skill = can perform X; competency = independently completes X; task = produces result X.',
    },
  ),
  bloomLevel: Type.Optional(
    Type.Union(
      [
        Type.Literal('remember'),
        Type.Literal('understand'),
        Type.Literal('apply'),
        Type.Literal('analyze'),
        Type.Literal('evaluate'),
        Type.Literal('create'),
      ],
      { description: 'Cognitive level of the expected behavior.' },
    ),
  ),
  level: Type.Optional(
    Type.Union([Type.Literal('course'), Type.Literal('component')], {
      description: 'course = top-level promise; component = a piece of one. Default component.',
    }),
  ),
  expectedBehavior: Type.Optional(
    Type.String({
      description:
        'The observable behavior that would let someone decide the outcome is met. Without it the outcome cannot be marked verifiable.',
    }),
  ),
  minCriteria: Type.Optional(
    Type.Array(Type.String(), {
      description: 'Minimum criteria — what the learner must do at all to pass.',
    }),
  ),
  proficientCriteria: Type.Optional(Type.Array(Type.String())),
  excellentCriteria: Type.Optional(Type.Array(Type.String())),
  difficulty: Type.Optional(
    Type.Union(
      [
        Type.Literal('intro'),
        Type.Literal('basic'),
        Type.Literal('intermediate'),
        Type.Literal('advanced'),
      ],
      { description: 'Default basic.' },
    ),
  ),
  sortOrder: Type.Optional(Type.Number()),
});

const PatchObjectiveParams = Type.Object({
  objectiveId: ObjectiveIdParams.properties.objectiveId,
  expectedBehavior: Type.Optional(Type.String()),
  minCriteria: Type.Optional(Type.Array(Type.String())),
  proficientCriteria: Type.Optional(Type.Array(Type.String())),
  excellentCriteria: Type.Optional(Type.Array(Type.String())),
  title: Type.Optional(Type.String()),
  description: Type.Optional(Type.String()),
  difficulty: Type.Optional(
    Type.Union([
      Type.Literal('intro'),
      Type.Literal('basic'),
      Type.Literal('intermediate'),
      Type.Literal('advanced'),
    ]),
  ),
  status: Type.Optional(
    Type.Union([Type.Literal('draft'), Type.Literal('approved'), Type.Literal('archived')]),
  ),
  verifiable: Type.Optional(Type.Boolean()),
  unverifiableReason: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const CreateEvidenceParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  objectiveId: Type.String({ description: 'The outcome this evidence proves.' }),
  evidenceType: Type.Union(
    [
      Type.Literal('quiz'),
      Type.Literal('lab'),
      Type.Literal('performance'),
      Type.Literal('dialogue'),
      Type.Literal('artifact'),
    ],
    { description: 'quiz = written questions; lab = hands-on environment; the rest are forms.' },
  ),
  verificationMethod: Type.String({
    description: 'How it is checked, concretely: "实操考试，在 Docker 环境获取指定数据".',
  }),
  successCondition: Type.String({
    description: 'What must be true for this evidence to count as met.',
  }),
  conditionExpression: Type.Optional(
    Type.String({ description: 'Machine-evaluable form of successCondition, when one exists.' }),
  ),
  auxiliaryCondition: Type.Optional(
    Type.String({
      description: 'Weaker corroboration, e.g. "the run shows real injection behavior".',
    }),
  ),
  assessmentMode: Type.Optional(
    Type.Union([Type.Literal('practice'), Type.Literal('exam')], {
      description:
        'practice trains and may hint; exam is independent and scored. Default practice.',
    }),
  ),
  thresholdPass: Type.Optional(Type.Number({ description: 'Score for pass. Default 60.' })),
  thresholdProficient: Type.Optional(
    Type.Number({ description: 'Score for proficient. Default 80.' }),
  ),
  thresholdExcellent: Type.Optional(
    Type.Number({ description: 'Score for excellent. Default 90.' }),
  ),
  timeLimitSec: Type.Optional(Type.Number()),
  hintPolicy: Type.Optional(
    Type.Union([Type.Literal('unlimited'), Type.Literal('limited'), Type.Literal('forbidden')], {
      description:
        'exam mode forces forbidden; the database refuses any other combination for an exam.',
    }),
  ),
  independent: Type.Optional(
    Type.Boolean({ description: 'Must be completed unaided. Default true.' }),
  ),
  processRecord: Type.Optional(
    Type.Boolean({ description: 'Record the steps, not just the result.' }),
  ),
  sortOrder: Type.Optional(Type.Number()),
});

const CreateNodeParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  parentId: Type.Optional(
    Type.String({ description: 'Parent node id, for a decomposition tree.' }),
  ),
  code: Type.Optional(Type.String()),
  name: Type.String({ description: 'Knowledge or skill name, e.g. "SQL 注入原理".' }),
  nodeType: Type.Union([Type.Literal('knowledge'), Type.Literal('skill')], {
    description:
      'knowledge = what must be understood; skill = what must be performed. A competency is an outcome, not a node.',
  }),
  summary: Type.Optional(Type.String()),
  difficulty: Type.Optional(
    Type.Union([
      Type.Literal('intro'),
      Type.Literal('basic'),
      Type.Literal('intermediate'),
      Type.Literal('advanced'),
    ]),
  ),
  sortOrder: Type.Optional(Type.Number()),
});

const SetNodeObjectivesParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  nodeId: Type.String({ description: 'The knowledge/skill node.' }),
  objectives: Type.Array(
    Type.Object({
      objectiveId: Type.String(),
      supportLevel: Type.Optional(
        Type.Union([Type.Literal('primary'), Type.Literal('secondary')], {
          description:
            'primary = this node is the main way the outcome is reached. Default primary.',
        }),
      ),
      note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    }),
    {
      description:
        "Replaces the node's objective links. Every knowledge/skill must serve at least one outcome, or it is an orphan.",
    },
  ),
});

const CreateDependencyParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  sourceId: Type.String({ description: 'The prerequisite endpoint.' }),
  targetId: Type.String({ description: 'The endpoint that depends on it.' }),
  sourceKind: Type.Union([Type.Literal('objective'), Type.Literal('node')]),
  targetKind: Type.Union([Type.Literal('objective'), Type.Literal('node')]),
  edgeType: Type.Union(
    [
      Type.Literal('prerequisite'),
      Type.Literal('derives'),
      Type.Literal('supports'),
      Type.Literal('practices'),
      Type.Literal('composes'),
      Type.Literal('progresses'),
    ],
    {
      description:
        'prerequisite = must come first; derives = outcome decomposed from node; supports = node backs outcome; practices = drill trains skill; composes = parts form a whole; progresses = next level.',
    },
  ),
  strength: Type.Optional(Type.Number({ description: '0..1. Default 1.' })),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const CreateUnitParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  parentId: Type.Optional(
    Type.String({
      description: 'For an item, the chapter id it belongs to. Omit for a chapter.',
    }),
  ),
  unitType: Type.Union([Type.Literal('chapter'), Type.Literal('item')], {
    description:
      'chapter classifies a group of related content and carries no content of its own; item is the actual teaching unit.',
  }),
  title: Type.String({ description: 'e.g. "第二章 Web 安全" or "2.1 SQL 注入原理".' }),
  code: Type.Optional(Type.String({ description: 'e.g. "2.1".' })),
  unitRole: Type.Optional(
    Type.Union([Type.Literal('lecture'), Type.Literal('practice'), Type.Literal('exam')], {
      description:
        'What the item is for. Items only; a chapter has none. Do not mechanically create a practice and an exam after every lecture — decide from the outcome and its evidence.',
    }),
  ),
  hours: Type.Optional(Type.Number()),
  orderIndex: Type.Optional(Type.Number()),
  teachingDesign: Type.Optional(
    Type.Object(
      {
        objectives: Type.Optional(Type.Array(Type.String(), { description: 'Outcome ids.' })),
        nodes: Type.Optional(Type.Array(Type.String(), { description: 'Node ids.' })),
        prerequisites: Type.Optional(
          Type.Array(Type.String(), { description: 'Node ids assumed known.' }),
        ),
        core: Type.Optional(
          Type.Array(Type.String(), { description: 'Node ids that must be taught in full.' }),
        ),
        brief: Type.Optional(
          Type.Array(Type.String(), { description: 'Node ids covered quickly.' }),
        ),
        mention: Type.Optional(Type.Array(Type.String(), { description: 'Node ids named once.' })),
        omit: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Node ids deliberately out of scope — recorded so the omission is a decision, not a gap.',
          }),
        ),
        sequence: Type.Optional(Type.Array(Type.String())),
        cases: Type.Optional(Type.Array(Type.String())),
        demos: Type.Optional(Type.Array(Type.String())),
        operations: Type.Optional(Type.Array(Type.String())),
        drills: Type.Optional(Type.Array(Type.String())),
        summary: Type.Optional(Type.Array(Type.String())),
      },
      {
        description:
          'For a lecture item: what to teach and how deep. An empty design is not a design.',
      },
    ),
  ),
  deckDesign: Type.Optional(
    Type.Object(
      {
        estPages: Type.Optional(Type.Number()),
        pages: Type.Optional(
          Type.Array(
            Type.Object(
              {
                order: Type.Number(),
                title: Type.String(),
                goal: Type.String({
                  description: 'What this page must make the learner understand or be able to do.',
                }),
                coreInfo: Type.String({ description: 'The one thing this page carries.' }),
                mode: Type.Union([
                  Type.Literal('case'),
                  Type.Literal('explain'),
                  Type.Literal('demo'),
                  Type.Literal('compare'),
                  Type.Literal('summary'),
                  Type.Literal('diagram'),
                ]),
                emphasis: Type.Optional(Type.Array(Type.String())),
                visual: Type.Optional(
                  Type.String({ description: 'What diagram this page needs.' }),
                ),
                code: Type.Optional(Type.String({ description: 'Code this page must show.' })),
              },
              {
                description:
                  'The page plan handed to slide generation. A bare list of titles is not a deck design — every page needs a goal.',
              },
            ),
          ),
        ),
      },
      {
        description: 'For a lecture item: the page-level plan consumed by slide generation.',
      },
    ),
  ),
});

const PatchUnitParams = Type.Object({
  unitId: Type.String({ description: 'A chapter or item id.' }),
  title: Type.Optional(Type.String()),
  code: Type.Optional(Type.String()),
  unitRole: Type.Optional(
    Type.Union([Type.Literal('lecture'), Type.Literal('practice'), Type.Literal('exam')]),
  ),
  hours: Type.Optional(Type.Number()),
  orderIndex: Type.Optional(Type.Number()),
  teachingDesign: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  deckDesign: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  stageId: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const CreateUnitCoverageParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  unitId: Type.String({ description: 'The item (not chapter) that teaches, drills or examines.' }),
  objectiveId: Type.String({ description: 'The outcome covered.' }),
  coverageKind: Type.Union(
    [Type.Literal('teach'), Type.Literal('practice'), Type.Literal('assess')],
    {
      description: 'teach = taught; practice = drilled; assess = examined.',
    },
  ),
  depth: Type.Optional(
    Type.Union([Type.Literal('brief'), Type.Literal('standard'), Type.Literal('deep')], {
      description: 'How deep a teach. Default standard.',
    }),
  ),
  orderIndex: Type.Optional(Type.Number()),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const CreateUnitDependencyParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  sourceUnitId: Type.String({ description: 'The item that must come first.' }),
  targetUnitId: Type.String({ description: 'The item that assumes it.' }),
  edgeType: Type.Optional(
    Type.Union([Type.Literal('prerequisite'), Type.Literal('follow-up'), Type.Literal('related')], {
      description: 'Default prerequisite.',
    }),
  ),
  strength: Type.Optional(Type.Number()),
  note: Type.Optional(Type.Union([Type.String(), Type.Null()])),
});

const CreateQuestionParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  unitId: Type.String({ description: 'The item this question belongs to.' }),
  objectiveId: Type.String({ description: 'The single outcome this question verifies.' }),
  evidenceId: Type.Optional(Type.String({ description: 'The quiz evidence it serves, if any.' })),
  questionType: Type.Union([
    Type.Literal('single'),
    Type.Literal('multiple'),
    Type.Literal('true_false'),
  ]),
  stem: Type.String({ description: 'The question.' }),
  options: Type.Optional(
    Type.Array(Type.Object({ key: Type.String(), text: Type.String() }), {
      description: 'Required for single/multiple; not used for true_false.',
    }),
  ),
  answer: Type.Optional(Type.Array(Type.String(), { description: 'Correct option keys.' })),
  explanation: Type.Optional(Type.String({ description: 'Why the answer is right.' })),
  distractors: Type.Optional(
    Type.Array(
      Type.Object({
        optionKey: Type.String(),
        misconception: Type.String({
          description:
            'The wrong reasoning this option represents. This is what makes feedback useful instead of just marking a letter wrong.',
        }),
      }),
      { description: 'One per wrong option.' },
    ),
  ),
  difficulty: Type.Optional(
    Type.Union([
      Type.Literal('intro'),
      Type.Literal('basic'),
      Type.Literal('intermediate'),
      Type.Literal('advanced'),
    ]),
  ),
  bloomLevel: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  score: Type.Optional(Type.Number()),
  sortOrder: Type.Optional(Type.Number()),
});

const CreateLabTaskParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  unitId: Type.String({ description: 'The practice or exam item this lab belongs to.' }),
  objectiveId: Type.String({ description: 'The outcome this lab trains or examines.' }),
  evidenceId: Type.Optional(Type.String()),
  assessmentMode: Type.Optional(
    Type.Union([Type.Literal('practice'), Type.Literal('exam')], {
      description: 'Default practice.',
    }),
  ),
  taskGoal: Type.String({ description: 'What the learner must achieve, e.g. "获取 /flag".' }),
  brief: Type.Optional(Type.String({ description: 'The task statement shown to the learner.' })),
  expectedResult: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  dockerImage: Type.String({ description: 'The environment image.' }),
  containerConfig: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  initState: Type.Optional(
    Type.Record(Type.String(), Type.Unknown(), {
      description: 'Initial state of the environment.',
    }),
  ),
  resetPolicy: Type.Optional(
    Type.Union([Type.Literal('on-start'), Type.Literal('on-demand'), Type.Literal('never')]),
  ),
  referenceSolution: Type.Optional(
    Type.Array(
      Type.Object({
        step: Type.Number(),
        action: Type.String(),
        detail: Type.Optional(Type.String()),
      }),
      {
        description:
          'One recommended route through the task. This is advice for the learner and for review — it is NEVER what decides a result. Grading uses verifyRules only.',
      },
    ),
  ),
  verifyRules: Type.Array(
    Type.Object({
      kind: Type.Union([
        Type.Literal('flag'),
        Type.Literal('file_read'),
        Type.Literal('file_write'),
        Type.Literal('env_state'),
        Type.Literal('http_request'),
        Type.Literal('process_exec'),
        Type.Literal('custom'),
      ]),
      value: Type.Optional(Type.String()),
      path: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      method: Type.Optional(Type.String()),
      argv: Type.Optional(Type.Array(Type.String())),
      expression: Type.Optional(Type.String()),
      note: Type.Optional(Type.String()),
    }),
    {
      description:
        'The machine-checkable conditions that decide a result. Must be satisfiable by any correct route, not just the reference one.',
    },
  ),
  keyBehaviors: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        description: Type.String(),
        stepId: Type.Optional(Type.String()),
      }),
      {
        description:
          'Behaviors worth process credit. A lab with no key behaviors can only be graded on result.',
      },
    ),
  ),
  finalStateRule: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  scoreRules: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([
          Type.Literal('result'),
          Type.Literal('process'),
          Type.Literal('key_step'),
          Type.Literal('time'),
        ]),
        weight: Type.Number(),
        stepId: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
      }),
    ),
  ),
  scoringMode: Type.Optional(
    Type.Union([
      Type.Literal('result'),
      Type.Literal('process'),
      Type.Literal('key_step'),
      Type.Literal('time'),
      Type.Literal('mixed'),
    ]),
  ),
  timeLimitSec: Type.Optional(Type.Number()),
  hintPolicy: Type.Optional(
    Type.Union([Type.Literal('unlimited'), Type.Literal('limited'), Type.Literal('forbidden')]),
  ),
  allowRetry: Type.Optional(
    Type.Boolean({ description: 'exam mode forces false; the database refuses any other value.' }),
  ),
  hintLadder: Type.Optional(
    Type.Array(
      Type.Object({
        level: Type.Number(),
        content: Type.String(),
        costWeight: Type.Optional(Type.Number()),
      }),
      { description: 'Hints, revealed in order, for practice.' },
    ),
  ),
  sortOrder: Type.Optional(Type.Number()),
});

const PatchLabTaskParams = Type.Object({
  labTaskId: Type.String({ description: 'A lab task id.' }),
  taskGoal: Type.Optional(Type.String()),
  brief: Type.Optional(Type.String()),
  expectedResult: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  dockerImage: Type.Optional(Type.String()),
  referenceSolution: Type.Optional(
    Type.Array(
      Type.Object({
        step: Type.Number(),
        action: Type.String(),
        detail: Type.Optional(Type.String()),
      }),
    ),
  ),
  verifyRules: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([
          Type.Literal('flag'),
          Type.Literal('file_read'),
          Type.Literal('file_write'),
          Type.Literal('env_state'),
          Type.Literal('http_request'),
          Type.Literal('process_exec'),
          Type.Literal('custom'),
        ]),
        value: Type.Optional(Type.String()),
        path: Type.Optional(Type.String()),
        key: Type.Optional(Type.String()),
        method: Type.Optional(Type.String()),
        argv: Type.Optional(Type.Array(Type.String())),
        expression: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
      }),
    ),
  ),
  keyBehaviors: Type.Optional(
    Type.Array(
      Type.Object({
        id: Type.String(),
        description: Type.String(),
        stepId: Type.Optional(Type.String()),
      }),
    ),
  ),
  scoreRules: Type.Optional(
    Type.Array(
      Type.Object({
        kind: Type.Union([
          Type.Literal('result'),
          Type.Literal('process'),
          Type.Literal('key_step'),
          Type.Literal('time'),
        ]),
        weight: Type.Number(),
        stepId: Type.Optional(Type.String()),
        note: Type.Optional(Type.String()),
      }),
    ),
  ),
  scoringMode: Type.Optional(
    Type.Union([
      Type.Literal('result'),
      Type.Literal('process'),
      Type.Literal('key_step'),
      Type.Literal('time'),
      Type.Literal('mixed'),
    ]),
  ),
});

const TraceObjectiveParams = Type.Object({
  taskId: TaskIdParams.properties.taskId,
  objectiveId: ObjectiveIdParams.properties.objectiveId,
});

// ── Result helper ─────────────────────────────────────────────────────────────

function toolResult(text: string, details: Record<string, unknown>, isError = false) {
  return {
    content: [{ type: 'text' as const, text }],
    details,
    ...(isError ? { isError: true } : {}),
  };
}

/**
 * The one refusal every task-scoped tool maps a non-owned task to. The text
 * never says whether the task is another tenant's or simply absent.
 */
function notYoursResult(taskId: string) {
  return toolResult(
    `Course task ${taskId} was not found, or does not belong to this session user. Use list_course_tasks to see the tasks you can work on.`,
    { refused: true },
    true,
  );
}

/**
 * Owner scope: a task that is not this owner's reads as absent.
 */
async function ownsTask(
  deps: CurriculumDesignToolDeps,
  taskId: string,
): Promise<CurriculumDesignSnapshot | null> {
  const queryable = await resolveQueryable(deps);
  const tasks = await listCurriculumTasks(queryable, deps.ownerId);
  if (!tasks.some((task) => task.id === taskId)) return null;
  return getCurriculumDesignSnapshot(queryable, deps.ownerId, taskId);
}

/**
 * Run a design write under three gates, in this order: the task must be the
 * owner's, the phase machine must allow the write, and the store's own
 * validation must pass. The three throw different error classes, and the
 * message each produces is written to be acted on rather than merely reported.
 */
async function guarded<T>(
  deps: CurriculumDesignToolDeps,
  taskId: string,
  action: string,
  run: (queryable: Queryable) => Promise<T>,
  ok: (value: T) => { text: string; details?: Record<string, unknown> },
): Promise<ReturnType<typeof toolResult>> {
  try {
    const queryable = await resolveQueryable(deps);
    const snapshot = await ownsTask(deps, taskId);
    if (!snapshot) return notYoursResult(taskId);
    const value = await run(queryable);
    const { text, details } = ok(value);
    return toolResult(text, { taskId, phase: snapshot.task.designPhase, ...details });
  } catch (error) {
    if (error instanceof CurriculumPhaseError) {
      return toolResult(
        `${action} is not allowed yet: ${error.message}. Call get_course_design to see which phase the task is in and what is still missing.`,
        { error: 'phase-locked', phaseLocked: true },
        true,
      );
    }
    if (error instanceof CurriculumDesignValidationError) {
      return toolResult(
        `${action} was refused: ${error.message}`,
        { error: 'invalid', validation: true },
        true,
      );
    }
    if (error instanceof CurriculumDesignNotFoundError) {
      return notYoursResult(taskId);
    }
    throw error;
  }
}

// ── Snapshot rendering ────────────────────────────────────────────────────────

/**
 * The design as compact text. A full `details` dump is also attached, but the
 * text is what the model actually reads — so it carries the structure that
 * matters (what is taught, drilled and examined per outcome) rather than every
 * field of every row.
 */
function renderSnapshot(snapshot: CurriculumDesignSnapshot): string {
  const { task, objectives, evidence, nodes, nodeObjectives, dependencies, units, unitCoverage } =
    snapshot;
  const lines: string[] = [];
  lines.push(
    `TASK ${task.id} "${task.title}" — design phase: ${task.designPhase}`,
    `  brief: audience=${task.audience ?? '—'} level=${task.learnerLevel ?? '—'} duration=${task.durationHours ?? '—'}h`,
    `  problem: ${task.problemStatement ?? '—'}`,
  );

  const phaseIndex = CURRICULUM_DESIGN_PHASES.indexOf(task.designPhase);
  if (phaseIndex < CURRICULUM_DESIGN_PHASES.length - 1) {
    const next = CURRICULUM_DESIGN_PHASES[phaseIndex + 1]!;
    lines.push(`  next phase: ${next} (call advance_course_design_phase when it is satisfied)`);
  }

  lines.push('', `OUTCOMES (${objectives.length}):`);
  for (const objective of objectives) {
    const itsEvidence = evidence.filter((e) => e.objectiveId === objective.id);
    const coverage = unitCoverage.filter((c) => c.objectiveId === objective.id);
    const kinds = ['teach', 'practice', 'assess']
      .filter((kind) => coverage.some((c) => c.coverageKind === kind))
      .join('+');
    lines.push(
      `  ${objective.id} [${objective.objectiveType}${objective.bloomLevel ? `/${objective.bloomLevel}` : ''}] ${objective.title}` +
        `${objective.verifiable ? '' : '  ⚠ NOT VERIFIABLE'}` +
        `\n    behavior: ${objective.expectedBehavior || '—'}` +
        `\n    min: ${objective.minCriteria.join(' | ') || '—'}` +
        `\n    evidence: ${itsEvidence.length ? itsEvidence.map((e) => `${e.evidenceType}/${e.assessmentMode}`).join(', ') : '—'}` +
        `\n    coverage: ${kinds || 'none — not taught, drilled or examined'}`,
    );
  }

  lines.push('', `KNOWLEDGE & SKILL NODES (${nodes.length}):`);
  for (const node of nodes) {
    const serves = nodeObjectives.filter((n) => n.nodeId === node.id);
    const prereqs = dependencies.filter((d) => d.targetId === node.id && d.targetKind === 'node');
    lines.push(
      `  ${node.id} [${node.nodeType}] ${node.name}` +
        `\n    serves: ${serves.length ? serves.map((s) => `${s.objectiveId}(${s.supportLevel})`).join(', ') : '⚠ ORPHAN — serves no outcome'}` +
        (prereqs.length ? `\n    requires: ${prereqs.map((d) => d.sourceId).join(', ')}` : ''),
    );
  }

  const chapterCount = units.filter((u) => u.unitType === 'chapter').length;
  const itemCount = units.filter((u) => u.unitType === 'item').length;
  lines.push('', `OUTLINE (${chapterCount} chapters, ${itemCount} items):`);
  for (const unit of units) {
    const indent = unit.unitType === 'chapter' ? '  ' : '      ';
    const teaches = unitCoverage.filter((c) => c.unitId === unit.id);
    const byKind = (kind: string) =>
      teaches
        .filter((c) => c.coverageKind === kind)
        .map((c) => c.objectiveId)
        .join(', ');
    lines.push(
      `${indent}${unit.id} ${unit.unitType === 'chapter' ? '▸' : `· [${unit.unitRole ?? 'no-role'}]`} ${unit.title}` +
        (unit.unitType === 'item'
          ? `\n${indent}  teach: ${byKind('teach') || '—'}\n${indent}  practice: ${byKind('practice') || '—'}\n${indent}  assess: ${byKind('assess') || '—'}` +
            (unit.deckDesign?.pages?.length
              ? `\n${indent}  deck: ${unit.deckDesign.pages.length} page(s) planned`
              : unit.unitRole === 'lecture'
                ? `\n${indent}  deck: ⚠ no page plan yet`
                : '')
          : ''),
    );
  }

  lines.push(
    '',
    `DEPENDENCIES (${dependencies.length}), QUESTIONS (${snapshot.questions.length}), LABS (${snapshot.labTasks.length}), OPEN FINDINGS (${snapshot.auditFindings.filter((f) => f.status === 'open').length})`,
  );
  return lines.join('\n');
}

// ── Toolset ───────────────────────────────────────────────────────────────────

const ListCourseTasksParams = Type.Object({});

/**
 * Resolve the queryable once per toolset build.
 *
 * The design schema is bootstrapped by the S1 provider, and doing it here
 * rather than at module load keeps a deployment with no configured database
 * from failing at import: `getCurriculumDesignProvider` throws only when a
 * design tool is actually called, and that refusal reaches the model as a
 * tool error instead of a crashed run.
 */
async function resolveQueryable(deps: CurriculumDesignToolDeps): Promise<Queryable> {
  if (deps.queryable) return deps.queryable;
  const persistence = await getCurriculumDesignProvider();
  return persistence.pool as unknown as Queryable;
}

export function buildCurriculumDesignTools(
  deps: CurriculumDesignToolDeps,
): AgentTool<never, never>[] {
  const { ownerId } = deps;

  const listCourseTasks: AgentTool<typeof ListCourseTasksParams, unknown> = {
    name: 'list_course_tasks',
    label: 'List course tasks',
    description:
      "List the course tasks this session user owns, with each one's design phase. Start here to find a task to continue designing.",
    parameters: ListCourseTasksParams,
    async execute(_id, _params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const queryable = await resolveQueryable(deps);
      const tasks = await listCurriculumTasks(queryable, ownerId);
      if (tasks.length === 0) {
        return toolResult('No course tasks yet.', { tasks: [], count: 0 });
      }
      const text = tasks
        .map(
          (task) =>
            `- ${task.id} "${task.title}" — phase ${task.designPhase}` +
            `${task.problemStatement ? '' : '  (brief incomplete)'}`,
        )
        .join('\n');
      return toolResult(`Course tasks:\n${text}`, {
        tasks: tasks.map((t) => ({ id: t.id, title: t.title, designPhase: t.designPhase })),
        count: tasks.length,
      });
    },
  };

  const createCourseTask: AgentTool<typeof CreateTaskParams, unknown> = {
    name: 'create_course_task',
    label: 'Create course task',
    description:
      'Create a course task from a brief. This is phase 1: no outcomes, no outline, no slides yet. The brief must state who is trained, for how long, and what problem the course solves before the design may move on.',
    parameters: CreateTaskParams,
    executionMode: 'sequential',
    async execute(_id, params: Static<typeof CreateTaskParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const queryable = await resolveQueryable(deps);
      try {
        const task = await createCurriculumTask(queryable, ownerId, {
          title: params.title,
          audience: params.audience,
          learnerLevel: params.learnerLevel,
          trainingScenario: params.trainingScenario,
          durationHours: params.durationHours,
          applicationScene: params.applicationScene,
          problemStatement: params.problemStatement,
        });
        return toolResult(
          `Created course task "${task.title}" (${task.id}), design phase "${task.designPhase}". Next: define what learners must be able to do independently — create_learning_outcome, never create_curriculum_unit first.`,
          { taskId: task.id, title: task.title, designPhase: task.designPhase },
        );
      } catch (error) {
        if (error instanceof CurriculumDesignValidationError) {
          return toolResult(
            `create_course_task was refused: ${error.message}`,
            { error: 'invalid', validation: true },
            true,
          );
        }
        throw error;
      }
    },
  };

  const patchCourseTask: AgentTool<typeof PatchTaskParams, unknown> = {
    name: 'patch_course_task',
    label: 'Update course brief',
    description:
      'Update the course brief. Required fields must be present before the design may advance past the brief.',
    parameters: PatchTaskParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const { taskId, ...patch } = params;
      return guarded(
        deps,
        taskId,
        'patch_course_task',
        (queryable) => updateCurriculumTask(queryable, ownerId, taskId, patch),
        (task) => ({ text: `Updated the brief for "${task.title}".` }),
      );
    },
  };

  const getCourseDesign: AgentTool<typeof TaskIdParams, unknown> = {
    name: 'get_course_design',
    label: 'Get course design',
    description:
      'Read the whole outcome-first design: outcomes with their evidence and teach/practice/assess coverage, knowledge & skill nodes with their dependencies, the chapter/item outline, questions, labs and open findings. This is the read to make before authoring any phase.',
    parameters: TaskIdParams,
    async execute(_id, params: Static<typeof TaskIdParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const snapshot = await ownsTask(deps, params.taskId);
      if (!snapshot) return notYoursResult(params.taskId);
      if (signal?.aborted) throw new Error('aborted');
      const queryable = await resolveQueryable(deps);
      const next =
        CURRICULUM_DESIGN_PHASES[CURRICULUM_DESIGN_PHASES.indexOf(snapshot.task.designPhase) + 1];
      const gaps = next ? await phaseCompletionGaps(queryable, ownerId, params.taskId, next) : [];
      return toolResult(renderSnapshot(snapshot), {
        design: snapshot,
        ...(next ? { nextPhase: next, gaps } : {}),
      });
    },
  };

  const advancePhase: AgentTool<typeof TaskIdParams, unknown> = {
    name: 'advance_course_design_phase',
    label: 'Advance design phase',
    description:
      'Move the task to the next design phase, once the current one is complete. Refused, with the concrete gaps, when it is not — this is the gate that keeps outcomes, graph, outline and assessment in order.',
    parameters: TaskIdParams,
    executionMode: 'sequential',
    async execute(_id, params: Static<typeof TaskIdParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const snapshot = await ownsTask(deps, params.taskId);
      if (!snapshot) return notYoursResult(params.taskId);
      if (signal?.aborted) throw new Error('aborted');
      const queryable = await resolveQueryable(deps);
      const current = snapshot.task.designPhase;
      const next = CURRICULUM_DESIGN_PHASES[CURRICULUM_DESIGN_PHASES.indexOf(current) + 1];
      if (!next) {
        return toolResult(
          `Task is already at the final phase "${current}". Run review_course_design to check it.`,
          { designPhase: current, atEnd: true },
        );
      }
      const gaps = await phaseCompletionGaps(queryable, ownerId, params.taskId, next);
      if (signal?.aborted) throw new Error('aborted');
      if (gaps.length > 0) {
        return toolResult(
          `Cannot enter "${next}" yet:\n- ${gaps.join('\n- ')}`,
          { error: 'phase-gated', nextPhase: next, gaps, designPhase: current },
          true,
        );
      }
      const task = await advanceCurriculumTaskPhase(queryable, ownerId, params.taskId);
      return toolResult(`Design phase advanced to "${task.designPhase}".`, {
        designPhase: task.designPhase,
        previousPhase: current,
        nextPhase: next,
      });
    },
  };

  const createOutcome: AgentTool<typeof CreateObjectiveParams, unknown> = {
    name: 'create_learning_outcome',
    label: 'Create learning outcome',
    description:
      'Create one learning outcome and, when it can be verified, the behavior and criteria that make it checkable. "Understand SQL injection" is not an outcome; "can exploit a SQL injection to retrieve specified data" is. Each outcome must be distinct from every other one.',
    parameters: CreateObjectiveParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_learning_outcome',
        (queryable) =>
          createCurriculumObjective(queryable, ownerId, params.taskId, {
            ...(params.parentId ? { parentId: params.parentId } : {}),
            ...(params.code ? { code: params.code } : {}),
            title: params.title,
            description: params.description,
            objectiveType: params.objectiveType,
            bloomLevel: params.bloomLevel,
            level: params.level,
            expectedBehavior: params.expectedBehavior,
            minCriteria: params.minCriteria,
            proficientCriteria: params.proficientCriteria,
            excellentCriteria: params.excellentCriteria,
            difficulty: params.difficulty,
            // `verifiable` is deliberately absent: the store derives it from
            // the behavior and criteria, so the flag cannot disagree between
            // this tool and the HTTP route that writes the same row.
            sortOrder: params.sortOrder,
          }),
        (objective) => ({
          text:
            `Created ${objective.objectiveType} outcome ${objective.id} "${objective.title}".` +
            (objective.verifiable
              ? ' It is verifiable.'
              : ` It is NOT verifiable yet${objective.unverifiableReason ? `: ${objective.unverifiableReason}` : ' — add expectedBehavior and minCriteria'} and cannot be claimed as met.`),
          details: {
            objectiveId: objective.id,
            verifiable: objective.verifiable,
            ...(objective.unverifiableReason
              ? { unverifiableReason: objective.unverifiableReason }
              : {}),
          },
        }),
      );
    },
  };

  const patchOutcome: AgentTool<typeof PatchObjectiveParams, unknown> = {
    name: 'patch_learning_outcome',
    label: 'Update learning outcome',
    description:
      'Update an outcome. Use it to add the expected behavior and criteria that make an outcome verifiable, and to archive an outcome that turns out to duplicate another.',
    parameters: PatchObjectiveParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const { objectiveId, ...rest } = params;
      // Objective writes are scoped through their task, so resolve it first.
      const queryable = await resolveQueryable(deps);
      const taskId = await findTaskIdForObjective(queryable, ownerId, objectiveId);
      if (!taskId) {
        return toolResult(
          `Learning outcome ${objectiveId} was not found, or does not belong to this session user.`,
          { refused: true },
          true,
        );
      }
      // `verifiable` is not derived here. The store re-derives it against the
      // MERGED outcome, which is what makes this patch — the ordinary way an
      // outcome becomes checkable, by gaining the behavior it lacked — flip
      // the flag. It also means one fewer snapshot read per write.
      return guarded(
        deps,
        taskId,
        'patch_learning_outcome',
        () => updateCurriculumObjective(queryable, ownerId, objectiveId, rest),
        (objective) => ({
          text: `Updated outcome ${objective.id} — now ${objective.verifiable ? 'verifiable' : 'not verifiable'}.`,
          details: { objectiveId: objective.id, verifiable: objective.verifiable },
        }),
      );
    },
  };

  const createEvidence: AgentTool<typeof CreateEvidenceParams, unknown> = {
    name: 'create_outcome_evidence',
    label: 'Create outcome evidence',
    description:
      'Bind the evidence that would prove an outcome is met — a quiz, a lab, a demonstration. Decide this before designing any content: if you cannot say what would prove the outcome, the outcome is not yet designed. Lab evidence should later have a matching lab task with machine-checkable verify rules.',
    parameters: CreateEvidenceParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_outcome_evidence',
        (queryable) =>
          createCurriculumEvidence(queryable, ownerId, params.taskId, {
            objectiveId: params.objectiveId,
            evidenceType: params.evidenceType,
            verificationMethod: params.verificationMethod,
            successCondition: params.successCondition,
            conditionExpression: params.conditionExpression,
            auxiliaryCondition: params.auxiliaryCondition,
            assessmentMode: params.assessmentMode,
            thresholdPass: params.thresholdPass,
            thresholdProficient: params.thresholdProficient,
            thresholdExcellent: params.thresholdExcellent,
            timeLimitSec: params.timeLimitSec,
            hintPolicy: params.hintPolicy,
            independent: params.independent,
            processRecord: params.processRecord,
            sortOrder: params.sortOrder,
          }),
        (evidence) => ({
          text: `Created ${evidence.assessmentMode} evidence ${evidence.id} (${evidence.evidenceType}) for outcome ${evidence.objectiveId}: ${evidence.successCondition}`,
          details: { evidenceId: evidence.id, objectiveId: evidence.objectiveId },
        }),
      );
    },
  };

  const createNode: AgentTool<typeof CreateNodeParams, unknown> = {
    name: 'create_learning_node',
    label: 'Create knowledge or skill node',
    description:
      'Create one knowledge or skill node — the substrate an outcome needs. Only knowledge and skill belong here; a competency is a learning outcome, and a task is an external result. Bind it to outcomes with set_node_objectives; a node that serves none is an orphan.',
    parameters: CreateNodeParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_learning_node',
        (queryable) =>
          createCurriculumLearningNode(queryable, ownerId, params.taskId, {
            ...(params.parentId ? { parentId: params.parentId } : {}),
            ...(params.code ? { code: params.code } : {}),
            name: params.name,
            nodeType: params.nodeType,
            summary: params.summary,
            difficulty: params.difficulty,
            sortOrder: params.sortOrder,
          }),
        (node) => ({
          text: `Created ${node.nodeType} node ${node.id} "${node.name}". Bind it to at least one outcome with set_node_objectives.`,
          details: { nodeId: node.id, nodeType: node.nodeType },
        }),
      );
    },
  };

  const setNodeObjectives: AgentTool<typeof SetNodeObjectivesParams, unknown> = {
    name: 'set_node_objectives',
    label: 'Bind node to outcomes',
    description:
      'Set which learning outcomes a knowledge/skill node supports (replaces previous links). This is what makes the reverse design checkable: a node that serves no outcome is an orphan, and an outcome with no nodes has no substrate.',
    parameters: SetNodeObjectivesParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'set_node_objectives',
        (queryable) =>
          setCurriculumNodeObjectives(
            queryable,
            ownerId,
            params.taskId,
            params.objectives.map((link) => ({ ...link, nodeId: params.nodeId })),
          ),
        (links) => ({
          text: `Node ${params.nodeId} now supports ${links.length} outcome(s): ${links.map((l) => l.objectiveId).join(', ')}.`,
          details: { nodeId: params.nodeId, links },
        }),
      );
    },
  };

  const createDependency: AgentTool<typeof CreateDependencyParams, unknown> = {
    name: 'create_dependency',
    label: 'Add dependency edge',
    description:
      'Add an edge to the learning dependency graph — what must come before what. Cycles are refused. If an outcome turns out to be missing a prerequisite, add the node that supplies it rather than only noting the gap.',
    parameters: CreateDependencyParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_dependency',
        (queryable) =>
          createCurriculumDependency(queryable, ownerId, params.taskId, {
            sourceId: params.sourceId,
            targetId: params.targetId,
            sourceKind: params.sourceKind,
            targetKind: params.targetKind,
            edgeType: params.edgeType,
            strength: params.strength,
            note: params.note,
          }),
        (edge) => ({
          text: `Added ${edge.edgeType} edge ${edge.sourceId} → ${edge.targetId}.`,
          details: { dependencyId: edge.id },
        }),
      );
    },
  };

  const createUnit: AgentTool<typeof CreateUnitParams, unknown> = {
    name: 'create_curriculum_unit',
    label: 'Create chapter or item',
    description:
      'Create a chapter (classifies a group of related content, carries none itself) or an item (the actual lecture/practice/exam unit) with its teaching and deck design. The outline is a presentation of the dependency graph, never its source.',
    parameters: CreateUnitParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_curriculum_unit',
        (queryable) =>
          createCurriculumUnit(queryable, ownerId, params.taskId, {
            ...(params.parentId ? { parentId: params.parentId } : {}),
            unitType: params.unitType,
            title: params.title,
            code: params.code,
            unitRole: params.unitRole,
            hours: params.hours,
            orderIndex: params.orderIndex,
            ...(params.teachingDesign ? { teachingDesign: params.teachingDesign } : {}),
            ...(params.deckDesign ? { deckDesign: params.deckDesign } : {}),
          }),
        (unit) => ({
          text:
            unit.unitType === 'chapter'
              ? `Created chapter ${unit.id} "${unit.title}". A chapter only classifies — it carries no content of its own.`
              : `Created ${unit.unitRole ?? 'item'} item ${unit.id} "${unit.title}". Now bind the outcomes it teaches/drills/examines with create_unit_coverage.`,
          details: { unitId: unit.id, unitType: unit.unitType, unitRole: unit.unitRole },
        }),
      );
    },
  };

  const patchUnit: AgentTool<typeof PatchUnitParams, unknown> = {
    name: 'patch_curriculum_unit',
    label: 'Update chapter or item',
    description:
      'Update a chapter or item, including its teaching design (what to teach and how deep) and deck design (the page plan handed to slide generation).',
    parameters: PatchUnitParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const { unitId, ...patch } = params;
      const taskId = await findTaskIdForUnit(await resolveQueryable(deps), ownerId, unitId);
      if (!taskId) {
        return toolResult(
          `Unit ${unitId} was not found, or does not belong to this session user.`,
          { refused: true },
          true,
        );
      }
      return guarded(
        deps,
        taskId,
        'patch_curriculum_unit',
        (queryable) => updateCurriculumUnit(queryable, ownerId, unitId, patch),
        (unit) => ({
          text: `Updated unit ${unit.id}.`,
          details: { unitId: unit.id },
        }),
      );
    },
  };

  const createUnitCoverage: AgentTool<typeof CreateUnitCoverageParams, unknown> = {
    name: 'create_unit_coverage',
    label: 'Bind item to outcome',
    description:
      'Record that an item teaches, drills or examines an outcome. Every outcome needs all three to close the loop; teach alone is not enough. This is the traceable link from a promise to the moment a learner meets it.',
    parameters: CreateUnitCoverageParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_unit_coverage',
        (queryable) =>
          createCurriculumUnitCoverage(queryable, ownerId, params.taskId, {
            unitId: params.unitId,
            objectiveId: params.objectiveId,
            coverageKind: params.coverageKind,
            depth: params.depth,
            orderIndex: params.orderIndex,
            note: params.note,
          }),
        (coverage) => ({
          text: `Item ${coverage.unitId} now ${coverage.coverageKind === 'assess' ? 'examines' : coverage.coverageKind === 'practice' ? 'drills' : 'teaches'} outcome ${coverage.objectiveId}.`,
          details: {
            coverageId: coverage.id,
            unitId: coverage.unitId,
            objectiveId: coverage.objectiveId,
            coverageKind: coverage.coverageKind,
          },
        }),
      );
    },
  };

  const createUnitDependency: AgentTool<typeof CreateUnitDependencyParams, unknown> = {
    name: 'create_unit_dependency',
    label: 'Order items against each other',
    description:
      'Record the teaching order between two items — what assumes what. The dependency graph being correct does not make the teaching order correct; this is where an advanced item appearing before its foundation is caught.',
    parameters: CreateUnitDependencyParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_unit_dependency',
        (queryable) =>
          createCurriculumUnitDependency(queryable, ownerId, params.taskId, {
            sourceUnitId: params.sourceUnitId,
            targetUnitId: params.targetUnitId,
            edgeType: params.edgeType,
            strength: params.strength,
            note: params.note,
          }),
        (edge) => ({
          text: `Item ${edge.sourceUnitId} now precedes ${edge.targetUnitId}.`,
          details: { dependencyId: edge.id },
        }),
      );
    },
  };

  const createQuestion: AgentTool<typeof CreateQuestionParams, unknown> = {
    name: 'create_question',
    label: 'Create theory question',
    description:
      'Create a theory question bound to exactly one outcome, with the misconception behind each wrong option. A question nobody can trace to an outcome is decoration.',
    parameters: CreateQuestionParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_question',
        (queryable) =>
          createCurriculumQuestion(queryable, ownerId, params.taskId, {
            unitId: params.unitId,
            objectiveId: params.objectiveId,
            evidenceId: params.evidenceId,
            questionType: params.questionType,
            stem: params.stem,
            options: params.options,
            answer: params.answer,
            explanation: params.explanation,
            distractors: params.distractors,
            difficulty: params.difficulty,
            bloomLevel: params.bloomLevel,
            score: params.score,
            sortOrder: params.sortOrder,
          }),
        (question) => ({
          text: `Created ${question.questionType} question ${question.id} for outcome ${question.objectiveId}.`,
          details: { questionId: question.id, objectiveId: question.objectiveId },
        }),
      );
    },
  };

  const createLabTask: AgentTool<typeof CreateLabTaskParams, unknown> = {
    name: 'create_lab_task',
    label: 'Create lab task',
    description:
      'Create a hands-on practice or exam task with a Docker environment, machine-checkable verify rules, and optionally a reference solution. The reference solution is advice and never grades: verify rules must accept any correct route, not only the one you had in mind.',
    parameters: CreateLabTaskParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      return guarded(
        deps,
        params.taskId,
        'create_lab_task',
        (queryable) =>
          createCurriculumLabTask(queryable, ownerId, params.taskId, {
            unitId: params.unitId,
            objectiveId: params.objectiveId,
            evidenceId: params.evidenceId,
            assessmentMode: params.assessmentMode,
            taskGoal: params.taskGoal,
            brief: params.brief,
            expectedResult: params.expectedResult,
            dockerImage: params.dockerImage,
            containerConfig: params.containerConfig,
            initState: params.initState,
            resetPolicy: params.resetPolicy,
            referenceSolution: params.referenceSolution,
            verifyRules: params.verifyRules as LabVerifyRule[],
            keyBehaviors: params.keyBehaviors as LabKeyBehavior[],
            scoreRules: params.scoreRules as LabScoreRule[],
            scoringMode: params.scoringMode,
            timeLimitSec: params.timeLimitSec,
            hintPolicy: params.hintPolicy,
            allowRetry: params.allowRetry,
            hintLadder: params.hintLadder,
            sortOrder: params.sortOrder,
          }),
        (lab) => ({
          // No empty-verify-rules branch: the store refuses such a lab outright,
          // so it can never reach here. The refusal is a validation error and
          // its message is what the model has to act on — hence the tool
          // description carries the same requirement.
          text: `Created ${lab.assessmentMode} lab ${lab.id} for outcome ${lab.objectiveId}: "${lab.taskGoal}". Graded by ${lab.verifyRules.length} verify rule(s), independent of the reference solution.`,
          details: {
            labTaskId: lab.id,
            objectiveId: lab.objectiveId,
            verifyRuleCount: lab.verifyRules.length,
          },
        }),
      );
    },
  };

  const patchLabTask: AgentTool<typeof PatchLabTaskParams, unknown> = {
    name: 'patch_lab_task',
    label: 'Update lab task',
    description:
      'Update a lab task — most often to replace verify rules that only accept one particular route, or to add process scoring via key behaviors.',
    parameters: PatchLabTaskParams,
    executionMode: 'sequential',
    async execute(_id, params, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const { labTaskId, ...patch } = params;
      const taskId = await findTaskIdForLabTask(await resolveQueryable(deps), ownerId, labTaskId);
      if (!taskId) {
        return toolResult(
          `Lab task ${labTaskId} was not found, or does not belong to this session user.`,
          { refused: true },
          true,
        );
      }
      return guarded(
        deps,
        taskId,
        'patch_lab_task',
        (queryable) => updateCurriculumLabTask(queryable, ownerId, labTaskId, patch),
        (lab) => ({
          text: `Updated lab ${lab.id} — ${lab.verifyRules.length} verify rule(s).`,
          details: { labTaskId: lab.id, verifyRuleCount: lab.verifyRules.length },
        }),
      );
    },
  };

  const traceObjective: AgentTool<typeof TraceObjectiveParams, unknown> = {
    name: 'trace_outcome',
    label: 'Trace one outcome',
    description:
      'Follow one outcome backwards and forwards: the knowledge and skills it rests on, their prerequisites, and the items that teach, drill and examine it. Use when you need to answer "what backs this outcome" or "where is this outcome actually met".',
    parameters: TraceObjectiveParams,
    async execute(_id, params: Static<typeof TraceObjectiveParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const snapshot = await ownsTask(deps, params.taskId);
      if (!snapshot) return notYoursResult(params.taskId);
      if (signal?.aborted) throw new Error('aborted');
      const trace = traceFromObjective(snapshot, params.objectiveId);
      if (!trace) {
        return toolResult(
          `Outcome ${params.objectiveId} is not part of task ${params.taskId}.`,
          { error: 'unknown-objective', objectiveId: params.objectiveId },
          true,
        );
      }
      const where = trace.units
        .map(
          ({ unit, kind, depth }) =>
            `- ${unit.id} "${unit.title}" (${unit.unitRole ?? 'chapter'}): ${kind}${
              depth && depth !== 'standard' ? ` @${depth}` : ''
            }`,
        )
        .join('\n');
      const text = [
        `OUTCOME ${trace.objective.id} "${trace.objective.title}" [${trace.objective.objectiveType}${
          trace.objective.bloomLevel ? `/${trace.objective.bloomLevel}` : ''
        }]${trace.verifiable ? '' : '  ⚠ NOT VERIFIABLE'}`,
        `  behavior: ${trace.objective.expectedBehavior || '—'}`,
        `  min criteria: ${trace.objective.minCriteria.join(' | ') || '—'}`,
        `  backed by: ${
          trace.supportNodes.length
            ? trace.supportNodes.map((n) => `${n.nodeId} ${n.name} (${n.supportLevel})`).join('; ')
            : '⚠ no knowledge or skill node supports this outcome'
        }`,
        `  requires first: ${
          trace.prerequisiteObjectiveIds.length
            ? trace.prerequisiteObjectiveIds.join(', ')
            : '— (nothing)'
        }`,
        `  evidence: ${
          trace.evidence.length
            ? trace.evidence
                .map((e) => `${e.evidenceId} ${e.evidenceType}/${e.assessmentMode}`)
                .join(', ')
            : '⚠ none'
        }`,
        `  loop: teach=${trace.coverage.teach} practice=${trace.coverage.practice} assess=${trace.coverage.assess}${
          trace.coverage.teach && trace.coverage.practice && trace.coverage.assess
            ? '  ✓ closed'
            : '  ⚠ incomplete'
        }`,
        where
          ? `  where it is met:\n${where}`
          : '  where it is met: ⚠ no item teaches, drills or examines it',
      ].join('\n');
      return toolResult(text, { trace });
    },
  };

  const reviewDesign: AgentTool<typeof TaskIdParams, unknown> = {
    name: 'review_course_design',
    label: 'Review course design',
    description:
      'Run the full design review: missing prerequisites, unevidenced outcomes, outcomes nobody examines, nodes that are orphans, teaching that arrives out of order, labs graded only by the reference route, duplicate outcomes, and the nine-layer quality gate. Returns every finding and whether the design may be produced.',
    parameters: TaskIdParams,
    executionMode: 'sequential',
    async execute(_id, params: Static<typeof TaskIdParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const snapshot = await ownsTask(deps, params.taskId);
      if (!snapshot) return notYoursResult(params.taskId);
      if (signal?.aborted) throw new Error('aborted');
      const review = await reviewCurriculumTaskDesign(
        await resolveQueryable(deps),
        ownerId,
        params.taskId,
      );
      if (signal?.aborted) throw new Error('aborted');
      const open = review.findings.filter((f) => f.status === 'open');
      const lines = open.map((f) => `- [${f.severity}] ${f.ruleCode}: ${f.message}`);
      const text = [
        `Design review for "${snapshot.task.title}": ${open.length} open finding(s).`,
        ...lines,
        `quality: ${review.quality.exportable ? 'passes' : `breaks at "${review.quality.firstBrokenLayer}"`} (layers: ${CURRICULUM_QUALITY_LAYERS.join(' → ')})`,
        `coverage: ${review.verdict.summary}`,
        `exportable: ${review.exportable}`,
      ].join('\n');
      return toolResult(text, { ...review, openCount: open.length }, !review.exportable);
    },
  };

  const assertExportable: AgentTool<typeof TaskIdParams, unknown> = {
    name: 'assert_course_design_exportable',
    label: 'Check design can be produced',
    description:
      'Check that the design may be handed to slide generation and video export. Re-runs the review rather than trusting the last one, because an edit after a review can reopen a gap. Call this before producing any content.',
    parameters: TaskIdParams,
    async execute(_id, params: Static<typeof TaskIdParams>, signal) {
      if (signal?.aborted) throw new Error('aborted');
      const snapshot = await ownsTask(deps, params.taskId);
      if (!snapshot) return notYoursResult(params.taskId);
      if (signal?.aborted) throw new Error('aborted');
      try {
        const review = await assertCurriculumDesignExportable(
          await resolveQueryable(deps),
          ownerId,
          params.taskId,
        );
        return toolResult(`Design is exportable. ${review.verdict.summary}`, {
          exportable: true,
          coverage: review.verdict,
        });
      } catch (error) {
        if (error instanceof CurriculumDesignValidationError) {
          return toolResult(
            `Not exportable: ${error.message} Run review_course_design for the full list.`,
            { error: 'not-exportable', exportable: false },
            true,
          );
        }
        throw error;
      }
    },
  };

  return [
    listCourseTasks,
    createCourseTask,
    patchCourseTask,
    getCourseDesign,
    advancePhase,
    createOutcome,
    patchOutcome,
    createEvidence,
    createNode,
    setNodeObjectives,
    createDependency,
    createUnit,
    patchUnit,
    createUnitCoverage,
    createUnitDependency,
    createQuestion,
    createLabTask,
    patchLabTask,
    traceObjective,
    reviewDesign,
    assertExportable,
  ] as unknown as AgentTool<never, never>[];
}

// ── Scope resolution for id-only writes ───────────────────────────────────────

/**
 * Objective, unit and lab writes take the row's own id but are scoped through
 * its task, so the task has to be resolved before the phase gate can run. Both
 * resolve by asking the owner's tasks — a row belonging to another tenant is
 * never listed, which is what makes the "not found" answer honest.
 */
async function findTaskIdForObjective(
  queryable: Queryable,
  ownerId: string,
  objectiveId: string,
): Promise<string | null> {
  const tasks = await listCurriculumTasks(queryable, ownerId);
  for (const task of tasks) {
    const snapshot = await getCurriculumDesignSnapshot(queryable, ownerId, task.id);
    if (snapshot.objectives.some((o) => o.id === objectiveId)) return task.id;
  }
  return null;
}

async function findTaskIdForUnit(
  queryable: Queryable,
  ownerId: string,
  unitId: string,
): Promise<string | null> {
  const tasks = await listCurriculumTasks(queryable, ownerId);
  for (const task of tasks) {
    const snapshot = await getCurriculumDesignSnapshot(queryable, ownerId, task.id);
    if (snapshot.units.some((u) => u.id === unitId)) return task.id;
  }
  return null;
}

async function findTaskIdForLabTask(
  queryable: Queryable,
  ownerId: string,
  labTaskId: string,
): Promise<string | null> {
  const tasks = await listCurriculumTasks(queryable, ownerId);
  for (const task of tasks) {
    const snapshot = await getCurriculumDesignSnapshot(queryable, ownerId, task.id);
    if (snapshot.labTasks.some((l) => l.id === labTaskId)) return task.id;
  }
  return null;
}

export const CURRICULUM_DESIGN_ALLOWLIST: ReadonlySet<string> = new Set([
  'list_course_tasks',
  'create_course_task',
  'patch_course_task',
  'get_course_design',
  'advance_course_design_phase',
  'create_learning_outcome',
  'patch_learning_outcome',
  'create_outcome_evidence',
  'create_learning_node',
  'set_node_objectives',
  'create_dependency',
  'create_curriculum_unit',
  'patch_curriculum_unit',
  'create_unit_coverage',
  'create_unit_dependency',
  'create_question',
  'create_lab_task',
  'patch_lab_task',
  'trace_outcome',
  'review_course_design',
  'assert_course_design_exportable',
]);

/** The design phase each tool belongs to, for the phase-lock prompt block. */
export const CURRICULUM_DESIGN_TOOL_PHASES: Readonly<Record<string, CurriculumDesignPhase>> = {
  list_course_tasks: 'task',
  create_course_task: 'task',
  patch_course_task: 'task',
  get_course_design: 'task',
  advance_course_design_phase: 'task',
  create_learning_outcome: 'outcomes',
  patch_learning_outcome: 'outcomes',
  create_outcome_evidence: 'outcomes',
  create_learning_node: 'graph',
  set_node_objectives: 'graph',
  create_dependency: 'graph',
  create_curriculum_unit: 'outline',
  patch_curriculum_unit: 'outline',
  create_unit_coverage: 'outline',
  create_unit_dependency: 'outline',
  create_question: 'assessment',
  create_lab_task: 'assessment',
  patch_lab_task: 'assessment',
  trace_outcome: 'task',
  review_course_design: 'review',
  assert_course_design_exportable: 'review',
};

/**
 * Prompt block: the design order, and the rule the whole model rests on.
 *
 * The phase lock is enforced in the store as well, but a model that does not
 * know the order will spend its budget discovering refusals. This block says
 * the order up front and names the two things that are refused outright —
 * creating structure before outcomes, and grading a lab by its reference route.
 */
export const CURRICULUM_DESIGN_TOOLS_PROMPT = [
  'Outcome-first course design. The design order is fixed:',
  'course task (brief) → learning outcomes → evidence → knowledge/skill nodes → dependency graph → outline → teaching & deck design → questions and labs → review.',
  'Never create a chapter or item before the outcomes it serves exist, and never create a learning node before the outcome that needs it.',
  'The store enforces this order and refuses writes that skip a phase, naming what is missing.',
  'Call `get_course_design` to read the whole design (outcomes with their evidence and teach/practice/assess coverage, nodes with dependencies, outline, questions, labs, findings) and `advance_course_design_phase` to move on once a phase is complete.',
  'An outcome is verifiable only when it has an expected behavior and at least one minimum criterion; the store refuses to mark one verifiable otherwise, and every outcome needs evidence before the graph phase opens.',
  'A chapter classifies; it carries no content. An item is a lecture, practice or exam, and the design may not assume a practice and an exam after every lecture — decide from the outcome and its evidence.',
  'Every outcome must eventually be taught, drilled AND examined. `trace_outcome` shows what backs one outcome and where it is met; `review_course_design` runs the quality rules; `assert_course_design_exportable` is the gate before generating any content.',
  'A lab is graded by its verify rules, never by its reference solution: verify rules must accept any correct route, and the reference steps are advice for the learner.',
].join(' ');
