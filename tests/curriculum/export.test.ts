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
      resolution: '1080p',
      fps: 30,
      quality: 'standard',
      burnInSubtitles: false,
    });
  });

  it('rejects an empty selection and unknown render options', () => {
    expect(parseCurriculumExportJobsInput({})).toMatchObject({
      ok: false,
      message: 'batchId or batchItemIds is required',
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
