import { describe, expect, it } from 'vitest';

import {
  parseCurriculumExportJobAction,
  parseCurriculumExportJobsInput,
} from '@/lib/server/curriculum/validation';

describe('parseCurriculumExportJobsInput', () => {
  it('accepts a batch item list with explicit render options', () => {
    const parsed = parseCurriculumExportJobsInput({
      batchItemIds: ['item-1', 'item-2'],
      resolution: '720p',
      fps: 24,
      quality: 'draft',
      burnInSubtitles: true,
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        batchItemIds: ['item-1', 'item-2'],
        stageIds: [],
        resolution: '720p',
        fps: 24,
        quality: 'draft',
        burnInSubtitles: true,
      },
    });
  });

  it('accepts a batch id and defaults to the standard MP4 profile', () => {
    const parsed = parseCurriculumExportJobsInput({ batchId: 'batch-1' });
    expect(parsed.ok && parsed.value).toMatchObject({
      batchId: 'batch-1',
      batchItemIds: [],
      stageIds: [],
      resolution: '1080p',
      fps: 30,
      quality: 'standard',
      burnInSubtitles: false,
    });
  });

  /**
   * 目工作台那条路：设计直接产出课堂，没有批量项可以指。
   *
   * 这一条钉住的是"stage 单独也是一份合法入队请求"——不是"stage 可以和一个
   * 空 batchItemIds 一起发"，因为那种请求在存储层会走 stage 分支，界面上却
   * 看不出自己走的是哪条。
   */
  it('accepts stage ids with a display title', () => {
    const parsed = parseCurriculumExportJobsInput({
      stageIds: ['stage-1', 'stage-2'],
      stageTitle: '2-1-2 信息收集实操',
    });
    expect(parsed).toEqual({
      ok: true,
      value: {
        batchItemIds: [],
        stageIds: ['stage-1', 'stage-2'],
        stageTitle: '2-1-2 信息收集实操',
        resolution: '1080p',
        fps: 30,
        quality: 'standard',
        burnInSubtitles: false,
      },
    });
  });

  it('rejects a stage selection that is empty, blank or over the cap', () => {
    expect(parseCurriculumExportJobsInput({ stageIds: [] })).toMatchObject({
      ok: false,
      message: 'batchId、batchItemIds 或 stageIds 为必填',
    });
    expect(parseCurriculumExportJobsInput({ stageIds: 'stage-1' })).toMatchObject({
      ok: false,
      message: 'stageIds 必须是数组',
    });
    expect(parseCurriculumExportJobsInput({ stageIds: ['stage-1', '  '] })).toMatchObject({
      ok: false,
      message: 'stageIds[1] 必须是非空字符串',
    });
    expect(
      parseCurriculumExportJobsInput({
        stageIds: Array.from({ length: 51 }, (_, index) => `stage-${index}`),
      }),
    ).toMatchObject({ ok: false, message: 'stageIds 数量过多' });
    expect(
      parseCurriculumExportJobsInput({ stageIds: ['stage-1'], stageTitle: ' ' }),
    ).toMatchObject({ ok: false, message: 'stageTitle 必须是非空字符串' });
  });

  it('rejects an empty selection and unknown render options', () => {
    expect(parseCurriculumExportJobsInput({})).toMatchObject({
      ok: false,
      message: 'batchId、batchItemIds 或 stageIds 为必填',
    });
    expect(
      parseCurriculumExportJobsInput({ batchItemIds: ['item-1'], resolution: '8k' }),
    ).toMatchObject({ ok: false });
    expect(parseCurriculumExportJobsInput({ batchItemIds: ['item-1'], fps: 25 })).toMatchObject({
      ok: false,
    });
    expect(
      parseCurriculumExportJobsInput({ batchItemIds: ['item-1'], quality: 'ultra' }),
    ).toMatchObject({ ok: false });
  });
});

describe('parseCurriculumExportJobAction', () => {
  it('parses worker lifecycle actions', () => {
    expect(parseCurriculumExportJobAction({ action: 'attach-render', renderJobId: 'r-1' })).toEqual(
      {
        ok: true,
        value: { action: 'attach-render', renderJobId: 'r-1' },
      },
    );
    expect(parseCurriculumExportJobAction({ action: 'progress', progress: 0.5 })).toEqual({
      ok: true,
      value: { action: 'progress', progress: 0.5 },
    });
    expect(parseCurriculumExportJobAction({ action: 'complete' })).toEqual({
      ok: true,
      value: { action: 'complete' },
    });
    expect(
      parseCurriculumExportJobAction({ action: 'fail', error: { code: 'X', message: 'bad' } }),
    ).toEqual({
      ok: true,
      value: { action: 'fail', error: { code: 'X', message: 'bad' } },
    });
    expect(parseCurriculumExportJobAction({ action: 'retry' })).toEqual({
      ok: true,
      value: { action: 'retry' },
    });
    expect(parseCurriculumExportJobAction({ action: 'cancel' })).toEqual({
      ok: true,
      value: { action: 'cancel' },
    });
  });

  it('rejects malformed lifecycle actions', () => {
    expect(parseCurriculumExportJobAction({ action: 'attach-render' })).toMatchObject({
      ok: false,
    });
    expect(parseCurriculumExportJobAction({ action: 'progress', progress: 2 })).toMatchObject({
      ok: false,
    });
    expect(parseCurriculumExportJobAction({ action: 'fail', error: {} })).toMatchObject({
      ok: false,
    });
    expect(parseCurriculumExportJobAction({ action: 'unknown' })).toMatchObject({ ok: false });
  });
});
