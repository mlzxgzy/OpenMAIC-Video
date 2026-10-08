/**
 * What a lab task needs before it can be graded, expressed as pure functions.
 *
 * Two things about a lab task are easy to get wrong from a form, and both are
 * silent when wrong — which is why they live here with tests rather than inside
 * a component's submit handler.
 *
 * **1. A verify rule must land in the field its kind is read from.** The record
 * carries seven possible fields for one condition (`value`, `path`, `key`,
 * `method`, `argv`, `expression`, `note`) and the kind decides which is the
 * condition. A `file_read` rule whose path was written into `value` is stored
 * successfully, passes review, and then never matches — the design-validation
 * comment calls this exact trap out: "a typo here is stored and then silently
 * never matches, so grading reports an unsolved task forever." A form that
 * offers all seven fields lets an author make that mistake by hand; a form that
 * asks for one *target* and maps it by kind cannot.
 *
 * **2. An exam is taken cold, and the database enforces it.** `assessment_mode =
 * 'exam'` requires `hint_policy = 'forbidden'`, `allow_retry = false` and a
 * non-null `time_limit_sec`. That rule is a table constraint
 * (`curriculum_lab_exam_strict`), so a caller who picks "exam" and keeps the
 * practice defaults trips a constraint whose raw message names the constraint
 * and not one of the three things to change. {@link examStrictGaps} states the
 * rule in the store's own vocabulary so the refusal can be actionable, and the
 * same function tells a form exactly what an exam must submit.
 */

import type { CurriculumAssessmentMode, CurriculumHintPolicy, LabVerifyRule } from './design-types';

export const LAB_VERIFY_KINDS = [
  'flag',
  'file_read',
  'file_write',
  'env_state',
  'http_request',
  'process_exec',
  'custom',
] as const;

export type LabVerifyKind = (typeof LAB_VERIFY_KINDS)[number];

const VERIFY_KIND_LABELS: Record<LabVerifyKind, string> = {
  flag: '提交的 flag',
  file_read: '读取的文件路径',
  file_write: '写入的文件路径',
  env_state: '环境变量名',
  http_request: '请求地址',
  process_exec: '执行的命令',
  custom: '自定义表达式',
};

export function labVerifyKindLabel(kind: LabVerifyKind): string {
  return VERIFY_KIND_LABELS[kind];
}

/**
 * Which field of {@link LabVerifyRule} the kind's condition is read from.
 *
 * `note` is deliberately never a target: it is commentary, and the audit's
 * grades-by-path rule does not treat it as an asserted value.
 */
export function labVerifyFieldFor(
  kind: LabVerifyKind,
): 'value' | 'path' | 'key' | 'expression' | 'argv' {
  switch (kind) {
    case 'flag':
    case 'http_request':
      return 'value';
    case 'file_read':
    case 'file_write':
      return 'path';
    case 'env_state':
      return 'key';
    case 'process_exec':
      return 'argv';
    case 'custom':
      return 'expression';
  }
}

/**
 * One verify rule, with the target written into the field the kind is read from.
 *
 * A blank target returns `null` rather than a rule with an empty condition: the
 * store refuses an empty rule set, and a rule that exists but asserts nothing
 * is worse than a refused write because it satisfies the "has a rule" check
 * while checking nothing.
 */
export function labVerifyRuleFrom(
  kind: LabVerifyKind,
  target: string,
  note?: string,
): LabVerifyRule | null {
  const trimmed = target.trim();
  if (trimmed === '') return null;
  const rule: LabVerifyRule = { kind };
  // `process_exec` takes an argv array; every other kind takes a single string.
  // A shell-quoted command line is not split here — quoting rules belong to the
  // runner that executes it, and guessing them would store a different command
  // than the author typed.
  const field = labVerifyFieldFor(kind);
  if (field === 'argv') rule.argv = trimmed.split(/\s+/);
  else if (field === 'value') rule.value = trimmed;
  else if (field === 'path') rule.path = trimmed;
  else if (field === 'key') rule.key = trimmed;
  else rule.expression = trimmed;
  const trimmedNote = note?.trim();
  if (trimmedNote) rule.note = trimmedNote;
  return rule;
}

/**
 * The condition a rule actually asserts, read back from the field its kind
 * belongs to — for display, so a list can show what will be graded rather than
 * the raw record.
 *
 * Returns `''` for a rule whose condition is missing. That is not the same as
 * "asserts nothing": it is exactly the state a mis-mapped field produces, and
 * showing it as empty is more honest than showing a `value` that the kind will
 * never read.
 */
export function labVerifyTargetOf(rule: LabVerifyRule): string {
  const field = labVerifyFieldFor(rule.kind);
  if (field === 'argv') return (rule.argv ?? []).join(' ');
  const value = rule[field];
  return typeof value === 'string' ? value : '';
}

/** The three fields `curriculum_lab_exam_strict` checks, as submitted values. */
export interface LabExamStrictness {
  assessmentMode: CurriculumAssessmentMode;
  hintPolicy: CurriculumHintPolicy;
  allowRetry: boolean;
  timeLimitSec: number | null;
}

/**
 * What stops this lab from being a valid exam. Empty for practice, and empty
 * for an exam that is cold, hint-free and on a clock.
 *
 * Returned as a list of specific gaps rather than a boolean so the refusal can
 * name all three at once — fixing them one refusal at a time is how a form
 * teaches someone to hate it.
 */
export function examStrictGaps(input: LabExamStrictness): string[] {
  // Practice is unconstrained on purpose: hints and retries are what practice
  // is for. Returning early keeps this the *exam* rule, so a practice lab can
  // never be refused by a rule that does not apply to it.
  if (input.assessmentMode !== 'exam') return [];
  const gaps: string[] = [];
  if (input.hintPolicy !== 'forbidden') {
    gaps.push('hintPolicy must be "forbidden": an exam gives no hints');
  }
  if (input.allowRetry !== false) {
    gaps.push('allowRetry must be false: an exam is taken once');
  }
  if (input.timeLimitSec === null || input.timeLimitSec === undefined) {
    gaps.push('timeLimitSec must be set: an exam is on a clock');
  }
  return gaps;
}

/** The store's refusal for {@link examStrictGaps}, or `null` when there is none. */
export function examStrictRefusal(input: LabExamStrictness): string | null {
  const gaps = examStrictGaps(input);
  if (gaps.length === 0) return null;
  return `an exam is independent, hint-free and on a clock; this one is not (${gaps.join('; ')})`;
}

/**
 * The exam defaults a form should submit when the author chooses `exam`.
 *
 * Practice keeps whatever the author chose. An exam gets the only values the
 * database accepts, so a form offering "exam" cannot produce a body the server
 * refuses — which is the defect this whole module exists to keep out of the
 * workbench. The time limit is left to the caller because there is no sensible
 * default for how long an exam should take.
 */
export const EXAM_FORCED_VALUES = {
  hintPolicy: 'forbidden' as const,
  allowRetry: false,
};
