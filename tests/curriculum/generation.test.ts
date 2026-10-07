import { describe, expect, it } from 'vitest';

import type { GenerationRunHookEvent } from '@/lib/server/generation-run-hooks';
import { curriculumGenerationUpdateForRunEvent } from '@/lib/server/curriculum/generation-hooks';
import { parseGenerationJobInput } from '@/lib/server/curriculum/validation';

function event(type: GenerationRunHookEvent['type']): GenerationRunHookEvent {
  const base = {
    runId: 'run-1',
    ownerId: 'owner-1',
    currentOwnerId: 'owner-1',
    attributes: {},
  };
  switch (type) {
    case 'started':
      return { ...base, type };
    case 'outline-ready':
      return { ...base, type, scenesTotal: 3 };
    case 'scene-appended':
      return {
        ...base,
        type,
        stageId: 'stage-1',
        sceneIndex: 0,
        sceneId: 'scene-1',
        scenesCompleted: 1,
        scenesTotal: 3,
      };
    case 'paused':
      return { ...base, type, step: 'narration', errorCode: 'MODEL_FAILED' };
    case 'completed':
      return { ...base, type, stageId: 'stage-1' };
    case 'ended':
      return { ...base, type, stageId: null };
  }
}

describe('parseGenerationJobInput', () => {
  it('defaults a one-click job to auto outline review', () => {
    const parsed = parseGenerationJobInput({
      assembly: {
        title: 'CTF 入门',
        knowledgePoints: [{ knowledgePointId: 'kp-1', coverageLevel: 'introduced' }],
      },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.outlineReview).toBe('auto');
    expect(parsed.value.interactive).toBe(false);
    expect(parsed.value.taskEngine).toBe(false);
  });

  it('accepts course, run options and voice', () => {
    const parsed = parseGenerationJobInput({
      assembly: {
        seriesId: 'series-1',
        title: 'CTF 入门',
        knowledgePoints: [{ knowledgePointId: 'kp-1', coverageLevel: 'practiced' }],
      },
      courseId: 'course-1',
      outlineReview: 'wait',
      interactive: true,
      taskEngine: true,
      voice: { providerId: 'azure', voiceId: 'zh-CN-XiaoxiaoNeural', speed: 1.1 },
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.courseId).toBe('course-1');
    expect(parsed.value.outlineReview).toBe('wait');
    expect(parsed.value.interactive).toBe(true);
    expect(parsed.value.taskEngine).toBe(true);
    expect(parsed.value.voice?.voiceId).toBe('zh-CN-XiaoxiaoNeural');
  });

  it('refuses invalid outline review and empty selection', () => {
    expect(
      parseGenerationJobInput({
        assembly: {
          title: 'CTF 入门',
          knowledgePoints: [{ knowledgePointId: 'kp-1' }],
        },
        outlineReview: 'later',
      }).ok,
    ).toBe(false);

    expect(
      parseGenerationJobInput({
        assembly: { title: 'CTF 入门', knowledgePoints: [] },
      }).ok,
    ).toBe(false);
  });
});

describe('curriculumGenerationUpdateForRunEvent', () => {
  it('maps committed run events onto job state and stage ids', () => {
    expect(curriculumGenerationUpdateForRunEvent(event('started'))).toEqual({ status: 'running' });
    expect(curriculumGenerationUpdateForRunEvent(event('outline-ready'))).toEqual({
      status: 'awaiting_outline',
    });
    expect(curriculumGenerationUpdateForRunEvent(event('scene-appended'))).toEqual({
      status: 'running',
      stageId: 'stage-1',
    });
    expect(curriculumGenerationUpdateForRunEvent(event('paused'))).toEqual({
      status: 'paused',
      error: { code: 'MODEL_FAILED', step: 'narration' },
    });
    expect(curriculumGenerationUpdateForRunEvent(event('completed'))).toEqual({
      status: 'completed',
      stageId: 'stage-1',
    });
    expect(curriculumGenerationUpdateForRunEvent(event('ended'))).toEqual({ status: 'ended' });
  });
});
