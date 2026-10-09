/**
 * Runtime validation for the design routes.
 *
 * The design tools did not need this layer: every tool carries a TypeBox
 * parameter schema, so the runtime rejected a bad enum before `execute` ran.
 * An HTTP route has no schema, and the store deliberately does not check
 * enums — it passes them straight to SQL, where a table CHECK turns a typo
 * into a constraint violation, i.e. a 500. This module is the schema the
 * writes lost when they stopped being tool calls.
 *
 * Two conventions it has to keep:
 *
 * 1. **Absent is not null.** A PATCH leaves a field alone when the body omits
 *    it and clears it when the body sends `null`. The store reads patches as
 *    `patch.x !== undefined ? patch.x : current.x`, so a parser that turned an
 *    omitted field into `null` would erase data the caller never mentioned.
 *    Every optional reader below returns `undefined` for absent.
 *
 * 2. **The store keeps its own messages.** Phase gates, ownership, and "a lab
 *    task needs at least one verification rule" are checked there and worded
 *    for a reader. This layer only rejects what would otherwise reach SQL, so
 *    a refusal always comes from the layer that understands the rule.
 *
 * The JSONB columns are why the enum checks here exist at all. A scalar like
 * `assessment_mode` has a CHECK constraint behind it, but `verify_rules` is
 * JSONB with nothing but `jsonb_typeof = 'array'`: `{ kind: 'flg' }` is stored
 * happily and then never matches at grading time. A rule that silently never
 * fires is worse than a rejected request.
 */

import {
  CURRICULUM_ASSESSMENT_MODES,
  CURRICULUM_BLOOM_LEVELS,
  CURRICULUM_COVERAGE_DEPTHS,
  CURRICULUM_COVERAGE_KINDS,
  CURRICULUM_DEPENDENCY_EDGE_TYPES,
  CURRICULUM_DEPENDENCY_KINDS,
  CURRICULUM_DIFFICULTIES,
  CURRICULUM_EVIDENCE_TYPES,
  CURRICULUM_HINT_POLICIES,
  CURRICULUM_NODE_TYPES,
  CURRICULUM_OBJECTIVE_LEVELS,
  CURRICULUM_OBJECTIVE_TYPES,
  CURRICULUM_QUESTION_TYPES,
  CURRICULUM_RESET_POLICIES,
  CURRICULUM_SCORING_MODES,
  CURRICULUM_SUPPORT_LEVELS,
  CURRICULUM_TASK_STATUSES,
  CURRICULUM_UNIT_DEPENDENCY_EDGE_TYPES,
  CURRICULUM_UNIT_ROLES,
  CURRICULUM_UNIT_TYPES,
  type CurriculumDeckDesign,
  type CurriculumDeckPage,
  type CurriculumTeachingDesign,
  type LabHint,
  type LabKeyBehavior,
  type LabReferenceStep,
  type LabScoreRule,
  type LabVerifyRule,
} from '@/lib/curriculum/design-types';
import type {
  CurriculumDependencyInput,
  CurriculumEvidenceInput,
  CurriculumLabTaskInput,
  CurriculumLearningNodeInput,
  CurriculumNodeObjectiveInput,
  CurriculumObjectiveInput,
  CurriculumQuestionInput,
  CurriculumTaskInput,
  CurriculumUnitCoverageInput,
  CurriculumUnitDependencyInput,
  CurriculumUnitInput,
} from './design-store';

export type ParseResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** A patch accepts every field the create does, but requires none of them. */
type PatchOf<T> = { [K in keyof T]?: T[K] };

// ── Embedded JSON enums the database cannot check ───────────────────────────

const VERIFY_RULE_KINDS = [
  'flag',
  'file_read',
  'file_write',
  'env_state',
  'http_request',
  'process_exec',
  'custom',
] as const;

const SCORE_RULE_KINDS = ['result', 'process', 'key_step', 'time'] as const;

const DECK_PAGE_MODES = ['case', 'explain', 'demo', 'compare', 'summary', 'diagram'] as const;

// ── The reader ──────────────────────────────────────────────────────────────

/**
 * Reads one JSON object, collecting every complaint rather than throwing on
 * the first. A caller fixing a request should see all of what is wrong with
 * it, not learn the fields one 400 at a time.
 */
class Reader {
  readonly errors: string[] = [];

  constructor(private readonly source: Record<string, unknown>) {}

  /** Whether the body mentioned the field. An explicit `null` counts. */
  has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.source, key) && this.source[key] !== undefined;
  }

  /** The raw value, for the few structured fields read by hand. */
  raw(key: string): unknown {
    return this.source[key];
  }

  fail(message: string): void {
    this.errors.push(message);
  }

  /** Fold a nested reader's complaints into this one. */
  absorb(other: Reader): void {
    this.errors.push(...other.errors);
  }

  /**
   * A trimmed non-empty string. An absent field, `null`, `""` and whitespace
   * all fail a required read and read as absent otherwise.
   */
  text(key: string, opts: { required?: boolean } = {}): string | undefined {
    if (!this.has(key)) {
      if (opts.required) this.fail(`${key} 为必填`);
      return undefined;
    }
    const raw = this.raw(key);
    if (typeof raw !== 'string') {
      this.fail(`${key} 必须是字符串`);
      return undefined;
    }
    const trimmed = raw.trim();
    if (trimmed === '') {
      if (opts.required) this.fail(`${key} 不能为空`);
      return undefined;
    }
    return trimmed;
  }

  /**
   * For a nullable text column in a PATCH: absent leaves it alone, `null` or
   * a blank string clears it.
   */
  nullableText(key: string): string | null | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.raw(key);
    if (raw === null) return null;
    if (typeof raw !== 'string') {
      this.fail(`${key} 必须是字符串或 null`);
      return undefined;
    }
    const trimmed = raw.trim();
    return trimmed === '' ? null : trimmed;
  }

  number(key: string, opts: { required?: boolean } = {}): number | undefined {
    if (!this.has(key)) {
      if (opts.required) this.fail(`${key} 为必填`);
      return undefined;
    }
    const raw = this.raw(key);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) {
      this.fail(`${key} 必须是有限数字`);
      return undefined;
    }
    return raw;
  }

  nullableNumber(key: string): number | null | undefined {
    if (!this.has(key)) return undefined;
    if (this.raw(key) === null) return null;
    return this.number(key);
  }

  integer(key: string, opts: { required?: boolean } = {}): number | undefined {
    const value = this.number(key, opts);
    if (value === undefined) return undefined;
    if (!Number.isInteger(value)) {
      this.fail(`${key} 必须是整数`);
      return undefined;
    }
    return value;
  }

  flag(key: string): boolean | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.raw(key);
    if (typeof raw !== 'boolean') {
      this.fail(`${key} 必须是 true 或 false`);
      return undefined;
    }
    return raw;
  }

  /** A flag with a default, for a create body that may omit it. */
  flagOr(key: string, fallback: boolean): boolean {
    return this.flag(key) ?? fallback;
  }

  /** One of `allowed`, named in the error so the caller can fix it. */
  oneOf<T extends string>(
    key: string,
    allowed: readonly T[],
    opts: { required?: boolean } = {},
  ): T | undefined {
    if (!this.has(key)) {
      if (opts.required) this.fail(`${key} 为必填`);
      return undefined;
    }
    const raw = this.raw(key);
    if (typeof raw !== 'string' || !(allowed as readonly string[]).includes(raw)) {
      this.fail(`${key} 只能是以下之一：${allowed.join(', ')}`);
      return undefined;
    }
    return raw as T;
  }

  /** A list of non-empty strings. An empty list is a real value, not absence. */
  textList(key: string): string[] | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.raw(key);
    if (!Array.isArray(raw)) {
      this.fail(`${key} 必须是字符串数组`);
      return undefined;
    }
    const out: string[] = [];
    raw.forEach((entry, index) => {
      if (typeof entry !== 'string') {
        this.fail(`${key}[${index}] 必须是字符串`);
        return;
      }
      const trimmed = entry.trim();
      if (trimmed !== '') out.push(trimmed);
    });
    return out;
  }

  /** A plain JSON object, for the opaque `container_config` / `init_state`. */
  record(key: string): Record<string, unknown> | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.raw(key);
    if (raw === null) return undefined;
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      this.fail(`${key} 必须是一个 JSON 对象`);
      return undefined;
    }
    return raw as Record<string, unknown>;
  }

  /**
   * An array of JSON objects, each read by `item`. `item` records its own
   * complaints on the sub-reader it is handed, which are folded back in.
   */
  objectList<T>(
    key: string,
    item: (entry: Reader, index: number) => T | undefined,
  ): T[] | undefined {
    if (!this.has(key)) return undefined;
    const raw = this.raw(key);
    if (!Array.isArray(raw)) {
      this.fail(`${key} 必须是数组`);
      return undefined;
    }
    const out: T[] = [];
    raw.forEach((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        this.fail(`${key}[${index}] 必须是一个对象`);
        return;
      }
      const sub = new Reader(entry as Record<string, unknown>);
      const parsed = item(sub, index);
      this.errors.push(...sub.errors);
      if (parsed !== undefined) out.push(parsed);
    });
    return out;
  }

  result<T>(value: T): ParseResult<T> {
    if (this.errors.length > 0) return { ok: false, message: this.errors.join('; ') };
    return { ok: true, value };
  }
}

/** A route body: one JSON object, or a named refusal. */
export function parseJsonObject(body: unknown): ParseResult<Record<string, unknown>> {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, message: '请求体必须是一个 JSON 对象' };
  }
  return { ok: true, value: body as Record<string, unknown> };
}

// ── Task ────────────────────────────────────────────────────────────────────

function readTask(r: Reader, partial: boolean): PatchOf<CurriculumTaskInput> {
  return {
    seriesId: r.nullableText('seriesId'),
    title: r.text('title', { required: !partial }),
    audience: r.nullableText('audience'),
    learnerLevel: r.nullableText('learnerLevel'),
    trainingScenario: r.nullableText('trainingScenario'),
    durationHours: r.nullableNumber('durationHours'),
    applicationScene: r.nullableText('applicationScene'),
    problemStatement: r.nullableText('problemStatement'),
    status: r.oneOf('status', CURRICULUM_TASK_STATUSES),
  };
}

export function parseTaskInput(body: unknown): ParseResult<CurriculumTaskInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readTask(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  if (value.title === undefined) return { ok: false, message: 'title 为必填' };
  return { ok: true, value: { ...value, title: value.title } };
}

export function parseTaskPatch(body: unknown): ParseResult<PatchOf<CurriculumTaskInput>> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  return r.result(readTask(r, true));
}

// ── Learning outcome ────────────────────────────────────────────────────────

function readObjective(r: Reader, partial: boolean): PatchOf<CurriculumObjectiveInput> {
  return {
    parentId: r.nullableText('parentId'),
    code: r.nullableText('code'),
    title: r.text('title', { required: !partial }),
    description: r.nullableText('description'),
    objectiveType: r.oneOf('objectiveType', CURRICULUM_OBJECTIVE_TYPES, { required: !partial }),
    bloomLevel: r.oneOf('bloomLevel', CURRICULUM_BLOOM_LEVELS),
    level: r.oneOf('level', CURRICULUM_OBJECTIVE_LEVELS),
    expectedBehavior: r.text('expectedBehavior'),
    minCriteria: r.textList('minCriteria'),
    proficientCriteria: r.textList('proficientCriteria'),
    excellentCriteria: r.textList('excellentCriteria'),
    difficulty: r.oneOf('difficulty', CURRICULUM_DIFFICULTIES),
    verifiable: r.flag('verifiable'),
    unverifiableReason: r.nullableText('unverifiableReason'),
    status: r.oneOf('status', ['draft', 'approved', 'archived'] as const),
    sortOrder: r.integer('sortOrder'),
  };
}

export function parseObjectiveInput(body: unknown): ParseResult<CurriculumObjectiveInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readObjective(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  if (value.title === undefined || value.objectiveType === undefined) {
    return { ok: false, message: 'title、objectiveType 均为必填' };
  }
  return {
    ok: true,
    value: { ...value, title: value.title, objectiveType: value.objectiveType },
  };
}

export function parseObjectivePatch(body: unknown): ParseResult<PatchOf<CurriculumObjectiveInput>> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  return r.result(readObjective(r, true));
}

// ── Evidence ────────────────────────────────────────────────────────────────

function readEvidence(r: Reader, partial: boolean): PatchOf<CurriculumEvidenceInput> {
  return {
    objectiveId: r.text('objectiveId', { required: !partial }),
    evidenceType: r.oneOf('evidenceType', CURRICULUM_EVIDENCE_TYPES, { required: !partial }),
    verificationMethod: r.text('verificationMethod', { required: !partial }),
    successCondition: r.text('successCondition', { required: !partial }),
    conditionExpression: r.nullableText('conditionExpression'),
    auxiliaryCondition: r.nullableText('auxiliaryCondition'),
    assessmentMode: r.oneOf('assessmentMode', CURRICULUM_ASSESSMENT_MODES),
    thresholdPass: r.number('thresholdPass'),
    thresholdProficient: r.number('thresholdProficient'),
    thresholdExcellent: r.number('thresholdExcellent'),
    timeLimitSec: r.nullableNumber('timeLimitSec'),
    hintPolicy: r.oneOf('hintPolicy', CURRICULUM_HINT_POLICIES),
    independent: r.flag('independent'),
    processRecord: r.flag('processRecord'),
    sortOrder: r.integer('sortOrder'),
  };
}

export function parseEvidenceInput(body: unknown): ParseResult<CurriculumEvidenceInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readEvidence(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  const { objectiveId, evidenceType, verificationMethod, successCondition } = value;
  if (
    objectiveId === undefined ||
    evidenceType === undefined ||
    verificationMethod === undefined ||
    successCondition === undefined
  ) {
    return {
      ok: false,
      message: 'objectiveId、evidenceType、verificationMethod、successCondition 均为必填',
    };
  }
  return {
    ok: true,
    value: { ...value, objectiveId, evidenceType, verificationMethod, successCondition },
  };
}

// ── Learning node ───────────────────────────────────────────────────────────

function readNode(r: Reader, partial: boolean): PatchOf<CurriculumLearningNodeInput> {
  return {
    parentId: r.nullableText('parentId'),
    code: r.nullableText('code'),
    name: r.text('name', { required: !partial }),
    nodeType: r.oneOf('nodeType', CURRICULUM_NODE_TYPES, { required: !partial }),
    summary: r.nullableText('summary'),
    difficulty: r.oneOf('difficulty', CURRICULUM_DIFFICULTIES),
    sortOrder: r.integer('sortOrder'),
  };
}

export function parseNodeInput(body: unknown): ParseResult<CurriculumLearningNodeInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readNode(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  if (value.name === undefined || value.nodeType === undefined) {
    return { ok: false, message: 'name、nodeType 均为必填' };
  }
  return { ok: true, value: { ...value, name: value.name, nodeType: value.nodeType } };
}

export function parseNodePatch(body: unknown): ParseResult<PatchOf<CurriculumLearningNodeInput>> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  return r.result(readNode(r, true));
}

/**
 * The node-to-outcome links, replaced as a set in one call. A link list is
 * always sent complete, so every field is required rather than merged.
 */
export function parseNodeObjectives(body: unknown): ParseResult<CurriculumNodeObjectiveInput[]> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const links = r.objectList<CurriculumNodeObjectiveInput>('links', (entry) => {
    const nodeId = entry.text('nodeId', { required: true });
    const objectiveId = entry.text('objectiveId', { required: true });
    if (nodeId === undefined || objectiveId === undefined) return undefined;
    return {
      nodeId,
      objectiveId,
      supportLevel: entry.oneOf('supportLevel', CURRICULUM_SUPPORT_LEVELS),
      note: entry.nullableText('note'),
    };
  });
  if (links === undefined && r.errors.length === 0) {
    // Absent reads differently from wrong-shaped, because the two need
    // different fixes — and this field is a whole set, so its absence is the
    // common mistake.
    return { ok: false, message: 'links 为必填（请发送完整集合）' };
  }
  return r.result(links ?? []);
}

// ── Dependency ──────────────────────────────────────────────────────────────

function readDependency(r: Reader, partial: boolean): PatchOf<CurriculumDependencyInput> {
  return {
    sourceId: r.text('sourceId', { required: !partial }),
    targetId: r.text('targetId', { required: !partial }),
    sourceKind: r.oneOf('sourceKind', CURRICULUM_DEPENDENCY_KINDS, { required: !partial }),
    targetKind: r.oneOf('targetKind', CURRICULUM_DEPENDENCY_KINDS, { required: !partial }),
    edgeType: r.oneOf('edgeType', CURRICULUM_DEPENDENCY_EDGE_TYPES, { required: !partial }),
    strength: r.number('strength'),
    note: r.nullableText('note'),
  };
}

export function parseDependencyInput(body: unknown): ParseResult<CurriculumDependencyInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readDependency(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  const { sourceId, targetId, sourceKind, targetKind, edgeType } = value;
  if (
    sourceId === undefined ||
    targetId === undefined ||
    sourceKind === undefined ||
    targetKind === undefined ||
    edgeType === undefined
  ) {
    return {
      ok: false,
      message: 'sourceId、targetId、sourceKind、targetKind、edgeType 均为必填',
    };
  }
  return {
    ok: true,
    value: { ...value, sourceId, targetId, sourceKind, targetKind, edgeType },
  };
}

// ── Unit (chapter / item) ───────────────────────────────────────────────────

/** The teaching plan: string lists and a deliberately-skipped bucket. */
function readTeachingDesign(r: Reader, key: string): CurriculumTeachingDesign | undefined {
  if (!r.has(key)) return undefined;
  const raw = r.raw(key);
  if (raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    r.fail(`${key} 必须是一个 JSON 对象`);
    return undefined;
  }
  const sub = new Reader(raw as Record<string, unknown>);
  const design: CurriculumTeachingDesign = {
    objectives: sub.textList('objectives'),
    nodes: sub.textList('nodes'),
    prerequisites: sub.textList('prerequisites'),
    core: sub.textList('core'),
    brief: sub.textList('brief'),
    mention: sub.textList('mention'),
    omit: sub.textList('omit'),
    sequence: sub.textList('sequence'),
    cases: sub.textList('cases'),
    demos: sub.textList('demos'),
    operations: sub.textList('operations'),
    drills: sub.textList('drills'),
    summary: sub.textList('summary'),
  };
  r.absorb(sub);
  return design;
}

/** The slide plan. `mode` is a JSONB enum the database never sees. */
function readDeckDesign(r: Reader, key: string): CurriculumDeckDesign | undefined {
  if (!r.has(key)) return undefined;
  const raw = r.raw(key);
  if (raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    r.fail(`${key} 必须是一个 JSON 对象`);
    return undefined;
  }
  const sub = new Reader(raw as Record<string, unknown>);
  const pages = sub.objectList<CurriculumDeckPage>('pages', (entry, index) => {
    const title = entry.text('title', { required: true });
    // A page is its goal. Accepting a heading with no goal is what produces a
    // deck that answers no design question, so it is refused here rather than
    // marked MISSING downstream.
    const goal = entry.text('goal', { required: true });
    const coreInfo = entry.text('coreInfo', { required: true });
    if (title === undefined || goal === undefined || coreInfo === undefined) return undefined;
    return {
      order: entry.integer('order') ?? index + 1,
      title,
      goal,
      coreInfo,
      mode: entry.oneOf('mode', DECK_PAGE_MODES, { required: true }) ?? 'explain',
      emphasis: entry.textList('emphasis'),
      visual: entry.text('visual'),
      code: entry.text('code'),
    };
  });
  const design: CurriculumDeckDesign = { estPages: sub.integer('estPages'), pages };
  r.absorb(sub);
  return design;
}

function readUnit(r: Reader, partial: boolean): PatchOf<CurriculumUnitInput> {
  // A chapter and an item are not interchangeable after creation: the role
  // rule, the children and every coverage row are written against the kind.
  // The store's UPDATE does not carry the column, so a patch naming it would
  // be silently ignored — refused here instead, which is the honest answer.
  if (partial && r.has('unitType')) {
    r.fail('unitType 不可更改：章节与条目不能互换');
  }
  return {
    parentId: r.nullableText('parentId'),
    unitType: r.oneOf('unitType', CURRICULUM_UNIT_TYPES, { required: !partial }),
    title: r.text('title', { required: !partial }),
    code: r.nullableText('code'),
    unitRole: r.oneOf('unitRole', CURRICULUM_UNIT_ROLES),
    hours: r.nullableNumber('hours'),
    orderIndex: r.integer('orderIndex'),
    teachingDesign: readTeachingDesign(r, 'teachingDesign'),
    deckDesign: readDeckDesign(r, 'deckDesign'),
    stageId: r.nullableText('stageId'),
  };
}

export function parseUnitInput(body: unknown): ParseResult<CurriculumUnitInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readUnit(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  if (value.unitType === undefined || value.title === undefined) {
    return { ok: false, message: 'unitType、title 均为必填' };
  }
  return { ok: true, value: { ...value, unitType: value.unitType, title: value.title } };
}

export function parseUnitPatch(body: unknown): ParseResult<PatchOf<CurriculumUnitInput>> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  return r.result(readUnit(r, true));
}

// ── Unit coverage ───────────────────────────────────────────────────────────

function readUnitCoverage(r: Reader): CurriculumUnitCoverageInput | undefined {
  const unitId = r.text('unitId', { required: true });
  const objectiveId = r.text('objectiveId', { required: true });
  const coverageKind = r.oneOf('coverageKind', CURRICULUM_COVERAGE_KINDS, { required: true });
  if (unitId === undefined || objectiveId === undefined || coverageKind === undefined) {
    return undefined;
  }
  return {
    unitId,
    objectiveId,
    coverageKind,
    depth: r.oneOf('depth', CURRICULUM_COVERAGE_DEPTHS),
    orderIndex: r.integer('orderIndex'),
    note: r.nullableText('note'),
  };
}

export function parseUnitCoverageInput(body: unknown): ParseResult<CurriculumUnitCoverageInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readUnitCoverage(r);
  const result = r.result(value);
  if (!result.ok) return result;
  if (value === undefined) {
    return { ok: false, message: 'unitId、objectiveId、coverageKind 均为必填' };
  }
  return { ok: true, value };
}

/** The whole coverage set for one task, replaced at once. */
export function parseUnitCoverageSet(body: unknown): ParseResult<CurriculumUnitCoverageInput[]> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const rows = r.objectList<CurriculumUnitCoverageInput>('rows', (entry) =>
    readUnitCoverage(entry),
  );
  if (rows === undefined && r.errors.length === 0) {
    return { ok: false, message: 'rows 为必填（请发送完整的覆盖集合）' };
  }
  return r.result(rows ?? []);
}

// ── Unit dependency ─────────────────────────────────────────────────────────

function readUnitDependency(r: Reader): CurriculumUnitDependencyInput | undefined {
  const sourceUnitId = r.text('sourceUnitId', { required: true });
  const targetUnitId = r.text('targetUnitId', { required: true });
  if (sourceUnitId === undefined || targetUnitId === undefined) return undefined;
  return {
    sourceUnitId,
    targetUnitId,
    edgeType: r.oneOf('edgeType', CURRICULUM_UNIT_DEPENDENCY_EDGE_TYPES),
    strength: r.number('strength'),
    note: r.nullableText('note'),
  };
}

export function parseUnitDependencyInput(
  body: unknown,
): ParseResult<CurriculumUnitDependencyInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readUnitDependency(r);
  const result = r.result(value);
  if (!result.ok) return result;
  if (value === undefined) {
    return { ok: false, message: 'sourceUnitId、targetUnitId 均为必填' };
  }
  return { ok: true, value };
}

// ── Question ────────────────────────────────────────────────────────────────

function readQuestion(r: Reader, partial: boolean): PatchOf<CurriculumQuestionInput> {
  return {
    unitId: r.text('unitId', { required: !partial }),
    objectiveId: r.text('objectiveId', { required: !partial }),
    evidenceId: r.nullableText('evidenceId'),
    questionType: r.oneOf('questionType', CURRICULUM_QUESTION_TYPES, { required: !partial }),
    stem: r.text('stem', { required: !partial }),
    options: r.objectList<{ key: string; text: string }>('options', (entry) => {
      const key = entry.text('key', { required: true });
      const text = entry.text('text', { required: true });
      return key === undefined || text === undefined ? undefined : { key, text };
    }),
    answer: r.textList('answer'),
    explanation: r.nullableText('explanation'),
    distractors: r.objectList<{ optionKey: string; misconception: string }>(
      'distractors',
      (entry) => {
        const optionKey = entry.text('optionKey', { required: true });
        const misconception = entry.text('misconception', { required: true });
        return optionKey === undefined || misconception === undefined
          ? undefined
          : { optionKey, misconception };
      },
    ),
    difficulty: r.oneOf('difficulty', CURRICULUM_DIFFICULTIES),
    bloomLevel: r.oneOf('bloomLevel', CURRICULUM_BLOOM_LEVELS),
    score: r.number('score'),
    sortOrder: r.integer('sortOrder'),
  };
}

export function parseQuestionInput(body: unknown): ParseResult<CurriculumQuestionInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readQuestion(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  const { unitId, objectiveId, questionType, stem } = value;
  if (
    unitId === undefined ||
    objectiveId === undefined ||
    questionType === undefined ||
    stem === undefined
  ) {
    return {
      ok: false,
      message: 'unitId、objectiveId、questionType、stem 均为必填',
    };
  }
  return { ok: true, value: { ...value, unitId, objectiveId, questionType, stem } };
}

export function parseQuestionPatch(body: unknown): ParseResult<PatchOf<CurriculumQuestionInput>> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  return r.result(readQuestion(r, true));
}

// ── Lab task ────────────────────────────────────────────────────────────────

function readReferenceSolution(r: Reader, key: string): LabReferenceStep[] | undefined {
  return r.objectList<LabReferenceStep>(key, (entry, index) => {
    const action = entry.text('action', { required: true });
    if (action === undefined) return undefined;
    return {
      step: entry.integer('step') ?? index + 1,
      action,
      detail: entry.text('detail'),
    };
  });
}

function readVerifyRules(r: Reader, key: string): LabVerifyRule[] | undefined {
  return r.objectList<LabVerifyRule>(key, (entry) => {
    // The one enum the database cannot guard: a typo here is stored and then
    // silently never matches, so grading reports an unsolved task forever.
    const kind = entry.oneOf('kind', VERIFY_RULE_KINDS, { required: true });
    if (kind === undefined) return undefined;
    return {
      kind,
      value: entry.text('value'),
      path: entry.text('path'),
      key: entry.text('key'),
      method: entry.text('method'),
      argv: entry.textList('argv'),
      expression: entry.text('expression'),
      note: entry.text('note'),
    };
  });
}

function readKeyBehaviors(r: Reader, key: string): LabKeyBehavior[] | undefined {
  return r.objectList<LabKeyBehavior>(key, (entry) => {
    const id = entry.text('id', { required: true });
    const description = entry.text('description', { required: true });
    if (id === undefined || description === undefined) return undefined;
    return { id, description, stepId: entry.text('stepId') };
  });
}

function readScoreRules(r: Reader, key: string): LabScoreRule[] | undefined {
  return r.objectList<LabScoreRule>(key, (entry) => {
    const kind = entry.oneOf('kind', SCORE_RULE_KINDS, { required: true });
    const weight = entry.number('weight', { required: true });
    if (kind === undefined || weight === undefined) return undefined;
    return { kind, weight, stepId: entry.text('stepId'), note: entry.text('note') };
  });
}

function readHintLadder(r: Reader, key: string): LabHint[] | undefined {
  return r.objectList<LabHint>(key, (entry) => {
    const level = entry.integer('level', { required: true });
    const content = entry.text('content', { required: true });
    if (level === undefined || content === undefined) return undefined;
    return { level, content, costWeight: entry.number('costWeight') };
  });
}

function readLabTask(r: Reader, partial: boolean): PatchOf<CurriculumLabTaskInput> {
  return {
    unitId: r.text('unitId', { required: !partial }),
    objectiveId: r.text('objectiveId', { required: !partial }),
    evidenceId: r.nullableText('evidenceId'),
    assessmentMode: r.oneOf('assessmentMode', CURRICULUM_ASSESSMENT_MODES),
    taskGoal: r.text('taskGoal', { required: !partial }),
    brief: r.text('brief'),
    expectedResult: r.nullableText('expectedResult'),
    dockerImage: r.text('dockerImage', { required: !partial }),
    containerConfig: r.record('containerConfig'),
    initState: r.record('initState'),
    resetPolicy: r.oneOf('resetPolicy', CURRICULUM_RESET_POLICIES),
    // `null` clears the reference route; absent leaves it alone. It is never
    // read by grading, so there is no shape rule beyond "steps with actions".
    referenceSolution: r.has('referenceSolution')
      ? r.raw('referenceSolution') === null
        ? null
        : (readReferenceSolution(r, 'referenceSolution') ?? null)
      : undefined,
    verifyRules: readVerifyRules(r, 'verifyRules'),
    keyBehaviors: readKeyBehaviors(r, 'keyBehaviors'),
    finalStateRule: r.nullableText('finalStateRule'),
    scoreRules: readScoreRules(r, 'scoreRules'),
    scoringMode: r.oneOf('scoringMode', CURRICULUM_SCORING_MODES),
    timeLimitSec: r.nullableNumber('timeLimitSec'),
    hintPolicy: r.oneOf('hintPolicy', CURRICULUM_HINT_POLICIES),
    allowRetry: r.flag('allowRetry'),
    hintLadder: readHintLadder(r, 'hintLadder'),
    sortOrder: r.integer('sortOrder'),
  };
}

export function parseLabTaskInput(body: unknown): ParseResult<CurriculumLabTaskInput> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const value = readLabTask(r, false);
  const result = r.result(value);
  if (!result.ok) return result;
  const { unitId, objectiveId, taskGoal, dockerImage } = value;
  if (
    unitId === undefined ||
    objectiveId === undefined ||
    taskGoal === undefined ||
    dockerImage === undefined
  ) {
    return {
      ok: false,
      message: 'unitId、objectiveId、taskGoal、dockerImage 均为必填',
    };
  }
  // `verifyRules` is intentionally not defaulted here. An empty set is the
  // store's to refuse, and it words that refusal better than this layer can.
  return {
    ok: true,
    value: {
      ...value,
      unitId,
      objectiveId,
      taskGoal,
      dockerImage,
      verifyRules: value.verifyRules ?? [],
    },
  };
}

export function parseLabTaskPatch(body: unknown): ParseResult<PatchOf<CurriculumLabTaskInput>> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  return r.result(readLabTask(r, true));
}

// ── Audit finding status ────────────────────────────────────────────────────

export function parseFindingStatus(body: unknown): ParseResult<'open' | 'resolved' | 'waived'> {
  const parsed = parseJsonObject(body);
  if (!parsed.ok) return parsed;
  const r = new Reader(parsed.value);
  const status = r.oneOf('status', ['open', 'resolved', 'waived'] as const, { required: true });
  const result = r.result(status);
  if (!result.ok) return result;
  if (status === undefined) return { ok: false, message: 'status 为必填' };
  return { ok: true, value: status };
}
