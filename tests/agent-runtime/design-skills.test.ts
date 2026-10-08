/**
 * The outcome-first skill set: which skills the runtime discovers, what each
 * one is allowed to author, and what the demotions actually removed.
 *
 * A skill directory is only half a contract — the other half is that a skill
 * the model can discover but not follow is worse than no skill at all. So
 * these tests pin three things that a prose edit could silently break:
 *
 *  1. All eleven design phases are discoverable, each with a phase lock in its
 *     body. The phase lock is what makes the skills composable: the store
 *     refuses out-of-order writes, and the skill is what tells the model to
 *     stop rather than spend its budget discovering refusals.
 *
 *  2. `understanding-by-design` is GONE from discovery. It was demoted to a
 *     reference document under `outcome-design/references/`, because an
 *     enduring understanding has no pass/fail condition and cannot be the
 *     objective record. Leaving it discoverable would let a model build a
 *     course on an unverifiable outcome model — exactly the regression the
 *     redesign exists to remove.
 *
 *  3. `stage-design` still exists (a one-off classroom with no outcomes to
 *     verify is a real case) but now points at the course-design path instead
 *     of being the only way to build anything.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { listSkills } from '@/lib/server/agent-runtime/skills';
import { CURRICULUM_DESIGN_PHASES } from '@/lib/curriculum/design-types';

/** The eleven design skills, in design order. */
const DESIGN_SKILLS = [
  'course-analysis',
  'outcome-design',
  'knowledge-decomposition',
  'dependency-builder',
  'outline-designer',
  'teaching-designer',
  'deck-designer',
  'practice-designer',
  'exam-designer',
  'content-producer',
  'course-auditor',
] as const;

const SKILLS_DIR =
  process.env.OPENMAIC_AGENT_SKILLS_DIR ?? join(process.cwd(), 'skills/agent-runtime');

/** Collapse whitespace so prose assertions survive a re-wrap. */
const prose = (text: string) => text.replace(/\s+/g, ' ');

async function loadSkillMap() {
  const skills = await listSkills();
  return new Map(skills.map((skill) => [skill.name, skill]));
}

describe('outcome-first design skills', () => {
  it('discovers all eleven design skills', async () => {
    const skills = await loadSkillMap();
    for (const name of DESIGN_SKILLS) {
      expect(skills.has(name), `skill "${name}" must be discoverable`).toBe(true);
    }
  });

  it('gives every design skill a description the model can route on', async () => {
    const skills = await loadSkillMap();
    for (const name of DESIGN_SKILLS) {
      const description = skills.get(name)!.description ?? '';
      // A description is the only thing the model sees when deciding whether
      // to load a skill. An empty or placeholder one makes the skill
      // undiscoverable in practice, however good its body is.
      expect(description.length, `${name} needs a real description`).toBeGreaterThan(80);
      expect(description).not.toMatch(/^TODO|^TBD|placeholder/i);
    }
  });

  it('states the phase lock in every design skill body', async () => {
    const skills = await loadSkillMap();
    for (const name of DESIGN_SKILLS) {
      const content = prose(skills.get(name)!.content);
      expect(content, `${name} must carry a phase lock`).toContain('Phase lock');
    }
  });

  it('names the design order in the entry skill, so the model can orient itself', async () => {
    const skills = await loadSkillMap();
    const content = prose(skills.get('course-analysis')!.content);
    // The order is the argument the whole model rests on. It is stated in the
    // first skill because a model that starts mid-sequence needs to know what
    // came before it.
    expect(content).toContain('brief');
    expect(content).toContain('outcomes');
    expect(content).toContain('evidence');
    expect(content).toContain('dependency');
  });

  it('keeps the phase names in every skill aligned with the store phase machine', async () => {
    // A skill that names a phase the store does not have would tell the model
    // to wait for a gate that never arrives. Only the explicit "phase N (name)"
    // and "you are in phase N (name)" forms are checked — the words brief,
    // core, assess and so on are content buckets and sections, not phases.
    const known = new Set<string>(CURRICULUM_DESIGN_PHASES);
    const skills = await loadSkillMap();
    for (const name of DESIGN_SKILLS) {
      const content = prose(skills.get(name)!.content);
      const mentioned = content.match(/phase \d+\s*\(([a-z]+)\)/g) ?? [];
      for (const match of mentioned) {
        const phase = match.match(/\(([a-z]+)\)/)![1]!;
        expect(
          known.has(phase),
          `${name} references phase "${phase}", which the store does not have`,
        ).toBe(true);
      }
    }
  });

  it('forbids the two shortcuts the redesign exists to remove', async () => {
    const skills = await loadSkillMap();
    // The failure this whole system exists to prevent is chapters-and-slides
    // first, content poured in afterwards. The entry skills must say so.
    const outlineDesigner = prose(skills.get('outline-designer')!.content);
    expect(outlineDesigner.toLowerCase()).toMatch(
      /rendering|derived from the graph|not the source/,
    );

    // And the second shortcut: grading a lab by its reference route.
    const practiceDesigner = prose(skills.get('practice-designer')!.content);
    expect(practiceDesigner).toMatch(/referenceSolution|reference solution/i);
    expect(practiceDesigner.toLowerCase()).toMatch(
      /never grades|not what decides|never the reference/,
    );
  });
});

describe('demoted and retained skills', () => {
  it('no longer discovers understanding-by-design', async () => {
    const skills = await loadSkillMap();
    // Demoted to a reference doc: an enduring understanding has no pass/fail
    // condition, so it cannot be the objective record. If this skill were
    // still discoverable the model would build courses on an outcome model
    // the database refuses to accept.
    expect(skills.has('understanding-by-design')).toBe(false);
  });

  it('keeps the UbD material as a reference document under outcome-design', () => {
    const referencePath = join(SKILLS_DIR, 'outcome-design/references/understanding-by-design.md');
    expect(existsSync(referencePath), 'the UbD reference must survive the demotion').toBe(true);
    const body = readFileSync(referencePath, 'utf8');
    // Reference, not skill: no frontmatter, and it says why it was demoted.
    expect(body.startsWith('---')).toBe(false);
    expect(prose(body)).toContain('参考');
  });

  it('still discovers stage-design for the one-off classroom path', async () => {
    const skills = await loadSkillMap();
    // A single lesson with nothing to verify is a real case; deleting this
    // would force the whole course machinery onto a one-off request.
    expect(skills.has('stage-design')).toBe(true);
  });

  it('points stage-design at the course-design path instead of owning it', () => {
    const content = readFileSync(join(SKILLS_DIR, 'stage-design/SKILL.md'), 'utf8');
    expect(content).toContain('course-analysis');
    expect(content).toMatch(/When NOT to use this skill/i);
  });
});
