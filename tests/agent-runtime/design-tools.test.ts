/**
 * The outcome-first design toolset on PGlite.
 *
 * The store tests pin the data model; these pin the surface the MODEL sees.
 * That is a different contract, and it is where three things can go wrong
 * without any store test going red:
 *
 *  1. **A refusal the model cannot act on.** The store refusing an out-of-order
 *     write is correct; a tool that surfaces it as `Something went wrong` makes
 *     the model retry the same call. So every refusal is asserted for its
 *     message content, not just that it happened.
 *
 *  2. **Owner scope leaking through a different door.** Objective, unit and lab
 *     writes take the row's own id rather than a task id, so they resolve the
 *     task by scanning the owner's tasks. That scan is the security boundary,
 *     and it is exactly the kind of code that works for the happy path and
 *     forgets the other tenant.
 *
 *  3. **A tool that reports success on an unverifiable design.** An outcome
 *     created without expected behaviour is the core failure of the old model;
 *     the tool must say so in its result text, because the store accepts the
 *     row and only the message keeps the model honest.
 */
import { PGlite } from '@electric-sql/pglite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  buildCurriculumDesignTools,
  CURRICULUM_DESIGN_ALLOWLIST,
} from '@/lib/server/agent-runtime/design-tools';
import { CURRICULUM_DESIGN_PHASES } from '@/lib/curriculum/design-types';
import type { AgentTool } from '@earendil-works/pi-agent-core';

const OWNER = 'owner:design-tools';
const OTHER = 'owner:intruder';

class PGlitePool {
  constructor(readonly db: PGlite) {}
  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }
  async connect() {
    return { query: (t: string, p?: unknown[]) => this.db.query(t, p), release() {} };
  }
  async end() {}
}

interface Result {
  text: string;
  isError: boolean;
  details?: Record<string, unknown>;
}

/** A toolset bound to one owner over one pool. */
function toolsFor(pool: PGlitePool, ownerId: string) {
  const tools = buildCurriculumDesignTools({ queryable: pool, ownerId });
  return new Map(tools.map((tool) => [tool.name, tool]));
}

async function call(
  tools: Map<string, AgentTool<never, never>>,
  name: string,
  params: Record<string, unknown> = {},
): Promise<Result> {
  const tool = tools.get(name);
  if (!tool) throw new Error(`no such tool: ${name}`);
  const out = (await tool.execute('call-1', params as never, new AbortController().signal)) as {
    content: { text: string }[];
    isError?: boolean;
    details?: Record<string, unknown>;
  };
  return { text: out.content[0]!.text, isError: out.isError === true, details: out.details };
}

describe('outcome-first design tools (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let tools: Map<string, AgentTool<never, never>>;

  beforeEach(async () => {
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    tools = toolsFor(pool, OWNER);
  });

  afterEach(async () => {
    await db.close();
  });

  /** Create one briefed task and return its id. */
  async function createTask(overrides: Record<string, unknown> = {}): Promise<string> {
    const r = await call(tools, 'create_course_task', {
      title: 'CTF 综合实战',
      audience: '安全运维岗新人',
      learnerLevel: '有 Linux 基础',
      problemStatement: '学员无法独立完成基础 Web CTF',
      durationHours: 54,
      ...overrides,
    });
    return r.details!.taskId as string;
  }

  /**
   * Drive a fresh task to the given phase by satisfying each gate in turn.
   *
   * This mirrors what the phase skills actually do — author the phase, then
   * advance — rather than writing rows directly, so a broken gate shows up
   * here as a broken advance instead of being bypassed.
   */
  async function advanceTo(target: (typeof CURRICULUM_DESIGN_PHASES)[number]): Promise<string> {
    const id = await createTask();
    if (target === 'task') return id;
    // 1 task -> outcomes
    await call(tools, 'advance_course_design_phase', { taskId: id });
    if (target === 'outcomes') return id;
    // 2 outcomes: one outcome with evidence
    await call(tools, 'create_learning_outcome', {
      taskId: id,
      title: '能够利用 SQL 注入获取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '能识别注入点并构造有效 Payload 取回数据',
      minCriteria: ['能取回指定数据'],
    });
    const design = (await call(tools, 'get_course_design', { taskId: id })).details!.design as {
      objectives: { id: string }[];
    };
    const objectiveId = design.objectives[0]!.id;
    await call(tools, 'create_outcome_evidence', {
      taskId: id,
      objectiveId,
      evidenceType: 'lab',
      verificationMethod: '实操考试，在 Docker 环境获取指定数据',
      successCondition: '成功读取 /flag',
    });
    await call(tools, 'advance_course_design_phase', { taskId: id });
    if (target === 'graph') return id;
    // 3 graph: one node bound to the outcome
    await call(tools, 'create_learning_node', {
      taskId: id,
      name: 'SQL 注入原理',
      nodeType: 'knowledge',
    });
    const withNode = (await call(tools, 'get_course_design', { taskId: id })).details!.design as {
      nodes: { id: string }[];
    };
    await call(tools, 'set_node_objectives', {
      taskId: id,
      nodeId: withNode.nodes[0]!.id,
      objectives: [{ objectiveId }],
    });
    // `graph` returns without advancing: the node work is graph work, and
    // crossing into `outline` is the caller's next gate.
    await call(tools, 'advance_course_design_phase', { taskId: id });
    return id;
  }

  describe('registration', () => {
    it('registers every design tool and keeps the allowlist in step', () => {
      const names = [...tools.keys()].sort();
      expect(names).toEqual([...CURRICULUM_DESIGN_ALLOWLIST].sort());
      expect(names.length).toBe(21);
    });
  });

  describe('brief phase', () => {
    it('creates a task and reports the phase it may work in next', async () => {
      await createTask();
      const listed = await call(tools, 'list_course_tasks');
      expect(listed.text).toContain('CTF 综合实战');
      expect(listed.text).toContain('phase task');
    });

    it('refuses to advance without the gated brief fields, naming them', async () => {
      const bare = await call(tools, 'create_course_task', { title: '空课程' });
      const id = bare.details!.taskId as string;
      const refused = await call(tools, 'advance_course_design_phase', { taskId: id });
      expect(refused.isError).toBe(true);
      // The message must name what is missing, or the model retries blindly.
      expect(refused.text).toContain('audience');
      expect(refused.text).toContain('Cannot enter "outcomes"');
    });
  });

  describe('phase lock', () => {
    it('refuses to create a chapter before the design reaches the outline phase', async () => {
      const id = await createTask();
      const refused = await call(tools, 'create_curriculum_unit', {
        taskId: id,
        unitType: 'chapter',
        title: '第一章',
      });
      expect(refused.isError).toBe(true);
      // The specific failure the redesign exists to prevent, and the message
      // has to name the tool to try instead.
      expect(refused.text).toMatch(/not allowed yet/i);
      expect(refused.text).toContain('get_course_design');
    });

    it('refuses to create a knowledge node before the outcomes phase', async () => {
      const id = await createTask();
      const refused = await call(tools, 'create_learning_node', {
        taskId: id,
        name: 'SQL 注入',
        nodeType: 'knowledge',
      });
      expect(refused.isError).toBe(true);
      expect(refused.text).toMatch(/not allowed yet/i);
    });

    it('advances through the gates once each phase is satisfied', async () => {
      const id = await advanceTo('outcomes');
      const design = (await call(tools, 'get_course_design', { taskId: id })).details!.design as {
        task: { designPhase: string };
      };
      expect(design.task.designPhase).toBe('outcomes');
    });
  });

  describe('verifiability is reported, not assumed', () => {
    it('says an outcome without expected behaviour is not verifiable', async () => {
      // Outcomes are a phase-2 write, so the task has to reach `outcomes`
      // first — which is itself the phase lock working.
      const id = await advanceTo('outcomes');
      const r = await call(tools, 'create_learning_outcome', {
        taskId: id,
        title: '理解 SQL 注入',
        objectiveType: 'knowledge',
      });
      // The store accepts the row; only the tool text keeps the model honest.
      expect(r.isError).toBe(false);
      expect(r.details!.verifiable).toBe(false);
      expect(r.text).toMatch(/NOT verifiable/i);
    });

    it('confirms an outcome that carries behaviour and criteria', async () => {
      const id = await advanceTo('outcomes');
      const r = await call(tools, 'create_learning_outcome', {
        taskId: id,
        title: '能够利用 SQL 注入取回数据',
        objectiveType: 'skill',
        expectedBehavior: '能构造 Payload 取回数据',
        minCriteria: ['取回数据'],
      });
      expect(r.details!.verifiable).toBe(true);
    });
  });

  describe('owner scope', () => {
    it("never reveals another owner's task, and the refusal is identical to a missing one", async () => {
      const otherTools = toolsFor(pool, OTHER);
      const id = await createTask();
      const foreign = await call(otherTools, 'get_course_design', { taskId: id });
      const missing = await call(otherTools, 'get_course_design', {
        taskId: 'task-does-not-exist',
      });
      expect(foreign.isError).toBe(true);
      // Identical apart from the id the caller itself supplied: a stranger must
      // not be able to tell "exists but is not yours" from "does not exist".
      const withoutId = (text: string) => text.replace(/task-\S+/, '<id>');
      expect(withoutId(foreign.text)).toBe(withoutId(missing.text));
    });

    it("refuses an id-only write on another owner's row", async () => {
      // 'graph' rather than 'outcomes': the objective this test patches is
      // created on the way through, so the row has to exist.
      const id = await advanceTo('graph');
      const design = (await call(tools, 'get_course_design', { taskId: id })).details!.design as {
        objectives: { id: string }[];
      };
      const objectiveId = design.objectives[0]!.id;
      const otherTools = toolsFor(pool, OTHER);
      const r = await call(otherTools, 'patch_learning_outcome', {
        objectiveId,
        expectedBehavior: '篡改',
      });
      expect(r.isError).toBe(true);
      expect(r.text).toMatch(/not found|does not belong/i);
      // And the row is untouched.
      const after = (await call(tools, 'get_course_design', { taskId: id })).details!.design as {
        objectives: { expectedBehavior: string }[];
      };
      expect(after.objectives[0]!.expectedBehavior).not.toBe('篡改');
    });
  });

  describe('lab design integrity', () => {
    /** An item that drills the seeded outcome, in the outline phase. */
    async function drillItem(taskId: string) {
      // advanceTo('graph') leaves the task in `graph`; units are `outline` work,
      // so cross that gate first. (create_curriculum_unit is refused below
      // without it — that refusal is the phase lock this file exists to pin.)
      const toOutline = await call(tools, 'advance_course_design_phase', { taskId });
      expect(toOutline.details!.designPhase).toBe('outline');
      const unit = await call(tools, 'create_curriculum_unit', {
        taskId,
        unitType: 'item',
        title: 'SQL 注入实操',
        unitRole: 'practice',
      });
      const design = (await call(tools, 'get_course_design', { taskId })).details!.design as {
        objectives: { id: string }[];
      };
      const objectiveId = design.objectives[0]!.id;
      await call(tools, 'create_unit_coverage', {
        taskId,
        unitId: unit.details!.unitId as string,
        objectiveId,
        coverageKind: 'practice',
      });
      // The gate out of `outline` is "every outcome is taught somewhere", so a
      // drill alone does not open it. This is the loop closing in the right
      // order: taught, then drilled, then examinable.
      await call(tools, 'create_unit_coverage', {
        taskId,
        unitId: unit.details!.unitId as string,
        objectiveId,
        coverageKind: 'teach',
      });
      // Questions and labs belong to the `assessment` phase, which is two
      // gates past `outline`: teaching first, then assessment. Both advances
      // are here because a lab written before the teaching phase closes is
      // refused — that refusal is the phase lock, and this test is about the
      // verify-rules rule underneath it.
      expect(
        (await call(tools, 'advance_course_design_phase', { taskId })).details!.designPhase,
      ).toBe('teaching');
      expect(
        (await call(tools, 'advance_course_design_phase', { taskId })).details!.designPhase,
      ).toBe('assessment');
      return { unitId: unit.details!.unitId as string, objectiveId };
    }

    it('refuses a lab with no verify rules, because nothing could be graded', async () => {
      const id = await advanceTo('graph');
      const { unitId, objectiveId } = await drillItem(id);
      const refused = await call(tools, 'create_lab_task', {
        taskId: id,
        unitId,
        objectiveId,
        taskGoal: '获取 /flag',
        dockerImage: 'web:lab',
        verifyRules: [],
      });
      // The store rejects it outright — stronger than a warning, and the
      // refusal must name the missing field or the model retries unchanged.
      expect(refused.isError).toBe(true);
      // The refusal has to name the missing field AND say that the reference
      // solution does not substitute for it — that second half is the whole
      // point, and a model that missed it would try to grade by its steps.
      expect(refused.text).toMatch(/verification rule/i);
      expect(refused.text).toMatch(/reference solution is not one/i);
    });

    it('reports the rule count and says grading ignores the reference solution', async () => {
      const id = await advanceTo('graph');
      const { unitId, objectiveId } = await drillItem(id);
      const lab = await call(tools, 'create_lab_task', {
        taskId: id,
        unitId,
        objectiveId,
        taskGoal: '获取 /flag',
        dockerImage: 'web:lab',
        referenceSolution: [
          { step: 1, action: '发现注入点' },
          { step: 2, action: '构造 Payload' },
        ],
        verifyRules: [{ kind: 'flag', value: 'flag{ok}' }],
      });
      expect(lab.isError).toBe(false);
      expect(lab.details!.verifyRuleCount).toBe(1);
      expect(lab.text).toMatch(/independent of the reference solution/i);
    });
  });
});
