/**
 * The design routes on PGlite.
 *
 * What is under test is the route layer's own contribution — the part the
 * store suites cannot reach: the persistence gate, owner scoping, the 409 that
 * carries the phase pair, and the runtime validation that stands in for the
 * TypeBox schema the agent tools had and an HTTP route does not.
 *
 * The real store runs underneath against PGlite; only the provider wiring and
 * owner resolution are substituted, so a route that lost its transaction fence
 * or resolved the wrong owner still fails here.
 *
 * The validation cases are the ones that matter most, because their failure
 * mode is invisible without a test: the store passes enums straight to SQL, so
 * an unchecked one becomes a constraint violation and therefore a 500 — and a
 * typo *inside* a JSONB column (`verify_rules`) is not even a violation. It is
 * stored, and then silently never matches at grading time.
 */
import { PGlite } from '@electric-sql/pglite';
import { NextRequest } from 'next/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CurriculumTaskRecord } from '@/lib/curriculum/design-types';

const OWNER = 'owner:design-routes';
const OTHER = 'owner:design-routes-other';
const DATABASE_URL = 'postgres://design-routes';

const mocks = vi.hoisted(() => ({
  resolveOwnerId: vi.fn(),
  provider: {
    current: null as null | {
      pool: unknown;
      withTransaction: (body: (queryable: unknown) => Promise<unknown>) => Promise<unknown>;
    },
  },
  startGenerationRun: vi.fn(),
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolveOwnerId),
);

// Substitute only the provider wiring; every real store function stays.
vi.mock('@/lib/server/curriculum/design-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/curriculum/design-store')>();
  return { ...actual, getCurriculumDesignProvider: async () => mocks.provider.current };
});

// The run starter is the only substituted piece behind the produce route,
// because it reaches for the model slots and wakes the runner. What is under
// test is the route's own contribution: that the gate runs before the start,
// that the run input comes from the design rather than a template, and that a
// refusal leaves no run behind.
//
// `startRefusal` is the real one, not a stub: the route's job is to *call* it and
// map what it returns, and a stub would only prove the route called a function
// it also defined the behaviour of.
vi.mock('@/lib/server/generation/run/start', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/generation/run/start')>();
  return { ...actual, startGenerationRun: mocks.startGenerationRun };
});

import { GET as overview } from '@/app/api/curriculum/design/overview/route';
import { createCurriculumSeries } from '@/lib/server/curriculum/store';
import { GET as listTasks, POST as createTask } from '@/app/api/curriculum/design/tasks/route';
import {
  DELETE as deleteTask,
  GET as getTask,
  PATCH as patchTask,
} from '@/app/api/curriculum/design/tasks/[id]/route';
import {
  GET as getPhase,
  POST as advancePhase,
} from '@/app/api/curriculum/design/tasks/[id]/phase/route';
import { POST as createObjective } from '@/app/api/curriculum/design/tasks/[id]/objectives/route';
import {
  DELETE as deleteObjective,
  PATCH as patchObjective,
} from '@/app/api/curriculum/design/tasks/[id]/objectives/[objectiveId]/route';
import { POST as createEvidence } from '@/app/api/curriculum/design/tasks/[id]/evidence/route';
import { POST as createNode } from '@/app/api/curriculum/design/tasks/[id]/nodes/route';
import { PUT as putNodeObjectives } from '@/app/api/curriculum/design/tasks/[id]/node-objectives/route';
import { POST as createDependency } from '@/app/api/curriculum/design/tasks/[id]/dependencies/route';
import { POST as createUnitDependency } from '@/app/api/curriculum/design/tasks/[id]/unit-dependencies/route';
import { DELETE as deleteUnitDependency } from '@/app/api/curriculum/design/tasks/[id]/unit-dependencies/[unitDependencyId]/route';
import { POST as createUnit } from '@/app/api/curriculum/design/tasks/[id]/units/route';
import { PATCH as patchUnit } from '@/app/api/curriculum/design/tasks/[id]/units/[unitId]/route';
import { POST as generateUnit } from '@/app/api/curriculum/design/tasks/[id]/units/[unitId]/generate/route';
import {
  POST as createCoverage,
  PUT as putCoverage,
} from '@/app/api/curriculum/design/tasks/[id]/unit-coverage/route';
import { POST as createQuestion } from '@/app/api/curriculum/design/tasks/[id]/questions/route';
import { POST as createLabTask } from '@/app/api/curriculum/design/tasks/[id]/lab-tasks/route';
import {
  GET as getReview,
  POST as postReview,
} from '@/app/api/curriculum/design/tasks/[id]/review/route';
import { PATCH as patchFinding } from '@/app/api/curriculum/design/tasks/[id]/findings/[findingId]/route';
import { GET as getCoverageReport } from '@/app/api/curriculum/design/tasks/[id]/coverage/route';
import {
  DELETE as withdrawDirection,
  GET as getDirection,
  POST as confirmDirection,
} from '@/app/api/curriculum/design/tasks/[id]/direction/route';
import { GET as getExportGate } from '@/app/api/curriculum/design/tasks/[id]/export-gate/route';
import { GET as getTrace } from '@/app/api/curriculum/design/tasks/[id]/trace/route';

import { assessmentDraftOf } from '@/lib/curriculum/assessment-draft';
import { assessmentBoardOf } from '@/lib/curriculum/design-assessment';
import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  advanceCurriculumTaskPhase,
  confirmCurriculumDesignStep,
  createCurriculumEvidence,
  createCurriculumLabTask,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  getCurriculumDesignSnapshot,
  getCurriculumDesignStepConfirmation,
  setCurriculumNodeObjectives,
  updateCurriculumUnit,
} from '@/lib/server/curriculum/design-store';

class PGlitePool {
  constructor(readonly db: PGlite) {}

  async query<TRow>(text: string, params?: unknown[]) {
    return (await this.db.query(text, params)) as { rows: TRow[] };
  }

  async connect() {
    return {
      query: (text: string, params?: unknown[]) => this.db.query(text, params),
      release() {},
    };
  }

  async end() {}
}

const taskParams = (id: string) => ({ params: Promise.resolve({ id }) });
/** A child route's dynamic segments, typed by name so the handler's own Params match. */
function childParams<K extends string>(
  id: string,
  key: K,
  value: string,
): { params: Promise<{ id: string } & Record<K, string>> } {
  return { params: Promise.resolve({ id, [key]: value } as { id: string } & Record<K, string>) };
}

function request(url: string, method: string, payload?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    ...(payload === undefined
      ? {}
      : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }),
  });
}

const post = (url: string, payload?: unknown) => request(url, 'POST', payload);
const patch = (url: string, payload?: unknown) => request(url, 'PATCH', payload);
const put = (url: string, payload?: unknown) => request(url, 'PUT', payload);
const remove = (url: string) => request(url, 'DELETE');
const fetch_ = (url: string) => request(url, 'GET');

async function read<T>(response: Response): Promise<T> {
  return (await response.json()) as T;
}

describe('design routes (PGlite)', () => {
  let db: PGlite;
  let pool: PGlitePool;
  let task: CurriculumTaskRecord;

  beforeEach(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    db = new PGlite();
    await db.waitReady;
    pool = new PGlitePool(db);
    await ensureCurriculumSchema(pool);
    mocks.resolveOwnerId.mockReturnValue(OWNER);
    mocks.provider.current = {
      pool,
      withTransaction: (body) => body(pool),
    };
    task = await createCurriculumTask(pool, OWNER, {
      title: 'CTF 综合实战',
      audience: '安全运维岗新人',
      problemStatement: '学员无法独立完成基础 Web CTF',
      durationHours: 54,
    });
  });

  afterEach(async () => {
    delete process.env.DATABASE_URL;
    await db.close();
  });

  /** Walk the phase machine to the phase a test needs, honouring every gate. */
  async function advanceTo(
    phase: 'outcomes' | 'graph' | 'outline' | 'teaching' | 'assessment',
  ): Promise<void> {
    // Step 1 first: the brief is complete in `beforeEach`, but the design may not
    // leave it until the direction is signed off.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'outcomes') return;
    const objective = await createCurriculumObjective(pool, OWNER, task.id, {
      title: '能够利用 SQL 注入读取指定数据',
      objectiveType: 'skill',
      expectedBehavior: '在靶场中构造 payload 读取 flag',
      minCriteria: ['识别注入点', '读取 flag'],
    });
    await createCurriculumEvidence(pool, OWNER, task.id, {
      objectiveId: objective.id,
      evidenceType: 'lab',
      verificationMethod: '实操验证',
      successCondition: '成功读取 /flag',
    });
    // Step 2 sign-off: like the brief, the outcome list is complete but not yet
    // agreed until the user confirms it. Walking the machine means honouring that,
    // so this helper confirms each step before advancing past it.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outcomes', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'graph') return;
    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: objective.id },
    ]);
    // Step 3 sign-off, the same rule as the two above: a complete graph is still
    // not an agreed one. Every fixture that walks past `graph` needs this line —
    // their needing it is the gate working, not a fixture that quietly stopped
    // exercising the phase machine.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'graph', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'outline') return;
    const unit = await createCurriculumUnit(pool, OWNER, task.id, {
      unitType: 'item',
      title: '1.1 SQL 注入原理',
      unitRole: 'lecture',
    });
    await createCurriculumUnitCoverage(pool, OWNER, task.id, {
      unitId: unit.id,
      objectiveId: objective.id,
      coverageKind: 'teach',
    });
    // Step 5 sign-off, the fourth of the same kind: a complete outline is not an
    // agreed one, so a fixture that walks past `outline` has to sign it.
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'outline', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'teaching') return;
    // Step 6 sign-off, the fifth of the same kind. Without it `teaching →
    // assessment` is refused: questions and lab tasks are authored **against** the
    // lesson design, so the attempt to author them on an undesigned lesson is
    // exactly what the gate is for.
    await updateCurriculumUnit(pool, OWNER, unit.id, {
      teachingDesign: { core: [node.id] },
      deckDesign: {
        estPages: 1,
        pages: [
          {
            order: 1,
            title: '参数拼接就是注入点',
            goal: '学员能指出注入点',
            coreInfo: '参数被拼进 SQL 的地方就是注入点',
            mode: 'explain',
            teaches: ['SQL 查询与参数化'],
          },
        ],
      },
    });
    await confirmCurriculumDesignStep(pool, OWNER, task.id, 'teaching', 'user');
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
  }

  describe('the persistence gate', () => {
    it('answers 404 on every design route without a DATABASE_URL', async () => {
      delete process.env.DATABASE_URL;
      const calls: [string, () => Promise<Response>][] = [
        ['GET tasks', () => listTasks(fetch_('/api/curriculum/design/tasks'))],
        ['POST tasks', () => createTask(post('/api/curriculum/design/tasks', { title: 'x' }))],
        [
          'GET task',
          () => getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        ],
        [
          'PATCH task',
          () =>
            patchTask(patch(`/api/curriculum/design/tasks/${task.id}`, {}), taskParams(task.id)),
        ],
        [
          'DELETE task',
          () => deleteTask(remove(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        ],
        [
          'GET phase',
          () =>
            getPhase(fetch_(`/api/curriculum/design/tasks/${task.id}/phase`), taskParams(task.id)),
        ],
        [
          'POST phase',
          () =>
            advancePhase(
              post(`/api/curriculum/design/tasks/${task.id}/phase`),
              taskParams(task.id),
            ),
        ],
        [
          'GET review',
          () =>
            getReview(
              fetch_(`/api/curriculum/design/tasks/${task.id}/review`),
              taskParams(task.id),
            ),
        ],
        [
          'GET coverage',
          () =>
            getCoverageReport(
              fetch_(`/api/curriculum/design/tasks/${task.id}/coverage`),
              taskParams(task.id),
            ),
        ],
        [
          'GET export-gate',
          () =>
            getExportGate(
              fetch_(`/api/curriculum/design/tasks/${task.id}/export-gate`),
              taskParams(task.id),
            ),
        ],
        [
          'GET trace',
          () =>
            getTrace(
              fetch_(`/api/curriculum/design/tasks/${task.id}/trace?unitId=x`),
              taskParams(task.id),
            ),
        ],
        [
          'DELETE unit dependency',
          () =>
            deleteUnitDependency(
              remove(`/api/curriculum/design/tasks/${task.id}/unit-dependencies/udep_x`),
              childParams(task.id, 'unitDependencyId', 'udep_x'),
            ),
        ],
      ];
      for (const [name, call] of calls) {
        const response = await call();
        expect(response.status, name).toBe(404);
      }
    });
  });

  describe('tasks', () => {
    it('creates a task in the brief phase and lists it', async () => {
      const created = await createTask(post('/api/curriculum/design/tasks', { title: '新课程' }));
      expect(created.status).toBe(201);
      const body = await read<{ task: CurriculumTaskRecord }>(created);
      expect(body.task.designPhase).toBe('task');

      const listed = await listTasks(fetch_('/api/curriculum/design/tasks'));
      const list = await read<{ tasks: CurriculumTaskRecord[] }>(listed);
      expect(list.tasks.map((row) => row.id)).toContain(body.task.id);
    });

    it('refuses a task with no title', async () => {
      const response = await createTask(post('/api/curriculum/design/tasks', { audience: 'x' }));
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('title');
    });

    it('refuses an unknown status with 400 instead of reaching SQL', async () => {
      const response = await createTask(
        post('/api/curriculum/design/tasks', { title: 'x', status: 'live' }),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('draft');
    });

    it('hides another owner’s task behind the same 404 as a missing one', async () => {
      mocks.resolveOwnerId.mockReturnValue(OTHER);
      const response = await getTask(
        fetch_(`/api/curriculum/design/tasks/${task.id}`),
        taskParams(task.id),
      );
      expect(response.status).toBe(404);
    });

    it('returns the whole design as one snapshot', async () => {
      const response = await getTask(
        fetch_(`/api/curriculum/design/tasks/${task.id}`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const snapshot = await read<{ objectives: unknown[]; units: unknown[] }>(response);
      expect(snapshot.objectives).toEqual([]);
      expect(snapshot.units).toEqual([]);
    });
  });

  describe('the phase machine', () => {
    it('reports the gap that blocks the move instead of only refusing it', async () => {
      const bare = await createCurriculumTask(pool, OWNER, { title: '未澄清的课程' });
      const response = await getPhase(
        fetch_(`/api/curriculum/design/tasks/${bare.id}/phase`),
        taskParams(bare.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{
        phase: string;
        nextPhase: string;
        gaps: string[];
        readyToAdvance: boolean;
      }>(response);
      expect(body.phase).toBe('task');
      expect(body.nextPhase).toBe('outcomes');
      expect(body.readyToAdvance).toBe(false);
      // Each gap names what is missing, not just the phase.
      expect(body.gaps.join(' ')).toContain('授课对象');
    });

    it('advances once the brief is complete AND the direction is confirmed', async () => {
      // A complete brief is no longer enough: the AI-assisted flow has to be
      // able to stop here, or "the model filled the card" would silently become
      // "the user agreed to the card".
      const blocked = await advancePhase(
        post(`/api/curriculum/design/tasks/${task.id}/phase`),
        taskParams(task.id),
      );
      expect(blocked.status).toBe(409);
      const blockedBody = await read<{ error: { message: string } }>(blocked);
      expect(blockedBody.error.message).toContain('课程方向还没有确认');

      const confirmed = await confirmDirection(
        post(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      expect(confirmed.status).toBe(200);
      const confirmedBody = await read<{
        confirmed: boolean;
        confirmation: { confirmedBy: string };
      }>(confirmed);
      expect(confirmedBody.confirmed).toBe(true);
      // The button path records a person, not the model.
      expect(confirmedBody.confirmation.confirmedBy).toBe('user');

      const response = await advancePhase(
        post(`/api/curriculum/design/tasks/${task.id}/phase`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{ task: CurriculumTaskRecord }>(response);
      expect(body.task.designPhase).toBe('outcomes');
    });

    it('refuses an advance with 409 and both phases, not as a malformed request', async () => {
      const bare = await createCurriculumTask(pool, OWNER, { title: '未澄清的课程' });
      const response = await advancePhase(
        post(`/api/curriculum/design/tasks/${bare.id}/phase`),
        taskParams(bare.id),
      );
      // A boundary that is not satisfied yet is the same refusal as a write that
      // ran ahead of the phase. Answering it as a 400 "invalid request" told the
      // caller its request was malformed when it was merely early.
      expect(response.status).toBe(409);
      const body = await read<{
        error: { code: string; message: string; details: { current: string; required: string } };
      }>(response);
      expect(body.error.code).toBe('CURRICULUM_DESIGN_PHASE_LOCKED');
      expect(body.error.details).toEqual({ current: 'task', required: 'outcomes' });
      // The pair says where it is stuck; the message still names what is missing.
      expect(body.error.message).toContain('授课对象');
    });

    it('refuses a write from a later phase with 409 and both phases in the body', async () => {
      const response = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '能够读取 flag',
          objectiveType: 'skill',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(409);
      const body = await read<{
        error: { code: string; details: { current: string; required: string } };
      }>(response);
      expect(body.error.code).toBe('CURRICULUM_DESIGN_PHASE_LOCKED');
      expect(body.error.details).toEqual({ current: 'task', required: 'outcomes' });
    });
  });

  describe('course direction sign-off', () => {
    /**
     * The card's own contract. Step 1 is the one step where the phase machine
     * reads a second condition — the user's sign-off — so the route that records
     * it is the only way past the boundary that does not come from the agent.
     */
    it('reports a complete card that is still unconfirmed as not ready to advance', async () => {
      const response = await getDirection(
        fetch_(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{
        values: Record<string, unknown>;
        gaps: string[];
        confirmed: boolean;
        readyToAdvance: boolean;
        phaseGaps: string[];
      }>(response);
      expect(body.values.title).toBe('CTF 综合实战');
      // The card itself is fine; the missing piece is the signature.
      expect(body.gaps).toEqual([]);
      expect(body.confirmed).toBe(false);
      expect(body.readyToAdvance).toBe(false);
      expect(body.phaseGaps.join(' ')).toContain('课程方向还没有确认');
    });

    it('refuses to confirm an incomplete card, naming the empty slots', async () => {
      const bare = await createCurriculumTask(pool, OWNER, { title: '未澄清的课程' });
      const response = await confirmDirection(
        post(`/api/curriculum/design/tasks/${bare.id}/direction`),
        taskParams(bare.id),
      );
      // Confirming here would tell the user step 1 is done while the advance
      // button still says otherwise.
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('授课对象');
      expect(await getCurriculumDesignStepConfirmation(pool, OWNER, bare.id, 'task')).toBeNull();
    });

    it('records a user confirmation and opens the gate, idempotently', async () => {
      const first = await confirmDirection(
        post(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      expect(first.status).toBe(200);
      const body = await read<{
        confirmed: boolean;
        confirmation: { id: string; confirmedBy: string };
        readyToAdvance: boolean;
      }>(first);
      expect(body.confirmed).toBe(true);
      expect(body.confirmation.confirmedBy).toBe('user');
      expect(body.readyToAdvance).toBe(true);

      // Re-confirming replaces the row rather than accumulating one per click.
      const second = await confirmDirection(
        post(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      const secondBody = await read<{ confirmation: { id: string } }>(second);
      expect(secondBody.confirmation.id).toBe(body.confirmation.id);
      expect((await getCurriculumDesignSnapshot(pool, OWNER, task.id)).confirmations).toHaveLength(
        1,
      );
    });

    it('withdraws the confirmation, and answers 404 when there is none', async () => {
      const nothing = await withdrawDirection(
        remove(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      expect(nothing.status).toBe(404);

      await confirmDirection(
        post(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      const withdrawn = await withdrawDirection(
        remove(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      expect(withdrawn.status).toBe(200);
      const body = await read<{ confirmed: boolean; readyToAdvance: boolean }>(withdrawn);
      expect(body.confirmed).toBe(false);
      expect(body.readyToAdvance).toBe(false);

      const again = await withdrawDirection(
        remove(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      expect(again.status).toBe(404);
    });

    it('re-opens the step when the brief is edited through the PATCH route', async () => {
      await confirmDirection(
        post(`/api/curriculum/design/tasks/${task.id}/direction`),
        taskParams(task.id),
      );
      const patched = await patchTask(
        patch(`/api/curriculum/design/tasks/${task.id}`, { durationHours: 40 }),
        taskParams(task.id),
      );
      expect(patched.status).toBe(200);
      const body = await read<{ task: CurriculumTaskRecord }>(patched);
      expect(body.task.durationHours).toBe(40);
      // The signature belonged to the old card, so the interface has to show the
      // step as open again.
      expect(await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'task')).toBeNull();
    });

    it('fences the sign-off by owner on every method', async () => {
      await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
      mocks.resolveOwnerId.mockReturnValue(OTHER);
      const responses = await Promise.all([
        getDirection(
          fetch_(`/api/curriculum/design/tasks/${task.id}/direction`),
          taskParams(task.id),
        ),
        confirmDirection(
          post(`/api/curriculum/design/tasks/${task.id}/direction`),
          taskParams(task.id),
        ),
        withdrawDirection(
          remove(`/api/curriculum/design/tasks/${task.id}/direction`),
          taskParams(task.id),
        ),
      ]);
      // One indistinguishable answer for "not yours" and "does not exist", on all
      // three methods: a stranger must not be able to confirm, or un-confirm, a
      // design whose id they guessed.
      for (const response of responses) expect(response.status).toBe(404);
      // And the owner's sign-off survived the attempts.
      expect(
        await getCurriculumDesignStepConfirmation(pool, OWNER, task.id, 'task'),
      ).not.toBeNull();
    });
  });

  describe('outcome validation and derivation', () => {
    beforeEach(async () => {
      await confirmCurriculumDesignStep(pool, OWNER, task.id, 'task', 'user');
      await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    });

    it('refuses an unknown objectiveType with 400 rather than a constraint 500', async () => {
      const response = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '能够读取 flag',
          objectiveType: 'understanding',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('competency');
    });

    it('derives verifiable from the behaviour and criteria it was given', async () => {
      const response = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '能够利用 SQL 注入读取指定数据',
          objectiveType: 'skill',
          expectedBehavior: '构造 payload 读取 flag',
          minCriteria: ['识别注入点'],
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(201);
      const body = await read<{ objective: { verifiable: boolean } }>(response);
      // The body never asked for this; a model will not think to set a flag
      // whose absence silently means "this outcome cannot be claimed".
      expect(body.objective.verifiable).toBe(true);
    });

    it('leaves an outcome unverifiable when it is only a topic', async () => {
      const response = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '了解 SQL 注入',
          objectiveType: 'knowledge',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(201);
      const body = await read<{ objective: { verifiable: boolean } }>(response);
      expect(body.objective.verifiable).toBe(false);
    });

    it('honours a deliberate demotion to unverifiable', async () => {
      const response = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '了解 SQL 注入的由来',
          objectiveType: 'knowledge',
          expectedBehavior: '能复述注入的历史',
          minCriteria: ['复述'],
          verifiable: false,
        }),
        taskParams(task.id),
      );
      const body = await read<{ objective: { verifiable: boolean } }>(response);
      expect(body.objective.verifiable).toBe(false);
    });

    it('re-derives verifiable against the merged outcome on patch', async () => {
      const created = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '了解 SQL 注入',
          objectiveType: 'knowledge',
        }),
        taskParams(task.id),
      );
      const objective = (await read<{ objective: { id: string; verifiable: boolean } }>(created))
        .objective;
      expect(objective.verifiable).toBe(false);

      const response = await patchObjective(
        patch(`/api/curriculum/design/tasks/${task.id}/objectives/${objective.id}`, {
          expectedBehavior: '构造 payload',
          minCriteria: ['识别注入点'],
        }),
        childParams(task.id, 'objectiveId', objective.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{ objective: { verifiable: boolean } }>(response);
      expect(body.objective.verifiable).toBe(true);
    });

    it('deletes an outcome it owns', async () => {
      const created = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '临时目标',
          objectiveType: 'knowledge',
        }),
        taskParams(task.id),
      );
      const objective = (await read<{ objective: { id: string } }>(created)).objective;
      const response = await deleteObjective(
        remove(`/api/curriculum/design/tasks/${task.id}/objectives/${objective.id}`),
        childParams(task.id, 'objectiveId', objective.id),
      );
      expect(response.status).toBe(200);
    });
  });

  describe('the graph', () => {
    it('keeps several knowledge nodes supporting one outcome', async () => {
      await advanceTo('graph');
      const objective = (
        await read<{ objectives: { id: string }[] }>(
          await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        )
      ).objectives[0]!;

      const first = await createNode(
        post(`/api/curriculum/design/tasks/${task.id}/nodes`, {
          name: 'SQL 语法与查询',
          nodeType: 'knowledge',
        }),
        taskParams(task.id),
      );
      const second = await createNode(
        post(`/api/curriculum/design/tasks/${task.id}/nodes`, {
          name: 'HTTP 参数传递',
          nodeType: 'knowledge',
        }),
        taskParams(task.id),
      );
      const nodeA = (await read<{ node: { id: string } }>(first)).node;
      const nodeB = (await read<{ node: { id: string } }>(second)).node;

      const response = await putNodeObjectives(
        put(`/api/curriculum/design/tasks/${task.id}/node-objectives`, {
          links: [
            { nodeId: nodeA.id, objectiveId: objective.id },
            { nodeId: nodeB.id, objectiveId: objective.id },
          ],
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{ links: unknown[] }>(response);
      // Both supporters survive. A dedupe keyed on the outcome alone would
      // keep one, and the outcome would read as singly-supported.
      expect(body.links).toHaveLength(2);
    });

    it('refuses a self-referencing dependency', async () => {
      await advanceTo('graph');
      const objective = (
        await read<{ objectives: { id: string }[] }>(
          await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        )
      ).objectives[0]!;
      const response = await createDependency(
        post(`/api/curriculum/design/tasks/${task.id}/dependencies`, {
          sourceId: objective.id,
          targetId: objective.id,
          sourceKind: 'objective',
          targetKind: 'objective',
          edgeType: 'prerequisite',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(400);
    });
  });

  describe('the outline', () => {
    it('refuses a chapter that carries a teaching role', async () => {
      await advanceTo('outline');
      const response = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'chapter',
          title: '第一章 Web 安全',
          unitRole: 'lecture',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('章节');
    });

    it('refuses an item that declares no role', async () => {
      await advanceTo('outline');
      const response = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'item',
          title: '1.1 SQL 注入原理',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(400);
    });

    it('refuses a patch that tries to change a unit’s kind', async () => {
      await advanceTo('outline');
      const created = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'item',
          title: '1.1 SQL 注入原理',
          unitRole: 'lecture',
        }),
        taskParams(task.id),
      );
      const unit = (await read<{ unit: { id: string } }>(created)).unit;
      const response = await patchUnit(
        patch(`/api/curriculum/design/tasks/${task.id}/units/${unit.id}`, {
          unitType: 'chapter',
          unitRole: null,
        }),
        childParams(task.id, 'unitId', unit.id),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('不能互换');
    });

    it('refuses a deck page with a goal-less heading', async () => {
      await advanceTo('outline');
      const created = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'item',
          title: '1.1 SQL 注入原理',
          unitRole: 'lecture',
        }),
        taskParams(task.id),
      );
      const unit = (await read<{ unit: { id: string } }>(created)).unit;
      const response = await patchUnit(
        patch(`/api/curriculum/design/tasks/${task.id}/units/${unit.id}`, {
          deckDesign: { pages: [{ title: '什么是 SQL 注入' }] },
        }),
        childParams(task.id, 'unitId', unit.id),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('goal');
    });

    it('records a coverage row and rejects an unknown kind', async () => {
      await advanceTo('outline');
      const snapshot = await read<{ objectives: { id: string }[]; units: { id: string }[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      const objectiveId = snapshot.objectives[0]!.id;
      // A fresh practice item, so the coverage row is not a duplicate.
      const created = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'item',
          title: '1.2 SQL 注入练习',
          unitRole: 'practice',
        }),
        taskParams(task.id),
      );
      const unitId = (await read<{ unit: { id: string } }>(created)).unit.id;

      const bad = await createCoverage(
        post(`/api/curriculum/design/tasks/${task.id}/unit-coverage`, {
          unitId,
          objectiveId,
          coverageKind: 'rehearse',
        }),
        taskParams(task.id),
      );
      expect(bad.status).toBe(400);

      const good = await createCoverage(
        post(`/api/curriculum/design/tasks/${task.id}/unit-coverage`, {
          unitId,
          objectiveId,
          coverageKind: 'practice',
        }),
        taskParams(task.id),
      );
      expect(good.status).toBe(201);
    });

    it('records a teaching order and can withdraw it again', async () => {
      await advanceTo('outline');
      const item = async (title: string, unitRole: string) =>
        (
          await read<{ unit: { id: string } }>(
            await createUnit(
              post(`/api/curriculum/design/tasks/${task.id}/units`, {
                unitType: 'item',
                title,
                unitRole,
              }),
              taskParams(task.id),
            ),
          )
        ).unit.id;
      const first = await item('1.2 SQL 注入练习', 'practice');
      const second = await item('1.3 SQL 注入考核', 'exam');

      const recorded = await createUnitDependency(
        post(`/api/curriculum/design/tasks/${task.id}/unit-dependencies`, {
          sourceUnitId: first,
          targetUnitId: second,
          edgeType: 'prerequisite',
        }),
        taskParams(task.id),
      );
      expect(recorded.status).toBe(201);
      const dependencyId = (await read<{ dependency: { id: string } }>(recorded)).dependency.id;

      const withdrawn = await deleteUnitDependency(
        remove(`/api/curriculum/design/tasks/${task.id}/unit-dependencies/${dependencyId}`),
        childParams(task.id, 'unitDependencyId', dependencyId),
      );
      expect(withdrawn.status).toBe(200);
      expect(await read<{ deleted: boolean }>(withdrawn)).toEqual({ deleted: true });

      const snapshot = await read<{ unitDependencies: unknown[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      expect(snapshot.unitDependencies).toEqual([]);

      // Withdrawing it twice is a 404: another owner's edge and a missing one
      // are the same answer, and neither may read as a successful removal.
      const again = await deleteUnitDependency(
        remove(`/api/curriculum/design/tasks/${task.id}/unit-dependencies/${dependencyId}`),
        childParams(task.id, 'unitDependencyId', dependencyId),
      );
      expect(again.status).toBe(404);
    });
  });

  describe('lab tasks', () => {
    it('refuses a verify rule kind that would never fire', async () => {
      await advanceTo('teaching');
      const snapshot = await read<{ objectives: { id: string }[]; units: { id: string }[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      const unitId = snapshot.units[0]!.id;
      const objectiveId = snapshot.objectives[0]!.id;

      const response = await createLabTask(
        post(`/api/curriculum/design/tasks/${task.id}/lab-tasks`, {
          unitId,
          objectiveId,
          taskGoal: '获取 /flag',
          dockerImage: 'ctf/web:1',
          verifyRules: [{ kind: 'flg', value: 'flag{...}' }],
        }),
        taskParams(task.id),
      );
      // This is the case the database cannot catch: the column is JSONB with
      // only an array check, so `flg` would be stored and then never match.
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('flag');
    });

    it('lets the store refuse a lab with no verification rules', async () => {
      await advanceTo('assessment');
      const snapshot = await read<{ objectives: { id: string }[]; units: { id: string }[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      const response = await createLabTask(
        post(`/api/curriculum/design/tasks/${task.id}/lab-tasks`, {
          unitId: snapshot.units[0]!.id,
          objectiveId: snapshot.objectives[0]!.id,
          taskGoal: '获取 /flag',
          dockerImage: 'ctf/web:1',
          verifyRules: [],
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { message: string } }>(response);
      expect(body.error.message).toContain('验证规则');
    });
  });

  describe('review', () => {
    it('evaluates on GET without recording anything', async () => {
      await advanceTo('outline');
      const response = await getReview(
        fetch_(`/api/curriculum/design/tasks/${task.id}/review`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{ persisted: boolean; quality: { exportable: boolean } }>(response);
      expect(body.persisted).toBe(false);
      // A read must not write: a prefetch or a retry would otherwise mutate.
      const rows = await pool.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM curriculum_audit_finding WHERE owner_id = $1',
        [OWNER],
      );
      expect(rows.rows[0]!.count).toBe(0);
    });

    it('records findings on POST, with ids to act on', async () => {
      await advanceTo('outline');
      const response = await postReview(
        post(`/api/curriculum/design/tasks/${task.id}/review`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{
        persisted: boolean;
        findings: { id: string; status: string }[];
        exportable: boolean;
      }>(response);
      expect(body.persisted).toBe(true);
      expect(body.findings.length).toBeGreaterThan(0);
      expect(body.findings[0]!.id).toBeTruthy();
      expect(body.findings[0]!.status).toBe('open');
      // A taught-but-unassessed outcome cannot close the loop.
      expect(body.exportable).toBe(false);
    });
  });

  describe('export gate and coverage', () => {
    it('names the first broken layer rather than every layer', async () => {
      const response = await getExportGate(
        fetch_(`/api/curriculum/design/tasks/${task.id}/export-gate`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{ exportable: boolean; blockers: string[] }>(response);
      expect(body.exportable).toBe(false);
      expect(body.blockers.length).toBeGreaterThan(0);
    });

    it('reports one coverage row per outcome with the three loop flags', async () => {
      await advanceTo('teaching');
      const response = await getCoverageReport(
        fetch_(`/api/curriculum/design/tasks/${task.id}/coverage`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{
        report: {
          counts: { total: number; taught: number; practiced: number; assessed: number };
          objectives: { teaches: boolean; practices: boolean; assesses: boolean }[];
        };
        verdict: { complete: boolean; summary: string };
      }>(response);
      expect(body.report.counts.total).toBe(1);
      expect(body.report.counts.taught).toBe(1);
      expect(body.report.counts.practiced).toBe(0);
      expect(body.report.counts.assessed).toBe(0);
      expect(body.report.objectives[0]!.teaches).toBe(true);
      expect(body.verdict.complete).toBe(false);
      // The summary names the fraction, which is what makes a partly covered
      // design legible. The sentence around it is Chinese because a person reads
      // it: it is the matrix header line, and the count the author sees while
      // the gate's own refusal names the outcomes that are missing.
      expect(body.verdict.summary).toContain('0/1');
    });

    it('reports an accepted defect as something the export ships with', async () => {
      await advanceTo('outline');
      const reviewed = await postReview(
        post(`/api/curriculum/design/tasks/${task.id}/review`),
        taskParams(task.id),
      );
      const blocking = (
        await read<{ findings: { id: string; severity: string; message: string }[] }>(reviewed)
      ).findings.find((finding) => finding.severity === 'error')!;

      const before = await read<{ blockers: string[]; accepted: unknown[] }>(
        await getExportGate(
          fetch_(`/api/curriculum/design/tasks/${task.id}/export-gate`),
          taskParams(task.id),
        ),
      );
      expect(before.blockers.join('；')).toContain(blocking.message);
      expect(before.accepted).toEqual([]);

      await patchFinding(
        patch(`/api/curriculum/design/tasks/${task.id}/findings/${blocking.id}`, {
          status: 'waived',
        }),
        childParams(task.id, 'findingId', blocking.id),
      );

      const after = await read<{
        blockers: string[];
        accepted: { id: string; ruleCode: string; message: string }[];
      }>(
        await getExportGate(
          fetch_(`/api/curriculum/design/tasks/${task.id}/export-gate`),
          taskParams(task.id),
        ),
      );
      // Out of the blockers, into the list of what is being accepted — read from
      // the same evaluation the gate decides on, so "may I produce this" and
      // "what am I shipping with" cannot come from two readings.
      expect(after.blockers.join('；')).not.toContain(blocking.message);
      expect(after.accepted.map((entry) => entry.id)).toContain(blocking.id);
      expect(after.accepted[0]!.ruleCode).toBeTruthy();
    });
  });

  describe('the remaining write surface', () => {
    it('renames and deletes a task', async () => {
      const renamed = await patchTask(
        patch(`/api/curriculum/design/tasks/${task.id}`, { title: 'CTF 综合实战（改）' }),
        taskParams(task.id),
      );
      expect(renamed.status).toBe(200);
      const body = await read<{ task: CurriculumTaskRecord }>(renamed);
      expect(body.task.title).toBe('CTF 综合实战（改）');

      const deleted = await deleteTask(
        remove(`/api/curriculum/design/tasks/${task.id}`),
        taskParams(task.id),
      );
      expect(deleted.status).toBe(200);
      expect(
        (await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)))
          .status,
      ).toBe(404);
    });

    it('records evidence for an outcome', async () => {
      await advanceTo('outcomes');
      const created = await createObjective(
        post(`/api/curriculum/design/tasks/${task.id}/objectives`, {
          title: '能够解释 SQL 注入为什么发生',
          objectiveType: 'knowledge',
        }),
        taskParams(task.id),
      );
      const objectiveId = (await read<{ objective: { id: string } }>(created)).objective.id;

      const response = await createEvidence(
        post(`/api/curriculum/design/tasks/${task.id}/evidence`, {
          objectiveId,
          evidenceType: 'quiz',
          verificationMethod: '理论题',
          successCondition: '答对全部单选题',
        }),
        taskParams(task.id),
      );
      expect(response.status).toBe(201);
      const body = await read<{ evidence: { objectiveId: string; assessmentMode: string } }>(
        response,
      );
      expect(body.evidence.objectiveId).toBe(objectiveId);
      expect(body.evidence.assessmentMode).toBe('practice');
    });

    it('replaces the whole coverage set on PUT rather than appending', async () => {
      await advanceTo('outline');
      const snapshot = await read<{ objectives: { id: string }[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      const objectiveId = snapshot.objectives[0]!.id;
      const lecture = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'item',
          title: '1.1 SQL 注入原理',
          unitRole: 'lecture',
        }),
        taskParams(task.id),
      );
      const lectureId = (await read<{ unit: { id: string } }>(lecture)).unit.id;
      const practice = await createUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units`, {
          unitType: 'item',
          title: '1.2 SQL 注入练习',
          unitRole: 'practice',
        }),
        taskParams(task.id),
      );
      const practiceId = (await read<{ unit: { id: string } }>(practice)).unit.id;

      const first = await putCoverage(
        put(`/api/curriculum/design/tasks/${task.id}/unit-coverage`, {
          rows: [
            { unitId: lectureId, objectiveId, coverageKind: 'teach' },
            { unitId: practiceId, objectiveId, coverageKind: 'practice' },
          ],
        }),
        taskParams(task.id),
      );
      expect(first.status).toBe(200);
      expect((await read<{ rows: unknown[] }>(first)).rows).toHaveLength(2);

      // The second PUT carries only one row, so the practice row must go:
      // this is a set replacement, and an append would silently keep a
      // coverage claim the caller withdrew.
      const second = await putCoverage(
        put(`/api/curriculum/design/tasks/${task.id}/unit-coverage`, {
          rows: [{ unitId: lectureId, objectiveId, coverageKind: 'teach' }],
        }),
        taskParams(task.id),
      );
      expect(second.status).toBe(200);
      expect((await read<{ rows: unknown[] }>(second)).rows).toHaveLength(1);
    });

    it('creates a question and refuses one with no answer key', async () => {
      await advanceTo('assessment');
      const snapshot = await read<{ objectives: { id: string }[]; units: { id: string }[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      const unitId = snapshot.units[0]!.id;
      const objectiveId = snapshot.objectives[0]!.id;

      const bad = await createQuestion(
        post(`/api/curriculum/design/tasks/${task.id}/questions`, {
          unitId,
          objectiveId,
          questionType: 'single',
          stem: 'SQL 注入的成因是什么？',
          options: [
            { key: 'A', text: '用户输入未作为数据与语句分离' },
            { key: 'B', text: '网络延迟过高' },
          ],
          answer: [],
        }),
        taskParams(task.id),
      );
      expect(bad.status).toBe(400);

      const good = await createQuestion(
        post(`/api/curriculum/design/tasks/${task.id}/questions`, {
          unitId,
          objectiveId,
          questionType: 'single',
          stem: 'SQL 注入的成因是什么？',
          options: [
            { key: 'A', text: '用户输入未作为数据与语句分离' },
            { key: 'B', text: '网络延迟过高' },
          ],
          answer: ['A'],
          distractors: [{ optionKey: 'B', misconception: '把性能问题误认为注入成因' }],
        }),
        taskParams(task.id),
      );
      expect(good.status).toBe(201);
      const body = await read<{ question: { answer: string[]; distractors: unknown[] } }>(good);
      expect(body.question.answer).toEqual(['A']);
      expect(body.question.distractors).toHaveLength(1);
    });

    it('草稿里"模型没标 Bloom 层级"的题也能落库', async () => {
      // 这一条测的是**两条写入路径的宽容度不同**：`assessment/turn` 路由直接调 store，
      // 而草稿的每一行都要过 HTTP 的 `parseQuestionInput`。`QuestionWrite.bloomLevel` 在
      // 模型没标 Bloom 层级时就是 `null`（`draft.bloomLevel ?? null`），而 `oneOf` 读见
      // 显式 `null` 报的是"取值非法"——所以**草稿的 body 里不能带这个键**，否则每一道没标
      // Bloom 层级的题采纳时都会收到一句与建议无关的报错。
      await advanceTo('assessment');
      const snapshot = await getCurriculumDesignSnapshot(pool, OWNER, task.id);
      const unitId = snapshot.units[0]!.id;
      const objectiveId = snapshot.objectives[0]!.id;

      const question = {
        unitId,
        objectiveId,
        evidenceId: null,
        questionType: 'single' as const,
        stem: 'SQL 注入的成因是什么？',
        options: [
          { key: 'A', text: '用户输入未作为数据与语句分离' },
          { key: 'B', text: '网络延迟过高' },
        ],
        answer: ['A'],
        explanation: null,
        distractors: [],
        difficulty: 'basic' as const,
        // 模型没写 Bloom 层级——多数情况如此。
        bloomLevel: null,
        score: 1,
        sortOrder: 1,
      };
      const draft = assessmentDraftOf({
        turn: {
          message: '出了一道题。',
          writes: {
            createQuestions: [question],
            updateQuestions: [],
            createLabTasks: [],
            updateLabTasks: [],
            removeQuestionIds: [],
            removeLabTaskIds: [],
            rejectedRefs: [],
            advisories: [],
            changed: true,
          },
          modelRequestedConfirm: false,
          confirmRequested: false,
          gaps: [],
          changedAnything: true,
          userTurns: 1,
          artifactCount: 1,
        },
        board: assessmentBoardOf(snapshot),
        taskId: task.id,
        instruction: '出题',
      });
      const body = draft.lines.find((row) => row.create !== undefined)!.create!.body;
      expect(body).not.toHaveProperty('bloomLevel');

      // 对照：**带** `null` 的那一份正是这条测试要挡住的写法。
      const withNull = await createQuestion(
        post(`/api/curriculum/design/tasks/${task.id}/questions`, {
          ...body,
          bloomLevel: null,
        }),
        taskParams(task.id),
      );
      expect(withNull.status).toBe(400);

      const saved = await createQuestion(
        post(`/api/curriculum/design/tasks/${task.id}/questions`, body),
        taskParams(task.id),
      );
      expect(saved.status, await saved.clone().text()).toBe(201);
      expect(
        (await read<{ question: { stem: string; bloomLevel: string | null } }>(saved)).question,
      ).toMatchObject({ stem: question.stem, bloomLevel: null });
    });

    it('validates a finding status instead of reaching a CHECK constraint', async () => {
      await advanceTo('outline');
      const reviewed = await postReview(
        post(`/api/curriculum/design/tasks/${task.id}/review`),
        taskParams(task.id),
      );
      const findingId = (await read<{ findings: { id: string }[] }>(reviewed)).findings[0]!.id;

      const bad = await patchFinding(
        patch(`/api/curriculum/design/tasks/${task.id}/findings/${findingId}`, {
          status: 'ignored',
        }),
        childParams(task.id, 'findingId', findingId),
      );
      expect(bad.status).toBe(400);

      const good = await patchFinding(
        patch(`/api/curriculum/design/tasks/${task.id}/findings/${findingId}`, {
          status: 'waived',
        }),
        childParams(task.id, 'findingId', findingId),
      );
      expect(good.status).toBe(200);
      const body = await read<{ finding: { status: string } }>(good);
      expect(body.finding.status).toBe('waived');

      // `resolved` is in the column's vocabulary but not in a caller's: a review is
      // derived, so the only decision an author can make about a live defect is to
      // accept it, and the refusal has to explain the way out rather than 500 on
      // the CHECK constraint.
      const refused = await patchFinding(
        patch(`/api/curriculum/design/tasks/${task.id}/findings/${findingId}`, {
          status: 'resolved',
        }),
        childParams(task.id, 'findingId', findingId),
      );
      expect(refused.status).toBe(400);
      const refusal = await read<{ error: { message: string } }>(refused);
      expect(refusal.error.message).toContain('已修复');
      expect(refusal.error.message).toContain('接受');

      // Undoing the acceptance is a decision too, and it has to be reachable:
      // a decision that cannot be revised is a trap.
      const reopened = await patchFinding(
        patch(`/api/curriculum/design/tasks/${task.id}/findings/${findingId}`, {
          status: 'open',
        }),
        childParams(task.id, 'findingId', findingId),
      );
      expect(reopened.status).toBe(200);
      expect((await read<{ finding: { status: string } }>(reopened)).finding.status).toBe('open');
    });
  });

  describe('traceability', () => {
    it('needs a direction', async () => {
      const response = await getTrace(
        fetch_(`/api/curriculum/design/tasks/${task.id}/trace`),
        taskParams(task.id),
      );
      expect(response.status).toBe(400);
    });

    it('traces from an outcome to what teaches it', async () => {
      await advanceTo('teaching');
      const snapshot = await read<{ objectives: { id: string }[] }>(
        await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
      );
      const objectiveId = snapshot.objectives[0]!.id;
      const response = await getTrace(
        fetch_(`/api/curriculum/design/tasks/${task.id}/trace?objectiveId=${objectiveId}`),
        taskParams(task.id),
      );
      expect(response.status).toBe(200);
      const body = await read<{
        direction: string;
        trace: {
          units: { kind: string }[];
          coverage: { teach: boolean; practice: boolean; assess: boolean };
        };
      }>(response);
      expect(body.direction).toBe('objective-to-course');
      expect(body.trace.units.map((traced) => traced.kind)).toEqual(['teach']);
      expect(body.trace.coverage).toEqual({ teach: true, practice: false, assess: false });
    });

    it('404s an unknown unit', async () => {
      const response = await getTrace(
        fetch_(`/api/curriculum/design/tasks/${task.id}/trace?unitId=unit-nope`),
        taskParams(task.id),
      );
      expect(response.status).toBe(404);
    });
  });

  describe('producing a designed item', () => {
    /** A stored-run stand-in; the route only re-reads its id and input. */
    const startedRun = (ownerId: string, input: unknown) => ({
      id: 'run-generated-item',
      ownerId,
      state: 'preparing',
      step: null,
      seq: 1,
      input,
      outline: null,
      agents: null,
      stageId: null,
      progress: { scenesTotal: 0, scenesCompleted: 0 },
      error: null,
      mediaPending: false,
      narrationUnvoiced: 0,
      mediaSummary: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      leaseWorkerId: null,
      leaseHeartbeatAt: null,
      leaseGeneration: 0,
      takeovers: 0,
    });

    beforeEach(() => {
      // Reset, not just re-implement. This file has no global `clearMocks`, so
      // calls accumulate across tests and `mock.calls[0]` would silently be the
      // *previous* test's run — which reads as a real product failure rather
      // than as a dirty mock.
      mocks.startGenerationRun.mockReset();
      mocks.startGenerationRun.mockImplementation((ownerId: string, input: unknown) =>
        Promise.resolve(startedRun(ownerId, input)),
      );
    });

    /** Build a design that passes the export gate, plus its items. */
    async function closableDesign() {
      // `advanceTo('teaching')` is the furthest point that builds an item: it
      // creates the outcome, its evidence, the node, one lecture item and its
      // teach coverage, then advances. Starting from 'outline' would stop one
      // line earlier and leave no item at all.
      await advanceTo('teaching');
      const objectiveId = (
        await read<{ objectives: { id: string }[] }>(
          await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        )
      ).objectives[0]!.id;

      // The lecture the helper made is already the teaching coverage; read it
      // back rather than adding a second one for the same outcome.
      const teach = (
        await read<{ units: { id: string; unitRole: string | null }[] }>(
          await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        )
      ).units.find((unit) => unit.unitRole === 'lecture')!;

      // The teaching design must name the outcome's primary support node.
      // `objective_missing_prereq` is the rule that stops an outcome being
      // taught by nothing that mentions the knowledge it rests on, so the
      // fixture has to author one rather than wave it through — the gate is
      // right to refuse an item whose teaching design is still empty.
      const nodeId = (
        await read<{ nodes: { id: string }[] }>(
          await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        )
      ).nodes[0]!.id;
      await patchUnit(
        patch(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}`, {
          // The `core` bucket names the node by **name** rather than by id on
          // purpose: a name is unambiguous inside one item's own node set, and the
          // rules layer has to translate it instead of silently dropping the
          // claim. The stored design still holds the id.
          teachingDesign: { nodes: [nodeId], core: ['SQL 查询与参数化'] },
          // A lecture without a storyboard is refused since step 6: the generator
          // would invent its own page structure, and then "what this lesson
          // teaches" would no longer be the author's decision.
          deckDesign: {
            estPages: 1,
            pages: [
              {
                order: 1,
                title: '参数拼接就是注入点',
                goal: '学员能指出注入点',
                coreInfo: '参数被拼进 SQL 的地方就是注入点',
                mode: 'explain',
                teaches: ['SQL 查询与参数化'],
              },
            ],
          },
        }),
        childParams(task.id, 'unitId', teach.id),
      );

      const practise = await createCurriculumUnit(pool, OWNER, task.id, {
        unitType: 'item',
        title: '1.2 SQL 注入练习',
        unitRole: 'practice',
      });
      await createCurriculumUnitCoverage(pool, OWNER, task.id, {
        unitId: practise.id,
        objectiveId,
        coverageKind: 'practice',
      });
      const assess = await createCurriculumUnit(pool, OWNER, task.id, {
        unitType: 'item',
        title: '1.3 SQL 注入考核',
        unitRole: 'exam',
      });
      await createCurriculumUnitCoverage(pool, OWNER, task.id, {
        unitId: assess.id,
        objectiveId,
        coverageKind: 'assess',
      });
      // Every item needs its teaching design before the step can close — a drill
      // and an exam included, because "what does this drill drill" is the question
      // the questions and lab tasks below are authored against.
      for (const [unitId, bucket] of [
        [practise.id, 'core'],
        [assess.id, 'mention'],
      ] as const) {
        await patchUnit(
          patch(`/api/curriculum/design/tasks/${task.id}/units/${unitId}`, {
            teachingDesign: { [bucket]: [nodeId] },
          }),
          childParams(task.id, 'unitId', unitId),
        );
      }
      // Step 6's sign-off, the fifth of the same kind: the lesson design has to be
      // agreed before the questions and labs that check it are authored.
      await confirmCurriculumDesignStep(pool, OWNER, task.id, 'teaching', 'user');
      // `advanceTo` declared lab evidence for this outcome, so a lab task must
      // exist to honour it. `evidence_no_artifact` is the rule that makes the
      // loop closable in practice rather than only on paper: an outcome that
      // promises a lab and has none is not assessable.
      // The lab is written *after* the advance: the phase machine refuses
      // assessment work while the task is still in `teaching`, and that refusal
      // is the machine working — this fixture follows it rather than reaching
      // around it.
      await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → assessment
      await createCurriculumLabTask(pool, OWNER, task.id, {
        unitId: assess.id,
        objectiveId,
        assessmentMode: 'exam',
        taskGoal: '读取 /flag',
        dockerImage: 'openmaic/ctf-web:latest',
        // An exam lab is held to the strict contract: no hints, no retry, a
        // time limit. The `curriculum_lab_exam_strict` CHECK enforces it in the
        // database, so a fixture that omits these cannot be written at all.
        hintPolicy: 'forbidden',
        allowRetry: false,
        timeLimitSec: 900,
        verifyRules: [{ kind: 'flag', value: 'flag{ok}' }],
      });
      // Step 7's sign-off, the sixth of the same kind: the questions and the lab
      // tasks are what `assessment → review` is about, so the walk agrees to them
      // before leaving the phase. Without it the gate refuses — and it is right
      // to: entering review on top of an assessment nobody read is the hole this
      // confirmation exists to close.
      await confirmCurriculumDesignStep(pool, OWNER, task.id, 'assessment', 'user');
      await advanceCurriculumTaskPhase(pool, OWNER, task.id); // → review
      return { objectiveId, teach, practise, assess };
    }

    it('starts a run whose scene types come from the item’s role', async () => {
      const { teach, practise, assess } = await closableDesign();

      const lecture = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      expect(lecture.status).toBe(202);

      const drill = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${practise.id}/generate`),
        childParams(task.id, 'unitId', practise.id),
      );
      expect(drill.status).toBe(202);

      const test = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${assess.id}/generate`),
        childParams(task.id, 'unitId', assess.id),
      );
      expect(test.status).toBe(202);

      const inputs = mocks.startGenerationRun.mock.calls.map(
        (call) =>
          call[1] as {
            sceneTypes: string[];
            interactive: boolean;
            taskEngine: boolean;
          },
      );
      // The defect being replaced was `['slide']` for all three.
      expect(inputs[0]!.sceneTypes).toEqual(['slide']);
      expect(inputs[1]!.sceneTypes).toEqual(['slide', 'quiz', 'interactive']);
      expect(inputs[2]!.sceneTypes).toEqual(['slide', 'quiz']);
      expect(inputs[2]!.sceneTypes).not.toContain('interactive');
      expect(inputs[1]!.taskEngine).toBe(true);
    });

    it('builds the requirement from the outcome the item serves', async () => {
      const { teach } = await closableDesign();
      await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      const input = mocks.startGenerationRun.mock.calls[0]![1] as { requirement: string };
      // Not "本节我们学习X": the stage is named after this text, and a title
      // there teaches nothing about what the course promised.
      expect(input.requirement).toContain('在靶场中构造 payload 读取 flag');
      expect(input.requirement).not.toMatch(/本节我们学习/);
    });

    it('carries the page plan of a lecture and not of a drill', async () => {
      const { teach, practise } = await closableDesign();
      const applied = await patchUnit(
        patch(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}`, {
          deckDesign: {
            pages: [
              {
                order: 1,
                title: '注入为何成立',
                goal: '能说出参数拼接的后果',
                coreInfo: '值被直接拼进查询',
                mode: 'explain',
                // The page has to carry the node the script says it teaches to
                // full depth: a lecture that claims "讲透 X" and plans no page for
                // X is refused before it can be produced, which is the rule this
                // test's rewrite exercises rather than works around.
                teaches: ['SQL 查询与参数化'],
              },
            ],
          },
        }),
        childParams(task.id, 'unitId', teach.id),
      );
      // Asserted, not assumed: a silently-refused patch would make this test
      // pass for the wrong reason on the `drill` half and fail confusingly here.
      expect(applied.status).toBe(200);
      const appliedBody = await read<{ unit: { deckDesign: { pages: unknown[] } } }>(applied);
      expect(appliedBody.unit.deckDesign.pages).toHaveLength(1);

      await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${practise.id}/generate`),
        childParams(task.id, 'unitId', practise.id),
      );

      const lecture = mocks.startGenerationRun.mock.calls[0]![1] as { deckDesign?: unknown };
      const drill = mocks.startGenerationRun.mock.calls[1]![1] as { deckDesign?: unknown };
      expect(lecture.deckDesign).toMatchObject({ pages: [{ goal: '能说出参数拼接的后果' }] });
      expect(drill.deckDesign).toBeUndefined();
    });

    it('carries the design ids so the produced stage is traceable', async () => {
      const { teach } = await closableDesign();
      await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      const input = mocks.startGenerationRun.mock.calls[0]![1] as {
        curriculumTaskId?: string;
        curriculumUnitId?: string;
      };
      expect(input.curriculumTaskId).toBe(task.id);
      expect(input.curriculumUnitId).toBe(teach.id);
    });

    it('refuses an unclosed design and starts nothing', async () => {
      // The `advanceTo('teaching')` design teaches one outcome and neither
      // practises nor assesses it: the loop is open, so producing the lecture
      // would create content for a promise nothing checks.
      await advanceTo('teaching');
      const teach = (
        await read<{ units: { id: string; unitRole: string | null }[] }>(
          await getTask(fetch_(`/api/curriculum/design/tasks/${task.id}`), taskParams(task.id)),
        )
      ).units.find((unit) => unit.unitRole === 'lecture')!;

      const response = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      expect(response.status).toBe(400);
      // The ordering that matters: the gate runs before the start, so a refusal
      // leaves no orphaned, paid-for run behind.
      expect(mocks.startGenerationRun).not.toHaveBeenCalled();
    });

    it('404s an item belonging to someone else', async () => {
      const { teach } = await closableDesign();
      mocks.resolveOwnerId.mockReturnValue(OTHER);
      const response = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      // The same answer as an unknown id: a 409 about the design would confirm
      // that this id exists.
      expect(response.status).toBe(404);
      expect(mocks.startGenerationRun).not.toHaveBeenCalled();
    });

    it('refuses a chapter, which carries no role and cannot be produced', async () => {
      const { teach } = await closableDesign();
      const chapter = await pool.query<{ id: string }>(
        `INSERT INTO curriculum_unit (id, owner_id, task_id, unit_type, title, unit_role)
         VALUES ('unit-chapter', $1, $2, 'chapter', '第一章 基础', NULL) RETURNING id`,
        [OWNER, task.id],
      );
      const response = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${chapter.rows[0]!.id}/generate`),
        childParams(task.id, 'unitId', chapter.rows[0]!.id),
      );
      expect(response.status).toBe(400);
      expect(mocks.startGenerationRun).not.toHaveBeenCalled();
      expect(teach.id).toBeTruthy();
    });

    // The bug this covers was found on the live server, not by reasoning: the
    // walk produced a lecture and a practice, then the exam came back
    // `500 CURRICULUM_DESIGN_FAILED`. That was the owner's *third* run, and the
    // active-run limit is 2 — so the exam was refused, not faulted, and the
    // refusal was reported as a broken server. The walk's first two assertions
    // passing is what made it look exam-specific.
    it('maps a refused start to the refusal’s own status, not a 500', async () => {
      const { teach } = await closableDesign();
      // The real error class from the real module, thrown by the mocked starter,
      // so `startRefusal` recognises it by `instanceof` exactly as it would in
      // production. A plain `Error` with a similar message would not be mapped
      // and this test would pass for the wrong reason.
      const { ActiveRunLimitError } = await import('@/lib/server/generation/run/store');
      mocks.startGenerationRun.mockRejectedValueOnce(new ActiveRunLimitError(2));

      const response = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );

      expect(response.status).toBe(429);
      const body = await read<{ error: { code: string; message: string } }>(response);
      expect(body.error.code).toBe('ACTIVE_RUN_LIMIT');
      // The limit itself must survive: "429" alone tells the caller to wait
      // forever, while the number tells them how many to finish first.
      expect(body.error.message).toContain('2');
      expect(body.error.code).not.toBe('CURRICULUM_DESIGN_FAILED');
    });

    it('answers 400 for a start refused by the caller, not by a limit', async () => {
      const { teach } = await closableDesign();
      const { ClassroomMaterialsRejectedError } = await import('@/lib/server/classroom-materials');
      mocks.startGenerationRun.mockRejectedValueOnce(
        new ClassroomMaterialsRejectedError('material not available'),
      );

      const response = await generateUnit(
        post(`/api/curriculum/design/tasks/${task.id}/units/${teach.id}/generate`),
        childParams(task.id, 'unitId', teach.id),
      );
      expect(response.status).toBe(400);
      const body = await read<{ error: { code: string } }>(response);
      expect(body.error.code).toBe('INVALID_REQUEST');
    });
  });

  /**
   * The cockpit aggregate.
   *
   * Two things are under test and both are invisible without them. The owner
   * fence first: this route reads *every* task of an owner and derives an audit
   * for each, so a missing fence leaks another owner's whole design rather than
   * merely miscounting. Second, and the reason the route does not read
   * `curriculum_audit_finding`: that table is only synced when a review is
   * explicitly requested (`syncCurriculumAuditFindings`), so counting its rows
   * would make "我有 3 处阻塞" depend on when the user last pressed 审核 — a
   * dependency the cockpit never states. The route derives instead.
   *
   * `blockingCount` is therefore **not** `evaluation.blocking.length`: the
   * derived audit reports "there are no items yet" and "there are no questions
   * yet" — steps the design has not reached — so counting it raw would give a
   * brand-new 目 "4 review problems are blocking the export". Only findings on
   * layers this design has already reached are counted (`blocking-scope.ts`).
   * The three cases below pin both sides of that boundary.
   */
  describe('design overview (cockpit aggregate)', () => {
    it('reports the aggregate for the owner and answers from a derived audit', async () => {
      await advanceTo('graph');

      const response = await overview(fetch_('/api/curriculum/design/overview'));
      expect(response.status).toBe(200);
      const body = await read<{
        rows: Array<{
          taskId: string;
          phase: string;
          unitCount: number;
          objectiveCount: number;
          blockingCount: number;
          exportable: boolean;
        }>;
      }>(response);

      expect(body.rows).toHaveLength(1);
      const row = body.rows[0]!;
      expect(row.taskId).toBe(task.id);
      expect(row.phase).toBe('graph');
      expect(row.objectiveCount).toBe(1);
      // 这一目的 1–4 步都走完了，层 `outcomes_verifiable` / `support_complete` /
      // `dependency_valid` 已经到达，但**后面**的 `teach_covers` 一层还没走到。
      // 所以派生审计报的"还没有条目"不该计入：`blockingCount` 是 0，而
      // `exportable` 仍然是 false——两者问的是两个不同的问题（见下）。
      expect(row.blockingCount).toBe(0);
      expect(row.exportable).toBe(false);
    });

    it('a gap the design has already reached counts as blocking', async () => {
      // 同一个"从派生审核算"的性质，用一个**真的走到那一步**的缺陷来证明：
      // `advanceTo` 造出来的目标带预期行为与最低标准，所以它是可验证的；这里
      // 追加一个不可验证的目标，`outcomes_verifiable` 层立刻破，而这一目已经
      // 走到了 `graph`。这才是"有阻塞"的含义——不是"还没做"，是"做了但做错"。
      await advanceTo('graph');
      await createCurriculumObjective(pool, OWNER, task.id, {
        title: '了解 SQL 注入',
        objectiveType: 'knowledge',
      });

      const response = await overview(fetch_('/api/curriculum/design/overview'));
      const body = await read<{ rows: Array<{ blockingCount: number }> }>(response);
      // 两条，不是一条：既不可验证（没写预期行为与最低标准），也没有证据（没人
      // 说明它将被如何检验）。两条都在 `outcomes_verifiable` 层，而这一目已经
      // 走到了 `graph`——所以这才是"卡住"，与上面那条的 0 构成对照。
      expect(body.rows[0]!.blockingCount).toBe(2);
    });

    it('counts the export gate exactly once the design has walked every phase', async () => {
      // 走完 `assessment` 之后所有层都到达，此时 `blockingCount` 必须与闸门
      // 口径相等——这条不变式是驾驶舱不必另设一套口径的原因，也是
      // `blocking-scope.test.ts` 里那张阶段→层表的用途。
      await advanceTo('assessment');
      const response = await overview(fetch_('/api/curriculum/design/overview'));
      const body = await read<{ rows: Array<{ blockingCount: number }> }>(response);
      const row = body.rows[0]!;
      const review = await getReview(
        fetch_(`/api/curriculum/design/tasks/${task.id}/review`),
        taskParams(task.id),
      );
      const gate = await read<{ blocking: unknown[] }>(review);
      expect(row.blockingCount).toBe(gate.blocking.length);
    });

    it('narrows to one series and never answers with another owner’s task', async () => {
      const series = await createCurriculumSeries(pool, OWNER, {
        name: '另一个系列',
      });
      const other = await createCurriculumTask(pool, OWNER, {
        title: '另一个系列里的目',
        audience: 'x',
        problemStatement: 'y',
        durationHours: 1,
        seriesId: series.id,
      });

      // Two tasks for OWNER: the fixture's unassigned one and this series-scoped
      // one. Narrowing must drop the first and keep the second.
      const scoped = await overview(
        fetch_(`/api/curriculum/design/overview?seriesId=${encodeURIComponent(series.id)}`),
      );
      const scopedBody = await read<{ rows: Array<{ taskId: string }> }>(scoped);
      expect(scopedBody.rows.map((row) => row.taskId)).toEqual([other.id]);

      mocks.resolveOwnerId.mockReturnValue(OTHER);
      const mine = await overview(fetch_('/api/curriculum/design/overview'));
      const body = await read<{ rows: Array<{ taskId: string }> }>(mine);
      // Both tasks belong to OWNER; as OTHER the caller sees none of them.
      expect(body.rows).toEqual([]);
    });

    it('returns an empty list rather than 404 for an owner with no tasks', async () => {
      mocks.resolveOwnerId.mockReturnValue('owner:design-routes-empty');
      const response = await overview(fetch_('/api/curriculum/design/overview'));
      expect(response.status).toBe(200);
      const body = await read<{ rows: unknown[] }>(response);
      expect(body.rows).toEqual([]);
    });
  });
});
