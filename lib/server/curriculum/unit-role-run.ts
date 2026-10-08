/**
 * From a designed item to a generation run.
 *
 * The assembler this replaces decided what a course may contain with one line:
 * `sceneTypes: ['slide']`, for every course, forever. That single choice is why
 * a practice item produced slides and an exam item produced slides — a course
 * could not have a quiz or a lab because nothing downstream ever asked what
 * kind of thing it was teaching.
 *
 * The design already answers that question. `unit_role` is `lecture`,
 * `practice` or `exam`, and each one means a different artifact:
 *
 * | role       | the learner is…                    | so the run needs        |
 * |------------|-------------------------------------|-------------------------|
 * | `lecture`  | being taught                        | `slide`                 |
 * | `practice` | drilling, with hints allowed        | `slide`, `quiz`, `interactive` |
 * | `exam`     | being tested, alone and unscored-by-hint | `slide`, `quiz`     |
 *
 * Two of those columns are not only a scene list. A practice item is only
 * practice if hints remain available, and an exam item is only an exam if they
 * do not — so the role also decides `interactive` and `taskEngine`, which
 * together switch the generation path. Deriving the scene types and deriving
 * those two flags from the same source is the point: splitting them is how the
 * pair drifts and a practice item silently becomes a lecture.
 *
 * The `requirement` text is still produced, because the run's start contract
 * requires it and the ad-hoc consumers read it. But it is now assembled from
 * the design's own outcomes, not from a template that says "本节我们学习X".
 */
import type { CurriculumUnitRole } from '@/lib/curriculum/design-types';
import type { DeckDesign, SceneType } from '@/lib/types/generation';

/**
 * What each role allows the outline to build.
 *
 * Ordered by `ALL_SCENE_TYPES` so equal sets compare equal, and deliberately
 * without `pbl`: a designed item is a lecture, a drill or a test, and a
 * project-based scene is a different kind of course than this pipeline
 * produces. Adding it here would let a model substitute a project for a graded
 * lab, which is the substitution the whole outcome loop exists to prevent.
 */
export const UNIT_ROLE_SCENE_TYPES: Record<CurriculumUnitRole, readonly SceneType[]> = {
  lecture: ['slide'],
  // `quiz` for the knowledge check that follows the drill, `interactive` for
  // the procedure itself — which the outline renders as a procedural-skill.
  practice: ['slide', 'quiz', 'interactive'],
  // No interactive scene: an exam item is graded, and a free-form procedural
  // widget in an exam is a surface where the learner can succeed without ever
  // demonstrating the outcome the item was written to assess.
  exam: ['slide', 'quiz'],
};

/**
 * Whether this role may be given hints, and whether the run needs the
 * task-engine path.
 *
 * `taskEngine` is not a preference: the outline step gates `procedural-skill`
 * behind it, and downgrades a procedural-skill outline to a plain diagram when
 * it is off. So a practice item that asked for `interactive` without this flag
 * would get a flowchart where the drill was supposed to be — the scene type
 * would be honoured and the intent thrown away.
 */
export function unitRoleRunModes(role: CurriculumUnitRole): {
  interactive: boolean;
  taskEngine: boolean;
} {
  return { interactive: role !== 'lecture', taskEngine: role === 'practice' };
}

/** The scene types of a role, as the run input's mutable array. */
export function unitRoleSceneTypes(role: CurriculumUnitRole): SceneType[] {
  return [...UNIT_ROLE_SCENE_TYPES[role]];
}

export interface DesignedItemRun {
  requirement: string;
  sceneTypes: SceneType[];
  interactive: boolean;
  taskEngine: boolean;
  deckDesign: DeckDesign | undefined;
}

/**
 * The page plan of one item, or undefined when it has none.
 *
 * Only a lecture item consumes a deck plan, and only when the plan is actually
 * usable — a page plan is the shape of slides, and handing a slide plan to a
 * practice item would have the outline build a lecture and call it a drill.
 *
 * An item with no plan is not an error here. Course design may not have run
 * yet, and refusing to start a run over a missing plan would make the gate
 * unreachable in exactly the situation the gate exists for. What must not
 * happen is a *malformed* plan being passed on, so a plan with no pages at all
 * reads as absent rather than as an empty authoritative structure.
 */
export function deckDesignForRole(
  role: CurriculumUnitRole,
  deckDesign: unknown,
): DeckDesign | undefined {
  if (role !== 'lecture') return undefined;
  if (deckDesign === null || typeof deckDesign !== 'object' || Array.isArray(deckDesign)) {
    return undefined;
  }
  const pages = (deckDesign as { pages?: unknown }).pages;
  if (!Array.isArray(pages) || pages.length === 0) return undefined;
  return deckDesign as DeckDesign;
}

/**
 * The requirement text of one designed item.
 *
 * It exists because a run start requires one and because the stage is named
 * after it — but it is built from the outcomes the item was designed to serve,
 * so the name that ends up on a course card traces back to a teaching decision
 * instead of restating the item's title.
 *
 * The outcomes are passed in rather than read here so this stays a pure
 * function over values the caller already has, and so the wording is testable
 * without a database.
 */
export function describeDesignedItem(input: {
  title: string;
  role: CurriculumUnitRole;
  /** What the item teaches/practises/assesses, in the designer's words. */
  outcomes: string[];
  /** How many pages the plan specifies, when it has one. */
  plannedPages?: number;
}): string {
  const kind = ROLE_KIND[input.role];
  const lines = [`This is a ${kind} from a course designed outcome-first: "${input.title}".`];
  if (input.outcomes.length > 0) {
    lines.push(
      `It serves these learning outcomes, which are what the course promised and what it will be checked against:\n${input.outcomes
        .map((outcome, index) => `${index + 1}. ${outcome}`)
        .join('\n')}`,
    );
  } else {
    // Said plainly rather than omitted. A run started on an item with no
    // outcome bound to it should be visibly incomplete to whoever reads the
    // outline, because that is a design gap the export gate exists to catch.
    lines.push(
      '⚠ No learning outcome is bound to this item yet. The design is incomplete; generate the structure and flag the missing outcome rather than inventing one.',
    );
  }
  if (input.plannedPages !== undefined) {
    lines.push(
      input.plannedPages > 0
        ? `A page plan of ${input.plannedPages} page(s) is supplied as the authoritative structure.`
        : '⚠ The page plan is empty, so the structure below is not authoritative.',
    );
  }
  lines.push(ROLE_INSTRUCTION[input.role]);
  return lines.join('\n\n');
}

const ROLE_KIND: Record<CurriculumUnitRole, string> = {
  lecture: 'lecture',
  practice: 'guided practice item',
  exam: 'exam item',
};

/**
 * What each kind of item must be built as.
 *
 * These are instructions to the generator, not descriptions of the role: a
 * model told "this is an exam" will still build a walkthrough, and one told
 * "this is a practice item" will still grade the learner.
 */
const ROLE_INSTRUCTION: Record<CurriculumUnitRole, string> = {
  lecture:
    'Build slides that teach. Work through the supplied page plan in order; do not add a quiz or an exercise, because a lecture item that teaches is not a lecture any more.',
  practice:
    'Build a drill the learner can attempt and retry. Hints are available and may be offered, and the learner is not being graded for passing. Include a procedural interactive scene that lets them perform the task, not read about it.',
  exam: 'Build an independent test. No hints, no worked solutions, no walkthrough of the answer: the learner is being assessed, and anything that shows them the answer defeats the purpose of the item.',
};
