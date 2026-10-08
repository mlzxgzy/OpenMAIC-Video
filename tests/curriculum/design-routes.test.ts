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
}));

vi.mock('@/lib/server/identity/resolve', async () =>
  (await import('../helpers/owner-resolution-mock')).ownerResolveModule(mocks.resolveOwnerId),
);

// Substitute only the provider wiring; every real store function stays.
vi.mock('@/lib/server/curriculum/design-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/server/curriculum/design-store')>();
  return { ...actual, getCurriculumDesignProvider: async () => mocks.provider.current };
});

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
import { GET as getExportGate } from '@/app/api/curriculum/design/tasks/[id]/export-gate/route';
import { GET as getTrace } from '@/app/api/curriculum/design/tasks/[id]/trace/route';

import { ensureCurriculumSchema } from '@/lib/persistence/curriculum';
import {
  advanceCurriculumTaskPhase,
  createCurriculumEvidence,
  createCurriculumLearningNode,
  createCurriculumObjective,
  createCurriculumTask,
  createCurriculumUnit,
  createCurriculumUnitCoverage,
  setCurriculumNodeObjectives,
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
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'graph') return;
    const node = await createCurriculumLearningNode(pool, OWNER, task.id, {
      name: 'SQL 查询与参数化',
      nodeType: 'knowledge',
    });
    await setCurriculumNodeObjectives(pool, OWNER, task.id, [
      { nodeId: node.id, objectiveId: objective.id },
    ]);
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
    await advanceCurriculumTaskPhase(pool, OWNER, task.id);
    if (phase === 'teaching') return;
    // → assessment: the gate is teaching coverage, which is already in place.
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
      // Each gap names a field, not just the phase.
      expect(body.gaps.join(' ')).toContain('audience');
    });

    it('advances once the brief is complete', async () => {
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
      expect(body.error.message).toContain('audience');
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

  describe('outcome validation and derivation', () => {
    beforeEach(async () => {
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
      expect(body.error.message).toContain('chapter');
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
      expect(body.error.message).toContain('not interchangeable');
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
      expect(body.error.message).toContain('verification rule');
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
      expect(body.verdict.summary).toContain('1 outcome');
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
});
